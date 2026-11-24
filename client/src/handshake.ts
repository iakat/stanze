/*
 The post-quantum handshake of a pair.
*/

import { state } from './state.js';
import { isAdmin, say } from './util.js';
import { send } from './menu.js';
import { paintVolume, storedVolume } from './volume.js';
import { disableMic } from './devices.js';
import { sealedSendState, setHand } from './audio.js';
import { connectPeer, ensurePeer, onCandidate, onDescription } from './peers.js';
import { leave } from './room.js';
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
} from './sealed.js';
import { fingerprint, paintPin, pinState, updatePinCount } from './identity.js';
import { asrAnnounce, asrOnMessage } from './asr.js';
import {
  PAD_KEY,
  maybeAdmitHeld,
  roomW,
  sealedAnnounceName,
  sealedKick,
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

// sealedRefusePass is sealedRefuse for a guest that failed the room proof, so a
// wrong passphrase costs one handshake. A member kicks the guest everywhere; a
// guest that was never let in goes back to the lobby.
function sealedRefusePass(peer) {
  sealedRefuse(peer, 'does not know the room passphrase');
  if (state.waiting) {
    // Out of the message handler: the pair state is being torn down here, and
    // leaving the room rewrites all of it.
    setTimeout(() => leave('the room refused the passphrase'), 0);
    return;
  }
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
  peer.ctlPending = [];
  fileDropPeer(peer);
  if (peer.pc) {
    peer.pc.close();
    peer.pc = null;
  }
  if (peer.tile) peer.tile.dataset.sas = '';
  sealedSetE2E(peer, 'new');
  if (resend) sealedSendPub(peer);
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
  if (!peer.keys && !peer.keyPromise && String(state.self) < String(peer.id)) {
    sealedInitiate(peer).catch(() => sealedRefuse(peer, 'handshake failed'));
  }
  sealedDrainCtl(peer);
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
  peer.keyPromise = sealedInstallKeys(peer);
  sealedSetE2E(peer, 'ready');
  Promise.resolve(peer.keyPromise).then((ok) => {
    if (!ok || !state.peers.has(peer.id) || state.leaving) return;
    sealedFlushApp(peer);
    sealedStartPass(peer);
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

// sealedStartPass proves the room passphrase to this peer. A handshake binds two
// ends, but anyone can run one; the proof is what makes the room a room.
function sealedStartPass(peer) {
  if (!state.w) {
    sealedRefuse(peer, 'this page holds no room key');
    return;
  }
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
  for (const msg of held) sealedOnPassFrame(peer, msg);
}

function sealedOnPassFrame(peer, msg) {
  if (!peer.pass) {
    (peer.passEarly = peer.passEarly || []).push(msg);
    return;
  }
  if (msg.k === 'spake') {
    if (peer.pass.finished) return;
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
  const held = peer.appHeld || [];
  peer.appHeld = [];
  for (const obj of held) sealedDispatchApp(peer, obj);
  if (!peer.pc && String(state.self) < String(peer.id)) connectPeer(peer.id, true);
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
      // video sender of this pair.
      if (state.worker) state.worker.postMessage({ type: 'keyframe', pair: pairLabel(peer.id) });
      break;
    case 'app': {
      if (!msg.b) return;
      // A frame can arrive while our own keys are still being installed. It is
      // the only copy, and a drop would desync both counters for the whole
      // pair, so hold it and fire it once the keys are in.
      if (!peer.keys || !peer.keysInstalled) {
        if ((peer.appPending = peer.appPending || []).length < 64) peer.appPending.push(msg);
        return;
      }
      // Both directions have their own counter. The socket is ordered, so the
      // next number is the only one that can be current; anything else is a
      // replay, a reorder or a forgery, and it is dropped before decryption.
      const seq = Number(msg.q);
      if (!Number.isSafeInteger(seq) || seq !== peer.seqIn + 1) {
        state.replayDrops++;
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
    aad: b64e(chatAAD(peer.id, seq)),
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
    if ((peer.appHeld = peer.appHeld || []).length < 256) peer.appHeld.push(obj);
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
  if (obj.k === 'spake' || obj.k === 'spakeok') {
    sealedOnPassFrame(peer, obj);
    return;
  }
  if (obj.k === 'name') {
    sealedSetName(peer, obj.n);
  } else if ((obj.k === 'chat' || obj.k === 'file') && peer.waiting) {
    // The server can not read a sealed line, so the room keeps this rule here:
    // a guest that waits outside says nothing in the room and offers no file.
    return;
  } else if (obj.k === 'chat') {
    state.chatRecv++;
    addChatLine(peer.name || shortPeer(peer.id), String(obj.x || ''), Date.now());
  } else if (obj.k === 'asr') {
    if (!peer.waiting) asrOnMessage(peer, obj);
  } else if (obj.k === 'state') {
    sealedOnState(peer, obj);
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
function adoptGate(v, n) {
  state.gate = { v, n };
  try {
    state.w = roomW(v, state.room);
  } catch {
    state.w = '';
  }
  paintGate();
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
