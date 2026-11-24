/*
 * wasm/qgemm_wasm_gru.c - the fused GRU step of the wasm tier.
 *
 * Same contract as the NEON and x86 versions: the input and recurrent gates
 * are dequantized in one pass, the r and z gates are sigmoided, the n gate
 * gets the recurrent mix, and the new state is written back as fp16.
 *
 * The three gates of one output block share the same activation rows and the
 * same weight-block index, so all six tiles (r/z/n x input/recurrent) run
 * back to back for a 4-row group and the r/z bands never leave registers as
 * far as the n gate is concerned.
 *
 * Gate order follows the reference kernels: the dequant is one multiply plus
 * add, the r and z gates add the bias sums after adding the two halves, and
 * the n gate adds bn_i and bn_h before the recurrent mix.
 */
#if defined(__wasm__) || defined(__wasm32__)

#include <wasm_simd128.h>
#include "../arch_kernels.h"
#include "qgemm_wasm_kernel.h"
#include "../../internal/fe_fp16.h"
#include "../../internal/fe_simd.h"
#include "../../internal/fe_profile.h"
#include <stdint.h>
#include <math.h>
#include <string.h>

/* Shared r/z gate bands live in fe_gru.c, one definition for every tier. */

static inline float fe_wasm_sigmoid_g(float x) {
    if (x < -16.6f) x = -16.6f;
    if (x > 16.6f) x = 16.6f;
    return 1.0f / (1.0f + expf(-x));
}

/* fp16 with round to nearest even, matching the hardware conversions. */
static inline float fe_wasm_h2f(uint16_t h) {
    uint32_t sign = (uint32_t)(h >> 15) << 31;
    uint32_t exp = (h >> 10) & 0x1f;
    uint32_t man = h & 0x3ff;
    uint32_t out;
    if (exp == 0) {
        if (man == 0) {
            out = sign;
        } else {
            int e = 127 - 15 + 1;
            while (!(man & 0x400)) { man <<= 1; e--; }
            man &= 0x3ff;
            out = sign | ((uint32_t)e << 23) | (man << 13);
        }
    } else if (exp == 0x1f) {
        out = sign | 0x7f800000u | (man << 13);
    } else {
        out = sign | ((exp + 127 - 15) << 23) | (man << 13);
    }
    float f;
    memcpy(&f, &out, 4);
    return f;
}

static inline uint16_t fe_wasm_f2h(float f) {
    uint32_t x;
    memcpy(&x, &f, 4);
    uint32_t sign = (x >> 16) & 0x8000u;
    int32_t exp = (int32_t)((x >> 23) & 0xff);
    uint32_t man = x & 0x7fffffu;
    if (exp == 0xff) {
        return (uint16_t)(sign | 0x7c00u | (man ? 0x200u : 0u));
    }
    int32_t e = exp - 127 + 15;
    if (e >= 0x1f) return (uint16_t)(sign | 0x7c00u);
    if (e <= 0) {
        if (e < -10) return (uint16_t)sign;
        man |= 0x800000u;
        int shift = 14 - e;
        uint32_t a = man >> shift;
        uint32_t rem = man & ((1u << shift) - 1);
        uint32_t half = 1u << (shift - 1);
        if (rem > half || (rem == half && (a & 1u))) a++;
        return (uint16_t)(sign | a);
    }
    uint32_t a = man >> 13;
    uint32_t rem = man & 0x1fffu;
    uint16_t base = (uint16_t)(sign | ((uint32_t)e << 10) | a);
    if (rem > 0x1000u || (rem == 0x1000u && (a & 1u))) base++;
    return base;
}

/* bias_eff + combined_scale * acc, exactly the two-step non-fused form the
 * other wasm epilogues use. */
static inline v128_t fe_wasm_deq4(v128_t ci, const float *cs, const float *bs) {
    return wasm_f32x4_add(
        wasm_f32x4_mul(wasm_f32x4_convert_i32x4(ci), wasm_v128_load(cs)),
        wasm_v128_load(bs));
}

