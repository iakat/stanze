/* fp16 (IEEE 754 binary16 / S1E5M10) helpers for runtime state storage.
 *
 * Hardware fp16 conversion is GUARANTEED on all deployment ISAs:
 *   x86: the minimum tier is AVX2+FMA3+F16C — VCVTPS2PH / VCVTPH2PS.
 *        1 µop, 5-7c latency, 1/cycle throughput on Haswell+.
 *   ARM: NEON baseline (aarch64) mandates FCVTN / FCVTL.
 *        Available on every aarch64 target (M2, X3, A78, A55).
 *
 * Dimension contract: all engine call sites pass n that is a multiple of
 * the vector width (8 on x86, 4 on ARM). FE_C1=96, FE_F1=128 and
 * FE_FREQ_BINS=512 are 16-aligned; FE_C2=72 and FE_F2=72 are
 * 8-aligned. The misaligned-n scalar fallback helper variants were removed
 * — if a misaligned n ever reaches one of these helpers it's a contract
 * violation; the abort() guard catches it loudly in release builds rather
 * than silently producing wrong output.
 *
 * Bit-id within fp16 path: hardware conversion is deterministic (RNE
 * rounding), so cross-tier byte-id holds for the fp16 path itself —
 * just different output than the fp32 path.
 */
#ifndef FE_FP16_H
#define FE_FP16_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#if defined(__wasm__) || defined(__wasm32__)
#include <wasm_simd128.h>
#endif

#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
#  include <immintrin.h>
#elif defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
#  include <arm_neon.h>
#elif defined(__wasm__) || defined(__wasm32__)
/* SIMD128 has no fp16 conversion op in the baseline. Software RNE
 * conversion, 4 lanes at a time; the dimension contract stays 4-aligned. */
#include <math.h>
#else
#  error "fe_fp16.h requires x86_64 (AVX2/FMA3/F16C), aarch64 (NEON FCVT) or wasm32"
#endif

/* Single-line guard for callers: any leftover after the SIMD loop is a
 * dimension contract violation; abort loudly. */
static inline void fe_fp16_alignment_violation(void) { abort(); }

#if defined(__wasm__) || defined(__wasm32__)
/* fp32 bits -> fp16 bits, round to nearest even. */
static inline uint16_t fe_f32_to_f16_bits(float f) {
    uint32_t x;
    memcpy(&x, &f, 4);
    uint32_t sign = (x >> 16) & 0x8000u;
    int32_t exp = (int32_t)((x >> 23) & 0xffu);
    uint32_t mant = x & 0x7fffffu;
    if (exp == 0xff) {
        if (mant == 0) return (uint16_t)(sign | 0x7c00u);
        uint16_t pay = (uint16_t)(mant >> 13);
        if (pay == 0) pay = 1;
        return (uint16_t)(sign | 0x7e00u | pay);
    }
    if (exp == 0) return (uint16_t)sign; /* fp32 subnormal -> fp16 zero */
    int32_t e = exp - 127 + 15;
    if (e >= 0x1f) return (uint16_t)(sign | 0x7c00u);
    if (e <= 0) {
        mant |= 0x800000u;
        int shift = 14 - e;
        if (shift > 24) return (uint16_t)sign;
        uint32_t v = mant >> shift;
        uint32_t rem = mant & ((1u << shift) - 1u);
        uint32_t half = 1u << (shift - 1);
        if (rem > half || (rem == half && (v & 1u))) v++;
        return (uint16_t)(sign | v);
    }
    uint32_t v = ((uint32_t)e << 10) | (mant >> 13);
    uint32_t rem = mant & 0x1fffu;
    if (rem > 0x1000u || (rem == 0x1000u && (v & 1u))) v++;
    return (uint16_t)(sign | v);
}

/* fp16 bits -> fp32 (exact). */
static inline float fe_f16_bits_to_f32(uint16_t h) {
    uint32_t sign = (uint32_t)(h & 0x8000u) << 16;
    uint32_t exp = (h >> 10) & 0x1fu;
    uint32_t mant = h & 0x3ffu;
    uint32_t x;
    if (exp == 0) {
        if (mant == 0) {
            x = sign;
        } else {
            int e = 0;
            while (!(mant & 0x400u)) { mant <<= 1; e++; }
            mant &= 0x3ffu;
            /* fp16 subnormal = mant * 2^-24; after normalising to a 1.0
             * mantissa the fp32 exponent is 127 - 14 - e. */
            x = sign | ((uint32_t)(127 - 14 - e) << 23) | (mant << 13);
        }
    } else if (exp == 0x1f) {
        x = sign | 0x7f800000u | (mant << 13);
    } else {
        x = sign | ((exp - 15u + 127u) << 23) | (mant << 13);
    }
    float f;
    memcpy(&f, &x, 4);
    return f;
}
#endif

