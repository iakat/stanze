/* Phone and tablet check: does the page fit the screen and can a finger use it.
 *
 * For every viewport in VIEWPORTS it opens the lobby, audits the join card,
 * joins a room with a fake camera, audits the stage, opens the stats sheet and
 * a menu, and writes one screenshot per state. A finding is a rectangle that
 * leaves the screen without a clipping parent, a control a finger cannot hit,
 * or a text smaller than the sheet's 13 px floor.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
const OUT = process.env.OUTDIR || '/tmp/shots';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, scale: 3 },
  { name: 'small', width: 360, height: 740, scale: 2 },
  { name: 'tablet', width: 820, height: 1180, scale: 2 },
  { name: 'landscape', width: 844, height: 390, scale: 3 },
];

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
  while (Date.now() - start < (timeout || 30000)) {
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

/* audit runs inside the page: it returns the numbers the checks look at. */
function audit() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clip = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return true;
    }
    return false;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < vh;
  };
  const name = (el) => el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const spill = [];
  const tooSmall = [];
  const tiny = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 0.5 || r.left < -0.5) && !clip(el)) {
      spill.push(name(el) + ' [' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
    }
    const s = getComputedStyle(el);
    if (el.matches('button, a, input, select, textarea, label.pick')) {
      const h = r.height;
      const lab = el.closest('label');
      const big = lab && lab !== el && lab.getBoundingClientRect().height >= 36;
      if (h < 32 && !big) tooSmall.push(name(el) + ' h' + Math.round(h));
    }
    const fs = parseFloat(s.fontSize);
    if (el.childElementCount === 0 && el.textContent.trim() && fs < 13) {
      tiny.push(name(el) + ' ' + fs + 'px');
    }
  }
  const de = document.documentElement;
  return {
    vw, vh,
    scrollX: de.scrollWidth - de.clientWidth,
    scrollY: de.scrollHeight - de.clientHeight,
    spill: spill.slice(0, 12),
    tooSmall: tooSmall.slice(0, 12),
    tiny: tiny.slice(0, 8),
  };
}

