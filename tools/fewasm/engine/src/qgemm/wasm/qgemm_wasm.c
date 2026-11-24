/*
 * wasm/qgemm_wasm.c - the WebAssembly SIMD128 tier, epilogues and entry
 * points. The blocked int8 tile itself lives in qgemm_wasm_kernel.h so the
 * fused GRU can share it.
 */
#if defined(__wasm__) || defined(__wasm32__)

#include <wasm_simd128.h>
#include "../arch_kernels.h"
#include "qgemm_wasm_kernel.h"
#include "../../internal/fe_simd.h"
#include <stdint.h>
#include <math.h>
#include <string.h>

#ifdef FE_ENABLE_PROFILE
unsigned long long g_wasm_macs;
unsigned long long fe_wasm_mac_count(void) { return g_wasm_macs; }
#endif

/* Vector SiLU: v * sigmoid(v), the same rational poly the x86 tiers use in
 * fe_qg_sigmoid8/16. Cheaper than v/(1+exp(-v)) by a wide margin (no range
 * reduction, no 7-term poly) and closer to the native tiers' formula. */
static inline v128_t fe_wasm_silu4(v128_t v) {
    return wasm_f32x4_mul(v, fe_sigmoidf4_fast(v));
}

/* Dequant epilogue for four lanes: bias + scale * c, then optional SiLU. */
static inline v128_t fe_wasm_epi4(v128_t ci, v128_t cs, v128_t cb, int silu) {
    v128_t v = wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_convert_i32x4(ci), cs),
                            cb);
    if (silu) v = fe_wasm_silu4(v);
    return v;
}