/* r or z gate: sigmoid(ih + hh + bias_sum), 4 rows x 8 lanes -> dst. */
static inline void fe_wasm_gru_gate_rz(float *dst, const int32_t *ti,
                                       const int32_t *th,
                                       const float *cs_i, const float *b_i,
                                       const float *cs_h, const float *b_h,
                                       const float *sum, int goff) {
    for (int row = 0; row < FE_WASM_MR; row++) {
        const int32_t *qi = ti + row * 8;
        const int32_t *qh = th + row * 8;
        float *d = dst + row * 8;
        for (int half = 0; half < 2; half++) {
            const int o = half * 4;
            const v128_t ih = fe_wasm_deq4(wasm_v128_load(qi + o),
                                           cs_i + goff + o, b_i + goff + o);
            const v128_t hh = fe_wasm_deq4(wasm_v128_load(qh + o),
                                           cs_h + goff + o, b_h + goff + o);
            const v128_t v = wasm_f32x4_add(wasm_f32x4_add(ih, hh),
                                            wasm_v128_load(sum + o));
            wasm_v128_store(d + o, fe_sigmoidf4_fast(v));
        }
    }
}

/* n gate for one row: tanh((ih + bn_i) + r * (hh + bn_h)), then
 * h' = n + z * (h - n). rr/zz/ho point at the row's 8 lanes. */
static inline void fe_wasm_gru_nrow(uint16_t *hs, float *ho,
                                    const int32_t *qi, const int32_t *qh,
                                    const float *cs_i, const float *b_i,
                                    const float *cs_h, const float *b_h,
                                    const float *bn_i, const float *bn_h,
                                    const float *rr, const float *zz, int goff) {
    for (int half = 0; half < 2; half++) {
        const int o = half * 4;
        const v128_t ih = fe_wasm_deq4(wasm_v128_load(qi + o),
                                       cs_i + goff + o, b_i + goff + o);
        const v128_t hh = fe_wasm_deq4(wasm_v128_load(qh + o),
                                       cs_h + goff + o, b_h + goff + o);
        const v128_t np = wasm_f32x4_add(
            wasm_f32x4_add(ih, wasm_v128_load(bn_i + o)),
            wasm_f32x4_mul(wasm_v128_load(rr + o),
                           wasm_f32x4_add(hh, wasm_v128_load(bn_h + o))));
        const v128_t nv = fe_tanhf4_fast(np);
        const v128_t old = fe_fp16_load4(hs + o);
        const v128_t hn = wasm_f32x4_add(
            nv, wasm_f32x4_mul(wasm_v128_load(zz + o),
                               wasm_f32x4_sub(old, nv)));
        wasm_v128_store(ho + o, hn);
        fe_fp16_store4(hs + o, hn);
    }
}

/* Reference row-at-a-time path: used when D is not a multiple of the 8-lane
 * block and for the M % 4 tail. */
