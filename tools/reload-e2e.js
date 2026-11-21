/* Headless Chromium check for the black video fault after a rejoin.
 *
 * One guest leaves by reloading the page and joins the same sealed room again
 * while the other guest stays. The test asserts that video resumes in both
 * directions after the rejoin, because the receiver asks for a keyframe as
 * soon as its key is installed.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
const OUT = process.env.OUTDIR || 'shots';

const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, fn, arg, timeout, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < (timeout || 45000)) {
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  await page.goto(BASE + '/?sealed=1' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
  await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
  await page.fill('#name', name);
  if (room) await page.fill('#room', room);
  await page.click('#enter-btn', { timeout: 20000 });
  await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
    null, 30000, name + ' joined');
  return { page, errors };
}

// videoClock returns the playing remote video time and the decrypted frame
// count for the first remote tile.
function videoClock(page) {
  return page.evaluate(() => {
    const p = window.e2eApp.peers()[0] || {};
    const v = p.video;
    const c = window.e2eApp.counters();
    return {
      t: v ? v.currentTime : -1,
      w: v ? v.videoWidth : 0,
      decrypt: c.decryptFrames,
      encrypt: c.encryptFrames,
      workerErrors: c.workerErrors.length,
    };
  });
}

async function measure(page, label) {
  // The regression under test: a peer that stays black never starts its clock,
  // so wait for the first decoded frame before the delta measurement.
  await until(page, () => window.e2eApp.peers().some((p) => p.pc === 'connected' && p.videoW > 0 && p.videoT > 0),
    null, 45000, label + ' first picture');
  const a = await videoClock(page);
  await sleep(2500);
  const b = await videoClock(page);
  check(label + ' video advances', b.t > a.t && b.w > 0, a.t.toFixed(2) + ' -> ' + b.t.toFixed(2) + ' w=' + b.w);
  check(label + ' decrypts inbound frames', b.decrypt > a.decrypt, a.decrypt + ' -> ' + b.decrypt);
  return b;
}

(async () => {
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // The Playwright Chromium build keeps RTCRtpScriptTransform behind a flag.
      '--enable-features=RTCRtpScriptTransform',
    ],
  });
  const ctxA = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ permissions: ['camera', 'microphone'] });

  const a = await joinPage(ctxA, 'alice', null);
  const room = await a.page.evaluate(() => window.e2eApp.state.room);
  check('A made a room', /^[a-z2-7]{26}$/.test(room || ''), room);

  const b = await joinPage(ctxB, 'bob', room);
  await until(a.page, () => window.e2eApp.peers().some((p) => p.pc === 'connected'), null, 60000, 'A sees bob');
  await measure(b.page, 'before reload: B');
  await measure(a.page, 'before reload: A');

  // B reloads and joins the same sealed room again. A stays in the room and
  // must recover its incoming video without a manual gesture.
  await b.page.goto(BASE + '/?sealed=1#r=' + room, { waitUntil: 'load', timeout: 60000 });
  await until(b.page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'rejoin wasm test');
  await b.page.fill('#name', 'bob');
  await b.page.click('#enter-btn', { timeout: 20000 });
  await until(b.page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
    null, 30000, 'B rejoined');
  await until(a.page, () => window.e2eApp.peers().filter((p) => p.pc === 'connected').length === 1,
    null, 60000, 'A reconnected to the reloaded B');

  const afterB = await measure(b.page, 'after reload: B');
  const afterA = await measure(a.page, 'after reload: A');
  check('A had no worker errors after the rejoin', afterA.workerErrors === 0, afterA.workerErrors);
  check('B had no worker errors after the rejoin', afterB.workerErrors === 0, afterB.workerErrors);

  fs.mkdirSync(OUT, { recursive: true });
  for (const [page, label] of [[a.page, 'a'], [b.page, 'b']]) {
    await page.screenshot({ path: OUT + '/' + label + '.png' });
  }
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
  if (failed.length) {
    console.log('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: PASS');
})().catch((e) => {
  console.log('SUITE ERROR ' + e);
  process.exit(2);
});
