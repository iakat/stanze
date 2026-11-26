/* Filter self test: the page's own loader, a real module and its weights.
 *
 * The browser error this guards against is one line long ("fe: fe_init
 * failed") and tells nobody why: a module built for a different tier, a
 * weights blob from another build, a frame size the worklet does not cut. All
 * three surface here, with the loader taken verbatim out of
 * static/fastenhancer-worker.js, so the test fails on exactly the code the page
 * runs and not on a copy that agreed with an older module.
 *
 * node tools/fewasm/selftest.mjs [module] [weights]
 * Defaults are static/fe.wasm and static/fe.q8, which is what ships. Exits non
 * zero on the first fault, so CI can gate a release on it.
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(here, '../..');
const modulePath = process.argv[2] || path.join(tree, 'static/fe.wasm');
const weightsPath = process.argv[3] || path.join(tree, 'static/fe.q8');
const workerPath = path.join(tree, 'static/fastenhancer-worker.js');

// The worklet cuts frames of this many samples at 48 kHz; every tier in the
// engine is one compile-time frame size, so a mismatch is a silent fault
// downstream of init and a hard one during the first copy either way.
const EXPECT_FRAME = 512;
const EXPECT_RATE = 48000;

function loadWorkerLoader() {
  const src = fs.readFileSync(workerPath, 'utf8');
  const start = src.indexOf('const FeWasm');
  const end = src.indexOf('let library = null;');
  if (start < 0 || end < 0) throw new Error('worker: FeWasm block not found');
  // The block is plain ES5 with no DOM: evaluate it and hand the IIFE back.
  const body = src.slice(start, end).replace('const FeWasm', 'globalThis.FeWasm');
  new Function(body)();
  if (!globalThis.FeWasm || typeof globalThis.FeWasm.load !== 'function') {
    throw new Error('worker: FeWasm.load is missing');
  }
  return globalThis.FeWasm;
}

function serve(moduleBytes, weightBytes) {
  globalThis.fetch = async (url) => {
    const buf = Buffer.from(String(url).endsWith('.q8') ? weightBytes : moduleBytes);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
}

let failed = 0;
function pass(name, detail) {
  console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : ''));
}
function fail(name, why) {
  failed++;
  console.log('FAIL  ' + name + '  ' + why);
}
function check(name, fn) {
  try {
    const detail = fn();
    pass(name, detail);
  } catch (err) {
    fail(name, String((err && err.message) || err));
  }
}

if (!fs.existsSync(modulePath)) throw new Error('no module: ' + modulePath);
if (!fs.existsSync(weightsPath)) throw new Error('no weights: ' + weightsPath);

const wasm = fs.readFileSync(modulePath);
const weights = fs.readFileSync(weightsPath);
const FeWasm = loadWorkerLoader();

// The loader fetches by URL; the bytes come from disk so the test reads the
// artifacts that are about to ship and not whatever a server happens to hold.
serve(wasm, weights);
let library = null;
try {
  library = await FeWasm.load('/fe.wasm', '/fe.q8');
} catch (err) {
  fail('the loader accepts the module and weights', String((err && err.message) || err));
}

if (library) {
  let engine = null;
  check('fe_init succeeds on one instance', () => {
    engine = library.create();
    if (!engine) throw new Error('create returned nothing');
    return 'module ' + wasm.length + ' bytes, weights ' + weights.length + ' bytes';
  });

  if (engine) {
    check('the frame size matches the worklet', () => {
      if (engine.frame !== EXPECT_FRAME) {
        throw new Error('engine frame ' + engine.frame + ', worklet cuts ' + EXPECT_FRAME);
      }
      return EXPECT_FRAME + ' samples';
    });

    check('a noise frame runs and comes back finite', () => {
      // Deterministic pseudo noise: a seed here, so a failure is repeatable.
      const pcm = new Float32Array(engine.frame);
      let seed = 0x2545f491;
      for (let i = 0; i < pcm.length; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        pcm[i] = (seed / 4294967296 - 0.5) * 0.2;
      }
      const out = engine.run(pcm);
      if (!out || out.length !== engine.frame) throw new Error('short frame out');
      for (let i = 0; i < out.length; i++) {
        if (!Number.isFinite(out[i])) throw new Error('non finite output at ' + i);
      }
      return 'finite';
    });

    check('a second instance initialises beside the first', () => {
      // One instance is one stream, so a room opens several: a module that
      // only survives one init would fail here and not in the loader test.
      const second = library.create();
      if (!second || second.frame !== EXPECT_FRAME) throw new Error('second instance bad');
      return 'ok';
    });

    check('reset keeps the frame stream running', () => {
      const pcm = new Float32Array(engine.frame).fill(0.01);
      engine.reset();
      const out = engine.run(pcm);
      if (!out || out.length !== engine.frame) throw new Error('short frame after reset');
      return 'ok';
    });
  }
}

if (failed) {
  console.log('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nRESULT: PASS');
