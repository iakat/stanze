/*
 The websocket frames, both directions.
*/

import { state } from './state.js';
import { say, setAdmins } from './util.js';
import { send, wsURL } from './menu.js';
import { markAdmins, paintWaiting, updateCount } from './host.js';
import { paintHandQueue, sendState } from './audio.js';
import { dropPeer, ensurePeer } from './peers.js';
import { leave } from './room.js';
import { playSfx, startLost, stopLost } from './sfx.js';
import { sealedHandleOpaque, sealedSendPub } from './handshake.js';
import { asrProbe, omniProbe } from './asr.js';
import { auditWire } from './audit.js';
import { resealOnLeave, startAuthSeed } from './gate.js';

// ---------------------------------------------------------------- signaling
export function dropPeers() {
  for (const id of [...state.peers.keys()]) dropPeer(id);
}

// scheduleReconnect retries the signaling socket with a capped backoff. The
// camera and the microphone stay open across a reconnect, so a short network
// drop does not need a click from the user.
export function scheduleReconnect() {
  if (state.leaving || state.fatal || state.reconnectTimer) return;
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.leaving && !state.fatal) connectWS();
  }, delay);
}

export function cancelReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.reconnectDelay = 500;
}

export function connectWS() {
  cancelReconnect();
  if (state.ws) {
    const old = state.ws;
    state.ws = null;
    old.onclose = null;
    try {
      old.close();
    } catch {
      /* already gone */
    }
  }

  let ws;
  try {
    ws = new WebSocket(wsURL());
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectDelay = 500;
    stopLost();
    // The join carries no name and no passphrase: the server announces every
    // peer as its placeholder, and the real name travels sealed once the keys
    // exist. The passphrase proves itself in the sealed handshake, so a wrong
    // one costs a failed exchange and never a server-side check.
    send({ t: 'join', room: state.room });
  };

  ws.onmessage = (event) => {
    auditWire('in', event.data);
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  };

  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    if (state.leaving) return;
    // The old peer id dies with the old socket, so the remote connections go
    // away too; the join after the reconnect rebuilds them.
    dropPeers();
    if (state.fatal) {
      leave(state.fatal);
      return;
    }
    say('connection lost, reconnecting');
    startLost();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // A close event follows and does the bookkeeping.
  };
}

export function handle(msg) {
  // A kick, a mute and a role change are sealed notices now, so the only clear
  // frames with a meaning of their own are a terminal join error and a leave.
  if (msg.t === 'error') {
    if (msg.code === 'unavailable') {
      // The passphrase is not a server question any more, so this code only
      // means a malformed id or a full room.
      state.fatal = 'room unavailable or full';
      leave(state.fatal);
    } else if (msg.code === 'sealed-only') {
      // Only a page from before the sealed handshake can still ask for a clear
      // relay. It cannot join, and a reload is the whole fix.
      state.fatal = 'this page is out of date; reload it to join';
      leave(state.fatal);
    }
    return;
  }
  switch (msg.t) {
    case 'joined': {
      state.self = msg.self;
      state.ice = msg.ice || [];
      // Only the reconnect notice ends here. A device or sealing notice that
      // the join itself wrote must stay up until the guest has read it.
      if (state.notice === 'connection lost, reconnecting') say('');
      // Every join is a new socket and a new peer id, so the role and the
      // switch start from nothing here: both are sealed commits that arrive
      // over the pairs, and this page begins held outside the room.
      state.auth = { n: -1, admins: [], by: '', sig: '' };
      setAdmins([]);
      state.waiting = true;
      asrProbe();
      omniProbe();
      let listed = 0;
      for (const info of msg.peers || []) {
        if (!info || !info.id) continue;
        // The toggle fields of an old server, or of the room control it used
        // to keep, are ignored: the flags come sealed from the guest itself.
        const peer = ensurePeer(info.id);
        peer.waiting = false;
        sealedSendPub(peer);
        listed++;
      }
      // A server with no roster leaves discovery to the room: one broadcast
      // bundle, and every member that answers is a pair.
      if (!listed) sealedSendPub(null);
      startAuthSeed();
      markAdmins();
      paintWaiting();
      // Tell the room the microphone and camera state; only the flags travel.
      sendState();
      updateCount();
      break;
    }
    case 'peer-joined': {
      if (!msg.peer || !msg.peer.id) break;
      // A knock: an opaque id and nothing else. Whether this guest waits is
      // our own sealed switch, not a server flag.
      const peer = ensurePeer(msg.peer.id);
      markAdmins();
      paintWaiting();
      paintHandQueue();
      sealedSendPub(peer);
      playSfx('pop');
      break;
    }
    case 'peer-left': {
      dropPeer(msg.from);
      state.admins.delete(msg.from);
      resealOnLeave(msg.from);
      markAdmins();
      paintWaiting();
      playSfx('bonk');
      break;
    }
    case 'enc': {
      if (msg.from && typeof msg.b === 'string') sealedHandleOpaque(msg.from, msg.b);
      break;
    }
  }
  // A clear description, a candidate, a toggle, a role, a kick and a waiting
  // flag all have no case here on purpose: every one of them arrives sealed,
  // so the server can not send one and hope this page acts on it.
}
