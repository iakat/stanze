/*
 The mesh: one RTCPeerConnection per peer and what flows on it.
*/

import { state } from './state.js';
import { isAdmin, say } from './util.js';
import { layoutStage, makeTile, paintRowDeaf, rowOf } from './tiles.js';
import { applyFlags, storedVolume, wireVolume } from './volume.js';
import { updateCount } from './host.js';
import { capCameraSenders } from './media.js';
import { paintPeerScreen, paintPeerVideo, preparePeer } from './devices.js';
import { dropAudio, paintHandQueue, routeAudio } from './audio.js';
import { FILE_LABEL, fileBindChannel, fileDropPeer } from './files.js';
import { sealedSendOpaque, shortPeer } from './sealed.js';
import { updatePinCount } from './identity.js';
import { wipeKeys } from './handshake.js';
import { sealedSendCand, sealedSendSdp } from './gate.js';
import { paintRelay } from './badge.js';
import { worldDrop } from './roomworld.js';
import { forgetRoute, paintPresence, routeNow } from './presence.js';

// ---------------------------------------------------------------- peers
// A direct only path drops the TURN servers. A relay path needs no filter:
// the transport policy already drops every other candidate.
export function iceServers() {
  const all = state.ice || [];
  if (state.path !== 'p2p') return all;
  return all.filter((server) => !/^turns?:/i.test(String(server.urls)));
}

function rtcConfig(): RTCConfiguration {
  return {
    iceServers: iceServers(),
    iceTransportPolicy: (state.path === 'relay' ? 'relay' : 'all') as RTCIceTransportPolicy,
    bundlePolicy: 'max-bundle',
  };
}

// ensurePeer makes the tile and the pair state of one guest. The flags start as
// microphone and camera on; the first sealed state of that pair corrects them.
export function ensurePeer(id) {
  let peer = state.peers.get(id);
  if (peer) return peer;
  // The name arrives sealed later, so the short id keeps the tile readable.
  const initial = String(id).slice(0, 6);
  peer = {
    id,
    name: initial,
    mic: true,
    cam: true,
    deaf: false,
    waiting: !!state.waitingRoom && !state.waiting, // held outside the room
    hand: false, // a raised hand
    handTs: 0,
    camOn: true, // the guest's own camera flag, sealed to this pair
    micOn: true, // the guest's own microphone flag, sealed to this pair
    talks: [], // the ids the guest says it is talking to, sealed to this pair
    screenShared: false, // a live share, until the sealed state says otherwise
    vol: 100,
    pc: null,
    tile: null,
    video: null,
    screenTile: null, // the second tile, built from the first screen track
    screenTrack: null,
    gain: null,
    audioSrc: null,
    audioEl: null,
    meter: null, // tap on the incoming audio, for the talking light
    meterPeak: 0, // decaying peak of that tap, so one stats tick sees a word
    inDenoise: null, // local noise cancel of this incoming stream
    inNoise: false, // that noise cancel is asked for, off unless a guest asks
    inEngine: 'off', // which engine that noise cancel uses
    feId: 0, // the lane of this stream in the FastEnhancer worker, 0 = none
    outFilter: '', // the filter the guest reports on its microphone
    inFilter: '', // the filter the guest reports on this pair's incoming stream
    spoke: null, // last time this peer was heard, for the hold

    statLast: new Map(),
    polite: String(state.self) > String(id),
    makingOffer: false,
    settingAnswer: false,
    ignoreOffer: false,

    pending: [],
    state: 'new',
    initiator: false,
    pub: null,
    keys: null,
    transcript: null,
    sas: '',
    confirmed: false,
    ready: '',
    myConfirm: '',
    sentConfirm: false,
    keyPromise: null,
    keysInstalled: false,
    gen: 0, // bumps on every new key agreement on this pair
    ctlPending: [], // hello/ok held until the pub and the keys are here
    seqOut: 0, // sealed chat/name frames sent on this pair
    seqIn: 0, // the last one opened, inbound only grows
    dc: null,
    dcPromise: null, // resolves with that channel, or null when it never comes
    dcResolve: null,
    mySig: '',
    fp: '', // fingerprint once the peer proved its identity
    pin: '', // 'changed' when a label here holds another key
    pinLabel: '', // the local label this guest is pinned under
    proven: false,
    desc: null, // the description chain of this pair
    announcedName: '',
  };
  peer.vol = storedVolume(peer);
  peer.tile = makeTile(peer.name, peer.name);
  peer.video = peer.tile.querySelector('video');
  peer.tile.dataset.peer = id;
  // The map holds the peer before the first paint: the flags of the tile read
  // the waiting room and the raised hand from it.
  state.peers.set(id, peer);
  applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
  paintRowDeaf(rowOf.get(peer.tile), peer.deaf);
  wireVolume(peer);
  layoutStage();
  updateCount();
  paintHandQueue();
  return peer;
}

