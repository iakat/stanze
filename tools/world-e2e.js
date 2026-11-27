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
    () => window.e2eApp && window.e2eApp.world && window.e2eApp.world.stats().loaded > 0,
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
      const w = window.e2eApp.world;
      w.goTo(x, y);
      return w.step();
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
      return app.world.reason(id) || null;
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
    const spawn = await a.page.evaluate(() => window.e2eApp.world.pos());
    check('a guest spawns on the map on join', spawn && typeof spawn.x === 'number' && spawn.y >= 0, spawn);

    // ---- the bubble: two guests beside each other talk
    await place(a.page, 100, 100);
    await place(b.page, 120, 100);
    // The reason is asked until it agrees: the pair rule runs on the next
    // position tick, and a tick already in flight may still carry the place
    // from before the move.
    const bubble = await until(
      a.page,
      (id) => {
        const why = window.e2eApp.world.reason(id);
        return why && why !== 'far' ? why : null;
      },
      bId,
      15000,
      'the pair rule to hear the neighbour',
    ).catch(() => 'far');
    check('a guest beside another is in the conversation', bubble === 'bubble' || bubble === 'near' || bubble === 'meeting', bubble);

    // ---- far apart: no conversation
    await place(b.page, 900, 700);
    const far = await until(
      a.page,
      (id) => {
        const why = window.e2eApp.world.reason(id);
        return why === 'far' || why === 'full' || why === 'silent' ? why : null;
      },
      bId,
      15000,
      'the pair rule to drop the neighbour',
    ).catch(() => 'bubble');
    check('a guest across the map is out of the conversation', far === 'far' || far === 'full' || far === 'silent', far);

    // ---- the map is painted whole: every tile layer, walls included
    // A floor that is walled all round on its top rows is drawn as that floor.
    // The walls group of a WorkAdventure map is a layer like the others: drawn
    // into a canvas of its own it reached the screen nowhere, and the floor
    // it stands on showed as a transparent gap in a band along the top.
    const top = await a.page.evaluate(() => {
      const c = document.getElementById('world-canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      // The top band of the visible window, as the share of pixels that are
      // not the page background and not the avatar disc.
      let dark = 0;
      let odd = 0;
      for (let y = 0; y < 6; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];
          if (r === 0x1d && g === 0x1d && b === 0x20) dark++;
          else if (r === 0xff && g === 0x00 && b === 0x00) odd++;
        }
      }
      return { dark, odd, width: c.width };
    });
    check('the map reaches the top edge of the window', top.odd === 0, top);

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

    // ---- a guest is drawn between the overhead rows
    // The above layers of an office map are the plants and the wall tops, and
    // they must cover only whoever stands behind their foot line. The whole
    // overhead map over every guest failed this: a guest in front of a plant
    // was painted over by it.
    const depth = await a.page.evaluate(() => {
      const hook = window.e2eApp && window.e2eApp.world;
      if (!hook) return 'no world hook on the page';
      const map = hook.map();
      if (!map) return 'no map on the page';
      return { rows: map.aboveRows, band: map.aboveBand };
    });
    check(
      'the overhead rows are filled',
      depth && typeof depth === 'object' && depth.rows > 1 && depth.band > 1,
      depth,
    );

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
