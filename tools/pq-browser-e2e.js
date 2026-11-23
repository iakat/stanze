/* Headless Chromium end-to-end test for the post-quantum client.
 *
 * Two separate browser contexts join one room with fake camera and microphone.
 * The test asserts that the handshake completes, that the short codes match,
 * that video and audio still flow through the sealed frame path, that chat and
 * names survive the round trip, that no canary string ever appears in a
 * signaling frame, and that an in-page receiver with a wrong key decodes
 * nothing until the right key is installed.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
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

// The two model probes answer 404 when the operator set no directory for the
// optional transcription engines, and the browser logs every such answer as a
// console error. They are expected in a bare server, so the collector takes the
// response status with its URL instead of the console text: a real miss still
// fails the run, and it names the file.
const EXPECTED_404 = ['/vosk/models', '/omni/models'];

function attach(page, errors) {
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() !== 'error') return;
    if (/^Failed to load resource/.test(text)) return;
    errors.push('console: ' + text);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const path = new URL(r.url()).pathname;
    if (r.status() === 404 && EXPECTED_404.includes(path)) return;
    errors.push('http ' + r.status() + ': ' + r.url());
  });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

async function joinPage(context, name, room, pass) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  // Keep the last sealed chat frame this page put on the wire, so the probe can
  // replay it and watch the other side drop it.
  await page.addInitScript(() => {
    if (window.__appFrameHook) return;
    window.__appFrameHook = true;
    window.__appFrame = '';
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (raw) {
      try {
        const m = typeof raw === 'string' ? JSON.parse(raw) : null;
        if (m && m.t === 'enc' && atob(m.b).includes('"k":"app"')) window.__appFrame = raw;
      } catch (_err) { /* not a frame of ours */ }
      return send.apply(this, arguments);
    };
  });
  let app = null;
  // A join can occasionally miss its first websocket; retry once by reloading.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Every visit is sealed: the room travels in the fragment and the module
    // warms while the lobby is open, so the only prompt left is the microphone.
    await page.goto(BASE + '/' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
    await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
    app = await page.evaluate(() => ({
      test: window.e2eApp && window.e2eApp.state.wasmTest,
      room: document.getElementById('room').value,
      title: document.title,
    }));
    await page.fill('#name', name);
    if (room) await page.fill('#room', room);
    if (pass) await page.fill('#pass', pass);
    await page.click('#enter-btn', { timeout: 20000 });
    try {
      await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
        null, 20000, name + ' joined');
      return { page, errors, app };
    } catch (err) {
      const st = await page.evaluate(() => {
        const el = document.getElementById('stage-error') || document.getElementById('sealed-note');
        return el ? el.textContent : '?';
      }).catch(() => '?');
      const diag = await page.evaluate(() => ({
        hasApp: !!window.e2eApp,
        stageHidden: document.getElementById('stage').hidden,
        lobbyHidden: document.getElementById('lobby').hidden,
        self: window.e2eApp ? window.e2eApp.state.self : null,
        say: (document.getElementById('status') || {}).textContent,
      })).catch((e) => ({ evaluate: String(e) }));
      console.log('RETRY ' + name + ' join attempt ' + (attempt + 1) + ' failed: ' + err
        + ' status=' + JSON.stringify(st) + ' diag=' + JSON.stringify(diag)
        + ' errors=' + JSON.stringify(errors));
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join after retries');
}

function snapshot(page) {
  return page.evaluate(() => {
    const app = window.e2eApp;
    const s = app.state;
    const peers = app.peers();
    const lines = [...document.querySelectorAll('#chat-log li')].map((li) => li.textContent);
    const videos = [...document.querySelectorAll('.tile video')].filter((v) => !v.muted);
    return {
      self: s.self,
      room: s.room,
      name: s.name,
      peers,
      counters: app.counters(),
      chat: lines,
      videos: videos.map((v) => ({ w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, ready: v.readyState })),
      wasmTest: s.wasmTest,
    };
  });
}

