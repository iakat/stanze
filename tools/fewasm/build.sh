#!/bin/bash
# Build the FastEnhancer wasm tier: a reactor module for the page.
# The engine keeps its state in globals, so one instance is one stream; the
# host copies one frame in, calls fe_run, and copies one frame out.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
R=$HERE/engine
OUT=${1:-$HERE/build}
CC=${CC:-clang}
OPT=${OPT:--O3}
# FE_WARMUP_FRAMES lowers the silence the engine runs at init. The reference
# count is 128, which costs ~0.4 s on a phone; 8 is enough to settle the tier
# and fault the hot pages in, and the stream is reset right after either way.
DEFS="-DNDEBUG -DFE_WARMUP_FRAMES=8"
CFLAGS="--target=wasm32-wasip1 -msimd128 $OPT $DEFS -D_WASI_EMULATED_MMAN -I$R/include -I$R/src -I$R/src/internal"
rm -rf "$OUT"; mkdir -p "$OUT"
SRCS=$(cd "$R" && ls src/*.c src/nn/*.c src/qgemm/*.c src/qgemm/wasm/*.c src/fft/*.c src/winograd/*.c 2>/dev/null)
for f in $SRCS; do
  $CC $CFLAGS -c "$R/$f" -o "$OUT/$(echo "$f" | tr '/' '_').o"
done
$CC --target=wasm32-wasip1 -msimd128 $OPT -mexec-model=reactor \
  -Wl,--export=fe_init -Wl,--export=fe_run -Wl,--export=fe_reset \
  -Wl,--export=fe_web_frame -Wl,--export=malloc -Wl,--export=free \
  -Wl,--initial-memory=2097152 -Wl,--max-memory=67108864 \
  -Wl,-z,stack-size=262144 \
  -o "$OUT/fe.wasm" "$OUT"/*.o -lwasi-emulated-mman
ls -l "$OUT/fe.wasm"