export function connectPeer(id, initiator) {
  const peer = ensurePeer(id);
  if (peer.pc) {
    peer.initiator = peer.initiator || initiator;
    return peer;
  }
  peer.initiator = initiator;

  const pc = new RTCPeerConnection(rtcConfig());
  peer.pc = pc;

  // One ordered data channel per pair carries file bytes: the initiator opens
  // it, the answerer takes the channel the offer brings. No server sees it.
  peer.dc = null;
  peer.dcPromise = new Promise((resolve) => {
    peer.dcResolve = resolve;
  });
  pc.ondatachannel = (event) => {
    if (event.channel && event.channel.label === FILE_LABEL) fileBindChannel(peer, event.channel);
  };
  if (initiator) fileBindChannel(peer, pc.createDataChannel(FILE_LABEL, { ordered: true }));

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sealedSendSdp(peer, 'offer', pc.localDescription.sdp);
    } catch (err) {
      console.warn('negotiation failed', errName(err));
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) sealedSendCand(peer, event.candidate.toJSON());
  };

  pc.ontrack = (event) => {
    const track = event.track;
    if (track.kind === 'audio') {
      // Audio is played through this peer gain, not through the video element,
      // so it can be louder than the browser maximum and silent at 0 percent.
      routeAudio(peer, track);
      // A track that arrives while the pair is out of the conversation starts
      // silent: the routing of the presence owns the gain.
      routeNow(peer);
      track.addEventListener('ended', () => dropAudio(peer));
      return;
    }
    // The screen has its own transceiver, matched by mid, and its track goes to
    // a second tile. Before preparePeer runs, the second video transceiver
    // names it.
    const named = peer.tx && peer.tx.screen;
    const screen =
      named || peer.pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video')[1];
    if (
      screen &&
      (event.transceiver === screen ||
        (named && named.mid !== null && event.transceiver.mid === named.mid))
    ) {
      peer.screenTrack = track;
      paintPeerScreen(peer);
      // A share that stops or starts again mutes and unmutes the same track.
      track.addEventListener('mute', () => paintPeerScreen(peer));
      track.addEventListener('unmute', () => paintPeerScreen(peer));
      track.addEventListener('ended', () => paintPeerScreen(peer));
      return;
    }
    // The track is kept, so undeafen needs no new negotiation, and a deafened
    // guest never draws it.
    peer.videoTrack = track;
    routeNow(peer);
    // A sender that stops its camera mutes the track instead of ending it, so
    // mute, unmute and ended each repaint, and a fresh camera needs no new
    // negotiation.
    track.addEventListener('mute', () => paintPeerVideo(peer));
    track.addEventListener('unmute', () => paintPeerVideo(peer));
    track.addEventListener('ended', () => paintPeerVideo(peer));
    layoutStage();
  };

  pc.onconnectionstatechange = () => {
    setPeerState(peer, pc.connectionState);
    if (pc.connectionState === 'connected') {
      // The encodings exist now, so a cap that was too early applies here.
      capCameraSenders(pc);
      paintRelay(peer);
      // One ask over the sealed channel, answered once with a key frame from
      // the sender. It is the only frame a fresh receiver can decode.
      if (!peer.askedKey) {
        peer.askedKey = true;
        sealedSendOpaque(peer.id, { k: 'key' });
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' && peer.initiator) {
      pc.restartIce();
    }
  };

  // The start order: the keys are in the worker by now, then one transceiver
  // per kind with both transforms and the live track, then the offer.
  if (initiator) preparePeer(peer);
  return peer;
}

// errName is what a console line carries about a browser error: its name, never
// its message. A WebRTC message quotes the description, and a console keeps
// what it is given, sealed call or not.
function errName(err) {
  return (err && (err.name || (err.constructor && err.constructor.name))) || 'error';
}

function setPeerState(peer, text) {
  peer.state = text;
  // The badge names the key state, so the link state lives in the data
  // attribute only. The status line carries no guest count: the chip at its far
  // end counts the peers, so the two can never disagree.
  if (peer.tile) peer.tile.dataset.state = text;
  const row = peer.tile ? rowOf.get(peer.tile) : null;
  if (row) row.dataset.state = text;
  if ((text === 'failed' || text === 'closed') && peer.tile) peer.tile.classList.remove('playing');
  layoutStage();
  updateCount();
}

