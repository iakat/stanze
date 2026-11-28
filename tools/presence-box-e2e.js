/* The presence line keeps its box: the right column never jumps.
 *
 * The line is written by the routing, so it changes on its own as guests walk:
 * "hearing: nobody, walk closer or into an area." in the empty state, then one
 * name per pair in earshot. A box that grew with that text would push the chat
 * down on every step and pull it back again, and one walk would make the whole
 * right column jump.
 *
 * What is measured is the geometry, not the text: the height of the presence
 * box, the height of the near line and the top of the chat panel are read in
 * every state the page passes through. None of them may move.
 *
 * The names are long on purpose. The near line names every pair in earshot, and
 * a short name does not push the old box over a line; "alpha-longname-human"
 * twice does, which is why the crowded state is the one that used to wrap and
 * push the chat down.
 *
 * A viewport narrower than 620 px opens the call on the picture alone and hides
 * the whole side column, so the narrow case is measured at the narrowest width
 * where the column still exists.
 *
 * env: PW, CHROME, ROOMSBASE
 */
'use strict';

const { chromium } = require(process.env.PW);

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const ROOM = 'presence-' + Math.random().toString(36).slice(2, 8);
const TIMEOUT = 60000;
const NARROW = 700;
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

async function join(browser, name, viewport = { width: 1024, height: 720 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/failed to load resource|favicon/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(BASE + '/#r=' + ROOM, { waitUntil: 'domcontentloaded' });
  await page.fill('#name', name);
  await page.click('#enter-btn');
  await until(
    page,
    () => window.e2eApp && window.e2eApp.world && window.e2eApp.world.stats().loaded > 0,
    null,
    TIMEOUT,
    name,
  );
  return { ctx, page, errors };
}

// box is the geometry that must not move. It is a string because this runs in
// the page: a closure of this process does not travel into a browser.
const BOX = `(() => {
  const rect = (id) => {
    const el = document.getElementById(id);
    return el ? el.getBoundingClientRect() : null;
  };
  const r = (x) => (x ? Math.round(x * 100) / 100 : null);
  const p = rect('presence');
  const n = rect('presence-near');
  const c = rect('chat-panel');
  const v = rect('presence-via');
  const near = document.getElementById('presence-near');
  const room = document.getElementById('presence-room');
  return {
    h: r(p && p.height),
    nearH: r(n && n.height),
    nearW: r(n && n.width),
    viaH: r(v && v.height),
    chatTop: r(c && c.top),
    nearText: near ? near.textContent : '',
    roomText: room ? room.textContent : '',
    visible: !!(p && p.height > 0),
  };
})()`;

function box(page) {
  return page.evaluate(BOX);
}

// namesOn counts the pairs the near line names: one bracketed channel each.
const NAMES = `(() => {
  const near = document.getElementById('presence-near');
  const text = near ? near.textContent : '';
  return { text, names: (text.match(/\\[/g) || []).length };
})()`;

(async () => {
  const CHROME = process.env.CHROME || '';
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const guests = [];
  try {
    guests.push(await join(browser, 'alpha-longname-human'));
    const alone = await box(guests[0].page);
    console.log('INFO  alone   ' + JSON.stringify({ ...alone, nearText: alone.nearText }));
    check('the line says nobody while this guest is alone', /nobody/.test(alone.nearText), alone.nearText);
    check('the presence box is a visible box', alone.visible === true && alone.h > 0, alone);

    guests.push(await join(browser, 'beta-second-name-person'));
    guests.push(await join(browser, 'gamma-third-name-human'));
    await until(
      guests[0].page,
      () => window.e2eApp.peers().length >= 2 && window.e2eApp.peers().every((p) => p.proven && p.dc === 'open'),
      null,
      TIMEOUT,
      'the two pairs',
    );

    // The office spawns the guests a few pixels apart, so one short step puts
    // them all in one bubble: the widest the near line gets with names on it.
    const crowded = await until(
      guests[0].page,
      () => {
        const near = document.getElementById('presence-near');
        const text = near ? near.textContent : '';
        const names = (text.match(/\[/g) || []).length;
        return names >= 2 ? { text, names } : null;
      },
      null,
      20000,
      'two names on the line',
    ).catch(async () => {
      await guests[0].page.evaluate(() => window.e2eApp.world.walk('d', 500));
      await sleep(900);
      return until(
        guests[0].page,
        () => {
          const near = document.getElementById('presence-near');
          const text = near ? near.textContent : '';
          const names = (text.match(/\[/g) || []).length;
          return names >= 2 ? { text, names } : null;
        },
        null,
        TIMEOUT,
        'two names on the line, after a step',
      );
    });
    const loud = await box(guests[0].page);
    console.log('INFO  crowded ' + JSON.stringify({ ...loud, nearby: crowded.text }));
    check('the line names the guests once they are in earshot', /hearing: (?!nobody)/.test(loud.nearText), loud.nearText);
    check('the crowded line is longer than the empty one', loud.nearText.length > alone.nearText.length, {
      alone: alone.nearText.length,
      crowded: loud.nearText.length,
    });

    check('the presence box is the same height alone and crowded', alone.h === loud.h, {
      alone: alone.h,
      crowded: loud.h,
    });
    check('the near line stays one line', alone.nearH === loud.nearH, { alone: alone.nearH, crowded: loud.nearH });
    check('the chat panel does not move', alone.chatTop === loud.chatTop, { alone: alone.chatTop, crowded: loud.chatTop });

    // The narrow column that still shows the panel: the same promise, and the
    // via line as well, which appears when a guest says whom it talks to.
    const narrow = await join(browser, 'delta-narrow-column-human', { width: NARROW, height: 720 });
    guests.push(narrow);
    await until(narrow.page, () => window.e2eApp.peers().length >= 3, null, TIMEOUT, 'delta sees the room');
    const narrowA = await box(narrow.page);
    console.log('INFO  narrow  ' + JSON.stringify({ ...narrowA, nearby: narrowA.nearText }));
    check('the narrow column still shows the panel', narrowA.visible === true && narrowA.h > 0, narrowA);
    await narrow.page.evaluate(() => window.e2eApp.world.walk('d', 500));
    await sleep(1400);
    const narrowB = await box(narrow.page);
    console.log('INFO  narrow2 ' + JSON.stringify({ ...narrowB, nearby: narrowB.nearText }));
    check('a narrow column keeps the box height', narrowA.h === narrowB.h, { a: narrowA.h, b: narrowB.h });
    check('a narrow column keeps the near line to one line', narrowA.nearH === narrowB.nearH, {
      a: narrowA.nearH,
      b: narrowB.nearH,
    });

    for (const [i, g] of guests.entries()) {
      check('no page error in guest ' + (i + 1), g.errors.length === 0, g.errors.slice(0, 3));
    }
  } catch (err) {
    check('the run finished', false, err && err.message ? err.message : String(err));
  } finally {
    for (const g of guests) {
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
