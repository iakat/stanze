/*
 The room log and its links.
*/

import { $ } from './dom.js';
import { handle } from './signaling.js';
import { leave } from './room.js';

// ---------------------------------------------------------------- chat
// The room log carries the sealed chat lines of this call. They never leave the
// browser in the clear, so there is no server history to replay.
export const CHAT_MAX = 200;

export function chatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// A posted address becomes a link, http and https only. It is a link and not a
// preview: nothing is fetched and no picture is loaded until a guest clicks it,
// because a link that phones home tells the other side who reads the room.
// The text shown is the address itself, the title says where a click goes
// (with punycode spelled out for a lookalike name), and the click opens a new
// tab that gets no referrer and no handle back to this page.
export const LINK_RE = /https?:\/\/[^\s<>"']+/gi;

// splitLink cuts the trailing marks that belong to the sentence and not to the
// address: a full stop, a comma, a closing bracket without an opening one.
export function splitLink(raw) {
  let url = raw;
  let tail = '';
  for (;;) {
    const last = url[url.length - 1];
    if (!last) break;
    let cut = '.,;:!?\'"'.includes(last);
    if (!cut && (last === ')' || last === ']' || last === '}')) {
      const open = { ')': '(', ']': '[', '}': '{' }[last];
      cut = url.split(last).length > url.split(open).length;
    }
    if (!cut) break;
    tail = last + tail;
    url = url.slice(0, -1);
  }
  return { url, tail };
}

// safeLink returns the parsed address when it may become a link, else null. A
// name with a user part (https://good.example@evil.example) is refused: the
// text would show one host and a click would go to another.
export function safeLink(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return u;
}

// linkify returns the text as nodes: plain text, and an anchor for each address.
export function linkify(text) {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const { url, tail } = splitLink(m[0]);
    const u = safeLink(url);
    if (!u) continue;
    if (m.index > at) out.appendChild(document.createTextNode(text.slice(at, m.index)));
    const a = document.createElement('a');
    a.textContent = url;
    a.href = u.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.referrerPolicy = 'no-referrer';
    a.title = `opens ${u.href}`;
    a.className = 'chat-link';
    out.appendChild(a);
    at = m.index + url.length;
  }
  if (at < text.length) out.appendChild(document.createTextNode(text.slice(at)));
  return out;
}

export function addChatLine(name, text, ts) {
  const log = $('chat-log');
  if (!log) return;
  const li = document.createElement('li');
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = chatTime(ts);
  li.appendChild(when);
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${name || 'guest'}:`;
  li.appendChild(who);
  li.appendChild(document.createTextNode(' '));
  li.appendChild(linkify(String(text)));
  log.appendChild(li);
  while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
