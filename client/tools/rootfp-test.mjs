/* The root fingerprint of a room, checked without a browser.
 *
 * gate.ts imports the whole client (DOM, storage, the wasm bridge), so the
 * functions are taken from a bundle of that one module with the few globals a
 * module-level read touches stubbed out. What is under test is pure string work:
 * which characters of a room id are the fingerprint, and whether the answer is
 * the one the identity compares against.
 *
 * The bug this pins: rootFingerprint used to slice the id at 23 characters,
 * while the fingerprint pq.Fingerprint mints is 24 (five groups of four base32
 * letters joined by dashes). The truncated value equalled nothing, so a room
 * opened from the lobby seeded no step 0 and had no admin.
 */
'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '..');
const entry = path.join(clientDir, 'src/gate.ts');
const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rootfp-')), 'gate.mjs');

let fails = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('PASS ' + name);
  } else {
    fails++;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' [' + JSON.stringify(detail) + ']'));
  }
}

// esbuild comes from the client's own devDependencies: the same bundler the page
// is built with, so the code under test is the code that ships.
execFileSync(
  path.join(clientDir, 'node_modules/.bin/esbuild'),
  [entry, '--bundle', '--format=esm', '--log-level=error', '--outfile=' + bundle],
  { stdio: 'inherit' },
);

// The stubs only have to survive module-level reads. Nothing here is called.
globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => null,
  addEventListener() {},
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    appendChild() {},
    querySelector: () => null,
  }),
  querySelector: () => null,
  documentElement: { style: { setProperty() {} } },
  body: {},
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { href: 'http://x/', origin: 'http://x', search: '' };

const { ROOTED, rootFingerprint } = await import(bundle);

// A fingerprint of the shape pq.Fingerprint mints: five groups of four, 24
// characters with the dashes.
const FP = 'abcd-efgh-ijkl-mnop-qrst';

check('a rooted id is recognised', ROOTED.test(FP + '-myname'));
check('the fingerprint is 24 characters', FP.length === 24, FP.length);

const got = rootFingerprint(FP + '-myname');
check('the answer is the whole fingerprint', got === FP, got);
check('the answer is 24 characters, not 23', got.length === 24, got.length);
check(
  'the answer has the five groups of four shape the module produces',
  got.split('-').length === 5 && got.split('-').every((p) => p.length === 4 && /^[a-z2-7]+$/.test(p)),
  got,
);
// The old behaviour, kept as the thing that must stay fixed.
check('the answer is not the old truncated slice', got !== (FP + '-myname').slice(0, 23), got);

// A guest is not the root of a room it only joined, and a room named by hand has
// no fingerprint in its id at all.
check('a plain room name answers no fingerprint', rootFingerprint('myname') === '', rootFingerprint('myname'));
check('an empty room answers no fingerprint', rootFingerprint('') === '', rootFingerprint(''));
// 0 and 1 are not in the base32 alphabet the module writes, so a group holding
// one is not a fingerprint and the room is not rooted.
check(
  'a name that only looks rooted is not',
  rootFingerprint('abcd-efgh-ijkl-mnop-0123-myname') === '',
  rootFingerprint('abcd-efgh-ijkl-mnop-0123-myname'),
);

// A room whose name itself carries dashes and digits still answers the groups
// and not the name.
check(
  'the name after the fingerprint is not part of it',
  rootFingerprint(FP + '-room-2.0_test') === FP,
  rootFingerprint(FP + '-room-2.0_test'),
);

try {
  fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
} catch {
  // A temp dir that will not go is the operating system's problem, not a test
  // failure: the checks above already ran.
}

if (fails) {
  console.log(fails + ' check(s) failed');
  process.exit(1);
}
console.log('all checks passed');
