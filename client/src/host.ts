/*
 The host controls in the call panel.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { isAdmin } from './util.js';
import { ownTile } from './tiles.js';
import { applyFlags } from './volume.js';
import { attachScreen, attachTrack } from './devices.js';
import { paintHandQueue, sendState, setPeerNoise } from './audio.js';
import { playSfx } from './sfx.js';
import { updatePinCount } from './identity.js';
import { banOf, banPeer, unbanPeer } from './bans.js';
import { asrAnnounce } from './asr.js';
import {
  admitAllHeld,
  issueClaim,
  sealedAdmit,
  sealedCodePanel,
  sealedKick,
  sealedMute,
  toSealed,
} from './gate.js';

// ---------------------------------------------------------------- host control
// hostMenu returns the menu element of one member. A tile holds its own menu,
// a rail row shares one popup on the page, because the scrolling list clips it.
let rowMenuEl = null;

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

// wireDots opens the small menu of one member: every guest gets it, an admin
// also gets the host entries. The tile and the row both carry the peer id.
export function wireDots(host) {
  const dots = host.querySelector('.dots');
  const menu = hostMenu(host);
  if (!dots || !menu) return;
  dots.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = document.querySelectorAll('.menu:not([hidden])') as NodeListOf<HTMLElement>;
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
      // A ban is the removal that outlives the call: the guest is removed now,
      // and this browser keeps the identity so the next knock of the same room
      // is refused. It is its own line and never a side effect of a plain
      // removal, so a guest removed for a wrong passphrase this hour is not
      // banned for a month. The row says what this browser already holds.
      const target = state.peers.get(host.dataset.peer);
      if (target && target.fp && banOf(target.fp)) {
        add('lift the ban on this identity', () => void unbanPeer(target.fp));
      } else if (target && target.fp) {
        add('ban for 30 days', () => {
          void banPeer(target.fp, target.name);
          sealedKick(target.id);
        });
      }
    }
    const noiseOn = !!(peer && peer.inNoise);
    const noiseEngine = peer ? peer.inEngine : '';
    const here = (name) => (noiseOn && noiseEngine === name ? ' (on)' : '');
    add('noise cancel: FastEnhancer' + here('fastenhancer'), () => {
      void setPeerNoise(peer, true, 'fastenhancer');
    });
    add('noise cancel: GTCRN' + here('gtcrn'), () => {
      void setPeerNoise(peer, true, 'gtcrn');
    });
    add('noise cancel: off' + (noiseOn ? '' : ' (on)'), () => {
      void setPeerNoise(peer, false);
    });
    // The sealed code is a card in the menu, not a banner over the picture.
    if (peer && peer.sas) {
      const card = document.createElement('div');
      card.className = 'sas';
      card.append(...sealedCodePanel(peer));
      menu.appendChild(card);
    }
    if (menu.classList.contains('row-menu')) {
      // The popup stays under its row and moves up when the screen has no room.
      const r = dots.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 16);
      menu.style.left =
        Math.round(Math.max(4, Math.min(r.left, window.innerWidth - width - 4))) + 'px';
      const below = r.bottom + 2;
      const height = menu.offsetHeight;
      const top =
        below + height > window.innerHeight - 4
          ? Math.max(4, window.innerHeight - 4 - height)
          : below;
      menu.style.top = Math.round(top) + 'px';
    }
    menu.hidden = false;
  });
}

// wireAdmit connects the let in button of one held member. Any guest inside may
// press it; the admit travels sealed to that guest.
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

// waitingText tells a waiting guest that the room already sees and hears
// whatever device is on, and how to switch it off.
function waitingText() {
  const both = state.mic && state.cam;
  const lead = 'You are in the waiting room. ';
  const mid = both
    ? 'Your camera and your microphone are on, and every member of the meeting can see and hear you right now, before you are let in. '
    : `Your camera is ${state.cam ? 'on' : 'off'} and your microphone is ${state.mic ? 'on' : 'off'}. Every member of the meeting can see and hear whatever is on, before you are let in. `;
  return `${lead}${mid}Use the buttons below to turn them off if you do not want that. You can not see or hear the meeting, or chat, until a member lets you in.`;
}

// paintWaiting draws what depends on the waiting room: the notice, the admin
// switch, the chat lock and the peer count.
export function paintWaiting() {
  document.body.classList.toggle('self-waiting', state.waiting);
  const banner = $('waiting-banner');
  if (banner) {
    banner.hidden = !state.waiting;
    if (state.waiting) banner.textContent = waitingText();
  }
  const sw = $('waiting-room');
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

// admitPeer runs when a guest is inside now and hands it the media that was
// held back.
export function admitPeer(id) {
  if (id === state.self) {
    const wasWaiting = state.waiting;
    state.waiting = false;
    // Every existing pair learns that this page is inside, so no member keeps
    // its media back from a page it let in.
    if (wasWaiting) toSealed({ k: 'in' });
    // With the switch off nobody waits; a pair whose admit was lost is let in here.
    if (!state.waitingRoom) admitAllHeld();
    // The held tracks go to every connection that is already built, or the room
    // hears nothing of a guest it has just let in.
    if (state.outStream) {
      for (const peer of state.peers.values()) {
        for (const track of state.outStream.getTracks()) attachTrack(peer, track);
        attachScreen(peer);
      }
    }
    // The flags were held back too; every pair gets them now.
    sendState();
    paintWaiting();
    playSfx('joined');
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

// closeMenus hides every open host menu. One listener on the page calls it.
export function closeMenus() {
  for (const menu of document.querySelectorAll('.menu:not([hidden])')) {
    (menu as HTMLElement).hidden = true;
  }
}

// markAdmins redraws the host chip on every tile and the page level admin flag,
// and repaints the hand queue.
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
  // The count is beside the title, not the title: a room's name is what a
  // person reads in the tab, and their browser history.
  const count = $('peer-count');
  if (count) {
    count.textContent =
      (total === 1 ? '1 peer' : `${live}/${total} peers`) +
      (held && !state.waiting ? `, ${held} waiting` : '');
  }
  updatePinCount();
}
