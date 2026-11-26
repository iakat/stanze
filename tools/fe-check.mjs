/* Filter check: the packing filter initialises and runs, before any browser
 * sees it.
 *
 * The point is the fault an image build cannot see: the module and the weights
 * are two files that must come from one bake, and a page whose fe.wasm does not
 * match its fe.q8 stops the incoming filter at fe_init with a one-line error in
 * a corner. This runs the worklet's own loader (static/fastenhancer-worker.js)
 * over the same two files the server will serve, so a mismatch fails the build.
 *
 * It asserts the module's frame size, that fe_init returns 0, that a frame of
 * noise comes back as a frame of floats, and that the loader's engine is the
 * one the worklet cuts (512 samples for the small and base tiers).
 *
 * env: FE_MODULE (default static/fe.wasm), FE_WEIGHTS (default static/fe.q8),
 *      FE_FRAME (default 512)
 */
'use strict';

import fs from 'node:fs';

const MODULE = process.env.FE_MODULE || 'static/fe.wasm';
const WEIGHTS = process.env.FE_WEIGHTS || 'static/fe.q8';
const FRAME = Number(process.env.FE_FRAME || 512);

const fails = [];
const pass = (name, detail) => console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : ''));
const fail = (name, detail) => {
  fails.push(name);
  console.log('FAIL  ' + name + (detail ? '  ' + detail : ''));
};

// The loader lives in the worker and has no DOM in it, so the file is loaded
// and the FeWasm block evaluated as is: testing a copy would test the copy.
const worker = fs.readFileSync('static/fastenhancer-worker.js', 'utf8');
const start = worker.indexOf('const FeWasm');
const end = worker.indexOf('let library = null;');
if (start < 0 || end < 0) {
  console.log('FAIL  the worker no longer carries a FeWasm block');
  process.exit(1);
}
const FeWasm = new Function(
  'performance',
  worker.slice(start, end).replace('const FeWasm', 'return FeWasm') + ';',
)(globalThis.performance);

if (!fs.existsSync(MODULE)) fail('module exists', MODULE + ' is missing');
if (!fs.existsSync(WEIGHTS)) fail('weights exist', WEIGHTS + ' is missing');
if (fails.length) process.exit(1);

const module = fs.readFileSync(MODULE);
const weights = fs.readFileSync(WEIGHTS);
pass('module present', MODULE + ' ' + module.length + ' bytes');
pass('weights present', WEIGHTS + ' ' + weights.length + ' bytes');

// The loader fetches, so the two files are served from memory under the names
// the worker asks for, byte for byte as the server would send them.
globalThis.fetch = async (url) => {
  const body = String(url).endsWith('.q8') ? weights : module;
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
};

let engine;
try {
  const library = await FeWasm.load('/fe.wasm', '/fe.q8');
  engine = library.create();
  pass('fe_init', 'module and weights accepted');
} catch (err) {
  fail('fe_init', String((err && err.message) || err));
  console.log('\nRESULT: FAIL');
  process.exit(1);
}

const frame = engine.frame;
if (frame === FRAME) pass('frame size', String(frame) + ' samples');
else fail('frame size', 'module cuts ' + frame + ', the worklet cuts ' + FRAME);

// Noise, not silence: silence can pass through a broken engine that returns
// zeros. The output must be finite and the same length as the input.
const input = new Float32Array(frame);
for (let i = 0; i < frame; i++) input[i] = Math.random() * 2 - 1;
const out = engine.run(input);
if (out.length === frame) pass('run returns one frame', String(out.length) + ' samples');
else fail('run returns one frame', 'got ' + out.length);
const clean = out.every((v) => Number.isFinite(v));
if (clean) pass('run output is finite');
else fail('run output is finite', 'NaN or Infinity in the frame');

// A second frame exercises the streaming state (STFT overlap, GRU hidden) that
// the first frame leaves behind, which is where a half-initialised engine dies.
try {
  engine.run(input);
  pass('second frame runs', 'streaming state survives');
} catch (err) {
  fail('second frame runs', String((err && err.message) || err));
}

console.log(fails.length ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(fails.length ? 1 : 0);
