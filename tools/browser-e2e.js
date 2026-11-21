/* Headless Chromium end-to-end test for the rooms client (short-lived Job).
 *
 * A and B are separate browser contexts (separate users). A creates a room,
 * B joins it, and the test asserts the real media path plus the privacy rules
 * from inside the browser.
 *
 * env: PW (path to playwright-core), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
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

// page.waitForFunction() evaluates its predicate with eval(), which a strict
// CSP (script-src 'self') rightly blocks. Poll with page.evaluate instead.
async function until(page, fn, arg, timeout = 60000, label = '') {
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
  throw new Error('timeout waiting for ' + (label || fn.toString().slice(0, 60)) + ' (last=' + JSON.stringify(last) + ')');
}

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push('console: ' + m.text());
      console.log('CONSOLE ' + m.text());
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

// Visible state of the page: tiles, remote and local video elements.
function snapshot() {
  const tiles = [...document.querySelectorAll('.tile')];
  const remotes = tiles.filter((t) => {
    const v = t.querySelector('video');
    return v && !v.muted;
  });
  const locals = [...document.querySelectorAll('.tile video[muted]')];
  return {
    tiles: tiles.length,
    remotes: remotes.map((t) => {
      const v = t.querySelector('video');
      return {
        w: v.videoWidth,
        h: v.videoHeight,
        t: v.currentTime,
        paused: v.paused,
        readyState: v.readyState,
        state: t.dataset.state,
        badge: t.querySelector('.state').textContent.trim(),
        relay: t.dataset.relay || '',
      };
    }),
    locals: locals.map((v) => ({
      w: v.videoWidth,
      h: v.videoHeight,
      paused: v.paused,
      readyState: v.readyState,
      tracks: v.srcObject ? v.srcObject.getTracks().map((t) => t.kind + ':' + t.readyState + ':' + t.enabled) : [],
    })),
  };
}

// Peer connection stats read from the page's own state object.
async function stats(page) {
  return page.evaluate(async () => {
    try {
      const peers = [...state.peers.values()];
      if (!peers.length || !peers[0].pc) return null;
      const pc = peers[0].pc;
      const report = await pc.getStats();
      const acc = { audioIn: 0, audioOut: 0, videoIn: 0, videoOut: 0, bytes: 0 };
      report.forEach((r) => {
        if (r.type === 'inbound-rtp') {
          if (r.kind === 'audio') acc.audioIn += r.packetsReceived || 0;
          if (r.kind === 'video') acc.videoIn += r.packetsReceived || 0;
        }
        if (r.type === 'outbound-rtp') {
          if (r.kind === 'audio') acc.audioOut += r.packetsSent || 0;
          if (r.kind === 'video') acc.videoOut += r.packetsSent || 0;
        }
      });

      // Selected ICE pair: transport -> candidate-pair -> local/remote candidate.
      const pairs = new Map();
      const cands = new Map();
      let pairId = null;
      report.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'candidate-pair') pairs.set(r.id, r);
        if (r.type === 'candidate' || r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r);
      });
      if (!pairId) {
        for (const [id, p] of pairs) {
          if (p.selected || p.state === 'succeeded') pairId = id;
        }
      }
      const pair = pairId ? pairs.get(pairId) : null;
      const local = pair ? cands.get(pair.localCandidateId) : null;
      const remote = pair ? cands.get(pair.remoteCandidateId) : null;

      return {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        signaling: pc.signalingState,
        audioIn: acc.audioIn,
        audioOut: acc.audioOut,
        videoIn: acc.videoIn,
        videoOut: acc.videoOut,
        peers: peers.length,
        pair: pair
          ? {
              local: local ? (local.candidateType || local.type) : '?',
              remote: remote ? (remote.candidateType || remote.type) : '?',
              protocol: local ? local.protocol : '?',
              address: local ? (local.address || local.ip) + ':' + local.port : '?',
            }
          : null,
      };
    } catch (e) {
      return { error: String(e) };
    }
  });
}

(async () => {
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const errorsA = [];
  const errorsB = [];
  const ctxA = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['camera', 'microphone'],
  });
  const ctxB = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['camera', 'microphone'],
  });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  attach(pageA, errorsA);
  attach(pageB, errorsB);

  let room = '';
  let fatal = null;
  try {
    // ---- A creates the room (empty room field => new room)
    await pageA.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
    const lobby = await pageA.evaluate(() => {
      const btn = document.getElementById('enter-btn');
      const form = document.getElementById('join-form');
      const box = btn ? btn.getBoundingClientRect() : null;
      return {
        url: location.href,
        title: document.title,
        ready: document.readyState,
        hasForm: !!form,
        buttons: document.querySelectorAll('button').length,
        enter: btn ? { visible: !!(btn.offsetWidth || btn.offsetHeight), disabled: btn.disabled, box: box && [box.x, box.y, box.width, box.height] } : null,
      };
    });
    info('A lobby', JSON.stringify(lobby));
    check('lobby offers the enter form', !!lobby.hasForm && !!lobby.enter && lobby.enter.visible, JSON.stringify(lobby.enter || {}));
    await pageA.fill('#name', 'alice');
    await pageA.click('#enter-btn', { timeout: 20000 });
    await until(pageA, () => /^#r=[a-z2-7]{26}$/.test(location.hash), null, 30000, 'room hash');
    room = await pageA.evaluate(() => location.hash.replace('#r=', ''));
    check('A created a room (128 bit base32 id)', /^[a-z2-7]{26}$/.test(room), 'len=' + room.length);

    await until(pageA, () => document.querySelectorAll('.tile').length >= 1, null, 30000, 'A local tile');
    const localA = await pageA.evaluate(snapshot);
    check('A getUserMedia produced a live local preview', localA.locals.length === 1 && localA.locals[0].w > 0 && !localA.locals[0].paused,
      JSON.stringify(localA.locals[0] || {}));

    // ---- B joins the same room through the shared link
    await pageB.goto(BASE + '/#r=' + room, { waitUntil: 'load', timeout: 60000 });
    const prefilled = await pageB.evaluate(() => document.getElementById('room').value);
    check('B lobby prefills the room from the link', prefilled === room, prefilled);
    await pageB.fill('#name', 'bob');
    await pageB.click('#enter-btn');
    await until(pageB, () => !document.getElementById('stage').hidden, null, 30000, 'B stage visible');

    // ---- both sides end up with two tiles and a connected remote
    // connected is not enough: require the first decoded frame on the remote tile
    const bothTiles = () => {
      const t = [...document.querySelectorAll('.tile')];
      return t.length === 2 && t.some((x) => {
        const v = x.querySelector('video');
        return x.dataset.state === 'connected' && !v.muted && v.videoWidth > 0;
      });
    };
    await until(pageA, bothTiles, null, 60000, 'A remote peer connected');
    await until(pageB, bothTiles, null, 60000, 'B remote peer connected');

    check('A shows 2 tiles', (await pageA.evaluate(snapshot)).tiles === 2);
    check('B shows 2 tiles', (await pageB.evaluate(snapshot)).tiles === 2);

    const snapA1 = await pageA.evaluate(snapshot);
    const snapB1 = await pageB.evaluate(snapshot);
    const remoteA = snapA1.remotes[0] || {};
    const remoteB = snapB1.remotes[0] || {};

    const namesA = await pageA.evaluate(() => [...document.querySelectorAll('.tile:not(:has(video[muted])) .name')].map((n) => n.textContent.trim()));
    const namesB = await pageB.evaluate(() => [...document.querySelectorAll('.tile:not(:has(video[muted])) .name')].map((n) => n.textContent.trim()));
    check('A sees B under the joined name', namesA[0] === 'bob', JSON.stringify(namesA));
    check('B sees A under the joined name', namesB[0] === 'alice', JSON.stringify(namesB));

    check('A remote tile reports connected', remoteA.state === 'connected', remoteA.badge || '');
    check('B remote tile reports connected', remoteB.state === 'connected', remoteB.badge || '');

    check('A remote video has decoded frames (videoWidth>0)', remoteA.w > 0 && remoteA.h > 0, remoteA.w + 'x' + remoteA.h);
    check('B remote video has decoded frames (videoWidth>0)', remoteB.w > 0 && remoteB.h > 0, remoteB.w + 'x' + remoteB.h);

    // ---- playhead must advance: proves media is flowing, not a frozen poster
    await sleep(1500);
    const snapA2 = await pageA.evaluate(snapshot);
    const snapB2 = await pageB.evaluate(snapshot);
    const a2 = snapA2.remotes[0] || {};
    const b2 = snapB2.remotes[0] || {};
    check('A remote currentTime advances', a2.t > (remoteA.t || 0) + 0.2, (remoteA.t || 0).toFixed(2) + ' -> ' + (a2.t || 0).toFixed(2));
    check('B remote currentTime advances', b2.t > (remoteB.t || 0) + 0.2, (remoteB.t || 0).toFixed(2) + ' -> ' + (b2.t || 0).toFixed(2));
    check('A remote video is playing', a2.paused === false, 'paused=' + a2.paused + ' readyState=' + a2.readyState);
    check('B remote video is playing', b2.paused === false, 'paused=' + b2.paused + ' readyState=' + b2.readyState);

    // ---- track level assertions through the page state
    const stA = await stats(pageA);
    const stB = await stats(pageB);
    if (stA && !stA.error && stB && !stB.error) {
      check('A peer connection is connected', stA.connection === 'connected', JSON.stringify(stA));
      check('B peer connection is connected', stB.connection === 'connected', JSON.stringify(stB));
      check('audio packets arrive at A', stA.audioIn > 0, 'audioIn=' + stA.audioIn + ' videoIn=' + stA.videoIn);
      check('audio packets arrive at B', stB.audioIn > 0, 'audioIn=' + stB.audioIn + ' videoIn=' + stB.videoIn);
      check('video packets arrive at A', stA.videoIn > 0, 'videoIn=' + stA.videoIn);
      check('video packets arrive at B', stB.videoIn > 0, 'videoIn=' + stB.videoIn);
      info('selected ICE pair A', stA.pair ? stA.pair.local + ' <- ' + stA.pair.remote + ' over ' + stA.pair.protocol + ' at ' + stA.pair.address : 'unavailable');
      info('selected ICE pair B', stB.pair ? stB.pair.local + ' <- ' + stB.pair.remote + ' over ' + stB.pair.protocol + ' at ' + stB.pair.address : 'unavailable');
    } else {
      info('peer connection stats unavailable from page state', JSON.stringify({ stA, stB }));
    }

    // ---- signaling must ride the page's own origin (wss behind TLS)
    const wsA = await pageA.evaluate(() => ({ url: state.ws ? state.ws.url : '', open: !!(state.ws && state.ws.readyState === 1) }));
    const wsB = await pageB.evaluate(() => ({ url: state.ws ? state.ws.url : '', open: !!(state.ws && state.ws.readyState === 1) }));
    check('A signaling socket is wss and open', wsA.open && /^wss:\/\//.test(wsA.url), wsA.url);
    check('B signaling socket is wss and open', wsB.open && /^wss:\/\//.test(wsB.url), wsB.url);

    // ---- mute / camera toggles flip the local track and the UI
    await pageA.click('#mic-btn');
    await pageA.click('#cam-btn');
    const toggled = await pageA.evaluate(() => {
      const v = document.querySelector('.tile video[muted]');
      const tracks = v.srcObject.getTracks().map((t) => t.kind + '=' + t.enabled);
      return {
        tracks,
        micBtn: document.getElementById('mic-btn').textContent,
        camBtn: document.getElementById('cam-btn').textContent,
      };
    });
    check('mic toggle disables the audio track', toggled.tracks.includes('audio=false') && /off/.test(toggled.micBtn),
      toggled.tracks.join(',') + ' buttons=' + toggled.micBtn + '/' + toggled.camBtn);
    check('camera toggle disables the video track', toggled.tracks.includes('video=false') && /off/.test(toggled.camBtn),
      toggled.tracks.join(','));
    await pageA.click('#mic-btn');
    await pageA.click('#cam-btn');

    // ---- CSP / console hygiene (before the deliberate 404 probe below)
    check('no console or page errors in A', errorsA.length === 0, errorsA.slice(0, 3).join(' | '));
    check('no console or page errors in B', errorsB.length === 0, errorsB.slice(0, 3).join(' | '));

    // ---- no route leaks rooms, checked from the browser itself
    const probe = await pageA.evaluate(async (id) => {
      const out = {};
      for (const path of ['/rooms', '/api/rooms', '/api/rooms/list', '/metrics', '/debug', '/status']) {
        try {
          const res = await fetch(path, { cache: 'no-store' });
          const text = await res.text();
          out[path] = { status: res.status, len: text.length, hasRoom: text.includes(id) };
        } catch (e) {
          out[path] = { error: String(e) };
        }
      }
      return out;
    }, room);
    const bad = Object.entries(probe).filter(([, v]) => v.status !== 404);
    check('all room-listing paths 404 from the browser', bad.length === 0, JSON.stringify(probe));
    const leak = Object.entries(probe).filter(([, v]) => v.hasRoom);
    check('no response body contains the room id', leak.length === 0, leak.map(([k]) => k).join(',') || 'clean');

    // ---- screenshots
    const shots = [];
    for (const [page, label] of [[pageA, 'a'], [pageB, 'b']]) {
      const tmp = '/tmp/' + label + '.png';
      await page.screenshot({ path: tmp });
      const size = fs.statSync(tmp).size;
      fs.mkdirSync(OUT, { recursive: true });
      const kept = OUT + '/' + label + '.png';
      fs.copyFileSync(tmp, kept);
      console.log('SHOT  ' + label.toUpperCase() + ': ' + tmp + ' (' + size + ' bytes) -> ' + kept + ' (' + fs.statSync(kept).size + ' bytes)');
      shots.push({ label, tmp, size, kept });
    }
    check('screenshots captured', shots.length === 2 && shots.every((s) => s.size > 5000), shots.map((s) => s.label + '=' + s.size + 'B').join(' '));
  } catch (e) {
    fatal = String(e);
    console.log('FATAL ' + fatal);
    for (const [page, label] of [[pageA, 'a'], [pageB, 'b']]) {
      try {
        await page.screenshot({ path: '/tmp/fail-' + label + '.png' });
        console.log('SHOT  fail-' + label + ': /tmp/fail-' + label + '.png (' + fs.statSync('/tmp/fail-' + label + '.png').size + ' bytes)');
        fs.mkdirSync(OUT, { recursive: true });
        fs.copyFileSync('/tmp/fail-' + label + '.png', OUT + '/' + label + '.png');
      } catch (_) {}
    }
  } finally {
    try {
      const finalA = await pageA.evaluate(snapshot).catch(() => null);
      info('final A snapshot', JSON.stringify(finalA));
      const finalB = await pageB.evaluate(snapshot).catch(() => null);
      info('final B snapshot', JSON.stringify(finalB));
    } catch (_) {}
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length === 0 && !fatal
    ? 'RESULT: PASS (' + results.length + ' checks)'
    : 'RESULT: FAIL (' + failed.length + ' of ' + results.length + ' checks' + (fatal ? ', fatal' : '') + ')');
  if (failed.length || fatal) process.exitCode = 1;
})();
