/* Join/boot race hunt for the sealed room.
 *
 * Two Chromium contexts with a fake camera and microphone join one sealed room
 * with deliberately varied timing, and every attempt must end with a pair that
 * works in both directions: each page sees the other peer's tile, the remote
 * video has a size, its currentTime advances and the sealed frame counters move.
 *
 * The timing is the input: simultaneous clicks, a stagger of 0, 200, 800 and
 * 1500 ms in both orders, a third guest that joins and leaves during the
 * handshake, a camera toggle and a camera device swap in the first second, and
 * a reload right after the join.
 *
 * Every page is instrumented from the test only (no product change) with a
 * timestamped log of the signaling frames, of every description call with the
 * signaling state around it, of every transform that is created and of every
 * console warning. A failed attempt writes fail.json with those logs, so the
 * exact interleaving can be named instead of guessed.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR, CYCLES, SCENARIOS,
 *      VIDEO_MS, ATTEMPTS_MAX
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
const OUT = process.env.OUTDIR || 'shots';
const CYCLES = Number(process.env.CYCLES || 2);
const ONLY = (process.env.SCENARIOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const VIDEO_MS = Number(process.env.VIDEO_MS || 15000);
const ATTEMPTS_MAX = Number(process.env.ATTEMPTS_MAX || 40);

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
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

// ---------------------------------------------------------------- scenarios

// Every scenario names the start order and the extra event that runs while the
// pair is still booting. `start` gets the two prepared pages (and the third one
// for the churn case) and drives the timing; `after` runs once both pages have
// reported `self`, before the pair is measured.
const SCENARIOS = [
  { name: 'together', cycles: 3, start: (a, b) => Promise.all([click(a), click(b)]) },
  { name: 'seq-0', cycles: 2, start: async (a, b) => { await click(a); await click(b); } },
  { name: 'stagger-200-ab', cycles: 2, stagger: 200, start: staggerStart('a') },
  { name: 'stagger-200-ba', cycles: 2, stagger: 200, start: staggerStart('b') },
  { name: 'stagger-800-ab', cycles: 2, stagger: 800, start: staggerStart('a') },
  { name: 'stagger-800-ba', cycles: 2, stagger: 800, start: staggerStart('b') },
  { name: 'stagger-1500-ab', cycles: 2, stagger: 1500, start: staggerStart('a') },
  { name: 'stagger-1500-ba', cycles: 2, stagger: 1500, start: staggerStart('b') },
  {
    name: 'churn-third',
    cycles: 2,
    churn: true,
    start: async (a, b, c) => {
      await Promise.all([click(a), click(b)]);
      await sleep(150);
      click(c).catch(() => {});
    },
    after: async (pages) => {
      // The third guest leaves in the middle of its own handshake.
      await sleep(700);
      await pages.c.page.close().catch(() => {});
    },
  },
  {
    name: 'cam-toggle',
    cycles: 2,
    start: (a, b) => Promise.all([click(a), click(b)]),
    after: async (pages) => {
      await pages.a.page.click('#cam-btn').catch(() => {});
      await sleep(400);
      await pages.a.page.click('#cam-btn').catch(() => {});
    },
  },
  {
    name: 'cam-swap',
    cycles: 2,
    start: (a, b) => Promise.all([click(a), click(b)]),
    after: async (pages) => {
      await sleep(250);
      // The picker's change handler runs the same code a person runs: a new
      // getUserMedia and a replaceTrack on the live video sender.
      await pages.a.page.evaluate(() => {
        const sel = document.getElementById('cam-live') || document.getElementById('cam-select');
        if (!sel) return;
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
    },
  },
  {
    name: 'reload-early',
    cycles: 2,
    start: (a, b) => Promise.all([click(a), click(b)]),
    after: async (pages) => {
      await sleep(150);
      const b = pages.b.page;
      await b.goto(BASE + '/?sealed=1#r=' + pages.room, { waitUntil: 'load', timeout: 60000 });
      await until(b, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 60000, 'reload wasm');
      await b.fill('#name', 'bo');
      await b.click('#enter-btn', { timeout: 20000 });
      pages.reloaded = true;
    },
  },
];

function click(page) {
  return page.click('#enter-btn', { timeout: 20000 });
}

function staggerStart(first) {
  return async (a, b, c, scenario) => {
    const one = first === 'a' ? a : b;
    const two = first === 'a' ? b : a;
    await click(one);
    await until(one, () => !!(window.e2eApp && window.e2eApp.state.self), null, 30000, 'first joined');
    await sleep(scenario.stagger);
    await click(two);
  };
}

// ---------------------------------------------------------------- instrument

// instrument runs inside every page before the client script does. It never
// changes behavior: it records what the page sends, receives and does to the
// peer connections, with a page-relative timestamp.
function instrument() {
  const race = window.__race = {
    t0: performance.now(), ws: [], rpc: [], warn: [], xf: [], pcs: [], wsSeq: 0,
  };
  const now = () => Math.round(performance.now() - race.t0);
  const push = (list, item) => { if (list.length < 600) list.push(item); };

  function sdpSummary(sdp) {
    const parts = [];
    for (const line of String(sdp || '').split(/\r?\n/)) {
      if (/^m=/.test(line)) parts.push(line);
      else if (/^a=(sendrecv|sendonly|recvonly|inactive|setup|mid)/.test(line)) parts.push(line);
    }
    return parts.join(' ; ').slice(0, 400);
  }

  function brief(data) {
    if (typeof data !== 'string') return { kind: typeof data };
    try {
      const m = JSON.parse(data);
      const o = { t: m.t };
      if (m.room) o.room = String(m.room).slice(0, 10);
      if (m.to) o.to = m.to;
      if (m.from) o.from = m.from;
      if (m.sealed) o.sealed = true;
      if (m.sdp) o.sdp = sdpSummary(m.sdp);
      if (m.candidate) o.cand = String((m.candidate || {}).candidate || '').slice(0, 20);
      if (m.b) o.b = String(m.b).length;
      if (m.code) o.code = m.code;
      if (m.action) o.action = m.action;
      return o;
    } catch {
      return { raw: String(data).slice(0, 60) };
    }
  }

  const OrigWS = window.WebSocket;
  function RaceWS(url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    const tag = 's' + (race.wsSeq += 1);
    push(race.ws, { t: now(), dir: 'new', ws: tag });
    ws.addEventListener('open', () => push(race.ws, { t: now(), dir: 'open', ws: tag }));
    ws.addEventListener('close', () => push(race.ws, { t: now(), dir: 'close', ws: tag }));
    ws.addEventListener('message', (ev) => push(race.ws, { t: now(), dir: 'in', ws: tag, m: brief(ev.data) }));
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      push(race.ws, { t: now(), dir: 'out', ws: tag, m: brief(data) });
      return send(data);
    };
    return ws;
  }
  RaceWS.prototype = OrigWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) RaceWS[k] = OrigWS[k];
  window.WebSocket = RaceWS;

  const OrigPC = window.RTCPeerConnection;
  function RacePC(cfg) {
    const pc = new OrigPC(cfg);
    const id = race.pcs.push(pc) - 1;
    const log = (what, extra) => push(race.rpc, Object.assign({
      t: now(), pc: id, what, sig: pc.signalingState, conn: pc.connectionState, ice: pc.iceConnectionState,
    }, extra || {}));
    for (const ev of ['signalingstatechange', 'connectionstatechange', 'iceconnectionstatechange', 'negotiationneeded', 'track', 'icecandidate']) {
      pc.addEventListener(ev, (e) => log(ev, ev === 'track' ? { kind: e.track && e.track.kind }
        : ev === 'icecandidate' ? { has: !!(e.candidate) } : undefined));
    }
    for (const m of ['setLocalDescription', 'setRemoteDescription', 'addTrack', 'addTransceiver', 'addIceCandidate', 'restartIce', 'close']) {
      const orig = pc[m].bind(pc);
      pc[m] = function (...args) {
        const before = pc.signalingState;
        const arg = args[0];
        let result;
        try {
          result = orig(...args);
        } catch (err) {
          log(m, { before, ok: false, err: String(err) });
          throw err;
        }
        if (result && typeof result.then === 'function') {
          return result.then((r) => {
            log(m, {
              before, ok: true,
              type: arg && arg.type,
              kind: arg && arg.kind,
              track: arg && arg.track ? String(arg.track.kind) : undefined,
              sdp: arg && arg.sdp ? sdpSummary(arg.sdp) : undefined,
              after: pc.signalingState,
              want: pc.pendingLocalDescription ? 'pending-local' : undefined,
            });
            return r;
          }, (err) => {
            log(m, { before, ok: false, err: String(err && err.name) + ': ' + String(err && err.message) });
            throw err;
          });
        }
        log(m, { before, ok: true, type: arg && arg.type, kind: arg && arg.kind });
        return result;
      };
    }
    return pc;
  }
  RacePC.prototype = OrigPC.prototype;
  window.RTCPeerConnection = RacePC;

  const OrigXF = window.RTCRtpScriptTransform;
  if (typeof OrigXF === 'function') {
    function RaceXF(worker, options) {
      const xf = new OrigXF(worker, options);
      push(race.xf, { t: now(), pair: options && options.pair, dir: options && options.dir, kind: options && options.kind });
      return xf;
    }
    RaceXF.prototype = OrigXF.prototype;
    window.RTCRtpScriptTransform = RaceXF;
  }

  const ow = console.warn.bind(console);
  console.warn = function (...a) {
    try { push(race.warn, { t: now(), w: a.map((x) => String(x)).join(' ').slice(0, 300) }); } catch { /* ignore */ }
    return ow(...a);
  };
  const oe = console.error.bind(console);
  console.error = function (...a) {
    try { push(race.warn, { t: now(), e: a.map((x) => String(x)).join(' ').slice(0, 300) }); } catch { /* ignore */ }
    return oe(...a);
  };
  window.addEventListener('unhandledrejection', (ev) => {
    try { push(race.warn, { t: now(), r: String((ev.reason && ev.reason.message) || ev.reason).slice(0, 300) }); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------- page side

async function newContext(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    permissions: ['camera', 'microphone'],
  });
  await ctx.addInitScript(instrument);
  return ctx;
}

async function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 240));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 240)));
}

