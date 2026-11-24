/*
 * wasm/qgemm_wasm_kernel.h - the blocked int8 tile shared by the wasm GEMM
 * and the wasm fused GRU.
 *
 * A tile is 4 activation rows x 8 output channels. SIMD128 has no int8 dot
 * product, so int8 pairs are folded with i32x4.dot_i16x8: the weight bytes
 * of k0,k1 for four output lanes become one i16x8 vector, the activation
 * pair (a0,a1) becomes a splat, and one dot produces four separate output
 * sums. Every i32 lane of a dot result is therefore already one distinct
 * output channel and no horizontal reduction is ever needed.
 *
 *   weights  w01l = [w0k0 w0k1 w1k0 w1k1 w2k0 w2k1 w3k0 w3k1]
 *   act      a01  = [a0 a1 a0 a1 a0 a1 a0 a1]
 *   dot  ->  [w0k0*a0+w0k1*a1, w1k0*a0+w1k1*a1, ...]   (lanes 0..3)
 *
 * Eight dots per (row, 8 k) cover both k pairs of both halves of the 8-lane
 * block. The int32 result is exact: integer addition is associative, so the
 * tier stays bit-identical to the scalar accumulation the other tiers use.
 */
#ifndef FE_QGEMM_WASM_KERNEL_H
#define FE_QGEMM_WASM_KERNEL_H

#if defined(__wasm__) || defined(__wasm32__)

#include <wasm_simd128.h>
#include "../../internal/fe_qgemm.h"
#include <stdint.h>
#include <string.h>

/* Optional instrumentation: total int8 multiply-accumulates executed. */
#ifdef FE_ENABLE_PROFILE
#include "../../internal/fe_profile.h"
extern unsigned long long g_wasm_macs;
#define FE_WASM_COUNT(m, n, k)                                               \
    do {                                                                     \
        const unsigned long long _m = (unsigned long long)(m) *              \
                                      (unsigned long long)(n) *              \
                                      (unsigned long long)(k);               \
        g_wasm_macs += _m;                                                   \
        fe_profile_mac(_m);                                                  \
    } while (0)
#else
#define FE_WASM_COUNT(m, n, k) ((void)0)
#endif

#define FE_WASM_NR FE_QGEMM_NR      /* 8 lanes per weight block */
#define FE_WASM_MR 4                /* activation rows per tile */

/* Packed weight layout from fe_qgemm_pack_W:
 *   block_n * (k4 * NR * 4) + g * (NR * 4) + lane * 4 + k_lane
 * with k4 = (K+3)/4. One N-block of one k4 group is 32 bytes: lane k0..k3. */
static inline const int8_t *fe_wasm_b(const int8_t *Bp, int K, int blk) {
    const int k4 = (K + 3) / 4;
    return Bp + (size_t)blk * (size_t)k4 * (FE_WASM_NR * 4);
}

/* One 16-byte weight vector holds 4 lanes x 4 k. Gather the k pair that
 * starts at kk (0 or 2) from all four lanes, then widen to i16. */
#define FE_WASM_WPAIR(w16, kk)                                               \
    wasm_i16x8_extend_low_i8x16(wasm_i8x16_shuffle(                          \
        (w16), (w16),                                                        \
        (kk), (kk) + 1, (kk) + 4, (kk) + 5, (kk) + 8, (kk) + 9,              \
        (kk) + 12, (kk) + 13,                                                \
        (kk), (kk) + 1, (kk) + 4, (kk) + 5, (kk) + 8, (kk) + 9,              \
        (kk) + 12, (kk) + 13))

/* Two adjacent k4 groups of one N-block, split into the pair vectors the dot
 * instructions want: lanes 0..3 from the first 16 bytes, lanes 4..7 from the
 * second, k(0,1) separated from k(2,3). */
typedef struct {
    v128_t w01l, w23l, w01h, w23h;  /* group g     */
    v128_t v01l, v23l, v01h, v23h;  /* group g + 1 */
} fe_wasm_w8;

static inline fe_wasm_w8 fe_wasm_w8_load(const int8_t *w) {
    const v128_t lo = wasm_v128_load(w);
    const v128_t hi = wasm_v128_load(w + 16);
    const v128_t lo2 = wasm_v128_load(w + 32);
    const v128_t hi2 = wasm_v128_load(w + 48);
    fe_wasm_w8 r;
    r.w01l = FE_WASM_WPAIR(lo, 0);
    r.w23l = FE_WASM_WPAIR(lo, 2);
    r.w01h = FE_WASM_WPAIR(hi, 0);
    r.w23h = FE_WASM_WPAIR(hi, 2);
    r.v01l = FE_WASM_WPAIR(lo2, 0);
    r.v23l = FE_WASM_WPAIR(lo2, 2);
    r.v01h = FE_WASM_WPAIR(hi2, 0);
    r.v23h = FE_WASM_WPAIR(hi2, 2);
    return r;
}

