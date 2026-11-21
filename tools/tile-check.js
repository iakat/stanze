/* Tile checks that the sealed suite does not cover: what a tile shows.
 *
 * Two browser contexts join one sealed room with fake devices. The test then
 * turns the camera of A off and on again, and reads the centre name and the
 * playing state of both tiles. A camera that is off must leave the name
 * visible on the own tile and on the tile of the other side.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR (optional)
 */
'use strict';

const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
const OUT = process.env.OUTDIR || 'shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
  return !!ok;
}

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
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  await page.goto(BASE + '/?sealed=1' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
  if (!(await page.evaluate(() => document.getElementById('sealed').checked))) await page.click('#sealed');
  await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
  await page.fill('#name', name);
  if (room) await page.fill('#room', room);
  await page.click('#enter-btn', { timeout: 20000 });
  await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
    null, 25000, name + ' joined');
  const app = await page.evaluate(() => ({ room: window.e2eApp.state.room, sealed: window.e2eApp.state.sealed }));
  return { page, errors, app };
}

// tileOf reads one tile in the page: the one of the local visitor or the one
// of the only remote peer.
function tileOf(page, local) {
  return page.evaluate((isLocal) => {
    const tile = isLocal
      ? document.querySelector('.tile[data-local="yes"]')
      : document.querySelectorAll('#grid > .tile:not([data-local])')[0];
    if (!tile) return { missing: true };
    const avatar = tile.querySelector('.avatar');
    const sas = tile.querySelector('.sas');
    const sasStyle = sas ? getComputedStyle(sas) : null;
    return {
      name: tile.querySelector('.name') ? tile.querySelector('.name').textContent : '',
      avatar: avatar ? avatar.textContent : '',
      avatarDisplay: avatar ? getComputedStyle(avatar).display : 'none',
      sasText: sas && !sas.hidden ? sas.textContent.trim() : '',
      sasOpacity: sasStyle ? Number(sasStyle.opacity) : 0,
      sasVisible: sas ? (!sas.hidden && sasStyle.visibility !== 'hidden' && Number(sasStyle.opacity) > 0.5) : false,
      sasImages: sas ? [...sas.querySelectorAll('img.sas-emoji')].map((i) => ({
        src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight, alt: i.alt,
      })) : [],
      sasCode: sas && sas.querySelector('.sas-code') ? sas.querySelector('.sas-code').textContent : '',
      playing: tile.classList.contains('playing'),
      videoW: tile.querySelector('video') ? tile.querySelector('video').videoWidth : 0,
    };
  }, local);
}

