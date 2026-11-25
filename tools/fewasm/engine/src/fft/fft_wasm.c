/* wasm32 FFT TU. SIMD128 is part of the wasm32 target, so there is no tier
 * selection and no per-file ISA flag. The transform is the same Stockham
 * radix-4 (L=1..64) plus final radix-2 (L=256) structure as the NEON and
 * AVX2 tiers, and the real-FFT pre/post stage keeps the same order of
 * operations: one fused multiply-add per complex multiply, matching the
 * fma used by the other tiers so the numeric drift stays comparable. */
#if defined(__wasm__) || defined(__wasm32__)
#include "fft_arch.h"
#include <math.h>
#include <string.h>

/* Complex multiply: (ar + i ai)(br + i bi). */
static inline void fe_wasm_cmul(float ar, float ai, float br, float bi,
                                float *out_re, float *out_im) {
    *out_re = fmaf(-ai, bi, ar * br);
    *out_im = fmaf(ai, br, ar * bi);
}

/* Radix-4 butterfly. Caller pre-multiplies a1..a3 by their twiddles. */
static inline void fe_wasm_radix4_butterfly(
        float a0_re, float a0_im,
        float b1_re, float b1_im,
        float b2_re, float b2_im,
        float b3_re, float b3_im,
        float *o0_re, float *o0_im,
        float *o1_re, float *o1_im,
        float *o2_re, float *o2_im,
        float *o3_re, float *o3_im) {
    const float t0_re = a0_re + b2_re, t0_im = a0_im + b2_im;
    const float t1_re = a0_re - b2_re, t1_im = a0_im - b2_im;
    const float t2_re = b1_re + b3_re, t2_im = b1_im + b3_im;
    const float t3_re = b1_re - b3_re, t3_im = b1_im - b3_im;

    *o0_re = t0_re + t2_re; *o0_im = t0_im + t2_im;
    *o1_re = t1_re + t3_im; *o1_im = t1_im - t3_re;
    *o2_re = t0_re - t2_re; *o2_im = t0_im - t2_im;
    *o3_re = t1_re - t3_im; *o3_im = t1_im + t3_re;
}

/* Stage 0 (L=1): no twiddles, four contiguous outputs per work unit. */
static void fft_wasm_stage0(const float *in_re, const float *in_im,
                            float *out_re, float *out_im) {
    const int stride = FE_FFT_HALF / 4;
    for (int u = 0; u < stride; ++u) {
        float o0_re, o0_im, o1_re, o1_im, o2_re, o2_im, o3_re, o3_im;
        fe_wasm_radix4_butterfly(
            in_re[u + 0 * stride], in_im[u + 0 * stride],
            in_re[u + 1 * stride], in_im[u + 1 * stride],
            in_re[u + 2 * stride], in_im[u + 2 * stride],
            in_re[u + 3 * stride], in_im[u + 3 * stride],
            &o0_re, &o0_im, &o1_re, &o1_im,
            &o2_re, &o2_im, &o3_re, &o3_im);

        out_re[4 * u + 0] = o0_re; out_im[4 * u + 0] = o0_im;
        out_re[4 * u + 1] = o1_re; out_im[4 * u + 1] = o1_im;
        out_re[4 * u + 2] = o2_re; out_im[4 * u + 2] = o2_im;
        out_re[4 * u + 3] = o3_re; out_im[4 * u + 3] = o3_im;
    }
}