/* Eight activation bytes -> the four pair splats for k0..k7. */
static inline void fe_wasm_act8(const int8_t *ap, v128_t *a01, v128_t *a23,
                                v128_t *a45, v128_t *a67) {
    uint64_t raw;
    memcpy(&raw, ap, 8);
    const v128_t x = wasm_i16x8_extend_low_i8x16(wasm_i64x2_splat((int64_t)raw));
    *a01 = wasm_i16x8_shuffle(x, x, 0, 1, 0, 1, 0, 1, 0, 1);
    *a23 = wasm_i16x8_shuffle(x, x, 2, 3, 2, 3, 2, 3, 2, 3);
    *a45 = wasm_i16x8_shuffle(x, x, 4, 5, 4, 5, 4, 5, 4, 5);
    *a67 = wasm_i16x8_shuffle(x, x, 6, 7, 6, 7, 6, 7, 6, 7);
}

/* Scalar reference dot, used for every tail. */
static inline int32_t fe_wasm_dot(const int8_t *a, const int8_t *blk, int K,
                                  int lane) {
    const int k4 = (K + 3) / 4;
    int32_t acc = 0;
    for (int g = 0; g < k4; g++) {
        const int k = g * 4;
        const int8_t *wl = blk + (size_t)g * (FE_WASM_NR * 4) +
                           (size_t)lane * 4;
        const int n = (k + 4 <= K) ? 4 : (K - k);
        for (int kk = 0; kk < n; kk++)
            acc += (int32_t)a[k + kk] * (int32_t)wl[kk];
    }
    return acc;
}

/* One row's contribution for two k4 groups against one N-block. */
#define FE_WASM_ROW(c_l, c_h, a01, a23, a45, a67, w)                         \
    do {                                                                     \
        (c_l) = wasm_i32x4_add(                                              \
            (c_l), wasm_i32x4_add(                                           \
                wasm_i32x4_dot_i16x8((w).w01l, (a01)),                       \
                wasm_i32x4_dot_i16x8((w).w23l, (a23))));                     \
        (c_h) = wasm_i32x4_add(                                              \
            (c_h), wasm_i32x4_add(                                           \
                wasm_i32x4_dot_i16x8((w).w01h, (a01)),                       \
                wasm_i32x4_dot_i16x8((w).w23h, (a23))));                     \
        (c_l) = wasm_i32x4_add(                                              \
            (c_l), wasm_i32x4_add(                                           \
                wasm_i32x4_dot_i16x8((w).v01l, (a45)),                       \
                wasm_i32x4_dot_i16x8((w).v23l, (a67))));                     \
        (c_h) = wasm_i32x4_add(                                              \
            (c_h), wasm_i32x4_add(                                           \
                wasm_i32x4_dot_i16x8((w).v01h, (a45)),                       \
                wasm_i32x4_dot_i16x8((w).v23h, (a67))));                     \
    } while (0)

