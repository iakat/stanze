/* Headless Chromium check for a sealed room with three guests.
 *
 * A mesh has one code per pair, so three guests mean three codes. The room
 * badge must not read that as a mismatch: it says that a mesh has one code per
 * pair and each code stays on its own tile. A failed key confirmation is the
 * only alarm, and it stays on that pair.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8095';
const OUT = process.env.OUTDIR || 'shots';

const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
  return !!ok;
}
function info(name, detail) {
  console.log('INFO  ' + name + (detail ? '  [' + detail + ']' : ''));
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
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  // The camera is not the subject here, so the stored choice keeps it off and
  // three pages stay light enough for one job.
  await page.addInitScript(() => {
    try { localStorage.setItem('rooms.cam', '0'); } catch (e) { /* private mode */ }
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(BASE + '/' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
    await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
    const app = await page.evaluate(() => ({
      test: window.e2eApp && window.e2eApp.state.wasmTest,
      room: document.getElementById('room').value,
    }));
    await page.fill('#name', name);
    if (room) await page.fill('#room', room);
    await page.click('#enter-btn', { timeout: 20000 });
    try {
      await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
        null, 20000, name + ' joined');
      // The camera is not the subject here, so the stored choice keeps it off
      // and three pages stay light enough for one job.
      return { page, errors, app };    } catch (err) {
      console.log('RETRY ' + name + ' attempt ' + (attempt + 1) + ': ' + err);
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join after retries');
}

function meshState(page) {
  return page.evaluate(() => {
    const s = window.e2eApp.state;
    const peers = [...s.peers.values()].map((p) => ({
      id: p.id, name: p.name, ready: p.ready, confirmed: p.confirmed, sas: p.sas,
      tileSas: p.tile ? p.tile.dataset.sas || '' : '',
    }));
    const badge = document.getElementById('sealed-badge');
    const stats = document.getElementById('stats-body') ? document.getElementById('stats-body').textContent : '';
    return {
      self: s.self, room: s.room, peers,
      badge: { text: badge.textContent, title: badge.title, hidden: badge.hidden },
      stats,
      confirmFailures: window.e2eApp.counters().confirmFailures,
      workerErrors: window.e2eApp.counters().workerErrors.length,
      workerErrorList: window.e2eApp.counters().workerErrors.slice(0, 4),
    };
  });
}

async function openStats(page) {
  const open = await page.evaluate(() => !document.getElementById('stats-panel').hidden);
  if (!open) await page.click('#stats-btn');
  await sleep(2500);
}

async function dump(page, label, errors) {
  let state = null;
  try {
    state = await meshState(page);
  } catch (e) {
    state = 'evaluate failed: ' + e;
  }
  console.log('DUMP  ' + label + '  ' + JSON.stringify(state));
  if (errors && errors.length) console.log('ERRS  ' + label + '  ' + JSON.stringify(errors.slice(-10)));
}

(async () => {
  let browser = null;
  const pages = [];
  try {
    fs.mkdirSync(OUT, { recursive: true });
    browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // This Chromium build keeps RTCRtpScriptTransform behind a runtime
        // flag; without it the sealed path reports that sealing is missing.
        '--enable-features=RTCRtpScriptTransform',
      ],
    });
    // One context per guest, so names and stored volume do not mix.
    const ctxA = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const a = await joinPage(ctxA, 'alice', '');
    pages.push(a);
    const room = a.app.room;
    check('the room id is a 26 character random id', /^[a-z2-7]{26}$/.test(room), room);
    const ctxB = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const b = await joinPage(ctxB, 'bob', room);
    pages.push(b);
    const ctxC = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const c = await joinPage(ctxC, 'carol', room);
    pages.push(c);

    const settled = async (page, label) => until(page, () => {
      const p = window.e2eApp.peers();
      return p.length === 2 && p.every((x) => x.ready === 'ready' && x.confirmed && x.sas.length === 13) ? p : null;
    }, null, 90000, label).catch(async (e) => {
      for (const g of [a, b, c]) await dump(g.page, g.page === page ? label : 'other', g.errors);
      throw e;
    });

    await settled(a.page, 'alice mesh');
    await settled(b.page, 'bob mesh');
    await settled(c.page, 'carol mesh');

    for (const g of [a, b, c]) {
      await openStats(g.page);
      const st = await meshState(g.page);
      const label = st.peers.map((p) => p.name).sort().join('+');
      info('guest state', JSON.stringify({ self: st.self, room: st.room, peers: st.peers.map((p) => p.name + ':' + p.sas), badge: st.badge.text }));
      const codes = st.peers.map((p) => p.sas);
      check('the two pair codes differ at one guest (' + label + ')', codes[0] !== codes[1], codes.join(' vs '));
      check('both pair codes are on the tiles (' + label + ')',
        st.peers.every((p) => p.tileSas === p.sas), JSON.stringify(st.peers.map((p) => p.tileSas)));
      check('the badge says one code per pair (' + label + ')',
        st.badge.text === 'pq-e2e one code per pair', JSON.stringify(st.badge));
      check('the badge title names the guest count (' + label + ')',
        /2 guests/.test(st.badge.title) && /own code/.test(st.badge.title), st.badge.title);
      check('the badge is visible (' + label + ')', st.badge.hidden === false);
      check('the badge is not an alarm (' + label + ')', !/differ|mismatch/i.test(st.badge.text), st.badge.text);
      check('the stats row agrees with the badge (' + label + ')',
        /one code per pair/.test(st.stats) && !/KEY MISMATCH|CODES DIFFER/.test(st.stats), st.stats.slice(0, 160));
      check('no key confirmation failure (' + label + ')', st.confirmFailures === 0, st.confirmFailures);
      check('no worker error (' + label + ')', st.workerErrors === 0, JSON.stringify(st.workerErrorList));
    }

    // A guest leaves: one pair remains, so the badge goes back to one code and
    // that code is the code of the remaining pair.
    await c.page.click('#leave-btn');
    for (const g of [a, b]) {
      await until(g.page, () => window.e2eApp.peers().length === 1 && window.e2eApp.peers()[0].ready === 'ready',
        null, 60000, 'one peer left').catch(() => null);
    }
    await sleep(1500);
    for (const [g, label] of [[a, 'alice'], [b, 'bob']]) {
      const st = await meshState(g.page);
      const code = st.peers.length === 1 ? st.peers[0].sas : '';
      info('after the third guest left', JSON.stringify({ label, peers: st.peers.map((p) => p.name), badge: st.badge }));
      check('the badge carries the single pair code again (' + label + ')',
        !!code && st.badge.text.includes(code), st.badge.text);
    }

    for (const g of [a, b, c]) check('page had no uncaught error (' + g.page.url().slice(-14) + ')', g.errors.length === 0,
      JSON.stringify(g.errors.slice(0, 3)));
    await a.page.screenshot({ path: OUT + '/a.png' });
    await b.page.screenshot({ path: OUT + '/b.png' });
    await c.page.screenshot({ path: OUT + '/c.png' });
  } catch (err) {
    check('test completed without exception', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    for (const [i, g] of pages.entries()) {
      await g.page.screenshot({ path: OUT + '/' + 'abc'[i] + '-fail.png' }).catch(() => {});
    }
  } finally {
    await browser && browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ checks: results.length, failed: failed.length }));
  fs.writeFileSync(OUT + '/results.json', JSON.stringify(results, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
})();
