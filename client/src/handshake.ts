/*
 The post-quantum handshake of a pair.
*/

import { state } from './state.js';
import { isAdmin, say } from './util.js';
import { send } from './menu.js';
import { paintVolume, storedVolume } from './volume.js';
import { disableMic, preparePeer } from './devices.js';
import { sealedSendState, setHand } from './audio.js';
import { connectPeer, ensurePeer, onCandidate, onDescription } from './peers.js';
import { addChatLine } from './chat.js';
import { fileDropPeer, fileOnMessage } from './files.js';
import {
  b64d,
  b64e,
  chatAAD,
  decOpaque,
  encOpaque,
  pairLabel,
  pqCall,
  pqModule,
  sealUtf8,
  sealedOnOffer,
  sealedSendOpaque,
  shortPeer,
  peerName,
} from './sealed.js';
import { fingerprint, paintPin, pinState, updatePinCount } from './identity.js';
import { scriptURL } from './trust.js';
import { setTalks } from './presence.js';
import { asrAnnounce, asrOnMessage } from './asr.js';
import {
  PAD_KEY,
  maybeAdmitHeld,
  roomW,
  sealedAnnounceName,
  sealedKick,
  onHandover,
  sealedOnAdmit,
  sealedOnClaim,
  sealedOnHeld,
  sealedOnIn,
  sealedOnKick,
  sealedOnState,
  sealedOnWait,
  sealedSend,
  sealedSendClaim,
  sealedSetE2E,
  sealedSetName,
  toSealed,
} from './gate.js';

// ------------------------------------------------------------- handshake
//
// The bundle carries the per-call keys, the long-term identity and a session id
// fresh on every join. Both sides sign one transcript and check the other's
// signature and confirmation tag in one gate, so a pair is proven or not at
// all; the keys are HKDF over the ephemeral secrets and reach the worker only
// after that gate.
// sealedSendPub sends the key bundle to one peer, or broadcasts it: with no
// roster from the server a page has no ids to address, so the room learns of
// it from this bundle alone.
export function sealedSendPub(peer) {
  if (!state.identity || !state.idKey) return;
  const bundle = {
    k: 'pub',
    x: state.identity.xpub,
    m: state.identity.ek,
    id: state.idKey.pub,
    sid: state.sid,
  };
  if (peer) sealedSendOpaque(peer.id, bundle);
  else send({ t: 'enc', b: encOpaque(bundle) });
}

// sealedRefuse closes a pair for good: a relay that strips the identity fields
// would otherwise leave a working pair with no authentication.
function sealedRefuse(peer, why) {
  if (!state.peers.has(peer.id)) return;
  state.identityFailures++;
  if (peer.pc) {
    peer.pc.close();
    peer.pc = null;
  }
  wipeKeys(peer);
  sealedSetE2E(peer, 'failed');
  say(shortPeer(peer.id) + ' ' + why + '; the link stays closed');
  updatePinCount();
}

// sealedGapReset is M3 on the receiving side: a sequence gap means one frame of
// this pair was lost on the way, and the socket is ordered, so every later frame
// would fail the counter for the rest of the call. The pair starts again
// instead: new keys in the worker, and one side opens a fresh handshake over the
// live socket. Media is stopped first so nothing keeps flowing on the keys the
// new handshake replaces.
const GAP_RESETS_MAX = 3;

function sealedGapReset(peer) {
  peer.gapResets = (peer.gapResets || 0) + 1;
  if (peer.gapResets > GAP_RESETS_MAX) {
    // A pair that keeps losing frames is not repaired by starting again.
    sealedRefuse(peer, 'keeps losing sealed frames');
    return;
  }
  if (peer.pc) {
    peer.pc.close();
    peer.pc = null;
  }
  sealedRestart(peer, true);
  say(shortPeer(peer.id) + ': one sealed frame went missing, so the link starts again');
}

// sealedRefusePass closes a pair that failed the room proof, so a wrong
// passphrase costs one handshake. Only a member kicks, and only an admin kicks
// at all; a page that waits outside stays. A spakeok from a pair that proved no
// passphrase is never a reason to leave the room.
export function sealedRefusePass(peer) {
  // A failed proof is not an identity failure: it must not read as an attack on
  // the identity pins, so it closes the pair without touching the pin count.
  if (!state.peers.has(peer.id)) return;
  if (peer.pc) {
    peer.pc.close();
    peer.pc = null;
  }
  wipeKeys(peer);
  sealedSetE2E(peer, 'failed');
  say(shortPeer(peer.id) + ' does not know the room passphrase; the link stays closed');
  if (state.waiting) return;
  // The admin removes the identity, not the socket, so the same guest can not
  // come back on a fresh pair in this call.
  if (!isAdmin(state.self) || isAdmin(peer.id)) return;
  sealedKick(peer.id);
}

