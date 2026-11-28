/* The presence line keeps its box: the right column never jumps.
 *
 * Two guests join the office map and walk in and out of earshot of each other,
 * which changes the presence line from "hearing: nobody, walk closer or into an
 * area." to "hearing: <name> [bubble]" and back. The line is written by the
 * routing, so a box that grew with its text would push the chat down on every
 * step and pull it back again: one walk would make the whole right column jump.
 *
 * What is measured is the geometry, not the text: the height of the presence
 * box and the top of the chat panel are read before, during and after the
 * change, and none of them may move by more than a pixel. The line may be cut
 * with an ellipsis; it may not wrap to a second line.
 *
 * env: PW, CHROME, ROOMSBASE
 */
'use strict';

const { chromium } = require(process.env.PW);

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const ROOM = 'presence-' + Math.random().toString(36).slice(2, 8);
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

async function join(browser, name, viewport = { width: 1024, height: 720 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
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

/* box reads the geometry that must not move: the presence box, the room line,
   the near line, and the top edge of the panel under it. */
function box() {
  const at = (el) => (el ? el.getBoundingClientRect() : null);
  const p = document.getElementById('presence');
  const near = document.getElementById('presence-near');
  const room = document.getElementById('presence-room');
  const via = document.getElementById('presence-via');
  const chat = document.getElementById('chat-panel');
  const r = at(p);
  const n = at(near);
  const c = at(chat);
  return {
    h: r ? Math.round(r.height * 100) / 100 : null,
    chatTop: c ? Math.round(c.top * 100) / 100 : null,
    nearH: n ? Math.round(n.height * 100) / 100 : null,
    nearText: near ? near.textContent : '',
    roomText: room ? room.textContent : '',
    viaH: via ? Math.round(at(via).height * 100) / 100 : null,
    viaHidden: via ? !!via.hidden : false,
  };
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
    a = await join(browser, 'alpha');
    b = await join(browser, 'beta');
    await until(
      a.page,
      () => window.e2eApp.peers().length >= 1 && window.e2eApp.peers().every((p) => p.proven && p.dc === 'open'),
      null,
      TIMEOUT,
      'the pair',
    );

    // The empty state is the long one: "hearing: nobody, walk closer or into an
    // area." is the widest the near line gets and it is where the box used to
    // grow. It is read first, before any walk, so the baseline is that state.
    const empty = await a.page.evaluate(box);
    console.log('INFO  empty  ' + JSON.stringify(empty));
    check('the line says nobody while the pairs are apart', /nobody/.test(empty.nearText), empty.nearText);

    // The guests walk into the same bubble. The office spawns them a few pixels
    // apart, so one short step puts them in a conversation.
    const walk = (async () => {
      await a.page.evaluate(() => window.e2eApp.world.walk('d', 250));
      await sleep(300);
    })();
    const loud = await until(
      a.page,
      () => {
        const near = document.getElementById('presence-near');
        return near && /hearing: (?!nobody)/.test(near.textContent) ? box() : null;
      },
      null,
      TIMEOUT,
      'a name on the line',
    );
    await walk;
    console.log('INFO  talking ' + JSON.stringify(loud));
    check('the line names the guest once they are in earshot', /hearing: (?!nobody)/.test(loud.nearText), loud.nearText);

    // The two states are different sentences, and the box is the same height.
    check('the two states are different text', empty.nearText !== loud.nearText, {
      empty: empty.nearText,
      talking: loud.nearText,
    });
    check('the presence box is the same height in both', empty.h == loud.h, { empty: empty.h, talking: loud.h });
    check('the chat panel does not move between them', empty.chatTop == loud.chatTop, {
      empty: empty.chatTop,
      talking: loud.chatTop,
    });
    check('the near line is one line in both', empty.nearH == loud.nearH, { empty: empty.nearH, talking: loud.nearH });
    check('the via line keeps its height while hidden', empty.viaH == loud.viaH, {
      empty: empty.viaH,
      talking: loud.viaH,
    });

    // The jump, measured the way a person sees it: sample the chat top on every
    // animation frame while the guests walk in and out of earshot, and count the
    // number of times it moves.
    await a.page.evaluate(() => {
      window.__tops = [];
      const tick = () => {
        const c = document.getElementById('chat-panel');
        window.__tops.push(c ? Math.round(c.getBoundingClientRect().top) : null);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < 3; i++) {
      await a.page.evaluate(() => window.e2eApp.world.walk('a', 400));
      await a.page.evaluate(() => window.e2eApp.world.walk('d', 400));
    }
    await sleep(300);
    const tops = await a.page.evaluate(() => window.__tops.filter((one) => typeof one === 'number'));
    const distinct = [...new Set(tops)];
    console.log('INFO  chat top over ' + tops.length + ' frames: ' + JSON.stringify(distinct));
    check('the chat panel never jumps while the line changes', distinct.length === 1, distinct);

    // A narrow column is the other place the line used to wrap. The phone width
    // gets the same promise.
    const phone = await join(browser, 'gamma', { width: 390, height: 700 });
    await until(phone.page, () => window.e2eApp.peers().length >= 2, null, TIMEOUT, 'gamma sees the room');
    await phone.page.click('#chrome-btn').catch(() => {});
    await sleep(800);
    const narrowEmpty = await phone.page.evaluate(box);
    await phone.page.evaluate(() => window.e2eApp.world.walk('d', 300));
    await sleep(1200);
    const narrowTalking = await phone.page.evaluate(box);
    console.log('INFO  narrow empty   ' + JSON.stringify(narrowEmpty));
    console.log('INFO  narrow talking ' + JSON.stringify(narrowTalking));
    check(
      'a narrow column keeps the same box height too',
      narrowEmpty.h == narrowTalking.h,
      { empty: narrowEmpty.h, talking: narrowTalking.h },
    );
    check(
      'a narrow column keeps the near line to one line',
      narrowEmpty.nearH == narrowTalking.nearH,
      { empty: narrowEmpty.nearH, talking: narrowTalking.nearH },
    );

    check('no page error in alpha', a.errors.length === 0, a.errors.slice(0, 3));
    check('no page error in beta', b.errors.length === 0, b.errors.slice(0, 3));
    check('no page error in gamma', phone.errors.length === 0, phone.errors.slice(0, 3));
    await phone.ctx.close().catch(() => {});
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