/* Generic radix-4 stage (L >= 4). */
static void fft_wasm_radix4_stage(const float *in_re, const float *in_im,
                                  float *out_re, float *out_im,
                                  const float *twr, const float *twi,
                                  int L) {
    const int Ls = L * 4;
    const int n_groups = FE_FFT_HALF / Ls;
    const int stride = FE_FFT_HALF / 4;
    for (int j = 0; j < n_groups; ++j) {
        for (int k = 0; k < L; ++k) {
            const int in_base = j * L + k;
            const float a0_re = in_re[in_base + 0 * stride];
            const float a0_im = in_im[in_base + 0 * stride];
            const float a1_re = in_re[in_base + 1 * stride];
            const float a1_im = in_im[in_base + 1 * stride];
            const float a2_re = in_re[in_base + 2 * stride];
            const float a2_im = in_im[in_base + 2 * stride];
            const float a3_re = in_re[in_base + 3 * stride];
            const float a3_im = in_im[in_base + 3 * stride];

            float b1_re, b1_im, b2_re, b2_im, b3_re, b3_im;
            fe_wasm_cmul(a1_re, a1_im, twr[0 * L + k], twi[0 * L + k], &b1_re, &b1_im);
            fe_wasm_cmul(a2_re, a2_im, twr[1 * L + k], twi[1 * L + k], &b2_re, &b2_im);
            fe_wasm_cmul(a3_re, a3_im, twr[2 * L + k], twi[2 * L + k], &b3_re, &b3_im);

            float o0_re, o0_im, o1_re, o1_im, o2_re, o2_im, o3_re, o3_im;
            fe_wasm_radix4_butterfly(a0_re, a0_im, b1_re, b1_im, b2_re, b2_im,
                                     b3_re, b3_im,
                                     &o0_re, &o0_im, &o1_re, &o1_im,
                                     &o2_re, &o2_im, &o3_re, &o3_im);

            const int out_base = j * Ls + k;
            out_re[out_base + 0 * L] = o0_re; out_im[out_base + 0 * L] = o0_im;
            out_re[out_base + 1 * L] = o1_re; out_im[out_base + 1 * L] = o1_im;
            out_re[out_base + 2 * L] = o2_re; out_im[out_base + 2 * L] = o2_im;
            out_re[out_base + 3 * L] = o3_re; out_im[out_base + 3 * L] = o3_im;
        }
    }
}

/* Final radix-2 stage (L=256). */
static void fft_wasm_radix2_stage(const float *in_re, const float *in_im,
                                  float *out_re, float *out_im,
                                  const float *twr, const float *twi) {
    const int L = 256;
    for (int k = 0; k < L; ++k) {
        const float a_re = in_re[k],      a_im = in_im[k];
        const float b_re = in_re[k + L],  b_im = in_im[k + L];
        float bw_re, bw_im;
        fe_wasm_cmul(b_re, b_im, twr[k], twi[k], &bw_re, &bw_im);
        out_re[k]     = a_re + bw_re; out_im[k]     = a_im + bw_im;
        out_re[k + L] = a_re - bw_re; out_im[k + L] = a_im - bw_im;
    }
}

/* 512-pt complex FFT. */
static void fft_complex_512_wasm(const float *in_re, const float *in_im,
                                 float *out_re, float *out_im) {
    /* Ping-pong scratch. The engine runs one transform at a time. */
    static float buf_re[2][FE_FFT_HALF];
    static float buf_im[2][FE_FFT_HALF];

    fft_wasm_stage0(in_re, in_im, buf_re[0], buf_im[0]);

    int parity = 0;
    int L = 4;
    for (int s = 1; s < FE_FFT_R4_STAGES; ++s) {
        const float *twr = g_fft_plan.twiddle_r4_re + g_fft_plan.twiddle_r4_off[s];
        const float *twi = g_fft_plan.twiddle_r4_im + g_fft_plan.twiddle_r4_off[s];
        fft_wasm_radix4_stage(buf_re[parity], buf_im[parity],
                              buf_re[1 - parity], buf_im[1 - parity],
                              twr, twi, L);
        parity = 1 - parity;
        L *= 4;
    }
    fft_wasm_radix2_stage(buf_re[parity], buf_im[parity], out_re, out_im,
                          g_fft_plan.twiddle_r2_re, g_fft_plan.twiddle_r2_im);
}

/* Pack 1024 real samples into 512 complex pairs (evens, odds). */
static inline void fft_wasm_pack_real(const float *in_real,
                                      float *pack_re, float *pack_im) {
    for (int k = 0; k < FE_FFT_HALF; ++k) {
        pack_re[k] = in_real[2 * k];
        pack_im[k] = in_real[2 * k + 1];
    }
}