function stageBox() {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const controls = [...document.querySelectorAll('.controls .ctrl, .controls .pick')].map((el) => {
    const b = el.getBoundingClientRect();
    return { id: el.id || el.className, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  });
  return {
    room: r('.room-row'),
    grid: r('#grid'),
    side: r('.side'),
    chat: r('#chat-panel'),
    rail: r('#stage-rail'),
    controlsRow: r('.statusline'),
    menu: r('.menubar'),
    title: r('.stage > .titlebar'),
    tile: (() => { const t = document.querySelector('#stage-main .tile'); if (!t) return null; const b = t.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
    controls,
  };
}

/* reveal taps the picture when the sheet of controls is closed, the way a
 * finger does, and waits until it is open. */
async function reveal(page) {
  if (await page.evaluate(() => document.body.classList.contains('ui-open'))) return;
  await page.tap('#grid').catch(async () => { await page.click('#grid'); });
  await until(page, () => document.body.classList.contains('ui-open'), null, 4000, 'the sheet opens').catch(() => {});
}

async function openPage(browser, viewport, room) {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // A failed fetch is counted once, below, with its URL: the browser also
    // writes a bare "Failed to load resource" line for the same request.
    if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  page.on('response', (r) => {
    const u = r.url();
    // A local server has no vosk model directory, and the transcribe menu asks
    // for it to know whether the feature is there. That is not a page error.
    if (r.status() >= 400 && !/\/vosk\//.test(u)) errors.push('http ' + r.status() + ' ' + u);
  });
  await page.goto(BASE + '/' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
  await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test').catch(() => {});
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
  const report = {};
  try {
    for (const vp of VIEWPORTS) {
      const tag = vp.name + '-';
      const a = await openPage(browser, vp, '');
      try {
        const lobby = await a.page.evaluate(audit);
        await a.page.screenshot({ path: OUT + '/' + tag + 'lobby.png' });
        check(tag + 'lobby no sideways scroll', lobby.scrollX <= 1, 'scrollX=' + lobby.scrollX);
        check(tag + 'lobby nothing out of the screen', lobby.spill.length === 0, lobby.spill.join(' | '));
        check(tag + 'lobby controls are fingers size', lobby.tooSmall.length === 0, lobby.tooSmall.join(' | '));
        check(tag + 'lobby text keeps 13 px', lobby.tiny.length === 0, lobby.tiny.join(' | '));
        const lobbyRect = await a.page.evaluate(() => {
          const b = document.querySelector('#lobby').getBoundingClientRect();
          return { b: Math.round(b.bottom), vh: window.innerHeight, h: Math.round(b.height) };
        });
        check(tag + 'lobby fits the height', lobbyRect.b <= lobbyRect.vh + 1, JSON.stringify(lobbyRect));

        await a.page.fill('#name', 'phone');
        await a.page.click('#enter-btn', { timeout: 20000 });
        await until(a.page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden, null, 30000, 'joined');
        await until(a.page, () => {
          const t = document.querySelector('#stage-main .tile');
          return !!t && t.getBoundingClientRect().height > 0;
        }, null, 30000, 'own tile');
        await sleep(1200);

        // A phone shows the picture alone. The bars and the side column are a
        // sheet that a tap brings back, so the first check runs on the bare
        // screen and the audit runs with the sheet open.
        const phone = await a.page.evaluate(() => document.body.classList.contains('phone'));
        if (phone) {
          await until(a.page, () => !document.body.classList.contains('ui-open'), null, 8000, 'the sheet closes by itself').catch(() => {});
          const bare = await a.page.evaluate(() => {
            const g = document.getElementById('grid').getBoundingClientRect();
            return {
              sheet: !document.body.classList.contains('ui-open'),
              w: Math.round(g.width), h: Math.round(g.height),
              vw: window.innerWidth, vh: window.innerHeight,
            };
          });
          check(tag + 'the picture owns the screen', bare.sheet && bare.h >= bare.vh - 8 && bare.w >= bare.vw - 8, JSON.stringify(bare));
          await reveal(a.page);
          const opened = await a.page.evaluate(() => document.body.classList.contains('ui-open'));
          check(tag + 'a tap brings the controls back', opened);
        }
        await sleep(400);

        const stage = await a.page.evaluate(audit);
        const box = await a.page.evaluate(stageBox);
        await a.page.screenshot({ path: OUT + '/' + tag + 'stage.png' });
        check(tag + 'stage no sideways scroll', stage.scrollX <= 1, 'scrollX=' + stage.scrollX);
        check(tag + 'stage nothing out of the screen', stage.spill.length === 0, stage.spill.join(' | '));
        check(tag + 'stage controls are fingers size', stage.tooSmall.length === 0, stage.tooSmall.join(' | '));
        const cIn = box.controls.every((c) => c.x >= 0 && c.x + c.w <= vp.width + 1 && c.y >= 0 && c.y + c.h <= vp.height + 1);
        check(tag + 'every control is on the screen', cIn, JSON.stringify(box.controls));
        check(tag + 'the tile has a real picture size', box.tile && box.tile.w >= 180 && box.tile.h >= 100, JSON.stringify(box.tile));
        check(tag + 'the grid keeps room', box.grid && box.grid.h >= (vp.height > vp.width ? 240 : 120), JSON.stringify(box.grid));
        check(tag + 'the toolbar holds at most two lines',
          box.controlsRow && box.controlsRow.h <= 100, JSON.stringify(box.controlsRow));
        report[vp.name] = { lobby, stage, box, errors: a.errors };

        // The stats sheet and one menu, because both are overlays. Both live
        // on the sheet, so it is brought back first.
        await reveal(a.page);
        await a.page.click('#stats-btn');
        await until(a.page, () => !document.getElementById('stats-panel').hidden, null, 8000, 'stats open').catch(() => {});
        await sleep(400);
        const stats = await a.page.evaluate(audit);
        const sbox = await a.page.evaluate(() => {
          const b = document.getElementById('stats-panel').getBoundingClientRect();
          return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
        });
        await a.page.screenshot({ path: OUT + '/' + tag + 'stats.png' });
        check(tag + 'stats sheet fits the screen', sbox.x >= 0 && sbox.x + sbox.w <= vp.width + 1 && sbox.y >= 0 && sbox.y + sbox.h <= vp.height + 1, JSON.stringify(sbox));
        check(tag + 'stats nothing out of the screen', stats.spill.length === 0, stats.spill.join(' | '));
        await a.page.click('#stats-close').catch(() => {});

        await reveal(a.page);
        await a.page.click('#menu-settings-btn').catch(() => {});
        await sleep(300);
        const menu = await a.page.evaluate(() => {
          const m = document.getElementById('menu-settings');
          if (m.hidden) return null;
          const b = m.getBoundingClientRect();
          return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
        });
        await a.page.screenshot({ path: OUT + '/' + tag + 'menu.png' });
        check(tag + 'settings menu fits the screen', menu && menu.x >= 0 && menu.x + menu.w <= vp.width + 1 && menu.y >= 0 && menu.y + menu.h <= vp.height + 1, JSON.stringify(menu));
        check(tag + 'no page errors', a.errors.length === 0, a.errors.join(' | '));
      } finally {
        await a.ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(OUT + '/report.json', JSON.stringify({ results, report }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks pass');
  if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join('; '));
  process.exit(failed.length ? 1 : 0);
})();
