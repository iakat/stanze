/*
 Small helpers that touch nothing but their arguments and storage.
*/

import { B32 } from './config.js';
import { $ } from './dom.js';
import { state } from './state.js';

// newRoomID builds a 128 bit room id in the client, so the lobby can suggest
// one without asking the server.
export function newRoomID() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function say(text) {
  const box = state.room ? $('stage-error') : $('lobby-error');
  state.notice = text;
  box.textContent = text;
  box.hidden = !text;
}

// isAdmin answers whether this peer holds the role. Safe before the first
// `joined` message, when no role is known yet.
export function isAdmin(id) {
  return !!(id && state.admins && state.admins.has(id));
}

// setAdmins replaces the role list in place, so every reader of the same set
// sees the new list. A missing set is rebuilt instead of throwing.
export function setAdmins(list) {
  if (!(state.admins instanceof Set)) state.admins = new Set();
  state.admins.clear();
  for (const id of list || []) state.admins.add(id);
}

// detachMedia empties a media element and stops it. A pause on an element that
// is not playing throws in some browsers, which is not an error here.
export function detachMedia(media: HTMLMediaElement) {
  try {
    media.pause();
  } catch {
    /* not playing */
  }
  media.srcObject = null;
}

// joinWords renders a short list for the status line ("a, b and c").
export function joinWords(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// ---------------------------------------------------------------- menu bar

// The menu bar carries one thin entry per drop-down. Only one panel is open at
// a time, the way a Windows menu bar behaves.
/** @type {[keyof Elements, keyof Elements][]} */
