/*
 The drop-down menu bar.
*/

import { ROOM_RE } from './config.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { newRoomID } from './util.js';
import { auditWire } from './audit.js';

export const MENUS = [
  ['menu-settings-btn', 'menu-settings'],
  ['menu-effects-btn', 'menu-effects'],
  ['menu-asr-btn', 'menu-asr'],
  ['menu-devices-btn', 'menu-devices'],
];

// fitMenu keeps a drop-down inside the window. A menu hangs from its slot to
// the left, which is right for the left of the bar and wrong for the right: on
// a narrow screen the last slot would push its panel past the edge. The panel
// is slid back by the pixels it hangs out, and never past the left edge, so a
// wrapped bar of two lines still keeps every panel on the glass.
export function fitMenu(list) {
  if (!(list instanceof HTMLElement)) return;
  const room = document.documentElement.clientWidth;
  list.style.left = '';
  const box = list.getBoundingClientRect();
  let shift = 0;
  if (box.right > room - 2) shift = room - 2 - box.right;
  if (box.left + shift < 2) shift = 2 - box.left;
  if (shift) list.style.left = Math.round(shift) + 'px';
}

// menuSet opens one panel, closes the others, and moves the focus to its first
// row when it opens. A panel keeps its own DOM, so a switch keeps its listener
// and its tick while the panel is closed.
export function menuSet(open, which = null) {
  for (const [btnId, listId] of MENUS) {
    const btn = $(btnId);
    const list = $(listId);
    if (!btn || !list) continue;
    const on = open && (!which || which === listId);
    const was = !list.hidden;
    list.hidden = !on;
    // A closed panel takes its nested lists with it.
    if (!on) closeSubmenus(list);
    btn.setAttribute('aria-expanded', String(on));
    if (on && !was) {
      fitMenu(list);
      const first = list.querySelector(
        'input[type="checkbox"], select, .menu-choice, .menu-sub',
      ) as HTMLElement | null;
      if (first) first.focus();
    }
  }
}

// menuClose closes every panel and says whether one of them was open, so the
// global Esc handler can leave the rest of the page alone.
export function menuClose() {
  let any = false;
  for (const [, listId] of MENUS) {
    const list = $(listId);
    if (list && !list.hidden) any = true;
  }
  if (any) menuSet(false);
  return any;
}

// closeSubmenus puts every nested list of one panel back to closed.
export function closeSubmenus(panel) {
  if (!panel) return;
  for (const sub of Array.from(panel.querySelectorAll('.menu-sub-list'))) {
    if (sub instanceof HTMLElement) sub.hidden = true;
  }
  for (const btn of Array.from(panel.querySelectorAll('.menu-sub')))
    (btn as HTMLElement).setAttribute('aria-expanded', 'false');
}

// wireSubmenus gives every nested row its list: a hover opens it and closes
// its siblings, a click toggles it, the right arrow walks in and the left
// arrow walks back out, the way a Windows menu of the era behaved.
export function wireSubmenus() {
  for (const wrap of Array.from(document.querySelectorAll('.menu-subwrap'))) {
    const btn = wrap.querySelector('.menu-sub') as HTMLElement | null;
    const list = wrap.querySelector('.menu-sub-list') as HTMLElement | null;
    if (!btn || !list) continue;
    /** @type {(on: boolean) => void} */
    const openSub = (on) => {
      list.hidden = !on;
      btn.setAttribute('aria-expanded', String(on));
      if (!on) return;
      for (const other of Array.from(document.querySelectorAll('.menu-subwrap'))) {
        if (other === wrap) continue;
        const otherList = other.querySelector('.menu-sub-list') as HTMLElement | null;
        const otherBtn = other.querySelector('.menu-sub');
        if (otherList) otherList.hidden = true;
        if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
      }
    };
    wrap.addEventListener('mouseenter', () => openSub(true));
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openSub(!list.hidden);
    });
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSub(true);
      const first = list.querySelector('.menu-choice') as HTMLElement | null;
      if (first) first.focus();
    });
    list.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      openSub(false);
      btn.focus();
    });
  }
}

// wireMenuBar gives each entry its behaviour: a click opens its panel and
// closes the other one, a click inside the panel keeps it open so several
// switches can be set at once, a click anywhere else or Esc closes it, and the
// arrow keys walk the rows.
export function wireMenuBar() {
  for (const [btnId, listId] of MENUS) {
    const btn = $(btnId);
    const list = $(listId);
    if (!btn || !list) continue;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      menuSet(list.hidden, listId);
    });
    list.addEventListener('click', (event) => event.stopPropagation());
    list.addEventListener('keydown', (event: KeyboardEvent) => {
      const rows = Array.from(
        list.querySelectorAll('input[type="checkbox"], select, .menu-choice, .menu-sub'),
      ).filter((el) => !(el as HTMLElement).hidden);
      const at = rows.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        menuSet(false);
        btn.focus();
        return;
      }
      if (event.key === 'Tab') {
        menuSet(false);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = rows[(at + step + rows.length) % rows.length] as HTMLElement | undefined;
      if (next) next.focus();
    });
  }
  document.addEventListener('click', (event) => {
    const target = event.target as Element;
    if (target.closest('#menubar')) return;
    menuSet(false);
  });
}

export function suggestRoom() {
  $('room').value = newRoomID();
}

// normalizeRoom turns whatever was pasted into a room name: a full link, a
// #r= fragment, mixed case, or a plain name.
export function normalizeRoom(raw) {
  let text = String(raw || '').trim();
  const hash = text.match(/#r=([^&\s"'<>]+)/);
  if (hash) text = hash[1];
  try {
    text = decodeURIComponent(text);
  } catch {
    /* keep the raw text */
  }
  return text.trim().toLowerCase();
}

export function roomFromHash() {
  const raw = location.hash.replace(/^#/, '');
  const id = normalizeRoom(new URLSearchParams(raw).get('r') || '');
  return ROOM_RE.test(id) ? id : '';
}

// setHash keeps the room in the fragment, so it never reaches the server.
export function setHash(room) {
  history.replaceState(null, '', room ? `#r=${encodeURIComponent(room)}` : location.pathname);
}

export function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws';
}

export function send(msg) {
  const raw = JSON.stringify(msg);
  // The audit sees every frame the relay sees, in both directions. It is the
  // client half of the proof that a room never sends a name or a chat line in
  // the clear.
  auditWire('out', raw);
  // Every frame follows the join frame of an open socket; one that meets a
  // closed socket names a peer that the close already dropped.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(raw);
}
