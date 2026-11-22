/* Screen share end-to-end test: two sealed guests, fake camera and microphone,
 * and one synthetic display capture.
 *
 * It asserts that the sharer sees the own screen tile in the stage, that the
 * tile survives the arrival of the first frame, and that the other guest gets
 * the same picture. A real display picker is not scriptable in a headless
 * run, so getDisplayMedia returns a canvas capture: the layout path under
 * test is the same one a picked window takes.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
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
    // The browser asks for /favicon.ico beside the svg the page names; the
    // server answers 404 by design, and that is not a page error.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    // /vosk/models answers 404 when no model directory is configured, and the
    // page asks for it on every join to decide whether to offer the feature.
    if (r.status() >= 400 && path !== '/favicon.ico' && path !== '/vosk/models') {
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
      await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
        null, 25000, name + ' joined');
      return { page, errors, room: await page.evaluate(() => window.e2eApp.state.room) };
    } catch (err) {
      console.log('RETRY ' + name + ' attempt ' + (attempt + 1) + ': ' + err);
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join');
}

// The own screen tile: it is the tile the sharer needs to see.
const ownScreen = (page) => page.evaluate(() => {
  const t = document.querySelector('.tile[data-local="screen"]');
  if (!t) return null;
  const v = t.querySelector('video');
  return { hidden: t.hidden, w: v.videoWidth, h: v.videoHeight, state: (t.querySelector('.state') || {}).textContent };
});

const peerScreens = (page) => page.evaluate(() => [...document.querySelectorAll('.tile[data-screen="yes"]')]
  .filter((t) => t.dataset.local !== 'screen')
  .map((t) => ({ hidden: t.hidden, w: t.querySelector('video').videoWidth })));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=RTCRtpScriptTransform',
    ],
  });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'] });
  let a = null;
  let b = null;
  let failed = null;
  try {
    a = await joinPage(ctxA, 'alice', '');
    b = await joinPage(ctxB, 'bob', a.room);
    await until(a.page, () => {
      const s = window.e2eApp.state;
      if (s.peers.size < 1) return false;
      return [...document.querySelectorAll('.tile')]
        .filter((t) => t.dataset.local !== 'yes' && t.dataset.state === 'connected')
        .some((t) => t.querySelector('video').videoWidth > 0);
    }, null, 45000, 'A sees B');
    await sleep(1000);

    // A canvas that always has a fresh frame, so the capture never idles.
    await a.page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const g = c.getContext('2d');
      let n = 0;
      setInterval(() => {
        g.fillStyle = n % 2 ? '#224466' : '#88cc44';
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = '#fff';
        g.fillRect((n * 7) % 600, 40, 40, 280);
        n += 1;
      }, 40);
      navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(20);
    });

    await a.page.click('#share-btn');
    await until(a.page, () => !!window.e2eApp.state.screen, null, 15000, 'A shares');
    check('the share starts', true);

    // The broken case: the tile was laid out before the first frame and no
    // later event brought it back, so the sharer never saw it.
    const seen = await until(a.page, () => {
      const t = document.querySelector('.tile[data-local="screen"]');
      if (!t) return null;
      const v = t.querySelector('video');
      return !t.hidden && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null;
    }, null, 20000, 'own screen tile in the stage').catch((err) => String(err));
    check('the sharer sees the own screen tile', !!(seen && seen.w), JSON.stringify(seen));

    await sleep(2000);
    const later = await ownScreen(a.page);
    check('the own screen tile stays in the stage', !!(later && !later.hidden && later.w > 0), JSON.stringify(later));
    check('the own screen tile says whose screen it is', !!(later && /your screen/.test(String(later.state))), later && later.state);

    const peer = await until(b.page, () => {
      const s = [...document.querySelectorAll('.tile[data-screen="yes"]')]
        .filter((t) => t.dataset.local !== 'screen')
        .filter((t) => !t.hidden && t.querySelector('video').videoWidth > 0);
      return s.length ? { n: s.length, w: s[0].querySelector('video').videoWidth } : null;
    }, null, 20000, 'the guest sees the screen').catch((err) => String(err));
    check('the other guest sees the screen', !!(peer && peer.n), JSON.stringify(peer));

    await a.page.screenshot({ path: OUT + '/screen-a.png' });
    await b.page.screenshot({ path: OUT + '/screen-b.png' });

    await a.page.click('#share-btn');
    await until(a.page, () => !window.e2eApp.state.screen, null, 15000, 'A stops the share');
    const gone = await until(a.page, () => !document.querySelector('.tile[data-local="screen"]'),
      null, 10000, 'the own screen tile leaves').catch(() => 'still there');
    check('the own screen tile leaves when the share stops', gone === true, JSON.stringify(gone));

    // The receiver track of a stopped share stays live, so the tile used to
    // stand there frozen on its last frame. It must leave for the guest too.
    const peerGone = await until(b.page, () => ![...document.querySelectorAll('.tile[data-screen="yes"]')]
      .some((t) => t.dataset.local !== 'screen'), null, 15000, 'the guest loses the screen tile')
      .catch(() => 'still there');
    check('the guest loses the screen tile when the share stops', peerGone === true, JSON.stringify(peerGone));

    check('no page errors on the sharer', a.errors.length === 0, a.errors.slice(0, 2).join(' | '));
    check('no page errors on the guest', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
  } catch (err) {
    failed = err;
    console.log('FATAL ' + (err && err.stack || err));
    if (a) await a.page.screenshot({ path: OUT + '/screen-fail-a.png' }).catch(() => {});
    if (b) await b.page.screenshot({ path: OUT + '/screen-fail-b.png' }).catch(() => {});
  } finally {
    await browser.close();
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log((bad === 0 && !failed ? 'OK ' : 'FAILED ') + (results.length - bad) + '/' + results.length);
  fs.writeFileSync(OUT + '/screen-e2e.json', JSON.stringify({ results, failed: failed ? String(failed) : null }, null, 1));
  process.exit(bad === 0 && !failed ? 0 : 1);
})();