// prep loads the lobby and leaves the page one click away from the join, so a
// simultaneous start is two clicks in the same turn and not two page loads.
async function prep(ctx, name, room, errors) {
  const page = await ctx.newPage();
  attach(page, errors);
  await page.goto(BASE + '/?sealed=1#r=' + room, { waitUntil: 'load', timeout: 60000 });
  await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 60000, name + ' wasm self test');
  const boxed = await page.evaluate(() => document.getElementById('sealed').checked);
  if (!boxed) await page.click('#sealed');
  await page.fill('#name', name);
  await page.fill('#room', room);
  const ready = await page.evaluate(() => ({
    sealed: window.e2eApp.state.sealed,
    boxed: document.getElementById('sealed').checked,
    room: document.getElementById('room').value,
    name: document.getElementById('name').value,
  }));
  return { page, errors, ready };
}

function probe(page) {
  return page.evaluate(() => {
    const app = window.e2eApp;
    if (!app) return { noApp: true };
    const s = app.state;
    const race = window.__race || { pcs: [] };
    const out = {
      self: s.self, room: s.room, sealed: s.sealed, leaving: s.leaving,
      outbox: s.outbox ? s.outbox.length : null, hasWorker: !!s.worker,
      identity: !!s.identity, sealFault: s.sealFault, modeClash: s.modeClash,
      sealing: typeof RTCRtpScriptTransform === 'function',
      counters: app.counters(),
      linkText: (document.getElementById('link-text') || {}).textContent,
      say: (document.getElementById('stage-error') || {}).textContent,
      peers: [],
    };
    for (const p of s.peers.values()) {
      const txs = [];
      if (p.pc) {
        for (const tx of p.pc.getTransceivers()) {
          txs.push({
            mid: tx.mid, dir: tx.direction, cur: tx.currentDirection,
            sKind: tx.sender && tx.sender.track ? tx.sender.track.kind : null,
            sState: tx.sender && tx.sender.track ? tx.sender.track.readyState : null,
            sXf: !!(tx.sender && tx.sender.transform),
            rKind: tx.receiver && tx.receiver.track ? tx.receiver.track.kind : null,
            rState: tx.receiver && tx.receiver.track ? tx.receiver.track.readyState : null,
            rXf: !!(tx.receiver && tx.receiver.transform),
          });
        }
      }
      out.peers.push({
        id: p.id, name: p.name, ready: p.ready, confirmed: !!p.confirmed, hasKeys: !!p.keys,
        hasPc: !!p.pc, pcIdx: p.pc ? race.pcs.indexOf(p.pc) : -1,
        sig: p.pc ? p.pc.signalingState : 'none', conn: p.pc ? p.pc.connectionState : 'none',
        ice: p.pc ? p.pc.iceConnectionState : 'none',
        polite: p.polite, initiator: p.initiator, tracksAdded: p.tracksAdded,
        recvSet: p.recvSet ? p.recvSet.size : -1, recvFaulted: !!p.recvFaulted,
        myConfirm: !!p.myConfirm, sentConfirm: p.sentConfirm, helloPending: !!p.helloTimer,
        keyRetryDone: p.keyRetryDone,
        announced: p.announcedName, sas: p.sas || '',
        videoW: p.video ? p.video.videoWidth : 0, videoH: p.video ? p.video.videoHeight : 0,
        videoT: p.video ? p.video.currentTime : 0, videoReady: p.video ? p.video.readyState : -1,
        videoPaused: p.video ? p.video.paused : null,
        videoTracks: p.video && p.video.srcObject
          ? p.video.srcObject.getTracks().map((t) => ({ k: t.kind, s: t.readyState, m: t.muted })) : null,
        tileE2E: p.tile ? (p.tile.dataset.e2e || null) : null,
        txs,
      });
    }
    return out;
  });
}

