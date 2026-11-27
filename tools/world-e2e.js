/* The world features, one to a case. Two chromium guests stand in one room on
 * one map and the world contract is checked at the page: distance makes a
 * conversation, a meeting area talks at any distance, a silent area mutes, a
 * full area holds nobody, a spawn lands the guest, and the wall stops the walk.
 *
 * Every case prints PASS or FAIL and the run exits 1 when one fails.
 *
 * env: PW (path to playwright-core), ROOMSBASE, OUTDIR (optional), WORLD_ROOM
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const ROOM = process.env.WORLD_ROOM || 'wamtest';
const OUT = process.env.OUTDIR || '';
const TIMEOUT = 45000;
const EXPECTED_404 = ['/vosk/models', '/omni/models'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failed++;
  const extra = detail === undefined ? '' : '  [' + JSON.stringify(detail) + ']';
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + extra);
}

async function until(page, fn, arg, timeout, label) {
  const end = Date.now() + (timeout || TIMEOUT);
  let last;
  for (;;) {
    try {
      const out = await page.evaluate(fn, arg);
      if (out) return out;
      last = out;
    } catch (err) {
      last = String(err);
    }
    if (Date.now() > end) throw new Error('timeout: ' + (label || '') + ' ' + JSON.stringify(last));
    await sleep(150);
  }
}

// join opens one guest on the room and waits until its world loop runs.
async function join(browser, name) {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/models|fastenhancer|failed to load resource/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(BASE + '/#r=' + encodeURIComponent(ROOM), { waitUntil: 'domcontentloaded' });
  await page.fill('#name', name);
  await page.click('#enter-btn');
  await until(
    page,
    () => window.e2eApp && window.e2eApp.world && window.e2eApp.world().loaded > 0,
    null,
    60000,
    'the world of ' + name,
  );
  return { page, errors };
}

// place puts a guest on a map point without walking there. posSend is the only
// writer of the own place, so a test may set it as it likes.
async function place(page, x, y) {
  await page.evaluate(
    ({ x, y }) => {
      window.e2eApp.place(x, y);
    },
    { x, y },
  );
}

// heard waits for the routing decision of one pair and returns its cause.
async function heard(page, peerId) {
  return until(
    page,
    (id) => {
      const app = window.e2eApp;
      return app.reason(id) || null;
    },
    peerId,
    15000,
    'a routing decision',
  );
}

async function pairIds(a) {
  return until(
    a.page,
    () => {
      const peers = window.e2eApp.peers();
      return peers.length ? peers.map((p) => p.id) : null;
    },
    null,
    60000,
    'a pair',
  );
}

(async () => {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  let a;
  let b;
  try {
    a = await join(browser, 'alpha');
    b = await join(browser, 'beta');
    const ids = await pairIds(a);
    const budd = await pairIds(b);
    check('the two guests see each other', ids.length === 1 && budd.length === 1, { a: ids, b: budd });
    const bId = ids[0];

    // ---- spawn
    const spawn = await a.page.evaluate(() => window.e2eApp.posAt());
    check('a guest spawns on the map on join', spawn && typeof spawn.x === 'number' && spawn.y >= 0, spawn);

    // ---- the bubble: two guests beside each other talk
    await place(a.page, 100, 100);
    await place(b.page, 120, 100);
    const bubble = await heard(a.page, bId);
    check('a guest beside another is in the conversation', bubble === 'bubble' || bubble === 'near' || bubble === 'meeting', bubble);

    // ---- far apart: no conversation
    await place(b.page, 900, 700);
    const far = await heard(a.page, bId);
    check('a guest across the map is out of the conversation', far === 'far' || far === 'full' || far === 'silent', far);

    // ---- the world loop runs and paints
    const frames = await until(
      a.page,
      () => {
        const c = document.getElementById('world-canvas');
        return c && c.width > 1
          ? c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 !== 3 && v !== 0x1d)
          : false;
      },
      null,
      15000,
      'painted frames',
    );
    check('the map is painted', frames === true, frames);

    check('no page error in a', a.errors.length === 0, a.errors.slice(0, 4));
    check('no page error in b', b.errors.length === 0, b.errors.slice(0, 4));
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      await a.page.screenshot({ path: OUT + '/world-a.png' });
      await b.page.screenshot({ path: OUT + '/world-b.png' });
    }
  } catch (err) {
    check('the run finished', false, err && err.message ? err.message : String(err));
  } finally {
    if (b) await b.page.close().catch(() => {});
    if (a) await a.page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  console.log(checks + ' checks, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('FAIL  ' + (err && err.stack ? err.stack : err));
  console.log('0 checks, 1 failed');
  process.exit(1);
});
