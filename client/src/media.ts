/*
 The camera and screen requests, the performance step and the sender
 bitrate and frame ceilings.
*/

import { PERF, QUALITY } from './config.js';
import { state } from './state.js';
import { say } from './util.js';
import { lookResize, lookTrack } from './look.js';

// ---------------------------------------------------------------- media
export const MIC_AUDIO = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };

// qualityNow is the chosen step, with its encoder ceiling, or the default for a
// value this build does not know (a stored string from an older page).
function qualityNow() {
  return QUALITY[state.quality] || QUALITY['1280x720@30'];
}

// perfNow is the chosen performance step, full quality for an unknown value.
function perfNow() {
  return PERF[state.perf] || PERF[0];
}

// evenPx scales a side and keeps it even, which every encoder accepts.
function evenPx(n, scale) {
  return scale === 1 ? n : Math.max(2, Math.round((n * scale) / 2) * 2);
}

// perfFps is the frame rate the camera sends at the chosen steps.
function perfFps(q, p) {
  return p.fps ? Math.min(q.fps, p.fps) : q.fps;
}

// videoFor builds one video request from a quality step and a performance step.
function videoFor(q, p) {
  const w = evenPx(q.w, p.scale);
  const h = evenPx(q.h, p.scale);
  const fps = perfFps(q, p);
  return {
    width: { ideal: w, max: w },
    height: { ideal: h, max: h },
    frameRate: { ideal: fps, max: fps },
  };
}

// camVideo builds the camera request for the chosen steps. The join and every
// later camera switch go through it, so the performance step sets the size the
// camera itself delivers, not only what the encoder does with it.
export function camVideo() {
  return videoFor(qualityNow(), perfNow());
}

// shareVideo is the screen share request. A shared screen is read as text, so
// it has a step of its own and never takes the performance step.
export function shareVideo() {
  return videoFor(QUALITY[state.shareQuality] || QUALITY['1920x1080@30'], PERF[0]);
}

// perfText says what the chosen step sends, in words and in numbers.
function perfText() {
  const q = qualityNow();
  const p = perfNow();
  const v = videoFor(q, p);
  return `${p.name}: camera ${v.width.ideal}x${v.height.ideal} at ${v.frameRate.ideal} frames, up to ${Math.round((q.max * p.bits) / 1000)} kbit/s. Sound is not changed.`;
}

// paintPerf shows the step on both sliders, the one in the form and the one in
// the toolbar, so the two can never disagree.
export function paintPerf() {
  for (const id of ['perf', 'perf-live']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    // The slider runs from the minimum on the left to the full quality on the
    // right, so the stored step is turned round for it.
    if (el) el.value = String(PERF.length - 1 - state.perf);
  }
  for (const id of ['perf-text', 'perf-live-text']) {
    const el = document.getElementById(id);
    if (!el) continue;
    // The toolbar has room for the name only; the form carries the numbers.
    el.textContent = id === 'perf-text' ? perfText() : perfNow().name;
  }
}

// ask opens one getUserMedia request and never throws, so the join can always
// go on with whatever the browser gives.
export async function ask(constraints) {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(constraints) };
  } catch (err) {
    return { err };
  }
}

// capVideoSender sets the encoder ceiling on one video sender. The parameters
// come back from the sender and are copied, because a sender refuses a reused
// object. A sender has no encodings until its description exists, so an empty
// list is skipped; the same call runs again when the pair connects.
export async function capVideoSender(sender) {
  if (!sender || !sender.getParameters || !sender.setParameters) return true;
  let params;
  try {
    params = sender.getParameters();
  } catch {
    return true;
  }
  if (!params || !Array.isArray(params.encodings) || params.encodings.length === 0) return true;
  const q = qualityNow();
  const p = perfNow();
  // Step 0 sets the same ceiling and no frame cap, which is the default path.
  const max = Math.round(q.max * p.bits);
  const fps = p.fps ? perfFps(q, p) : 0;
  const next = {
    ...params,
    encodings: params.encodings.map((enc) => {
      const out = { ...enc, maxBitrate: max };
      if (fps) out.maxFramerate = fps;
      else delete out.maxFramerate;
      return out;
    }),
  };
  try {
    await sender.setParameters(next);
    return true;
  } catch {
    return false;
  }
}

// capCameraSenders caps every sender that carries the camera. The screen share
// sender is left alone, because the share keeps its own quality.
export function capCameraSenders(pc) {
  if (!pc || !state.camTrack) return;
  const drawn = lookTrack();
  for (const sender of pc.getSenders()) {
    if (sender.track !== state.camTrack && sender.track !== drawn) continue;
    capVideoSender(sender);
  }
}

// applyQuality pushes the chosen steps into the live camera: the raw track gets
// the new size and frame rate, and every peer's encoder the matching ceiling.
// The screen share carries its own quality and is not touched.
export async function applyQuality() {
  let refused = false;
  const track = state.camTrack;
  if (track && track.readyState === 'live') {
    try {
      await track.applyConstraints(camVideo());
    } catch {
      refused = true;
    }
  }
  for (const peer of state.peers.values()) {
    if (!peer.pc) continue;
    const drawn = lookTrack();
    for (const sender of peer.pc.getSenders()) {
      if (!sender.track || (sender.track !== track && sender.track !== drawn)) continue;
      if (!(await capVideoSender(sender))) refused = true;
    }
  }
  lookResize();
  if (refused) say('the browser refused the new camera quality; the old one stays in effect');
}