/* ---------------------------------------------------------------- *
 *  Vector SIMD conversion (the only path — no scalar fallback)
 * ---------------------------------------------------------------- */

#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)

/* Store 8 fp32 lanes as 8 fp16 (RNE). */
__attribute__((target("avx2,f16c,fma")))
static inline void fe_fp16_store8(uint16_t *dst, __m256 v) {
    _mm_storeu_si128((__m128i *)dst,
                     _mm256_cvtps_ph(v,
                         _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC));
}

/* Load 8 fp16 lanes and expand to fp32. */
__attribute__((target("avx2,f16c,fma")))
static inline __m256 fe_fp16_load8(const uint16_t *src) {
    return _mm256_cvtph_ps(_mm_loadu_si128((const __m128i *)src));
}

#endif /* x86 */

#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)

/* Store 4 fp32 lanes as 4 fp16. */
static inline void fe_fp16_store4(uint16_t *dst, float32x4_t v) {
    float16x4_t h = vcvt_f16_f32(v);
    vst1_u16(dst, vreinterpret_u16_f16(h));
}

/* Load 4 fp16 lanes and expand to fp32. */
static inline float32x4_t fe_fp16_load4(const uint16_t *src) {
    float16x4_t h = vreinterpret_f16_u16(vld1_u16(src));
    return vcvt_f32_f16(h);
}

#endif /* aarch64 */

#if defined(__wasm__) || defined(__wasm32__)

/* 4-lane SIMD128 fp32 -> fp16 (RNE), bit-identical to the scalar reference.
 * The normal range takes the exponent/mantissa path with a round-half-to-even
 * increment; magnitudes below the fp16 normal range scale by 2^24, where the
 * product is exact and f32x4.nearest gives the correct RNE mantissa. */
static inline v128_t fe_fp16_pack_v(v128_t f) {
    const v128_t m_abs  = wasm_i32x4_splat(0x7fffffffu);
    const v128_t m_neg  = wasm_i32x4_splat((int32_t)0x80000000u);
    const v128_t sgn32  = wasm_v128_and(f, m_neg);
    const v128_t ab     = wasm_v128_and(f, m_abs);
    const v128_t sign   = wasm_u32x4_shr(sgn32, 16);
    const v128_t exp    = wasm_u32x4_shr(ab, 23);
    const v128_t mant   = wasm_v128_and(ab, wasm_i32x4_splat(0x7fffffu));

    v128_t v = wasm_v128_or(
        wasm_i32x4_shl(wasm_i32x4_sub(exp, wasm_i32x4_splat(112)), 10),
        wasm_u32x4_shr(mant, 13));
    const v128_t rem = wasm_v128_and(mant, wasm_i32x4_splat(0x1fffu));
    const v128_t up = wasm_i32x4_add(
        wasm_v128_and(wasm_u32x4_gt(rem, wasm_i32x4_splat(0x1000u)),
                      wasm_i32x4_splat(1)),
        wasm_v128_and(wasm_i32x4_eq(rem, wasm_i32x4_splat(0x1000u)),
                      wasm_v128_and(v, wasm_i32x4_splat(1))));
    v = wasm_i32x4_add(v, up);
    v = wasm_v128_or(v, sign);

    v128_t tiny = wasm_i32x4_trunc_sat_f32x4(
        wasm_f32x4_nearest(wasm_f32x4_mul(ab, wasm_f32x4_splat(16777216.0f))));
    tiny = wasm_v128_or(tiny, sign);

    const v128_t isnorm = wasm_v128_and(
        wasm_u32x4_ge(exp, wasm_i32x4_splat(113)),
        wasm_u32x4_le(exp, wasm_i32x4_splat(142)));
    v = wasm_v128_bitselect(v, tiny, isnorm);

    /* Inf and NaN both land on the largest exponent. */
    const v128_t isbig = wasm_u32x4_ge(exp, wasm_i32x4_splat(143));
    const v128_t isnan = wasm_i32x4_ne(exp, wasm_i32x4_splat(0xff));
    const v128_t pay  = wasm_i32x4_max(wasm_u32x4_shr(mant, 13),
                                       wasm_i32x4_splat(1));
    const v128_t qnan = wasm_v128_or(sign, wasm_v128_or(
        wasm_i32x4_splat(0x7e00u), pay));
    const v128_t inf  = wasm_v128_or(sign, wasm_i32x4_splat(0x7c00u));
    const v128_t big  = wasm_v128_bitselect(inf, qnan, isnan);
    return wasm_v128_bitselect(big, v, isbig);
}

