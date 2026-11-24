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
// rowOf maps a tile to its row in the member list. Both nodes live as long as
// the tile, so the map is weak.
export const rowOf = new WeakMap();

// paintName keeps the small tag and the large centre label in step: the centre
// label carries the whole name, so a guest without a camera is not a pair of
// letters.
export function paintName(tile, name, local) {
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = name || '?';
  tile.setAttribute('aria-label', local ? `${name}, you` : name);
  paintRowName(rowOf.get(tile), name, local);
}

// paintRowName keeps the label of a list row in step with its tile, so a guest
// that names itself once the keys are proven shows it in both places at once.
function paintRowName(row, name, local) {
  if (!row) return;
  row.querySelector('.row-name').textContent = local ? `${name} (you)` : name;
  row.setAttribute('aria-label', local ? `${name}, you` : name);
}

// paintRowDeaf shows the deafened mark on a member row: a deaf member hears and
// sends nothing, so the row is the only place for it.
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

// el builds one element from a tag, its attributes and its children, so no
// markup is parsed from a string. A true attribute is set with no value.
function el(
  tag: string,
  attrs: Record<string, string | number | boolean> = {},
  ...kids: (Node | string)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids) node.append(kid);
  return node;
}

// the small pickers that a remote guest carries on its tile and on its row
function volRange(): HTMLElement {
  return el('input', {
    class: 'vol-range',
    type: 'range',
    min: 0,
    max: 200,
    step: 5,
    value: 100,
    'aria-label': 'volume of this participant',
  });
}
function lineButton(): HTMLElement[] {
  return [
    el(
      'button',
      { class: 'admit', type: 'button', title: 'let this guest into the room' },
      'let in',
    ),
    el('button', { class: 'dots', type: 'button', 'aria-label': 'member actions' }, '\u22ef'),
  ];
}

// makeTile builds one picture. A screen tile has no row and no volume of its
// own, because the row of the guest already carries both.
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
  tile.append(
    el(
      'video',
      local
        ? { autoplay: true, playsinline: true, muted: true }
        : { autoplay: true, playsinline: true },
    ),
    el('div', { class: 'avatar' }),
    el('span', { class: 'ring', 'aria-hidden': 'true' }),
  );
  if (!plain) {
    tile.append(
      el(
        'div',
        { class: 'vol' },
        el('img', { class: 'vol-ico', src: '/openmoji/1F50A.svg', alt: '', width: 16, height: 16 }),
        volRange(),
        el('span', { class: 'vol-num' }, '100%'),
      ),
    );
  }
  tile.append(
    el('button', {
      class: 'zoom',
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': 'enlarge this picture',
      title: 'enlarge',
    }),
    el(
      'div',
      { class: 'tag' },
      el('span', { class: 'name' }),
      el('span', { class: 'flags' }),
      el('span', { class: 'state' }),
      ...(plain
        ? []
        : [
            el(
              'span',
              { class: 'route', title: 'the media goes through the relay server' },
              'relay',
            ),
            el('span', { class: 'pin', hidden: true }),
          ]),
    ),
  );
  if (!plain) {
    tile.append(...lineButton());
    tile.append(el('div', { class: 'menu', hidden: true }));
  }
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

// makeRow builds the list row of one member: name, the two lamps and the volume
// slider. The row is one line and the slider always open, so a pointer that
// crosses it never moves the stage.
function makeRow(id, name, local = false) {
  const row = document.createElement('div');
  row.className = 'plist-row';
  if (local) row.dataset.local = 'yes';
  else row.dataset.peer = id;
  row.dataset.state = 'new';
  row.dataset.mic = 'on';
  row.tabIndex = 0;
  row.setAttribute('role', 'group');
  row.append(
    el('span', { class: 'row-name' }),
    el(
      'span',
      { class: 'row-deaf', hidden: true },
      el('img', {
        src: '/openmoji/1F507.svg',
        alt: 'deafened',
        title: 'deafened',
        width: 16,
        height: 16,
      }),
    ),
    el('span', { class: 'row-hand', hidden: true }, 'hand'),
  );
  if (local) {
    row.append(el('span', { class: 'row-you' }, 'you'));
  } else {
    row.append(volRange(), el('span', { class: 'vol-num' }, '100%'), ...lineButton());
  }
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
let localTile = null; // the own preview tile, made once per room
// The tile is made in one place and dropped in another, so the two write it
// through this setter; a plain imported binding cannot be assigned.
export function setLocalTile(tile) {
  localTile = tile;
}

export function ownTile() {
  return localTile && localTile.isConnected ? localTile : null;
}

// stageTiles is every tile in a stable order: the own preview and its screen,
// then the guests in join order, each guest's screen right after its picture.
// The zones follow this order, so a relayout never reshuffles the room.
function stageTiles() {
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
// that is off, a muted track and a stopped track all say no, and that guest
// belongs in the rail. A screen tile needs a decoded frame too: its receiver
// track exists from the negotiation on.
function tileHasPicture(tile) {
  if (!tile || tile.classList.contains('camoff')) return false;
  const video = tile.querySelector('video');
  const stream = video && video.srcObject;
  if (!stream || typeof stream.getVideoTracks !== 'function') return false;
  const live = stream.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
  return live && (!tile.dataset.screen || video.videoWidth > 0);
}

// spotlightTile is the one tile that holds the large area while the spotlight
// is on. A guest that left takes it away; a screen tile is its own key.
function spotlightTile() {
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
const CORNERS = ['tl', 'tr', 'bl', 'br'];

const OPPOSITE_CORNER = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };

const cornerCall = new Map(); // peer id -> corner, this call only

export let cornerDropAt = 0; // when a drag ended, so its click is not a zoom

// peerOfTile is the peer record of one tile, or null for the own tile.
function peerOfTile(tile) {
  const id = tile && tile.dataset.peer;
  return id && state.peers ? state.peers.get(id) || null : null;
}

// storedCorner reads the kept corner of one guest: on disk under its
// fingerprint, or for this call only without a key. The default is the bottom
// right corner, where the own preview also sits.
function storedCorner(peer) {
  const raw =
    peer && peer.fp ? load(`corner.fp.${peer.fp}`) : peer ? cornerCall.get(peer.id) || '' : '';
  return CORNERS.includes(raw) ? raw : 'br';
}

function saveCorner(peer, corner) {
  if (!peer || !CORNERS.includes(corner)) return;
  cornerCall.set(peer.id, corner);
  if (peer.fp) store(`corner.fp.${peer.fp}`, corner);
}

// layoutStage picks the tiles that hold the large area and keeps the member
// list in step. A tile keeps its node, so its video keeps its stream. Without a
// spotlight the tiles with a picture, or the voice tiles, take the area; a
// waiting guest stays in the rail, a block of reserved height that scrolls.
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
  // moved, not copied, so the preview keeps the own stream and the mirror.
  const pip = !!(self && pipBox && state.selfPip);
  if (pipBox) pipBox.hidden = !pip;
  if (self && pip && self.parentElement !== pipBox) pipBox.appendChild(self);
  if (self && !pip && self.parentElement !== main) main.appendChild(self);
  // Two pictures and no spotlight: the later guest sits small in a corner and
  // the other keeps the whole frame.
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

// wireCornerDrag lets the small guest tile follow the pointer and snap to the
// nearest of the four corners. A pointer that stays put does not start a drag,
// so a click on the tile enlarges that guest.
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
