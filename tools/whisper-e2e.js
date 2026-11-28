/* A whisper: a private side conversation over the sealed pair channel.
 *
 * Three chromium guests join one sealed room with fake media. The first two
 * open a whisper and say a line each; the third is in the room the whole time
 * and must never see either line, in its whisper panel or in the room log. The
 * test also proves that no line of a whisper and no name of a member reached the
 * signaling socket, that the panel is hidden and costs no layout until a
 * conversation is on, and that leaving takes the conversation down on both
 * sides. The bounds are checked on the wire shape: a list longer than SIDE_MAX,
 * a list with a repeat and a list naming the sender itself all come out at four
 * members or fewer and never include the sender.
 *
 * env: PW (path to playwright-core), CHROME (optional browser path), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const TIMEOUT = 60000;
const ROOM = 'whisper-' + Math.random().toString(36).slice(2, 8);

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

// join opens one guest on the one room and waits until the sealed pair to the
// guests already there is up, which is what a whisper rides on.
async function join(browser, name) {
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 720 },
    permissions: ['camera', 'microphone'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => errors.push(String(err && err.message ? err.message : err)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/models|fastenhancer|failed to load resource|favicon/i.test(m.text())) {
      errors.push(m.text());
    }
  });
  // Every signaling frame the page sends is kept, so the test can prove a
  // whisper never reaches the relay in the clear.
  await page.addInitScript(() => {
    window.__wsSent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        window.__wsSent.push(typeof data === 'string' ? data : '');
      } catch {
        /* a binary frame is not one of ours */
      }
      return send.call(this, data);
    };
  });
  await page.goto(BASE + '/#r=' + encodeURIComponent(ROOM), { waitUntil: 'domcontentloaded' });
  await page.fill('#name', name);
  await page.click('#enter-btn');
  await until(
    page,
    () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
    null,
    TIMEOUT,
    name + ' joins',
  );
  return { ctx, page, errors };
}

// pair waits until the page holds a proved pair to every other guest with an
// open data channel, so a whisper frame has somewhere to go.
async function pair(page, count) {
  return until(
    page,
    (want) => {
      const peers = window.e2eApp.peers();
      const ready = peers.filter((p) => p.proven && p.pc === 'connected' && p.dc === 'open');
      return ready.length >= want ? peers : null;
    },
    count,
    TIMEOUT,
    'the sealed pairs',
  );
}

// sentText is every signaling frame of one page as one string, for the canary
// check: a whisper line must not appear in any of them.
async function sentText(page) {
  return page.evaluate(() => (window.__wsSent || []).join('\n'));
}

