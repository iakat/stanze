/*
 Per peer volume, remembered by identity when one is pinned.
*/

import { state } from './state.js';
import { load, store } from './prefs.js';
import { layoutStage, paintRowHand, rowOf } from './tiles.js';
import { handPlace } from './audio.js';

// ---------------------------------------------------------------- volume
// The volume of one participant is a percent from 0 (silent) to 200. It is
// kept under the key fingerprint of a peer that proved its key, never under a
// name, so a machine that several people use keeps no list of who was called.
// A peer without a proven key keeps its setting in memory for this call only.
export const volCall = new Map(); // peer id -> percent, this call only

// purgeNamedVolume deletes the keys of older builds, which held the guest name
// in the key itself. A machine that ran one of them loses that list now.
export function purgeNamedVolume() {
  if (!window.localStorage) return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('rooms.vol.') && !key.startsWith('rooms.vol.fp.'))
        localStorage.removeItem(key);
    }
  } catch {
    /* private mode */
  }
}

// The slider is a position, not an amplitude. Loudness is heard on a log scale,
// so a straight line from 0 to 2 in amplitude puts all the change at the
// bottom and almost none at the top. The gain is a power of the position:
// position 100 is unity, and every 50 points of travel is about 10 dB, which
// the ear takes for half or double the loudness. 0 is silence, 200 is +10 dB.
// What is stored is the position, the same percent as before.
export const VOL_MAX = 200;

export const VOL_EXP = 5 / 3; // 2^(5/3) is 3.17, +10 dB

// volGain turns a slider position (0 to 200) into the gain of the node.
export function volGain(pos) {
  const n = Number(pos);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.pow(Math.min(n, VOL_MAX) / 100, VOL_EXP);
}

// storedVolume reads the kept percent of one peer: from the disk under its
// fingerprint once that key is proven, and from memory before that.
export function storedVolume(peer) {
  const raw = peer && peer.fp ? load(`vol.fp.${peer.fp}`) : '';
  const n = parseInt(raw || (peer ? volCall.get(peer.id) : ''), 10);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(200, n));
}

// saveVolume keeps the percent of one peer. A proven guest is remembered on
// the disk by fingerprint; a guest without a key lives for this call only.
export function saveVolume(peer) {
  if (!peer) return;
  volCall.set(peer.id, peer.vol);
  if (peer.fp) store(`vol.fp.${peer.fp}`, peer.vol);
}

// volumePairs is every slider of one peer: the one on its tile and the one on
// its row. Both write the one peer.vol, so the two can never disagree.
export function volumePairs(peer) {
  const out = [];
  for (const host of [peer.tile, rowOf.get(peer.tile)]) {
    const range = host ? host.querySelector('.vol-range') : null;
    const num = host ? host.querySelector('.vol-num') : null;
    if (range && num) out.push({ range, num });
  }
  return out;
}

// paintVolume draws the percent of one peer on its sliders, its labels and the
// live gain. It is called when a slider moves, and again when a sealed guest
// tells us the name that its stored volume is kept under.
export function paintVolume(peer) {
  for (const { range, num } of volumePairs(peer)) {
    num.textContent = `${peer.vol}%`;
    range.value = String(peer.vol);
  }
  const g = state.deaf ? 0 : volGain(peer.vol);
  if (peer.gain) peer.gain.gain.value = g;
  // The element path is only a fallback and can not go over unity.
  if (peer.audioEl) peer.audioEl.volume = Math.min(g, 1);
}

// wireVolume connects the tile slider and the row slider of one peer to the
// one value. The gain and the labels are painted from peer.vol, which the audio
// path and both sliders share.
export function wireVolume(peer) {
  for (const { range } of volumePairs(peer)) {
    range.addEventListener('input', () => {
      const n = parseInt(range.value, 10);
      peer.vol = Number.isFinite(n) ? Math.max(0, Math.min(200, n)) : 100;
      paintVolume(peer);
      saveVolume(peer);
    });
  }
  paintVolume(peer);
}

// applyFlags shows the mute and camera state of one tile. A tile with neither
// flag shows nothing extra.
export function applyFlags(tile, mic, cam, admin) {
  if (!tile) return;
  // A camera that is off must show the centre name again. The last frame of a
  // disabled track is black, so the tile can not stay in the playing state.
  tile.classList.toggle('camoff', cam === false);
  tile.dataset.mic = mic === false ? 'off' : 'on';
  // The row of this member shows the same two lamps and the same picture state.
  const row = rowOf.get(tile);
  if (row) {
    row.dataset.mic = mic === false ? 'off' : 'on';
    row.classList.toggle('camoff', cam === false);
  }
  // A guest that waits is marked on its tile and its row, and a member sees the
  // let in button there; the CSS shows it. The button belongs to a room that is
  // really holding guests, so a stale held flag can not leave one behind in a
  // room whose switch is off.
  const who = tile.dataset.peer ? state.peers.get(tile.dataset.peer) : null;
  const waiting = who
    ? !!(who.waiting && state.waitingRoom)
    : !!(tile.dataset.local && state.waiting);
  tile.dataset.waiting = waiting ? 'yes' : '';
  if (row) row.dataset.waiting = waiting ? 'yes' : '';
  const box = tile.querySelector('.flags');
  // A raised hand is on the tile with its place in the queue, and on the row
  // of the same member, so a small picture still shows it.
  const handOn = who ? !!who.hand : !!(tile.dataset.local && state.hand);
  const place = handOn ? handPlace(who ? who.id : state.self) : 0;
  paintRowHand(row, handOn);
  if (!box) return;
  const out = [];
  if (waiting) out.push('waiting');
  if (admin) out.push('host');
  if (mic === false) out.push('muted');
  if (cam === false) out.push('no cam');
  if (handOn) out.push(place ? `hand #${place}` : 'hand');
  box.innerHTML = '';
  for (const text of out) {
    const chip = document.createElement('span');
    chip.textContent = text;
    box.appendChild(chip);
  }
  // The camera flag decides the zone of this tile: a picture goes to the large
  // area, a row without one goes to the rail.
  layoutStage();
}
