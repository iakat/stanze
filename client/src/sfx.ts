/*
 The page's own sound effects.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { disconnectQuietly, stopQuietly } from './util.js';
import { newAudioCtx } from './audio.js';

// ---------------------------------------------------------------- sound effects
// The one-shot cues from sfx/<name>.<ext>, decoded once into a cache, plus a
// lost connection chime that loops. Ogg Opus first, WebM Opus next, an mp3
// copy last for a browser that can not decode either.
//
// Seven of them are the Jitsi Meet cues, so a room sounds like the one a guest
// knows: joining and leaving, a knock at the lobby, a hand going up, a chat
// line, and a microphone that turns on or off. The Jitsi files carry no sound
// for a connection that drops, so the pad and the two device cues below stay
// this page's own.
const SFX_NAMES = ['joined', 'left', 'knock', 'raisehand', 'msg', 'unmuted', 'muted', 'timp', 'hammer', 'lost'];

const SFX_RATE = 0.35;

// The pad sits under the room for as long as the socket is down, so it plays
// quieter than a one shot cue.
const LOST_RATE = 0.2;

// The lost cue loops the middle 8.0 s of the file.
const LOST_LOOP_START = 0.16;

const LOST_LOOP_END = 8.16;

export const sfxCache = new Map();

let sfxExt = '';

// pickSfxExt returns the first container the browser plays: Ogg Opus, then
// WebM Opus, then mp3.
function pickSfxExt() {
  if (sfxExt) return sfxExt;
  const probe = document.createElement('audio');
  const tries = [
    ['ogg', 'audio/ogg; codecs=opus'],
    ['webm', 'audio/webm; codecs=opus'],
    ['mp3', 'audio/mpeg'],
  ];
  for (const [ext, type] of tries) {
    if (probe.canPlayType && probe.canPlayType(type)) {
      sfxExt = ext;
      return ext;
    }
  }
  sfxExt = 'webm';
  return sfxExt;
}

export function ensureSfx() {
  if (!state.sfxCtx) state.sfxCtx = newAudioCtx();
}

// preloadSfx decodes the cues once, so a click never waits for a fetch.
export function preloadSfx() {
  ensureSfx();
  const ctx = state.sfxCtx;
  if (!ctx) return;
  const ext = pickSfxExt();
  for (const name of SFX_NAMES) {
    if (sfxCache.has(name)) continue;
    fetch(`sfx/${name}.${ext}`)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b))
      .then((buffer) => {
        sfxCache.set(name, buffer);
        // A lost connection may already have asked for the pad.
        if (name === 'lost' && state.lostWanted) startLost();
      })
      .catch(() => {});
  }
}

// playSfx plays one cue in full. A cue never waits in a line: it replaces the
// one that is playing, so the newest event is the one that is heard. The rate
// scales the cue's own gain, for a caller that wants it quieter.
export function playSfx(name, rate = 1) {
  if (!state.sounds) return;
  if (!state.sfxCtx || !SFX_NAMES.includes(name)) return;
  const ctx = state.sfxCtx;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const buffer = sfxCache.get(name);
  if (!buffer) {
    // Not decoded yet: this cue is dropped, the file is tiny and the next
    // click finds it ready.
    return;
  }
  stopSfx();
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = SFX_RATE * Math.max(0, Math.min(1, rate));
    src.connect(gain);
    gain.connect(ctx.destination);
    src.onended = () => {
      if (state.sfxSource === src) state.sfxSource = null;
    };
    state.sfxSource = src;
    src.start();
  } catch {
    // The context is gone; the next join builds a new one.
  }
}

// stopSfx cuts the one shot that plays now, if any.
export function stopSfx() {
  if (!state.sfxSource) return;
  stopQuietly(state.sfxSource);
  state.sfxSource = null;
}

// startLost loops the waiting chime while the signaling socket is down. A second
// call while it already plays does nothing, so reconnects never stack copies.
export function startLost() {
  // The wish stays, so a guest who switches the sound back on in the middle of
  // an outage hears the chime from then on.
  state.lostWanted = true;
  if (!state.sounds) return;
  if (state.lostSource) return;
  const ctx = state.sfxCtx;
  const buffer = sfxCache.get('lost');
  if (!ctx || !buffer) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    // The file has a little head and tail around the 8.0 s loop, so the codec
    // padding at the file edges stays outside the loop point: the pad runs on
    // with no gap and no click.
    if (buffer.duration >= LOST_LOOP_END) {
      src.loopStart = LOST_LOOP_START;
      src.loopEnd = LOST_LOOP_END;
    }
    const gain = ctx.createGain();
    gain.gain.value = LOST_RATE;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    state.lostSource = src;
    state.lostGain = gain;
  } catch {
    state.lostSource = null;
    state.lostGain = null;
  }
}

// setSounds is the switch for the cues and the lost connection chime. Off
// cuts whatever plays now.
export function setSounds(on) {
  state.sounds = on;
  const box = $('sounds');
  if (box) box.checked = on;
  if (!on) {
    if (state.sfxSource) {
      stopQuietly(state.sfxSource);
      state.sfxSource = null;
    }
    // Cut the pad but keep the wish for it.
    const wanted = state.lostWanted;
    stopLost();
    state.lostWanted = wanted;
  } else if (state.lostWanted) {
    startLost();
  }
}

// stopLost cuts the pad as soon as the client is connected again.
export function stopLost() {
  state.lostWanted = false;
  const src = state.lostSource;
  state.lostSource = null;
  if (state.lostGain) {
    disconnectQuietly(state.lostGain);
    state.lostGain = null;
  }
  if (!src) return;
  stopQuietly(src);
  disconnectQuietly(src);
}
