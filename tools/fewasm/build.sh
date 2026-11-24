#!/bin/bash
# Build the FastEnhancer wasm tier as a reactor module.
# Exports the frame API only; the page copies frames in and out.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
R=$HERE/engine
OUT=${1:-$HERE/build}
CC=${CC:-clang}
OPT=${OPT:--O3}
CFLAGS="--target=wasm32-wasip1 -msimd128 $OPT -D_WASI_EMULATED_MMAN -I$R/include -I$R/src -I$R/src/internal"
rm -rf "$OUT"; mkdir -p "$OUT"
SRCS=$(cd "$R" && ls src/*.c src/nn/*.c src/qgemm/*.c src/qgemm/wasm/*.c src/fft/*.c src/winograd/*.c 2>/dev/null \
  | grep -v 'x86/\|arm/\|fft_avx\|fft_neon\|fft_avx512\|fft_scalar\|qgemm_avx\|qgemm_neon\|qgemm_dotprod\|qgemm_i8mm\|qgemm_scalar\|qgemm_avx512')
for f in $SRCS; do
  $CC $CFLAGS -c "$R/$f" -o "$OUT/$(echo "$f" | tr '/' '_').o"
done
$CC --target=wasm32-wasip1 -msimd128 $OPT \
  -Wl,--export=fe_init -Wl,--export=fe_run -Wl,--export=fe_reset \
  -Wl,--export=fe_free -Wl,--export=malloc -Wl,--export=free \
  -Wl,--export=__wasm_call_ctors \
  -Wl,--export=fe_web_in -Wl,--export=fe_web_out -Wl,--export=fe_web_run \
  -Wl,--export=fe_web_frame \
  -Wl,--no-entry -Wl,--strip-all -o "$OUT/fe.wasm" "$OUT"/*.o \
  -lwasi-emulated-mman -Wl,-z,stack-size=262144
ls -l "$OUT/fe.wasm"
