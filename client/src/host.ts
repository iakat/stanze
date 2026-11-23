/*
 The host controls in the call panel.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { isAdmin, say } from './util.js';
import { ownTile } from './tiles.js';
import { applyFlags } from './volume.js';
import { attachScreen, attachTrack } from './devices.js';
import { paintHandQueue, sendState, setPeerNoise } from './audio.js';
import { playSfx } from './sfx.js';
import { updatePinCount } from './identity.js';
import { asrAnnounce } from './asr.js';
import { issueClaim, sealedAdmit, sealedCodePanel, sealedKick, sealedMute } from './gate.js';

// ---------------------------------------------------------------- host control
// hostMenu returns the menu element of one member, a tile or a rail row. A
// tile holds its own menu, because nothing scrolls around it. The rail does
// scroll and is short, so a row hands the work to one popup on the page: the
// entries would be cut off inside the list. One popup serves every row.
export let rowMenuEl = null;

export function hostMenu(host) {
  if (!host) return null;
  if (!host.classList.contains('plist-row')) return host.querySelector('.menu');
  if (!rowMenuEl) {
    rowMenuEl = document.createElement('div');
    rowMenuEl.className = 'menu row-menu';
    rowMenuEl.hidden = true;
    document.body.appendChild(rowMenuEl);
  }
  return rowMenuEl;
}

// wireDots opens the small menu of one remote member. Every guest sees it; the
// host commands appear only for the admin, and every page checks the sealed
// role list again on every notice. It takes the tile or the row of that member,
// because both carry the peer id.
export function wireDots(host) {
  const dots = host.querySelector('.dots');
  const menu = hostMenu(host);
  if (!dots || !menu) return;
  dots.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = (document.querySelectorAll('.menu:not([hidden])') as NodeListOf<HTMLElement>);
    for (const other of open) {
      if (other !== menu) other.hidden = true;
    }
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    menu.replaceChildren();
    menu.dataset.peer = host.dataset.peer || '';
    const peer = state.peers.get(host.dataset.peer);
    const add = (label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        menu.hidden = true;
        run();
      });
      menu.appendChild(b);
    };
    if (isAdmin(state.self)) {
      add('give admin', () => {
        const id = host.dataset.peer;
        if (!id || isAdmin(id)) return;
        void issueClaim(state.auth.n + 1, [...state.auth.admins, id]);
      });
      add('mute', () => {
        const peer = state.peers.get(host.dataset.peer);
        if (peer) sealedMute(peer);
      });
      add('remove from room', () => sealedKick(host.dataset.peer));
    }
    const noiseOn = !!(peer && peer.inNoise);
    add('local noise cancel: ' + (noiseOn ? 'on' : 'off'), () => { void setPeerNoise(peer, !noiseOn); });
    // The sealed code lives here, not as a banner over the picture: one card,
    // built by the same function that feeds the stats panel.
    if (peer && peer.sas) {
      const card = document.createElement('div');
      card.className = 'sas';
      card.append(...sealedCodePanel(peer));
      menu.appendChild(card);
    }
    if (menu.classList.contains('row-menu')) {
      // The popup sits under the three dots of its row, and above them when
      // there is no room below, so every entry stays on the screen.
      const r = dots.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 16);
      menu.style.left = Math.round(Math.max(4, Math.min(r.left, window.innerWidth - width - 4))) + 'px';
      const below = r.bottom + 2;
      const height = menu.offsetHeight;
      const top = below + height > window.innerHeight - 4
        ? Math.max(4, window.innerHeight - 4 - height)
        : below;
      menu.style.top = Math.round(top) + 'px';
    }
    menu.hidden = false;
  });
}

// wireAdmit connects the let in button of one remote member. Any guest that is
// inside may press it; the news goes sealed to that guest and to the room.
export function wireAdmit(host) {
  const button = host.querySelector('.admit');
  if (!button) return;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.waiting || !host.dataset.peer) return;
    const peer = state.peers.get(host.dataset.peer);
    if (peer) sealedAdmit(peer);
  });
}

// waitingText says to a waiting guest what the room can see and hear. It is
// built from the real state of the two devices, so it is never wrong about
// them, and it is shown again whenever one of them changes.
export function waitingText() {
  const both = state.mic && state.cam;
  const lead = 'You are in the waiting room. ';
  const mid = both
    ? 'Your camera and your microphone are on, and every member of the meeting can see and hear you right now, before you are let in. '
    : `Your camera is ${state.cam ? 'on' : 'off'} and your microphone is ${state.mic ? 'on' : 'off'}. Every member of the meeting can see and hear whatever is on, before you are let in. `;
  return `${lead}${mid}Use the buttons below to turn them off if you do not want that. You can not see or hear the meeting, or chat, until a member lets you in.`;
}

// paintWaiting draws everything that depends on the waiting room: the notice
// of a waiting guest, the admin switch, the chat lock and the count in the
// header. It is cheap and safe to call at any time.
export function paintWaiting() {
  document.body.classList.toggle('self-waiting', state.waiting);
  const banner = document.getElementById('waiting-banner');
  if (banner) {
    banner.hidden = !state.waiting;
    if (state.waiting) banner.textContent = waitingText();
  }
  const sw = (document.getElementById('waiting-room') as HTMLInputElement | null);
  if (sw) sw.checked = state.waitingRoom;
  // A waiting guest has no chat and offers no files: the room is not theirs yet.
  $('chat-text').disabled = state.waiting;
  $('file-btn').disabled = state.waiting;
  $('chat-text').placeholder = state.waiting ? 'chat opens when you are let in' : 'say something';
  for (const peer of state.peers.values()) {
    if (peer.tile) applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
    if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
  }
  const self = ownTile();
  if (self) applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  updateCount();
  paintHandQueue();
}

// admitPeer runs when the room says that a guest is inside now. Our own media
// goes to that guest from this moment on; before it, nothing of it did.
export function admitPeer(id) {
  if (id === state.self) {
    state.waiting = false;
    // The waiting room held every outgoing track back. Now the guest is
    // inside, so the tracks go to every connection that is already built.
    // Without this the room hears nothing of a guest it has just let in.
    if (state.outStream) {
      for (const peer of state.peers.values()) {
        for (const track of state.outStream.getTracks()) attachTrack(peer, track);
        attachScreen(peer);
      }
    }
    // The room held our flags back while we waited; now every pair gets them.
    sendState();
    paintWaiting();
    playSfx('pop');
    return;
  }
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.waiting = false;
  if (peer.fp) state.insideFps.add(peer.fp);
  asrAnnounce(peer);
  if (peer.pc && state.outStream) {
    for (const track of state.outStream.getTracks()) attachTrack(peer, track);
    attachScreen(peer);
  }
  paintWaiting();
}

// closeMenus hides every host menu. One listener on the page does it, because
// a listener per tile was never removed when its tile left.
export function closeMenus() {
  for (const menu of document.querySelectorAll('.menu:not([hidden])')) {
    (menu as HTMLElement).hidden = true;
  }
}

// markAdmins redraws the host chip on every tile. The member menu is open to
// every guest, so only the chip and the host commands depend on the role.
export function markAdmins() {
  const mine = isAdmin(state.self);
  document.body.classList.toggle('is-admin', mine);
  for (const peer of state.peers.values()) {
    applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
    if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
  }
  const self = ownTile();
  applyFlags(self, state.mic, state.cam, mine);
  paintHandQueue();
}

export function updateCount() {
  const total = state.peers.size + 1;
  const live = [...state.peers.values()].filter((p) => p.state === 'connected').length + 1;
  const held = [...state.peers.values()].filter((p) => p.waiting).length;
  $('peer-count').textContent = (total === 1 ? '1 peer' : `${live}/${total} peers`) +
    (held && !state.waiting ? `, ${held} waiting` : '');
  updatePinCount();
}
