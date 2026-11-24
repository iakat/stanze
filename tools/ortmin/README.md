# A smaller ONNX Runtime Web for the incoming noise filter

The incoming stream filter uses FastEnhancer Small. The model is 856 KB, but the
stock runtime that runs it is 14.8 MB of wasm, because a stock build registers
every kernel in the library and nothing is tree shaken.

This folder holds the reproducible recipe for a build that keeps only what this
one model needs.

## What the upstream docs say

From **Build for web**, https://onnxruntime.ai/docs/build/web.html:

> ONNX Runtime WebAssembly can be built with flag `--minimal_build`. This will
> generate smaller artifacts and also have a less runtime memory usage. In order
> to use this ONNX Runtime configuration an ORT format model is required (vs.
> ONNX format).

> `--enable_wasm_simd` / `--enable_wasm_threads` — build with SIMD / multi-thread
> support. The release build uses `--config Release --skip_tests
> --disable_wasm_exception_catching --disable_rtti`.

From **Custom build**, https://onnxruntime.ai/docs/build/custom.html:

> To reduce the compiled binary size of ONNX Runtime, the operator kernels
> included in the build can be reduced to just those required by your model/s.
> Add `--include_ops_by_config <config file produced during model conversion>
> --skip_tests` to the build parameters.

> `--enable_reduced_operator_type_support` enables operator type reduction.
> Requires that type reduction was enabled during model conversion
> (`--enable_type_reduction`). ONNX format models are not guaranteed to include
> the required per-node type information, so cannot be used with this option.

The last sentence is the reason the model ships as `.ort` and not `.onnx`.

## What this model needs

`ops_of_model.py` reads the graph at the wire level, without the onnx package,
and prints the operator set:

```
Add Clip Concat Conv ConvTranspose DFT Div Gather Gemm MatMul Mul Pad Pow
ReduceL2 Reshape ScatterND SequenceAt Sigmoid Slice Softmax Split
SplitToSequence Squeeze Sub Tanh Transpose Unsqueeze
```

27 operators out of the several hundred a stock build carries. IR version 10.

## Build

```
docker run --rm -v "$PWD":/w -w /w debian:bookworm sh tools/ortmin/build.sh
```

In this namespace the same script runs as a Job, because the tree, emsdk and the
build need about 6 GB of disk and a few GB of RAM, which the app pod does not
have: see `job.json`.

Pinned: `ORT_TAG=v1.31.1`, which is the version of the runtime the client loads
today (`static/ort/ort.wasm.min.js`). Change both together or not at all.

## Result and what changes in the client

The build writes `static/ort-min/`:

- `ort-wasm-simd-threaded.wasm` — the reduced runtime
- `ort-wasm-simd-threaded.mjs` — its loader
- `fastenhancer-s.ort` — the model in ORT format

The worker then points at `ort-min/` and loads `fastenhancer-s.ort` instead of
`fastenhancer-s.onnx`. Nothing else in the client changes: the session options,
the five cache tensors and the frame size stay as they are.

The stock runtime stays in the tree until the reduced one passes the same end to
end check (`/tmp/opencode/fe_live.js` in the pod), then it is removed.
