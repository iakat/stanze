'use strict';

// Small full mesh: every peer keeps one RTCPeerConnection per other peer.
// The server only relays SDP and ICE. Negotiation follows the "perfect
// negotiation" pattern so both sides can renegotiate without glare.

const state = {
  ws: null,
  self: null,
  room: '',
  pass: '',
  name: '',
  ice: [],
  peers: new Map(),
  stream: null,
  mic: true,
  cam: true,
  leaving: false,
  reconnectTimer: null,
  reconnectDelay: 500,
  fatal: '',
};

const $ = (id) => document.getElementById(id);
const ROOM_RE = /^[a-z2-7]{26}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

// newRoomID builds a 128 bit room id in the client, so an empty room field
// needs no request to the server: the first join creates the room.
function newRoomID() {
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

function say(text) {
  const box = state.room ? $('stage-error') : $('lobby-error');
  box.textContent = text;
  box.hidden = !text;
}

function roomFromHash() {
  const raw = location.hash.replace(/^#/, '');
  const id = (new URLSearchParams(raw).get('r') || '').toLowerCase();
  return ROOM_RE.test(id) ? id : '';
}

function setHash(room) {
  history.replaceState(null, '', room ? `#r=${room}` : location.pathname);
}

function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws';
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------- tiles

function makeTile(id, name, local = false) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.state = 'new';
  tile.innerHTML = `
    <video autoplay playsinline${local ? ' muted' : ''}></video>
    <div class="avatar"></div>
    <div class="tag"><span class="name"></span><span class="state"></span></div>`;
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = (name || '?').slice(0, 2);
  $('grid').appendChild(tile);
  return tile;
}

function setTileState(peer, text) {
  if (!peer.tile) return;
  peer.tile.dataset.state = text;
  peer.tile.querySelector('.state').textContent = text;
}

function updateCount() {
  const total = state.peers.size + 1;
  const live = [...state.peers.values()].filter((p) => p.state === 'connected').length + 1;
  $('peer-count').textContent = total === 1 ? '1 peer' : `${live}/${total} peers`;
}

// ---------------------------------------------------------------- media

async function openCamera() {
  const want = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
  };
  try {
    state.stream = await navigator.mediaDevices.getUserMedia(want);
  } catch (err) {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.cam = false;
    } catch (err2) {
      say('no camera or microphone available, joining to watch only');
      state.mic = false;
      state.cam = false;
    }
  }
  if (state.stream) {
    const self = makeTile(state.name, state.name, true);
    self.querySelector('video').srcObject = state.stream;
    self.classList.add('playing');
    self.dataset.state = 'connected';
    self.querySelector('.state').textContent = 'you';
  }
  updateButtons();
}

function updateButtons() {
  $('mic-btn').textContent = state.mic ? 'mic on' : 'mic off';
  $('mic-btn').setAttribute('aria-pressed', String(state.mic));
  $('cam-btn').textContent = state.cam ? 'camera on' : 'camera off';
  $('cam-btn').setAttribute('aria-pressed', String(state.cam));
}

function toggleTrack(kind, on) {
  if (!state.stream) return;
  for (const track of state.stream.getTracks()) {
    if (track.kind === kind) track.enabled = on;
  }
}

// ---------------------------------------------------------------- peers

function ensurePeer(id, name) {
  let peer = state.peers.get(id);
  if (peer) {
    if (name && peer.name !== name) {
      peer.name = name;
      peer.tile.querySelector('.name').textContent = name;
    }
    return peer;
  }
  peer = {
    id,
    name: name || 'guest',
    pc: null,
    tile: null,
    polite: String(state.self) > String(id),
    makingOffer: false,
    ignoreOffer: false,
    tracksAdded: false,
    pending: [],
    state: 'new',
    initiator: false,
  };
  peer.tile = makeTile(peer.name, peer.name);
  state.peers.set(id, peer);
  updateCount();
  return peer;
}

function addLocalTracks(peer) {
  if (peer.tracksAdded) return;
  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      peer.pc.addTrack(track, state.stream);
    }
  }
  peer.tracksAdded = true;
}