/* Real-FFT post-process (forward), bins 1..HALF-1. */
static void fft_wasm_real_post_forward(const float *Z_re, const float *Z_im,
                                       float *out_re, float *out_im) {
    out_re[0]           = Z_re[0] + Z_im[0]; out_im[0]           = 0.0f;
    out_re[FE_FFT_HALF] = Z_re[0] - Z_im[0]; out_im[FE_FFT_HALF] = 0.0f;

    for (int k = 1; k < FE_FFT_HALF; ++k) {
        const float zk_r = Z_re[k];
        const float zk_i = Z_im[k];
        const float zn_r = Z_re[FE_FFT_HALF - k];
        const float zn_i = Z_im[FE_FFT_HALF - k];
        const float sum_r = 0.5f * (zk_r + zn_r);
        const float sum_i = 0.5f * (zk_i - zn_i);
        const float dif_r = 0.5f * (zk_r - zn_r);
        const float dif_i = 0.5f * (zk_i + zn_i);
        float d_re, d_im;
        fe_wasm_cmul(dif_r, dif_i, g_fft_plan.realfft_re[k],
                     g_fft_plan.realfft_im[k], &d_re, &d_im);
        out_re[k] = sum_r + d_im;
        out_im[k] = sum_i - d_re;
    }
}

/* Real-FFT pre-process (inverse): rebuild 512 complex bins; the split
 * spectrum has no Nyquist bin (fe_istft zeroes it), so X[512] == 0. */
static void fft_wasm_real_pre_inverse(const float *in_re, const float *in_im,
                                      float *Z_re, float *Z_im) {
    Z_re[0] = in_re[0];
    Z_im[0] = in_re[0];

    for (int k = 1; k < FE_FFT_HALF; ++k) {
        const float xk_r = in_re[k],               xk_i = in_im[k];
        const float xn_r = in_re[FE_FFT_HALF - k], xn_i = in_im[FE_FFT_HALF - k];
        const float sum_r = xk_r + xn_r;
        const float sum_i = xk_i - xn_i;
        const float dif_r = xk_r - xn_r;
        const float dif_i = xk_i + xn_i;
        float d_re, d_im;
        fe_wasm_cmul(dif_r, dif_i, g_fft_plan.realfft_re[k],
                     -g_fft_plan.realfft_im[k], &d_re, &d_im);
        Z_re[k] = sum_r - d_im;
        Z_im[k] = sum_i + d_re;
    }
}

/* Public entry points. */
void fe_fft_forward_wasm(const float *in_real, float *out_re, float *out_im) {
    float pack_re[FE_FFT_HALF], pack_im[FE_FFT_HALF];
    fft_wasm_pack_real(in_real, pack_re, pack_im);

    float Z_re[FE_FFT_HALF], Z_im[FE_FFT_HALF];
    fft_complex_512_wasm(pack_re, pack_im, Z_re, Z_im);

    fft_wasm_real_post_forward(Z_re, Z_im, out_re, out_im);
}

void fe_fft_inverse_wasm(const float *in_re, const float *in_im, float *out_real) {
    float Z_re[FE_FFT_HALF], Z_im[FE_FFT_HALF];
    fft_wasm_real_pre_inverse(in_re, in_im, Z_re, Z_im);

    /* Inverse complex FFT via conjugation: invFFT(X) = conj(FFT(conj(X)))/N.
     * The 1/N scaling is folded into window_istft at init time. */
    for (int k = 0; k < FE_FFT_HALF; ++k) Z_im[k] = -Z_im[k];

    float W_re[FE_FFT_HALF], W_im[FE_FFT_HALF];
    fft_complex_512_wasm(Z_re, Z_im, W_re, W_im);

    /* Unpack: real_out[2k] = W_re[k], real_out[2k+1] = -W_im[k]. */
    for (int k = 0; k < FE_FFT_HALF; ++k) {
        out_real[2 * k]     =  W_re[k];
        out_real[2 * k + 1] = -W_im[k];
    }
}
#endif