static void fe_wasm_gru_scalar(int M, int D, const int8_t *Xq, int ld_x,
                               const int8_t *Hq, int ld_h,
                               const int8_t *Wq_ih, const int8_t *Wq_hh,
                               const float *combined_ih,
                               const float *bias_eff_ih,
                               const float *combined_hh,
                               const float *bias_eff_hh,
                               const float *br_sum, const float *bz_sum,
                               const float *bn_i, const float *bn_h,
                               uint16_t *h_inout_fp16, int ld_h_inout,
                               float *h_out_scratch, int ld_h_out) {
    const int NR = FE_WASM_NR;
    const int nblk = (D + NR - 1) / NR;
    const int lanes = D;

    for (int r = 0; r < M; r++) {
        const int8_t *x = Xq + (size_t)r * ld_x;
        const int8_t *h = Hq + (size_t)r * ld_h;
        uint16_t *hs = h_inout_fp16 + (size_t)r * ld_h_inout;
        float *hscr = h_out_scratch + (size_t)r * ld_h_out;

        for (int n = 0; n < lanes; n++) {
            int32_t ci = fe_wasm_dot(x, fe_wasm_b(Wq_ih, D, n / NR), D,
                                     n % NR);
            int32_t ch = fe_wasm_dot(h, fe_wasm_b(Wq_hh, D, n / NR), D,
                                     n % NR);
            float ih = fmaf(combined_ih[n], (float)ci, bias_eff_ih[n]);
            float hh = fmaf(combined_hh[n], (float)ch, bias_eff_hh[n]);
            fe_gru_r_band[(size_t)(r % FE_QGEMM_GRU_MR) * D + n] =
                fe_wasm_sigmoid_g((ih + hh) + br_sum[n]);
        }
        for (int n = 0; n < lanes; n++) {
            int32_t ci = fe_wasm_dot(x, fe_wasm_b(Wq_ih, D, nblk + n / NR), D,
                                     n % NR);
            int32_t ch = fe_wasm_dot(h, fe_wasm_b(Wq_hh, D, nblk + n / NR), D,
                                     n % NR);
            float ih = fmaf(combined_ih[D + n], (float)ci,
                            bias_eff_ih[D + n]);
            float hh = fmaf(combined_hh[D + n], (float)ch,
                            bias_eff_hh[D + n]);
            fe_gru_z_band[(size_t)(r % FE_QGEMM_GRU_MR) * D + n] =
                fe_wasm_sigmoid_g((ih + hh) + bz_sum[n]);
        }
        for (int n = 0; n < lanes; n++) {
            int32_t ci = fe_wasm_dot(x, fe_wasm_b(Wq_ih, D, 2 * nblk + n / NR),
                                     D, n % NR);
            int32_t ch = fe_wasm_dot(h, fe_wasm_b(Wq_hh, D, 2 * nblk + n / NR),
                                     D, n % NR);
            const int g = 2 * D + n;
            float ih = fmaf(combined_ih[g], (float)ci, bias_eff_ih[g]);
            float hh = fmaf(combined_hh[g], (float)ch, bias_eff_hh[g]);
            const float rv = fe_gru_r_band[(size_t)(r % FE_QGEMM_GRU_MR) * D + n];
            const float zv = fe_gru_z_band[(size_t)(r % FE_QGEMM_GRU_MR) * D + n];
            float np = (ih + bn_i[n]) + rv * (hh + bn_h[n]);
            float nv = tanhf(np);
            float old = fe_wasm_h2f(hs[n]);
            float hn = nv + zv * (old - nv);
            hscr[n] = hn;
            hs[n] = fe_wasm_f2h(hn);
        }
    }
}

/* One 4-row block of the fused step. `rows` is 1..4: the unused rows still
 * run through the tile (their pointers alias a valid row) but nothing is
 * written for them. This keeps the M % 4 tail on the vector path. */
static inline void fe_wasm_gru_block4(int D, int nblk,
                                      const int8_t *x0, const int8_t *x1,
                                      const int8_t *x2, const int8_t *x3,
                                      const int8_t *h0, const int8_t *h1,
                                      const int8_t *h2, const int8_t *h3,
                                      uint16_t *hs, float *hscr,
                                      int ld_h_inout, int ld_h_out,
                                      const int8_t *Wq_ih,
                                      const int8_t *Wq_hh,
                                      const float *combined_ih,
                                      const float *bias_eff_ih,
                                      const float *combined_hh,
                                      const float *bias_eff_hh,
                                      const float *br_sum,
                                      const float *bz_sum,
                                      const float *bn_i, const float *bn_h,
                                      int rows) {
    const int NR = FE_WASM_NR;
    int32_t ti[FE_WASM_MR * 8], th[FE_WASM_MR * 8];
    float rz[2 * FE_WASM_MR * 8];

    for (int b = 0; b < nblk; b++) {
        const int n = b * NR;
        const int g_r = n, g_z = D + n, g_n = 2 * D + n;

        fe_wasm_tile(D, x0, x1, x2, x3, fe_wasm_b(Wq_ih, D, b), ti);
        fe_wasm_tile(D, h0, h1, h2, h3, fe_wasm_b(Wq_hh, D, b), th);
        fe_wasm_gru_gate_rz(rz, ti, th, combined_ih, bias_eff_ih,
                            combined_hh, bias_eff_hh, br_sum + n, g_r);

        fe_wasm_tile(D, x0, x1, x2, x3,
                        fe_wasm_b(Wq_ih, D, nblk + b), ti);
        fe_wasm_tile(D, h0, h1, h2, h3,
                        fe_wasm_b(Wq_hh, D, nblk + b), th);
        fe_wasm_gru_gate_rz(rz + FE_WASM_MR * 8, ti, th, combined_ih,
                            bias_eff_ih, combined_hh, bias_eff_hh,
                            bz_sum + n, g_z);

        fe_wasm_tile(D, x0, x1, x2, x3,
                        fe_wasm_b(Wq_ih, D, 2 * nblk + b), ti);
        fe_wasm_tile(D, h0, h1, h2, h3,
                        fe_wasm_b(Wq_hh, D, 2 * nblk + b), th);
        /* gate_n walks the rows itself because h lives row-strided. */
        for (int row = 0; row < rows; row++) {
            fe_wasm_gru_nrow(hs + (size_t)row * ld_h_inout + n,
                             hscr + (size_t)row * ld_h_out + n,
                             ti + row * 8, th + row * 8,
                             combined_ih, bias_eff_ih,
                             combined_hh, bias_eff_hh,
                             bn_i + n, bn_h + n,
                             rz + row * 8,
                             rz + FE_WASM_MR * 8 + row * 8, g_n);
        }
    }
}

