/* A door carries a guest to another room.
 *
 * The office map ships WorkAdventure's own door: an area named to-conference
 * with exitUrl conference.tmj. A guest that steps into it leaves this call and
 * joins the room the door names, and that room puts them on its own start
 * area, not on the default spawn. Two chromium guests start in the office, one
 * walks into the door, and the page that was left is empty.
 *
 * Every case prints PASS or FAIL and the run exits 1 when one fails.
 *
 * env: PW (path to playwright-core), ROOMSBASE, OUTDIR (optional)
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const TIMEOUT = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checks = 0;
let failed = 0;
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

// join opens one guest on a room and waits until its world loop runs.
async function join(browser, room, name) {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  page.on('pageerror', (err) => errors.push(String(err && err.message ? err.message : err)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/models|fastenhancer|failed to load resource|favicon/i.test(m.text())) {
      errors.push(m.text());
    }
  });
  await page.goto(BASE + '/#r=' + encodeURIComponent(room), { waitUntil: 'domcontentloaded' });
  await page.fill('#name', name);
  await page.click('#enter-btn');
  await until(
    page,
    () => window.e2eApp && window.e2eApp.world && window.e2eApp.world.stats().loaded > 0,
    null,
    TIMEOUT,
    'the world of ' + name,
  );
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  let a;
  let b;
  try {
    a = await join(browser, 'office', 'alpha');
    b = await join(browser, 'office', 'beta');

    const doors = await a.page.evaluate(() => window.e2eApp.world.doors());
    check(
      'the office map carries a door to the conference room',
      Array.isArray(doors) && doors.some((d) => d.room === 'conference'),
      doors,
    );
    const door = (doors || []).find((d) => d.room === 'conference');
    check('the door names a room this page knows', !!door && !!door.id, door);

    // The guest walks into the door the way the map draws it: the zone itself
    // has no walk to it, so the hook fires the same code a step runs.
    const fired = await a.page.evaluate((id) => window.e2eApp.world.door(id), door.id);
    check('the door fires', fired === 'fired', fired);

    // The page joins the room the door named, and reports it.
    const landed = await until(
      a.page,
      () => {
        const room = window.e2eApp && window.e2eApp.world ? window.e2eApp.world.map() : null;
        return room && room.room === 'conference' ? room : null;
      },
      null,
      45000,
      'the conference map',
    );
    check('the guest is in the room the door names', landed && landed.room === 'conference', landed);
    const hash = await a.page.evaluate(() => location.hash);
    check('the address carries the new room', /r=conference/.test(hash), hash);

    // The conference map marks its own start area, and that is where the guest
    // lands, not on the default spawn of the map.
    const start = await a.page.evaluate(() => window.e2eApp.world.start());
    check('the conference map marks a start area', Array.isArray(start) && start.length > 0, start);
    const pos = await a.page.evaluate(() => window.e2eApp.world.pos());
    const inside = await a.page.evaluate(
      (id) => {
        const dbg = window.e2eApp.world.debug();
        if (!dbg || !dbg.map) return null;
        const zone = (dbg.map.zones || []).find((z) => z.id === id);
        return zone ? zone.rects : null;
      },
      start && start[0],
    );
    const landedIn =
      !!pos &&
      !!inside &&
      inside.some((r) => pos.x >= r.x && pos.x < r.x + r.w && pos.y >= r.y && pos.y < r.y + r.h);
    check('the guest lands on the start area of the new room', landedIn, { pos, inside });

    // The second guest stayed in the office: a door moves one guest.
    const other = await b.page.evaluate(() => window.e2eApp.world.map());
    check('the other guest stays in the office', other && other.room === 'office', other && other.room);

    check('no page error in a', a.errors.length === 0, a.errors.slice(0, 4));
    check('no page error in b', b.errors.length === 0, b.errors.slice(0, 4));
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      await a.page.screenshot({ path: OUT + '/door-a.png' });
      await b.page.screenshot({ path: OUT + '/door-b.png' });
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