/* mode: bit0 = accumulate into C, bit1 = track max |C|. */
static void fe_wasm_gemm_epi(int M, int N, int K,
                             const int8_t *A_q, int lda, const int8_t *Bp,
                             const float *combined_scale, const float *bias,
                             float *C, int ldc, int silu, int mode,
                             float *max_abs_out) {
    FE_WASM_COUNT(M, N, K);
    int32_t tile[FE_WASM_MR * 8];
    v128_t mx4 = wasm_f32x4_splat(0.0f);
    const int acc = mode & 1;

    int m = 0;
    for (; m + 3 < M; m += 4) {
        const int8_t *a0 = A_q + (size_t)m * lda;
        const int8_t *a1 = a0 + lda;
        const int8_t *a2 = a1 + lda;
        const int8_t *a3 = a2 + lda;
        int n = 0;
        for (; n + 7 < N; n += 8) {
            fe_wasm_tile(K, a0, a1, a2, a3, fe_wasm_b(Bp, K, n >> 3),
                            tile);
            const v128_t s0 = wasm_v128_load(combined_scale + n);
            const v128_t s1 = wasm_v128_load(combined_scale + n + 4);
            const v128_t b0 = bias ? wasm_v128_load(bias + n)
                                 : wasm_f32x4_splat(0.0f);
            const v128_t b1 = bias ? wasm_v128_load(bias + n + 4)
                                 : wasm_f32x4_splat(0.0f);
            for (int r = 0; r < FE_WASM_MR; r++) {
                float *dst = C + (size_t)(m + r) * ldc + n;
                const int32_t *cc = tile + r * 8;
                v128_t v0 = fe_wasm_epi4(wasm_v128_load(cc), s0, b0, silu);
                v128_t v1 = fe_wasm_epi4(wasm_v128_load(cc + 4), s1, b1, silu);
                if (acc) {
                    v0 = wasm_f32x4_add(v0, wasm_v128_load(dst));
                    v1 = wasm_f32x4_add(v1, wasm_v128_load(dst + 4));
                }
                if (mode & 2) {
                    mx4 = wasm_f32x4_max(mx4, wasm_f32x4_abs(v0));
                    mx4 = wasm_f32x4_max(mx4, wasm_f32x4_abs(v1));
                }
                wasm_v128_store(dst, v0);
                wasm_v128_store(dst + 4, v1);
            }
        }
        /* N % 8 tail. */
        for (; n < N; n++) {
            const int8_t *wl = fe_wasm_b(Bp, K, n >> 3);
            const int lane = n & 7;
            for (int r = 0; r < FE_WASM_MR; r++) {
                const int8_t *ap = (r == 0) ? a0 : (r == 1) ? a1
                                  : (r == 2) ? a2 : a3;
                const int32_t ci = fe_wasm_dot(ap, wl, K, lane);
                float v = fmaf(combined_scale[n], (float)ci,
                               bias ? bias[n] : 0.0f);
                if (silu) {
                    float t = -v;
                    if (t < -16.6f) t = -16.6f;
                    if (t > 16.6f) t = 16.6f;
                    v = v / (1.0f + expf(t));
                }
                float *dst = C + (size_t)(m + r) * ldc + n;
                if (acc) v += *dst;
                if (mode & 2) {
                    float a = fabsf(v);
                    if (a > max_abs_out[0]) max_abs_out[0] = a;
                }
                *dst = v;
            }
        }
    }
    /* M % 4 tail: keep it on the tile by aliasing the last valid row. */
    if (m < M) {
        const int rows = M - m;
        const int8_t *a0 = A_q + (size_t)m * lda;
        const int8_t *a1 = (rows > 1) ? a0 + lda : a0;
        const int8_t *a2 = (rows > 2) ? a0 + 2 * lda : a0;
        int n = 0;
        for (; n + 7 < N; n += 8) {
            fe_wasm_tile(K, a0, a1, a2, a0, fe_wasm_b(Bp, K, n >> 3),
                            tile);
            const v128_t s0 = wasm_v128_load(combined_scale + n);
            const v128_t s1 = wasm_v128_load(combined_scale + n + 4);
            const v128_t b0 = bias ? wasm_v128_load(bias + n)
                                 : wasm_f32x4_splat(0.0f);
            const v128_t b1 = bias ? wasm_v128_load(bias + n + 4)
                                 : wasm_f32x4_splat(0.0f);
            for (int r = 0; r < rows; r++) {
                float *dst = C + (size_t)(m + r) * ldc + n;
                const int32_t *cc = tile + r * 8;
                v128_t v0 = fe_wasm_epi4(wasm_v128_load(cc), s0, b0, silu);
                v128_t v1 = fe_wasm_epi4(wasm_v128_load(cc + 4), s1, b1, silu);
                if (acc) {
                    v0 = wasm_f32x4_add(v0, wasm_v128_load(dst));
                    v1 = wasm_f32x4_add(v1, wasm_v128_load(dst + 4));
                }
                if (mode & 2) {
                    mx4 = wasm_f32x4_max(mx4, wasm_f32x4_abs(v0));
                    mx4 = wasm_f32x4_max(mx4, wasm_f32x4_abs(v1));
                }
                wasm_v128_store(dst, v0);
                wasm_v128_store(dst + 4, v1);
            }
        }
        for (; n < N; n++) {
            const int8_t *wl = fe_wasm_b(Bp, K, n >> 3);
            for (int r = 0; r < rows; r++) {
                const int8_t *ap = (r == 0) ? a0 : (r == 1) ? a1 : a2;
                const int32_t ci = fe_wasm_dot(ap, wl, K, n & 7);
                float v = fmaf(combined_scale[n], (float)ci,
                               bias ? bias[n] : 0.0f);
                if (silu) {
                    float t = -v;
                    if (t < -16.6f) t = -16.6f;
                    if (t > 16.6f) t = 16.6f;
                    v = v / (1.0f + expf(t));
                }
                float *dst = C + (size_t)(m + r) * ldc + n;
                if (acc) v += *dst;
                if (mode & 2) {
                    float a = fabsf(v);
                    if (a > max_abs_out[0]) max_abs_out[0] = a;
                }
                *dst = v;
            }
        }
    }

    if (mode & 2) {
        const v128_t t0 = wasm_f32x4_max(mx4,
                        wasm_i32x4_shuffle(mx4, mx4, 2, 3, 0, 1));
        const v128_t t1 = wasm_f32x4_max(t0,
                        wasm_i32x4_shuffle(t0, t0, 1, 0, 3, 2));
        const float mx = wasm_f32x4_extract_lane(t1, 0);
        if (mx > max_abs_out[0]) max_abs_out[0] = mx;
    }
}

/* gemm_int32 consumes two different weight sources: buffers packed at load
 * time (pair layout, fe_qgemm_repack_wasm) and per-frame K/V packs
 * built by the attention block (always DOTPROD). `pair` selects the tile;
 * both packs occupy the same number of bytes. */
static inline void wasm_int32_tile(int pair, int K, const int8_t *a0,
                                   const int8_t *a1, const int8_t *a2,
                                   const int8_t *a3, const int8_t *blk,
                                   int32_t *c) {
    if (pair)
        fe_wasm_tile4x8p(K, a0, a1, a2, a3, blk, c);
    else
        fe_wasm_tile4x8(K, a0, a1, a2, a3, blk, c);
}

