/*
 The talking light, the remote audio graph and the noise
 suppression worklet.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { detachMedia, disconnectQuietly, isAdmin, say } from './util.js';
import { layoutStage, ownTile, rowOf } from './tiles.js';
import { applyFlags, volGain } from './volume.js';
import { refreshSelf } from './devices.js';
import { sealedSend } from './gate.js';
import { scriptURL } from './trust.js';

// ------------------------------------------------------------- talking light
// Every audio source has an RMS tap, and a green light marks the tile of the
// person who speaks. The tap sits before the peer gain, so a guest turned down
// to zero still lights up; a short hold keeps the light steady between syllables.
const SPEAK_MS = 100;

const SPEAK_ON = 0.03;

const SPEAK_HOLD_MS = 400;

const speakBufs = new WeakMap();

function analyserLevel(a) {
  if (!a) return 0;
  let buf = speakBufs.get(a);
  if (!buf || buf.length !== a.fftSize) {
    buf = new Float32Array(a.fftSize);
    speakBufs.set(a, buf);
  }
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// paintSpeaking turns the light on for a level over the threshold and keeps it
// on for the hold. The last time is kept in the given object.
function paintSpeaking(tile, level, hold) {
  if (!tile) return;
  const now = performance.now();
  if (level >= SPEAK_ON) hold.last = now;
  const on = now - (hold.last || 0) < SPEAK_HOLD_MS;
  tile.classList.toggle('speaking', on);
  // The row of this member carries the same light, so a guest without a
  // picture still shows that it talks.
  const row = rowOf.get(tile);
  if (row) row.classList.toggle('speaking', on);
}

export function speakTick() {
  const own = ownTile();
  // One read of the microphone tap feeds the talking light and the stats row.
  // The peak falls slowly, so one stats tick can still see a word.
  const level = analyserLevel(state.micAnalyser);
  state.meterPeak = Math.max(level, state.meterPeak * 0.9);
  if (own && state.ownSpoke) {
    // A muted microphone sends silence, so the guest is not shown as talking.
    paintSpeaking(own, state.mic ? level : 0, state.ownSpoke);
  }
  for (const peer of state.peers.values()) {
    // One read per tick feeds the light and the stats line. The light follows
    // the microphone flag, but the level is measured either way, so a stats row
    // still shows what arrives from a peer that reports a muted microphone.
    const level = analyserLevel(peer.meter);
    peer.meterPeak = Math.max(level, (peer.meterPeak || 0) * 0.9);
    if (!peer.tile) continue;
    if (!peer.spoke) peer.spoke = { last: 0 };
    paintSpeaking(peer.tile, peer.mic ? level : 0, peer.spoke);
  }
}

export function startSpeaking() {
  if (state.speakTimer) return;
  state.ownSpoke = { last: 0 };
  state.speakTimer = setInterval(speakTick, SPEAK_MS);
}

export function stopSpeaking() {
  if (state.speakTimer) clearInterval(state.speakTimer);
  state.speakTimer = null;
  state.ownSpoke = null;
}

// micLevelCells splits the own input into the four columns of the microphone
// row: decibels, the share of the scale and the state word. A peak under -60 dB
// is below anything a person hears, so it reads as silent.
export function micLevelCells(peak) {
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  if (!(db > -60)) return { db: '0 dB', pct: '0 %', state: 'silent' };
  return {
    db: `${Math.round(db)} dB`,
    pct: `${Math.round(((db + 60) / 60) * 100)} %`,
    state: 'transmitting',
  };
}

// noiseWasm fetches the model once; every processor builds its module from the
// same copy.
export function noiseWasm() {
  if (!state.noiseWasm) {
    state.noiseWasm = fetch('/gtcrn.wasm').then((res) => {
      if (!res.ok) throw new Error('gtcrn.wasm ' + res.status);
      return res.arrayBuffer();
    });
  }
  return state.noiseWasm;
}

// gtIds ties a GTCRN node to its row in state.gtStats, because the node is a
// graph object and the counters are keyed by a small string.
const gtIds = new WeakMap();

// makeDenoiseNode builds one GTCRN processor on one context. The microphone and
// every incoming stream that wants it own a node, because the filter state
// belongs to one stream.
async function makeDenoiseNode(ctx, dir) {
  const [binary] = await Promise.all([
    noiseWasm(),
    ctx.audioWorklet.addModule(scriptURL('/gtcrn-node.js')),
  ]);
  const node = new AudioWorkletNode(ctx, 'gtcrn', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { wasm: new Uint8Array(binary) },
  });
  // One row per node: the microphone and every filtered peer own a model, and
  // the counters of a node that stops are dropped with it.
  const id = 'g' + ++state.gtSeq;
  node.port.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.ev !== 'stats') return;
    state.gtStats.set(id, {
      dir,
      frames: Number(msg.frames) || 0,
      ms: Number(msg.ms) || 0,
      starved: Number(msg.starved) || 0,
    });
    paintFilterNote();
  };
  gtIds.set(node, id);
  node.addEventListener('processorerror', () => state.gtStats.delete(id));
  state.gtStats.set(id, { dir, frames: 0, ms: 0, starved: 0 });
  return node;
}

// prefetchNoise starts the download of the FastEnhancer engine and its weights,
// so a switch to that model or an incoming filter of that kind does not wait for
// them. The worker then loads both from the HTTP cache. It is a plain fetch and
// nothing is kept here.
export function prefetchNoise() {
  const warm = (url) =>
    fetch(url)
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .catch(() => {});
  void warm('/fe.wasm');
  void warm('/fe.q8');
}

// feWorker starts the one worker that holds FastEnhancer. Every incoming stream
// that uses it hands over its own node port, so the model is fetched and built
// once, and every stream keeps its own state in the worker.
function feWorker() {
  if (!state.feWorker) {
    state.feWorker = new Worker(scriptURL('/fastenhancer-worker.js'));
    state.feWorker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.ev === 'error') say('the noise filter stopped: ' + String(msg.text || 'unknown'));
      else if (msg.ev === 'stats') {
        state.feStats.set(Number(msg.id) || 0, {
          frames: Number(msg.frames) || 0,
          dropped: Number(msg.dropped) || 0,
          ms: Number(msg.ms) || 0,
        });
        paintFilterNote();
      }
    };
    // The streams ask for the model at call start, so the load does not land on
    // the first frame of the first talker.
    state.feWorker.postMessage({ ev: 'warm' });
  }
  return state.feWorker;
}

// feDrops sums the counter every worker lane sends: frames it filtered and
// frames its queue threw away, over all lanes alive in this call.
export function feDrops() {
  let frames = 0;
  let dropped = 0;
  for (const s of state.feStats.values()) {
    frames += s.frames;
    dropped += s.dropped;
  }
  return { frames, dropped };
}

// filterNote paints the frame time and the drop rate of the filters that run
// now: the outgoing one next to its model choice, the incoming ones summed over
// every peer that asks for a filter. A filter that is off shows off, so the row
// never keeps a number from a stream that stopped.
function noteLine(label, frames, ms, dropped) {
  if (!frames) return `${label}, warming up`;
  const per = ms / frames;
  const drop = dropped / frames > 0.0005
    ? `, ${((100 * dropped) / frames).toFixed(1)}% drop`
    : '';
  return `${label} ${per.toFixed(per < 1 ? 2 : 1)} ms/frame${drop}`;
}

export function paintFilterNote() {
  const out = $('noise-note-out');
  const inc = $('noise-note-in');
  if (out) {
    if (!state.denoiseOn) out.textContent = 'off';
    else if (state.denoiseEngine === 'gtcrn') {
      const g = state.gtStats.get('out');
      out.textContent = g
        ? noteLine('GTCRN', g.frames, g.ms, g.starved / 768)
        : 'GTCRN, warming up';
    } else {
      const f = state.feStats.get(state.denoiseFeId);
      out.textContent = f
        ? noteLine('FastEnhancer', f.frames, f.ms, f.dropped)
        : 'FastEnhancer, warming up';
    }
  }
  if (inc) {
    let frames = 0, ms = 0, dropped = 0, engines = 0;
    for (const g of state.gtStats.values()) {
      if (g.dir !== 'in') continue;
      frames += g.frames;
      ms += g.ms;
      dropped += g.starved / 768;
      engines++;
    }
    for (const [id, f] of state.feStats) {
      if (id === state.denoiseFeId) continue;
      frames += f.frames;
      ms += f.ms;
      dropped += f.dropped;
      engines++;
    }
    inc.textContent = engines
      ? noteLine(engines > 1 ? `${engines} streams` : 'in', frames, ms, dropped)
      : 'off';
  }
  return undefined;
}

// makeFastEnhancerNode builds one node for one stream and attaches it to the
// worker. The node port is transferred, so the worker talks to the audio thread
// directly and no sample passes through the page.
async function makeFastEnhancerNode(ctx) {
  await ctx.audioWorklet.addModule(scriptURL('/fastenhancer-worklet.js'));
  const node = new AudioWorkletNode(ctx, 'fastenhancer', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  const id = ++state.feSeq;
  feWorker().postMessage({ ev: 'attach', id, port: node.port }, [node.port]);
  return { node, id };
}

// dropMicFilter takes the microphone filter out of the graph and drops its
// worker lane, so a change of model builds the next one from a clean state.
function dropMicFilter() {
  if (state.denoise) {
    disconnectQuietly(state.denoise);
    const id = gtIds.get(state.denoise);
    if (id) state.gtStats.delete(id);
  }
  if (state.denoiseFeId) {
    feWorker().postMessage({ ev: 'detach', id: state.denoiseFeId });
    state.feStats.delete(state.denoiseFeId);
    state.denoiseFeId = 0;
  }
  state.denoise = null;
  state.denoiseEngine = 'off';
  paintFilterNote();
}

// setNoise switches the microphone between the raw path and one of the two
// filters; the choice of model is kept for the next switch on. Only the
// microphone graph changes, so the incoming streams and the mixer stay as they
// are.
export async function setNoise(on, engine = state.noiseEngine) {
  if (!state.micSource || !state.audioCtx) {
    state.denoiseOn = false;
    return false;
  }
  const want = on ? (engine === 'fastenhancer' ? 'fastenhancer' : 'gtcrn') : 'off';
  if (want !== 'off' && state.denoise && state.denoiseEngine !== want) dropMicFilter();
  if (want !== 'off' && !state.denoise) {
    try {
      if (want === 'gtcrn') {
        // The wasm bytes travel in processorOptions: a worklet can only build
        // a module from bytes it already holds.
        state.denoise = await makeDenoiseNode(state.audioCtx, 'out');
      } else {
        // FastEnhancer keeps its model and runtime in the worker, and its port
        // is transferred, so no sample passes through the page.
        const { node, id } = await makeFastEnhancerNode(state.audioCtx);
        state.denoise = node;
        state.denoiseFeId = id;
      }
      state.denoise.connect(state.micGain);
      state.denoiseEngine = want;
    } catch (err) {
      console.warn('noise suppression unavailable', err);
      dropMicFilter();
      state.denoiseOn = false;
      return false;
    }
  }
  disconnectQuietly(state.micSource);
  if (want === 'off') {
    state.micSource.connect(state.micGain);
    state.denoiseOn = false;
  } else {
    state.micSource.connect(state.denoise);
    state.denoiseOn = true;
  }
  sendState();
  paintFilterNote();
  return state.denoiseOn;
}

export function resumeAudio() {
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume().catch(() => {
      // Autoplay policy: retry on the next click.
      document.addEventListener(
        'click',
        () => state.audioCtx && state.audioCtx.resume().catch(() => {}),
        {
          once: true,
        },
      );
    });
  }
}

// ---------------------------------------------------------------- remote audio
// Remote audio does not play from the video element: one gain node per peer
// takes it to the output, so 100 percent is unity and 200 a real boost. The
// context is created on the join click, and a suspended one resumes on a click.
// newAudioCtx opens one audio context. Older Safari exposes only the prefixed
// constructor, which the DOM lib omits, so the page asks for both names once.
export function newAudioCtx(opts?: AudioContextOptions) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    return new Ctx(opts);
  } catch {
    return null;
  }
}

export function ensurePlayback() {
  if (state.playCtx) {
    resumePlayback();
    return state.playCtx;
  }
  state.playCtx = newAudioCtx({ latencyHint: 'interactive' });
  if (!state.playCtx) return null;
  resumePlayback();
  return state.playCtx;
}

function resumePlayback() {
  const ctx = state.playCtx;
  if (!ctx || ctx.state !== 'suspended') return;
  ctx.resume().catch(() => {
    document.addEventListener('click', () => ctx.resume().catch(() => {}), { once: true });
  });
}

// routeAudio sends one incoming audio track through the gain of its peer. The
// element path is only for a browser without Web Audio and can not go over 100
// percent.
export function routeAudio(peer, track) {
  const ctx = ensurePlayback();
  if (!ctx) {
    const el = peer.audioEl || new Audio();
    el.autoplay = true;
    el.srcObject = new MediaStream([track]);
    el.volume = state.deaf ? 0 : Math.min(volGain(peer.vol), 1);
    el.play().catch(() => {});
    peer.audioEl = el;
    return;
  }
  dropAudio(peer);
  // A muted element is the decode sink: Chromium does not always pull the
  // decoder for a source node alone, and then every node reads zeros.
  const pump = new Audio();
  pump.muted = true;
  pump.volume = 0;
  pump.autoplay = true;
  pump.srcObject = new MediaStream([track]);
  pump.play().catch(() => {});
  peer.pump = pump;
  peer.gain = ctx.createGain();
  peer.gain.gain.value = state.deaf ? 0 : volGain(peer.vol);
  peer.audioSrc = ctx.createMediaStreamSource(new MediaStream([track]));
  peer.audioSrc.connect(peer.gain);
  peer.gain.connect(ctx.destination);
  // The talking light reads the source, before the gain, so a guest turned down
  // to zero still shows that they speak.
  peer.meter = ctx.createAnalyser();
  peer.meter.fftSize = 1024;
  peer.audioSrc.connect(peer.meter);
  // A guest whose noise cancel was asked for before this track existed gets it
  // now, without a second toggle.
  if (peer.inNoise)
    void setPeerNoise(peer, true, peer.inEngine === 'gtcrn' ? 'gtcrn' : 'fastenhancer');
  resumePlayback();
  // A context still suspended after a resume attempt plays nothing. Say it,
  // because the video looks correct and only the sound is missing.
  if (ctx.state === 'suspended')
    say('the browser holds the audio output; tap the page once to hear the room');
}

// dropAudio unhooks one peer from the output, so a closed peer is silent and
// its nodes can be collected.
export function dropAudio(peer) {
  if (!peer) return;
  if (peer.inDenoise) {
    disconnectQuietly(peer.inDenoise);
    peer.inDenoise = null;
  }
  if (peer.feId) {
    feWorker().postMessage({ ev: 'detach', id: peer.feId });
    peer.feId = 0;
  }
  if (peer.audioSrc) {
    disconnectQuietly(peer.audioSrc);
    peer.audioSrc = null;
  }
  if (peer.meter) {
    disconnectQuietly(peer.meter);
    peer.meter = null;
  }
  if (peer.gain) {
    disconnectQuietly(peer.gain);
    peer.gain = null;
  }
  if (peer.pump) {
    detachMedia(peer.pump);
    peer.pump = null;
  }
  if (peer.audioEl) {
    detachMedia(peer.audioEl);
    peer.audioEl = null;
  }
}

// wirePlayNoise connects one guest's source to its gain, through that guest's
// own noise cancel when on. The talking light reads the source either way.
function wirePlayNoise(peer) {
  if (!peer.audioSrc || !peer.gain) return;
  disconnectQuietly(peer.audioSrc);
  if (peer.inDenoise) {
    disconnectQuietly(peer.inDenoise);
  }
  if (peer.inNoise && peer.inDenoise) {
    peer.audioSrc.connect(peer.inDenoise);
    peer.inDenoise.connect(peer.gain);
  } else {
    peer.audioSrc.connect(peer.gain);
  }
  if (peer.meter) peer.audioSrc.connect(peer.meter);
}

// setPeerNoise sets the noise cancel of one incoming stream. Three states: off,
// GTCRN, and FastEnhancer, the tier the page was built with. A change of engine
// rebuilds that one filter and leaves the peer connection alone.
export async function setPeerNoise(peer, on, engine = 'fastenhancer') {
  if (!peer) return;
  const want = on ? engine : 'off';
  if (want === 'off') {
    if (!peer.inNoise && !peer.inDenoise) return;
  } else if (peer.inNoise && peer.inEngine === want && peer.inDenoise) {
    return;
  }
  const ctx = state.playCtx || ensurePlayback();
  if (want !== 'off' && !ctx) {
    say('this browser can not cancel noise without Web Audio');
    return;
  }
  if (peer.inDenoise) {
    disconnectQuietly(peer.inDenoise);
    const id = gtIds.get(peer.inDenoise);
    if (id) state.gtStats.delete(id);
    peer.inDenoise = null;
  }
  if (peer.feId) {
    feWorker().postMessage({ ev: 'detach', id: peer.feId });
    state.feStats.delete(peer.feId);
    peer.feId = 0;
  }
  if (want === 'off') {
    peer.inNoise = false;
    peer.inEngine = 'off';
    wirePlayNoise(peer);
    sendState();
    return;
  }
  try {
    if (want === 'gtcrn') {
      peer.inDenoise = await makeDenoiseNode(ctx!, 'in');
    } else {
      const made = await makeFastEnhancerNode(ctx!);
      peer.inDenoise = made.node;
      peer.feId = made.id;
    }
  } catch (err) {
    console.warn('noise cancel unavailable', err);
    peer.inNoise = false;
    peer.inEngine = 'off';
    wirePlayNoise(peer);
    sendState();
    say('the noise cancel is not available in this browser');
    return;
  }
  peer.inNoise = true;
  peer.inEngine = want;
  wirePlayNoise(peer);
  sendState();
  paintFilterNote();
}

// stateFrame is the one sealed message that carries the flags of this guest.
// It goes to every pair separately, so the server relays an opaque blob and
// keeps none of the values. The noise filters are per side: the microphone one
// is the same for the room, the incoming one is a choice about this pair.
function stateFrame(peer) {
  return {
    k: 'state',
    mic: state.mic,
    cam: state.cam,
    deaf: state.deaf,
    screen: !!state.screen,
    hand: state.hand,
    ts: state.handTs,
    // This build reads padded frames, so a peer may round its frame sizes up.
    pad: 1,
    outFilter: state.denoiseOn ? state.denoiseEngine : 'off',
    inFilter: peer && peer.inNoise ? peer.inEngine : 'off',
  };
}

// sendState tells the room that the microphone, the camera, the hand or the
// share changed. Every guest gets its own sealed copy, and the own tile is
// painted here, because no server echoes the flags back.
export function sendState() {
  refreshSelf();
  if (!state.self || state.leaving) return;
  for (const peer of state.peers.values()) {
    if (!peer.keys || peer.waiting) continue;
    sealedSend(peer, stateFrame(peer));
  }
}

// sealedSendState hands the current flags to one pair that has just proved the
// passphrase, so a guest that joins later still learns the toggles.
export function sealedSendState(peer) {
  if (!peer.keys || peer.waiting) return;
  sealedSend(peer, stateFrame(peer));
}

// setHand raises or lowers the own hand and tells the room. The raise time is
// the queue order and every guest reads it, so no server numbers the hands.
export function setHand(on) {
  if (state.waiting || state.hand === on) return;
  state.hand = on;
  state.handTs = on ? Date.now() : 0;
  const self = ownTile();
  if (self) applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  updateButtons();
  sendState();
  paintHandQueue();
}

// handRows lists the raised hands in the order every guest agrees on: sender
// time, ties by peer id. A hand with no time yet goes last, never first.
function handRows() {
  const rows = [];
  for (const peer of state.peers.values()) {
    if (peer.hand)
      rows.push({ id: String(peer.id), ts: peer.handTs || 0, name: peer.name, self: false });
  }
  if (state.hand)
    rows.push({
      id: String(state.self),
      ts: state.handTs || 0,
      name: state.name || 'you',
      self: true,
    });
  rows.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

// handPlace is the 1 based place of one guest in the raised hand queue, or 0
// while that hand is down.
export function handPlace(id) {
  const at = handRows().findIndex((row) => row.id === String(id));
  return at < 0 ? 0 : at + 1;
}

// paintHandQueue draws the raised hands in that order: the first row holds the
// hand that the room answers next. An admin gets a button on every row that
// takes that hand down.
export function paintHandQueue() {
  const panel = document.getElementById('hand-queue');
  const list = document.getElementById('hand-queue-list');
  if (!panel || !list) return;
  const rows = handRows();
  panel.hidden = rows.length === 0;
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'hq-row';
    const name = document.createElement('span');
    name.className = 'hq-name';
    name.textContent = row.self ? `${row.name} (you)` : row.name;
    li.appendChild(name);
    if (isAdmin(state.self) && !row.self) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hq-lower';
      b.textContent = 'lower';
      b.setAttribute('aria-label', `take the hand of ${row.name} down`);
      b.addEventListener('click', () => askLower(row.id));
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

// askLower asks one guest to take its own hand down. The request travels
// sealed to that guest, which lowers the hand and tells the room, so an admin
// can still clear a queue that nobody follows.
function askLower(id) {
  const peer = state.peers.get(id);
  if (peer) sealedSend(peer, { k: 'lower' });
}

// setCtrl writes the label of one toolbar button and its pressed state. The
// drawing sits in its own place left of the label, so only the label text and
// the pressed state change here.
function setCtrl(id, text, on) {
  const btn = $(id);
  const label = btn.querySelector('span');
  if (label) label.textContent = text;
  else btn.textContent = text;
  btn.setAttribute('aria-pressed', String(!!on));
}

export function updateButtons() {
  setCtrl('mic-btn', state.mic ? 'mic on' : 'mic off', state.mic);
  setCtrl('cam-btn', state.cam ? 'camera on' : 'camera off', state.cam);
  setCtrl('deaf-btn', state.deaf ? 'undeafen' : 'deafen', state.deaf);
  setCtrl('share-btn', state.screen ? 'stop share' : 'share screen', !!state.screen);
  setCtrl('hand-btn', state.hand ? 'lower hand' : 'raise hand', state.hand);
  $('mirror').checked = state.mirror;
  $('pip').checked = state.selfPip;
  $('voice-tiles').checked = !state.voiceTiles;
  // Without a microphone the switch still shows what the next microphone will
  // get, which is the stored choice. The model row follows that choice.
  $('noise-live').checked = state.micSource ? state.denoiseOn : state.noiseWanted;
  $('noise-engine').value = state.noiseEngine;
}

export function applyMirror() {
  const tile = ownTile();
  if (!tile) return;
  tile.classList.toggle('mirrored', state.mirror);
  layoutStage();
}
