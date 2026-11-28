/* Four guests in one room, all at once.
 *
 * A mesh has one pair per two guests, so four guests owe six connected pairs
 * each of the others must see. The check joins four Chromium contexts into the
 * same link, then asks every guest for the three others and for the six links.
 *
 * env: PW (playwright directory that has chromium), ROOMSBASE, OUTDIR (optional)
 */
'use strict';

const fs = require('fs');
const pw = require(process.env.PW || 'playwright');
const chromium = pw.chromium;
const { expectedMiss } = require('./expected-404');

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const N = 4;

const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, fn, arg, timeout, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < (timeout || 60000)) {
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(500);
  }
  console.log('INFO  timeout ' + label + ' last=' + JSON.stringify(last));
  return null;
}

function room() {
  const a = new Uint8Array(16);
  require('crypto').randomFillSync(a);
  const b32 = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let bits = 0;
  let buf = 0;
  for (const x of a) {
    buf = (buf << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += b32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function watch(page, tag, errors) {
  page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + (e && e.message ? e.message : e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expectedMiss(m)) return;
    errors.push(tag + ' console: ' + m.text());
  });
}

// The peers a page holds as connected, with the name each carries. The list is
// returned only when all of `want` are in it, so a partial mesh keeps waiting.
const CONNECTED = (want) => {
  const app = window.e2eApp;
  if (!app || !app.peers) return null;
  const list = app.peers().filter((p) => p.pc === 'connected').map((p) => p.name);
  return want.every((n) => list.includes(n)) ? list : null;
};

(async () => {
  const id = room();
  const errors = [];
  let cr = null;
  try {
    cr = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
      headless: true,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--enable-features=RTCRtpScriptTransform',
      ],
    });
    const names = ['uno', 'due', 'tre', 'quattro'];
    const guests = [];
    for (let i = 0; i < N; i++) {
      const ctx = await cr.newContext({ permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      watch(page, names[i], errors);
      await page.goto(BASE + '/#r=' + id, { waitUntil: 'domcontentloaded' });
      guests.push({ tag: names[i], page });
    }
    for (const g of guests) {
      await g.page.evaluate((n) => {
        const name = document.getElementById('name');
        if (name) {
          name.value = n;
          name.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const lobby = document.getElementById('lobby');
        if (lobby && !lobby.hidden) document.getElementById('enter-btn').click();
      }, g.tag);
      await g.page.waitForTimeout(300);
    }

    // Every guest must hold the other three, by name.
    const held = {};
    for (const g of guests) {
      const seen = await until(
        g.page,
        CONNECTED,
        names.filter((n) => n !== g.tag),
        90000,
        g.tag + ' sees three guests',
      );
      const list = Array.isArray(seen) ? seen : [];
      held[g.tag] = list;
      const want = names.filter((n) => n !== g.tag);
      const missing = want.filter((n) => !list.includes(n));
      const detail = 'sees=' + list.join(',') + (missing.length ? ' missing=' + missing.join(',') : '');
      check(g.tag + ' holds the other three', missing.length === 0, detail);
    }

    // One pair per guest pair, so six links in the room's mesh.
    const links = new Set();
    for (const [who, others] of Object.entries(held)) {
      for (const other of others) links.add([who, other].sort().join('-'));
    }
    check('the room holds six links', links.size === 6, 'links=' + links.size + ' ' + [...links].sort().join(' '));

    // Every pair reads connected on both sides.
    let both = 0;
    for (const g of guests) {
      for (const h of guests) {
        if (g === h) continue;
        if ((held[g.tag] || []).includes(h.tag) && (held[h.tag] || []).includes(g.tag)) both++;
      }
    }
    check('every pair agrees on the link', both === N * (N - 1), 'agreed=' + both + ' of ' + N * (N - 1));

    // A mic on all four keeps the mesh.
    for (const g of guests) {
      await g.page.evaluate(() => {
        const btn = document.getElementById('mic-btn');
        if (btn && !btn.classList.contains('on')) btn.click();
      });
    }
    await sleep(6000);
    for (const g of guests) {
      const count = await g.page.evaluate(() => window.e2eApp.peers().filter((p) => p.pc === 'connected').length);
      check(g.tag + ' keeps three links after the mic opens', count === N - 1, 'peers=' + count);
    }

    check('no page error and no console error', errors.length === 0, errors.slice(0, 4).join(' | '));
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      for (const g of guests) await g.page.screenshot({ path: OUT + '/quartet-' + g.tag + '.png' }).catch(() => {});
    }
  } catch (e) {
    check('the run reached its end', false, e && e.message ? e.message : String(e));
  } finally {
    if (cr) await cr.close().catch(() => {});
    const bad = results.filter((r) => !r.ok);
    console.log('');
    console.log((results.length - bad.length) + ' of ' + results.length + ' PASS');
    process.exit(bad.length ? 1 : 0);
  }
})();
