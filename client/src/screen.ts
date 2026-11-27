/*
 Screen share.
*/

import { state } from './state.js';
import { disconnectQuietly, say, stopTracks } from './util.js';
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

// A share ends once: the track that stops fires `ended`, and the guest can
// also press the stop switch. One handler runs one stopShare, and stopShare
// takes it off before it stops the tracks, so the second path finds nothing.
let shareEnded: (() => void) | null = null;

function releaseShareEnded(video) {
  if (!shareEnded || !video) return;
  video.removeEventListener('ended', shareEnded);
  shareEnded = null;
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
    releaseShareEnded(video);
    shareEnded = () => stopShare();
    video.addEventListener('ended', shareEnded, { once: true });
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
  // The listener goes before the tracks stop: an `ended` from them finds no
  // handler and can not start a second stopShare on the share that is going.
  const video = state.screen.getVideoTracks()[0];
  releaseShareEnded(video);
  stopTracks(state.screen);
  if (state.screenSource) {
    disconnectQuietly(state.screenSource);
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
