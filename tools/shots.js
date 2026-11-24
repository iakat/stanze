/* README pictures of the live page.
 *
 * Four views: the join card, a two person call, the stats panel and the
 * effects menu. Each one is taken at twice the pixel density and cut to the
 * box that carries the interface, so the text stays sharp on a readme and no
 * unused page margin is shipped.
 *
 * env: PW (path to playwright-core), BASE, OUT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PW);

const BASE = (process.env.BASE || 'https://stanze.ch-test.katia.sh').replace(/\/+$/, '');
const OUT = process.env.OUT || path.join(__dirname, '..', 'scripts-out');
const W = 1280;
const H = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, fn, label, ms = 40000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await page.evaluate(fn);
      if (last) return last;
    } catch (e) {
      last = String(e);
    }
    await sleep(250);
  }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

function roomID() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = require('crypto').randomBytes(26);
  let out = '';
  for (let i = 0; i < 26; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// shrink draws a png onto a canvas at the wanted width and writes it back, so
// a picture at twice the density still ships at a sane size.
async function shrink(browser, file, width) {
  const page = await browser.newPage();
  const b64 = fs.readFileSync(file).toString('base64');
  const out = await page.evaluate(
    async ([data, want]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await img.decode();
      const scale = Math.min(1, want / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png').split(',')[1];
    },
    [b64, width],
  );
  fs.writeFileSync(file, Buffer.from(out, 'base64'));
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      ...(fs.existsSync('/tmp/opencode/shots/bars.y4m')
        ? ['--use-file-for-fake-video-capture=/tmp/opencode/shots/bars.y4m']
        : []),
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--enable-features=RTCRtpScriptTransform',
    ],
  });
  const errors = [];

  const mk = async () => {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 2,
      ignoreHTTPSErrors: true,
      permissions: ['camera', 'microphone'],
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    return page;
  };

  const join = async (who, room) => {
    const page = await mk();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await until(page, () => state.wasmOk === true, 'wasm ' + who);
    await page.fill('#name', who);
    await page.fill('#room', room);
    await page.click('#enter-btn');
    await until(page, () => !document.getElementById('stage').hidden, 'stage ' + who);
    return page;
  };

  const clipOf = (page, id, pad) =>
    page.evaluate(
      ([sel, grow]) => {
        const r = document.getElementById(sel).getBoundingClientRect();
        return {
          x: Math.max(0, r.x - grow),
          y: Math.max(0, r.y - grow),
          width: r.width + grow * 2,
          height: r.height + grow * 2,
        };
      },
      [id, pad],
    );

  try {
    // ---- the join card, on the page background
    const lobby = await mk();
    await lobby.goto(BASE + '/', { waitUntil: 'load' });
    await until(lobby, () => state.wasmOk === true, 'wasm');
    await sleep(1200);
    await lobby.screenshot({ path: OUT + '/lobby.png', clip: await clipOf(lobby, 'lobby', 26) });

    // ---- two people in a call, both identities pinned
    const room = roomID();
    const a = await join('ada', room);
    const b = await join('bo', room);
    await until(a, () => document.querySelectorAll('.tile').length >= 2, 'two tiles');
    await until(
      a,
      () => {
        for (const v of document.querySelectorAll('.tile video')) if (v.videoWidth > 0) return true;
        return false;
      },
      'a decoded remote picture',
      20000,
    );
    for (const page of [a, b]) {
      for (const tile of await page.$$('.tile[data-peer]')) {
        try {
          await tile.$eval('.dots', (el) => el.click());
          await sleep(350);
          const pin = await page.$('.menubar-menu:not([hidden]) .pin-btn, .menu:not([hidden]) .pin-btn');
          if (pin) {
            await pin.click();
            await sleep(700);
          }
          await page.keyboard.press('Escape');
          await sleep(200);
        } catch (e) {
          errors.push('pin: ' + String(e));
        }
      }
    }
    await until(
      a,
      () => !document.body.innerText.includes('identity changed'),
      'pinned identities',
      15000,
    ).catch((e) => errors.push(String(e)));
    await sleep(2500);
    await a.screenshot({ path: OUT + '/call.png' });
    await shrink(browser, OUT + '/call.png', 1600);

    // ---- the stats panel alone
    await a.click('#stats-btn');
    await until(a, () => !document.getElementById('stats-panel').hidden, 'stats panel');
    await sleep(3000);
    await a.screenshot({ path: OUT + '/stats.png', clip: await clipOf(a, 'stats-panel', 12) });
    await a.click('#stats-close');
    await sleep(300);

    // ---- the effects menu alone
    await a.click('#menu-effects-btn');
    await sleep(800);
    const menu = await a.evaluate(() => {
      const el = document.querySelector('.menubar-menu:not([hidden])');
      const r = el.getBoundingClientRect();
      return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
    });
    await a.screenshot({ path: OUT + '/effects.png', clip: menu });

    for (const n of ['lobby', 'call', 'stats', 'effects']) {
      const file = OUT + '/' + n + '.png';
      const buf = fs.readFileSync(file);
      console.log(n, Math.round(buf.length / 1024) + 'kB', buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20));
    }
    console.log('errors', JSON.stringify(errors));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
