/*
 The room gate: the passphrase and who is in.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { isAdmin, setAdmins } from './util.js';
import { paintName, paintRowDeaf, rowOf } from './tiles.js';
import { applyFlags } from './volume.js';
import { admitPeer, hostMenu, markAdmins, paintWaiting } from './host.js';
import { dropPeerCamera, dropPeerScreen, paintPeerScreen, paintPeerVideo } from './devices.js';
import { paintHandQueue } from './audio.js';
import { dropPeer } from './peers.js';
import { leave } from './room.js';
import { addChatLine } from './chat.js';
import { playSfx } from './sfx.js';
import {
  b64e,
  chatAAD,
  cleanSealedName,
  pairLabel,
  pqCall,
  pqModule,
  sealUtf8,
  sealedSendOpaque,
  verifyEmojis,
} from './sealed.js';
import {
  paintPin,
  pinLabelOf,
  pinPeer,
  pinState,
  renamePin,
  resetDevice,
  updatePinCount,
} from './identity.js';
import { canary } from './audit.js';
import { setChrome } from './phone.js';

// ------------------------------------------------------ sealed room control
//
// The role, the waiting switch, the let in, the kick and the mute are sealed
// commits now. Each one travels per pair, so the server relays a blob and
// learns nothing. A role list and a switch carry a counter: the highest
// counter wins and the lower peer id breaks a tie, so two pages that act at
// the same moment still land on one answer.
// claimText is the exact byte string a role claim signs. The room id binds the
// claim to this room, and the counter orders two admins that act at once.
export function claimText(n, admins) {
  return b64e(sealUtf8.encode(`stanze/claim/1|${state.room}|${n}|${admins.join(',')}`));
}

// makeClaim signs one role list with the identity this page announced in the
// handshake, so every page that holds that key can check it.
export async function makeClaim(n, admins) {
  if (!state.idKey) return null;
  let sig = '';
  try {
    sig = await state.idKey.sign(claimText(n, admins));
  } catch {
    return null;
  }
  return sig ? { n, admins: admins.slice(), sig } : null;
}

// adoptClaim installs a checked claim: the role list, its counter and the page
// that signed it.
export function adoptClaim(claim) {
  state.auth = { n: claim.n, admins: claim.admins.slice(), by: claim.by, sig: claim.sig };
  setAdmins(claim.admins);
  markAdmins();
  paintWaiting();
}

// issueClaim makes a claim current here and sends it to every pair.
export async function issueClaim(n, admins) {
  const unique = [...new Set(admins)].filter((id) => /^[0-9a-f]{12}$/.test(String(id || '')));
  if (!unique.length) return false;
  const claim = await makeClaim(n, unique);
  if (!claim || state.leaving) return false;
  adoptClaim({ ...claim, by: state.self });
  toSealed({ k: 'claim', n: claim.n, admins: claim.admins, sig: claim.sig });
  return true;
}

// sealedSendClaim answers a page that just proved the room and asked who holds
// the role. A page with no claim of its own has nothing to say.
export function sealedSendClaim(peer) {
  if (state.auth.n < 0) return;
  sealedSend(peer, { k: 'claim', n: state.auth.n, admins: state.auth.admins, sig: state.auth.sig });
}

// sealedOnClaim checks one claim: the sender signs for its own announced
// identity, names itself in the list, and the counter decides.
export function sealedOnClaim(peer, obj) {
  if (!peer.proven || !peer.pub || !peer.pub.id) return;
  const n = Number(obj.n);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) return;
  if (!Array.isArray(obj.admins) || !obj.admins.length || obj.admins.length > 64) return;
  if (obj.admins.some((id) => typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id))) return;
  if (!obj.admins.includes(peer.id) || typeof obj.sig !== 'string') return;
  const res = pqCall((json) => pqModule().idverify(json), {
    id: peer.pub.id,
    msg: claimText(n, obj.admins),
    sig: obj.sig,
  });
  if (!res || !res.ok) return;
  if (n < state.auth.n) return;
  if (n === state.auth.n) {
    // Two pages hold the same counter: the lower signer id wins, so both sides
    // land on one list and a page never flips between two answers.
    if (obj.admins.join(',') === state.auth.admins.join(',')) return;
    if (String(peer.id) >= String(state.auth.by)) return;
  }
  adoptClaim({ ...obj, by: peer.id });
}

// startAuthSeed gives a room with no member a first admin. A page that hears a
// claim first keeps it; pages that seed at the same moment agree through the
// counter and the peer id, so one list survives.
export function startAuthSeed() {
  if (state.authTimer) clearTimeout(state.authTimer);
  state.authTimer = setTimeout(() => {
    state.authTimer = null;
    if (state.leaving || !state.self) return;
    // A room with nobody else in it has no member to let this page in, so the
    // first guest takes the room itself. It also seeds the first role.
    if (!state.peers.size && state.waiting) admitPeer(state.self);
    if (state.auth.n >= 0) return;
    void issueClaim(0, [state.self]);
  }, 1200);
}

// resealOnLeave drops a member that left from the role list. The first admin
// left in the list signs the new claim, so one page does it and every page
// lands on the same list. A room with no admin left lets every page offer
// itself, and the counter and the peer id pick one.
export function resealOnLeave(id) {
  if (!state.auth.admins.includes(id)) return;
  const rest = state.auth.admins.filter((other) => other !== id);
  if (!rest.length) {
    if (!state.waiting) void issueClaim(state.auth.n + 1, [state.self]);
    return;
  }
  if (rest[0] !== state.self) return;
  void issueClaim(state.auth.n + 1, rest);
}

// sealedOnWait takes the room switch from an admin's pair. The counter orders
// two changes, and the peer id breaks a tie, the same rule as the gate value.
export function sealedOnWait(peer, obj) {
  if (!isAdmin(peer.id)) return;
  const n = Number(obj.n);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) return;
  const on = !!obj.on;
  if (n < state.wait.n) return;
  if (n === state.wait.n && (on === state.wait.on || String(peer.id) >= String(state.self))) return;
  state.wait = { on, n };
  state.waitingRoom = on;
  paintWaiting();
  // A switch that goes off opens the room: every held guest is let in now,
  // because a held guest only asks a few times and then waits in silence.
  if (!on) admitAllHeld();
}

// setWaitingRoom is the admin switch: one sealed commit to every pair. A page
// with no role can not move it, and no page obeys a sender that holds none.
export function setWaitingRoom(on) {
  if (!isAdmin(state.self) || state.waiting) return;
  const n = state.wait.n + 1;
  state.wait = { on: !!on, n };
  state.waitingRoom = !!on;
  toSealed({ k: 'wait', on: !!on, n });
  paintWaiting();
  if (!on) admitAllHeld();
}

// sealedAdmit lets one held guest in. Any member may do it: the gate proof
// already showed that both pages hold the room, so no server has a say.
export function sealedAdmit(peer) {
  if (!peer || state.waiting) return;
  sealedSend(peer, { k: 'admit' });
}

// admitAllHeld lets every guest that is still outside in. A guest asks only a
// few times and then goes quiet, so the room must not rely on another ask: the
// switch going off opens the room at once, and a member never keeps a let in
// button for a room that is not holding anyone. The admit is idempotent, so
// every page may send it.
export function admitAllHeld() {
  if (state.waiting) return;
  for (const peer of state.peers.values()) {
    if (!peer.waiting) continue;
    sealedAdmit(peer);
    admitPeer(peer.id);
  }
}

// maybeAdmitHeld runs when a held guest says so. A member with the switch off
// lets it in, and with no member inside at all the lower id keeps the room and
// lets the other in, so a room can never stay shut with nobody inside.
export function maybeAdmitHeld(peer) {
  if (!peer || !peer.waiting) return;
  if (!state.waiting) {
    if (!state.waitingRoom || (peer.fp && state.insideFps.has(peer.fp))) {
      // The member decides, and its own view follows at once: a page that keeps
      // holding a guest it has just let in holds its media back as well, and the
      // let in notice alone never clears it here.
      sealedAdmit(peer);
      admitPeer(peer.id);
    }
    return;
  }
  if (String(state.self) < String(peer.id)) {
    admitPeer(state.self);
    sealedAdmit(peer);
    return;
  }
  // The lower id keeps the room and lets the other in, so this page waits for
  // that news. Ask again a few times, because the one note can go out before
  // the pair that carries it exists.
  askHeldAgain(peer);
}

// askHeldAgain repeats the held note on one pair. It is idempotent on the far
// side and it stops with the room, so a lost note costs two seconds and not a
// call. The count is capped so a room that never answers stays quiet.
export function askHeldAgain(peer) {
  if (!peer || !state.waiting) return;
  if ((peer.heldAsks || 0) >= 6) return;
  peer.heldAsks = (peer.heldAsks || 0) + 1;
  const timer = setTimeout(() => {
    peer.heldTimers = (peer.heldTimers || []).filter((t) => t !== timer);
    if (state.leaving || !state.peers.has(peer.id) || !state.waiting) return;
    sealedSend(peer, { k: 'held' });
  }, 2000);
  (peer.heldTimers = peer.heldTimers || []).push(timer);
}

// sealedOnHeld is a guest telling its pair that the room still holds it out.
export function sealedOnHeld(peer) {
  if (!peer) return;
  if (!peer.waiting) {
    peer.waiting = true;
    paintWaiting();
    paintHandQueue();
  }
  maybeAdmitHeld(peer);
}

// sealedOnAdmit is the news that a member let this page in.
export function sealedOnAdmit(peer) {
  if (!state.waiting || !peer) return;
  admitPeer(state.self);
  toSealed({ k: 'in' });
}

// sealedOnIn is a guest whose pair is new telling this page that it is inside.
// The claim is a hint and not a permission: the room applies its own rule, the
// same one the held note runs, so a guest that says it is in does not skip a
// waiting room that is switched on.
export function sealedOnIn(peer) {
  if (state.waiting || !peer || !peer.waiting) return;
  maybeAdmitHeld(peer);
}

// sealedKick removes one peer from every page. Each page drops it and stops
// answering, so a page that ignores the notice talks to nobody. The identity
// goes on the list this page refuses, so the same key can not come back.
export function sealedKick(id) {
  if (!isAdmin(state.self) || !id || id === state.self) return;
  const gone = state.peers.get(id);
  if (gone && gone.fp) state.kickedFps.add(gone.fp);
  toSealed({ k: 'kick', of: id });
  dropPeer(id);
  state.admins.delete(id);
  resealOnLeave(id);
  markAdmins();
  paintWaiting();
}

// sealedMute asks one page to turn its own microphone down. Only a page can
// reach its own track, so this is a request over its proven pair and not a
// command the relay could carry.
export function sealedMute(id) {
  if (!isAdmin(state.self) || !id || id === state.self) return;
  toSealed({ k: 'mute', of: id });
}

// sealedOnKick honours an admin's notice. Only a proven pair of an admin
// counts, and the page named in it is dropped here too.
export function sealedOnKick(peer, obj) {
  if (!isAdmin(peer.id) || typeof obj.of !== 'string') return;
  if (obj.of === state.self) {
    leave('the host removed you from the room');
    return;
  }
  const gone = state.peers.get(obj.of);
  if (!gone) return;
  if (gone.fp) state.kickedFps.add(gone.fp);
  dropPeer(obj.of);
  state.admins.delete(obj.of);
  resealOnLeave(obj.of);
  markAdmins();
  paintWaiting();
}

// padsOn tells the frame worker that this pair may round its frame sizes up.
// The worker only pads a sender that the peer has said it reads, so a call with
// a client that predates the padding keeps the old sizes on that side.
export function padsOn(peer) {
  if (!state.worker || !peer || peer.padsOn) return;
  peer.padsOn = true;
  for (const kind of ['audio', 'video']) {
    state.worker.postMessage({ type: 'pad', pair: pairLabel(peer.id), kind, on: true });
  }
}

// sealedOnState paints the flags one guest sent over its sealed pair. The
// queue order is the sender's own time, so no server numbers it; a time from
// the future is clamped to now instead of trusted.
export function sealedOnState(peer, obj) {
  if (obj.pad) padsOn(peer);
  if (obj.mic !== undefined) peer.mic = !!obj.mic;
  if (obj.cam !== undefined) {
    peer.cam = !!obj.cam;
    // A camera that goes off leaves its last frame in the element when the
    // sender only stops the track, and the sealed flag is the news that says
    // so. The receiver track stays, so the picture comes back with the camera.
    if (peer.cam) paintPeerVideo(peer);
    else dropPeerCamera(peer);
  }
  if (obj.deaf !== undefined) peer.deaf = !!obj.deaf;
  if (obj.screen !== undefined) {
    peer.screenShared = !!obj.screen;
    // A share that stops must leave the stage, not stand there frozen on its
    // last frame: the sender's track stays live and unmuted when it only
    // replaces it with nothing, so the flag is the only news.
    if (peer.screenShared) paintPeerScreen(peer);
    else dropPeerScreen(peer);
  }
  if (obj.hand !== undefined) {
    const was = peer.hand;
    peer.hand = !!obj.hand;
    peer.handTs = peer.hand ? Math.max(0, Math.min(Number(obj.ts) || 0, Date.now())) : 0;
    if (peer.hand !== was) {
      playSfx(peer.hand ? 'pop' : 'bonk');
      // A hand that goes up on a phone brings the frame back, or nobody would
      // see the queue on a screen that shows only the picture.
      if (peer.hand) setChrome(true);
    }
  }
  applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
  if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
  paintRowDeaf(rowOf.get(peer.tile), peer.deaf);
  paintHandQueue();
}

export function sealedAnnounceName(peer) {
  if (!peer.keys || !state.name || peer.announcedName === state.name) return;
  peer.announcedName = state.name;
  sealedSend(peer, { k: 'name', n: state.name });
}

// A sealed payload is padded to a fixed bucket before it is sealed, so the
// length of the ciphertext stops saying what was sent: a two word chat line, a
// name and a file offer all leave as the same size. The true length travels
// inside as the filler field, and the receiver drops it. Buckets are powers of
// two and the biggest repeats, so a large payload still lands on a round size.
export const PAD_BUCKETS = [512, 2048, 8192];

export const PAD_LAST = PAD_BUCKETS[PAD_BUCKETS.length - 1];

export function padPayload(obj) {
  const withPad = Object.assign({}, obj, { z: '' }) as any;
  const bytes = sealUtf8.encode(JSON.stringify(withPad)).length;
  let target = PAD_BUCKETS.find((n) => n >= bytes);
  if (!target) target = Math.ceil(bytes / PAD_LAST) * PAD_LAST;
  const need = target - bytes;
  if (need > 0) withPad.z = 'A'.repeat(need);
  return JSON.stringify(withPad);
}

// padRoundTripOk proves the padding is a round trip and that every outgoing
// size lands on a bucket or a whole multiple of the biggest one. It runs in the
// post-quantum self test, so a change that breaks the buckets shows up before a
// call starts.
export function padRoundTripOk() {
  // Fixtures only: two words, a two byte character, and a payload over the
  // biggest bucket, so the bucket choice and the round trip are both covered.
  const cases = [
    { k: 'name', n: 'abc' },
    { k: 'chat', n: 'a', x: 'hello', ts: 1 },
    { k: 'chat', n: 'b', x: 'é'.repeat(400) },
    { k: 'asr', n: 'c', x: 'z'.repeat(9000) },
  ];
  for (const c of cases) {
    const raw = JSON.stringify(c);
    const out = padPayload(c);
    const bytes = sealUtf8.encode(out).length;
    const onBucket = PAD_BUCKETS.includes(bytes) || bytes % PAD_LAST === 0;
    const back = JSON.parse(out);
    delete back.z;
    if (!onBucket || JSON.stringify(back) !== raw) return false;
  }
  return true;
}

// roomW turns the room passphrase into the SPAKE2 scalar. The count is high on
// purpose: it is the price of one guess at the passphrase after a dump, and it
// is paid here, where the passphrase never leaves the page.
export function roomW(pass, room) {
  // An open room has no passphrase, and an empty password would make SPAKE2
  // prove the same public constant to everyone. That is exactly what an open
  // room means, so the empty case gets a fixed label and the exchange still
  // runs: a room with a passphrase is indistinguishable from an open one on
  // the wire.
  const secret = pass === '' ? '\u0000open room' : pass;
  const out = pqCall((json) => pqModule().spakew(json), { pass: secret, salt: room });
  if (!out || !out.w) throw new Error('the room key could not be derived');
  return out.w;
}

// Sealed negotiation. An offer, an answer and a candidate travel inside the
// pair channel like a name does, so the server relays a blob and never sees a
// codec, a fingerprint or an address. Both sides only reach this point after
// the handshake, so the keys are always there.
export function sealedSendSdp(peer, kind, sdp) {
  if (!peer.keys || !sdp) return;
  sealedSend(peer, { k: 'sdp', d: kind, s: sdp });
}

export function sealedSendCand(peer, cand) {
  if (!peer.keys || !cand) return;
  sealedSend(peer, { k: 'cand', c: cand });
}

export function sealedSend(peer, obj) {
  if (!peer.keys) return;
  const seq = peer.seqOut + 1;
  const out = pqCall((json) => pqModule().seal(json), {
    key: b64e(peer.keys.sendChat),
    aad: b64e(chatAAD(peer.id, seq)),
    pt: b64e(sealUtf8.encode(padPayload(obj))),
  });
  if (!out || !out.b) return;
  peer.seqOut = seq;
  sealedSendOpaque(peer.id, { k: 'app', q: seq, b: out.b });
}

// toSealed sends one sealed message to every guest in the room. A guest that
// waits outside has no keys, and the room is not its yet, so it gets nothing.
export function toSealed(obj) {
  for (const peer of state.peers.values()) {
    if (!peer.keys || peer.waiting) continue;
    sealedSend(peer, obj);
  }
}

export function sendSealedChat() {
  const input = $('chat-text');
  const text = (input.value || '').trim();
  if (!text || !state.self || state.waiting) return;
  input.value = '';
  canary(text);
  addChatLine(state.name, text, Date.now());
  state.chatSent++;
  toSealed({ k: 'chat', n: state.name, x: text, ts: Date.now() });
}

// sealedSetName paints the decrypted name. The volume is kept under the peer
// key, so a name that arrives late never moves it.
export function sealedSetName(peer, raw) {
  const name = cleanSealedName(raw);
  if (!name || peer.name === name) return;
  peer.name = name;
  if (peer.tile) paintName(peer.tile, name, false);
  if (peer.screenTile) paintName(peer.screenTile, `${name}, screen`, false);
}

// sealedSetE2E paints the key state and the short code on one tile.
export function sealedSetE2E(peer, status) {
  peer.ready = status;
  updatePinCount();
  if (!peer.tile) return;
  peer.tile.dataset.e2e = status;
  paintState(peer);
  paintPin(peer);
}

// refreshCodeCard redraws the sealed card of one host, a tile or a list row,
// when its menu is open. A closed menu reads the code when it opens; an open
// one needs a redraw, because the code of a pair can arrive after it opened.
export function refreshCodeCard(host, peer) {
  const menu = hostMenu(host);
  if (!menu || menu.hidden) return;
  if (menu.classList.contains('row-menu') && menu.dataset.peer !== (host.dataset.peer || ''))
    return;
  let card = menu.querySelector('.sas');
  if (!peer.sas) {
    if (card) card.remove();
    return;
  }
  if (!card) {
    card = document.createElement('div');
    card.className = 'sas';
    menu.appendChild(card);
  }
  card.replaceChildren(...sealedCodePanel(peer));
}

// paintState is the one place a tile says how far the link is. A ready link is
// called unverified, in red, until its fingerprint is one this browser pinned.
// Once it is pinned the words go away: the tile then carries the guest's own
// label and a green chip, and a second label beside the name says nothing new.
// A signature alone proves continuity inside the call, which is a weaker claim.
export function paintState(peer) {
  if (!peer.tile) return;
  const badge = peer.tile.querySelector('.state');
  if (!badge) return;
  const known = peer.ready === 'ready' && pinState(peer) === 'known';
  badge.hidden = known;
  badge.dataset.e2e = known
    ? 'known'
    : peer.ready === 'ready'
      ? 'unverified'
      : peer.ready === 'failed'
        ? 'failed'
        : '';
  badge.textContent = known
    ? ''
    : peer.ready === 'ready'
      ? 'e2e unverified'
      : peer.ready === 'failed'
        ? 'e2e FAILED'
        : peer.ready || '';
}

// sealedCodePanel builds the code card of one guest: a small heading, the six
// OpenMoji drawings, the code in groups of four, and the identity line. The two
// prove different things and the card keeps them apart: the code proves that
// this pair shares one secret now, the fingerprint names who the peer is.
// Neither tells how long the secret will live, which is one call.
export function sealedCodePanel(peer) {
  const code = peer.sas;
  const head = document.createElement('span');
  head.className = 'sas-head';
  head.textContent = 'sealed code';
  const row = document.createElement('span');
  row.className = 'sas-row';
  for (const [emoji, name, hex] of verifyEmojis(code)) {
    // Each drawing carries its own name in a card of its own: the six of them
    // are easy to mix up at a glance, so pointing at one says which it is.
    // The name is drawn here rather than left to the native title bubble,
    // because the card lets the pointer through to the tile underneath.
    const cell = document.createElement('span');
    cell.className = 'sas-cell';
    const img = document.createElement('img');
    img.className = 'sas-emoji';
    img.src = `/openmoji/${hex}.svg`;
    img.alt = emoji;
    img.title = name;
    const tip = document.createElement('span');
    tip.className = 'sas-tip';
    tip.textContent = name;
    cell.append(img, tip);
    row.appendChild(cell);
  }
  const text = document.createElement('span');
  text.className = 'sas-code';
  text.textContent = String(code || '').replace(/(.{4})(?=.)/g, '$1 ');
  return [head, row, text, sealedIdentityRow(peer)];
}

// sealedIdentityRow is the who of one pair: the pin label and the fingerprint.
export function sealedIdentityRow(peer) {
  const row = document.createElement('span');
  row.className = 'id-row';
  const what = pinState(peer);
  const state = document.createElement('span');
  state.className = 'id-state';
  state.dataset.pin = what;
  state.textContent =
    what === 'changed' ? 'changed' : what === 'rollback' ? 'old key back' : 'unverified';
  const which = document.createElement('span');
  which.className = 'id-fp';
  which.textContent = peer.fp || 'no fingerprint yet';
  // a pinned pair shows its label as the button: one click renames it
  if (what === 'known') {
    row.append(
      pinButton(pinLabelOf(peer) || 'pinned', () =>
        renamePin(peer, prompt('new name for this device', pinLabelOf(peer)) || ''),
      ),
    );
  } else row.append(state);
  row.append(which);
  if (what === 'new' && peer.fp) {
    row.append(
      pinButton('pin this device', () =>
        pinPeer(peer, prompt('label for this device', peer.name) || ''),
      ),
    );
  } else if (what === 'changed' || what === 'rollback') {
    row.append(pinButton('this device was reset', () => resetDevice(peer, peer.pinLabel)));
  }
  return row;
}

export function pinButton(text, onclick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pin-btn';
  button.textContent = text;
  button.addEventListener('click', onclick);
  return button;
}
