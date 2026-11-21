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
  return { page, errors };
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
    return {
      name: tile.querySelector('.name') ? tile.querySelector('.name').textContent : '',
      avatar: avatar ? avatar.textContent : '',
      avatarDisplay: avatar ? getComputedStyle(avatar).display : 'none',
      sasText: sas && !sas.hidden ? sas.textContent.trim() : '',
      sasOpacity: sas ? Number(getComputedStyle(sas).opacity) : 0,
      sasVisible: sas ? (sas.hidden ? false : getComputedStyle(sas).visibility !== 'hidden') : false,
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
    b = await joinPage(ctxB, 'bob', '');
    await until(a.page, () => window.e2eApp.state.peers.size === 1, null, 30000, 'A sees one peer');
    await until(b.page, () => window.e2eApp.state.peers.size === 1, null, 30000, 'B sees one peer');
    await sleep(2500);

    const remoteA = await tileOf(a.page, false);
    const ownA = await tileOf(a.page, true);
    check('A remote tile plays the video of bob', remoteA.playing && remoteA.videoW > 0, remoteA.videoW);
    check('A own tile plays its own camera', ownA.playing, JSON.stringify({ playing: ownA.playing, videoW: ownA.videoW }));
    check('the tile keeps a readable name', /alice/.test(ownA.name), ownA.name);

    // Camera off on A.
    await a.page.click('#cam-btn');
    await sleep(1200);
    const ownOff = await tileOf(a.page, true);
    const seenOff = await tileOf(b.page, false);
    check('own tile leaves the playing state with the camera off', !ownOff.playing, JSON.stringify(ownOff));
    check('own centre name is visible with the camera off', ownOff.avatarDisplay !== 'none' && ownOff.avatar.length > 0,
      ownOff.avatarDisplay + ' "' + ownOff.avatar + '"');
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
  } catch (err) {
    check('test completed without exception', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('RESULT: ' + (failed ? 'FAIL ' + failed : 'PASS') + ' (' + results.length + ' checks)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
