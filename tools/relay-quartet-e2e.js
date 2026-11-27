/* Four guests in one room, every link through the relay.
 *
 * The same four-guest mesh as quartet-e2e, joined with the path set to
 * "relay" on all four pages. The transport policy then drops every host and
 * server-reflexive candidate, so a link that comes up is a link the TURN
 * server carries. The check reads the candidate pair of every connection and
 * fails a pair where neither end is a relay.
 *
 * env: PW (playwright directory that has chromium), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const pw = require(process.env.PW || 'playwright');
const chromium = pw.chromium;
const { expectedMiss } = require('./expected-404');

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const N = 4;
const NAMES = ['uno', 'due', 'tre', 'quattro'];

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

// The connected peers of a page, by name, but only once all of `want` are in.
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
      headless: true,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--enable-features=RTCRtpScriptTransform',
      ],
    });
    const guests = [];
    for (let i = 0; i < N; i++) {
      const ctx = await cr.newContext({ permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      watch(page, NAMES[i], errors);
      await page.goto(BASE + '/#r=' + id, { waitUntil: 'domcontentloaded' });
      guests.push({ tag: NAMES[i], page });
    }
    // The path is chosen in the lobby, before the room is entered, so every
    // pair is built with the relay-only transport policy from its first offer.
    for (const g of guests) {
      const picked = await g.page.evaluate(() => {
        const pick = document.getElementById('path');
        if (!pick) return null;
        pick.value = 'relay';
        pick.dispatchEvent(new Event('change', { bubbles: true }));
        return pick.value;
      });
      check(g.tag + ' asks for the relay path', picked === 'relay', 'path=' + picked);
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

    const held = {};
    for (const g of guests) {
      const seen = await until(g.page, CONNECTED, NAMES.filter((n) => n !== g.tag), 120000, g.tag + ' sees three guests');
      const list = Array.isArray(seen) ? seen : [];
      held[g.tag] = list;
      const missing = NAMES.filter((n) => n !== g.tag && !list.includes(n));
      check(g.tag + ' holds the other three over the relay', missing.length === 0, 'sees=' + list.join(',') + (missing.length ? ' missing=' + missing.join(',') : ''));
    }

    const links = new Set();
    for (const [who, others] of Object.entries(held)) {
      for (const other of others) links.add([who, other].sort().join('-'));
    }
    check('the relay carries six links', links.size === 6, 'links=' + links.size);

    // Every live pair, read through the browser's own transport stats: the
    // local candidate type must be relay on both ends of a relay-only pair.
    const pairs = await guests[0].page.evaluate(async () => {
      const out = [];
      const app = window.e2eApp;
      for (const peer of app.state.peers.values()) {
        if (!peer.pc) continue;
        const stats = await peer.pc.getStats();
        let local = '';
        let remote = '';
        let nominated = false;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') {
            nominated = true;
            const l = stats.get(r.localCandidateId);
            const rm = stats.get(r.remoteCandidateId);
            local = l ? l.candidateType : '';
            remote = rm ? rm.candidateType : '';
          }
        });
        out.push({ name: peer.name, local, remote, nominated });
      }
      return out;
    });
    for (const p of pairs) {
      check(p.name + ' is carried by the relay', p.local === 'relay' && (p.remote === 'relay' || p.remote === 'prflx'), 'local=' + p.local + ' remote=' + p.remote);
    }

    // A mic on all four keeps the relayed mesh.
    for (const g of guests) {
      await g.page.evaluate(() => {
        const btn = document.getElementById('mic-btn');
        if (btn && !btn.classList.contains('on')) btn.click();
      });
    }
    await sleep(6000);
    for (const g of guests) {
      const count = await g.page.evaluate(() => window.e2eApp.peers().filter((p) => p.pc === 'connected').length);
      check(g.tag + ' keeps three relayed links after the mic opens', count === N - 1, 'peers=' + count);
    }

    check('no page error and no console error', errors.length === 0, errors.slice(0, 4).join(' | '));
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      for (const g of guests) await g.page.screenshot({ path: OUT + '/relay-' + g.tag + '.png' }).catch(() => {});
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
