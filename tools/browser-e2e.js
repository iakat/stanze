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

// Visible state of the page: tiles, remote and local video elements. Every
// remote video is muted because its audio goes through the peer gain node.
function snapshot() {
  const tiles = [...document.querySelectorAll('.tile')];
  const remotes = tiles.filter((t) => t.dataset.local !== 'yes');
  const locals = [...document.querySelectorAll('.tile[data-local="yes"] video')];
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
      // The sealed media path needs the script transform API.
      '--enable-features=RTCRtpScriptTransform',
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
    // The module warms while the lobby is open, so this waits before the join.
    await until(pageA, () => state.wasmOk, null, 60000, 'A pq module');
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

    // ---- join: the camera and the microphone are on from the first second
    await until(pageA, () => document.querySelectorAll('.tile').length >= 1, null, 30000, 'A local tile');
    // The tile is drawn before the device answer arrives, so wait for the join
    // to finish asking before reading the tracks.
    await until(pageA, () => state.micTrack && state.camTrack, null, 30000, 'A camera and microphone');
    const localA = await pageA.evaluate(snapshot);
    check('A getUserMedia produced a live local preview', localA.locals.length === 1 && localA.locals[0].w > 0 && !localA.locals[0].paused,
      JSON.stringify(localA.locals[0] || {}));

    const joinedA = await pageA.evaluate(() => {
      const local = document.querySelector('.tile[data-local="yes"]');
      const box = document.getElementById('stage-error');
      return {
        micTrack: state.micTrack ? state.micTrack.readyState + ':' + state.micTrack.enabled : 'none',
        camTrack: state.camTrack ? state.camTrack.readyState + ':' + state.camTrack.enabled : 'none',
        micBtn: document.getElementById('mic-btn').textContent,
        camBtn: document.getElementById('cam-btn').textContent,
        admins: state.admins instanceof Set,
        badge: local ? local.querySelector('.state').textContent : '',
        status: box && !box.hidden ? box.textContent : '',
      };
    });
    check('A joined with the microphone on', joinedA.micTrack === 'live:true' && /^mic on$/.test(joinedA.micBtn), JSON.stringify(joinedA));
    check('A joined with the camera on', joinedA.camTrack === 'live:true' && /^camera on$/.test(joinedA.camBtn), joinedA.camTrack);
    check('prepareLocal finished (role set, own badge, buttons painted)', joinedA.admins && joinedA.badge === 'you' && joinedA.status === '',
      JSON.stringify({ admins: joinedA.admins, badge: joinedA.badge, status: joinedA.status }));

    // ---- B joins the same room through the shared link
    await pageB.goto(BASE + '/#r=' + room, { waitUntil: 'load', timeout: 60000 });
    await until(pageB, () => state.wasmOk, null, 60000, 'B pq module');
    const prefilled = await pageB.evaluate(() => document.getElementById('room').value);
    check('B lobby prefills the room from the link', prefilled === room, prefilled);
    await pageB.fill('#name', 'bob');
    await pageB.click('#enter-btn');
    await until(pageB, () => !document.getElementById('stage').hidden, null, 30000, 'B stage visible');
    await until(pageB, () => state.micTrack && state.camTrack, null, 30000, 'B camera and microphone');
    check('B joins with the camera and the microphone on', true);

    // ---- both sides end up with two tiles and a connected remote
    // connected is not enough: require the first decoded frame on the remote tile
    const bothTiles = () => {
      const t = [...document.querySelectorAll('.tile')];
      return t.length === 2 && t.some((x) => {
        const v = x.querySelector('video');
        return x.dataset.local !== 'yes' && x.dataset.state === 'connected' && v.videoWidth > 0;
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

    const namesA = await pageA.evaluate(() => [...document.querySelectorAll('.tile[data-peer] .name')].map((n) => n.textContent.trim()));
    const namesB = await pageB.evaluate(() => [...document.querySelectorAll('.tile[data-peer] .name')].map((n) => n.textContent.trim()));
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

    // ---- signaling must ride the page's own origin (wss behind TLS, ws on
    // a plain http test server)
    const wsA = await pageA.evaluate(() => ({ url: state.ws ? state.ws.url : '', open: !!(state.ws && state.ws.readyState === 1) }));
    const wsB = await pageB.evaluate(() => ({ url: state.ws ? state.ws.url : '', open: !!(state.ws && state.ws.readyState === 1) }));
    const wsBase = BASE.replace(/^http/, 'ws').replace(/\/+$/, '');
    check('A signaling socket is open on the page origin', wsA.open && wsA.url.startsWith(wsBase), wsA.url + ' vs ' + wsBase);
    check('B signaling socket is open on the page origin', wsB.open && wsB.url.startsWith(wsBase), wsB.url + ' vs ' + wsBase);

    // ---- per peer volume: a 0..200 slider on the remote tile, routed through
    // a gain node, kept per peer name
    const vol = await pageA.evaluate(() => {
      const tile = document.querySelector('.tile[data-peer]');
      const range = tile.querySelector('.vol-range');
      const num = tile.querySelector('.vol-num');
      const peer = [...state.peers.values()][0];
      const set = (v) => {
        range.value = String(v);
        range.dispatchEvent(new Event('input', { bubbles: true }));
        return {
          gain: peer.gain ? peer.gain.gain.value : null,
          label: num.textContent,
          stored: localStorage.getItem('rooms.vol.' + peer.name),
        };
      };
      const snap = { normal: { gain: peer.gain ? peer.gain.gain.value : null, label: num.textContent }, name: peer.name };
      snap.zero = set(0);
      snap.loud = set(175);
      snap.kept = set(140);
      snap.max = range.max;
      snap.ownTile = !!document.querySelector('.tile[data-local="yes"] .vol-range');
      snap.ctx = state.playCtx ? state.playCtx.state : 'none';
      return snap;
    });
    check('a remote tile has a 0-200 volume slider at 100 percent', vol.max === '200' && vol.normal.gain === 1 && vol.normal.label === '100%',
      JSON.stringify(vol.normal) + ' max=' + vol.max);
    check('the own tile has no volume slider', vol.ownTile === false);
    check('volume 0 mutes that peer', vol.zero.gain === 0 && vol.zero.label === '0%' && vol.zero.stored === '0', JSON.stringify(vol.zero));
    check('volume 175 is a real boost above unity gain', Math.abs(vol.loud.gain - 1.75) < 1e-6 && vol.loud.label === '175%', JSON.stringify(vol.loud));
    check('the volume is kept per peer name', vol.kept.stored === '140' && vol.kept.label === '140%', JSON.stringify(vol.kept));
    check('remote audio runs through the playback graph', vol.ctx === 'running' || vol.ctx === 'suspended', vol.ctx);

    // ---- telemetry: a toolbar toggle and a panel that polls getStats
    await pageA.click('#stats-btn');
    await sleep(3000);
    const tel = await pageA.evaluate(() => {
      const body = document.getElementById('stats-body');
      return {
        open: !document.getElementById('stats-panel').hidden,
        timer: !!state.statsTimer,
        text: body ? body.textContent : '',
      };
    });
    check('the stats panel opens and polls once a second', tel.open && tel.timer, tel.text);
    check('stats show the peer, the round trip time and the path',
      tel.text.includes('bob') && /\d+ ms/.test(tel.text) && /(p2p|relay)/.test(tel.text), tel.text);
    check('stats show outbound and inbound bitrate for video and audio',
      /video [1-9]\d*\/[1-9]\d*/.test(tel.text) && /audio [1-9]\d*\/[1-9]\d*/.test(tel.text), tel.text);
    check('stats show the own rnnoise state and device settings',
      /rnnoise (on|off)/.test(tel.text) && /mic (on|off) \d+ kHz \d+ch/.test(tel.text) && /camera \d+x\d+/.test(tel.text), tel.text);
    const hiddenStop = await pageA.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      const timer = state.statsTimer;
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      return { hiddenTimer: timer, backTimer: !!state.statsTimer };
    });
    check('stats polling stops while the tab is hidden and comes back', hiddenStop.hiddenTimer === null && hiddenStop.backTimer,
      JSON.stringify(hiddenStop));
    await pageA.click('#stats-btn');
    const closedStats = await pageA.evaluate(() => ({
      hidden: document.getElementById('stats-panel').hidden,
      timer: state.statsTimer,
    }));
    check('stats polling stops when the panel is closed', closedStats.hidden && closedStats.timer === null, JSON.stringify(closedStats));

    // ---- mute / camera toggles flip the local track and the UI
    await pageA.click('#mic-btn');
    await pageA.click('#cam-btn');
    const toggled = await pageA.evaluate(() => ({
      // The microphone stays live and is muted on its gain, so a toggle never
      // has to reopen the device.
      micOn: state.mic,
      micGain: state.micGain ? state.micGain.gain.value : null,
      camTrack: state.camTrack,
      camLive: state.raw ? state.raw.getVideoTracks().filter((t) => t.readyState !== 'ended').length : 0,
      micBtn: document.getElementById('mic-btn').textContent,
      camBtn: document.getElementById('cam-btn').textContent,
      prefs: [localStorage.getItem('rooms.mic'), localStorage.getItem('rooms.cam')],
    }));
    check('mic toggle mutes the microphone and turns it off', toggled.micOn === false && toggled.micGain === 0 && /off/.test(toggled.micBtn),
      JSON.stringify(toggled));
    check('camera off stops the video track, so the camera light goes off',
      toggled.camTrack === null && toggled.camLive === 0 && /off/.test(toggled.camBtn), JSON.stringify(toggled));
    check('the toggles are remembered', toggled.prefs[0] === '0' && toggled.prefs[1] === '0', JSON.stringify(toggled.prefs));
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

    // ---- the lost connection cue: one calm loop, no stacking, seamless
    const cue = await pageA.evaluate(() => {
      const info = {};
      startLost();
      const src = state.lostSource;
      info.started = !!src;
      startLost();
      info.same = !!src && state.lostSource === src;
      info.loop = src ? src.loop : null;
      info.dur = src && src.buffer ? src.buffer.duration : null;
      info.channels = src && src.buffer ? src.buffer.numberOfChannels : null;
      info.rate = src && src.buffer ? src.buffer.sampleRate : null;
      if (src && src.buffer) {
        const d = src.buffer.getChannelData(0);
        const a = Math.round(src.loopStart * src.buffer.sampleRate);
        const b = Math.round(src.loopEnd * src.buffer.sampleRate);
        info.seam = Math.abs(d[a] - d[b - 1]);
        let local = 0;
        for (let i = a + 1; i < a + 2000; i++) local = Math.max(local, Math.abs(d[i] - d[i - 1]));
        info.local = local;
        info.window = Math.round((b - a) / src.buffer.sampleRate * 1000);
      }
      stopLost();
      info.stopped = state.lostSource === null;
      return info;
    });
    check('the lost connection cue is an 8 s loop of two soft chimes',
      cue.started && cue.loop === true && cue.dur >= 8 && cue.dur <= 9, JSON.stringify(cue));
    // Chromium decodes Opus at its own rate here, so only the mono shape and
    // the loop window are fixed expectations.
    check('the lost cue is a mono loop of the expected window', cue.channels === 1 && cue.window >= 7900 && cue.window <= 8100,
      cue.channels + 'ch ' + cue.rate + ' Hz, window ' + cue.window + ' ms');
    check('a second reconnect attempt does not stack a second cue', cue.same === true);
    check('the loop point is seamless (no step bigger than the waveform itself)',
      cue.seam <= cue.local, 'seam=' + cue.seam + ' local=' + cue.local);
    check('stopping the cue releases it', cue.stopped === true);

    await pageA.evaluate(() => { state.ws.close(); });
    const down = await until(pageA, () => (state.lostSource ? 'playing' : ''), null, 5000, 'lost cue');
    check('a lost connection starts the pad', down === 'playing');
    const recovered = await until(pageA, () => (state.ws && state.ws.readyState === 1 && !state.lostSource ? 'back' : ''),
      null, 60000, 'reconnect after the dropped socket');
    check('the pad stops as soon as the client is connected again', recovered === 'back');
    await until(pageA, () => [...state.peers.values()].some((p) => p.state === 'connected'), null, 60000, 'A reconnected to B');

    // ---- remembered choice: a camera off visit comes back with the camera off
    // and does not ask for it again
    await pageA.evaluate(() => { if (state.cam) disableCam(); });
    await pageA.addInitScript(() => {
      window.__gum = [];
      const md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) return;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (constraints) => {
        window.__gum.push(JSON.stringify(constraints));
        return orig(constraints);
      };
    });
    // A reload is what makes the stored choice load again; navigating to the
    // same fragment would only scroll.
    await pageA.reload({ waitUntil: 'load', timeout: 60000 });
    const restored = await pageA.evaluate(() => ({
      prefMic: state.prefMic,
      prefCam: state.prefCam,
      path: document.getElementById('path').value,
      room: document.getElementById('room').value,
      name: document.getElementById('name').value,
    }));
    check('the camera off choice is stored and comes back', restored.prefCam === false && restored.prefMic === true,
      JSON.stringify(restored));
    check('the room and the name still prefill', restored.room === room && restored.name === 'alice', JSON.stringify(restored));
    await pageA.click('#enter-btn');
    await until(pageA, () => [...state.peers.values()].some((p) => p.state === 'connected'), null, 60000, 'A rejoined the room');
    const rejoin = await pageA.evaluate(() => {
      const range = document.querySelector('.tile[data-peer] .vol-range');
      const peer = [...state.peers.values()][0];
      const box = document.getElementById('stage-error');
      return {
        gum: window.__gum,
        mic: state.micTrack ? state.micTrack.enabled : null,
        cam: state.camTrack ? state.camTrack.enabled : null,
        camBtn: document.getElementById('cam-btn').textContent,
        volume: range ? range.value : '',
        gain: peer && peer.gain ? peer.gain.gain.value : null,
        status: box && !box.hidden ? box.textContent : '',
      };
    });
    check('a camera off visit asks for the microphone only',
      rejoin.gum.length === 1 && /"audio"/.test(rejoin.gum[0]) && !/"video"/.test(rejoin.gum[0]), JSON.stringify(rejoin.gum));
    check('a camera off visit joins with the mic on and the camera off',
      rejoin.mic === true && rejoin.cam === null && /off/.test(rejoin.camBtn) && rejoin.status === '', JSON.stringify(rejoin));
    check('the per peer volume came back after the reload',
      rejoin.volume === '140' && Math.abs((rejoin.gain || 0) - 1.4) < 1e-6, rejoin.volume + ' gain=' + rejoin.gain);

    // ---- relay only path from the browser, over whatever this server speaks
    await pageA.click('#leave-btn');
    await until(pageA, () => !document.getElementById('lobby').hidden, null, 20000, 'A back in the lobby');
    await pageA.evaluate(() => {
      const pick = document.getElementById('path');
      pick.value = 'relay';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pageA.click('#enter-btn');
    await until(pageA, () => [...state.peers.values()].some((p) => p.state === 'connected'), null, 60000, 'A relayed to B');
    await pageA.click('#stats-btn');
    await sleep(2000);
    const relay = await pageA.evaluate(() => {
      const peer = [...state.peers.values()][0];
      const box = document.getElementById('stats-body');
      return { state: peer ? peer.state : '', text: box ? box.textContent : '' };
    });
    check('the relay only path works from the browser', /relay \(you\)/.test(relay.text), relay.text);
    await pageA.click('#stats-btn');

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
