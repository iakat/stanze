/*
 Screen share.
*/

import { state } from './state.js';
import { say } from './util.js';
import { layoutStage, makeTile } from './tiles.js';
import { shareVideo } from './media.js';
import { resumeAudio, sendState, updateButtons } from './audio.js';
import { sealingAvailable } from './sealed.js';

// ---------------------------------------------------------------- screen share
// replaceScreenTrack points the screen sender of every peer at the display
// track, or at nothing. The camera sender is not touched, so the two pictures
// travel side by side and a share needs no renegotiation.
async function replaceScreenTrack(track) {
  for (const peer of state.peers.values()) {
    const tr = peer.tx && peer.tx.screen;
    if (tr && !peer.waiting) await tr.sender.replaceTrack(track || null).catch(() => {});
  }
}

export async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    say('screen sharing is not supported by this browser');
    return;
  }
  if (!sealingAvailable() || !state.worker) {
    say('this browser cannot seal media frames, so screen sharing stays off');
    return;
  }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: shareVideo(), audio: true });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return;
    say('screen sharing failed');
    return;
  }
  state.screen = display;
  const video = display.getVideoTracks()[0];
  if (video) {
    video.contentHint = 'detail';
    video.addEventListener('ended', () => stopShare());
    await replaceScreenTrack(video);
    // The screen gets its own tile, so the own camera keeps its picture, its
    // mirror and its badge.
    const tile = makeTile(state.name, state.name, true, true);
    tile.dataset.state = 'connected';
    tile.querySelector('.state').textContent = 'your screen';
    tile.classList.add('playing');
    const el = tile.querySelector('video');
    el.srcObject = display;
    el.play().catch(() => {});
    // A capture on a slow display gives its first frame after this function
    // returns; the own tile waits for it like a guest's, or the sharer sees
    // nothing of the screen that everyone else sees.
    el.addEventListener('resize', () => layoutStage());
    el.addEventListener('loadedmetadata', () => layoutStage());
    state.screenTile = tile;
  }
  const audio = display.getAudioTracks()[0];
  if (audio && state.audioCtx) {
    state.screenSource = state.audioCtx.createMediaStreamSource(new MediaStream([audio]));
    state.screenSource.connect(state.mixer);
    resumeAudio();
  }
  sendState();
  layoutStage();
  updateButtons();
}

export async function stopShare() {
  if (!state.screen) return;
  for (const track of state.screen.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
  if (state.screenSource) {
    try {
      state.screenSource.disconnect();
    } catch {
      /* not connected */
    }
    state.screenSource = null;
  }
  state.screen = null;
  sendState();
  await replaceScreenTrack(null);
  if (state.screenTile) {
    state.screenTile.remove();
    state.screenTile = null;
  }
  layoutStage();
  updateButtons();
}
