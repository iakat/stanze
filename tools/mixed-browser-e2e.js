/* A room with two Firefox guests and one Chromium guest.
 *
 * The same mesh, joined from two engines: two Firefox contexts and one
 * Chromium context. The check answers whether the three guests see each
 * other, and what the sealing path does per engine.
 *
 * env: PW (playwright directory that has chromium and firefox), ROOMSBASE,
 * OUTDIR (optional)
 */
'use strict';

const fs = require('fs');
const pw = require(process.env.PW || 'playwright');
const chromium = pw.chromium;
const firefox = pw.firefox;
const { expectedMiss } = require('./expected-404');

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';

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
  while (Date.now() - start < (timeout || 45000)) {
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(500);
    if (process.env.TRACE) console.log('INFO  wait ' + label + ' ' + JSON.stringify(last));
  }
  console.log("INFO  timeout " + label + " last=" + JSON.stringify(last));
  throw new Error("timed out: " + (label || "condition"));
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

// missed is the URL of every answer of 4xx and 5xx the page asked for. A
// failed resource is logged by Chromium as a console error without the URL, so
// the line alone can not say whether it is one of the expected misses; the
// answer it stands for can.
function watch(page, tag, errors, missed) {
  page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + (e && e.message ? e.message : e)));
  page.on('response', (res) => {
    if (res.status() >= 400) missed.push(res.url());
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expectedMiss(m)) return;
    // Chromium's own wording for a failed load, with no address in it.
    if (/^Failed to load resource/.test(m.text())) {
      let url = '';
      try {
        url = (m.location() || {}).url || '';
      } catch (_err) {
        url = '';
      }
      missed.push({ url, text: m.text() });
      return;
    }
    errors.push(tag + ' console: ' + m.text());
  });
}

(async () => {
  const id = room();
  const errors = [];
  const missed = [];
  let ff = null;
  let cr = null;
  try {
    ff = await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'dom.events.testing.asyncClipboard': true,
        'privacy.webrtc.legacyGlobalIndicator': false,
      },
    });
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
    const guests = [];
    for (const [tag, engine, name] of [
      ['A', ff, 'nia'],
      ['B', ff, 'sasha'],
      ['C', cr, 'ovio'],
    ]) {
      // Firefox has no camera or microphone permission to grant: it reads
      // the prefs set at launch, and a permission name it does not know is an
      // error. Chromium needs the grant.
      const ctx = await engine.newContext(engine === cr ? { permissions: ['camera', 'microphone'] } : {});
      const page = await ctx.newPage();
      watch(page, tag, errors, missed);
      const url = BASE + '/#r=' + id;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      guests.push({ tag, page, name, url });
    }
    for (const g of guests) {
      const at = await g.page.evaluate(() => location.href);
      console.log('INFO  ' + g.tag + ' at ' + at);
      await g.page.evaluate((n) => {
        const name = document.getElementById('name');
        if (name) {
          name.value = n;
          name.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const hash = window.location.hash;
        const lobby = document.getElementById('lobby');
        if (lobby && !lobby.hidden) document.getElementById('enter-btn').click();
        return hash;
      }, g.name);
      await g.page.waitForTimeout(300);
      console.log('INFO  ' + g.tag + ' after enter lobby=' + (await g.page.evaluate(() => (document.getElementById('lobby') || {}).hidden)));
    }
    // Each guest has to see the two others connected.
    await sleep(8000);
    for (const g of guests) {
      console.log('INFO  ' + g.tag + ' peek ' + JSON.stringify(await g.page.evaluate(() => {
        const app = window.e2eApp;
        return { app: !!app, peers: app && app.peers ? app.peers().map((p) => p.pc + '/' + p.ready + '/' + p.videoT) : null,
          err: ((document.getElementById('stage-error') || {}).textContent || '').slice(0, 120) };
      })));
    }
    for (const g of guests) {
      const seen = await until(
        g.page,
        () => {
          const app = window.e2eApp;
          if (!app || !app.peers) return null;
          const list = app.peers();
          const ready = list.filter((p) => p.pc === 'connected');
          if (ready.length >= 2) return list.length;
          return { list: list.map((p) => p.pc + '/' + p.ready) };
        },
        null,
        90000,
        g.tag + ' sees two guests',
      );
      if (seen && seen.list) {
        const dbg = await g.page.evaluate(() => ({
          app: !!window.e2eApp,
          list: window.e2eApp && window.e2eApp.peers ? window.e2eApp.peers().map((p) => p.pc + '/' + p.ready) : null,
          err: (document.getElementById('stage-error') || {}).textContent || '',
          note: (document.getElementById('lobby-error') || {}).textContent || '',
        }));
        console.log('INFO  ' + g.tag + ' dbg ' + JSON.stringify(dbg));
      }
      check(g.tag + ' sees two connected guests', seen >= 2, 'peers=' + seen);
    }
    // The engines in play, read from the page itself.
    for (const g of guests) {
      const ua = await g.page.evaluate(() => navigator.userAgent);
      console.log('INFO  ' + g.tag + ' ' + ua.replace(/.*(Firefox|Chrome)\//, '$1/').slice(0, 40));
    }
    // The sealing gate: a media track only flows when the transform is in place.
    for (const g of guests) {
      const seal = await g.page.evaluate(() => {
        const el = document.getElementById('stage-error');
        return el && !el.hidden ? el.textContent.trim() : '';
      });
      check(g.tag + ' seals its media', !(seal && /seal|transform|insertable/i.test(seal)), seal);
    }
    // The mic from each guest reaches the other two.
    for (const g of guests) {
      await g.page.evaluate(() => {
        const btn = document.getElementById('mic-btn');
        if (btn && !btn.classList.contains('on')) btn.click();
      });
    }
    await sleep(6000);
    for (const g of guests) {
      const heard = await g.page.evaluate(() => {
        const app = window.e2eApp;
        if (!app || !app.peers) return null;
        return app.peers().filter((p) => p.pc === 'connected').length;
      });
      check(g.tag + ' keeps its pairs after the mic opens', heard >= 2, 'peers=' + heard);
    }
    // A failed load is reported apart from a broken page: the two are read
    // differently, and one used to hide the other.
    const odd = missed.filter((entry) => !expectedMiss({ location: () => ({ url: entry.url }) }));
    check('no page error and no console error', errors.length === 0, errors.slice(0, 4).join(' | '));
    // The answer is what decides, not the line: the response URL is the
    // address the line lacks.
    const urls = odd.map((entry) => entry.url).filter(Boolean);
    check('no resource missing but the expected ones', urls.length === 0, urls.slice(0, 4).join(' | '));
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      for (const g of guests) await g.page.screenshot({ path: OUT + '/mix-' + g.tag + '.png' }).catch(() => {});
    }
  } catch (e) {
    check('the run reached its end', false, e && e.message ? e.message : String(e));
  } finally {
    for (const b of [ff, cr]) {
      if (b) await b.close().catch(() => {});
    }
    const bad = results.filter((r) => !r.ok);
    console.log('');
    console.log((results.length - bad.length) + ' of ' + results.length + ' PASS');
    process.exit(bad.length ? 1 : 0);
  }
})();
