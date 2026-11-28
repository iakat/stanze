/*
 The room log, its links, and the whisper: a private side conversation.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { say } from './util.js';
import { peerName, shortPeer } from './sealed.js';
import { playSfx } from './sfx.js';
import { canary } from './audit.js';
import { sideAlive, sideClean, sideSet } from './proximity.js';

// ---------------------------------------------------------------- chat
// The sealed chat lines of this call. They never leave the browser in the clear,
// so there is no server history to replay.
export const CHAT_MAX = 200;

export function chatTime(ts = null) {
  const d = ts ? new Date(ts) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// A posted address becomes a link, http and https only. Nothing is fetched
// until a guest clicks it, because a link that phones home tells the other side
// who reads the room. The title shows the real target, punycode included, and
// the tab gets no referrer and no handle back to this page.
const LINK_RE = /https?:\/\/[^\s<>"']+/gi;

// splitLink cuts the trailing marks that belong to the sentence and not to the
// address: punctuation, and a closing bracket without an opening one.
function splitLink(raw) {
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
function safeLink(text) {
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
function linkify(text) {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const { url } = splitLink(m[0]);
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

// blankLine shows the "no messages" line of a log and hides it again as soon as
// the log holds a line, so the empty state never sits under one. Every log of
// the page has its own: the room log and the whisper log are separate boxes and
// an empty whisper must not lend its word to the room.
export function blankLine(log, empty) {
  if (!log || !empty) return;
  empty.hidden = log.children.length > 0;
}

export function chatEmpty(log) {
  blankLine(log, document.getElementById('chat-empty'));
}

// chatRow builds one line: the time, the speaker and the text with the links a
// posted address becomes. The room log and the whisper log use the same row, so
// a line reads alike wherever it is and only the box it lands in differs.
export function chatRow(name, text, ts) {
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
  return li;
}

// addLine puts one row at the end of a log and keeps the log at its own cap.
// The cap belongs to the box, not to the conversation: a whisper holds as many
// lines as the room does and no more.
export function addLine(log, name, text, ts) {
  if (!log) return null;
  const li = chatRow(name, text, ts);
  log.appendChild(li);
  while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
  return li;
}

export function addChatLine(name, text, ts) {
  const log = $('chat-log');
  if (!log) return;
  addLine(log, name, text, ts);
  chatEmpty(log);
}

// clearHooks are what a call ending takes with it besides the room log. A side
// conversation is part of the call and not of the page, so it goes here rather
// than in a second place that has to remember the same edges.
const clearHooks: Array<() => void> = [];

export function chatOnClear(fn: () => void) {
  clearHooks.push(fn);
}

// clearChat takes the log back to its empty state, which is a new call or a
// call that ended.
export function clearChat() {
  const log = $('chat-log');
  if (!log) return;
  log.replaceChildren();
  chatEmpty(log);
  for (const fn of clearHooks) {
    try {
      fn();
    } catch {
      /* a hook that throws must not stop the log from clearing */
    }
  }
}

// ------------------------------------------------------------------- whisper
//
// A whisper is a private side conversation: a few guests, named by the guest
// that opens it, saying text to each other and to nobody else. It is not a
// second transport and not a second rule of who hears whom. Every line is one
// sealed `side` frame on the pair channel that the room already opened, sent
// only to the members of that conversation, so the relay carries the same
// opaque blobs it already carries and learns nothing new. Audio never follows:
// `judge` stays the only decider of who is heard, which is why a whisper can
// not be used to reach a guest the map does not put you beside.
//
// The list of members is agreed by the guest that opened the conversation, in
// one sealed `side` frame per member, and every member applies the same bounds
// (`SIDE_MAX`, no self, no repeat, legal id) on the way in and on the way out.
// A member that leaves takes the conversation down for itself alone; running
// out of other members ends it, because a whisper of one is nobody's whisper.
//
// Nothing here touches the map, so a map that never uses a whisper costs one
// hidden panel and one line of CSS, and a guest whose browser never calls it
// sees exactly the room it saw before.

// side is this page's one open whisper, or null. One at a time on purpose: the
// panel is one box, and a guest that is in two side conversations at once has
// no way to say which one a line belongs to.
type Side = { owner: string; members: string[] };

let side: Side | null = null;
// sideLine is what the panel says about the conversation when it is not a
// line of chat: who is in it, or why it ended.
let sideNote = '';