function pairView(page, target) {
  return page.evaluate((want) => {
    const s = window.e2eApp.state;
    const race = window.__race || { ws: [] };
    const list = [...s.peers.values()];
    let p = null;
    if (want && want.id) p = list.find((x) => x.id === want.id) || null;
    if (!p && want && want.name) p = list.find((x) => x.name === want.name) || null;
    if (!p && list.length === 1) p = list[0];
    const base = {
      self: s.self,
      peers: list.length,
      opens: (race.ws || []).filter((x) => x.dir === 'open').length,
      closes: (race.ws || []).filter((x) => x.dir === 'close').length,
      ids: list.map((x) => x.id),
      names: list.map((x) => x.name),
    };
    if (!p) return Object.assign(base, { missing: true });
    return Object.assign(base, {
      id: p.id, name: p.name,
      w: p.video ? p.video.videoWidth : 0, h: p.video ? p.video.videoHeight : 0,
      t: p.video ? p.video.currentTime : 0,
      ready: p.video ? p.video.readyState : -1, paused: p.video ? p.video.paused : null,
      keys: !!p.keys, readyState: p.ready, confirmed: !!p.confirmed,
      conn: p.pc ? p.pc.connectionState : 'none',
      sig: p.pc ? p.pc.signalingState : 'none',
      e2e: p.tile ? (p.tile.dataset.e2e || '') : '',
    });
  }, target || {});
}

