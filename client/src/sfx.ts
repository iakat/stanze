/*
 The page's own sound effects.
*/

import { state } from './state.js';

// ---------------------------------------------------------------- sound effects
// Four one-shot cues from sfx/<name>.<ext>, decoded once into a cache, plus a
// lost connection chime that loops. Ogg Opus first, WebM Opus next, an mp3 copy
// last for a browser that can not decode either.
export const SFX_NAMES = ['pop', 'bonk', 'timp', 'hammer', 'lost'];

export const SFX_RATE = 0.35;

// The pad sits under the room for as long as the socket is down, so it plays
// quieter than a one shot cue.
export const LOST_RATE = 0.2;

// The lost cue loops the middle 8.0 s of the file.
export const LOST_LOOP_START = 0.16;

export const LOST_LOOP_END = 8.16;

export const sfxCache = new Map();

export let sfxExt = '';

// pickSfxExt returns the first container the browser plays: Ogg Opus, then
// WebM Opus, then mp3.
export function pickSfxExt() {
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
  if (state.sfxCtx) return;
  // Safari exposes only the prefixed constructor, which the DOM lib omits.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    state.sfxCtx = new Ctx();
  } catch {
    state.sfxCtx = null;
  }
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
// one that is playing, so the newest event is the one that is heard.
export function playSfx(name) {
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
  if (state.sfxSource) {
    try {
      state.sfxSource.stop();
    } catch {
      /* already finished */
    }
    state.sfxSource = null;
  }
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = SFX_RATE;
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

// setSounds is the switch for the four cues and the lost connection chime. Off
// cuts whatever plays now, and the body carries the state for the stylesheet.
export function setSounds(on) {
  state.sounds = on;
  document.body.dataset.sounds = on ? 'on' : 'off';
  const box = document.getElementById('sounds') as HTMLInputElement | null;
  if (box) box.checked = on;
  if (!on) {
    if (state.sfxSource) {
      try {
        state.sfxSource.stop();
      } catch {
        /* already finished */
      }
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
    try {
      state.lostGain.disconnect();
    } catch {
      /* already gone */
    }
    state.lostGain = null;
  }
  if (!src) return;
  try {
    src.stop();
  } catch {
    /* already finished */
  }
  try {
    src.disconnect();
  } catch {
    /* already gone */
  }
}