/* 4 fp16 lanes (low 64 bits) -> fp32, exact. */
static inline v128_t fe_fp16_unpack_v(v128_t h4) {
    const v128_t hu   = wasm_u32x4_extend_low_u16x8(h4);
    const v128_t sign = wasm_i32x4_shl(wasm_v128_and(hu, wasm_i32x4_splat(0x8000u)), 16);
    const v128_t exp  = wasm_v128_and(wasm_u32x4_shr(hu, 10), wasm_i32x4_splat(0x1fu));
    const v128_t mant = wasm_v128_and(hu, wasm_i32x4_splat(0x3ffu));

    v128_t nx = wasm_v128_or(sign,
        wasm_i32x4_shl(wasm_i32x4_add(exp, wasm_i32x4_splat(112)), 23));
    nx = wasm_v128_or(nx, wasm_i32x4_shl(mant, 13));
    /* fp16 subnormal = mant * 2^-24, exactly representable. */
    v128_t sub = wasm_f32x4_mul(
        wasm_f32x4_convert_i32x4(mant), wasm_f32x4_splat(5.9604644775390625e-8f));
    sub = wasm_v128_or(sub, sign);
    v128_t r = wasm_v128_bitselect(sub, nx,
                                   wasm_i32x4_eq(exp, wasm_i32x4_splat(0)));
    /* exp == 31: inf / NaN keep their payload. */
    const v128_t ex = wasm_v128_or(sign,
        wasm_i32x4_splat(0x7f800000u));
    v128_t inf = wasm_v128_or(ex, wasm_i32x4_shl(mant, 13));
    return wasm_v128_bitselect(inf, r,
                               wasm_i32x4_eq(exp, wasm_i32x4_splat(31)));
}

/* 4-lane façade over the vector converters so the NEON-shaped engine
 * branches (fe_load/fe_store + fe_fp16_store4) compile unchanged. */
static inline void fe_fp16_store4(uint16_t *dst, v128_t v) {
    /* Each lane holds one fp16 in its low half; gather the four. */
    const v128_t p = fe_fp16_pack_v(v);
    const v128_t h = wasm_i8x16_shuffle(p, p, 0, 1, 4, 5, 8, 9, 12, 13,
                                        0, 1, 4, 5, 8, 9, 12, 13);
    const int64_t lo = wasm_i64x2_extract_lane(h, 0);
    memcpy(dst, &lo, 8);
}
static inline v128_t fe_fp16_load4(const uint16_t *src) {
    int64_t lo;
    memcpy(&lo, src, 8);
    return fe_fp16_unpack_v(wasm_i64x2_splat(lo));
}
#endif

/* ---------------------------------------------------------------- *
 *  Buffer-level conversions
 *  Caller contract: n must be a multiple of the SIMD width
 *  (8 on x86, 4 on ARM). Violation → abort().
 * ---------------------------------------------------------------- */

/* fp32 [n] -> fp16 [n]. */
#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
__attribute__((target("avx2,f16c,fma")))
#endif
static inline void fe_fp16_pack_buf(uint16_t *dst, const float *src, int n) {
    int i = 0;
#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
    for (; i + 7 < n; i += 8) {
        __m256 v = _mm256_loadu_ps(src + i);
        fe_fp16_store8(dst + i, v);
    }
#elif defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
    for (; i + 3 < n; i += 4) {
        float32x4_t v = vld1q_f32(src + i);
        fe_fp16_store4(dst + i, v);
    }
#elif defined(__wasm__) || defined(__wasm32__)
    for (; i + 15 < n; i += 16) {
        fe_fp16_store4(dst + i +  0, wasm_v128_load(src + i +  0));
        fe_fp16_store4(dst + i +  4, wasm_v128_load(src + i +  4));
        fe_fp16_store4(dst + i +  8, wasm_v128_load(src + i +  8));
        fe_fp16_store4(dst + i + 12, wasm_v128_load(src + i + 12));
    }
    for (; i + 3 < n; i += 4) fe_fp16_store4(dst + i, wasm_v128_load(src + i));
#endif
    if (i != n) fe_fp16_alignment_violation();
}

