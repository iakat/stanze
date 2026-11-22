/* Raised hands: the button, the queue order and the host command.
 *
 * Two peers join one room with fake media. The one on a desktop raises first,
 * the one on a phone raises second, and both read the same queue in the same
 * order. The admin takes the second hand down from the queue, then lowers the
 * own hand, and the panel goes away. The phone also proves that the queue
 * fits its sheet and that a tap brings the sheet back.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '/tmp/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
}

async function until(page, fn, arg, timeout, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < (timeout || 30000)) {
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

/* names reads the raised hands of one page, in the order of the panel. */
function names() {
  return [...document.querySelectorAll('#hand-queue-list .hq-name')].map((n) => n.textContent);
}

/* reveal opens the sheet of a phone, the way a finger does. */
async function reveal(page) {
  if (await page.evaluate(() => !document.body.classList.contains('phone'))) return;
  if (await page.evaluate(() => document.body.classList.contains('ui-open'))) return;
  await page.tap('#grid').catch(async () => { await page.click('#grid'); });
  await until(page, () => document.body.classList.contains('ui-open'), null, 4000, 'the sheet opens').catch(() => {});
}

async function join(browser, viewport, room, who) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: viewport.width < 620,
    hasTouch: viewport.width < 620,
    permissions: ['camera', 'microphone'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  await page.goto(BASE + '/#r=' + room, { waitUntil: 'load', timeout: 60000 });
  await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm').catch(() => {});
  await page.fill('#name', who);
  await page.click('#enter-btn', { timeout: 20000 });
  await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden, null, 30000, who + ' joins');
  return { ctx, page, errors };
}

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
  const room = 'hand' + Math.random().toString(32).slice(2, 10);
  try {
    const a = await join(browser, { width: 1280, height: 820 }, room, 'ana');
    const b = await join(browser, { width: 390, height: 844 }, room, 'bia');
    try {
      await until(a.page, () => window.e2eApp.state.peers.size === 1, null, 20000, 'A sees B');
      await until(b.page, () => window.e2eApp.state.peers.size === 1, null, 20000, 'B sees A');
      // The names travel sealed, so the queue reads them only once the pair
      // has proved itself.
      await until(a.page, () => [...window.e2eApp.state.peers.values()].every((p) => p.proven), null, 20000, 'A proved');
      await until(b.page, () => [...window.e2eApp.state.peers.values()].every((p) => p.proven), null, 20000, 'B proved');
      await until(a.page, () => [...window.e2eApp.state.peers.values()].every((p) => p.name === 'bia'), null, 20000, 'A named B');
      await until(b.page, () => [...window.e2eApp.state.peers.values()].every((p) => p.name === 'ana'), null, 20000, 'B named A');

      // A raises the hand from the toolbar.
      await a.page.click('#hand-btn');
      check('A raises the hand', await a.page.evaluate(() => window.e2eApp.state.hand));
      await until(b.page, () => document.querySelectorAll('#hand-queue-list .hq-row').length === 1, null, 8000, 'the queue of one')
        .catch(() => {});
      const one = await b.page.evaluate(names);
      check('B sees one raised hand', one.length === 1, JSON.stringify(one));
      check('B sees the name in the queue', one[0] === 'ana', JSON.stringify(one));
      const label = await a.page.evaluate(() => document.querySelector('#hand-btn span').textContent);
      check('the button reads lower hand', label === 'lower hand', label);
      await until(a.page, () => /hand #1/.test(document.querySelector('#stage-main .tile .flags').textContent), null, 8000, 'the tile flag')
        .catch(() => {});
      const flag = await a.page.evaluate(() => document.querySelector('#stage-main .tile .flags').textContent);
      check('the own tile carries the queue number', /hand #1/.test(flag), flag);

      // B raises on a phone, so the sheet has to come back first.
      await reveal(b.page);
      await b.page.click('#hand-btn');
      await until(a.page, () => document.querySelectorAll('#hand-queue-list .hq-row').length === 2, null, 8000, 'the queue of two')
        .catch(() => {});
      const two = await a.page.evaluate(names);
      check('A sees both hands', two.length === 2, JSON.stringify(two));
      check('the first hand keeps the first place', two[0] === 'ana', JSON.stringify(two));
      check('the second hand takes the second place', String(two[1]).startsWith('bia'), JSON.stringify(two));

      await reveal(b.page);
      const box = await b.page.evaluate(() => {
        const p = document.getElementById('hand-queue');
        const r = p.getBoundingClientRect();
        return {
          hidden: p.hidden, x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          vw: window.innerWidth, vh: window.innerHeight,
        };
      });
      check('the queue fits the phone sheet', !box.hidden && box.x >= 0 && box.x + box.w <= box.vw + 1 &&
        box.y >= 0 && box.y + box.h <= box.vh + 1, JSON.stringify(box));
      await b.page.screenshot({ path: OUT + '/hand-phone.png' });

      // The host takes the second hand down from the panel.
      const lowers = await a.page.evaluate(() => document.querySelectorAll('#hand-queue-list .hq-lower').length);
      check('the host gets a lower button for a guest hand', lowers === 1, 'buttons ' + lowers);
      await a.page.evaluate(() => {
        const rows = [...document.querySelectorAll('#hand-queue-list .hq-row')];
        const target = rows[rows.length - 1].querySelector('.hq-lower');
        if (target) target.click();
      });
      await until(b.page, () => document.querySelectorAll('#hand-queue-list .hq-row').length === 1, null, 8000, 'the hand goes down')
        .catch(() => {});
      const left = await b.page.evaluate(names);
      check('the lowered hand leaves the queue', left.length === 1 && left[0] === 'ana', JSON.stringify(left));
      const still = await b.page.evaluate(() => window.e2eApp.state.hand);
      check('the guest hand is down', still === false, String(still));

      // A lowers the own hand and the panel goes away for both.
      await a.page.click('#hand-btn');
      await until(b.page, () => document.getElementById('hand-queue').hidden, null, 8000, 'the panel goes away')
        .catch(() => {});
      const empty = await b.page.evaluate(() => ({
        hidden: document.getElementById('hand-queue').hidden,
        hand: window.e2eApp.state.hand,
      }));
      check('no hand leaves no panel', empty.hidden && empty.hand === false, JSON.stringify(empty));

      check('A has no page errors', a.errors.length === 0, a.errors.join(' | '));
      check('B has no page errors', b.errors.length === 0, b.errors.join(' | '));
    } finally {
      await a.ctx.close();
      await b.ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(OUT + '/hand-report.json', JSON.stringify({ results }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks pass');
  if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join('; '));
  process.exit(failed.length ? 1 : 0);
})();
