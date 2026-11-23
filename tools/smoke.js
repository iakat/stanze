/* Client smoke test: a real browser, a real join, and no silent faults.
 *
 * The point is the kind of fault that a normal element check misses: a script
 * that throws during the join, so nothing renders and nothing notices. Every
 * uncaught exception and every console error is fatal here, with the stack in
 * the output, and the process exits non zero.
 *
 * env: PW (path to playwright-core), ROOMSBASE, OUTDIR (optional)
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);
const { expectedMiss } = require('./expected-404');

const BASE = (process.env.ROOMSBASE || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const OUT = process.env.OUTDIR || '';
const TIMEOUT = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fatal = null;
function die(why) {
  if (!fatal) fatal = why;
  console.log('FAIL  ' + why);
}

function pass(name, detail) {
  console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : ''));
}

// attach is called before the first navigation, so no script of the page runs
// without these listeners in place.
function attach(page, who) {
  page.on('pageerror', (err) => {
    const stack = err && err.stack ? err.stack : String(err);
    const where = err && err.location ? ' at ' + err.location.url + ':' + err.location.lineNumber : '';
    die(who + ' uncaught exception: ' + (err && err.message ? err.message : String(err)) + where + '\n' + stack);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (expectedMiss(msg)) return;
    const at = msg.location ? msg.location() : null;
    const loc = at ? ' at ' + at.url + ':' + at.lineNumber : '';
    die(who + ' console error: ' + msg.text() + loc);
  });
}

async function until(page, fn, arg, label, timeout = TIMEOUT) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    if (fatal) throw new Error('stopped after: ' + fatal.split('\n')[0]);
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
}

async function join(page, name, room) {
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: TIMEOUT });
  await page.fill('#name', name);
  if (room) await page.fill('#room', room);
  await page.click('#enter-btn');
}

function newRoomID() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = require('crypto').randomBytes(26);
  let out = '';
  for (let i = 0; i < 26; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

(async () => {
  const room = newRoomID();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      // The sealed media path needs the script transform API.
      '--enable-features=RTCRtpScriptTransform',
    ],
  });
  const ctxA = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  attach(pageA, 'A');
  attach(pageB, 'B');

  try {
    // ---- fresh page, join with fake camera and microphone
    await pageA.goto(BASE + '/', { waitUntil: 'load', timeout: TIMEOUT });
    await until(pageA, () => state.wasmOk, null, 'the post-quantum module');
    await pageA.fill('#name', 'smoke');
    await pageA.fill('#room', room);
    await pageA.click('#enter-btn');

    await until(pageA, () => !document.getElementById('stage').hidden, null, 'the call stage');
    const joined = await until(pageA, () => {
      const own = document.querySelector('.tile[data-local="yes"]');
      const ws = state.ws;
      if (!own || !ws || ws.readyState !== 1) return null;
      return {
        socket: ws.url,
        ownTile: !!own.querySelector('video'),
        mic: !!state.micTrack,
        cam: !!state.camTrack,
        error: document.getElementById('stage-error').hidden ? '' : document.getElementById('stage-error').textContent,
      };
    }, null, 'an open socket and the own tile');
    pass('the socket opened on the page origin', joined.socket.indexOf(BASE.replace(/^http/, 'ws')) === 0, joined.socket);
    pass('the own tile is drawn with a live video', joined.ownTile);
    pass('the join brought camera and microphone', joined.mic && joined.cam, 'mic=' + joined.mic + ' cam=' + joined.cam);
    pass('the stage shows no error', joined.error === '', joined.error);

    // ---- chat
    const line = 'smoke line ' + Date.now();
    await pageA.fill('#chat-text', line);
    await pageA.press('#chat-text', 'Enter');
    await until(pageA, (text) => document.getElementById('chat-log').textContent.indexOf(text) >= 0, line, 'the chat line in the log');
    pass('a chat line reaches the log', true, line);

    // ---- microphone and camera toggles
    await pageA.click('#mic-btn');
    const off = await until(pageA, () => (document.getElementById('mic-btn').textContent === 'mic off' ? {
      text: document.getElementById('mic-btn').textContent,
      on: state.mic,
      gain: state.micGain ? state.micGain.gain.value : null,
    } : null), null, 'the microphone off');
    pass('the microphone toggles off', off.on === false && off.gain === 0, JSON.stringify(off));
    await pageA.click('#mic-btn');
    await until(pageA, () => document.getElementById('mic-btn').textContent === 'mic on', null, 'the microphone on');
    pass('the microphone toggles back on', true);

    await pageA.click('#cam-btn');
    const camOff = await until(pageA, () => (document.getElementById('cam-btn').textContent === 'camera off' ? {
      text: document.getElementById('cam-btn').textContent,
      on: state.cam,
      track: state.camTrack,
    } : null), null, 'the camera off');
    pass('the camera toggles off and stops the track', camOff.on === false && camOff.track === null, JSON.stringify(camOff));
    await pageA.click('#cam-btn');
    await until(pageA, () => document.getElementById('cam-btn').textContent === 'camera on', null, 'the camera on');
    pass('the camera toggles back on', true);

    // ---- stats panel
    await pageA.click('#stats-btn');
    const stats = await until(pageA, () => {
      const panel = document.getElementById('stats-panel');
      if (panel.hidden || !state.statsTimer) return null;
      return document.getElementById('stats-body').textContent;
    }, null, 'the stats panel');
    pass('the stats panel opens and polls', stats.length > 0, stats.slice(0, 80));
    await pageA.click('#stats-btn');

    // ---- a second peer in the same room, and one volume change
    await pageB.goto(BASE + '/#r=' + room, { waitUntil: 'load', timeout: TIMEOUT });
    await until(pageB, () => state.wasmOk, null, 'the post-quantum module on B');
    await pageB.fill('#name', 'smoke2');
    await pageB.click('#enter-btn');
    await until(pageA, () => [...state.peers.values()].some((p) => p.state === 'connected'), null, 'a connected remote peer');
    const vol = await pageA.evaluate(() => {
      const tile = document.querySelector('.tile[data-peer]');
      const range = tile ? tile.querySelector('.vol-range') : null;
      if (!range) return null;
      range.value = '175';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      const peer = [...state.peers.values()][0];
      return {
        label: tile.querySelector('.vol-num').textContent,
        gain: peer.gain ? peer.gain.gain.value : null,
      };
    });
    pass('a remote tile volume can be changed', vol && vol.label === '175%' && Math.abs(vol.gain - 1.75) < 1e-6, JSON.stringify(vol));

    // ---- leave
    await pageA.click('#leave-btn');
    await until(pageA, () => !document.getElementById('lobby').hidden, null, 'the lobby after leave');
    pass('leave returns to the lobby', true);

    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      await pageA.screenshot({ path: OUT + '/smoke-a.png' }).catch(() => {});
    }
  } catch (e) {
    die('test stopped: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (fatal) {
    console.log('RESULT: FAIL');
    console.log('first fault:\n' + fatal);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})();