async function flushPending(peer) {
  const queued = peer.pending.splice(0);
  // The candidates are independent and the socket order holds them, so one
  // wait covers the batch.
  await Promise.allSettled(
    queued.map((cand) =>
      peer.pc.addIceCandidate(cand).catch((err) => {
        if (!peer.ignoreOffer) console.warn('candidate rejected', errName(err));
      }),
    ),
  );
}

// onDescription queues one description per peer: two offers, or an answer that
// races a rejoin, would interleave the set calls and leave the pair at "new".
export function onDescription(peer, type, sdp) {
  const run = () => applyDescription(peer, type, sdp);
  peer.desc = (peer.desc || Promise.resolve()).then(run, run);
  return peer.desc;
}

async function applyDescription(peer, type, sdp) {
  const pc = peer.pc;
  if (!pc || pc.signalingState === 'closed') return;
  const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
  const collision = type === 'offer' && !readyForOffer;
  // The impolite side keeps its own offer and drops the incoming one; the
  // polite side gives way instead.
  peer.ignoreOffer = !peer.polite && collision;
  if (peer.ignoreOffer) return;
  // A duplicate answer arrives after a rejoin and completes nothing.
  if (type === 'answer' && pc.signalingState !== 'have-local-offer') return;

  try {
    // Perfect negotiation: the polite side rolls its offer back so the remote
    // one can be applied.
    if (collision && peer.polite && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription({ type: 'rollback' });
    }
    peer.settingAnswer = type === 'answer';
    await pc.setRemoteDescription({ type, sdp });
    peer.settingAnswer = false;
    // The transceivers exist now, so both directions get their transform and
    // their track here, before the answer leaves.
    preparePeer(peer);

    if (type === 'offer') {
      await pc.setLocalDescription();
      sealedSendSdp(peer, 'answer', pc.localDescription.sdp);
    }
    await flushPending(peer);
    // The description is in place, so a camera cap set before the negotiation
    // can land.
    capCameraSenders(pc);
  } catch (err) {
    peer.settingAnswer = false;
    // A rejected description leaves the pair at "new": no media, no retry,
    // nothing on screen. The browser's own text is not kept: it quotes the SDP,
    // and the stats panel and the console would then hold the call's addresses
    // in the clear under the seal. The error name is enough to tell one failure
    // from another.
    const kind = (err && (err.name || err.constructor && err.constructor.name)) || 'error';
    state.workerErrors.push('description failed for ' + shortPeer(peer.id) + ': ' + kind);
    say('the ' + type + ' with ' + shortPeer(peer.id) + ' failed; the link has no media');
  }
}

// PENDING_MAX is the candidate queue of one pair before its first description.
// A real pair queues a handful; a flood is a peer that never sends one, and the
// rest of its entries are dropped. The drops are counted on the peer so a page
// can see that a link, not the network, is short; the console says so once.
const PENDING_MAX = 100;

let pendingWarned = false;

export async function onCandidate(peer, candidate) {
  if (!candidate) return;
  if (!peer.pc || !peer.pc.remoteDescription) {
    if (peer.pending.length < PENDING_MAX) {
      peer.pending.push(candidate);
      return;
    }
    peer.pendingDropped = (peer.pendingDropped || 0) + 1;
    if (!pendingWarned) {
      pendingWarned = true;
      console.warn('a candidate queue is full, further candidates are dropped and counted');
    }
    return;
  }
  try {
    await peer.pc.addIceCandidate(candidate);
  } catch (err) {
    if (!peer.ignoreOffer) console.warn('candidate rejected', errName(err));
  }
}

export function dropPeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;

  dropAudio(peer);
  worldDrop(id);
  forgetRoute(id);
  paintPresence();
  fileDropPeer(peer);
  if (peer.pc) peer.pc.close();
  const row = peer.tile ? rowOf.get(peer.tile) : null;
  if (row) row.remove();
  if (peer.tile) peer.tile.remove();
  if (peer.screenTile) peer.screenTile.remove();
  // The pair secrets go with the peer, zeroed: no later join can resume them.
  wipeKeys(peer);
  state.peers.delete(id);
  layoutStage();
  updatePinCount();
  updateCount();
  paintHandQueue();
}