/* fp16-input min/max scan. Reads fp16 once with on-the-fly cvt; no
 * fp32 materialization. Output matches fe_qg_min_max signature. */
#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
__attribute__((target("avx2,f16c,fma")))
#endif
static inline void fe_fp16_min_max(const uint16_t *p, int n,
                                    float *min_out, float *max_out) {
    if (n <= 0) { *min_out = 0.0f; *max_out = 0.0f; return; }
    int i = 0;
    float vmin = 0.0f, vmax = 0.0f;
#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
    {
        __m256 v0 = fe_fp16_load8(p);
        __m256 vmn = v0, vmx = v0;
        i = 8;
        for (; i + 7 < n; i += 8) {
            __m256 v = fe_fp16_load8(p + i);
            vmn = _mm256_min_ps(vmn, v);
            vmx = _mm256_max_ps(vmx, v);
        }
        __m128 lo = _mm256_castps256_ps128(vmn);
        __m128 hi = _mm256_extractf128_ps(vmn, 1);
        __m128 mn = _mm_min_ps(lo, hi);
        mn = _mm_min_ps(mn, _mm_movehl_ps(mn, mn));
        mn = _mm_min_ss(mn, _mm_shuffle_ps(mn, mn, 1));
        vmin = _mm_cvtss_f32(mn);
        lo = _mm256_castps256_ps128(vmx);
        hi = _mm256_extractf128_ps(vmx, 1);
        __m128 mx = _mm_max_ps(lo, hi);
        mx = _mm_max_ps(mx, _mm_movehl_ps(mx, mx));
        mx = _mm_max_ss(mx, _mm_shuffle_ps(mx, mx, 1));
        vmax = _mm_cvtss_f32(mx);
    }
#elif defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
    {
        float32x4_t v0 = fe_fp16_load4(p);
        float32x4_t vmn = v0, vmx = v0;
        i = 4;
        for (; i + 3 < n; i += 4) {
            float32x4_t v = fe_fp16_load4(p + i);
            vmn = vminq_f32(vmn, v);
            vmx = vmaxq_f32(vmx, v);
        }
        vmin = vminvq_f32(vmn);
        vmax = vmaxvq_f32(vmx);
    }
#elif defined(__wasm__) || defined(__wasm32__)
    {
        v128_t vmn = fe_fp16_load4(p);
        v128_t vmx = vmn;
        i = 4;
        for (; i + 3 < n; i += 4) {
            const v128_t v = fe_fp16_load4(p + i);
            vmn = wasm_f32x4_min(vmn, v);
            vmx = wasm_f32x4_max(vmx, v);
        }
        vmn = wasm_f32x4_min(vmn, wasm_i32x4_shuffle(vmn, vmn, 2, 3, 0, 1));
        vmn = wasm_f32x4_min(vmn, wasm_i32x4_shuffle(vmn, vmn, 1, 0, 3, 2));
        vmx = wasm_f32x4_max(vmx, wasm_i32x4_shuffle(vmx, vmx, 2, 3, 0, 1));
        vmx = wasm_f32x4_max(vmx, wasm_i32x4_shuffle(vmx, vmx, 1, 0, 3, 2));
        vmin = wasm_f32x4_extract_lane(vmn, 0);
        vmax = wasm_f32x4_extract_lane(vmx, 0);
    }
#endif
    if (i != n) fe_fp16_alignment_violation();
    *min_out = vmin;
    *max_out = vmax;
}