function peerCount(page) {
  return page.evaluate(() => (window.e2eApp ? window.e2eApp.state.peers.size : 0));
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  let a;
  let b;
  const room = 'tilecheck' + Date.now().toString(36).toLowerCase();
  try {
    const ctxA = await browser.newContext({ viewport: { width: 1180, height: 780 }, permissions: ['camera', 'microphone'] });
    const ctxB = await browser.newContext({ viewport: { width: 1180, height: 780 }, permissions: ['camera', 'microphone'] });
    a = await joinPage(ctxA, 'alice', room);
    b = await joinPage(ctxB, 'bob', a.app.room);
    const ready = (page, label) => until(page, () => {
      const p = window.e2eApp.peers();
      return p.length === 1 && p[0].ready === 'ready' && p[0].confirmed && p[0].sas.length === 13;
    }, null, 60000, label);
    await ready(a.page, 'A handshake');
    await ready(b.page, 'B handshake');
    await sleep(2500);

    const remoteA = await tileOf(a.page, false);
    const ownA = await tileOf(a.page, true);
    check('A remote tile plays the video of bob', remoteA.playing && remoteA.videoW > 0, remoteA.videoW);
    check('A own tile plays its own camera', ownA.playing, JSON.stringify({ playing: ownA.playing, videoW: ownA.videoW }));
    check('the tile keeps a readable name', /alice/.test(ownA.name), ownA.name);

    // The house typeface is shipped with the page, so the browser draws its own
    // copy instead of a local fallback with different side bearings.
    const face = await a.page.evaluate(async () => {
      await document.fonts.ready;
      const body = getComputedStyle(document.body).fontFamily;
      return {
        loaded: document.fonts.check('13px "Stanze Sans"'),
        bold: document.fonts.check('bold 13px "Stanze Sans"'),
        family: body,
        families: [...document.fonts].map((f) => f.family + ':' + f.status),
      };
    });
    check('the page ships its own typeface', face.loaded && face.bold, JSON.stringify(face.families));
    check('the body uses the shipped typeface first', /Stanze Sans/.test(face.family), face.family);

    // Camera off on A.
    await a.page.click('#cam-btn');
    await sleep(1200);
    const ownOff = await tileOf(a.page, true);
    const seenOff = await tileOf(b.page, false);
    check('own tile leaves the playing state with the camera off', !ownOff.playing, JSON.stringify(ownOff));
    check('own centre name is visible with the camera off', ownOff.avatarDisplay !== 'none' && ownOff.avatar.length > 0,
      ownOff.avatarDisplay + ' "' + ownOff.avatar + '"');
    check('the centre label carries the whole name', ownOff.avatar.trim().toLowerCase() === 'alice', '"' + ownOff.avatar + '"');
    check('the other side sees the whole name of a camera that is off',
      seenOff.avatar.trim().toLowerCase() === 'alice', '"' + seenOff.avatar + '"');
    check('the other side sees the centre name of a camera that is off',
      seenOff.avatarDisplay !== 'none' && seenOff.avatar.length > 0,
      seenOff.avatarDisplay + ' "' + seenOff.avatar + '"');
    await a.page.screenshot({ path: OUT + '/tile-camera-off.png' });

    // Camera on again.
    await a.page.click('#cam-btn');
    await sleep(1500);
    const ownOn = await tileOf(a.page, true);
    const seenOn = await tileOf(b.page, false);
    check('own tile plays again after the camera comes back', ownOn.playing, JSON.stringify({ playing: ownOn.playing, videoW: ownOn.videoW }));
    check('own centre name hides again while the video plays',
      ownOn.avatarDisplay === 'none' || !ownOn.playing, ownOn.avatarDisplay);
    check('the other side hides the centre name again', seenOn.avatarDisplay === 'none' || !seenOn.playing,
      JSON.stringify({ display: seenOn.avatarDisplay, playing: seenOn.playing }));

    check('A page had no uncaught error', a.errors.length === 0, JSON.stringify(a.errors.slice(0, 3)));
    check('B page had no uncaught error', b.errors.length === 0, JSON.stringify(b.errors.slice(0, 3)));

    // The sealed code card: hidden until the pointer is over the tile.
    const codeNow = await b.page.evaluate(() => window.e2eApp.peers()[0].sas);
    const cardIdle = await tileOf(b.page, false);
    check('the code card has six drawings', cardIdle.sasImages.length === 6, cardIdle.sasImages.length);
    check('the code card is hidden while the pointer is away', !cardIdle.sasVisible, 'opacity ' + cardIdle.sasOpacity);
    check('the code card keeps the code of the pair',
      cardIdle.sasCode.replace(/\s+/g, '') === codeNow, cardIdle.sasCode + ' vs ' + codeNow);

    await b.page.hover('#grid > .tile:not([data-local])');
    await sleep(400);
    const cardHover = await tileOf(b.page, false);
    check('the code card shows on hover', cardHover.sasVisible, 'opacity ' + cardHover.sasOpacity);
    check('every drawing comes from the openmoji folder',
      cardHover.sasImages.every((i) => /^\/openmoji\/[0-9A-F]+\.svg$/.test(i.src)),
      JSON.stringify(cardHover.sasImages.map((i) => i.src)));
    check('every drawing decoded', cardHover.sasImages.every((i) => i.w > 0 && i.h > 0),
      JSON.stringify(cardHover.sasImages.map((i) => i.w + 'x' + i.h)));
    check('the drawings have a name for a screen reader',
      cardHover.sasImages.every((i) => i.alt && i.alt.length > 0),
      JSON.stringify(cardHover.sasImages.map((i) => i.alt)));
    const missing = await b.page.evaluate(() => fetch('/openmoji/0000.svg').then((r) => r.status));
    check('an unknown drawing is a 404', missing === 404, missing);
    await b.page.screenshot({ path: OUT + '/tile-code-hover.png' });
  } catch (err) {
    check('test completed without exception', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('RESULT: ' + (failed ? 'FAIL ' + failed : 'PASS') + ' (' + results.length + ' checks)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