// sealedRestart drops a pair's state so a new handshake can run: a deliberate
// "this device was reset", or a peer that comes back with a fresh session id.
export function sealedRestart(peer, resend) {
  // A restart is a new generation: every key import still in flight belongs to
  // the old one and must not resolve the gate of this one.
  peer.gen = ++state.keyGen;
  const waiting = state.keyWait.get(pairLabel(peer.id));
  if (waiting) {
    state.keyWait.delete(pairLabel(peer.id));
    waiting.resolve(false);
  }
  wipeKeys(peer);
  peer.pub = null;
  peer.transcript = null;
  peer.sas = '';
  peer.confirmed = false;
  peer.myConfirm = '';
  peer.mySig = '';
  peer.sentConfirm = false;
  peer.fp = '';
  peer.proven = false;
  peer.ready = '';
  peer.keyPromise = null;
  peer.seqOut = 0;
  peer.seqIn = 0;
  peer.announcedName = '';
  // Frames held for the old pair can never belong to the new one.
  peer.appPending = [];
  peer.appHeld = [];
  peer.pass = null;
  peer.passEarly = [];
  // The budget does not restart with the pair: it is spent by the page, and a
  // page that restarted its own pair must not get its tries back.
  if (peer.passTimer) clearTimeout(peer.passTimer);
  peer.passTimer = null;
  for (const t of peer.passHold || []) clearTimeout(t);
  peer.passHold = [];
  peer.ctlPending = [];
  fileDropPeer(peer);
  if (peer.pc) {
    peer.pc.close();
    peer.pc = null;
  }
  if (peer.tile) peer.tile.dataset.sas = '';
  sealedSetE2E(peer, 'new');
  if (resend) sealedSendPub(peer);
  // A pair that restarted still owes the room its proof, and the restart has
  // just emptied it: the passphrase exchange can not start with no keys, so a
  // lower id asks to be looked at again and the bundle it gets back starts the
  // exchange on the emptied pair. Without this the pair sits keyed and silent.
  if (resend && peer.keys && String(state.self) < String(peer.id)) sealedHoldPass(peer);
}

// sealedHoldPass keeps a proof this page may not start yet: the window is spent
// on another pair. It is retried a few times, because a pair with its keys in
// and no proof is a pair that will never carry a frame.
const PASS_HOLDS_MAX = 6;

function sealedHoldPass(peer) {
  if (peer.pass || peer.passSpent || (peer.passHold || []).length >= PASS_HOLDS_MAX) return;
  const timer = setTimeout(() => {
    peer.passHold = (peer.passHold || []).filter((t) => t !== timer);
    if (!state.peers.has(peer.id) || state.leaving || peer.pass || !peer.keys) return;
    if (startPassNow(peer)) sealedOfferPass(peer);
    else sealedHoldPass(peer);
  }, PASS_SPEND_MS + 100);
  (peer.passHold = peer.passHold || []).push(timer);
}

// sealedOnPub decides which side initiates: the lower peer id, and the other
// answers the hello. A bundle with a new session id is the same guest on a fresh
// call, so the old pair goes first.
function sealedOnPub(peer, msg) {
  if (peer.pub && peer.pub.sid && msg.sid && peer.pub.sid !== msg.sid) sealedRestart(peer, false);
  peer.pub = { x: msg.x, m: msg.m, id: msg.id || '', sid: msg.sid || '' };
  if (!peer.pub.id || !peer.pub.sid) {
    sealedRefuse(peer, 'sent no identity');
    return;
  }
  // The lower peer id went looking for this bundle, so its hello goes now; the
  // other side answers it in sealedRespond, which installs the keys.
  if (!peer.keys && !peer.keyPromise && String(state.self) < String(peer.id)) {
    peer.sentPub = true;
    sealedInitiate(peer).catch(() => sealedRefuse(peer, 'handshake failed'));
  }
  sealedDrainCtl(peer);
}

// startPassNow answers whether this page may begin the passphrase exchange of
// this pair now: keys installed, no exchange yet, nothing spent, and the last
// start older than one window. The pacing lives here, at the bundle, because a
// peer that re-sends its bundle would otherwise drive an exchange per frame.
function startPassNow(peer) {
  if (!peer.keys || peer.keyPromise || peer.pass || peer.passSpent) return false;
  if (state.passTries >= PASS_PAGE_TRIES) return false;
  return passMayStart(Date.now());
}