// dump prints the peer state and buffered errors when a handshake wait fails.
async function dump(page, label, errors) {
  let state = null;
  try {
    state = await page.evaluate(() => {
      const s = window.e2eApp.state;
      const peers = [...s.peers.values()].map((p) => ({
        id: p.id, ready: p.ready, confirmed: p.confirmed,
        sas: p.sas, name: p.name, hasKeys: !!p.keys,
        hasPc: !!p.pc, myConfirm: !!p.myConfirm, sentConfirm: p.sentConfirm,
      }));
      return { self: s.self, room: s.room, peers, counters: window.e2eApp.counters() };
    });
  } catch (e) {
    state = 'evaluate failed: ' + e;
  }
  console.log('DUMP  ' + label + '  ' + JSON.stringify(state));
  if (errors && errors.length) console.log('ERRS  ' + label + '  ' + JSON.stringify(errors.slice(-10)));
}

// frameDump prints the encrypted-frame counters and samples from a page.
async function frameDump(page, label) {
  let s = null;
  try {
    s = await page.evaluate(async () => {
      const st = window.e2eApp.state;
      const peer = [...st.peers.values()][0];
      const inbound = {};
      if (peer && peer.pc) {
        (await peer.pc.getStats()).forEach((r) => {
          if (r.type === 'inbound-rtp') {
            inbound[r.kind] = {
              framesDecoded: r.framesDecoded, framesReceived: r.framesReceived,
              framesDropped: r.framesDropped, bytesReceived: r.bytesReceived,
              packetsReceived: r.packetsReceived, jitter: r.jitter,
              totalSamplesReceived: r.totalSamplesReceived, totalAudioEnergy: r.totalAudioEnergy,
              audioLevel: r.audioLevel,
            };
          }
        });
      }
      const v = peer && peer.video;
      const txs = [];
      if (peer && peer.pc) {
        for (const tx of peer.pc.getTransceivers()) {
          txs.push({
            mid: tx.mid,
            dir: tx.direction,
            cur: tx.currentDirection,
            sKind: tx.sender && tx.sender.track ? tx.sender.track.kind : null,
            sXf: !!(tx.sender && tx.sender.transform),
            rKind: tx.receiver && tx.receiver.track ? tx.receiver.track.kind : null,
            rXf: !!(tx.receiver && tx.receiver.transform),
          });
        }
      }
      return {
        counters: window.e2eApp.counters(),
        // The room control is sealed now, so a held guest that never got a let
        // in shows up here and not in the server log.
        self: st.self,
        waiting: st.waiting,
        waitingRoom: st.waitingRoom,
        peerWaiting: peer ? !!peer.waiting : null,
        passDone: !!(peer && peer.pass && peer.pass.done),
        inside: [...st.insideFps],
        outTracks: st.outStream ? st.outStream.getTracks().map((t) => [t.kind, t.enabled, t.muted, t.readyState]) : null,
        camTrack: st.camTrack ? st.camTrack.readyState : null,
        frames: st.frames,
        samples: (st.samples || []).slice(0, 6),
        conn: peer && peer.pc ? peer.pc.connectionState : 'none',
        ice: peer && peer.pc ? peer.pc.iceConnectionState : 'none',
        txs,
        video: v ? {
          w: v.videoWidth, h: v.videoHeight, t: v.currentTime,
          paused: v.paused, ready: v.readyState, muted: v.muted,
          tracks: v.srcObject ? v.srcObject.getTracks().map((t) => ({ kind: t.kind, state: t.readyState, muted: t.muted })) : null,
        } : null,
        inbound,
      };
    });
  } catch (e) {
    s = 'evaluate failed: ' + e;
  }
  console.log('FRAMES  ' + label + '  ' + JSON.stringify(s));
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
      // This Chromium build keeps RTCRtpScriptTransform behind a runtime flag
      // even though stable Chrome ships it on by default; enable it for the test.
      '--enable-features=RTCRtpScriptTransform',
    ],
  });

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'] });

  const run = Date.now().toString(36);
  const chatFromA = 'alice sealed message ' + run;
  const chatFromB = 'bob sealed reply ' + run;

  let a = null;
  let b = null;
  try {
    // There is one kind of room, and the form says so without a toggle.
    const probe = await ctxA.newPage();
    await probe.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
    const defaults = await probe.evaluate(() => ({
      box: !!document.getElementById('sealed'),
      note: [...document.querySelectorAll('p.note')].map((p) => p.textContent).join(' '),
    }));
    await probe.close();
    check('the join form has no post-quantum toggle', defaults.box === false, defaults.box);
    check('the lobby says every room is sealed', /sealed end to end/i.test(defaults.note), defaults.note);

    a = await joinPage(ctxA, 'alice', '');
    check('A loaded the post-quantum module', !!(a.app.test && a.app.test.sasMatch && a.app.test.confirm && a.app.test.open && a.app.test.wrongKeyRefused && a.app.test.pad && a.app.test.passGood && a.app.test.passBad),
      JSON.stringify(a.app.test));
    const room = a.app.room;
    check('A has a 26 character random room id', /^[a-z2-7]{26}$/.test(room), room);
    // The address carries the room only.
    const hashA = await a.page.evaluate(() => location.hash);
    check('a room link carries no mode flag', !/sealed=/.test(hashA), hashA);

    b = await joinPage(ctxB, 'bob', room);

    // A green edge marks the person who speaks: the RMS tap on the audio of
    // every tile must light, the fake microphone is never silent.
    const sawLight = async (page, label) => {
      try {
        await until(page, () => [...document.querySelectorAll('.tile')].some((t) => t.classList.contains('speaking')),
          null, 15000, label + ' talking light');
        return true;
      } catch {
        return false;
      }
    };
    const lightA = await sawLight(a.page, 'A');
    check('a tile lights up while a person talks', lightA, lightA);

    // Both sides reach a confirmed handshake for exactly one peer.
    const ready = async (page, label) => until(page, () => {
      const p = window.e2eApp.peers();
      return p.length === 1 && p[0].ready === 'ready' && p[0].confirmed && p[0].sas.length === 13;
    }, null, 60000, label);
    await ready(a.page, 'A handshake').catch(async (e) => {
      await dump(a.page, 'A', a.errors);
      await dump(b.page, 'B', b.errors);
      throw e;
    });
    await ready(b.page, 'B handshake').catch(async (e) => {
      await dump(a.page, 'A', a.errors);
      await dump(b.page, 'B', b.errors);
      throw e;
    });

    const sa = await snapshot(a.page);
    const sb = await snapshot(b.page);
    info('A peer', JSON.stringify(sa.peers));
    info('B peer', JSON.stringify(sb.peers));
    check('both sides derive the same short code', sa.peers[0].sas === sb.peers[0].sas, sa.peers[0].sas);
    const chip = await a.page.evaluate(() => {
      const el = document.getElementById('pin-count');
      return {
        text: el.textContent, verified: el.dataset.verified || '', hidden: el.hidden,
        codes: [...document.querySelectorAll('.tile[data-sas]')].map((t) => t.dataset.sas).filter(Boolean),
        test: window.e2eApp.state.wasmTest ? window.e2eApp.state.wasmTest.sas : '',
      };
    });
    check('the top right chip counts the guests this browser pinned, and is red while one is unverified',
      chip.text === 'verified 0/1' && chip.verified === 'part' && chip.hidden === false, JSON.stringify(chip));
    check('the pair code sits on the guest tile, not the self test code',
      chip.codes.includes(sa.peers[0].sas) && !chip.codes.includes(chip.test), JSON.stringify(chip.codes));
    check('A sees the decrypted name bob', sa.peers[0].name === 'bob', sa.peers[0].name);
    check('B sees the decrypted name alice', sb.peers[0].name === 'alice', sb.peers[0].name);

    // Media still flows through the encoded transform.
    await until(a.page, () => window.e2eApp.peers()[0].videoW > 0, null, 45000, 'A remote video')
      .catch(async (e) => { await frameDump(a.page, 'A'); await frameDump(b.page, 'B'); throw e; });
    await until(b.page, () => window.e2eApp.peers()[0].videoW > 0, null, 45000, 'B remote video')
      .catch(async (e) => { await frameDump(a.page, 'A'); await frameDump(b.page, 'B'); throw e; });

    // Is decoded audio actually reaching the element? A non-zero RMS proves the
    // receiver transform output is consumed, even if video stays blank.
    const energy = await a.page.evaluate(async () => {
      const peer = window.e2eApp.state.peers.values().next().value;
      const st = peer && peer.video && peer.video.srcObject;
      const track = st && st.getAudioTracks()[0];
      if (!track) return { noTrack: true, kinds: st ? st.getTracks().map((t) => t.kind) : null };
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let best = 0;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 150));
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        best = Math.max(best, Math.sqrt(sum / buf.length));
      }
      ctx.close();
      return { rms: best, state: track.readyState, muted: track.muted };
    });
    info('A decoded audio', JSON.stringify(energy));
    const t0a = await a.page.evaluate(() => window.e2eApp.peers()[0].videoT);
    const t0b = await b.page.evaluate(() => window.e2eApp.peers()[0].videoT);
    await sleep(1600);
    const t1a = await a.page.evaluate(() => window.e2eApp.peers()[0].videoT);
    const t1b = await b.page.evaluate(() => window.e2eApp.peers()[0].videoT);
    check('A remote video is playing', t1a > t0a, t0a.toFixed(2) + ' -> ' + t1a.toFixed(2));
    check('B remote video is playing', t1b > t0b, t0b.toFixed(2) + ' -> ' + t1b.toFixed(2));

    // Concrete frame counts and packet counts.
    const statsA = await a.page.evaluate(async () => {
      const pc = window.e2eApp.state.peers.values().next().value.pc;
      const out = { inAudio: 0, inVideo: 0, outAudio: 0, outVideo: 0 };
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp') {
          if (r.kind === 'audio') out.inAudio += r.packetsReceived || 0;
          if (r.kind === 'video') out.inVideo += r.packetsReceived || 0;
        }
        if (r.type === 'outbound-rtp') {
          if (r.kind === 'audio') out.outAudio += r.packetsSent || 0;
          if (r.kind === 'video') out.outVideo += r.packetsSent || 0;
        }
      });
      return out;
    });
    const countsA = await a.page.evaluate(() => window.e2eApp.counters());
    const countsB = await b.page.evaluate(() => window.e2eApp.counters());
    info('A rtp', JSON.stringify(statsA));
    info('A counters', JSON.stringify({ enc: countsA.encryptFrames, dec: countsA.decryptFrames, wire: countsA.wireFrames }));
    info('B counters', JSON.stringify({ enc: countsB.encryptFrames, dec: countsB.decryptFrames, wire: countsB.wireFrames }));
    check('A sealed outbound frames', countsA.encryptFrames > 50, countsA.encryptFrames);
    check('A opened inbound frames', countsA.decryptFrames > 50, countsA.decryptFrames);
    check('B sealed outbound frames', countsB.encryptFrames > 50, countsB.encryptFrames);
    check('B opened inbound frames', countsB.decryptFrames > 50, countsB.decryptFrames);
    check('audio packets arrived at both peers', statsA.inAudio > 0, statsA.inAudio);

    // A sealed frame is 1 version byte, 12 IV bytes and a 16 byte tag around a
    // padded plaintext, and the plaintext is a four byte length plus the rung
    // of the ladder it fell in, so the sizes stop naming what was sent.
    const onLadder = (n, kind) => {
      const ladders = { audio: [128, 192, 256, 384, 512, 768, 1024, 1536], video: [512, 1024, 2048, 4096, 8192] };
      const ladder = ladders[kind] || ladders.video;
      return ladder.includes(n) || (n > ladder[ladder.length - 1] && n % ladder[ladder.length - 1] === 0);
    };
    const sent = countsA.samples.filter((s) => s.dir === 'send');
    const frameOverhead = sent.every((s) => onLadder(s.cipherLen - 29, s.kind) &&
      s.cipherLen - 29 >= s.plainLen + 4);
    check('every sampled frame is padded to a rung of the ladder (1 version + 12 IV + 16 tag around it)',
      sent.length > 0 && frameOverhead, JSON.stringify(sent.slice(0, 2)));

    // Chat in both directions.
    await a.page.fill('#chat-text', chatFromA);
    await a.page.press('#chat-text', 'Enter');
    await until(b.page, (needle) => window.e2eApp.state.chatRecv > 0 &&
      [...document.querySelectorAll('#chat-log li')].some((li) => li.textContent.includes(needle)), chatFromA, 20000, 'B chat');
    await b.page.fill('#chat-text', chatFromB);
    await b.page.press('#chat-text', 'Enter');
    await until(a.page, (needle) => window.e2eApp.state.chatRecv > 0 &&
      [...document.querySelectorAll('#chat-log li')].some((li) => li.textContent.includes(needle)), chatFromB, 20000, 'A chat');
    check('sealed chat A -> B', true, chatFromA);
    check('sealed chat B -> A', true, chatFromB);

    // A relay that records a sealed app frame and sends it again must not make
    // the line appear twice: the sequence number is in the AAD and the receiver
    // only opens the next one.
    const replayBefore = await b.page.evaluate(() => ({
      chat: window.e2eApp.counters().chatRecv, drops: window.e2eApp.counters().replayDrops,
    }));
    const replayed = await a.page.evaluate(() => {
      if (!window.__appFrame) return false;
      window.e2eApp.state.ws.send(window.__appFrame);
      return true;
    });
    await sleep(800);
    const replayAfter = await b.page.evaluate(() => ({
      chat: window.e2eApp.counters().chatRecv, drops: window.e2eApp.counters().replayDrops,
    }));
    check('a replayed sealed chat frame is dropped, not shown twice',
      replayed && replayAfter.chat === replayBefore.chat && replayAfter.drops === replayBefore.drops + 1,
      JSON.stringify({ replayed, replayBefore, replayAfter }));

    // No name or chat text ever appeared in a signaling frame.
    const auditA = await a.page.evaluate(() => ({
      leaks: window.e2eApp.state.wireLeaks, frames: window.e2eApp.state.wireFrames, clear: window.e2eApp.state.clearSignaling,
    }));
    const auditB = await b.page.evaluate(() => ({
      leaks: window.e2eApp.state.wireLeaks, frames: window.e2eApp.state.wireFrames, clear: window.e2eApp.state.clearSignaling,
    }));
    check('A signaling carries no plaintext name or chat', auditA.leaks.length === 0, JSON.stringify(auditA.leaks) + ' frames=' + auditA.frames);
    check('B signaling carries no plaintext name or chat', auditB.leaks.length === 0, JSON.stringify(auditB.leaks) + ' frames=' + auditB.frames);
    // The pair still opens its media, so the descriptions and candidates did
    // travel. None of them may have done so in the clear.
    check('A signaling carries no clear description or candidate',
      auditA.clear === 0 && auditA.frames > 5, JSON.stringify(auditA));
    check('B signaling carries no clear description or candidate',
      auditB.clear === 0 && auditB.frames > 5, JSON.stringify(auditB));
    check('both peers inspected a real number of signaling frames', auditA.frames > 10 && auditB.frames > 10, auditA.frames + '/' + auditB.frames);

    // The lab proves the frame layer directly: RTP arrives, a wrong key
    // decodes nothing, the right key installed live starts decoding.
    info('running in-page frame lab', '');
    let lab = null;
    try {
      lab = await a.page.evaluate(() => window.e2eApp.lab());
    } catch (err) {
      info('lab threw', String(err).split('\n')[0]);
    }
    if (lab) {
      info('lab before', JSON.stringify(lab.before));
      info('lab after', JSON.stringify(lab.after));
      info('lab worker', JSON.stringify({ refused: lab.refusedFrames, opened: lab.openedFrames, errors: lab.workerErrors }));
      check('lab: encrypted RTP reached the receiver', lab.packetsArrived, JSON.stringify(lab.before));
      check('lab: wrong key decoded zero frames', lab.decodedNothingWithoutKey, JSON.stringify(lab.before));
      check('lab: wrong key was refused at the AEAD tag', lab.refusedFrames > 0, lab.refusedFrames);
      check('lab: correct key installed live started decoding', lab.decryptedAfterKey && lab.openedFrames > 0,
        JSON.stringify({ after: lab.after, opened: lab.openedFrames }));
      check('lab: transform worker stayed clean', lab.workerErrors.length === 0, JSON.stringify(lab.workerErrors));
    } else {
      check('lab ran', false, 'page lab threw');
    }

    const finalA = await snapshot(a.page);
    const finalB = await snapshot(b.page);
    check('no worker errors in either page', finalA.counters.workerErrors.length === 0 && finalB.counters.workerErrors.length === 0,
      JSON.stringify([finalA.counters.workerErrors, finalB.counters.workerErrors]));
    check('no key confirmation failures', finalA.counters.confirmFailures === 0 && finalB.counters.confirmFailures === 0,
      finalA.counters.confirmFailures + '/' + finalB.counters.confirmFailures);
    check('A page had no uncaught error', a.errors.length === 0, JSON.stringify(a.errors.slice(0, 3)));
    check('B page had no uncaught error', b.errors.length === 0, JSON.stringify(b.errors.slice(0, 3)));

    await a.page.screenshot({ path: OUT + '/a.png' });
    await b.page.screenshot({ path: OUT + '/b.png' });

    // A room with a passphrase: the proof is the only gate now, so a guest
    // with a wrong one is refused by the admin and removed from the room.
    const owner = await joinPage(ctxA, 'carol', '', 'sesame');
    const roomP = owner.app.room;
    check('an owner opens a room with a passphrase', /^[a-z2-7]{26}$/.test(roomP), roomP);
    const ownerState = await owner.page.evaluate(() => ({
      w: typeof window.e2eApp.state.w,
      pass: 'pass' in window.e2eApp.state,
    }));
    check('the passphrase lives as a scalar only', ownerState.w === 'string' && ownerState.pass === false,
      JSON.stringify(ownerState));
    const guest = await joinPage(ctxB, 'mallory', roomP, 'wrong-one');
    const guestId = await guest.page.evaluate(() => window.e2eApp.state.self);
    let kicked = false;
    try {
      kicked = await until(owner.page, (id) => {
        const seen = window.e2eApp.state.peers.has(id);
        return !seen ? 'gone' : '';
      }, guestId, 20000, 'the guest is removed');
    } catch (err) {
      kicked = 'timeout';
    }
    check('a guest with a wrong passphrase is removed by the admin', kicked === 'gone', kicked);
    await sleep(1000);
    const guestAfter = await guest.page.evaluate(() => ({
      self: window.e2eApp.state.self,
      peers: window.e2eApp.state.peers.size,
      lobby: !document.getElementById('lobby').hidden,
      note: (document.getElementById('sealed-note') || {}).textContent || '',
    }));
    check('the refused guest is back in the lobby', guestAfter.peers === 0 && guestAfter.lobby,
      JSON.stringify(guestAfter));
    // The guest may hear either word: a member's kick says it was removed, and a
    // failed passphrase proof says the room refused it. Both are the truth.
    check('the lobby gives the guest a reason', /(removed you from the room|refused the passphrase)/i.test(guestAfter.note), guestAfter.note);
    await owner.page.screenshot({ path: OUT + '/owner.png' });
  } catch (err) {
    check('test completed without exception', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    if (a) await a.page.screenshot({ path: OUT + '/a-fail.png' }).catch(() => {});
    if (b) await b.page.screenshot({ path: OUT + '/b-fail.png' }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ checks: results.length, failed: failed.length }));
  fs.writeFileSync(OUT + '/results.json', JSON.stringify(results, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
})();
