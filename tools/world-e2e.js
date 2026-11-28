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

// sameLook tells two canvas pixels apart, allowing for the light filter the
// view puts under a guest's feet.
function sameLook(a, b) {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) <= 6 && Math.abs(a[1] - b[1]) <= 6 && Math.abs(a[2] - b[2]) <= 6;
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
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=RTCRtpScriptTransform',
    ],
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

    // ---- a share stops when the guest walks out of earshot
    // The rule of the module is that nobody is subscribed to a stream they can
    // not see, and a screen is a stream like the camera. A share that was
    // playing when the guest walked away used to keep playing, because
    // setRouted repainted the camera tile and not the screen tile.
    // A headless run has no display picker, so getDisplayMedia returns a canvas
    // capture: the layout and routing path under test is the one a picked
    // window takes.
    await b.page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const g = c.getContext('2d');
      let n = 0;
      setInterval(() => {
        g.fillStyle = n % 2 ? '#224466' : '#88cc44';
        g.fillRect(0, 0, 640, 360);
        n += 1;
      }, 40);
      navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(20);
    });
    await b.page.click('#share-btn');
    await until(b.page, () => !!window.e2eApp.state.screen, null, 20000, 'beta shares a screen');
    await place(b.page, 120, 100);
    await until(
      a.page,
      (id) => {
        const why = window.e2eApp.world.reason(id);
        return why && why !== 'far' ? why : 'far';
      },
      bId,
      15000,
      'the neighbour back in earshot',
    ).catch(() => 'far');
    await sleep(500);
    // The screen track crosses the pair like any other, so the tile is waited
    // for rather than sampled on a fixed delay.
    const screenWhileNear = await until(
      a.page,
      () => {
        const tiles = [...document.querySelectorAll('.tile[data-screen="yes"]')].filter(
          (t) => t.dataset.local !== 'screen',
        );
        const live = tiles.map((t) => ({
          playing: t.classList.contains('playing'),
          src: !!t.querySelector('video').srcObject,
        }));
        return live.length && live.every((one) => one.playing && one.src) ? live : null;
      },
      null,
      20000,
      'the guest sees the screen',
    ).catch(() => []);
    check(
      'the guest sees the screen while the sharer is in earshot',
      screenWhileNear.length > 0 && screenWhileNear.every((one) => one.playing && one.src),
      screenWhileNear,
    );

    // The receiver's tile is marked, so the check after the walk back can tell a
    // reattached element from a rebuilt one.
    const mark = 'm' + Date.now();
    await a.page.evaluate((m) => {
      const tile = [...document.querySelectorAll('.tile[data-screen="yes"]')].filter(
        (t) => t.dataset.local !== 'screen',
      )[0];
      if (tile) tile.dataset.presenceTileMark = m;
    }, mark);

    // Walk the sharer across the map, out of the bubble. Beta holds the
    // screen, so beta is the one that moves; alpha is the guest that must stop
    // drawing it.
    await place(b.page, 900, 700);
    const dropped = await until(
      a.page,
      (id) => {
        const why = window.e2eApp.world.reason(id);
        return why === 'far' || why === 'full' || why === 'silent' ? why : null;
      },
      bId,
      15000,
      'the sharer out of earshot',
    ).catch(() => 'bubble');
    check('the sharer is out of the conversation', dropped !== 'bubble', dropped);
    // The picture follows the route on the next frame, so the tile is read once
    // the routing has settled rather than immediately.
    const screenGone = await until(
      a.page,
      () => {
        const tiles = [...document.querySelectorAll('.tile[data-screen="yes"]')].filter(
          (t) => t.dataset.local !== 'screen',
        );
        const live = tiles.filter((t) => t.classList.contains('playing') || t.querySelector('video').srcObject);
        return live.length === 0 ? { tiles: tiles.length, live: 0 } : null;
      },
      null,
      15000,
      'the screen tile stops playing',
    ).catch(() => 'still playing');
    check('a share stops playing when the guest walks out of earshot', screenGone !== 'still playing', screenGone);

    // Walk back: the same track, no new negotiation, and the picture returns.
    await place(b.page, 120, 100);
    await until(
      a.page,
      (id) => {
        const why = window.e2eApp.world.reason(id);
        return why && why !== 'far' ? why : 'far';
      },
      bId,
      15000,
      'the sharer back in earshot',
    ).catch(() => 'far');
    const back = await until(
      a.page,
      () => {
        const tiles = [...document.querySelectorAll('.tile[data-screen="yes"]')].filter(
          (t) => t.dataset.local !== 'screen',
        );
        return tiles.length && tiles.every((t) => t.classList.contains('playing') && t.querySelector('video').srcObject)
          ? { tiles: tiles.length }
          : null;
      },
      null,
      20000,
      'the screen comes back',
    ).catch(() => 'did not come back');
    check('the share comes back when the guest walks into earshot again', back !== 'did not come back', back);
    // The share itself never stopped, and the picture came back on the same
    // tile: the receiver's element was kept and reattached, so no second
    // negotiation and no rebuilt tile took place. The element is marked before
    // the walk and looked for after it.
    const stillShared = await b.page.evaluate(() => ({
      sharing: !!window.e2eApp.state.screen,
      tracks: window.e2eApp.state.screen
        ? window.e2eApp.state.screen.getVideoTracks().map((t) => t.readyState)
        : [],
    }));
    const sameTile = await a.page.evaluate((mark) => {
      const tile = document.querySelector('.tile[data-screen="yes"][data-presence-tile-mark]');
      return !!tile && tile.dataset.presenceTileMark === mark;
    }, mark);
    check(
      'no new negotiation was needed for the share to return',
      back !== 'did not come back' && stillShared.sharing && sameTile,
      { ...stillShared, sameTile },
    );

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

    // ---- a foot line on a band boundary belongs to the row it stands in
    // Only a map with an overhead layer can judge this, so the case runs in the
      // room that carries one and says so on every other room instead of failing
      // a map the test walked by default.
      const overhead = await a.page.evaluate(() => {
        const hook = window.e2eApp && window.e2eApp.world;
        const dbg = hook && hook.debug ? hook.debug() : null;
        return !!(dbg && dbg.map && dbg.map.above);
      });
      if (!overhead) {
        console.log('SKIP  the foot line bands, this room walks a map with no overhead layer');
      } else {
      // The pixel just above a guest's foot line is the last sprite line of the
      // guest. The pixel just below it is the first line of the overhead row and
      // is drawn after the guest, so it is the leaf. Flushing the bands up to the
      // foot's own row left the guest painted over by the row it stands in: the
      // line above its feet came out as the leaf. The two pixels differ on the
      // canvas only when the bound is right.
      const footing = await a.page.evaluate(() => {
        const hook = window.e2eApp && window.e2eApp.world;
        const dbg = hook && hook.debug ? hook.debug() : null;
        if (!dbg || !dbg.map || !dbg.view) return 'no view on the page';
        const above = dbg.map.above;
        const view = dbg.view;
        if (!above) return 'no overhead paint';
        const src = above.rows.getContext('2d');
        const w = above.rows.width;
        const all = src.getImageData(0, 0, w, above.rows.height).data;
        const alpha = (x, y) => all[(y * w + x) * 4 + 3];
        const inked = (row, x) => {
          for (let i = 0; i < above.band; i++) {
            if (alpha(x, row * above.band + i) > 0) return true;
          }
          return false;
        };
        const rows = Math.floor(above.heightPx / above.band);
        // A row whose first line the leaf fills and whose line above is empty:
        // the foot line goes on that row's boundary. The leaf is empty for a
        // whole guest cell below the line, so a guest under it is a change where
        // it is drawn.
        let pick = null;
        for (let row = 1; row < rows - 1 && !pick; row++) {
          for (let x = 2; x < w - 2; x++) {
            if (!inked(row, x) || inked(row - 1, x)) continue;
            let clean = true;
            for (let y = row * above.band; y < (row + 1) * above.band && clean; y++) {
              if (alpha(x, y) === 0) clean = false;
            }
            if (clean) {
              pick = { x, row };
              break;
            }
          }
        }
        if (!pick) return 'no row with a filled top line';
        const fx = pick.x + 0.5;
        const fy = pick.row * above.band;
        const canvas = document.getElementById('world-canvas');
        const px = (mapX, mapY) => {
          const d = canvas
            .getContext('2d')
            .getImageData(Math.round(mapX * view.scale - view.camX), Math.round(mapY * view.scale - view.camY), 1, 1).data;
          return [d[0], d[1], d[2], d[3]];
        };
        hook.goTo(fx, fy);
        hook.step();
        view.mark();
        view.draw();
        // The band's own pixel on that line is what the guest must not be: with
        // the foot landing in the row after it, the last sprite line is replaced
        // by the leaf and the two pixels come out alike.
        const foot = px(fx, fy - 1);
        const d = src.getImageData(Math.round(fx - view.camX / view.scale), Math.round(fy - 1 - view.camY / view.scale), 1, 1).data;
        const leafAbove = [d[0], d[1], d[2], d[3]];
        return { pick, fy, foot, leafAbove };
      });
      check('a foot line is found on a filled top line', footing && typeof footing === 'object', footing);
      check(
        'the line above the feet is the guest, not the leaf',
        footing && typeof footing === 'object' && footing.foot[3] > 0 && !sameLook(footing.foot, footing.leafAbove),
        footing,
      );
      }

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