// sealedProved records that the peer's signature over this transcript checked
// out. It is the only moment a fingerprint of that peer means anything.
function sealedProved(peer) {
  peer.proven = true;
  peer.fp = fingerprint(peer.pub.id);
  paintPin(peer);
  // The key is proven now, so the kept volume of this guest can load, and a
  // later move of this guest under the same key finds it again.
  peer.vol = storedVolume(peer);
  paintVolume(peer);
  rememberInside(peer);
  asrAnnounce(peer);
}

// rememberInside keeps the waiting room from locking out a member whose link
// dropped: a proven key that was inside is let in again without a member. Only
// a key proof counts, never a name; a kicked key is refused, and the list ends
// with the call.
function rememberInside(peer) {
  if (peer.fp && !peer.waiting) state.insideFps.add(peer.fp);
}

// wipeKeys zeroes one pair's secrets. They are the only copies outside the
// worker and the module, and they last as long as the pair does.
export function wipeKeys(peer) {
  if (!peer || !peer.keys) return;
  for (const value of Object.values(peer.keys)) {
    if (value instanceof Uint8Array) value.fill(0);
  }
  peer.keys = null;
  peer.keysInstalled = false;
}

// wipeIdentity zeroes the per-call X25519 and ML-KEM secret halves.
export function wipeIdentity() {
  if (!state.identity) return;
  for (const name of ['xsk', 'dk']) {
    const value = state.identity[name];
    if (value instanceof Uint8Array) value.fill(0);
  }
  state.identity = null;
}

// sealedHoldKeys keeps the agreed pair keys in this page until the peer has
// proved itself; they reach the worker only after that, so no frame of this pair
// opens before the identity is checked.
function sealedHoldKeys(peer, out) {
  wipeKeys(peer);
  peer.keys = {
    sendMedia: b64d(out.keys.sendMedia),
    recvMedia: b64d(out.keys.recvMedia),
    sendChat: b64d(out.keys.sendChat),
    recvChat: b64d(out.keys.recvChat),
  };
  peer.transcript = out.transcript;
  peer.seqOut = 0;
  peer.seqIn = 0;
  peer.sas = out.keys.sas;
  peer.myConfirm = out.confirm;
  peer.ready = 'handshake';
  if (peer.tile) peer.tile.dataset.sas = peer.sas;
  sealedSetE2E(peer, 'handshake');
}

// sealedInstallKeys hands the pair keys to the worker and returns a promise that
// the import resolves. The connection is built on that promise, so the first
// frame always meets a key.
function sealedInstallKeys(peer) {
  peer.keysInstalled = true;
  // The generation rises across the whole page, not per peer: a pair id that
  // comes back in a new peer object still gets a newer number than the worker
  // has seen, so its keys are never mistaken for a stale import.
  const gen = (peer.gen = ++state.keyGen);
  const pair = pairLabel(peer.id);
  return new Promise((resolve) => {
    if (!state.worker) {
      state.workerErrors.push('sealed worker missing');
      resolve(false);
      return;
    }
    state.keyWait.set(pair, { gen, resolve });
    state.worker.postMessage({
      type: 'keys',
      pair,
      peer: peer.id,
      gen,
      enc: b64e(peer.keys.sendMedia),
      dec: b64e(peer.keys.recvMedia),
    });
  });
}

// sealedProve runs the one gate the module offers: the peer's identity
// signature over this transcript and its confirmation tag, both or neither.
function sealedProve(peer, msg) {
  return pqCall((json) => pqModule().proved(json), {
    key: b64e(peer.keys.recvMedia),
    transcript: peer.transcript,
    tag: msg.c || '',
    id: msg.id || '',
    sig: msg.sig || '',
  });
}

// sealedPair is the bundle fields both calls name: ours first, then the peer's.
function sealedPair(peer) {
  return {
    self: state.self,
    peer: peer.id,
    selfX: state.identity.xpub,
    selfK: state.identity.ek,
    selfID: state.idKey.pub,
    selfSID: state.sid,
    peerX: peer.pub.x,
    peerK: peer.pub.m,
    peerID: peer.pub.id,
    peerSID: peer.pub.sid,
  };
}

// sealedSigned signs the transcript and holds the keys the gate proved. An empty
// answer means the pair is gone or the key cannot sign, and the peer has already
// heard why while it is still there.
async function sealedSigned(peer, out) {
  const sig = await state.idKey.sign(out.transcript);
  if (!state.peers.has(peer.id) || state.leaving) return '';
  if (!sig) {
    sealedRefuse(peer, 'could not sign the handshake');
    return '';
  }
  sealedHoldKeys(peer, out);
  peer.mySig = sig;
  return sig;
}

// sealedSendOk sends the confirmation that names us, so the other side can check
// us as soon as it has its keys. The same transcript covers both sides.
function sealedSendOk(peer, out) {
  peer.sentConfirm = true;
  sealedSendOpaque(peer.id, {
    k: 'ok',
    c: out.confirm,
    id: state.idKey.pub,
    sid: state.sid,
    sig: peer.mySig,
  });
}