(async () => {
  const CHROME = process.env.CHROME || '';
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  let a;
  let b;
  let c;
  try {
    a = await join(browser, 'alpha');
    b = await join(browser, 'beta');
    c = await join(browser, 'gamma');

    await pair(a.page, 2);
    await pair(b.page, 2);
    await pair(c.page, 2);

    // The map is not needed for a whisper, but the room is: a guest that waits
    // outside has no keys, so the two tests below only mean something with
    // every guest inside.
    await until(a.page, () => !window.e2eApp.state.waiting, null, TIMEOUT, 'alpha is in');
    await until(b.page, () => !window.e2eApp.state.waiting, null, TIMEOUT, 'beta is in');
    await until(c.page, () => !window.e2eApp.state.waiting, null, TIMEOUT, 'gamma is in');

    // --- the panel costs nothing until it is used -------------------------
    const beforeA = await a.page.evaluate(() => {
      const box = document.getElementById('side-panel');
      return {
        hidden: !!box.hidden,
        button: (document.getElementById('side-open') || {}).textContent,
        side: window.e2eApp.side(),
      };
    });
    check('the whisper panel is hidden in a room that never opens one', beforeA.hidden);
    check('the whisper button offers to open one', /whisper/.test(beforeA.button || ''), beforeA.button);
    check('a page in no whisper says so', beforeA.side.on === false, beforeA.side);

    // --- the room log and the whisper log are different boxes -------------
    const peerIds = await a.page.evaluate(() => window.e2eApp.peers().map((p) => p.id));
    check('alpha sees both other guests', peerIds.length === 2, peerIds);
    const betaId = await b.page.evaluate(() => window.e2eApp.state.self);

    // --- alpha opens a whisper on beta ------------------------------------
    const opened = await a.page.evaluate((id) => window.e2eApp.sideOpen([id]), betaId);
    check('a whisper opens on a named guest', opened === true, opened);
    const aOn = await until(a.page, () => {
      const s = window.e2eApp.side();
      return s.on ? s : null;
    }, null, 15000, 'alpha is in the whisper');
    check('the guest that opened it is in it', aOn.on === true, aOn);
    check('the panel shows itself', aOn.shown === true, aOn.shown);

    // Beta is told by a sealed frame on the pair it already holds.
    const bOn = await until(b.page, () => {
      const s = window.e2eApp.side();
      return s.on ? s : null;
    }, null, 20000, 'beta was invited');
    check('the guest that was named is in it too', bOn.on === true, bOn);
    check(
      'both sides hold the same members',
      aOn.members.length === 2 && bOn.members.slice().sort().join(',') === aOn.members.slice().sort().join(','),
      { a: aOn.members, b: bOn.members },
    );

    // --- a line goes to the members and to nobody else ---------------------
    const ALPHA_LINE = 'meet me by the stairs';
    await a.page.evaluate((t) => window.e2eApp.sideSay(t), ALPHA_LINE);
    const bHeard = await until(b.page, (want) => {
      const s = window.e2eApp.side();
      return s.lines.some((l) => l.includes(want)) ? s : null;
    }, ALPHA_LINE, 20000, 'beta hears the whisper');
    check('the named guest receives the line', bHeard.lines.some((l) => l.includes(ALPHA_LINE)), bHeard.lines);
    check(
      'the line is not in the room log',
      !(await b.page.evaluate(() => document.getElementById('chat-log').textContent)).includes(ALPHA_LINE),
    );

    const BETA_LINE = 'on my way';
    await b.page.evaluate((t) => window.e2eApp.sideSay(t), BETA_LINE);
    const aHeard = await until(a.page, (want) => {
      const s = window.e2eApp.side();
      return s.lines.some((l) => l.includes(want)) ? s : null;
    }, BETA_LINE, 20000, 'alpha hears the answer');
    check('the answer comes back on the same channel', aHeard.lines.some((l) => l.includes(BETA_LINE)), aHeard.lines);

    // --- the third guest, in the same room, is not in the conversation ----
    await sleep(1500);
    const cSide = await c.page.evaluate(() => window.e2eApp.side());
    const cChat = await c.page.evaluate(() => document.getElementById('chat-log').textContent);
    check('a guest outside the whisper is not in it', cSide.on === false, cSide);
    check('the panel of that guest stays hidden', cSide.shown === false, cSide.shown);
    check('no line of the whisper reached that guest', !cChat.includes(ALPHA_LINE) && !cChat.includes(BETA_LINE));
    check(
      'the whisper counters of that guest are zero',
      (await c.page.evaluate(() => window.e2eApp.counters())).sideRecv === 0,
    );

    // --- the counters moved on the members -------------------------------
    const counters = await a.page.evaluate(() => window.e2eApp.counters());
    check('the member counted the line it sent', counters.sideSent === 1, counters.sideSent);
    check('the member counted the line it received', counters.sideRecv === 1, counters.sideRecv);

    // --- no line, no name, no member list on the wire ---------------------
    for (const [who, page] of [
      ['alpha', a.page],
      ['beta', b.page],
    ]) {
      const wire = await sentText(page);
      check('no whisper line reached the relay from ' + who, !wire.includes(ALPHA_LINE) && !wire.includes(BETA_LINE));
      check('no member name reached the relay from ' + who, !wire.includes('"alpha"') && !wire.includes('"beta"'));
      check('the word side never appears in a frame from ' + who, !wire.includes('"side"'));
    }

    // --- leaving ends it on both sides ------------------------------------
    await b.page.evaluate(() => window.e2eApp.sideLeave());
    const aGone = await until(a.page, () => (window.e2eApp.side().on ? null : window.e2eApp.side()), null, 20000, 'alpha sees beta go');
    check('a member that leaves ends the conversation for the other', aGone.on === false, aGone);
    check('the panel goes back to hidden', aGone.shown === false, aGone.shown);
    const bGone = await b.page.evaluate(() => window.e2eApp.side());
    check('the member that left is out of it', bGone.on === false, bGone);

    // --- a second whisper, the owner leaving, the same answer -------------
    const again = await a.page.evaluate((id) => window.e2eApp.sideOpen([id]), betaId);
    check('a whisper can be opened again afterwards', again === true, again);
    await until(b.page, () => window.e2eApp.side().on, null, 20000, 'beta is in the second one');
    await a.page.evaluate(() => window.e2eApp.sideLeave());
    const bOwnerGone = await until(
      b.page,
      () => (window.e2eApp.side().on ? null : window.e2eApp.side()),
      null,
      20000,
      'the owner leaving ends it',
    );
    check('the owner leaving ends it for the others', bOwnerGone.on === false, bOwnerGone);

    // --- the bounds -------------------------------------------------------
    // A list longer than SIDE_MAX, with a repeat and with junk in it, is handed
    // to the same function the frame path uses. The list a member holds always
    // names the opener and the reader, because they are members; what the bounds
    // stop is a stranger, a repeat and a list longer than the conversation.
    const bounded = await a.page.evaluate(() => {
      const peerIds = window.e2eApp.peers().map((p) => p.id);
      const self = window.e2eApp.state.self;
      const many = [self, ...peerIds, ...peerIds, 'not-a-peer-id', ...peerIds];
      window.e2eApp.sideOpen(many);
      return { side: window.e2eApp.side(), self, peers: peerIds };
    });
    check('a list of members never exceeds the bound', bounded.side.members.length <= 4, bounded.side.members.length);
    check(
      'the opener is in the list it holds',
      bounded.side.members.includes(bounded.self),
      bounded.side.members,
    );
    check(
      'no id outside the room reaches the list',
      bounded.side.members.every((id) => id === bounded.self || bounded.peers.includes(id)),
      bounded.side.members,
    );
    check(
      'no member list repeats a guest',
      new Set(bounded.side.members).size === bounded.side.members.length,
      bounded.side.members,
    );
    await a.page.evaluate(() => window.e2eApp.sideLeave());

    // --- nothing thrown, nothing drawn wrong ------------------------------
    check('no page error in the guest that opened it', a.errors.length === 0, a.errors.slice(0, 4));
    check('no page error in the guest that was named', b.errors.length === 0, b.errors.slice(0, 4));
    check('no page error in the guest outside it', c.errors.length === 0, c.errors.slice(0, 4));

    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      await a.page.screenshot({ path: OUT + '/whisper-a.png' });
      await b.page.screenshot({ path: OUT + '/whisper-b.png' });
      await c.page.screenshot({ path: OUT + '/whisper-c.png' });
    }
  } catch (err) {
    check('the run finished', false, err && err.message ? err.message : String(err));
  } finally {
    for (const g of [c, b, a]) {
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
  console.log('0 checks, 1 failed');
  process.exit(1);
});
