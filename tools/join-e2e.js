/* One real browser, the homepage, one join, from every window size that
 * counts.
 *
 * The point is the join as a person does it on the page they land on: no room
 * in the fragment, a name and the enter button, on a desktop, on a small
 * laptop and on a phone. Every uncaught exception and every console error is
 * fatal, and so is a page that stays in the lobby.
 *
 * env: PW (path to playwright-core), ROOMSBASE, OUTDIR (optional)
 */
'use strict';

const fs = require('fs');
const pw = require(process.env.PW || 'playwright');
const { expectedMiss } = require('./expected-404');

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const TIMEOUT = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



const faults = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
  if (!ok) faults.push(name + (d ? ' [' + d + ']' : ''));
  return ok;
}

function watch(page, who) {
  page.on('pageerror', (err) => {
    const stack = err && err.stack ? err.stack : String(err);
    faults.push(who + ' uncaught: ' + (err && err.message ? err.message : String(err)));
    console.log('FAIL  ' + who + ' uncaught: ' + (err && err.message ? err.message : String(err)) + '\n' + stack);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (expectedMiss(msg)) return;
    faults.push(who + ' console: ' + msg.text());
    console.log('FAIL  ' + who + ' console: ' + msg.text());
  });
}

async function until(page, fn, arg, label, timeout = TIMEOUT) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(250);
  }
  return { timeout: true, last };
}

function roomID() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = require('crypto').randomBytes(26);
  let out = '';
  for (let i = 0; i < 26; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// The sizes are the ones a person arrives with: a desktop, a small laptop and
// an iPhone in portrait, with the phone's touch and user agent.
const VIEWS = [
  { who: 'desktop', viewport: { width: 1280, height: 800 }, touch: false },
  { who: 'laptop', viewport: { width: 1024, height: 640 }, touch: false },
  {
    who: 'phone',
    viewport: { width: 390, height: 844 },
    touch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
];

(async () => {
  const browser = await pw.chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });
  try {
    for (const view of VIEWS) {
      const ctx = await browser.newContext({
        viewport: view.viewport,
        hasTouch: view.touch,
        userAgent: view.userAgent,
        permissions: ['camera', 'microphone'],
      });
      const page = await ctx.newPage();
      watch(page, view.who);
      await page.goto(BASE + '/', { waitUntil: 'load', timeout: TIMEOUT });
      await page.fill('#name', 'guest');
      await page.click('#enter-btn');
      const done = await until(
        page,
        () => {
          const stage = document.getElementById('stage');
          if (!stage || stage.hidden) return null;
          const app = window.e2eApp && window.e2eApp.state;
          return {
            title: document.title,
            lobby: document.getElementById('lobby').hidden,
            wasm: !!(app && app.wasmOk),
            note: document.getElementById('sealed-note').textContent,
          };
        },
        null,
        view.who + ' the stage',
      );
      check(view.who + ' leaves the lobby for the stage', done && !done.timeout, done && done.timeout ? JSON.stringify(done.last) : '');
      check(view.who + ' names the room in the title', done && !done.timeout && /stanze - \S/.test(done.title || ''), done && done.title);
      // A stage with a dead wasm module or a closed socket is not a join.
      check(view.who + ' loaded the pq module', done && !done.timeout && done.wasm, done && JSON.stringify(done));
      if (OUT && done && !done.timeout) {
        fs.mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: OUT + '/join-' + view.who + '.png' }).catch(() => {});
      }
      // The socket opens just after the stage appears: connectWS runs once the
      // devices are asked for, so the open socket is waited for, not assumed.
      await until(page, () => {
        const a = window.e2eApp && window.e2eApp.state;
        return !!(a && a.ws && a.ws.readyState === 1);
      }, null, view.who + ' the socket opens', 15000);
      const live = await page.evaluate(() => {
        const a = window.e2eApp && window.e2eApp.state;
        return !!(a && a.wasmOk && a.ws && a.ws.readyState === 1);
      });
      check(view.who + ' keeps the socket open and the pq module', live);
      // The page also has to stay joined for a moment, not fall back on the
      // first throw after the stage is shown.
      await sleep(3000);
      const held = await page.evaluate(() => !document.getElementById('stage').hidden);
      check(view.who + ' stays in the room', held);
      // A refresh on the same page is the other common way in: the room is in
      // the fragment now, so the page shows the lobby and asks for a name.
      await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
      await sleep(1500);
      const again = await page.evaluate(() => ({
        lobby: !document.getElementById('lobby').hidden,
        room: (document.getElementById('room').value || '').length > 0,
      }));
      check(view.who + ' comes back to the lobby with its room', again.lobby && again.room, JSON.stringify(again));
      await ctx.close();
    }
  } catch (e) {
    faults.push('the run reached its end: ' + (e && e.message ? e.message : e));
    console.log('FAIL  the run reached its end [' + (e && e.message ? e.message : e) + ']');
  } finally {
    await browser.close().catch(() => {});
    console.log('');
    console.log(faults.length === 0 ? 'ALL PASS' : faults.length + ' FAIL');
    process.exit(faults.length ? 1 : 0);
  }
})();