function rtp(page, id) {
  return page.evaluate(async (peerId) => {
    const p = window.e2eApp.state.peers.get(peerId);
    if (!p || !p.pc) return { noPc: true };
    const out = { inAudio: 0, inVideo: 0, outAudio: 0, outVideo: 0, decVideo: 0, decAudio: 0, recvVideo: 0 };
    try {
      (await p.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp') {
          if (r.kind === 'audio') { out.inAudio += r.packetsReceived || 0; out.decAudio += r.framesDecoded || 0; }
          if (r.kind === 'video') {
            out.inVideo += r.packetsReceived || 0; out.decVideo += r.framesDecoded || 0; out.recvVideo += r.framesReceived || 0;
          }
        }
        if (r.type === 'outbound-rtp') {
          if (r.kind === 'audio') out.outAudio += r.packetsSent || 0;
          if (r.kind === 'video') out.outVideo += r.packetsSent || 0;
        }
      });
    } catch (err) {
      out.error = String(err);
    }
    return out;
  }, id);
}

// waitPair is the assertion of this suite: both pages must show the other
// peer's tile with a picture whose clock advances, within VIDEO_MS.
//
// A socket that is replaced during the wait (a rollout of the host, a killed
// pod, a network drop) gives the pair a fresh budget: the reconnect path is a
// product feature and is not the race under test. The reconnect is counted and
// reported, so a run that only passes thanks to it is visible as such.
async function waitPair(pageA, targetA, pageB, targetB, ms) {
  const start = Date.now();
  let budget = start;
  let reconnects = 0;
  let last = null;
  let seenA = null;
  let seenB = null;
  while (Date.now() - budget < ms) {
    const a1 = await pairView(pageA, targetB).catch((e) => ({ err: String(e) }));
    const b1 = await pairView(pageB, targetA).catch((e) => ({ err: String(e) }));
    await sleep(700);
    const a2 = await pairView(pageA, targetB).catch((e) => ({ err: String(e) }));
    const b2 = await pairView(pageB, targetA).catch((e) => ({ err: String(e) }));
    last = { a: { first: a1, now: a2 }, b: { first: b1, now: b2 } };
    if ((seenA && seenA !== a2.self) || (seenB && seenB !== b2.self)) {
      reconnects++;
      budget = Date.now();
      console.log('RECONNECT during pair wait: self ' + seenA + '->' + a2.self + ' / ' + seenB + '->' + b2.self);
    }
    seenA = a2.self;
    seenB = b2.self;
    const aOk = !!(a2 && a2.w > 0 && a2.t > (a1.t || 0) + 0.02);
    const bOk = !!(b2 && b2.w > 0 && b2.t > (b1.t || 0) + 0.02);
    if (aOk && bOk) return { ok: true, waited: Date.now() - start, view: last, reconnects };
  }
  return { ok: false, waited: Date.now() - start, view: last, reconnects };
}