async function sealedInitiate(peer) {
  if (!state.identity || !state.idKey || !peer.pub) return;
  const out = pqCall((json) => pqModule().initiate(json), sealedPair(peer));
  if (!out || out.error) {
    sealedRefuse(peer, 'refused the key bundle');
    return;
  }
  const sig = await sealedSigned(peer, out);
  if (!sig) return;
  sealedSendOpaque(peer.id, {
    k: 'hello',
    epk: out.epk,
    ct: out.ct,
    id: state.idKey.pub,
    sid: state.sid,
    sig,
  });
  sealedSendOk(peer, out);
}

async function sealedRespond(peer, msg) {
  if (!state.identity || !state.idKey || !peer.pub) return;
  // The hello must describe the bundle the peer broadcast. The signature over
  // the transcript would fail anyway; this refusal just names the reason.
  if (msg.id !== peer.pub.id || msg.sid !== peer.pub.sid) {
    sealedRefuse(peer, 'sent a hello for another identity');
    return;
  }
  const out = pqCall((json) => pqModule().respond(json), {
    ...sealedPair(peer),
    selfSK: b64e(state.identity.xsk),
    selfDK: b64e(state.identity.dk),
    epk: msg.epk,
    ct: msg.ct,
    sig: msg.sig || '',
  });
  if (!out || out.error) {
    sealedRefuse(peer, 'refused the hello');
    return;
  }
  if (!(await sealedSigned(peer, out))) return;
  sealedSendOk(peer, out);
  // The pair is not ready yet: the initiator's own ok has to prove it. That ok
  // may have arrived while this hello was answered, so the hold is drained here.
  sealedDrainCtl(peer);
}

// sealedOnProof is an `ok` from the peer, on either side. Nothing is announced
// as established before it passes: the signature names the peer, the tag shows
// that both ends hold the same keys, and the pin state judges the name.
async function sealedOnProof(peer, msg) {
  if (!peer.keys || !peer.pub || !peer.transcript) return;
  if (peer.confirmed) return;
  if (msg.id !== peer.pub.id || msg.sid !== peer.pub.sid) {
    // A proof for another session is the old handshake arriving late, not an
    // attack: the gate checks the signature over *this* transcript anyway, so a
    // drop here would tear down a fresh pair that crossed its own tail.
    return;
  }
  const res = sealedProve(peer, msg);
  if (!res || !res.ok) {
    const why = res && res.error ? res.error : 'the proof did not check out';
    if (/confirmation tag/.test(why)) {
      state.confirmFailures++;
      sealedSetE2E(peer, 'failed');
      say('key confirmation failed for ' + shortPeer(peer.id) + ': keys do not match');
      return;
    }
    sealedRefuse(peer, 'did not prove its identity');
    return;
  }
  peer.confirmed = true;
  sealedProved(peer);
  // The pin answers "who" and is checked before anything is established: a
  // revoked key that comes back and a label that holds another key both close
  // the pair, and the guest can say the device was reset.
  const pin = pinState(peer);
  if (pin === 'rollback' || pin === 'changed') {
    sealedRefuse(
      peer,
      pin === 'rollback'
        ? 'came back with an identity this browser revoked'
        : 'proved an identity another label here holds',
    );
    return;
  }
  // A member removed this identity from the room earlier in the call. The
  // notice went to every page, so no page answers this key again.
  if (state.kickedFps.has(peer.fp)) {
    sealedRefuse(peer, 'was removed from this room');
    return;
  }
  // The keys go to the worker now: the passphrase proof travels sealed, and a
  // frame that can not be opened would stall it. The keys are not permission:
  // every application frame of this pair waits for the proof.
  const keys = sealedInstallKeys(peer);
  peer.keyPromise = keys;
  sealedSetE2E(peer, 'ready');
  Promise.resolve(keys).then((ok) => {
    // The promise is the one proof this side has keys in the worker now. It is
    // cleared with the answer so nothing that asks whether the install is still
    // running reads a settled promise as a pending one.
    if (peer.keyPromise === keys) peer.keyPromise = null;
    if (!ok || !state.peers.has(peer.id) || state.leaving) return;
    sealedFlushApp(peer);
    // The bundle decides who begins; this call arrives after both sides have
    // installed their keys, so it is the one place an answer starts an exchange.
    if (startPassNow(peer)) sealedOfferPass(peer);
    else sealedHoldPass(peer);
  });
}

