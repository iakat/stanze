# FastEnhancer wasm tier

A browser build of the FastEnhancer Medium denoiser (`faster-enhancer.c`) that
replaces the 14.8 MB ONNX Runtime graph with a 305 KB module and a 565 KB
weight blob.

`engine/` is the upstream C tree with the wasm tier added. The ARM and x86
kernel files, the native test runners and the offline tools are left out; this
copy builds for wasm32 only.

- `src/qgemm/wasm/` — int8 and fused fp32 GEMM kernels, the K=20 attention
  variant, both GRU forms, and the prefault stub, written in wasm SIMD128.
- `src/fft/fft_wasm.c` — the 1024 point real FFT for wasm.
- `src/winograd/fe_winograd.c` — wasm quantise and fused fp32 epilogues.
- `src/internal/fe_fp16.h` — software fp16 conversion, because wasm has no
  fp16 arithmetic.
- `src/fe_web.c` — the one browser entry point, `fe_web_frame`.

## Build

    CC=/path/to/clang ./build.sh        # writes build/fe.wasm

The build needs `clang` with the wasm32 target and `wasi-libc` (tested with
wasi-sdk). The result is a reactor module: no `_start`, and the host makes the
two frame buffers with `malloc` and calls `fe_run(in, out)`. The engine keeps
its streaming state in globals, so one module instance is one stream.

The shipped `static/fe.wasm` is this build with `wasi-sdk` clang and `-O3`:

    f318a92dfe665d85e83de8667a91df1f97262a3aba821c2f10fc621389fbe563  fe.wasm
    d6f98e186bee6ed655b52a2edf5f707ccf761c755bb69de8de7f68cad42d7837  fe.q8

## State

- Output matches the reference build byte for byte over 800 frames, so the
  SIMD128 tier is the same arithmetic in the same order.
- 25 dB SNR against the native engine on the same input. The gap is the int8
  quantisation of the native path itself, not a logic difference.
- 3.2 ms per frame median, 3.7 ms at the 95th percentile, for 6.67 ms of audio
  (320 samples at 48 kHz) under Node. Native is 0.57 ms, ONNX Runtime wasm is
  2.75 ms.
- One fixed tier: SIMD128, which every browser that can run the page has. No
  runtime CPU detection.
- On a phone, keep one instance per stream and drop frames rather than queue
  them; the state is per stream and it cannot be shared.

## Licence

`engine/` is MIT, see `engine/LICENSE`. It is a modified copy of the upstream
tree; the modifications are the wasm tier files listed above.
