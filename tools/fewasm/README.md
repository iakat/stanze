# FastEnhancer wasm tier

A browser build of the FastEnhancer Medium denoiser (`faster-enhancer.c`) that
replaces the 14.8 MB ONNX Runtime graph with a small wasm module.

`engine/` is the upstream C tree with the wasm tier added:

- `src/qgemm/wasm/` — int8 and fused fp32 GEMM kernels, the K=20 attention
  variant, both GRU forms, and the prefault stub, written in wasm SIMD128.
- `src/fft/fft_wasm.c` — the 1024 point real FFT for wasm.
- `src/winograd/fe_winograd.c` — wasm quantise and fused fp32 epilogues.
- `src/internal/fe_fp16.h` — software fp16 conversion, because wasm has no
  fp16 arithmetic.
- `src/fe_web.c` — reactor entry points (`fe_web_in`, `fe_web_out`,
  `fe_web_run`, `fe_web_frame`) so a page can call the engine without
  pointers.

## Build

    ./build.sh            # writes build/fe.wasm

The build needs `clang` with the wasm32 target and `wasi-libc`. Set `CC` to
your compiler if it is not `clang`.

## State

- Output matches the native build: SNR 22 dB, correlation 0.997 over the test
  frames. The gap is the int8 quantisation of the native path, not a logic
  difference.
- 3.7 ms per 6.67 ms frame (320 samples at 48 kHz) under Node with SIMD128.
  Native is 0.57 ms, ONNX Runtime wasm is 2.75 ms. Two Winograd spots are
  still scalar.
- Module size 151 KB with the weights kept as a separate 565 KB blob.

## Licence

`engine/` is MIT, see `engine/LICENSE`. It is a modified copy of the upstream
tree; the modifications are the wasm tier files listed above.
