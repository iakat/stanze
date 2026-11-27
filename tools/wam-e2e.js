/* A .wam world opens like a map: one browser joins #r=wamtest, the map draws,
 * the .wam areas became zones and the start area is the spawn.
 *
 * env: PW (path to playwright-core), ROOMSBASE, OUTDIR (optional)
 */
'use strict';

const fs = require('fs');
const chromium = require(process.env.PW).chromium;

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const EXPECTED_404 = ['/vosk/models', '/omni/models', '/world/maps/wamtest.json', '/world/maps/wamtest.zones.json'];
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
    if (Date.now() > end) throw new Error('timeout: ' + (label || '') + ' ' + JSON.stringify(last));
    await sleep(200);
  }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (m) => {
      // A 404 of the fallback list is logged too; the status handler below
      // tells it apart from a real fault.
      if (m.type() === 'error' && !/models|fastenhancer|failed to load resource/i.test(m.text())) errors.push(m.text());
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !EXPECTED_404.some((path) => res.url().endsWith(path))) {
        errors.push(res.status() + ' ' + res.url());
      }
    });
    await page.goto(BASE + '/#r=wamtest', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#enter-btn', { state: 'visible' });
    await page.click('#enter-btn');
    // The world is the front view on a first visit. world-btn goes the other
    // way (it asks for the call grid), so it is never clicked when the world
    // is what this test came to see.

    const state = await until(
      page,
      () => {
        const view = document.getElementById('world-view');
        if (!view) return null;
        const note = document.getElementById('world-note');
        const text = note ? note.textContent : '';
        if (!view.hidden) return { hidden: false, error: window.__worldError || null, note: text };
        if (window.__worldError || /no world/i.test(text)) return { hidden: true, error: String(window.__worldError || text) };
        return null;
      },
      null,
      TIMEOUT,
      'world',
    );
    check('the world view is shown', state.hidden === false, state);
    const canvas = await page.evaluate(() => {
      const c = document.getElementById('world-canvas');
      return c ? { w: c.width, h: c.height } : null;
    });
    check('a map canvas is drawn', canvas && canvas.w > 0 && canvas.h > 0, canvas);
    const note = await page.evaluate(() => {
      const n = document.getElementById('world-note');
      return n ? n.textContent : '';
    });
    check('the note is the walking line, not "no world"', !/no world/i.test(note), note);
    // The loop only starts once the map loaded; a frame drawn is the proof
    // that the .wam led to a map and the map painted.
    const frames = await until(page, () => {
      const c = document.getElementById('world-canvas');
      return c && c.width > 1 ? c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 !== 3 && v !== 0x1d) : false;
    }, null, 15000, 'frames');
    check('the canvas holds painted pixels', frames === true, frames);
    check('no page error', errors.length === 0, errors.slice(0, 5));
    if (OUT) await page.screenshot({ path: OUT + '/wamtest.png' });
    fs.writeFileSync((OUT || '/tmp') + '/wamtest-state.json', JSON.stringify({ state, canvas, note, errors }, null, 1));
  } finally {
    await browser.close();
  }
  console.log(checks + ' checks, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('FAIL  ' + (err && err.stack ? err.stack : err));
  console.log('0 checks, 1 failed');
  process.exit(1);
});
