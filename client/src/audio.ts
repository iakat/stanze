/*
 The talking light, the remote audio graph and the noise
 suppression worklet.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { detachMedia, isAdmin, say } from './util.js';
import { layoutStage, ownTile, rowOf } from './tiles.js';
import { applyFlags, volGain } from './volume.js';
import { refreshSelf } from './devices.js';
import { sealedSend, toSealed } from './gate.js';

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

// makeDenoiseNode builds one GTCRN processor on one context. The microphone and
// every incoming stream that wants it own a node, because the filter state
// belongs to one stream.
async function makeDenoiseNode(ctx) {
  const [binary] = await Promise.all([noiseWasm(), ctx.audioWorklet.addModule('/gtcrn-node.js')]);
  return new AudioWorkletNode(ctx, 'gtcrn', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { wasm: new Uint8Array(binary) },
  });
}

// setNoise switches the microphone between the raw path and the GTCRN path.
// The output of the mixer does not change, so no peer is disturbed.
export async function setNoise(on) {
  if (!state.micSource || !state.audioCtx) {
    state.denoiseOn = false;
    return false;
  }
  if (on && !state.denoise) {
    try {
      // The wasm bytes travel in processorOptions: a worklet can only build a
      // module from bytes it already holds.
      state.denoise = await makeDenoiseNode(state.audioCtx);
      state.denoise.connect(state.micGain);
    } catch (err) {
      console.warn('noise suppression unavailable', err);
      state.denoise = null;
      state.denoiseOn = false;
      return false;
    }
  }
  try {
    state.micSource.disconnect();
  } catch {
    /* not connected */
  }
  if (on) {
    state.micSource.connect(state.denoise);
    state.denoiseOn = true;
  } else {
    state.micSource.connect(state.micGain);
    state.denoiseOn = false;
  }
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
export function ensurePlayback() {
  if (state.playCtx) {
    resumePlayback();
    return state.playCtx;
  }
  // Older Safari exposes only the prefixed constructor, which the DOM lib omits.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    state.playCtx = new Ctx({ latencyHint: 'interactive' });
  } catch {
    state.playCtx = null;
    return null;
  }
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
  if (peer.inNoise) void setPeerNoise(peer, true);
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
    try {
      peer.inDenoise.disconnect();
    } catch {
      /* already gone */
    }
  }
  if (peer.audioSrc) {
    try {
      peer.audioSrc.disconnect();
    } catch {
      /* already gone */
    }
    peer.audioSrc = null;
  }
  if (peer.meter) {
    try {
      peer.meter.disconnect();
    } catch {
      /* already gone */
    }
    peer.meter = null;
  }
  if (peer.gain) {
    try {
      peer.gain.disconnect();
    } catch {
      /* already gone */
    }
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
  try {
    peer.audioSrc.disconnect();
  } catch {
    /* not connected */
  }
  if (peer.inDenoise) {
    try {
      peer.inDenoise.disconnect();
    } catch {
      /* not connected */
    }
  }
  if (peer.inNoise && peer.inDenoise) {
    peer.audioSrc.connect(peer.inDenoise);
    peer.inDenoise.connect(peer.gain);
  } else {
    peer.audioSrc.connect(peer.gain);
  }
  if (peer.meter) peer.audioSrc.connect(peer.meter);
}

// setPeerNoise turns the local noise cancel of one incoming stream on or off.
// The processor is built on first use; a browser without Web Audio says so.
export async function setPeerNoise(peer, on) {
  if (!peer) return;
  if (on) {
    const ctx = state.playCtx || ensurePlayback();
    if (!ctx) {
      say('this browser can not cancel noise without Web Audio');
      return;
    }
    if (!peer.inDenoise) {
      try {
        peer.inDenoise = await makeDenoiseNode(ctx);
      } catch (err) {
        console.warn('noise cancel unavailable', err);
        say('the local noise cancel is not available in this browser');
        return;
      }
    }
  }
  peer.inNoise = on;
  wirePlayNoise(peer);
}

// stateFrame is the one sealed message that carries the flags of this guest.
// It goes to every pair separately, so the server relays an opaque blob and
// keeps none of the values.
function stateFrame() {
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
  };
}

// sendState tells the room that the microphone, the camera, the hand or the
// share changed. Every guest gets its own sealed copy, and the own tile is
// painted here, because no server echoes the flags back.
export function sendState() {
  refreshSelf();
  if (!state.self || state.leaving) return;
  toSealed(stateFrame());
}

// sealedSendState hands the current flags to one pair that has just proved the
// passphrase, so a guest that joins later still learns the toggles.
export function sealedSendState(peer) {
  if (!peer.keys || peer.waiting) return;
  sealedSend(peer, stateFrame());
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
  // get, which is the stored choice.
  $('noise-live').checked = state.micSource ? state.denoiseOn : state.noiseWanted;
}

export function applyMirror() {
  const tile = ownTile();
  if (!tile) return;
  tile.classList.toggle('mirrored', state.mirror);
  layoutStage();
}