// Only the side that starts the offer needs explicit transceivers: without a
// local track the offer would otherwise describe nothing to receive.
function ensureRecvTransceivers(peer) {
  const kinds = new Set(state.stream ? state.stream.getTracks().map((t) => t.kind) : []);
  for (const kind of ['audio', 'video']) {
    if (!kinds.has(kind)) peer.pc.addTransceiver(kind, { direction: 'recvonly' });
  }
}

function connectPeer(id, name, initiator) {
  const peer = ensurePeer(id, name);
  if (peer.pc) {
    peer.initiator = peer.initiator || initiator;
    return peer;
  }
  peer.initiator = initiator;

  const pc = new RTCPeerConnection({ iceServers: state.ice, bundlePolicy: 'max-bundle' });
  peer.pc = pc;

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ t: 'offer', to: peer.id, sdp: pc.localDescription.sdp });
    } catch (err) {
      console.warn('negotiation failed', err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ t: 'ice', to: peer.id, candidate: event.candidate.toJSON() });
    }
  };

  pc.ontrack = (event) => {
    const video = peer.tile.querySelector('video');
    if (video.srcObject !== event.streams[0]) video.srcObject = event.streams[0];
    peer.tile.classList.add('playing');
    video.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    setPeerState(peer, pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' && peer.initiator) {
      pc.restartIce();
    }
  };

  if (initiator) {
    addLocalTracks(peer);
    ensureRecvTransceivers(peer);
  }
  return peer;
}

function setPeerState(peer, text) {
  peer.state = text;
  setTileState(peer, text);
  if (text === 'failed' || text === 'closed') {
    peer.tile.classList.remove('playing');
  }
  updateCount();
}

async function flushPending(peer) {
  const queued = peer.pending.splice(0);
  for (const cand of queued) {
    try {
      await peer.pc.addIceCandidate(cand);
    } catch (err) {
      if (!peer.ignoreOffer) console.warn('candidate rejected', err);
    }
  }
}

async function onDescription(peer, type, sdp) {
  const pc = peer.pc;
  const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
  const collision = type === 'offer' && !readyForOffer;
  peer.ignoreOffer = !peer.polite && collision;
  if (peer.ignoreOffer) return;

  try {
    peer.settingAnswer = type === 'answer';
    await pc.setRemoteDescription({ type, sdp });
    peer.settingAnswer = false;

    if (type === 'offer') {
      // Tracks are added after the remote offer, so the answer carries them
      // and this side does not start a competing negotiation.
      addLocalTracks(peer);
      await pc.setLocalDescription();
      send({ t: 'answer', to: peer.id, sdp: pc.localDescription.sdp });
    }
    await flushPending(peer);
  } catch (err) {
    console.warn('description failed', err);
  }
}

async function onCandidate(peer, candidate) {
  if (!candidate) return;
  if (!peer.pc || !peer.pc.remoteDescription) {
    peer.pending.push(candidate);
    return;
  }
  try {
    await peer.pc.addIceCandidate(candidate);
  } catch (err) {
    if (!peer.ignoreOffer) console.warn('candidate rejected', err);
  }
}

function dropPeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  if (peer.pc) peer.pc.close();
  if (peer.tile) peer.tile.remove();
  state.peers.delete(id);
  updateCount();
}

// ---------------------------------------------------------------- signaling

function dropPeers() {
  for (const id of [...state.peers.keys()]) dropPeer(id);
}

// scheduleReconnect retries the signaling socket with a capped backoff. The
// camera and the microphone stay open across a reconnect, so a short network
// drop does not need a click from the user.
function scheduleReconnect() {
  if (state.leaving || state.fatal || state.reconnectTimer) return;
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.leaving && !state.fatal) connectWS();
  }, delay);
}

function cancelReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.reconnectDelay = 500;
}

function connectWS() {
  cancelReconnect();
  if (state.ws) {
    const old = state.ws;
    state.ws = null;
    old.onclose = null;
    try { old.close(); } catch { /* already gone */ }
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
    $('link-dot').className = 'dot on';
    send({ t: 'join', room: state.room, pass: state.pass, name: state.name });
  };

  ws.onmessage = (event) => {
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
    $('link-dot').className = 'dot off';
    if (state.leaving) return;
    // The old peer id dies with the old socket, so the remote connections go
    // away too; the join after the reconnect rebuilds them.
    dropPeers();
    if (state.fatal) {
      leave(state.fatal);
      return;
    }
    say('connection lost, reconnecting');
    scheduleReconnect();
  };

  ws.onerror = () => {
    // A close event follows and does the bookkeeping.
  };
}

