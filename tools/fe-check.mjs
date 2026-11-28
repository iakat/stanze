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
 * one the worklet cuts: the frame is read from static/fastenhancer-worklet.js,
 * so no second copy of the tier table exists to drift from the first.
 *
 * FE_TIER is the tier the build meant to make. Given it, the check also
 * requires the bake's own record (fe.tier, written by tools/fewasm/build.sh
 * next to the module) to name that tier: a build argument that never reached
 * the compiler is then a failed check, not a medium module shipped beside the
 * small weights.
 *
 * env: FE_MODULE (default static/fe.wasm), FE_WEIGHTS (default static/fe.q8),
 *      FE_WORKLET (default static/fastenhancer-worklet.js),
 *      FE_FRAME (default: the frame the worklet cuts),
 *      FE_TIER, FE_TIER_FILE (default <module dir>/fe.tier)
 */
'use strict';

import fs from 'node:fs';

const MODULE = process.env.FE_MODULE || 'static/fe.wasm';
const WEIGHTS = process.env.FE_WEIGHTS || 'static/fe.q8';
const WORKLET = process.env.FE_WORKLET || 'static/fastenhancer-worklet.js';
// Set-but-empty is the interesting case (an ARG out of scope), so the tier is
// tested for presence, never for truthiness.
const TIER = process.env.FE_TIER;
const TIER_FILE = process.env.FE_TIER_FILE || MODULE.replace(/[^/]*$/, '') + 'fe.tier';

// The page cuts one frame size and the module exports one; a build that gets
// them apart is silent until a browser runs it. The worklet is the source.
function workletFrame() {
  const src = fs.readFileSync(WORKLET, 'utf8');
  const m = src.match(/const\s+FRAME\s*=\s*(\d+)/);
  if (!m) {
    console.log('FAIL  the worklet no longer declares FRAME');
    process.exit(1);
  }
  return Number(m[1]);
}

const FRAME = Number(process.env.FE_FRAME || workletFrame());

const fails = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = dir + '/' + e.name;
    return e.isDirectory() ? walk(p) : [p];
  });
}
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

// The tier the build asked for and the tier the bake recorded, when both are
// known: this is the fault a pairing test alone cannot see. A module and a
// weights blob of the same tier initialise, but a build argument that never
// reached the compiler produces a module from another tier and the wrong frame
// for the page, and only a browser would ever notice.
if (TIER !== undefined) {
  if (TIER === '') {
    fail('tier is set', 'FE_TIER is empty: the build argument is not in scope in the stage that compiles the module');
  } else if (!fs.existsSync(TIER_FILE)) {
    fail('bake records its tier', TIER_FILE + ' is missing: was the module built by tools/fewasm/build.sh?');
  } else {
    const [bakedTier, bakedFrame] = fs.readFileSync(TIER_FILE, 'utf8').trim().split(/\s+/);
    if (bakedTier === TIER) pass('tier matches the build', bakedTier);
    else fail('tier matches the build', 'asked for ' + TIER + ', the bake is ' + bakedTier);
    if (Number(bakedFrame) === FRAME) pass('tier frame is the worklet frame', bakedFrame);
    else fail('tier frame is the worklet frame', 'the bake is ' + bakedFrame + ', the worklet cuts ' + FRAME);
  }
}

const module = fs.readFileSync(MODULE);
const weights = fs.readFileSync(WEIGHTS);
pass('module present', MODULE + ' ' + module.length + ' bytes');
pass('weights present', WEIGHTS + ' ' + weights.length + ' bytes');

// The module is a build artifact that only a rebuild refreshes, so a stale one
// is the fault this file has to catch: the engine source and the tier decide
// the bytes, and a module older than either is from another bake.
const inputs = ['tools/fewasm/engine', 'tools/fewasm/build.sh']
  .flatMap((p) => (fs.statSync(p).isDirectory() ? walk(p) : [p]))
  .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
  .sort((a, b) => b.t - a.t);
const moduleAge = fs.statSync(MODULE).mtimeMs;
const newer = inputs.find((i) => i.t > moduleAge + 1000);
if (newer && !process.env.FE_ALLOW_STALE) {
  fail('module is newer than its inputs', newer.p + ' is newer than ' + MODULE + '; rebuild with FE_REBUILD=1');
  console.log('\nRESULT: FAIL');
  process.exit(1);
}
if (newer) console.log('WARN  ' + newer.p + ' is newer than ' + MODULE + ' (FE_ALLOW_STALE)');
pass('module is newer than its inputs', inputs.length + ' files');

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
