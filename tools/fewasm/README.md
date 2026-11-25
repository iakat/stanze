# FastEnhancer wasm tier

A browser build of the FastEnhancer denoiser (`faster-enhancer.c`) that
replaces the 14.8 MB ONNX Runtime graph with a 150 KB module and a weight blob
of 121 KB (base), 236 KB (small) or 565 KB (medium). The page runs Small on
incoming streams.

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

    CC=/path/to/clang ./build.sh              # medium, writes build/fe.wasm
    TIER=small CC=/path/to/clang ./build.sh out   # the tier the page runs
    TIER=base  CC=/path/to/clang ./build.sh out   # smallest tier

The build needs `clang` with the wasm32 target and `wasi-libc` (tested with
wasi-sdk). The result is a reactor module: no `_start`, and the host makes the
two frame buffers with `malloc` and calls `fe_run(in, out)`. The engine keeps
its streaming state in globals, so one module instance is one stream.

The shipped `static/fe.wasm` is the small tier with `wasi-sdk` clang and `-O3`:

    eecdb111e4296d5a444d3a7916bc9cf7139dc7d67e9fbd4d1266bb9542c222ce  fe.wasm
    a2cdf08d4ce9e0a63d4e52cd1fddd29b64d2fd5728798135c379d7abcb97c57b  fe.q8

## State

- Output matches the reference build byte for byte over 800 frames, so the
  SIMD128 tier is the same arithmetic in the same order.
- 25 dB SNR against the native engine on the same input. The gap is the int8
  quantisation of the native path itself, not a logic difference.
- 1.4 ms per frame median, 1.9 ms at the 95th percentile, for 10.67 ms of audio
  (512 samples at 48 kHz) under Node, small tier. Medium is 3.8 ms for 6.67 ms
  of audio. Native Medium is 0.57 ms, ONNX Runtime wasm 2.75 ms.
- 32.9 dB SNR against the ONNX model at 512 hop over 800 frames, correlation
  0.9997, small tier; medium reaches 35 dB at 320 hop.
- One fixed tier: SIMD128, which every browser that can run the page has. No
  runtime CPU detection.
- On a phone, keep one instance per stream and drop frames rather than queue
  them; the state is per stream and it cannot be shared.

## Licence

`engine/` is MIT, see `engine/LICENSE`. It is a modified copy of the upstream
tree; the modifications are the wasm tier files listed above.