function handle(msg) {
  switch (msg.t) {
    case 'joined': {
      state.self = msg.self;
      state.ice = msg.ice || [];
      say('');
      for (const peer of msg.peers || []) connectPeer(peer.id, peer.name, true);
      break;
    }
    case 'peer-joined': {
      ensurePeer(msg.peer.id, msg.peer.name);
      break;
    }
    case 'peer-left': {
      dropPeer(msg.from);
      break;
    }
    case 'offer':
    case 'answer': {
      const peer = connectPeer(msg.from, null, false);
      onDescription(peer, msg.t, msg.sdp);
      break;
    }
    case 'ice': {
      const peer = state.peers.get(msg.from);
      if (peer) onCandidate(peer, msg.candidate);
      break;
    }
    case 'error': {
      if (msg.code === 'unavailable') {
        state.fatal = 'room unavailable or passphrase incorrect';
        leave(state.fatal);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- room flow

async function enterRoom(room, pass) {
  cancelReconnect();
  state.fatal = '';
  state.room = room;
  state.pass = pass;
  state.name = ($('name').value || '').trim().slice(0, 32) || 'guest';
  state.leaving = false;

  $('lobby').hidden = true;
  $('stage').hidden = false;
  $('room-label').textContent = room;
  $('room-label').title = room;
  setHash(room);

  await openCamera();
  connectWS();
}

function leave(message) {
  state.leaving = true;
  cancelReconnect();
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    ws.onclose = null;
    try { ws.close(); } catch { /* already gone */ }
  }
  dropPeers();
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  $('grid').replaceChildren();
  $('stage').hidden = true;
  $('lobby').hidden = false;
  $('room-label').textContent = '';
  $('peer-count').textContent = '';
  $('link-dot').className = 'dot';
  state.room = '';
  state.pass = '';
  state.self = null;
  state.ice = [];
  state.fatal = '';
  state.reconnectDelay = 500;
  setHash('');
  if (message) say(message);
}

// ---------------------------------------------------------------- relay badge

async function pollRelay() {
  for (const peer of state.peers.values()) {
    if (!peer.pc || peer.pc.connectionState !== 'connected') continue;
    try {
      const stats = await peer.pc.getStats();
      let pairId = null;
      const candidates = new Map();
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          pairId = report.selectedCandidatePairId;
        }
        if (report.type === 'candidate-pair' && report.selected) pairId = pairId || report.id;
        if (report.type === 'local-candidate') candidates.set(report.id, report);
      });
      const pair = pairId ? stats.get(pairId) : null;
      const local = pair ? candidates.get(pair.localCandidateId) : null;
      peer.tile.dataset.relay = local && local.candidateType === 'relay' ? 'yes' : 'no';
    } catch {
      /* stats are best effort */
    }
  }
}

// ---------------------------------------------------------------- boot

function init() {
  const fromHash = roomFromHash();
  if (fromHash) $('room').value = fromHash;

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = $('room').value.trim().toLowerCase();
    // An empty room field makes a new room: the join creates it.
    if (!raw) {
      $('room').value = '';
      enterRoom(newRoomID(), $('pass').value || '');
      return;
    }
    const id = (raw.match(/[a-z2-7]{26}/) || [raw])[0];
    if (!ROOM_RE.test(id)) {
      say('that does not look like a room id');
      return;
    }
    enterRoom(id, $('pass').value || '');
  });

  $('mic-btn').addEventListener('click', () => {
    state.mic = !state.mic;
    toggleTrack('audio', state.mic);
    updateButtons();
  });

  $('cam-btn').addEventListener('click', () => {
    state.cam = !state.cam;
    toggleTrack('video', state.cam);
    updateButtons();
  });

  $('leave-btn').addEventListener('click', () => leave(''));

  $('copy-btn').addEventListener('click', async () => {
    const link = `${location.origin}/#r=${state.room}`;
    try {
      await navigator.clipboard.writeText(link);
      $('copy-btn').textContent = 'copied';
      setTimeout(() => { $('copy-btn').textContent = 'copy link'; }, 1500);
    } catch {
      window.prompt('copy this link', link);
    }
  });

  setInterval(pollRelay, 5000);
}

init();