function roomName(tag) {
  const run = Date.now().toString(36).slice(-5);
  const clean = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ('jr-' + clean + '-' + run).slice(0, 60);
}

// ---------------------------------------------------------------- one attempt

async function runAttempt(browser, scenario, cycle) {
  const tag = scenario.name + '-' + (cycle + 1);
  const room = roomName(tag);
  const rec = { tag, room, scenario: scenario.name, cycle: cycle + 1, started: new Date().toISOString() };
  const errorsA = [];
  const errorsB = [];
  const errorsC = [];
  const t0 = Date.now();
  const pages = {};
  let ctxA = null;
  let ctxB = null;
  let ctxC = null;

  try {
    ctxA = await newContext(browser);
    ctxB = await newContext(browser);
    pages.a = await waitPrep(ctxA, 'ana', room, errorsA, 'A');
    pages.b = await waitPrep(ctxB, 'bo', room, errorsB, 'B');
    if (!pages.a || !pages.a.page || !pages.b || !pages.b.page) {
      rec.how = 'prep';
      rec.prep = {
        a: pages.a ? (pages.a.ready || {}) : 'absent',
        b: pages.b ? (pages.b.ready || {}) : 'absent',
      };
      return { ok: false, rec, pages, errors: { A: errorsA, B: errorsB, C: errorsC } };
    }
    if (scenario.churn) {
      ctxC = await newContext(browser);
      pages.c = await waitPrep(ctxC, 'cy', room, errorsC, 'C');
    }
    pages.room = room;

    rec.startAt = Date.now() - t0;
    await scenario.start(pages.a.page, pages.b.page, pages.c && pages.c.page, scenario);

    const joinA = await until(pages.a.page,
      () => !!(window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden),
      null, 40000, 'A joined').then(() => Date.now() - t0).catch((e) => 'A-join-fail: ' + e.message);
    const joinB = await until(pages.b.page,
      () => !!(window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden),
      null, 40000, 'B joined').then(() => Date.now() - t0).catch((e) => 'B-join-fail: ' + e.message);
    rec.joinA = joinA;
    rec.joinB = joinB;
    if (typeof joinA === 'string' || typeof joinB === 'string') {
      rec.how = 'join';
      return { ok: false, rec, pages, errors: { A: errorsA, B: errorsB, C: errorsC } };
    }

    if (scenario.after) await scenario.after(pages).catch((e) => { rec.afterError = String(e).slice(0, 200); });

    // With a reload the peer id of B changes; the id is read fresh below and
    // the wait also matches on the sealed name, so a reconnect is not mistaken
    // for a missing peer.
    const idA = await pages.a.page.evaluate(() => window.e2eApp.state.self);
    const idB = await pages.b.page.evaluate(() => window.e2eApp.state.self);
    rec.idA = idA;
    rec.idB = idB;

    const waited = await waitPair(pages.a.page, { id: idB, name: 'bo' }, pages.b.page, { id: idA, name: 'ana' }, VIDEO_MS);
    rec.view = waited.view;
    rec.mediaMs = waited.waited;
    rec.reconnects = waited.reconnects;
    if (!waited.ok) {
      rec.how = 'no-video';
      const nowA = await pages.a.page.evaluate(() => window.e2eApp.state.self).catch(() => '?');
      const nowB = await pages.b.page.evaluate(() => window.e2eApp.state.self).catch(() => '?');
      rec.selfNow = { a: nowA, b: nowB };
      rec.rtpA = await rtp(pages.a.page, (rec.view.a.now || {}).id || idB).catch((e) => ({ err: String(e) }));
      rec.rtpB = await rtp(pages.b.page, (rec.view.b.now || {}).id || idA).catch((e) => ({ err: String(e) }));
      return { ok: false, rec, pages, errors: { A: errorsA, B: errorsB, C: errorsC } };
    }

    const idNowA = (rec.view.a.now || {}).id || idA;
    const idNowB = (rec.view.b.now || {}).id || idB;
    rec.idNowA = idNowA;
    rec.idNowB = idNowB;

    // The counters must move in both directions too: a picture that decodes
    // while the sealed frame path is idle is not the path under test.
    const c1A = await pages.a.page.evaluate(() => window.e2eApp.counters());
    const c1B = await pages.b.page.evaluate(() => window.e2eApp.counters());
    await sleep(1200);
    const c2A = await pages.a.page.evaluate(() => window.e2eApp.counters());
    const c2B = await pages.b.page.evaluate(() => window.e2eApp.counters());
    rec.counters = {
      a: { enc: c2A.encryptFrames, dec: c2A.decryptFrames, movedEnc: c2A.encryptFrames > c1A.encryptFrames, movedDec: c2A.decryptFrames > c1A.decryptFrames, errors: c2A.workerErrors },
      b: { enc: c2B.encryptFrames, dec: c2B.decryptFrames, movedEnc: c2B.encryptFrames > c1B.encryptFrames, movedDec: c2B.decryptFrames > c1B.decryptFrames, errors: c2B.workerErrors },
    };
    rec.rtpA = await rtp(pages.a.page, idNowB).catch((e) => ({ err: String(e) }));
    rec.rtpB = await rtp(pages.b.page, idNowA).catch((e) => ({ err: String(e) }));
    const countersOk = rec.counters.a.movedEnc && rec.counters.b.movedEnc
      && rec.counters.a.movedDec && rec.counters.b.movedDec;
    if (!countersOk) {
      rec.how = 'counters';
      return { ok: false, rec, pages, errors: { A: errorsA, B: errorsB, C: errorsC } };
    }
    rec.how = 'ok';
    return { ok: true, rec, pages, errors: { A: errorsA, B: errorsB, C: errorsC } };
  } catch (err) {
    rec.how = 'exception';
    rec.exception = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
    return { ok: false, rec, pages, errors: { A: errorsA, B: errorsB, C: errorsC } };
  } finally {
    // The contexts stay open on a failure: the dump reads the live pages and
    // takes a screenshot. closeAttempt() is called by the caller either way.
    lastContexts = [ctxA, ctxB, ctxC].filter(Boolean);
  }
}