static void wasm_int32_impl(int pair, int M, int N, int K,
                            const int8_t *A_q, const int8_t *Bp,
                            int32_t *C32, int ldc32) {
    FE_WASM_COUNT(M, N, K);
    int32_t tile[FE_WASM_MR * 8];
    int m = 0;
    for (; m + 3 < M; m += 4) {
        const int8_t *a0 = A_q + (size_t)m * K;
        const int8_t *a1 = a0 + K;
        const int8_t *a2 = a1 + K;
        const int8_t *a3 = a2 + K;
        int n = 0;
        for (; n + 7 < N; n += 8) {
            wasm_int32_tile(pair, K, a0, a1, a2, a3,
                            fe_wasm_b(Bp, K, n >> 3), tile);
            memcpy(C32 + (size_t)m * ldc32 + n, tile,
                   8 * sizeof(int32_t));
            memcpy(C32 + (size_t)(m + 1) * ldc32 + n, tile + 8,
                   8 * sizeof(int32_t));
            memcpy(C32 + (size_t)(m + 2) * ldc32 + n, tile + 16,
                   8 * sizeof(int32_t));
            memcpy(C32 + (size_t)(m + 3) * ldc32 + n, tile + 24,
                   8 * sizeof(int32_t));
        }
        for (; n < N; n++) {
            const int8_t *wl = fe_wasm_b(Bp, K, n >> 3);
            const int lane = n & 7;
            C32[(size_t)m * ldc32 + n] = fe_wasm_dot(a0, wl, K, lane);
            C32[(size_t)(m + 1) * ldc32 + n] = fe_wasm_dot(a1, wl, K, lane);
            C32[(size_t)(m + 2) * ldc32 + n] = fe_wasm_dot(a2, wl, K, lane);
            C32[(size_t)(m + 3) * ldc32 + n] = fe_wasm_dot(a3, wl, K, lane);
        }
    }
    /* M % 4 tail: vector tiles with aliased rows. */
    if (m < M) {
        const int rows = M - m;
        const int8_t *a0 = A_q + (size_t)m * K;
        const int8_t *a1 = (rows > 1) ? a0 + K : a0;
        const int8_t *a2 = (rows > 2) ? a0 + 2 * K : a0;
        int n = 0;
        for (; n + 7 < N; n += 8) {
            wasm_int32_tile(pair, K, a0, a1, a2, a0,
                            fe_wasm_b(Bp, K, n >> 3), tile);
            for (int r = 0; r < rows; r++)
                memcpy(C32 + (size_t)(m + r) * ldc32 + n, tile + r * 8,
                       8 * sizeof(int32_t));
        }
        for (; n < N; n++) {
            const int8_t *wl = fe_wasm_b(Bp, K, n >> 3);
            for (int r = 0; r < rows; r++) {
                const int8_t *ap = (r == 0) ? a0 : (r == 1) ? a1 : a2;
                C32[(size_t)(m + r) * ldc32 + n] =
                    fe_wasm_dot(ap, wl, K, n & 7);
            }
        }
    }
}

void qgemm_wasm_int32(int M, int N, int K,
                      const int8_t *A_q, const int8_t *Bp,
                      int32_t *C32, int ldc32) {
    wasm_int32_impl(0, M, N, K, A_q, Bp, C32, ldc32);
}

void qgemm_wasm_int32_p(int M, int N, int K,
                        const int8_t *A_q, const int8_t *Bp,
                        int32_t *C32, int ldc32) {
    wasm_int32_impl((K & 7) == 0, M, N, K, A_q, Bp, C32, ldc32);
}

/* K = 20 (attention head dim): fixed trip count, so the k8 loop and the
 * leftover single group are straight-line code once inlined. */
void qgemm_wasm_int32_k20(int M, int N, const int8_t *A_q, const int8_t *Bp,
                          int32_t *C32, int ldc32) {
    qgemm_wasm_int32(M, N, 20, A_q, Bp, C32, ldc32);
}

void qgemm_wasm_fp32_fused(int M, int N, int K,
                           const int8_t *A_q, const int8_t *Bp,
                           const float *combined_scale, const float *bias,
                           float *C, int ldc, int act_silu,
                           int32_t *c32_tail) {
    (void)c32_tail;
    fe_wasm_gemm_epi(M, N, K, A_q, K, Bp, combined_scale, bias, C, ldc,
                     act_silu, 0, NULL);
}

void qgemm_wasm_fp32_fused_acc(int M, int N, int K,
                               const int8_t *A_q, const int8_t *Bp,
                               const float *combined_scale, const float *bias,
                               float *C, int ldc, int32_t *c32_tail) {
    (void)c32_tail;
    fe_wasm_gemm_epi(M, N, K, A_q, K, Bp, combined_scale, bias, C, ldc,
                     0, 1, NULL);
}

void qgemm_wasm_fp32_fused_track_maxabs(int M, int N, int K,
                                        const int8_t *A_q, const int8_t *Bp,
                                        const float *combined_scale,
                                        const float *bias,
                                        float *C, int ldc, int32_t *c32_tail,
                                        float *max_abs_out) {
    (void)c32_tail;
    if (max_abs_out) *max_abs_out = 0.0f;
    fe_wasm_gemm_epi(M, N, K, A_q, K, Bp, combined_scale, bias, C, ldc,
                     0, 2, max_abs_out);
}

/* Nothing to pre-fault: wasm memory is grown once at init. */
void qgemm_wasm_prefault_buffers(void) {}

#endif /* wasm */

/* wasm has one tier and no CPU brand to report; the dispatcher logs it. */
const char *fe_cpu_brand(void) { return "wasm"; }