// sealedFlushApp replays the sealed frames that arrived before this side had
// its keys in the worker. They are in socket order, so the pair counters stay
// in step.
function sealedFlushApp(peer) {
  const held = peer.appPending || [];
  peer.appPending = [];
  for (const msg of held) sealedHandleOpaque(peer.id, encOpaque(msg));
}

// The passphrase exchange of one pair costs the module a P-256 run, and every
// frame a peer sends decides a pass or a fail for this page. Both sides are
// capped, so a page that answers with fresh points forever gets a few frames
// here and no more: PASS_TRIES per pair, PASS_PAGE_TRIES for the whole page per
// call (a peer id is cheap to mint, a page is not), and PASS_SPEND_MS between
// the exchanges a page starts, so a driver of joins can not run them back to
// back.
const PASS_TRIES = 3;

const PASS_PAGE_TRIES = 24;

const PASS_SPEND_MS = 3000;

// sealedPassBudget spends one try of one pair; false means neither this pair
// nor this page has any left, and the pair is closed.
function sealedPassBudget(peer) {
  peer.passTries = (peer.passTries || 0) + 1;
  state.passTries += 1;
  // A peer that never sends its bundle pays for the exchange it is answered
  // with; a peer we never saw pays for nothing we did not talk to.
  if (!peer.pub && !peer.pass) return true;
  if (peer.passTries <= PASS_TRIES && state.passTries <= PASS_PAGE_TRIES) return true;
  state.passRefusals += 1;
  sealedRefuse(peer, 'made too many passphrase attempts');
  return false;
}

// passMayStart is the one clock of the page's exchanges: a fresh one may begin
// only a window after the last. A page that spent its budget begins nothing.
function passMayStart(now) {
  if (state.passTries >= PASS_PAGE_TRIES) return false;
  return now - state.passLast >= PASS_SPEND_MS;
}

// sealedOfferPass begins the exchange of one pair and records the clock. The
// decision is startPassNow's; this is only the call that spends it.
function sealedOfferPass(peer) {
  if (!state.w) {
    sealedRefuse(peer, 'this page holds no room key');
    return;
  }
  if (!passMayStart(Date.now())) return;
  state.passLast = Date.now();
  sealedStartPass(peer);
}

// sealedStartPass sends the first proof frame of this pair. A handshake binds
// two ends, but anyone can run one; the proof is what makes the room a room.
function sealedStartPass(peer) {
  const first = String(state.self) < String(peer.id);
  const a = b64e(sealUtf8.encode(first ? state.self : peer.id));
  const b = b64e(sealUtf8.encode(first ? peer.id : state.self));
  const out = pqCall((json) => pqModule().spakestart(json), {
    w: state.w,
    role: first ? 'A' : 'B',
    a,
    b,
  });
  if (!out || !out.id) {
    sealedRefuse(peer, 'the room key could not be used');
    return;
  }
  peer.pass = { id: out.id, mine: '', peerOk: false, finished: false, done: false };
  sealedSend(peer, { k: 'spake', m: out.msg });
  sealedDrainPass(peer);
}

// sealedDrainPass replays a proof frame that arrived before the exchange it
// belongs to existed.
function sealedDrainPass(peer) {
  const held = peer.passEarly || [];
  peer.passEarly = [];
  for (const msg of held) {
    if (!peer.pass || peer.pass.done) break;
    sealedOnPassFrame(peer, msg);
  }
}

// sealedOnPassFrame takes one frame of the room proof. The exchange of one pair
// is paid for up to PASS_TRIES times; after that the pair is closed and this
// page starts no further exchange with it in this call. Every attempt is one
// guess at the room passphrase, and this budget is what keeps a member from
// turning a peer into a guess probe that runs as long as the call does.
function sealedOnPassFrame(peer, msg) {
  if (!peer.pass) {
    (peer.passEarly = peer.passEarly || []).push(msg);
    return;
  }
  if (peer.pass.done) {
    // A pair that proved the passphrase acts on no further proof frame: both
    // sides already hold the same secret, and a fresh exchange could only be
    // an attempt to take the pair back.
    return;
  }
  if (msg.k === 'spake') {
    if (peer.pass.finished) return;
    if (!sealedPassBudget(peer)) return;
    const out = pqCall((json) => pqModule().spakefinish(json), { id: peer.pass.id, msg: msg.m });
    if (!out || !out.conf) {
      sealedRefuse(peer, 'the passphrase exchange failed');
      return;
    }
    peer.pass.finished = true;
    peer.pass.mine = out.conf;
    sealedSend(peer, { k: 'spakeok', c: out.conf });
    sealedDrainPass(peer);
    sealedPassMaybe(peer);
    return;
  }
  // spakeok: the peer's confirmation of the key our side derived.
  if (!sealedPassBudget(peer)) return;
  const out = pqCall((json) => pqModule().spakeverify(json), { id: peer.pass.id, tag: msg.c });
  if (!out || !out.ok) {
    sealedRefusePass(peer);
    return;
  }
  peer.pass.peerOk = true;
  sealedPassMaybe(peer);
}

