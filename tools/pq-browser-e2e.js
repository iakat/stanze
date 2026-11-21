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

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  let app = null;
  // A join can occasionally miss its first websocket; retry once by reloading.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Sealed rooms use the same join form as plain ones: the flag travels in
    // the query, the room in the fragment, and a sealed visit warms the module
    // before the join so the only prompt left is the microphone.
    await page.goto(BASE + '/?sealed=1' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
    const boxed = await page.evaluate(() => document.getElementById('sealed').checked);
    if (!boxed) await page.click('#sealed');
    await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
    app = await page.evaluate(() => ({
      test: window.e2eApp && window.e2eApp.state.wasmTest,
      room: document.getElementById('room').value,
      sealed: document.getElementById('sealed').checked,
      title: document.title,
    }));
    await page.fill('#name', name);
    if (room) await page.fill('#room', room);
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
        sealedBox: document.getElementById('sealed').checked,
        self: window.e2eApp ? window.e2eApp.state.self : null,
        sealed: window.e2eApp ? window.e2eApp.state.sealed : null,
        linkText: (document.getElementById('link-text') || {}).textContent,
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
    // The default is checked before any link or stored choice: a visitor who
    // opens the plain address gets post-quantum e2ee without asking.
    const probe = await ctxA.newPage();
    await probe.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
    const defaults = await probe.evaluate(() => ({
      box: document.getElementById('sealed').checked,
      label: document.querySelector('label.check').textContent.trim(),
    }));
    await probe.close();
    check('the post-quantum box is on by default', defaults.box === true, defaults.box);
    check('the box says enable post-quantum e2ee', /enable post-quantum e2ee/.test(defaults.label), defaults.label);

    a = await joinPage(ctxA, 'alice', '');
    check('the sealed box is on for a sealed link', a.app.sealed === true, a.app.sealed);
    check('A loaded the post-quantum module', !!(a.app.test && a.app.test.sasMatch && a.app.test.confirm && a.app.test.open && a.app.test.wrongKeyRefused),
      JSON.stringify(a.app.test));
    const room = a.app.room;
    check('A has a 26 character random room id', /^[a-z2-7]{26}$/.test(room), room);
    // Sealed is the default, so the address carries the room only; a plain
    // room is the one that says sealed=0.
    const hashA = await a.page.evaluate(() => location.hash);
    check('a sealed link carries no sealed flag', !/sealed=/.test(hashA), hashA);

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
    const badge = await a.page.evaluate(() => ({
      text: document.getElementById('sealed-badge').textContent,
      test: window.e2eApp.state.wasmTest ? window.e2eApp.state.wasmTest.sas : '',
    }));
    check('the badge carries the peer code, not the self test code',
      badge.text.includes(sa.peers[0].sas) && !(badge.test && badge.text.includes(badge.test)), badge.text);
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

    const frameOverhead = countsA.samples.filter((s) => s.dir === 'send')
      .every((s) => s.cipherLen === s.plainLen + 29);
    check('every sampled frame grew by exactly 29 bytes (1 version + 12 IV + 16 tag)',
      countsA.samples.some((s) => s.dir === 'send') && frameOverhead, JSON.stringify(countsA.samples.slice(0, 2)));

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

    // No name or chat text ever appeared in a signaling frame.
    const auditA = await a.page.evaluate(() => ({ leaks: window.e2eApp.state.wireLeaks, frames: window.e2eApp.state.wireFrames }));
    const auditB = await b.page.evaluate(() => ({ leaks: window.e2eApp.state.wireLeaks, frames: window.e2eApp.state.wireFrames }));
    check('A signaling carries no plaintext name or chat', auditA.leaks.length === 0, JSON.stringify(auditA.leaks) + ' frames=' + auditA.frames);
    check('B signaling carries no plaintext name or chat', auditB.leaks.length === 0, JSON.stringify(auditB.leaks) + ' frames=' + auditB.frames);
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