// sidePeer answers the peer a whisper names, or null when the id is not in this
// room any more. Every read of a member goes through it, so a guest that left
// is never drawn from a list that still holds its id.
function sidePeer(id: string) {
  const peer = state.peers.get(id);
  return peer && !peer.waiting ? peer : null;
}

// sideName is the name of one member for the panel. The own guest is "you",
// because a whisper that lists itself by name reads like a room.
function sideName(id: string): string {
  if (id === state.self) return 'you';
  const peer = sidePeer(id);
  return peer ? peerName(peer) : shortPeer(id);
}

// sideMembers is the membership this page holds, with the guests that have left
// dropped: the list is the one that was agreed, filtered by who is still here.
// It is what the panel names and what a line is sent to.
export function sideMembers(): string[] {
  if (!side) return [];
  return side.members.filter((id) => id === state.self || !!sidePeer(id));
}

// sideOn answers whether this page is in a whisper, which the panel and the
// test hook both ask. A whisper whose only other member left is over: there is
// nobody left to say anything to.
export function sideOn(): boolean {
  if (!side) return false;
  const members = sideMembers();
  return sideAlive(state.self, members, new Set(members));
}

// sideOwner answers who opened the conversation this page is in.
export function sideOwner(): string {
  return side ? side.owner : '';
}

