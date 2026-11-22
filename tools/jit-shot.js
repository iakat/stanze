/* Two browsers in one /jit room, for a picture of the skin with real tiles.
 * env: PW (playwright-core), ROOMSBASE, OUTDIR */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'https://stanze.ch-test.katia.sh';
const OUT = process.env.OUTDIR || '/tmp/shots';
const ROOM = 'jitroom' + Date.now().toString(36).slice(-5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, fn, arg, timeout = 45000, label = '') {
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
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

function attach(page, tag, errors) {
  page.on('pageerror', (e) => { errors.push(tag + ' pageerror: ' + e); console.log(tag + ' PAGEERROR ' + e); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(tag + ' CONSOLE ' + m.text()); });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const errors = [];
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await contextA.newPage();
  attach(a, 'A', errors);
  await a.goto(BASE + '/jit', { waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#enter-btn');
  await a.fill('#name', 'alice');
  await a.fill('#room', ROOM);
  await a.click('#enter-btn');
  await until(a, () => !document.getElementById('stage').hidden, null, 45000, 'A stage');
  await until(a, () => document.querySelectorAll('.tile').length > 0, null, 45000, 'A tile');
  await sleep(2500);
  const aState = await a.evaluate(() => ({
    url: location.href,
    title: document.title,
    tiles: [...document.querySelectorAll('.tile')].map((t) => ({
      name: (t.querySelector('.name') || {}).textContent,
      state: t.dataset.state,
      video: !!t.querySelector('video') && t.querySelector('video').videoWidth,
    })),
    toolbar: [...document.querySelectorAll('.controls .ctrl')].map((b) => b.id + '=' + b.dataset.label),
    sideOpen: getComputedStyle(document.querySelector('.side')).display,
    watermark: (document.querySelector('.jit-watermark') || {}).offsetParent !== null,
  }));
  console.log('A ' + JSON.stringify(aState));
  await a.screenshot({ path: OUT + '/a.png' });

  const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const b = await contextB.newPage();
  attach(b, 'B', errors);
  // The second guest comes in by the jitsi-shaped link: room in the path.
  await b.goto(BASE + '/jit/' + ROOM, { waitUntil: 'domcontentloaded' });
  await b.waitForSelector('#enter-btn');
  const bootUrl = await b.evaluate(() => location.href);
  console.log('B boot ' + bootUrl + ' room field=' + (await b.inputValue('#room')));
  await b.fill('#name', 'bob');
  await b.click('#enter-btn');
  await until(b, () => !document.getElementById('stage').hidden, null, 45000, 'B stage');
  await sleep(4000);

  // A headless browser may refuse the frame transform, so a room without a
  // picture hides the chat sheet. The chat line is a check, not the point of
  // the picture, so it runs only when the sheet is on screen.
  await a.evaluate(() => document.getElementById('chat-btn').click());
  await sleep(400);
  if (await a.isVisible('#chat-text')) {
    await a.fill('#chat-text', 'hello from the jitsi shaped room');
    await a.press('#chat-text', 'Enter');
  } else {
    console.log('chat sheet hidden: no media in this browser');
  }
  await sleep(1200);
  await a.screenshot({ path: OUT + '/b.png' });

  const bChat = await b.evaluate(() => {
    const log = document.getElementById('chat-log');
    return { open: getComputedStyle(document.querySelector('.side')).display, lines: log.children.length, last: log.lastElementChild ? log.lastElementChild.textContent : '' };
  });
  console.log('B chat ' + JSON.stringify(bChat));

  // The settings sheet holds the device and quality pickers.
  await a.evaluate(() => document.getElementById('settings-btn').click());
  await sleep(400);
  const settings = await a.evaluate(() => ({
    open: document.body.classList.contains('jit-settings'),
    rows: [...document.querySelectorAll('#jit-settings .pick')].map((p) => p.textContent.trim().slice(0, 20)),
  }));
  console.log('settings ' + JSON.stringify(settings));
  await a.screenshot({ path: OUT + '/c.png' });
  await a.evaluate(() => document.getElementById('settings-btn').click());
  await sleep(300);

  // The people sheet.
  await a.evaluate(() => document.getElementById('people-btn').click());
  await sleep(500);
  const people = await a.evaluate(() => ({
    rows: [...document.querySelectorAll('#stage-rail .plist-row .row-name')].map((r) => r.textContent),
    chatHidden: getComputedStyle(document.querySelector('.chat')).display,
  }));
  console.log('people ' + JSON.stringify(people));
  await a.screenshot({ path: OUT + '/d.png' });

  const finalB = await b.evaluate(() => ({
    title: document.title,
    tiles: [...document.querySelectorAll('.tile')].map((t) => (t.querySelector('.name') || {}).textContent),
  }));
  console.log('B ' + JSON.stringify(finalB));

  // No media in this image (the browsers refuse the frame transform), so the
  // tiles of a busy room are mounted from a canvas to show the skin over a
  // picture. This is paint only, on the live page and the live stylesheet.
  await a.evaluate(() => document.getElementById('people-btn').click());
  await a.evaluate(() => {
    const main = document.getElementById('stage-main');
    main.hidden = false;
    const mount = (name, hue, live) => {
      const tile = document.createElement('div');
      tile.className = 'tile' + (live ? ' playing' : ' camoff');
      tile.dataset.state = 'connected';
      tile.dataset.mic = 'on';
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      tile.appendChild(video);
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = name;
      tile.appendChild(avatar);
      const ring = document.createElement('span');
      ring.className = 'ring';
      tile.appendChild(ring);
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.innerHTML = '<span class="name"></span><span class="flags"></span><span class="state">connected</span>';
      tag.querySelector('.name').textContent = name;
      tile.appendChild(tag);
      if (live) {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const g = canvas.getContext('2d');
        let n = 0;
        setInterval(() => {
          n += 1;
          const grad = g.createLinearGradient(0, 0, 640, 360);
          grad.addColorStop(0, 'hsl(' + hue + ' 55% 26%)');
          grad.addColorStop(1, 'hsl(' + ((hue + 40) % 360) + ' 60% 12%)');
          g.fillStyle = grad;
          g.fillRect(0, 0, 640, 360);
          g.fillStyle = 'hsl(' + hue + ' 80% 70% / 0.85)';
          g.beginPath();
          g.arc(160 + Math.sin(n / 12) * 150, 160 + Math.cos(n / 16) * 60, 70, 0, Math.PI * 2);
          g.fill();
        }, 90);
        video.srcObject = canvas.captureStream(10);
      }
      main.appendChild(tile);
    };
    mount('alice', 210, true);
    mount('bob', 145, true);
    mount('carol', 25, false);
  });
  await sleep(900);
  await a.evaluate(() => { document.getElementById('stage-main').hidden = false; });
  await sleep(200);
  await a.screenshot({ path: OUT + '/e.png' });

  console.log('errors ' + JSON.stringify(errors));
  await browser.close();
  console.log('DONE');
})().catch((e) => {
  console.error('FATAL ' + (e && e.stack || e));
  process.exit(1);
});