let lastContexts = [];

async function closeAttempt(attempt) {
  void attempt;
  for (const ctx of lastContexts) {
    await ctx.close().catch(() => {});
  }
  lastContexts = [];
}

// waitPrep keeps a page that failed to load out of the attempt as a named
// failure instead of an exception with no context. A lobby load is not the
// subject of this suite, so it gets three tries like the join in the sibling
// suite: a flaky asset fetch must not be read as a race.
async function waitPrep(ctx, name, room, errors, label) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await prep(ctx, name, room, errors);
      return out;
    } catch (err) {
      last = String((err && err.message) || err).slice(0, 300);
      console.log('PREP-RETRY ' + label + ' attempt ' + (attempt + 1) + '  ' + last);
      // A fresh page: the failed one may be stuck on a half-loaded lobby.
      const pages = ctx.pages();
      for (const p of pages) await p.close().catch(() => {});
      await sleep(400);
    }
  }
  return { page: null, errors, ready: { failed: last }, label };
}

async function dumpFailure(browser, attempt) {
  const out = { rec: attempt.rec, errors: attempt.errors, pages: {}, shots: [] };
  const list = [];
  for (const [label, p] of [['a', attempt.pages.a], ['b', attempt.pages.b], ['c', attempt.pages.c]]) {
    if (!p || !p.page) continue;
    list.push([label, p.page]);
  }
  // A reload replaces the page object only inside the scenario; the handle in
  // attempt.pages is the one that is alive, which is what the dump needs.
  for (const [label, page] of list) {
    const one = {};
    try { one.probe = await probe(page); } catch (e) { one.probe = { err: String(e) }; }
    try { one.ws = await page.evaluate(() => (window.__race ? window.__race.ws : [])); } catch (e) { one.ws = String(e); }
    try { one.rpc = await page.evaluate(() => (window.__race ? window.__race.rpc : [])); } catch (e) { one.rpc = String(e); }
    try { one.warn = await page.evaluate(() => (window.__race ? window.__race.warn : [])); } catch (e) { one.warn = String(e); }
    try { one.xf = await page.evaluate(() => (window.__race ? window.__race.xf : [])); } catch (e) { one.xf = String(e); }
    try { one.workerErrors = await page.evaluate(() => window.e2eApp.counters().workerErrors); } catch (e) { one.workerErrors = String(e); }
    out.pages[label] = one;
    const shot = OUT + '/' + attempt.rec.tag + '-' + label + '.png';
    try { await page.screenshot({ path: shot }); out.shots.push(shot.split('/').pop()); } catch { /* gone */ }
  }
  fs.writeFileSync(OUT + '/fail.json', JSON.stringify(out, null, 2));
  // Print the compact story: the signaling frames and the description calls of
  // the page that has the most to say, so the log carries it without the JSON.
  for (const [label, one] of Object.entries(out.pages)) {
    const ws = Array.isArray(one.ws) ? one.ws.filter((x) => !(x.m && x.m.cand)) : [];
    console.log('WIRE ' + label + '  ' + JSON.stringify(ws.slice(0, 90)));
    const rpc = Array.isArray(one.rpc)
      ? one.rpc.filter((x) => /Description|negotiation|connectionstatechange|track|restartIce/.test(x.what)) : [];
    console.log('RPC  ' + label + '  ' + JSON.stringify(rpc.slice(0, 60)));
    console.log('WARN ' + label + '  ' + JSON.stringify((one.warn || []).slice(-20)));
    console.log('PEER ' + label + '  ' + JSON.stringify((one.probe && one.probe.peers) || one.probe));
  }
}

