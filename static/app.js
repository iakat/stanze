'use strict';

// Small full mesh: every peer keeps one RTCPeerConnection per other peer.
// The server only relays SDP and ICE. Negotiation follows the "perfect
// negotiation" pattern so both sides can renegotiate without glare.
//
// Microphone audio always goes through one output track that is built here:
// mic -> RNNoise (optional) -> gain -> mixer destination. Sharing a screen
// adds the screen audio to the same mixer, so neither a mute nor a screen
// stop needs a renegotiation.

const state = {
  ws: null,
  self: null,
  room: '',
  pass: '',
  name: '',
  ice: [],
  peers: new Map(),
  raw: null,          // camera + microphone from getUserMedia
  camTrack: null,
  micTrack: null,
  outStream: null,    // what is sent to peers
  audioCtx: null,
  mixer: null,
  micGain: null,
  micSource: null,
  rnnoise: null,
  rnnoiseOn: false,
  screen: null,       // display stream while sharing
  screenSource: null,
  mic: true,
  cam: true,
  path: 'auto',
  quality: '1280x720@30',
  mirror: true,
  noiseWanted: true,
  leaving: false,
  reconnectTimer: null,
  reconnectDelay: 500,
  fatal: '',
};

const $ = (id) => document.getElementById(id);
const ROOM_RE = /^[a-z0-9._-]{1,64}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const QUALITY = {
  '640x360@30': { w: 640, h: 360, fps: 30 },
  '1280x720@30': { w: 1280, h: 720, fps: 30 },
  '1920x1080@30': { w: 1920, h: 1080, fps: 30 },
  '1920x1080@60': { w: 1920, h: 1080, fps: 60 },
  '2560x1440@30': { w: 2560, h: 1440, fps: 30 },
};

// newRoomID builds a 128 bit room id in the client, so the lobby can suggest
// one without asking the server.
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

function suggestRoom() {
  $('room').value = newRoomID();
}

// normalizeRoom turns whatever was pasted into a room name: a full link, a
// #r= fragment, mixed case, or a plain name.
function normalizeRoom(raw) {
  let text = String(raw || '').trim();
  const hash = text.match(/#r=([^&\s"'<>]+)/);
  if (hash) text = hash[1];
  try {
    text = decodeURIComponent(text);
  } catch { /* keep the raw text */ }
  return text.trim().toLowerCase();
}

function roomFromHash() {
  const raw = location.hash.replace(/^#/, '');
  const id = normalizeRoom(new URLSearchParams(raw).get('r') || '');
  return ROOM_RE.test(id) ? id : '';
}

function setHash(room) {
  history.replaceState(null, '', room ? `#r=${encodeURIComponent(room)}` : location.pathname);
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
  if (local) tile.dataset.local = 'yes';
  tile.innerHTML = `
    <video autoplay playsinline${local ? ' muted' : ''}></video>
    <div class="avatar"></div>
    <div class="tag"><span class="name"></span><span class="flags"></span><span class="state"></span></div>
    ${local ? '' : '<button class="dots" type="button" aria-label="host actions">&#8943;</button><div class="menu" hidden></div>'}`;
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = (name || '?').slice(0, 2);
  if (!local) wireDots(tile);
  $('grid').appendChild(tile);
  return tile;
}

function setTileState(peer, text) {
  if (!peer.tile) return;
  peer.tile.dataset.state = text;
  peer.tile.querySelector('.state').textContent = text;
}

// applyFlags shows the mute and camera state of one tile. A tile with neither
// flag shows nothing extra.
function applyFlags(tile, mic, cam, admin) {
  if (!tile) return;
  const box = tile.querySelector('.flags');
  if (!box) return;
  const out = [];
  if (admin) out.push('host');
  if (mic === false) out.push('muted');
  if (cam === false) out.push('no cam');
  box.innerHTML = '';
  for (const text of out) {
    const chip = document.createElement('span');
    chip.textContent = text;
    box.appendChild(chip);
  }
}

// ---------------------------------------------------------------- host control

// wireDots opens the small menu on a remote tile. Only the admin sees it; the
// CSS shows it on hover. The server checks the role again on every command.
function wireDots(tile) {
  const dots = tile.querySelector('.dots');
  const menu = tile.querySelector('.menu');
  if (!dots || !menu) return;
  dots.addEventListener('click', (event) => {
    event.stopPropagation();
    for (const other of document.querySelectorAll('.tile .menu:not([hidden])')) {
      if (other !== menu) other.hidden = true;
    }
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    menu.replaceChildren();
    for (const [action, label] of [['admin', 'give admin'], ['mute', 'mute'], ['kick', 'remove from room']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        menu.hidden = true;
        send({ t: 'mod', to: tile.dataset.peer, action });
      });
      menu.appendChild(b);
    }
    menu.hidden = false;
  });
  document.addEventListener('click', () => { menu.hidden = true; });
}

// markAdmins redraws the host chip on every tile and hides the menus from
// peers that are not the admin.
function markAdmins() {
  document.body.classList.toggle('is-admin', state.isAdmin);
  for (const peer of state.peers.values()) {
    peer.admin = peer.id === state.adminID;
    applyFlags(peer.tile, peer.mic, peer.cam, peer.admin);
  }
  const self = document.querySelector('.tile[data-local="yes"]');
  applyFlags(self, state.mic, state.cam, state.isAdmin);
}

function updateCount() {
  const total = state.peers.size + 1;
  const live = [...state.peers.values()].filter((p) => p.state === 'connected').length + 1;
  $('peer-count').textContent = total === 1 ? '1 peer' : `${live}/${total} peers`;
}

// ---------------------------------------------------------------- media

const MIC_AUDIO = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };

