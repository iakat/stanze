/* Deafen end-to-end test: two sealed guests, fake camera and microphone.
 *
 * It asserts that deafen closes the microphone, the outgoing camera and every
 * incoming picture at once, that the other guest is told the camera is off,
 * that the stored camera choice survives, and that undeafen brings both the
 * own camera and the incoming picture back.
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
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
}

// tiles reads the picture state of every tile from the page.
function tiles(page) {
  return page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => {
    const v = t.querySelector('video');
    return {
      local: t.dataset.local === 'yes',
      name: (t.querySelector('.name') || {}).textContent.trim(),
      playing: t.classList.contains('playing'),
      camoff: t.classList.contains('camoff'),
      src: !!v.srcObject,
      w: v.videoWidth,
      flags: [...t.querySelectorAll('.flags span')].map((s) => s.textContent),
    };
  }));
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

const state = (page) => page.evaluate(() => {
  const s = window.e2eApp.state;
  return { deaf: s.deaf, mic: s.mic, cam: s.cam, screen: !!s.screen, peers: s.peers.size, storedCam: localStorage.getItem('rooms.cam') };
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
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
  try {
    a = await joinPage(ctxA, 'alice', '');
    b = await joinPage(ctxB, 'bob', a.room);

    // Both pictures must flow before deafen means anything.
    await until(a.page, () => {
      const v = [...document.querySelectorAll('.tile')].filter((t) => t.dataset.local !== 'yes').map((t) => t.querySelector('video'));
      return v.length && v.every((x) => x.videoWidth > 0);
    }, null, 45000, 'A sees B');
    await until(b.page, () => {
      const v = [...document.querySelectorAll('.tile')].filter((t) => t.dataset.local !== 'yes').map((t) => t.querySelector('video'));
      return v.length && v.every((x) => x.videoWidth > 0);
    }, null, 45000, 'B sees A');
    check('both guests see each other before deafen', true);

    const before = await state(a.page);
    check('A joined with camera and microphone on', before.cam === true && before.mic === true, JSON.stringify(before));
    // A stored camera choice stands in for the next visit: deafen must not
    // overwrite it, or the guest would come back with the camera off.
    await a.page.evaluate(() => localStorage.setItem('rooms.cam', '1'));

    await a.page.click('#deaf-btn');
    await until(a.page, () => window.e2eApp.state.deaf === true, null, 10000, 'A deafened');
    // enableMic/disableCam and the peer flags settle in the same turn; wait for
    // the local camera flag to fall before reading the tiles.
    await until(a.page, () => window.e2eApp.state.cam === false, null, 10000, 'A camera off');

    const deaf = await state(a.page);
    check('deafen turns the microphone off', deaf.mic === false, deaf.mic);
    check('deafen turns the outgoing camera off', deaf.cam === false, deaf.cam);
    check('deafen keeps the stored camera choice', deaf.storedCam === '1', deaf.storedCam);

    const aTiles = await tiles(a.page);
    const aSelf = aTiles.find((t) => t.local) || {};
    const aRemote = aTiles.find((t) => !t.local) || {};
    check('A shows its own tile without a picture', aSelf.src === false && aSelf.playing === false, JSON.stringify(aSelf));
    check('A draws no incoming picture while deafened', aRemote.src === false && aRemote.playing === false, JSON.stringify(aRemote));
    check('A keeps the guest row without a picture', aTiles.length === 2, aTiles.length);

    const bTiles = await tiles(b.page);
    const bSeesA = bTiles.find((t) => !t.local) || {};
    check('B is told that A has no camera', bSeesA.flags.includes('no cam') && bSeesA.camoff === true, JSON.stringify(bSeesA));
    check('B still runs its own camera', (await state(b.page)).cam === true);

    await a.page.screenshot({ path: OUT + '/deaf-a.png' });
    await b.page.screenshot({ path: OUT + '/deaf-b.png' });

    await a.page.click('#deaf-btn');
    await until(a.page, () => window.e2eApp.state.deaf === false && window.e2eApp.state.cam === true, null, 25000, 'A undeafened');
    await until(a.page, () => {
      const v = [...document.querySelectorAll('.tile')].filter((t) => t.dataset.local !== 'yes').map((t) => t.querySelector('video'));
      return v.length && v.every((x) => x.videoWidth > 0);
    }, null, 45000, 'A sees B again');
    const back = await state(a.page);
    check('undeafen gives the camera back', back.cam === true, back.cam);
    check('undeafen gives the microphone back', back.mic === true, back.mic);
    const backTiles = await tiles(a.page);
    const backRemote = backTiles.find((t) => !t.local) || {};
    check('undeafen draws the incoming picture again', backRemote.src === true && backRemote.w > 0, JSON.stringify(backRemote));

    await until(b.page, () => {
      const t = [...document.querySelectorAll('.tile')].find((x) => x.dataset.local !== 'yes');
      return t && !t.classList.contains('camoff');
    }, null, 20000, 'B sees A camera back');
    check('B sees the camera of A come back', true);

    check('A logged no page errors', a.errors.length === 0, a.errors.join(' | '));
    check('B logged no page errors', b.errors.length === 0, b.errors.join(' | '));
  } catch (err) {
    check('test ran to the end', false, String(err && err.stack || err));
    if (a) await a.page.screenshot({ path: OUT + '/deaf-fail-a.png' }).catch(() => {});
    if (b) await b.page.screenshot({ path: OUT + '/deaf-fail-b.png' }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + (results.length - failed.length) + '/' + results.length + ' pass');
  fs.writeFileSync(OUT + '/deaf-e2e.json', JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