void qgemm_wasm_gru_full_fused_fp16inout(int M, int D,
                                         const int8_t *Xq, int ld_x,
                                         const int8_t *Hq, int ld_h,
                                         const int8_t *Wq_ih,
                                         const int8_t *Wq_hh,
                                         const float *combined_ih,
                                         const float *bias_eff_ih,
                                         const float *combined_hh,
                                         const float *bias_eff_hh,
                                         const float *br_sum, const float *bz_sum,
                                         const float *bn_i, const float *bn_h,
                                         uint16_t *h_inout_fp16, int ld_h_inout,
                                         float *h_out_scratch, int ld_h_out) {
    const int NR = FE_WASM_NR;
    const int nblk = D / NR;
    FE_WASM_COUNT(M, 3 * D, 2 * D);
    if ((D & (NR - 1)) != 0) {
        fe_wasm_gru_scalar(M, D, Xq, ld_x, Hq, ld_h, Wq_ih, Wq_hh,
                           combined_ih, bias_eff_ih, combined_hh, bias_eff_hh,
                           br_sum, bz_sum, bn_i, bn_h,
                           h_inout_fp16, ld_h_inout, h_out_scratch, ld_h_out);
        return;
    }

    int r = 0;
    for (; r + 3 < M; r += 4) {
        const int8_t *x0 = Xq + (size_t)r * ld_x;
        const int8_t *h0 = Hq + (size_t)r * ld_h;
        fe_wasm_gru_block4(D, nblk,
                           x0, x0 + ld_x, x0 + 2 * ld_x, x0 + 3 * ld_x,
                           h0, h0 + ld_h, h0 + 2 * ld_h, h0 + 3 * ld_h,
                           h_inout_fp16 + (size_t)r * ld_h_inout,
                           h_out_scratch + (size_t)r * ld_h_out,
                           ld_h_inout, ld_h_out,
                           Wq_ih, Wq_hh, combined_ih, bias_eff_ih,
                           combined_hh, bias_eff_hh, br_sum, bz_sum,
                           bn_i, bn_h, FE_WASM_MR);
    }

    if (r < M) {
        /* Rows alias the last valid row so the tile still runs; only the
         * valid output rows are stored. */
        const int rows = M - r;
        const int8_t *x0 = Xq + (size_t)r * ld_x;
        const int8_t *h0 = Hq + (size_t)r * ld_h;
        const int8_t *x1 = (rows > 1) ? x0 + ld_x : x0;
        const int8_t *x2 = (rows > 2) ? x0 + 2 * ld_x : x0;
        const int8_t *h1 = (rows > 1) ? h0 + ld_h : h0;
        const int8_t *h2 = (rows > 2) ? h0 + 2 * ld_h : h0;
        fe_wasm_gru_block4(D, nblk, x0, x1, x2, x0,
                           h0, h1, h2, h0,
                           h_inout_fp16 + (size_t)r * ld_h_inout,
                           h_out_scratch + (size_t)r * ld_h_out,
                           ld_h_inout, ld_h_out,
                           Wq_ih, Wq_hh, combined_ih, bias_eff_ih,
                           combined_hh, bias_eff_hh, br_sum, bz_sum,
                           bn_i, bn_h, rows);
    }
}

#endif /* wasm */