// prepareLocal builds the empty local side: the output stream, the own tile
// and the buttons. It asks for no permission. The microphone and the camera
// are requested on their first click, so a visitor only watches by default.
function prepareLocal() {
  state.outStream = new MediaStream();
  // The own tile exists even with no camera and no microphone, so the mirror
  // preview, the name and the mute flags always have a place.
  const self = makeTile(state.name, state.name, true);
  self.dataset.state = 'connected';
  self.querySelector('.state').textContent = 'you';
  applyFlags(self, state.mic, state.cam, state.isAdmin);
  applyMirror();
  updateButtons();
}

// publishTrack offers one new track to every peer. addTrack triggers the
// perfect negotiation on that connection, so no manual renegotiation is coded.
function publishTrack(track) {
  if (!track) return;
  for (const peer of state.peers.values()) {
    if (!peer.pc) continue;
    if (peer.pc.getSenders().some((s) => s.track === track)) continue;
    try {
      peer.pc.addTrack(track, state.outStream);
    } catch {
      // The connection is closing; it is replaced by a reconnect.
    }
  }
}

async function enableMic() {
  if (!state.micTrack) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO });
    } catch {
      say('the microphone is not available or was refused');
      return;
    }
    state.micTrack = stream.getAudioTracks()[0] || null;
    if (!state.micTrack) {
      say('the microphone is not available');
      return;
    }
    if (!state.audioCtx) await buildAudio();
    const track = state.mixer && state.mixer.stream.getAudioTracks()[0];
    if (track && state.outStream) state.outStream.addTrack(track);
    publishTrack(track);
  }
  state.mic = true;
  playSfx('timp');
  if (state.micGain) state.micGain.gain.value = 1;
  if (state.micTrack) state.micTrack.enabled = true;
  updateButtons();
  sendState();
}

function disableMic() {
  playSfx('hammer');
  state.mic = false;
  if (state.micGain) state.micGain.gain.value = 0;
  updateButtons();
  sendState();
}

async function enableCam() {
  if (!state.camTrack) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
    } catch {
      say('the camera is not available or was refused');
      return;
    }
    state.camTrack = stream.getVideoTracks()[0] || null;
    if (!state.camTrack) {
      say('the camera is not available');
      return;
    }
    state.camTrack.contentHint = 'motion';
    const self = document.querySelector('.tile[data-local="yes"]');
    if (self) {
      self.querySelector('video').srcObject = new MediaStream([state.camTrack]);
      self.classList.add('playing');
      self.querySelector('video').play().catch(() => {});
    }
    if (state.outStream) state.outStream.addTrack(state.camTrack);
    publishTrack(state.camTrack);
    applyMirror();
  }
  state.cam = true;
  if (state.camTrack) state.camTrack.enabled = true;
  updateButtons();
  sendState();
}

