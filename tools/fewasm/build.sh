#!/bin/bash
# Build one FastEnhancer wasm tier: a reactor module for the page.
# The engine keeps its state in globals, so one instance is one stream; the
# host copies one frame in, calls fe_run, and copies one frame out.
#
#   ./build.sh [outdir]              # medium, writes <outdir>/fe.wasm
#   TIER=base  ./build.sh out        # base,   writes out/fe.wasm
#   TIER=small ./build.sh out        # small,  writes out/fe.wasm
#   TIER=medium ./build.sh out       # medium (default)
#
# Each tier is a separate compile: every shape in the engine is a compile-time
# constant. The two 512-hop tiers (base, small) also need -DFE_FRAME_SIZE=512,
# because the public frame size defaults to Medium's 320.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
R=$HERE/engine
OUT=${1:-$HERE/build}
CC=${CC:-clang}
OPT=${OPT:--O3}
TIER=${TIER:-medium}

case "$TIER" in
  base)   TIER_DEF=-DFE_TIER_BASE;  FRAME=512 ;;
  small)  TIER_DEF=-DFE_TIER_SMALL; FRAME=512 ;;
  medium) TIER_DEF=-DFE_TIER_MEDIUM; FRAME=320 ;;
  *) echo "unknown TIER: $TIER (base|small|medium)" >&2; exit 2 ;;
esac

# FE_WARMUP_FRAMES lowers the silence the engine runs at init. The reference
# count is 128, which costs ~0.4 s on a phone; 8 is enough to settle the tier
# and fault the hot pages in, and the stream is reset right after either way.
DEFS="-DNDEBUG -DFE_WARMUP_FRAMES=8 $TIER_DEF -DFE_FRAME_SIZE=$FRAME"
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
# Drop .debug_* and the name section: 155 KB of the module that the browser
# never reads. The code sections and the output are unchanged.
STRIP=${STRIP:-$(dirname "$CC")/llvm-strip}
[ -x "$STRIP" ] && "$STRIP" --strip-all "$OUT/fe.wasm"
# The tier and the frame it implies are written beside the module, because the
# pair (module, weights) is only valid together and a caller that copies the
# module away otherwise has no record of which bake it holds. This is the one
# tier table; every check reads this line instead of spelling a second one.
echo "$TIER $FRAME" > "$OUT/fe.tier"
echo "$TIER tier: frame $FRAME, module $(stat -c %s "$OUT/fe.wasm") bytes"
