/* Freeze frame and late joiners end to end: three sealed guests, fake camera.
 *
 * The case under test: alice freezes her camera, then carol joins the room.
 * Carol must get the still picture, not a black tile and not the live feed.
 * A canvas captureStream(0) sends nothing until it is asked, so the frame has
 * to be requested again for a sender that appears after the freeze.
 *
 * env: PW (playwright-core directory), CHROME, ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8095';
const OUT = process.env.OUTDIR || '/tmp/shots';

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
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && path !== '/favicon.ico' && path !== '/vosk/models'
      && path !== '/omni/models') {
      errors.push('http ' + r.status() + ' ' + r.url());
    }
  });
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(BASE + '/' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
    await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
    await page.fill('#name', name);
    if (room) await page.fill('#room', room);
    await page.click('#enter-btn', { timeout: 20000 });
    try {
      await until(page, () => window.e2eApp && window.e2eApp.state.self
        && !document.getElementById('stage').hidden, null, 25000, name + ' joined');
      return { page, errors, room: await page.evaluate(() => window.e2eApp.state.room) };
    } catch (err) {
      console.log('RETRY ' + name + ' attempt ' + (attempt + 1) + ': ' + err);
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join');
}

// What the tile actually shows: the drawing buffer of the remote video,
// downscaled to a small square. A live camera feed moves between two samples,
// a frozen still does not; a re-encoded still differs by a little, so compare
// the samples with a tolerance instead of for equality.
const tileSample = (page, peerName) => page.evaluate((name) => {
  const p = window.e2eApp.peers().find((q) => q.name === name);
  const v = p && p.video;
  if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  g.drawImage(v, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  const out = [];
  for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
  return out;
}, peerName);

// meanDiff is the average channel distance between two samples, 0 to 255.
function meanDiff(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return Math.round((sum / a.length) * 100) / 100;
} 
const STILL = 2; // a still that is sent again may differ by this much
const LIVE = 3.5; // a moving picture differs by at least this much

const freezeOn = (page) => page.evaluate(() => {
  const f = document.getElementById('freeze');
  if (!f) return 'no freeze control';
  f.checked = true;
  f.dispatchEvent(new Event('change'));
  return 'asked';
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/data/workspace/tools/pw/browsers/chromium-1134/chrome-linux/chrome',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=RTCRtpScriptTransform',
    ],
  });
  const opts = { viewport: { width: 1180, height: 760 }, permissions: ['camera', 'microphone'] };
  const ctxA = await browser.newContext(opts);
  const ctxB = await browser.newContext(opts);
  const ctxC = await browser.newContext(opts);
  let a = null;
  let b = null;
  let c = null;
  let failed = null;
  try {
    a = await joinPage(ctxA, 'alice', '');
    b = await joinPage(ctxB, 'bob', a.room);
    await until(a.page, () => [...window.e2eApp.peers()].some((p) => p.videoW > 0), null, 45000, 'A sees B');

    await freezeOn(a.page);
    const froze = await until(a.page, () => window.e2eApp.state.freeze === true, null, 15000, 'A freezes')
      .catch(() => 'no freeze');
    check('the freeze switch takes', froze === true, JSON.stringify(froze));

    await sleep(1500);
    const before = await tileSample(b.page, 'alice');
    await sleep(1500);
    const after = await tileSample(b.page, 'alice');
    const moved = meanDiff(before, after);
    check('the peer already in the room sees a still', moved !== null && moved <= STILL,
      JSON.stringify({ moved }));

    // The live control: bob is not frozen, so his picture must move.
    const b1 = await tileSample(a.page, 'bob');
    await sleep(1500);
    const b2 = await tileSample(a.page, 'bob');
    const live = meanDiff(b1, b2);
    check('the control tile is alive', live !== null && live >= LIVE, JSON.stringify({ live }));

    c = await joinPage(ctxC, 'carol', a.room);
    const seen = await until(c.page, () => {
      const ps = window.e2eApp.peers();
      return ps.length >= 2 && ps.every((p) => p.videoW > 0) ? ps.map((p) => p.name + ':' + p.videoW) : null;
    }, null, 45000, 'carol sees both peers').catch((err) => String(err));
    check('the late guest gets a picture from both peers', Array.isArray(seen), JSON.stringify(seen));

    const c1 = await tileSample(c.page, 'alice');
    const dark = c1 ? c1.reduce((a, b) => a + b, 0) / c1.length : 0;
    check('the late guest sees the frozen still, not black', c1 !== null && dark > 8,
      JSON.stringify({ dark }));
    await sleep(2000);
    const c2 = await tileSample(c.page, 'alice');
    const still = meanDiff(c1, c2);
    check('the still the late guest sees does not move', still !== null && still <= STILL,
      JSON.stringify({ still }));

    const live1 = await tileSample(c.page, 'bob');
    await sleep(1500);
    const live2 = await tileSample(c.page, 'bob');
    const moves = meanDiff(live1, live2);
    check('the same late guest sees bob live', moves !== null && moves >= LIVE,
      JSON.stringify({ moves }));

    await c.page.screenshot({ path: OUT + '/freeze-late-c.png' });
    await a.page.screenshot({ path: OUT + '/freeze-late-a.png' });

    check('no page errors on the freezer', a.errors.length === 0, a.errors.slice(0, 2).join(' | '));
    check('no page errors on the late guest', c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
  } catch (err) {
    failed = err;
    console.log('FATAL ' + ((err && err.stack) || err));
    for (const [n, p] of [['a', a], ['b', b], ['c', c]]) {
      if (p) await p.page.screenshot({ path: OUT + '/freeze-fail-' + n + '.png' }).catch(() => {});
    }
  } finally {
    await browser.close();
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log((bad === 0 && !failed ? 'OK ' : 'FAILED ') + (results.length - bad) + '/' + results.length);
  fs.writeFileSync(OUT + '/freeze-late-e2e.json',
    JSON.stringify({ results, failed: failed ? String(failed) : null }, null, 1));
  process.exit(bad === 0 && !failed ? 0 : 1);
})();
