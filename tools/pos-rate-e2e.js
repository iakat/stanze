/* Position refresh rate: how often a remote avatar is actually drawn moving.
 *
 * Two guests join the office map. One walks a straight line for two seconds
 * while the other samples the drawn x of that avatar on every animation frame.
 * The test counts the distinct drawn places, the frames per second the picture
 * changes at, and the longest the drawn avatar stands still while the sender is
 * still walking. A 5 Hz move shows up as a picture that changes about five times
 * a second whatever the send rate is; the fix is that the move runs on the
 * animation frame.
 *
 * env: PW, CHROME, ROOMSBASE
 */
'use strict';

const { chromium } = require(process.env.PW);

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const ROOM = 'pos-' + Math.random().toString(36).slice(2, 8);
const TIMEOUT = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checks = 0;
let failed = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  [' + JSON.stringify(detail) + ']'));
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
    await sleep(100);
  }
}

async function join(browser, name) {
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 720 },
    permissions: ['camera', 'microphone'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/models|fastenhancer|failed to load resource|favicon/i.test(m.text())) {
      errors.push(m.text());
    }
  });
  await page.goto(BASE + '/#r=' + ROOM, { waitUntil: 'domcontentloaded' });
  await page.fill('#name', name);
  await page.click('#enter-btn');
  await until(page, () => window.e2eApp && window.e2eApp.world && window.e2eApp.world.stats().loaded > 0, null, TIMEOUT, name);
  return { ctx, page, errors };
}

(async () => {
  const CHROME = process.env.CHROME || '';
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  let a;
  let b;
  try {
    a = await join(browser, 'walker');
    b = await join(browser, 'watcher');
    await until(a.page, () => window.e2eApp.state.self && window.e2eApp.peers().length >= 1, null, TIMEOUT, 'the pair');
    await until(
      a.page,
      () => window.e2eApp.peers().every((p) => p.proven && p.pc === 'connected' && p.dc === 'open'),
      null,
      TIMEOUT,
      'a sealed channel',
    );

    // The watcher samples the drawn place of the walker on every animation
    // frame while the walker holds a direction key. The walk is a loop of four
    // legs so the walker keeps travelling for the whole window: the spawn sits
    // in a corner of the office map and one leg alone runs into a wall, and a
    // blocked walker repeats one place, which is a snap and not a slide.
    const walkerId = await a.page.evaluate(() => window.e2eApp.state.self);
    await b.page.evaluate((id) => {
      const out = (window.__drawn = { id, samples: [] });
      const tick = () => {
        const at =
          window.e2eApp && window.e2eApp.world && window.e2eApp.world.drawn
            ? window.e2eApp.world.drawn(id)
            : null;
        const raw = (window.e2eApp.world.points() || []).find((one) => one.id === id) || null;
        out.samples.push({
          at: performance.now(),
          x: at ? at.x : null,
          y: at ? at.y : null,
          rx: raw ? raw.x : null,
          ry: raw ? raw.y : null,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, walkerId);

    const walking = (async () => {
      for (const key of ['w', 'd', 's', 'a']) {
        await a.page.evaluate((k) => window.e2eApp.world.walk(k, 800), key);
      }
    })();
    await sleep(300);
    const frames = await b.page.evaluate(() => (window.__drawn.samples || []).length);
    await walking;
    await sleep(400);
    const res = await b.page.evaluate(() => {
      const all = (window.__drawn.samples || []).filter((one) => typeof one.x === 'number');
      // A sample counts only while the sender is really reporting new places:
      // the test drives the walk in four round trips, so the key is up between
      // the legs and a still sender repeats one place on purpose. Frames that
      // follow the previous one by more than 60 ms are two evaluate round trips
      // and not a rendering pair, so they are not a stall of the client either.
      let lastMove = -1e9;
      const rows = [];
      for (let i = 0; i < all.length; i++) {
        if (i > 0 && (all[i].rx !== all[i - 1].rx || all[i].ry !== all[i - 1].ry)) lastMove = all[i].at;
        const active = all[i].at - lastMove < 250;
        const close = i > 0 && all[i].at - all[i - 1].at <= 60;
        rows.push({ at: all[i].at, x: all[i].x, y: all[i].y, live: active && close });
      }
      // The rate the picture changes at, over the live frames only. A one euro
      // filter holds a steady lag on a constant velocity, so the drawn place
      // steps when the sender reports and not on every animation frame: the
      // number to expect is the send rate, not the screen rate.
      let changes = 0;
      let seen = null;
      let longest = 0;
      let since = 0;
      let first = 0;
      let last = 0;
      let live = 0;
      for (const one of rows) {
        if (!one.live) {
          seen = null;
          continue;
        }
        if (!live) first = one.at;
        live++;
        last = one.at;
        const where = one.x.toFixed(2) + ',' + one.y.toFixed(2);
        if (where !== seen) {
          changes++;
          if (seen !== null) longest = Math.max(longest, one.at - since);
          since = one.at;
          seen = where;
        }
      }
      const ms = last - first;
      return {
        live,
        changes,
        hz: ms > 0 ? Math.round(((changes / ms) * 1000) * 10) / 10 : 0,
        longest: Math.round(longest),
        rawMoves: new Set(all.map((one) => one.rx + ',' + one.ry)).size,
      };
    });
    console.log(
      'INFO  ' +
        res.live +
        ' live frames, ' +
        res.changes +
        ' moves, ' +
        res.hz +
        ' Hz, longest still ' +
        res.longest +
        ' ms, ' +
        res.rawMoves +
        ' places reported',
    );

    check('the watcher sampled on the animation frame', res.live > 30 && frames > 0, res.live);
    check('the sender reported many places', res.rawMoves > 8, res.rawMoves);
    check('the drawn avatar moves at the send rate, not the 5 Hz judge tick', res.hz > 20, res.hz);
    check('the drawn avatar never stands still for a judge tick', res.longest < 200, res.longest);

    check('no page error in the walker', a.errors.length === 0, a.errors.slice(0, 3));
    check('no page error in the watcher', b.errors.length === 0, b.errors.slice(0, 3));
  } catch (err) {
    check('the run finished', false, err && err.message ? err.message : String(err));
  } finally {
    for (const g of [b, a]) {
      if (!g) continue;
      await g.page.close().catch(() => {});
      await g.ctx.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
  console.log(checks + ' checks, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('FAIL  ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