// ---------------------------------------------------------------- main

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

  const plan = [];
  for (const sc of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(sc.name)) continue;
    const n = sc.cycles || CYCLES;
    for (let i = 0; i < n; i++) plan.push([sc, i]);
  }
  console.log('PLAN ' + JSON.stringify({ target: BASE, attempts: plan.length, videoMs: VIDEO_MS }));
  info('scenarios', plan.map(([sc]) => sc.name).join(','));

  let pass = 0;
  let fail = 0;
  const tally = {};
  const retried = new Set();
  let aborted = false;

  for (let i = 0; i < plan.length && i < ATTEMPTS_MAX && !aborted; i++) {
    const [scenario, cycle] = plan[i];
    let attempt = await runAttempt(browser, scenario, cycle);
    if (!attempt.ok && attempt.rec.how === 'prep' && !retried.has(i)) {
      // The lobby did not load: that is the harness, not the pair.
      retried.add(i);
      console.log('RETRY-ATTEMPT ' + attempt.rec.tag + ' after prep failure '
        + JSON.stringify(attempt.rec.prep || {}));
      await closeAttempt(attempt);
      i--;
      continue;
    }
    const r = attempt.rec;
    tally[scenario.name] = tally[scenario.name] || { pass: 0, fail: 0 };
    const view = r.view || {};
    const line = 'ATTEMPT ' + (i + 1) + '/' + plan.length + ' ' + r.tag + ' ' + (attempt.ok ? 'PASS' : 'FAIL')
      + ' media=' + (r.mediaMs || 0) + 'ms'
      + (view.a ? ' A[w=' + (view.a.now || {}).w + ' t=' + Number((view.a.now || {}).t || 0).toFixed(2)
        + ' ' + (view.a.now || {}).conn + '/' + (view.a.now || {}).sig + ']' : '')
      + (view.b ? ' B[w=' + (view.b.now || {}).w + ' t=' + Number((view.b.now || {}).t || 0).toFixed(2)
        + ' ' + (view.b.now || {}).conn + '/' + (view.b.now || {}).sig + ']' : '')
      + (r.how && r.how !== 'ok' ? ' how=' + r.how : '')
      + (r.exception ? ' exc=' + r.exception : '');
    console.log(line);
    results.push({ name: r.tag, ok: attempt.ok, detail: line });

    if (attempt.ok) {
      pass++;
      tally[scenario.name].pass++;
    } else {
      fail++;
      tally[scenario.name].fail++;
      console.log('---- failing attempt detail ----');
      console.log(JSON.stringify(r, null, 1).slice(0, 8000));
      await dumpFailure(browser, attempt).catch((e) => console.log('DUMP FAILED ' + e));
      fs.writeFileSync(OUT + '/results.json', JSON.stringify({ tally, results }, null, 2));
      aborted = true;
    }
    await closeAttempt(attempt);
  }

  await browser.close().catch(() => {});
  fs.writeFileSync(OUT + '/results.json', JSON.stringify({ tally, results }, null, 2));
  console.log('TALLY ' + JSON.stringify(tally));
  console.log('SUMMARY ' + JSON.stringify({ attempts: pass + fail, pass, fail }));
  process.exit(fail === 0 && !aborted ? 0 : 1);
})().catch((e) => {
  console.log('SUITE ERROR ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
