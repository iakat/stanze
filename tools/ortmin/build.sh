#!/bin/sh
# Reproducible build of a reduced ONNX Runtime Web wasm for one model.
#
# The stock runtime is 14.8 MB because it carries every kernel. This build
# keeps only the operators of fastenhancer-s and only the types it uses, and it
# drops the ONNX reader, so the model ships in ORT format.
#
# Run it in a container, never in the app pod: source, emsdk and the build tree
# need about 6 GB and a few GB of RAM.
#
#   docker run --rm -v "$PWD":/w -w /w debian:bookworm sh tools/ortmin/build.sh
#
# The upstream steps are the ones in the ONNX Runtime docs:
#   https://onnxruntime.ai/docs/build/web.html          (wasm flags)
#   https://onnxruntime.ai/docs/build/custom.html       (reduced kernels and types)
set -eu

ORT_TAG="${ORT_TAG:-v1.31.1}"   # must match the runtime the client ships
MODEL="${MODEL:-static/fastenhancer-s.onnx}"
OUT="${OUT:-static/ort-min}"
WORK="${WORK:-/tmp/ortmin}"

echo "onnxruntime  $ORT_TAG"
echo "model        $MODEL"
echo "out          $OUT"

# Toolchain: cmake >= 3.26, ninja, python 3.9+, node 18+, and a C++ compiler.
if ! command -v cmake >/dev/null 2>&1; then
	apt-get update
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		git curl ca-certificates build-essential cmake ninja-build python3 python3-pip python3-venv nodejs npm
fi

python3 -m venv "$WORK/venv"
. "$WORK/venv/bin/activate"
pip install --quiet --upgrade pip
# Both are needed: onnxruntime for the ORT format converter, onnx for the model.
pip install --quiet "onnxruntime==${ORT_TAG#v}" onnx

# Step 1. Convert the model and collect the operators and the types it needs.
# --enable_type_reduction records the input and output types of every node,
# which the build then keeps instead of every type of every kernel.
mkdir -p "$WORK/conv"
python3 -m onnxruntime.tools.convert_onnx_models_to_ort "$MODEL" \
	--enable_type_reduction --output_dir "$WORK/conv"
CONFIG=$(ls "$WORK"/conv/*and_types*.config 2>/dev/null | head -1)
if [ -z "$CONFIG" ]; then
	CONFIG=$(ls "$WORK"/conv/*.config | head -1)
fi
echo "ops config   $CONFIG"
wc -l "$CONFIG"

# Step 2. Build the wasm runtime against that config.
git clone --depth 1 --branch "$ORT_TAG" --recursive https://github.com/microsoft/onnxruntime "$WORK/src"
cd "$WORK/src"
( cd cmake/external/emsdk && ./emsdk install latest && ./emsdk activate latest )
. cmake/external/emsdk/emsdk_env.sh

# The flags below are the documented ones for a release wasm build, plus the
# two that cut the kernel set: --include_ops_by_config and the type reduction.
# --minimal_build removes the ONNX reader and the runtime graph optimizer, so
# the model must be in ORT format.
./build.sh \
	--config Release \
	--build_wasm \
	--enable_wasm_simd \
	--enable_wasm_threads \
	--skip_tests \
	--disable_wasm_exception_catching \
	--disable_rtti \
	--minimal_build \
	--include_ops_by_config "$CONFIG" \
	--enable_reduced_operator_type_support \
	--parallel "${JOBS:-4}"

# Step 3. Publish the artifacts next to the model.
cd - >/dev/null
mkdir -p "$OUT"
cp "$WORK"/src/build/Linux/Release/ort-wasm-simd-threaded.wasm "$OUT"/
cp "$WORK"/src/build/Linux/Release/ort-wasm-simd-threaded.mjs "$OUT"/
cp "$WORK"/src/build/Linux/Release/ort-wasm-simd-threaded.js "$OUT"/ 2>/dev/null || true
cp "$WORK"/conv/*.ort "$OUT"/fastenhancer-s.ort

ls -l "$OUT"
echo "wasm before 14848852 bytes"
