/*
 The room gate: the passphrase and who is in.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { clamp, isAdmin, say, setAdmins } from './util.js';
import { ownTile, paintName, paintRowDeaf, rowOf } from './tiles.js';
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
import { store } from './prefs.js';
import { setChrome } from './phone.js';
import { setGuestFlags } from './presence.js';

// ------------------------------------------------------ sealed room control
//
// Role, waiting switch, let in, kick and mute are sealed commits, one per pair:
// the server relays a blob and learns nothing. A role list and a switch carry a
// counter: the highest wins, the lower peer id breaks a tie.
//
// The claim wire format is `claim/2`. The 2 is the step-0 rule: a role list no
// longer starts from whoever signs first. Steps 0 and 1 are both signed by the
// identity of the page that holds the room, and that page is the one whose
// fingerprint is in the room id:
//
//   <32 base32 chars, the room creator's identity fingerprint>-<room name>
//
// A room named without that prefix (a typed name, a link from an older build)
// has no root, so nobody in it is an admin until the room is handed its root:
// the waiting-room switch and a passphrase change then need the passphrase
// itself instead (see below). The 1 was the UNROOTED format: a claim/1 signed
// by any proven member was adopted as step 0, which let a member of an open
// room take the role. A claim/1 or claim/1 line is no longer signed and no
// longer adopted.

// ROOTED is the room id shape this build mints: a fingerprint, a dash, a name.
export const ROOTED = /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-([a-z0-9._-]{1,40})$/;

// rootFingerprint is the identity fingerprint that roots this room, or '' for a
// room that has none yet. A room id this build mints carries it; a room named
// any other way gets one from the page that created it, recorded locally
// (identity.ts adoptRoot) and read into state.root at the join and when a claim
// asks for it.
export function rootFingerprint(room) {
  const m = ROOTED.exec(String(room || ''));
  if (m) return m[0].slice(0, 23);
  return state.root || '';
}

// setRoot installs the root this page read from a room record, unless the page
// already holds one.
export function setRoot(fp) {
  if (fp && !state.root) state.root = fp;
}

// roomNameOf is the human name of a room: the label after the root prefix, or
// the whole id.
export function roomNameOf(room) {
  const m = ROOTED.exec(String(room || ''));
  return m ? m[1] : String(room || '');
}

// claimText is the exact byte string a role claim signs. The room id binds the
// claim to this room (salt is the whole id), the counter orders two admins that
// act at once, and ROOT binds a step to the identity that made the room, so a
// claim signed for a rooted room can never be replayed into another one. The
// signer is inside the text as well as in the signature, so a step names who
// signed it even after that page is gone.
// The text is UTF-8; sign() always takes base64 of these bytes (see botSign),
// and the module decodes it once before it checks the signature, so the two
// sides agree on exactly these bytes and on nothing else.
export function claimText(n, admins, by = '') {
  const who = by ? String(by) : '';
  const root = rootFingerprint(state.room) || '-';
  return `stanze/claim/2|${state.room}|${n}|${root}|${who}|${admins.join(',')}|`;
}

// botSign signs one message for the long-term identity and hands back base64.
// The only encoding is here, once: a WebCrypto identity signs the decoded
// bytes, a seed identity signs through the module, and both answer base64 of
// that signature over exactly those bytes. A caller never holds the text it
// signed, so a verify can not check a different encoding than the sign used.
export async function botSign(msg) {
  const bytes = b64e(sealUtf8.encode(String(msg || '')));
  let sig;
  try {
    sig = await state.idKey.sign(bytes);
  } catch {
    return '';
  }
  return typeof sig === 'string' ? sig : '';
}

// botVerify checks one base64 signature over one text against a base64
// identity. It is the verifier of every signed statement the page accepts.
export function botVerify(id, msg, sig) {
  if (!id || typeof sig !== 'string' || !sig) return false;
  const res = pqCall((json) => pqModule().idverify(json), {
    id,
    msg: b64e(sealUtf8.encode(String(msg || ''))),
    sig,
  });
  return !!(res && res.ok);
}

// isRootOwner answers whether this page holds the identity the room id names.
// A page with no root (an unrooted room, an identity not yet loaded) is not the
// owner, so it may not seed step 0 anywhere.
export function isRootOwner(root) {
  return !!root && !!state.idKey && state.idKey.fp === root;
}

// makeClaim signs one role list with the identity this page announced in the
// handshake, so every page that holds that key can check it.
async function makeClaim(n, admins) {
  if (!state.idKey) return null;
  const sig = await botSign(claimText(n, admins, state.self));
  if (!sig) return null;
  return { n, admins: admins.slice(), by: state.self, sig };
}

// adoptClaim installs a checked claim: the role list, its counter and the page
// that signed it.
function adoptClaim(claim) {
  state.auth = { n: claim.n, admins: claim.admins.slice(), by: claim.by, sig: claim.sig };
  setAdmins(claim.admins);
  markAdmins();
  paintWaiting();
}

// issueClaim makes a claim current here and sends it to every pair.
export async function issueClaim(n, admins) {
  const unique = [...new Set(admins)].filter((id) => /^[0-9a-f]{12}$/.test(String(id || '')));
  if (!unique.length) return false;
  // Only a step beyond the claim this page holds is issued, and only by an
  // admin of that step. A room that has lost every admin can not mint one:
  // that is a known limit of claim/2. Step 0 is the seed, and only the identity
  // the room id names may seed it.
  if (n === 0) {
    if (state.auth.n >= 0) return false;
    if (!isRootOwner(rootFingerprint(state.room))) return false;
  } else if (n === 1) {
    // The handover: the root turns its own step 0 into a room with members.
    // Only the root, and only from its own step 0.
    if (state.auth.n !== 0 || !isRootOwner(rootFingerprint(state.room))) return false;
  } else {
    if (state.auth.n < 0 || n !== state.auth.n + 1) return false;
    if (!state.admins.has(state.self)) return false;
  }
  const claim = await makeClaim(n, unique);
  if (!claim || state.leaving) return false;
  adoptClaim(claim);
  toSealed({ k: 'claim', n: claim.n, admins: claim.admins, by: claim.by, sig: claim.sig });
  return true;
}

// sealedSendClaim answers a page that just proved the room and asked who holds
// the role. A page with no claim of its own has nothing to say.
export function sealedSendClaim(peer) {
  if (state.auth.n < 0) return;
  sealedSend(peer, {
    k: 'claim',
    n: state.auth.n,
    admins: state.auth.admins,
    by: state.auth.by,
    sig: state.auth.sig,
  });
}

// stepOneAdmins is the list step 1 carries when the root hands over to the
// members: the root itself, the member it was asked to give the role to, and
// every other member present, up to five in all. The root stays in the list,
// because only an admin of a step can sign the next one.
export function stepOneAdmins(want) {
  const list = [state.self];
  if (want && want !== state.self) list.push(want);
  for (const peer of state.peers.values()) {
    if (list.length >= 5) break;
    if (peer.proven && !peer.waiting && !list.includes(peer.id)) list.push(peer.id);
  }
  return list;
}

// handOver asks the root, if this page is not it, to make this page an admin of
// step 1. Both frames travel sealed over a pair that proved the passphrase, so
// it works in an open room and behind any passphrase the member holds. A page
// asks twice at most: no answer is an answer too.
export function handOver(peer, why) {
  if (!peer || !peer.keys || peer.waiting) return;
  const root = rootFingerprint(state.room);
  if (!root || root === (state.idKey && state.idKey.fp)) return;
  peer.handAsks = (peer.handAsks || 0) + 1;
  if (peer.handAsks > 2) {
    say('nobody here holds the key this room was made with, so nobody can change ' + why);
    return;
  }
  sealedSend(peer, { k: 'handover', why: String(why || '').slice(0, 32) });
}

// onHandover is the root's answer to handOver: it moves its own step 0 to
// step 1, naming the asking member. It is asked for by sealedOnCtl, on a pair
// that proved the room, and answers nothing to a page that holds no role yet.
export function onHandover(peer) {
  if (state.auth.n !== 0 || !isRootOwner(rootFingerprint(state.room))) return;
  if (peer.waiting || isAdmin(peer.id)) return;
  void issueClaim(1, stepOneAdmins(peer.id));
}

// sealedOnClaim checks one claim. Every claim is a signature by one identity
// over the claim text, and the sender must be that identity; what follows is
// the step rule:
//   step 0 must be signed by the page whose fingerprint the room id names, so
//     the first admin is the page that made the room, never whoever joined
//     first;
//   step 1 must be signed by that same root and start from its own step 0, so
//     the handover to members is still the root's decision;
//   every later step goes up by one from the step this page holds, is signed
//     by an admin of that step, and names that admin in its list.
// A page that already holds a claim never takes a foreign one in place of it
// except as the next step, so a second root claim can not overwrite the list.
export function sealedOnClaim(peer, obj) {
  if (!peer.proven || !peer.pub || !peer.pub.id) return;
  const n = Number(obj.n);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) return;
  if (!Array.isArray(obj.admins) || !obj.admins.length || obj.admins.length > 64) return;
  if (obj.admins.some((id) => typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id))) return;
  if (typeof obj.sig !== 'string' || !obj.sig) return;
  // The sender is the signer: a page signs only for its own identity, so a
  // claim in another's name is refused whatever its bytes say.
  if (obj.by !== peer.id || !obj.admins.includes(peer.id)) return;
  // The signed text names the signer too, so a signature made over another
  // step cannot be lifted into this one.
  if (!botVerify(peer.pub.id, claimText(n, obj.admins, obj.by), obj.sig)) return;
  const root = rootFingerprint(state.room);

  if (n === 0) {
    if (!root || !isRootOwner(root)) return; // no root here, or not the root's page
    if (peer.fp !== root) return; // step 0 belongs to the room's identity only
    if (obj.by !== state.self || obj.admins.length !== 1 || obj.admins[0] !== state.self) return;
    if (state.auth.n >= 0) return; // this page holds its own seed already
    adoptClaim(obj);
    return;
  }
  if (n === 1) {
    if (!root || !isRootOwner(root) || peer.fp !== root) return;
    if (state.auth.n !== 0 || state.auth.by !== state.self) return;
    if (obj.by !== state.self) return;
    adoptClaim(obj);
    return;
  }
  if (state.auth.n < 0) return; // a step above the seed needs a step to follow
  if (n !== state.auth.n + 1) return;
  if (!state.admins.has(peer.id)) return;
  if (obj.admins.join(',') === state.auth.admins.join(',')) return;
  adoptClaim(obj);
}

// startAuthSeed lets a page into a room it is alone in, and gives a rooted room
// a first admin before anyone else joins: the page that made the room. The two
// are separate decisions. Admission to an empty room is a waiting-room matter
// and happens for any page; the first role is a root matter, so a page whose
// identity is not in the room id seeds no claim and asks the root for one
// instead (see startRootAsk). An unrooted room therefore has no admin until it
// is handed a root, and README says so.
export function startAuthSeed() {
  if (state.authTimer) clearTimeout(state.authTimer);
  state.authTimer = setTimeout(() => {
    state.authTimer = null;
    if (state.leaving || !state.self) return;
    // A room with nobody else in it has no member to let this page in, so the
    // first guest takes the room.
    if (!state.peers.size && state.waiting) admitPeer(state.self);
    if (state.auth.n >= 0) return;
    if (!isRootOwner(rootFingerprint(state.room))) return;
    void issueClaim(0, [state.self]);
  }, 1200);
}

// startRootAsk is the guest half of the seed: when the member that made the
// room speaks on a proved pair, ask it for a role. A room with no root never
// asks, and no page answers.
export function startRootAsk(peer) {
  const root = rootFingerprint(state.room);
  if (!root || state.auth.n >= 0 || !peer || peer.waiting) return;
  peer.handAsks = 0;
  handOver(peer, 'the waiting room');
}

// resealOnLeave drops a member that left from the role list. The first admin
// left in the list signs the new claim, so one page does it. A room with no
// admin left keeps the last step: a claim never falls back below 2, because a
// step 1 signed by the root would otherwise be reachable again.
export function resealOnLeave(id) {
  if (!state.auth.admins.includes(id)) return;
  const rest = state.auth.admins.filter((other) => other !== id);
  if (!rest.length) return;
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
// with no role can not move it, and no page obeys a sender that holds none. It
// asks the page that made the room for the role first, so a member of a rooted
// room is never locked out of its own switch.
export function setWaitingRoom(on) {
  if (state.waiting) return;
  if (!isAdmin(state.self)) {
    askRoot('the waiting room');
    return;
  }
  const n = state.wait.n + 1;
  state.wait = { on: !!on, n };
  state.waitingRoom = !!on;
  toSealed({ k: 'wait', on: !!on, n });
  paintWaiting();
  if (!on) admitAllHeld();
}

// askRoot sends the hand-over request over every proved pair: only the page
// with the room's identity answers it, and it answers with a role claim.
export function askRoot(why) {
  for (const peer of state.peers.values()) {
    if (peer.pass && peer.pass.done && !peer.waiting) handOver(peer, why);
  }
}

// sealedAdmit lets one held guest in. Any member may do it: the gate proof
// already showed that both pages hold the room, so no server has a say.
export function sealedAdmit(peer) {
  if (!peer || state.waiting) return;
  sealedSend(peer, { k: 'admit' });
}

// admitAllHeld lets every guest still outside in. A guest asks only a few times
// and then goes quiet, so the room must not rely on another ask. The admit is
// idempotent, so every page may send it.
export function admitAllHeld() {
  if (state.waiting) return;
  for (const peer of state.peers.values()) {
    if (!peer.waiting) continue;
    sealedAdmit(peer);
    admitPeer(peer.id);
  }
}

// maybeAdmitHeld runs when a held guest says so. A member with the switch off
// lets it in; with no member inside, the lower id keeps the room and lets the
// other in, so a room never stays shut with nobody inside.
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
// side and stops with the room; the count is capped so a silent room stays quiet.
function askHeldAgain(peer) {
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

// sealedOnIn is a guest saying it is inside. The claim is a hint, not a
// permission: the room applies its own waiting rule.
export function sealedOnIn(peer) {
  if (state.waiting || !peer || !peer.waiting) return;
  maybeAdmitHeld(peer);
}

// sealedKick removes one peer from every page, so a page that ignores the notice
// talks to nobody. Its identity goes on the refused list, so the key can not
// come back.
export function sealedKick(id) {
  if (!id || id === state.self) return;
  if (!isAdmin(state.self)) {
    askRoot('removing a guest');
    return;
  }
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
  if (!id || id === state.self) return;
  if (!isAdmin(state.self)) {
    askRoot('muting a guest');
    return;
  }
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
// The worker pads a sender only when the peer has said it reads padding.
function padsOn(peer) {
  if (!state.worker || !peer || peer.padsOn) return;
  peer.padsOn = true;
  for (const kind of ['audio', 'video']) {
    state.worker.postMessage({ type: 'pad', pair: pairLabel(peer.id), kind, on: true });
  }
}

// filterName narrows a reported noise model to the names this page uses, so a
// value off the wire reaches the stats panel as one of three words or nothing.
function filterName(value) {
  return value === 'gtcrn' || value === 'fastenhancer' || value === 'off' ? value : '';
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
  // The camera and microphone lamps of the presence line are the guest's own
  // word, and they are what a name tag shows.
  setGuestFlags(peer.id, { cam: obj.cam !== undefined ? !!obj.cam : undefined, mic: obj.mic !== undefined ? !!obj.mic : undefined });
  if (obj.deaf !== undefined) peer.deaf = !!obj.deaf;
  // The two noise models the guest reports: its microphone filter and the one
  // it runs on the stream this pair sends to it. An older guest sends neither.
  if (obj.outFilter !== undefined) peer.outFilter = filterName(obj.outFilter);
  if (obj.inFilter !== undefined) peer.inFilter = filterName(obj.inFilter);
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
    peer.handTs = peer.hand ? clamp(Number(obj.ts) || 0, 0, Date.now()) : 0;
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

// renameSelf changes the name of this page after the join. The new name is kept
// in the browser, the own tile and its row show it at once, and every pair that
// already proved its keys is told again, so the others read the new name now.
export function renameSelf(raw) {
  const name = cleanSealedName(raw);
  if (!name || name === state.name) return false;
  state.name = name;
  store('name', name);
  const self = ownTile();
  if (self) paintName(self, name, true);
  for (const peer of state.peers.values()) {
    if (!peer.keys) continue;
    peer.announcedName = '';
    sealedAnnounceName(peer);
  }
  return true;
}

export function sealedAnnounceName(peer) {
  if (!peer.keys || !state.name || peer.announcedName === state.name) return;
  peer.announcedName = state.name;
  sealedSend(peer, { k: 'name', n: state.name });
}

// A sealed payload is padded to a fixed bucket before sealing, so the ciphertext
// length stops saying what was sent. The true length rides inside as the filler
// field and the receiver drops it; the biggest bucket repeats for larger payloads.
// The filler key is `p` and no frame may use it for content: an older build padded
// under `z`, which the file offer also used for the size, and the receiver dropped
// the size with the filler, so no offer ever showed.
export const PAD_KEY = 'p';

const PAD_BUCKETS = [512, 2048, 8192];

const PAD_LAST = PAD_BUCKETS[PAD_BUCKETS.length - 1];

// A frame may not use the filler key for content: the filler is written over it
// and the receiver drops it, so the field would vanish. The file offer used it
// for the size and no offer ever showed. This check holds for every frame, now
// and later, because it sits on the one path every sealed frame takes.
function padPayload(obj) {
  if (Object.prototype.hasOwnProperty.call(obj, PAD_KEY)) throw new Error('the padding key is reserved');
  const withPad = Object.assign({}, obj, { [PAD_KEY]: '' }) as any;
  const bytes = sealUtf8.encode(JSON.stringify(withPad)).length;
  let target = PAD_BUCKETS.find((n) => n >= bytes);
  if (!target) target = Math.ceil(bytes / PAD_LAST) * PAD_LAST;
  const need = target - bytes;
  if (need > 0) withPad[PAD_KEY] = 'A'.repeat(need);
  return JSON.stringify(withPad);
}

// padRoundTripOk proves the padding is a round trip and that every outgoing size
// lands on a bucket or a whole multiple of the biggest one. It runs in the
// post-quantum self test, before a call starts.
export function padRoundTripOk() {
  const cases = [
    { k: 'name', n: 'abc' },
    { k: 'chat', n: 'a', x: 'hello', ts: 1 },
    { k: 'chat', n: 'b', x: '\u00e9'.repeat(400) },
    { k: 'file', a: 'offer', x: '0123456789abcdef', n: 'probe.bin', z: 4096, m: '' },
    { k: 'asr', n: 'c', x: 'z'.repeat(9000) },
  ];
  for (const c of cases) {
    const raw = JSON.stringify(c);
    const out = padPayload(c);
    const bytes = sealUtf8.encode(out).length;
    const onBucket = PAD_BUCKETS.includes(bytes) || bytes % PAD_LAST === 0;
    const back = JSON.parse(out);
    delete back[PAD_KEY];
    if (!onBucket || JSON.stringify(back) !== raw) return false;
  }
  return true;
}

// roomW turns the room passphrase into the SPAKE2 scalar. The count is high on
// purpose: it prices one guess after a dump, and it is paid here, where the
// passphrase never leaves the page.
export function roomW(pass, room) {
  // An open room has no passphrase, and an empty password would make SPAKE2
  // prove the same public constant to everyone. The empty case gets a fixed
  // label, so an open room and a passphrase room look alike on the wire.
  const secret = pass === '' ? '\u0000open room' : pass;
  const out = pqCall((json) => pqModule().spakew(json), { pass: secret, salt: room });
  if (!out || typeof out.w !== 'string' || !out.w) throw new Error('the room key could not be derived');
  return out.w;
}

// Sealed negotiation: an offer, an answer and a candidate travel inside the pair
// channel, so the server relays a blob and never sees a codec, a fingerprint or
// an address. Both sides reach this point only after the handshake.
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
    aad: b64e(chatAAD(peer.id, seq, state.idKey && state.idKey.pub, peer.pub && peer.pub.id)),
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

// refreshCodeCard redraws the sealed card of one host, a tile or a row, while
// its menu is open: the code of a pair can arrive after it opened.
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

// paintState is the one place a tile says how far the link is. A ready link
// reads unverified, in red, until its fingerprint is pinned; then the words go
// away and the tile carries the guest's label and a green chip.
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

// sealedCodePanel builds the code card of one guest: a heading, the six OpenMoji
// drawings, the code in groups of four and the identity line. The code proves
// this pair shares one secret now; the fingerprint names who the peer is.
export function sealedCodePanel(peer) {
  const code = peer.sas;
  const head = document.createElement('span');
  head.className = 'sas-head';
  head.textContent = 'sealed code';
  const row = document.createElement('span');
  row.className = 'sas-row';
  for (const [emoji, name, hex] of verifyEmojis(code)) {
    // Each drawing carries its name drawn in the card: the six are easy to mix
    // up, and the card lets the pointer through, so no native title bubble.
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
function sealedIdentityRow(peer) {
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

function pinButton(text, onclick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pin-btn';
  button.textContent = text;
  button.addEventListener('click', onclick);
  return button;
}