function disableCam() {
  state.cam = false;
  if (state.camTrack) state.camTrack.enabled = false;
  updateButtons();
  sendState();
}

// buildAudio wires mic -> (RNNoise) -> gain -> mixer. The mixer track is what
// the peers receive, and it is created even without a microphone so screen
// audio can be added later without touching the peer connections.
async function buildAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    state.audioCtx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch {
    return;
  }
  state.mixer = state.audioCtx.createMediaStreamDestination();
  state.micGain = state.audioCtx.createGain();
  state.micGain.connect(state.mixer);
  if (state.micTrack && !state.micSource) {
    state.micSource = state.audioCtx.createMediaStreamSource(new MediaStream([state.micTrack]));
    await setNoise(state.noiseWanted);
  }
  resumeAudio();
}

// setNoise switches the microphone between the raw path and the RNNoise path.
// The output of the mixer does not change, so no peer is disturbed.
async function setNoise(on) {
  if (!state.micSource || !state.audioCtx) {
    state.rnnoiseOn = false;
    return false;
  }
  if (on && !state.rnnoise) {
    try {
      // A worklet module has its own scope, so the wasm bundle and the
      // processor come as one file: /rnnoise-node.js.
      await state.audioCtx.audioWorklet.addModule('/rnnoise-node.js');
      state.rnnoise = new AudioWorkletNode(state.audioCtx, 'rnnoise', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      state.rnnoise.connect(state.micGain);
    } catch (err) {
      console.warn('noise suppression unavailable', err);
      state.rnnoise = null;
      state.rnnoiseOn = false;
      return false;
    }
  }
  try { state.micSource.disconnect(); } catch { /* not connected */ }
  if (on) {
    state.micSource.connect(state.rnnoise);
    state.rnnoiseOn = true;
  } else {
    state.micSource.connect(state.micGain);
    state.rnnoiseOn = false;
  }
  return state.rnnoiseOn;
}

function resumeAudio() {
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume().catch(() => {
      // Autoplay policy: retry on the next click.
      document.addEventListener('click', () => state.audioCtx && state.audioCtx.resume().catch(() => {}), { once: true });
    });
  }
}

// sendState tells the room that the microphone or the camera changed. The
// other clients show it as a small flag on the tile.
function sendState() {
  const self = document.querySelector('.tile[data-local="yes"]');
  applyFlags(self, state.mic, state.cam, state.isAdmin);
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ t: 'state', mic: state.mic, cam: state.cam });
  }
}

function updateButtons() {
  $('mic-btn').textContent = state.mic ? 'mic on' : 'mic off';
  $('mic-btn').setAttribute('aria-pressed', String(state.mic));
  $('cam-btn').textContent = state.cam ? 'camera on' : 'camera off';
  $('cam-btn').setAttribute('aria-pressed', String(state.cam));
  $('share-btn').textContent = state.screen ? 'stop share' : 'share screen';
  $('share-btn').setAttribute('aria-pressed', String(!!state.screen));
  $('mirror').checked = state.mirror;
  $('noise-live').checked = state.rnnoiseOn;
}

function applyMirror() {
  const tile = document.querySelector('.tile[data-local="yes"]');
  if (!tile) return;
  const camera = !state.screen;
  tile.classList.toggle('mirrored', state.mirror && camera);
  tile.classList.toggle('screenshare', !!state.screen);
  const badge = tile.querySelector('.state');
  if (badge) badge.textContent = state.screen ? 'your screen' : 'you';
}

// ---------------------------------------------------------------- screen share