// sidePanel paints the panel from the state: the box shows itself only while
// there is a conversation, its head names the members, and the log starts with
// the one note that says what it is. A guest that is not in a whisper has a
// hidden box and no cost.
function sidePanel() {
  const box = document.getElementById('side-panel');
  if (!box) return;
  const log = document.getElementById('side-log');
  const head = document.getElementById('side-who');
  const empty = document.getElementById('side-empty');
  const members = sideMembers();
  const on = members.length > 1;
  box.hidden = !on;
  if (head) head.textContent = on ? members.map(sideName).join(', ') : '';
  if (empty) {
    empty.textContent = sideNote;
    blankLine(log, empty);
  }
  // The button that opens a whisper is the way in, and while a whisper is on it
  // is the way out: the same switch must not read two ways at once.
  const open = document.getElementById('side-open');
  if (open) {
    open.textContent = on ? 'leave' : 'whisper';
    open.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (on) {
    document.dispatchEvent(new CustomEvent('sidepanel'));
  }
}

// sideSay puts one line in the whisper log, in the same row the room log uses.
function sideSay(name, text, ts) {
  const log = document.getElementById('side-log');
  if (!log) return;
  addLine(log, name, text, ts);
  const empty = document.getElementById('side-empty');
  if (empty) empty.hidden = true;
  const box = document.getElementById('side-panel');
  if (box) box.hidden = false;
}

// sideNoteTo is the one note that is not a line: who is in the whisper, or the
// word that it ended. It replaces the note and never the lines, so the reason a
// conversation closed outlives the last thing said in it.
export function sideNoteTo(text: string) {
  sideNote = String(text || '');
  const empty = document.getElementById('side-empty');
  const log = document.getElementById('side-log');
  if (!empty) return;
  empty.textContent = sideNote;
  blankLine(log, empty);
}

// sideClose ends this page's whisper and says why. It is the only place the
// state goes back to null, so the panel, the button and the list can not
// disagree about whether a conversation is on.
export function sideClose(reason: string) {
  if (!side) return;
  side = null;
  sideNoteTo(reason);
  sidePanel();
}

// sideApply installs a membership that arrived sealed from the guest that owns
// the conversation. The same bounds are applied here as on the sending side, so
// a page that sends a longer list gets what the bounds allow and not what it
// asked for. A guest that is not in the list it was sent drops the whisper.
export function sideApply(owner: string, ids: unknown) {
  const members = sideSet(state.self, owner, ids);
  if (!members.includes(state.self)) {
    sideClose('closed by ' + sideName(owner));
    return;
  }
  const before = side ? side.members.join(',') : '';
  side = { owner, members };
  if (before !== members.join(',')) sideNoteTo('');
  sidePanel();
}

// sideOpen starts a whisper with the guests this page names, and tells each of
// them the membership. This page is its owner, so the list it sends is the list
// every member holds.
export function sideOpen(ids: string[]) {
  if (!state.self || state.leaving || state.waiting) return false;
  const others = sideClean(state.self, ids);
  if (!others.length) {
    say('a whisper needs a name: open one from the menu of a guest beside you');
    return false;
  }
  const members = sideSet(state.self, state.self, others);
  side = { owner: state.self, members };
  sideNoteTo('');
  sidePanel();
  for (const id of others) {
    const peer = sidePeer(id);
    if (peer) sealedSide(peer, { k: 'side', o: 'open', w: state.self, m: members });
  }
  playSfx('knock');
  return true;
}

// sideLeave takes this page out of the whisper and tells the members. A guest
// that is not the owner simply goes; the others keep the conversation with the
// list it had, so a whisper survives one member walking away.
export function sideLeave() {
  if (!side) return;
  const members = sideMembers();
  const owner = side.owner;
  sideClose('you left the whisper');
  for (const id of members) {
    if (id === state.self) continue;
    const peer = sidePeer(id);
    if (peer) sealedSide(peer, { k: 'side', o: 'leave', f: state.self, w: owner });
  }
}

// sideSend says one line to the members of the whisper. The line never goes to
// the room: `toSealed` is not called here, and the frame is one per member on
// the pair that member already holds.
export function sideSend() {
  const input = document.getElementById('side-text') as HTMLInputElement | null;
  const text = String((input && input.value) || '').trim();
  if (!text || !sideOn()) return;
  if (input) input.value = '';
  canary(text);
  sideSay(state.name || 'you', text, Date.now());
  state.sideSent++;
  // Every frame names the conversation it belongs to. A `say` without `w` is
  // dropped by the receiver, because it cannot tell which whisper it is for.
  const owner = side ? side.owner : '';
  for (const id of sideMembers()) {
    if (id === state.self) continue;
    const peer = sidePeer(id);
    if (peer) sealedSide(peer, { k: 'side', o: 'say', w: owner, x: text, ts: Date.now() });
  }
}

// sideOnFrame takes one sealed frame of a whisper from a pair. Every frame
// carries the owner of the conversation it belongs to, and this page acts only
// on the conversation it is in, so a member that was removed can not keep
// talking into a panel that is no longer there.
export function sideOnFrame(peer, obj) {
  const owner = String(obj.w || '');
  if (!owner) return;
  if (obj.k !== 'side') return;
  if (peer.waiting) return;
  if (state.leaving) return;
  if (obj.o === 'open') {
    sideApply(owner, obj.m);
    if (sideOn()) playSfx('msg');
    return;
  }
  // Everything below is traffic inside a conversation this page holds. A frame
  // for another conversation, or from a guest that is not a member, is ignored:
  // the membership is the whole authority of a whisper.
  if (!side || side.owner !== owner) return;
  if (!side.members.includes(peer.id)) return;
  if (obj.o === 'leave') {
    // The owner closing it ends it for everybody. Any other member leaving is
    // the list minus that name, and the conversation is over when one is left.
    if (peer.id === owner || side.members.length <= 2) {
      sideClose(sideName(peer.id) + ' closed the whisper');
      return;
    }
    side = { owner: side.owner, members: side.members.filter((id) => id !== peer.id) };
    sideNoteTo('');
    sidePanel();
    return;
  }
  if (obj.o === 'say') {
    const text = String(obj.x || '').slice(0, 500);
    if (!text) return;
    state.sideRecv++;
    sideSay(sideName(peer.id), text, Number(obj.ts) || Date.now());
  }
}

// sideWire connects the panel: the form, the button, and the note that a
// whisper is part of the call and goes when the call does.
export function sideWire() {
  const form = document.getElementById('side-form') as HTMLFormElement | null;
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      sideSend();
    });
  }
  const open = document.getElementById('side-open');
  if (open) {
    open.addEventListener('click', () => {
      if (sideOn()) {
        sideLeave();
        return;
      }
      // No name yet: the menu of a guest is where one is named, and the panel
      // says that instead of opening an empty conversation.
      sideNoteTo('open a whisper from the menu of a guest beside you');
      sidePanel();
    });
  }
  const close = document.getElementById('side-close');
  if (close) close.addEventListener('click', () => sideLeave());
  chatOnClear(() => {
    side = null;
    sideNote = '';
    const log = document.getElementById('side-log');
    if (log) log.replaceChildren();
    sidePanel();
  });
  sidePanel();
}

// sealedSide is the one write of a whisper frame. It is a separate function
// because the sealed send is the only thing a whisper borrows from the room
// channel, and keeping it in one place keeps `chat.ts` free of the key work.
let sideSealer: ((peer: any, obj: any) => void) | null = null;

export function sideSetSealer(fn: (peer: any, obj: any) => void) {
  sideSealer = fn;
}

function sealedSide(peer, obj) {
  if (sideSealer) sideSealer(peer, obj);
}