/* 4 rows x 8 lanes -> int32, row-major into c[4][8]. */
static inline void fe_wasm_tile4x8(int K, const int8_t *a0, const int8_t *a1,
                                   const int8_t *a2, const int8_t *a3,
                                   const int8_t *blk, int32_t *c) {
    v128_t c0l = wasm_i32x4_splat(0), c0h = c0l;
    v128_t c1l = c0l, c1h = c0l;
    v128_t c2l = c0l, c2h = c0l;
    v128_t c3l = c0l, c3h = c0l;

    const int k8 = K >> 3;
    for (int g = 0; g < k8; g++) {
        const int8_t *wg = blk + (size_t)g * (2 * FE_WASM_NR * 4);
        const fe_wasm_w8 w = fe_wasm_w8_load(wg);
        v128_t a01, a23, a45, a67;
        fe_wasm_act8(a0 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW(c0l, c0h, a01, a23, a45, a67, w);
        fe_wasm_act8(a1 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW(c1l, c1h, a01, a23, a45, a67, w);
        fe_wasm_act8(a2 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW(c2l, c2h, a01, a23, a45, a67, w);
        fe_wasm_act8(a3 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW(c3l, c3h, a01, a23, a45, a67, w);
    }

    if (K & 4) {
        const int g = k8 * 2;
        const int8_t *wg = blk + (size_t)g * (FE_WASM_NR * 4);
        const v128_t lo = wasm_v128_load(wg);
        const v128_t hi = wasm_v128_load(wg + 16);
        const v128_t w01l = FE_WASM_WPAIR(lo, 0), w23l = FE_WASM_WPAIR(lo, 2);
        const v128_t w01h = FE_WASM_WPAIR(hi, 0), w23h = FE_WASM_WPAIR(hi, 2);
#define FE_WASM_ROW4(c_l, c_h, ap)                                           \
        do {                                                                 \
            uint32_t raw;                                                    \
            memcpy(&raw, (ap) + 4 * (size_t)g, 4);                           \
            const v128_t x = wasm_i16x8_extend_low_i8x16(                     \
                wasm_i64x2_splat((int64_t)raw));                              \
            const v128_t a01 = wasm_i16x8_shuffle(x, x, 0, 1, 0, 1, 0, 1, 0, 1);\
            const v128_t a23 = wasm_i16x8_shuffle(x, x, 2, 3, 2, 3, 2, 3, 2, 3);\
            (c_l) = wasm_i32x4_add(                                          \
                (c_l), wasm_i32x4_add(                                       \
                    wasm_i32x4_dot_i16x8(w01l, a01),                         \
                    wasm_i32x4_dot_i16x8(w23l, a23)));                       \
            (c_h) = wasm_i32x4_add(                                          \
                (c_h), wasm_i32x4_add(                                       \
                    wasm_i32x4_dot_i16x8(w01h, a01),                         \
                    wasm_i32x4_dot_i16x8(w23h, a23)));                       \
        } while (0)
        FE_WASM_ROW4(c0l, c0h, a0);
        FE_WASM_ROW4(c1l, c1h, a1);
        FE_WASM_ROW4(c2l, c2h, a2);
        FE_WASM_ROW4(c3l, c3h, a3);
#undef FE_WASM_ROW4
    }

    wasm_v128_store(c + 0, c0l); wasm_v128_store(c + 4, c0h);
    wasm_v128_store(c + 8, c1l); wasm_v128_store(c + 12, c1h);
    wasm_v128_store(c + 16, c2l); wasm_v128_store(c + 20, c2h);
    wasm_v128_store(c + 24, c3l); wasm_v128_store(c + 28, c3h);

    /* K % 4 remainder: only the last group can be partial. */
    if (K & 3) {
        const int base = (K >> 2) * 4;
        const int rest = K - base;
        const int8_t *w = blk + (size_t)(K >> 2) * (FE_WASM_NR * 4);
        for (int r = 0; r < FE_WASM_MR; r++) {
            const int8_t *ap = (r == 0) ? a0 : (r == 1) ? a1
                              : (r == 2) ? a2 : a3;
            for (int lane = 0; lane < FE_WASM_NR; lane++) {
                int32_t acc = 0;
                for (int kk = 0; kk < rest; kk++)
                    acc += (int32_t)ap[base + kk] *
                           (int32_t)w[(size_t)lane * 4 + kk];
                c[r * 8 + lane] += acc;
            }
        }
    }
}

/* ------------------------------------------------------------------------
 * Pair-interleaved weight layout (fe_qgemm_repack_wasm, load time).
 *
 * The DOTPROD layout stores four k per lane, so the dot operands have to be
 * gathered with a byte shuffle. Repacking at load time instead puts one
 * k-pair of all eight lanes into a single 16-byte vector:
 *
 *   v = [w0k0 w0k1 w1k0 w1k1 w2k0 w2k1 w3k0 w3k1  |
 *        w4k0 w4k1 w5k0 w5k1 w6k0 w6k1 w7k0 w7k1]
 *
 * One load plus two widening moves then yield both the low-lane and the
 * high-lane dot operands, with no shuffle on the critical path. The buffer
 * keeps the size of the DOTPROD pack (K*NR bytes per N-block) and no weight
 * byte leaves its own output lane, so row sums and per-channel scales stay
 * valid.
 *
 * Precondition: K is a multiple of 8. Callers check that and fall back to
 * fe_wasm_tile4x8 on the DOTPROD layout otherwise.
 */
typedef struct {
    v128_t p0l, p0h, p1l, p1h;
    v128_t p2l, p2h, p3l, p3h;
} fe_wasm_w8p;

static inline fe_wasm_w8p fe_wasm_w8p_load(const int8_t *w) {
    fe_wasm_w8p r;
    v128_t v = wasm_v128_load(w);
    r.p0l = wasm_i16x8_extend_low_i8x16(v);
    r.p0h = wasm_i16x8_extend_high_i8x16(v);
    v = wasm_v128_load(w + 16);
    r.p1l = wasm_i16x8_extend_low_i8x16(v);
    r.p1h = wasm_i16x8_extend_high_i8x16(v);
    v = wasm_v128_load(w + 32);
    r.p2l = wasm_i16x8_extend_low_i8x16(v);
    r.p2h = wasm_i16x8_extend_high_i8x16(v);
    v = wasm_v128_load(w + 48);
    r.p3l = wasm_i16x8_extend_low_i8x16(v);
    r.p3h = wasm_i16x8_extend_high_i8x16(v);
    return r;
}

#define FE_WASM_ROW_P(c_l, c_h, a01, a23, a45, a67, w)                       \
    do {                                                                     \
        (c_l) = wasm_i32x4_add(                                              \
            (c_l), wasm_i32x4_add(                                           \
                wasm_i32x4_add(wasm_i32x4_dot_i16x8((w).p0l, (a01)),         \
                               wasm_i32x4_dot_i16x8((w).p1l, (a23))),        \
                wasm_i32x4_add(wasm_i32x4_dot_i16x8((w).p2l, (a45)),         \
                               wasm_i32x4_dot_i16x8((w).p3l, (a67)))));      \
        (c_h) = wasm_i32x4_add(                                              \
            (c_h), wasm_i32x4_add(                                           \
                wasm_i32x4_add(wasm_i32x4_dot_i16x8((w).p0h, (a01)),         \
                               wasm_i32x4_dot_i16x8((w).p1h, (a23))),        \
                wasm_i32x4_add(wasm_i32x4_dot_i16x8((w).p2h, (a45)),         \
                               wasm_i32x4_dot_i16x8((w).p3h, (a67)))));      \
    } while (0)

/* 4 rows x 8 lanes -> int32, row-major into c[4][8]. K % 8 == 0. */
static inline void fe_wasm_tile4x8p(int K, const int8_t *a0, const int8_t *a1,
                                    const int8_t *a2, const int8_t *a3,
                                    const int8_t *blk, int32_t *c) {
    v128_t c0l = wasm_i32x4_splat(0), c0h = c0l;
    v128_t c1l = c0l, c1h = c0l;
    v128_t c2l = c0l, c2h = c0l;
    v128_t c3l = c0l, c3h = c0l;

    const int k8 = K >> 3;
    for (int g = 0; g < k8; g++) {
        const fe_wasm_w8p w = fe_wasm_w8p_load(blk + (size_t)g * 64);
        v128_t a01, a23, a45, a67;
        fe_wasm_act8(a0 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW_P(c0l, c0h, a01, a23, a45, a67, w);
        fe_wasm_act8(a1 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW_P(c1l, c1h, a01, a23, a45, a67, w);
        fe_wasm_act8(a2 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW_P(c2l, c2h, a01, a23, a45, a67, w);
        fe_wasm_act8(a3 + 8 * (size_t)g, &a01, &a23, &a45, &a67);
        FE_WASM_ROW_P(c3l, c3h, a01, a23, a45, a67, w);
    }

    wasm_v128_store(c + 0, c0l); wasm_v128_store(c + 4, c0h);
    wasm_v128_store(c + 8, c1l); wasm_v128_store(c + 12, c1h);
    wasm_v128_store(c + 16, c2l); wasm_v128_store(c + 20, c2h);
    wasm_v128_store(c + 24, c3l); wasm_v128_store(c + 28, c3h);
}

/* Tile for buffers that went through fe_qgemm_repack_wasm: pair layout when
 * K allows it, DOTPROD layout otherwise. */
static inline void fe_wasm_tile(int K, const int8_t *a0, const int8_t *a1,
                                const int8_t *a2, const int8_t *a3,
                                const int8_t *blk, int32_t *c) {
    if ((K & 7) == 0)
        fe_wasm_tile4x8p(K, a0, a1, a2, a3, blk, c);
    else
        fe_wasm_tile4x8(K, a0, a1, a2, a3, blk, c);
}

#endif /* wasm */
#endif /* FE_QGEMM_WASM_KERNEL_H */