// replaceOutVideo swaps the track that is sent to every peer and keeps the
// local preview in sync. replaceTrack avoids a renegotiation when the peer
// already has a video sender. The old camera track stays alive so the share
// can be stopped again.
async function replaceOutVideo(track) {
  if (!state.outStream) return;
  for (const old of state.outStream.getVideoTracks()) {
    state.outStream.removeTrack(old);
  }
  if (track) state.outStream.addTrack(track);
  for (const peer of state.peers.values()) {
    if (!peer.pc) continue;
    let sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) {
      const tr = peer.pc.getTransceivers().find((t) => t.receiver.track && t.receiver.track.kind === 'video');
      if (tr) {
        sender = tr.sender;
        if (tr.direction === 'recvonly') tr.direction = 'sendrecv';
      }
    }
    if (sender) {
      await sender.replaceTrack(track || null).catch(() => {});
    } else if (track) {
      peer.pc.addTrack(track, state.outStream);
    }
  }
}

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    say('screen sharing is not supported by this browser');
    return;
  }
  const q = QUALITY[state.quality] || QUALITY['1280x720@30'];
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: q.fps, max: q.fps }, width: { ideal: q.w }, height: { ideal: q.h } },
      audio: true,
    });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return;
    say('screen sharing failed');
    return;
  }
  state.screen = display;
  const video = display.getVideoTracks()[0];
  if (video) {
    video.contentHint = 'detail';
    video.addEventListener('ended', () => stopShare());
    await replaceOutVideo(video);
    const tile = document.querySelector('.tile[data-local="yes"]');
    if (tile) tile.querySelector('video').srcObject = display;
  }
  const audio = display.getAudioTracks()[0];
  if (audio && state.audioCtx) {
    state.screenSource = state.audioCtx.createMediaStreamSource(new MediaStream([audio]));
    state.screenSource.connect(state.mixer);
    resumeAudio();
  }
  applyMirror();
  updateButtons();
}

async function stopShare() {
  if (!state.screen) return;
  for (const track of state.screen.getTracks()) {
    try { track.stop(); } catch { /* already stopped */ }
  }
  if (state.screenSource) {
    try { state.screenSource.disconnect(); } catch { /* not connected */ }
    state.screenSource = null;
  }
  state.screen = null;
  await replaceOutVideo(state.cam ? state.camTrack : null);
  const tile = document.querySelector('.tile[data-local="yes"]');
  if (tile) {
    const preview = new MediaStream();
    if (state.camTrack) preview.addTrack(state.camTrack);
    tile.querySelector('video').srcObject = preview;
  }
  applyMirror();
  updateButtons();
}

// ---------------------------------------------------------------- peers

function iceServers() {
  const all = state.ice || [];
  if (state.path === 'p2p') {
    // Direct only: hand over STUN servers and nothing that could relay.
    return all.filter((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls || ''];
      return urls.every((u) => !/^turns?:/i.test(u));
    });
  }
  return all;
}

function rtcConfig() {
  return {
    iceServers: iceServers(),
    iceTransportPolicy: state.path === 'relay' ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
  };
}

