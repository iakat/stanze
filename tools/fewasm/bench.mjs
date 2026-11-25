// Run one FastEnhancer wasm tier over a raw f32 mono file and time each frame.
//
//   node bench.mjs <module.wasm> <weights.q8> <in.f32> <out.f32> [frames]
//
// Prints ms per frame (median/p95) and the frame size the module reports.
import fs from 'node:fs';

const [modPath, wPath, inPath, outPath, framesArg] = process.argv.slice(2);
if (!modPath) {
  console.error('usage: node bench.mjs <module.wasm> <weights.q8> <in.f32> <out.f32> [frames]');
  process.exit(2);
}

const moduleBytes = fs.readFileSync(modPath);
const weights = fs.readFileSync(wPath);
const audio = new Float32Array(
  fs.readFileSync(inPath).buffer.slice(0),
);

const state = { ex: null };
function wasi() {
  return {
    clock_time_get(id, precision, out) {
      if (!state.ex) return 0;
      const now = Math.round(performance.now() * 1e6);
      const dv = new DataView(state.ex.memory.buffer);
      dv.setUint32(out, now >>> 0, true);
      dv.setUint32(out + 4, Math.floor(now / 4294967296) >>> 0, true);
      return 0;
    },
    fd_write(fd, iovs, len, written) {
      if (!state.ex) return 0;
      const dv = new DataView(state.ex.memory.buffer);
      let n = 0;
      for (let i = 0; i < len; i++) n += dv.getUint32(iovs + i * 8 + 4, true);
      dv.setUint32(written, n, true);
      return 0;
    },
    fd_close() { return 0; },
    fd_seek() { return 0; },
  };
}

const module = await WebAssembly.compile(moduleBytes);
const inst = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi() });
state.ex = inst.exports;
const ex = inst.exports;

const wptr = ex.malloc(weights.length);
new Uint8Array(ex.memory.buffer, wptr, weights.length).set(weights);
const rc = ex.fe_init(wptr, weights.length);
if (rc !== 0) throw new Error('fe_init returned ' + rc);

const frame = ex.fe_web_frame();
const inPtr = ex.malloc(frame * 4);
const outPtr = ex.malloc(frame * 4);

const total = Math.min(
  framesArg ? parseInt(framesArg, 10) : Infinity,
  Math.floor(audio.length / frame),
);
const out = new Float32Array(total * frame);
const times = [];
for (let t = 0; t < total; t++) {
  new Float32Array(ex.memory.buffer, inPtr, frame).set(
    audio.subarray(t * frame, t * frame + frame));
  const t0 = performance.now();
  ex.fe_run(inPtr, outPtr);
  times.push(performance.now() - t0);
  out.set(new Float32Array(ex.memory.buffer, outPtr, frame), t * frame);
}

const sorted = times.slice().sort((a, b) => a - b);
const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
console.log(JSON.stringify({
  frame,
  frames: total,
  moduleBytes: moduleBytes.length,
  weightsBytes: weights.length,
  msMedian: +pick(0.5).toFixed(3),
  msP95: +pick(0.95).toFixed(3),
  msMean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3),
}));
fs.writeFileSync(outPath, Buffer.from(out.buffer));