function sealedPassMaybe(peer) {
  if (!peer.pass || peer.pass.done || !peer.pass.finished || !peer.pass.peerOk) return;
  peer.pass.done = true;
  sealedPassDone(peer);
}

// sealedPassDone is the point where a pair becomes usable: both ends proved
// the passphrase, so the frames held behind the proof are released and the
// connection may start.
function sealedPassDone(peer) {
  sealedAnnounceName(peer);
  sealedSendState(peer);
  // Both ends proved the gate, so either may ask which value is current: a
  // page that reconnected or joined late may hold an older one. The role and
  // the waiting switch travel the same way.
  if (!peer.waiting) sealedSend(peer, { k: 'gateq' });
  sealedSend(peer, { k: 'wait', on: state.wait.on, n: state.wait.n });
  sealedSend(peer, { k: 'claimq' });
  // A held guest says so on the pair: the room can not read the switch from the
  // server, so this is how a member learns to let it in. A guest already inside
  // says that instead, in case a member still holds it.
  if (state.waiting) sealedSend(peer, { k: 'held' });
  else sealedSend(peer, { k: 'in' });
  // A held guest stays held until a member lets it in. With the switch off, or
  // a proven key this page already saw inside, that happens at once.
  if (peer.waiting) maybeAdmitHeld(peer);
  // Held application frames go out only now, and only behind the proof: this
  // is the one place they are released, and the pass flag above is set before
  // it runs. A frame that arrived without any pass is never dispatched, because
  // nothing else calls this.
  const held = peer.appHeld || [];
  peer.appHeld = [];
  for (const obj of held) if (peer.pass && peer.pass.done) sealedDispatchApp(peer, obj);
  if (!peer.pc && String(state.self) < String(peer.id)) connectPeer(peer.id, true);
  // A prepare that arrived before the proof was held, not applied; this is
  // where the transceivers and the tracks are built.
  if (peer.prepareHeld && peer.pc && !peer.tx) preparePeer(peer);
}

// sealedHoldCtl keeps a handshake frame that arrived before the state it needs.
// It is replayed in arrival order once the pub or the keys are in place.
function sealedHoldCtl(peer, msg) {
  if (peer.ctlPending.length < 8) peer.ctlPending.push(msg);
}

function sealedDrainCtl(peer) {
  if (!peer.ctlPending.length) return;
  const held = peer.ctlPending;
  peer.ctlPending = [];
  for (const msg of held) sealedHandleOpaque(peer.id, encOpaque(msg));
}

export function sealedHandleOpaque(from, b) {
  let peer = state.peers.get(from);
  if (!peer) {
    // With no roster a member is known only by the frame it sent. The id is
    // minted by the server, and the payload stays opaque until the handshake
    // has proved who is behind it.
    if (from === state.self || !/^[0-9a-f]{12}$/.test(String(from || ''))) return;
    peer = ensurePeer(from);
  }
  let msg;
  try {
    msg = decOpaque(b);
  } catch {
    return;
  }
  switch (msg.k) {
    case 'pub':
      sealedOnPub(peer, msg);
      break;
    case 'hello':
      if (!peer.pub) return sealedHoldCtl(peer, msg);
      if (String(state.self) < String(from)) return; // we are the initiator
      if (peer.keys || peer.keyPromise) return; // duplicate hello, keys already set
      sealedRespond(peer, msg).catch(() => sealedRefuse(peer, 'handshake failed'));
      break;
    case 'ok':
      // The initiator sends its hello and its own proof back to back. Both
      // proofs need the keys of our side, and those are agreed only when the
      // hello is answered, so an early one is held, never dropped.
      if (!peer.keys || !peer.pub || !peer.transcript) return sealedHoldCtl(peer, msg);
      sealedOnProof(peer, msg).catch(() => sealedRefuse(peer, 'handshake failed'));
      break;
    case 'key':
      // One request, one answer: ask our own worker for a key frame on the
      // video sender of this pair. Only a pair that passed the room proof is
      // answered: a key frame on a pair that proved nothing would let any
      // proven stranger make this page encode for media nobody admitted.
      if (peer.pass && peer.pass.done && peer.keys && state.worker)
        state.worker.postMessage({ type: 'keyframe', pair: pairLabel(peer.id) });
      break;
    case 'app': {
      if (!msg.b) return;
      // A frame can arrive while our own keys are still being installed. It is
      // the only copy, and a drop would desync both counters for the whole
      // pair, so hold it and fire it once the keys are in.
      if (!peer.keys || !peer.keysInstalled) {
        // A full queue is a gap the pair can not recover from: the frame is
        // lost and every later counter of the pair is out of step. The pair
        // restarts here, before the frames after this one pile up.
        if (!peer.appPending) peer.appPending = [];
        if (peer.appPending.length < 64) peer.appPending.push(msg);
        else sealedGapReset(peer);
        return;
      }
      // Both directions have their own counter. The socket is ordered, so the
      // next number is the only one that can be current. A number the pair has
      // already read is a replay or a reorder and is dropped before decryption.
      const seq = Number(msg.q);
      if (!Number.isSafeInteger(seq) || seq <= peer.seqIn) {
        state.replayDrops++;
        return;
      }
      if (seq !== peer.seqIn + 1) {
        // A gap is not a replay: one frame went missing on the way, and every
        // later frame of the pair would fail this counter for the rest of the
        // call, so the pair itself would be silently dead. The pair restarts
        // instead (new keys in the worker, a fresh handshake over the live
        // socket), and this frame is dropped with the generation it belongs to.
        state.seqGaps++;
        sealedGapReset(peer);
        return;
      }
      sealedOnApp(peer, msg.b, seq);
      break;
    }
    default:
      break;
  }
}