function ensurePeer(id, name, mic, cam) {
  let peer = state.peers.get(id);
  if (peer) {
    if (mic !== undefined || cam !== undefined) {
      peer.mic = mic === undefined ? peer.mic : mic;
      peer.cam = cam === undefined ? peer.cam : cam;
      applyFlags(peer.tile, peer.mic, peer.cam);
    }
    if (name && peer.name !== name) {
      peer.name = name;
      peer.tile.querySelector('.name').textContent = name;
    }
    return peer;
  }
  peer = {
    id,
    name: name || 'guest',
    mic: mic === undefined ? true : mic,
    cam: cam === undefined ? true : cam,
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
  peer.tile.dataset.peer = id;
  applyFlags(peer.tile, peer.mic, peer.cam);
  state.peers.set(id, peer);
  updateCount();
  return peer;
}

function addLocalTracks(peer) {
  if (peer.tracksAdded) return;
  if (state.outStream) {
    for (const track of state.outStream.getTracks()) {
      peer.pc.addTrack(track, state.outStream);
    }
  }
  peer.tracksAdded = true;
}

// Only the side that starts the offer needs explicit transceivers: without a
// local track the offer would otherwise describe nothing to receive.
function ensureRecvTransceivers(peer) {
  const kinds = new Set(state.outStream ? state.outStream.getTracks().map((t) => t.kind) : []);
  for (const kind of ['audio', 'video']) {
    if (!kinds.has(kind)) peer.pc.addTransceiver(kind, { direction: 'recvonly' });
  }
}

function connectPeer(id, name, initiator, mic, cam) {
  const peer = ensurePeer(id, name, mic, cam);
  if (peer.pc) {
    peer.initiator = peer.initiator || initiator;
    return peer;
  }
  peer.initiator = initiator;

  const pc = new RTCPeerConnection(rtcConfig());
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
      state.adminID = msg.admin || '';
      state.isAdmin = state.adminID === msg.self;
      for (const peer of msg.peers || []) connectPeer(peer.id, peer.name, true, peer.mic, peer.cam);
      markAdmins();
      // Tell the room the real microphone and camera state right away: a new
      // visitor shares neither until a button is pressed.
      sendState();
      break;
    }
    case 'peer-joined': {
      ensurePeer(msg.peer.id, msg.peer.name, msg.peer.mic, msg.peer.cam);
      if (msg.peer.admin) state.adminID = msg.peer.id;
      markAdmins();
      playSfx('pop');
      break;
    }
    case 'admin': {
      state.adminID = msg.admin || '';
      state.isAdmin = state.adminID === state.self;
      markAdmins();
      break;
    }
    case 'mod': {
      // The host asked for a mute. It is a request to this client; the server
      // can not mute a track, so this client turns its own gain down.
      if (msg.action === 'mute') {
        disableMic();
        say('the host muted your microphone');
      }
      break;
    }
    case 'kicked': {
      leave('the host removed you from the room');
      break;
    }
    case 'state': {
      const peer = state.peers.get(msg.from);
      if (peer) {
        if (msg.mic !== undefined) peer.mic = msg.mic;
        if (msg.cam !== undefined) peer.cam = msg.cam;
        applyFlags(peer.tile, peer.mic, peer.cam);
      }
      break;
    }
    case 'peer-left': {
      dropPeer(msg.from);
      playSfx('bonk');
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
  ensureSfx();
  preloadSfx();
  cancelReconnect();
  state.fatal = '';
  state.room = room;
  state.pass = pass;
  state.name = ($('name').value || '').trim().slice(0, 32) || 'guest';
  state.path = $('path').value;
  state.quality = $('quality').value;
  state.noiseWanted = $('noise').checked;
  state.mirror = true;
  state.leaving = false;
  state.mic = false;
  state.cam = false;
  if (window.localStorage) {
    try { localStorage.setItem('rooms.name', state.name); } catch { /* private mode */ }
  }

  $('lobby').hidden = true;
  $('stage').hidden = false;
  $('room-label').textContent = room;
  $('room-label').title = room;
  setHash(room);

  prepareLocal();
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
  if (state.screen) {
    for (const track of state.screen.getTracks()) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    state.screen = null;
  }
  dropPeers();
  if (state.raw) {
    for (const track of state.raw.getTracks()) track.stop();
    state.raw = null;
  }
  if (state.micTrack) {
    try { state.micTrack.stop(); } catch { /* already stopped */ }
  }
  if (state.camTrack) {
    try { state.camTrack.stop(); } catch { /* already stopped */ }
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
  if (state.sfxCtx) {
    state.sfxCtx.close().catch(() => {});
    state.sfxCtx = null;
  }
  sfxCache.clear();
  state.sfxSource = null;
  state.mixer = null;
  state.micGain = null;
  state.micSource = null;
  state.rnnoise = null;
  state.rnnoiseOn = false;
  state.outStream = null;
  state.camTrack = null;
  state.micTrack = null;
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
  state.mic = true;
  state.cam = true;
  setHash('');
  suggestRoom();
  state.reconnectDelay = 500;
  if (message) say(message);
}

// ---------------------------------------------------------------- sound effects

// The four cartoon cues come from the Hanna-Barbera sound effects library that
// is on archive.org. They are stored as 48 kHz mono Opus, which is about 27 kB
// for all four files together. An mp3 copy stays next to each one for a
// browser that can not decode Opus.
const SFX_NAMES = ['pop', 'bonk', 'timp', 'hammer'];
const SFX_RATE = 0.35;
const sfxCache = new Map();
let sfxExt = '';

// pickSfxExt returns the first container the browser plays. Chrome, Firefox and
// Edge take WebM; the rest fall back to Ogg, then to mp3.
function pickSfxExt() {
  if (sfxExt) return sfxExt;
  const probe = document.createElement('audio');
  const tries = [
    ['webm', 'audio/webm; codecs=opus'],
    ['ogg', 'audio/ogg; codecs=opus'],
    ['mp3', 'audio/mpeg'],
  ];
  for (const [ext, type] of tries) {
    if (probe.canPlayType && probe.canPlayType(type)) {
      sfxExt = ext;
      return ext;
    }
  }
  sfxExt = 'webm';
  return sfxExt;
}

function ensureSfx() {
  if (state.sfxCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    state.sfxCtx = new Ctx();
  } catch {
    state.sfxCtx = null;
  }
}

// preloadSfx decodes the four cues once, so a click never waits for a fetch.
function preloadSfx() {
  ensureSfx();
  const ctx = state.sfxCtx;
  if (!ctx) return;
  const ext = pickSfxExt();
  for (const name of SFX_NAMES) {
    if (sfxCache.has(name)) continue;
    fetch(`sfx/${name}.${ext}`)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b))
      .then((buffer) => sfxCache.set(name, buffer))
      .catch(() => {});
  }
}