/* fp16-input asymmetric quantize. q = clamp(round(x*inv) + zp_off). */
#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
__attribute__((target("avx2,f16c,fma")))
#endif
static inline void fe_fp16_quantize_asym(const uint16_t *p, int n,
                                          int8_t *out, float inv,
                                          int32_t zp_off) {
    int i = 0;
    const float zof = (float)zp_off;
#if defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
    const __m256 vinv = _mm256_set1_ps(inv);
    const __m256 vzof = _mm256_set1_ps(zof);
    for (; i + 7 < n; i += 8) {
        __m256 v = _mm256_fmadd_ps(fe_fp16_load8(p + i), vinv, vzof);
        __m256i q = _mm256_cvtps_epi32(v);
        __m128i lo = _mm256_castsi256_si128(q);
        __m128i hi = _mm256_extracti128_si256(q, 1);
        __m128i s  = _mm_packs_epi32(lo, hi);
        __m128i b  = _mm_packs_epi16(s, s);
        _mm_storel_epi64((__m128i *)(out + i), b);
    }
#elif defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
    const float32x4_t vinv = vdupq_n_f32(inv);
    const float32x4_t vzof = vdupq_n_f32(zof);
    for (; i + 15 < n; i += 16) {
        float32x4_t v0 = fe_fp16_load4(p + i +  0);
        float32x4_t v1 = fe_fp16_load4(p + i +  4);
        float32x4_t v2 = fe_fp16_load4(p + i +  8);
        float32x4_t v3 = fe_fp16_load4(p + i + 12);
        int32x4_t q0 = vcvtnq_s32_f32(vfmaq_f32(vzof, v0, vinv));
        int32x4_t q1 = vcvtnq_s32_f32(vfmaq_f32(vzof, v1, vinv));
        int32x4_t q2 = vcvtnq_s32_f32(vfmaq_f32(vzof, v2, vinv));
        int32x4_t q3 = vcvtnq_s32_f32(vfmaq_f32(vzof, v3, vinv));
        int16x8_t s01 = vcombine_s16(vqmovn_s32(q0), vqmovn_s32(q1));
        int16x8_t s23 = vcombine_s16(vqmovn_s32(q2), vqmovn_s32(q3));
        vst1q_s8(out + i, vcombine_s8(vqmovn_s16(s01), vqmovn_s16(s23)));
    }
    for (; i + 3 < n; i += 4) {
        float32x4_t v = fe_fp16_load4(p + i);
        int32x4_t q = vcvtnq_s32_f32(vfmaq_f32(vzof, v, vinv));
        int16x4_t s = vqmovn_s32(q);
        int8x8_t  b = vqmovn_s16(vcombine_s16(s, vdup_n_s16(0)));
        uint32_t  w = (uint32_t)vget_lane_u32(vreinterpret_u32_s8(b), 0);
        for (int k = 0; k < 4; ++k) out[i + k] = (int8_t)((w >> (k * 8)) & 0xff);
    }
#elif defined(__wasm__) || defined(__wasm32__)
    {
        const v128_t vinv = wasm_f32x4_splat(inv);
        const v128_t vzof = wasm_f32x4_splat(zof);
        const v128_t vmin = wasm_i32x4_splat(-128);
        const v128_t vmax = wasm_i32x4_splat(127);
        for (; i + 15 < n; i += 16) {
            v128_t q0 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_nearest(
                wasm_f32x4_add(wasm_f32x4_mul(fe_fp16_load4(p + i +  0), vinv), vzof)));
            v128_t q1 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_nearest(
                wasm_f32x4_add(wasm_f32x4_mul(fe_fp16_load4(p + i +  4), vinv), vzof)));
            v128_t q2 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_nearest(
                wasm_f32x4_add(wasm_f32x4_mul(fe_fp16_load4(p + i +  8), vinv), vzof)));
            v128_t q3 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_nearest(
                wasm_f32x4_add(wasm_f32x4_mul(fe_fp16_load4(p + i + 12), vinv), vzof)));
            q0 = wasm_i32x4_min(wasm_i32x4_max(q0, vmin), vmax);
            q1 = wasm_i32x4_min(wasm_i32x4_max(q1, vmin), vmax);
            q2 = wasm_i32x4_min(wasm_i32x4_max(q2, vmin), vmax);
            q3 = wasm_i32x4_min(wasm_i32x4_max(q3, vmin), vmax);
            wasm_v128_store(out + i, wasm_i8x16_narrow_i16x8(
                wasm_i16x8_narrow_i32x4(q0, q1),
                wasm_i16x8_narrow_i32x4(q2, q3)));
        }
        for (; i + 3 < n; i += 4) {
            v128_t q = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_nearest(
                wasm_f32x4_add(wasm_f32x4_mul(fe_fp16_load4(p + i), vinv), vzof)));
            q = wasm_i32x4_min(wasm_i32x4_max(q, vmin), vmax);
            const v128_t b = wasm_i8x16_narrow_i16x8(
                wasm_i16x8_narrow_i32x4(q, q), wasm_i16x8_narrow_i32x4(q, q));
            const int32_t w = wasm_i32x4_extract_lane(b, 0);
            memcpy(out + i, &w, 4);
        }
    }
#endif
    if (i != n) fe_fp16_alignment_violation();
}

#endif /* FE_FP16_H */