function sealedOnApp(peer, b, seq) {
  const out = pqCall((json) => pqModule().open(json), {
    key: b64e(peer.keys.recvChat),
    aad: b64e(chatAAD(peer.id, seq, state.idKey && state.idKey.pub, peer.pub && peer.pub.id)),
    b,
  });
  if (!out || out.error) return;
  let obj;
  try {
    obj = decOpaque(out.pt);
  } catch {
    return;
  }
  peer.seqIn = seq;
  if (obj[PAD_KEY] !== undefined) delete obj[PAD_KEY]; // the padding bucket, never content
  // The proof may pass before the room is open, and a kick as well: a page a
  // member removed must go even if its proof never finished. Anything else
  // waits here, because a peer that ran a handshake can still be a stranger.
  if (
    obj.k !== 'spake' &&
    obj.k !== 'spakeok' &&
    obj.k !== 'kick' &&
    !(peer.pass && peer.pass.done)
  ) {
    if (!peer.appHeld) peer.appHeld = [];
    // The same rule as the queue above: a frame that does not fit is a lost
    // frame, so the pair restarts now instead of meeting the gap later.
    if (peer.appHeld.length < 256) peer.appHeld.push(obj);
    else sealedGapReset(peer);
    return;
  }
  sealedDispatchApp(peer, obj);
}

function sealedDispatchApp(peer, obj) {
  if (obj.k === 'sdp') {
    // A sealed description is the only kind this client sends. It arrives after
    // the keys, so no clear offer is ever made or accepted from here.
    if (obj.d === 'offer')
      sealedOnOffer(peer, obj.s).catch(() => sealedRefuse(peer, 'the offer could not be applied'));
    else if (obj.d === 'answer' && peer.pc) onDescription(peer, 'answer', obj.s);
    return;
  }
  if (obj.k === 'cand') {
    // The socket and the pair counter are ordered, so a candidate always
    // follows its description; the queue in onCandidate covers the gap while
    // the description is still being applied.
    if (peer.pc) onCandidate(peer, obj.c);
    else (peer.candEarly = peer.candEarly || []).push(obj.c);
    return;
  }
  if (obj.k === 'spake' || obj.k === 'spakeok') sealedOnPassFrame(peer, obj);
  if (obj.k === 'name') {
    sealedSetName(peer, obj.n);
  } else if ((obj.k === 'chat' || obj.k === 'file') && peer.waiting) {
    // The server can not read a sealed line, so the room keeps this rule here:
    // a guest that waits outside says nothing in the room and offers no file.
    return;
  } else if (obj.k === 'chat') {
    state.chatRecv++;
    addChatLine(peerName(peer), String(obj.x || ''), Date.now());
  } else if (obj.k === 'asr') {
    if (!peer.waiting) asrOnMessage(peer, obj);
  } else if (obj.k === 'state') {
    sealedOnState(peer, obj);
  } else if (obj.k === 'talks') {
    // The guest's own word about whom it talks to, for the presence line. It
    // never routes anything: the rule of this page decides that.
    setTalks(peer.id, obj.ids);
  } else if (obj.k === 'lower') {
    // Only an admin may ask, and only the guest that owns the hand lowers it.
    if (isAdmin(peer.id) && state.hand) setHand(false);
  } else if (obj.k === 'gateq') {
    // A peer that just proved the gate asks which value the room uses now.
    // Only a value is sent, and only over a pair that already passed the
    // proof, so a stranger never sees it.
    if (state.gate.v !== null) sealedSend(peer, { k: 'gate', v: state.gate.v, n: state.gate.n });
  } else if (obj.k === 'gate') {
    sealedOnGate(peer, obj);
  } else if (obj.k === 'claim') {
    sealedOnClaim(peer, obj);
  } else if (obj.k === 'handover') {
    // A member asks the page that made the room for a role. Only that page
    // answers, and only with the next claim.
    onHandover(peer);
  } else if (obj.k === 'claimq') {
    // A page that just proved the room asks who holds the role. The answer is
    // the current claim, signed, and nothing else.
    sealedSendClaim(peer);
  } else if (obj.k === 'wait') {
    sealedOnWait(peer, obj);
  } else if (obj.k === 'admit') {
    sealedOnAdmit(peer);
  } else if (obj.k === 'held') {
    sealedOnHeld(peer);
  } else if (obj.k === 'in') {
    sealedOnIn(peer);
  } else if (obj.k === 'kick') {
    sealedOnKick(peer, obj);
  } else if (obj.k === 'mute') {
    // The host asked for a mute. It is a request to this page; no page can
    // reach another page's track, so this one turns its own gain down.
    if (isAdmin(peer.id)) {
      disableMic(false);
      say('the host muted your microphone');
    }
  } else if (obj.k === 'file') {
    fileOnMessage(peer, obj);
  }
}