// playSfx plays one cue in full. A cue never waits in a line: it replaces the
// one that is playing, so the newest event is the one that is heard.
function playSfx(name) {
  if (!state.sfxCtx || !SFX_NAMES.includes(name)) return;
  const ctx = state.sfxCtx;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const buffer = sfxCache.get(name);
  if (!buffer) {
    // Not decoded yet: this cue is dropped, the file is tiny and the next
    // click finds it ready.
    return;
  }
  if (state.sfxSource) {
    try { state.sfxSource.stop(); } catch { /* already finished */ }
    state.sfxSource = null;
  }
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = SFX_RATE;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.onended = () => {
      if (state.sfxSource === src) state.sfxSource = null;
    };
    state.sfxSource = src;
    src.start();
  } catch {
    // The context is gone; the next join builds a new one.
  }
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
  if (fromHash) {
    $('room').value = fromHash;
  } else {
    suggestRoom();
  }
  if (window.localStorage) {
    try {
      const last = localStorage.getItem('rooms.name');
      if (last) $('name').value = last;
    } catch { /* private mode */ }
  }

  $('newid-btn').addEventListener('click', (event) => {
    event.preventDefault();
    suggestRoom();
  });

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const room = normalizeRoom($('room').value);
    if (!room) {
      // Nothing typed: the suggested id is used.
      const id = newRoomID();
      $('room').value = id;
      enterRoom(id, $('pass').value || '');
      return;
    }
    if (!ROOM_RE.test(room)) {
      say('room names use a-z 0-9 . _ - (1 to 64 characters)');
      return;
    }
    $('room').value = room;
    enterRoom(room, $('pass').value || '');
  });

  $('noise-live').addEventListener('change', async () => {
    const on = $('noise-live').checked;
    const applied = await setNoise(on);
    if (applied !== on) say('noise suppression is not available');
    updateButtons();
  });

  $('mirror').addEventListener('change', () => {
    state.mirror = $('mirror').checked;
    applyMirror();
  });

  $('quality').addEventListener('change', () => {
    state.quality = $('quality').value;
  });

  $('share-btn').addEventListener('click', () => {
    if (state.screen) stopShare();
    else startShare();
  });

  $('mic-btn').addEventListener('click', () => {
    if (state.mic) disableMic();
    else enableMic();
  });

  $('cam-btn').addEventListener('click', () => {
    if (state.cam) disableCam();
    else enableCam();
  });

  $('leave-btn').addEventListener('click', () => leave(''));

  $('copy-btn').addEventListener('click', async () => {
    const link = `${location.origin}/#r=${encodeURIComponent(state.room)}`;
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
