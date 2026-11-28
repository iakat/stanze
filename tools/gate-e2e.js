/* Room gate test: two browsers, one room, the passphrase changed mid call.
 *
 * The point: a value typed in the lobby is only the first word. An admin can
 * set or change the room passphrase while the call runs, the new value goes
 * sealed over every pair, a page that was already inside keeps its keys, and
 * the menu says what the room holds without printing the value.
 *
 * env: PW (path to playwright-core), ROOMSBASE, OUTDIR (optional)
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);
const { expectedMiss } = require('./expected-404');

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const EXPECTED_404 = ['/vosk/models', '/omni/models'];
const TIMEOUT = 45000;

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
    if (Date.now() > end) throw new Error('timeout: ' + label + ' last=' + JSON.stringify(last));
    await sleep(120);
  }
}

function attach(page, errors) {
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !expectedMiss(m)) errors.push('console: ' + m.text());
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const path = new URL(r.url()).pathname;
    if (r.status() === 404 && EXPECTED_404.includes(path)) return;
    errors.push('http ' + r.status() + ': ' + r.url());
  });
}

async function joinPage(context, name, room, pass) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(BASE + '/' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
    await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
    await page.fill('#name', name);
    if (room) await page.fill('#room', room);
    if (pass) await page.fill('#pass', pass);
    await page.click('#enter-btn', { timeout: 20000 });
    try {
      await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
        null, 25000, name + ' joined');
      return { page, errors };
    } catch (_err) {
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join after retries');
}

(async () => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=RTCRtpScriptTransform',
    ],
  });
  const opts = { viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'] };
  const ctxA = await browser.newContext(opts);
  const ctxB = await browser.newContext(opts);

  const run = Date.now().toString(36);
  const room = 'gate-' + run;

  let a = null;
  let b = null;
  try {
    a = await joinPage(ctxA, 'alice', room, 'one');
    b = await joinPage(ctxB, 'bob', room, 'one');

    // Both sides start from the typed value, with no change yet.
    const start = await a.page.evaluate(() => window.e2eApp.state.gate);
    check('the first value is the one typed', start.v === 'one' && start.n === 0, start);

    const note = await a.page.evaluate(() => (document.getElementById('gate-note') || {}).textContent || '');
    check('the menu names the state, never the value', note.includes('set') && !note.includes('one'), note);

    // The admin changes it through the real menu and the real prompt.
    a.page.once('dialog', (d) => d.accept('two'));
    await a.page.click('#menu-settings-btn');
    await a.page.click('#gate-pick');

    const local = await until(a.page, () => {
      const g = window.e2eApp.state.gate;
      return g.n === 1 ? g : null;
    }, null, 15000, 'alice holds the new value');
    check('the admin holds the new value with the next counter', local.v === 'two' && local.n === 1, local);

    const remote = await until(b.page, () => {
      const g = window.e2eApp.state.gate;
      return g.v === 'two' ? g : null;
    }, null, 20000, 'bob learns the new value sealed');
    // The change is a word, not a key schedule: bob keeps the pair, so its
    // counter still stands while the value travels.
    check('the value travels sealed and the counter follows', remote.v === 'two' && remote.n === 1, remote);

    // The open pair is untouched: a chat line still crosses the room.
    const line = 'still here ' + run;
    await a.page.fill('#chat-text', line);
    await a.page.press('#chat-text', 'Enter');
    const got = await until(b.page, (want) => {
      return [...document.querySelectorAll('#chat-log li')].some((li) => li.textContent.includes(want));
    }, line, 15000, 'the old pair still carries chat');
    check('a pair that was open keeps working after the change', !!got, true);

    check('alice page had no uncaught error', a.errors.length === 0, a.errors);
    check('bob page had no uncaught error', b.errors.length === 0, b.errors);
  } catch (err) {
    check('gate run completed', false, String(err));
    if (a) check('alice page had no uncaught error', a.errors.length === 0, a.errors);
    if (b) check('bob page had no uncaught error', b.errors.length === 0, b.errors);
  } finally {
    if (OUT && a) await a.page.screenshot({ path: OUT + '/gate-a.png' }).catch(() => {});
    if (OUT && b) await b.page.screenshot({ path: OUT + '/gate-b.png' }).catch(() => {});
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log('SUMMARY ' + JSON.stringify({ checks, failed }));
  if (failed) process.exitCode = 1;
})();
