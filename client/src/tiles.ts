/*
 The stage: one tile per peer, the row list, the corner layout, the
 spotlight and the volume slider.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { load, store } from './prefs.js';
import { wireAdmit, wireDots } from './host.js';
import { updateButtons } from './audio.js';

// ---------------------------------------------------------------- tiles
// rowOf maps a tile to its row in the list of members. Both nodes live for as
// long as the tile does, so the map is weak and carries no name of its own.
export const rowOf = new WeakMap();

// paintName keeps the small tag and the large centre label in step. The centre
// label carries the whole name, so a guest without a camera is not a pair of
// letters.
export function paintName(tile, name, local) {
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = name || '?';
  tile.setAttribute('aria-label', local ? `${name}, you` : name);
  paintRowName(rowOf.get(tile), name, local);
}

// paintRowName keeps the label of a list row in step with the label of its
// tile. A guest that names itself once the keys are proven shows the name in
// both places at the same moment.
export function paintRowName(row, name, local) {
  if (!row) return;
  row.querySelector('.row-name').textContent = local ? `${name} (you)` : name;
  row.setAttribute('aria-label', local ? `${name}, you` : name);
}

// paintRowDeaf shows the deafened drawing on the list row of one member. The
// row is the only place that carries the state: a deaf member hears nothing
// and sends nothing, and every other member sees that on their list.
export function paintRowDeaf(row, deaf) {
  if (!row) return;
  const mark = row.querySelector('.row-deaf');
  if (mark) mark.hidden = !deaf;
}

// paintRowHand shows the raised hand of one member on its row. The queue panel
// carries the order; the row only says that this hand is up.
export function paintRowHand(row, hand) {
  if (!row) return;
  const mark = row.querySelector('.row-hand');
  if (mark) mark.hidden = !hand;
}

// tileId is the spotlight key of one tile: the peer id, or 'self'. The screen
// tile of a guest carries ':screen', so each picture is its own key.
export function tileId(tile) {
  const id = tile.dataset.peer || (tile.dataset.local ? 'self' : '');
  return id && tile.dataset.screen ? id + ':screen' : id;
}

// makeTile builds one picture. A screen tile is the second picture of a guest:
// it has no row and no volume of its own, because the row of the guest already
// carries both.
export function makeTile(id, name, local = false, screen = false) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.state = 'new';
  if (local && !screen) tile.dataset.local = 'yes';
  if (local && screen) tile.dataset.local = 'screen';
  if (screen) {
    tile.dataset.screen = 'yes';
    tile.classList.add('screenshare');
  }
  const plain = local || screen;
  // The tile is a focus stop: Enter or Space on it enlarges that guest, the
  // same as a click. The controls on it show on hover, on focus and, on a
  // touch screen, after a tap.
  tile.tabIndex = 0;
  tile.setAttribute('role', 'group');
  tile.innerHTML = `
    <video autoplay playsinline${local ? ' muted' : ''}></video>
    <div class="avatar"></div>
    <span class="ring" aria-hidden="true"></span>
    ${
      plain
        ? ''
        : `<div class="vol">
      <img class="vol-ico" src="/openmoji/1F50A.svg" alt="" width="16" height="16">
      <input class="vol-range" type="range" min="0" max="200" step="5" value="100" aria-label="volume of this participant">
      <span class="vol-num">100%</span>
    </div>`
    }
    <button class="zoom" type="button" aria-pressed="false" aria-label="enlarge this picture" title="enlarge"></button>
    <div class="tag"><span class="name"></span><span class="flags"></span><span class="state"></span>${plain ? '' : '<span class="route" title="the media goes through the relay server">relay</span><span class="pin" hidden></span>'}</div>
    ${plain ? '' : '<button class="admit" type="button" title="let this guest into the room">let in</button><button class="dots" type="button" aria-label="member actions">&#8943;</button><div class="menu" hidden></div>'}`;
  paintName(tile, name, local && !screen);
  // A remote guest is heard through its own gain node, so the video element
  // only ever carries pictures and stays muted.
  if (!local) tile.querySelector('video').muted = true;
  if (!plain) wireDots(tile);
  if (!plain) wireAdmit(tile);
  tile.addEventListener('keydown', (event) => {
    if (event.target !== tile || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const id = tileId(tile);
    if (id) setSpotlight(id);
  });
  $('stage-main').appendChild(tile);
  if (!screen) rowOf.set(tile, makeRow(id, name, local));
  return tile;
}

// makeRow builds the list row of one member. Every member has one, with a
// picture or without: the picture stays in the large area and the row carries
// the name, the two lamps and the volume slider. The row is one line and the
// slider is always open, so a pointer that crosses it never moves the stage.
export function makeRow(id, name, local = false) {
  const row = document.createElement('div');
  row.className = 'plist-row';
  if (local) row.dataset.local = 'yes';
  else row.dataset.peer = id;
  row.dataset.state = 'new';
  row.dataset.mic = 'on';
  row.tabIndex = 0;
  row.setAttribute('role', 'group');
  row.innerHTML = `<span class="row-name"></span><span class="row-deaf" hidden><img src="/openmoji/1F507.svg" alt="deafened" title="deafened" width="16" height="16"></span><span class="row-hand" hidden>hand</span>${
    local
      ? '<span class="row-you">you</span>'
      : `
    <input class="vol-range" type="range" min="0" max="200" step="5" value="100" aria-label="volume of this participant">
    <span class="vol-num">100%</span>
    <button class="admit" type="button" title="let this guest into the room">let in</button>
    <button class="dots" type="button" aria-label="member actions">&#8943;</button>`
  }`;
  paintRowName(row, name, local);
  if (!local) {
    wireDots(row);
    wireAdmit(row);
  }
  row.addEventListener('keydown', (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const id = tileId(row);
    if (id) setSpotlight(id);
  });
  $('stage-rail').appendChild(row);
  return row;
}

// ---------------------------------------------------------------- stage layout
export let localTile = null; // the own preview tile, made once per room
// The tile is made in one place and dropped in another, so the two write it
// through this setter; a plain imported binding cannot be assigned.
export function setLocalTile(tile) {
  localTile = tile;
}

export function ownTile() {
  return localTile && localTile.isConnected ? localTile : null;
}

// stageTiles is every tile in a stable order: the own preview first, then the
// guests in the order they joined. The order of the two zones follows it, so a
// relayout never reshuffles the room. A shared screen is its own tile and stands
// right after the picture of the guest that shares it.
export function stageTiles() {
  const out = [];
  const self = ownTile();
  if (self) out.push(self);
  if (state.screenTile) out.push(state.screenTile);
  for (const peer of state.peers.values()) {
    if (peer.tile) out.push(peer.tile);
    if (peer.screenTile) out.push(peer.screenTile);
  }
  return out;
}

// tileHasPicture answers "does this tile show a moving picture now". A camera
// that is off, a track that the sender muted and a track that stopped all say
// no, and that guest belongs in the rail as a row. A screen tile needs a
// decoded frame too: its receiver track exists from the negotiation on, so the
// live flag alone would show an empty box.
export function tileHasPicture(tile) {
  if (!tile || tile.classList.contains('camoff')) return false;
  const video = tile.querySelector('video');
  const stream = video && video.srcObject;
  if (!stream || typeof stream.getVideoTracks !== 'function') return false;
  const live = stream.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
  return live && (!tile.dataset.screen || video.videoWidth > 0);
}

// spotlightTile is the one tile that holds the large area while the spotlight
// is on. A guest that left takes the spotlight with it, and a screen tile is
// its own key.
export function spotlightTile() {
  if (!state.spotlight) return null;
  if (state.spotlight === 'self') return ownTile();
  const screen = state.spotlight.endsWith(':screen');
  const id = screen ? state.spotlight.slice(0, -7) : state.spotlight;
  if (id === 'self') return document.querySelector('.tile[data-local="screen"]');
  for (const peer of state.peers.values()) {
    if (peer.id !== id) continue;
    return screen ? peer.screenTile : peer.tile;
  }
  return null;
}

// ---------------------------------------------------------------- corners
// A stage with two pictures puts one guest small in a corner. A corner is two
// letters, the vertical side first and then the horizontal one, and the own
// preview gives way to the guest by taking the opposite corner while it is on.
export const CORNERS = ['tl', 'tr', 'bl', 'br'];

export const OPPOSITE_CORNER = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };

export const cornerCall = new Map(); // peer id -> corner, this call only

export let cornerDropAt = 0; // when a drag ended, so its click is not a zoom

// peerOfTile is the peer record of one tile, or null for the own tile.
export function peerOfTile(tile) {
  const id = tile && tile.dataset.peer;
  return id && state.peers ? state.peers.get(id) || null : null;
}

// storedCorner reads the kept place of one guest. A guest that proved its key
// keeps it on the disk under the fingerprint, the same key as its volume; a
// guest without a key keeps it for this call only. The default is the bottom
// right corner, where the own preview also sits.
export function storedCorner(peer) {
  const raw =
    peer && peer.fp ? load(`corner.fp.${peer.fp}`) : peer ? cornerCall.get(peer.id) || '' : '';
  return CORNERS.includes(raw) ? raw : 'br';
}

export function saveCorner(peer, corner) {
  if (!peer || !CORNERS.includes(corner)) return;
  cornerCall.set(peer.id, corner);
  if (peer.fp) store(`corner.fp.${peer.fp}`, corner);
}

// layoutStage picks the tiles that hold the large area and keeps the list of
// members in step. A tile keeps its node, so its video element keeps its stream
// and its sliders keep their listener. Without a spotlight, the tiles with a
// picture take the large area; a tile without one stays out of the frame,
// because its row in the list already names the guest, unless the voice-only
// switch is on, which is the default: then it holds a tile with its avatar and
// its name in the size of a picture tile. A guest that still waits stays in
// the rail.
// The list is a block of reserved height that scrolls, so no tile and no row
// can move the stage.
export function layoutStage() {
  const main = $('stage-main');
  const rail = $('stage-rail');
  const pipBox = $('self-pip');
  const cornerBox = $('guest-pip');
  if (!main || !rail) return;
  const spot = spotlightTile();
  if (state.spotlight && !spot) state.spotlight = '';
  const self = ownTile();
  // The own picture is a small preview while the switch is on. The node is
  // moved, never copied, so the preview keeps the own stream and the mirror.
  const pip = !!(self && pipBox && state.selfPip);
  if (pipBox) pipBox.hidden = !pip;
  if (self && pip && self.parentElement !== pipBox) pipBox.appendChild(self);
  if (self && !pip && self.parentElement !== main) main.appendChild(self);
  // Two pictures and no spotlight: the later guest sits small in a corner and
  // the other one keeps the whole frame. The small tile keeps its node too.
  const bigs = [];
  for (const tile of stageTiles()) {
    const inPip = pip && tile === self;
    // A screen tile without a picture has nothing to show: it leaves the stage
    // instead of standing there as a name.
    const voice = state.voiceTiles && !tile.dataset.waiting && !tile.dataset.screen;
    const big = !inPip && (spot ? tile === spot : tileHasPicture(tile) || voice);
    if (big) bigs.push(tile);
    tile.hidden = inPip ? false : !big;
    const on = big && !!spot;
    tile.classList.toggle('spot', on);
    const row = rowOf.get(tile);
    if (row) row.classList.toggle('spot', on);
    const zoom = tile.querySelector('.zoom');
    if (zoom) {
      zoom.setAttribute('aria-pressed', String(on));
      zoom.setAttribute('aria-label', on ? 'back to the grid' : 'enlarge this picture');
      zoom.title = on ? 'back to the grid' : 'enlarge';
    }
  }
  // The small corner goes to a person, not to a screen: a shared screen needs
  // the whole frame.
  const small = !spot && !pip && bigs.length === 2 ? bigs.find((t) => !t.dataset.screen) : null;
  if (cornerBox) {
    cornerBox.hidden = !small;
    for (const tile of stageTiles()) {
      if (tile !== small && tile.parentElement === cornerBox) main.appendChild(tile);
    }
    if (small && small.parentElement !== cornerBox) cornerBox.appendChild(small);
    if (small) {
      const corner = storedCorner(peerOfTile(small));
      cornerBox.dataset.corner = corner;
      // The own preview gives way to the guest: it takes the opposite corner.
      if (pip && pipBox) pipBox.dataset.corner = OPPOSITE_CORNER[corner];
    } else if (pipBox) {
      pipBox.removeAttribute('data-corner');
    }
  }
  const alone = bigs.length - (small ? 1 : 0) === 1 ? 'yes' : 'no';
  if (main.dataset.alone !== alone) main.dataset.alone = alone;
  main.hidden = bigs.length - (small ? 1 : 0) === 0;
}

// wireCornerDrag lets the small guest tile of a two person stage follow the
// pointer and snap to the nearest of the four corners when it is let go. A
// pointer that stays put does not start a drag, so a click on the tile keeps
// its meaning and enlarges that guest.
export function wireCornerDrag() {
  const box = $('guest-pip');
  const grid = $('grid');
  if (!box || !grid) return;
  let drag = null as any;
  box.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest('.vol, .vol-range, .vol-num, .dots, .menu, .sas, .pin, .admit, .zoom'))
      return;
    const rect = box.getBoundingClientRect();
    const frame = grid.getBoundingClientRect();
    if (!frame.width || !frame.height) return;
    drag = {
      id: event.pointerId,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      w: rect.width,
      h: rect.height,
      frame,
      moved: false,
    };
    try {
      box.setPointerCapture(event.pointerId);
    } catch {
      /* no capture */
    }
  });
  box.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) < 4 && Math.abs(event.clientY - drag.startY) < 4)
        return;
      drag.moved = true;
      box.classList.add('dragging');
      box.style.width = `${drag.w}px`;
      box.style.height = `${drag.h}px`;
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    }
    const frame = drag.frame;
    const x = Math.min(
      Math.max(event.clientX - drag.grabX - frame.left, 0),
      Math.max(0, frame.width - drag.w),
    );
    const y = Math.min(
      Math.max(event.clientY - drag.grabY - frame.top, 0),
      Math.max(0, frame.height - drag.h),
    );
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    const frame = drag.frame;
    const rect = box.getBoundingClientRect();
    drag = null;
    try {
      box.releasePointerCapture(event.pointerId);
    } catch {
      /* already gone */
    }
    box.classList.remove('dragging');
    box.style.width = '';
    box.style.height = '';
    box.style.left = '';
    box.style.top = '';
    box.style.right = '';
    box.style.bottom = '';
    if (!moved) return;
    // The nearest corner wins: the side of each middle line that holds the
    // centre of the tile.
    const right = rect.left + rect.width / 2 > frame.left + frame.width / 2;
    const bottom = rect.top + rect.height / 2 > frame.top + frame.height / 2;
    const corner = `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`;
    saveCorner(peerOfTile(box.querySelector('.tile')), corner);
    box.dataset.corner = corner;
    if (state.selfPip && $('self-pip')) $('self-pip').dataset.corner = OPPOSITE_CORNER[corner];
    cornerDropAt = Date.now();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// setSpotlight puts one guest alone in the large area, or ends the spotlight
// when that guest already holds it.
export function setSpotlight(id) {
  // The own picture is a preview now, so asking for it puts it back in the
  // grid instead of leaving an empty stage behind.
  if (id === 'self' && state.selfPip) {
    state.selfPip = false;
    store('selfpip', 0);
    updateButtons();
    state.spotlight = '';
    layoutStage();
    return;
  }
  state.spotlight = id && state.spotlight !== id ? id : '';
  for (const open of document.querySelectorAll('.tile.ctl')) open.classList.remove('ctl');
  layoutStage();
}