// sealedOnGate takes a gate value from a pair that already proved the room. The
// counter orders the changes and a tie goes to the lower peer id.
function sealedOnGate(peer, obj) {
  // The role is checked here as well as in the menu: the role is a sealed claim
  // now, and a sealed value must follow the same list.
  if (!isAdmin(peer.id)) return;
  const n = Number(obj.n);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) return;
  if (typeof obj.v !== 'string' || obj.v.length > 256) return;
  if (n < state.gate.n) return;
  if (n === state.gate.n && (state.gate.v === obj.v || String(peer.id) >= String(state.self)))
    return;
  adoptGate(obj.v, n);
}

// adoptGate installs a value and derives its scalar again, so the next pair
// proves the new word. A pair that is already open keeps its keys: the value
// gates the door, it is not a key schedule.
//
// The derivation is Argon2id inside the module and costs the tab a visible
// stall, so it runs in the sealed worker: the passphrase enters the page, goes
// straight to the worker with a generation, and only the scalar comes back. The
// newest request wins, because a second change while the first derives must not
// be undone by the slower answer.
export function adoptGate(v, n) {
  state.gate = { v, n };
  // Work inside the promise chains stays untyped at the edge of the module: the
  // scalar is whatever the derive answered, checked where it is used.
  const gen = ++state.wGen;
  state.w = '';
  deriveRoomW(v, state.room)
    .then((w) => {
      if (state.leaving || state.wGen !== gen) return;
      state.w = typeof w === 'string' ? w : '';
    })
    .catch(() => {
      if (state.wGen === gen) state.w = '';
    });
  paintGate();
}

// deriveRoomW turns a passphrase into the SPAKE2 scalar. It asks a worker of
// its own, so the Argon2id run behind it never stalls the page; the worker is
// created per change and torn down after, because each one loads the wasm
// module. A browser with no worker derives here instead, which is the old stall
// and never a wrong value.
export function deriveRoomW(pass, room) {
  const secret = pass === '' ? '\u0000open room' : pass;
  return new Promise((resolve, reject) => {
    if (typeof Worker !== 'function') {
      try {
        resolve(roomW(pass, room));
      } catch (err) {
        reject(err);
      }
      return;
    }
    let worker;
    try {
      worker = new Worker(scriptURL('/wasm-derive.js'));
    } catch (err) {
      reject(err);
      return;
    }
    const done = (w, err) => {
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve(w);
    };
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.error || typeof msg.w !== 'string') done('', new Error(msg.error || 'derive'));
      else done(msg.w, null);
    };
    worker.onerror = () => done('', new Error('the room key could not be derived'));
    worker.postMessage({ pass: secret, salt: room });
  });
}

// paintGate says whether the room has a passphrase now, and never the value.
export function paintGate() {
  const note = document.getElementById('gate-note');
  if (note) note.textContent = state.gate.v ? 'set, ' + state.gate.n : 'open room';
}

// setGate is the admin command: the value goes sealed to every pair and the
// counter moves up by one. A pair that is open keeps working; a guest that
// joins later must know the new value or fail the proof.
export function setGate(v) {
  if (!isAdmin(state.self) || state.waiting) return;
  const n = state.gate.n + 1;
  adoptGate(v, n);
  toSealed({ k: 'gate', v, n });
}
