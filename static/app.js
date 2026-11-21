'use strict';

// Small full mesh: every peer keeps one RTCPeerConnection per other peer.
// The server only relays SDP and ICE. Negotiation follows the "perfect
// negotiation" pattern so both sides can renegotiate without glare.
//
// The room has two forms on the same page. A plain room sends names, chat and
// media as they are. A sealed room (the `sealed` checkbox, remembered in the
// browser) keeps names and chat inside opaque `enc` payloads and puts every
// encoded media frame through an AES-GCM transform in a worker, so the relay
// only ever forwards sealed blobs. The stage, the tiles, the chat log, the
// stats panel and the controls are the same in both forms.
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
  admins: new Set(),  // filled by `joined`; empty until then
  raw: null,          // camera + microphone from getUserMedia
  camTrack: null,
  micTrack: null,
  outStream: null,    // what is sent to peers
  audioCtx: null,     // the microphone graph
  mixer: null,
  micGain: null,
  micSource: null,
  micAnalyser: null,  // tap on the microphone input, for the stats level
  meterBuf: null,     // one reusable buffer for the analyser
  meterPeak: 0,       // decaying peak, so one tick per second can see a word
  meterTimer: null,
  rnnoise: null,
  rnnoiseOn: false,
  playCtx: null,      // the remote audio graph, so a peer can go over 100%
  screen: null,       // display stream while sharing
  screenSource: null,
  mic: false,         // live in this call
  cam: false,
  prefMic: true,      // the choice kept in localStorage
  prefCam: true,
  path: 'auto',
  quality: '1280x720@30',
  mirror: true,
  noiseWanted: true,
  leaving: false,
  reconnectTimer: null,
  reconnectDelay: 500,
  fatal: '',
  statsTimer: null,
  statsBusy: false,
  sfxCtx: null,
  sfxSource: null,
  lostSource: null,   // the loop that plays while the socket is down
  lostGain: null,
  lostWanted: false,

  // Sealed room state. Every field is inert until a sealed join: the plain
  // path never reads the worker, the identity or the frame counters.
  sealed: false,       // this call is a sealed one
  wasmOk: false,       // /pq.wasm loaded and the self test passed once
  wasmTest: null,      // the result of that self test, for the stats panel
  identity: null,      // our key bundle for one call
  worker: null,        // /e2e-transform.js, one per sealed call
  keyWait: new Map(),  // pair -> resolve, waiting for the worker to import keys
  frames: {},          // pair|dir|kind -> last counter message of the worker
  encryptFrames: 0,
  decryptFrames: 0,
  chatSent: 0,
  chatRecv: 0,
  confirmFailures: 0,
  workerErrors: [],    // a red row in the stats panel, never ignored
  sealFault: '',       // why this browser can not seal media, if it can not
  modeClash: false,    // this call met a guest that uses the other mode
  wireFrames: 0,       // signaling frames inspected by the audit
  wireLeaks: [],       // a canary that appeared on the wire, must stay empty
  canaries: [],        // the name and the chat lines that must never leak
  samples: [],         // a few frame samples, for the in-page lab proof
};


// The markup is the single source of truth for the element types: an id that
// is not listed here is a typo, and a listed id hands back the right DOM type.
/**
 * @typedef {{
 *   lobby: HTMLElement, 'join-form': HTMLFormElement, name: HTMLInputElement,
 *   room: HTMLInputElement, 'newid-btn': HTMLButtonElement, pass: HTMLInputElement,
 *   path: HTMLSelectElement, noise: HTMLInputElement, 'enter-btn': HTMLButtonElement,
 *   sealed: HTMLInputElement, 'sealed-note': HTMLElement,
 *   'lobby-error': HTMLElement, stage: HTMLElement, 'room-label': HTMLElement,
 *   'peer-count': HTMLElement, 'copy-btn': HTMLButtonElement, 'link-dot': HTMLElement,
 *   'link-text': HTMLElement, 'sealed-badge': HTMLElement, grid: HTMLElement,
 *   'stats-panel': HTMLElement,
 *   'stats-body': HTMLElement, 'chat-log': HTMLElement, 'chat-form': HTMLFormElement,
 *   'chat-text': HTMLInputElement, 'chat-note': HTMLElement, 'mic-btn': HTMLButtonElement,
 *   'cam-btn': HTMLButtonElement, 'share-btn': HTMLButtonElement,
 *   'stats-btn': HTMLButtonElement, 'stats-close': HTMLButtonElement,
 *   'leave-btn': HTMLButtonElement,
 *   quality: HTMLSelectElement, mirror: HTMLInputElement,
 *   'noise-live': HTMLInputElement, 'stage-error': HTMLElement,
 * }} Elements
 */

/**
 * @template {keyof Elements} K
 * @param {K} id
 * @returns {Elements[K]}
 */
const $ = (id) => /** @type {Elements[K]} */ (document.getElementById(id));
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

// ---------------------------------------------------------------- preferences

// The browser keeps a few small strings: the name, the room, the last
// microphone and camera choice, the media path, rnnoise, and the volume of
// each peer by name. An unreadable storage (private mode) simply keeps nothing.
function store(key, value) {
  if (!window.localStorage) return;
  try { localStorage.setItem('rooms.' + key, String(value)); } catch { /* private mode */ }
}

function load(key) {
  if (!window.localStorage) return '';
  try { return localStorage.getItem('rooms.' + key) || ''; } catch { return ''; }
}

// isAdmin answers "does this peer hold the role". It is safe before the first
// `joined` message, when no role is known yet.
function isAdmin(id) {
  return !!(id && state.admins && state.admins.has(id));
}

// setAdmins replaces the role list in place, so every reader of the same set
// sees the new list. It also rebuilds a missing set instead of throwing.
function setAdmins(list) {
  if (!(state.admins instanceof Set)) state.admins = new Set();
  state.admins.clear();
  for (const id of list || []) state.admins.add(id);
}

// joinWords renders a short list for the status line ("a, b and c").
function joinWords(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
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

// sealedFlag reads the sealed flag from the fragment or from the query:
// '1' on, '0' off, '' when the link says nothing. The fragment is what a
// copied link carries; the query is what the old /e2e route redirects to, so a
// link from before the merge still lands sealed. The flag is on by default, so
// a plain link has to say '0' to keep a plain room plain.
function sealedFlag() {
  const value = new URLSearchParams(location.search).get('sealed')
    || new URLSearchParams(location.hash.replace(/^#/, '')).get('sealed')
    || '';
  if (value === '1' || value === 'true' || value === 'on') return '1';
  if (value === '0' || value === 'false' || value === 'off') return '0';
  return '';
}

// setHash keeps the room, and the sealed flag with it, in the fragment: a
// fragment never reaches the server, and a link carries the choice of the
// visitor, so a plain room stays plain when the link is opened again.
function setHash(room) {
  const params = new URLSearchParams();
  if (room) {
    params.set('r', room);
    params.set('sealed', state.sealed ? '1' : '0');
  }
  const hash = params.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
}

function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws';
}

function send(msg) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const raw = JSON.stringify(msg);
  // The audit sees every frame the relay sees, in both directions. It is the
  // client half of the proof that a sealed room never sends a name or a chat
  // line in the clear.
  if (state.sealed) auditWire('out', raw);
  state.ws.send(raw);
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
    ${local ? '' : `<div class="vol">
      <input class="vol-range" type="range" min="0" max="200" step="5" value="100" aria-label="volume of this participant">
      <span class="vol-num">100%</span>
    </div>`}
    <div class="tag"><span class="name"></span><span class="flags"></span><span class="state"></span></div>
    ${local ? '' : '<div class="sas" hidden></div><button class="dots" type="button" aria-label="host actions">&#8943;</button><div class="menu" hidden></div>'}`;
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = (name || '?').slice(0, 2);
  if (state.sealed && !local) {
    // A sealed guest is heard through its own gain node, so the video element
    // only ever carries pictures and stays muted.
    tile.querySelector('video').muted = true;
  }
  if (!local) wireDots(tile);
  $('grid').appendChild(tile);
  return tile;
}

// ---------------------------------------------------------------- volume

// The volume of one participant is a percent from 0 (silent) to 200, kept per
// name, so the same visitor sounds the same on the next visit.
function storedVolume(name) {
  const raw = load(`vol.${name}`);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(200, n));
}

// paintVolume draws the percent of one peer on its slider, its label and the
// live gain. It is called when the slider moves, and again when a sealed guest
// tells us the name that its stored volume is kept under.
function paintVolume(peer) {
  const range = peer.tile ? peer.tile.querySelector('.vol-range') : null;
  const num = peer.tile ? peer.tile.querySelector('.vol-num') : null;
  if (num) num.textContent = `${peer.vol}%`;
  if (range) range.value = String(peer.vol);
  if (peer.gain) peer.gain.gain.value = peer.vol / 100;
  // The element path is only a fallback and can not go over 100 percent.
  if (peer.audioEl) peer.audioEl.volume = Math.min(peer.vol / 100, 1);
}

// wireVolume connects one tile slider to one peer. The gain and the label are
// painted from peer.vol, which the audio path and the slider share.
function wireVolume(peer) {
  const range = peer.tile.querySelector('.vol-range');
  const num = peer.tile.querySelector('.vol-num');
  if (!range || !num) return;
  range.value = String(peer.vol);
  range.addEventListener('input', () => {
    const n = parseInt(range.value, 10);
    peer.vol = Number.isFinite(n) ? Math.max(0, Math.min(200, n)) : 100;
    paintVolume(peer);
    store(`vol.${peer.name}`, peer.vol);
  });
  paintVolume(peer);
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
    const open = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tile .menu:not([hidden])'));
    for (const other of open) {
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
  const mine = isAdmin(state.self);
  document.body.classList.toggle('is-admin', mine);
  for (const peer of state.peers.values()) {
    peer.admin = isAdmin(peer.id);
    applyFlags(peer.tile, peer.mic, peer.cam, peer.admin);
  }
  const self = document.querySelector('.tile[data-local="yes"]');
  applyFlags(self, state.mic, state.cam, mine);
}

function updateCount() {
  const total = state.peers.size + 1;
  const live = [...state.peers.values()].filter((p) => p.state === 'connected').length + 1;
  $('peer-count').textContent = total === 1 ? '1 peer' : `${live}/${total} peers`;
}

// ---------------------------------------------------------------- media

const MIC_AUDIO = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
const CAM_VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };

// ask opens one getUserMedia request and never throws, so the join can always
// go on with whatever the browser gives.
async function ask(constraints) {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(constraints) };
  } catch (err) {
    return { err };
  }
}

// requestLocal asks for the camera and the microphone when the join button is
// pressed: one prompt when both are wanted, and the call starts with both on.
// A refusal or a missing device never stops the join; the devices that did not
// open stay off and a short status line says which ones.
async function requestLocal() {
  state.mic = false;
  state.cam = false;
  const wantMic = state.prefMic;
  const wantCam = state.prefCam;
  if (!wantMic && !wantCam) {
    updateButtons();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    say('this browser offers no camera and no microphone: you joined to watch and listen');
    updateButtons();
    return;
  }

  const missing = [];
  const refused = [];
  const noteErr = (err, list) => {
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) refused.push(list);
    else missing.push(list);
  };

  if (wantMic && wantCam) {
    const both = await ask({ audio: MIC_AUDIO, video: CAM_VIDEO });
    if (both.stream) {
      await adoptMic(both.stream.getAudioTracks()[0]);
      await adoptCam(both.stream.getVideoTracks()[0]);
    } else if (both.err && (both.err.name === 'NotAllowedError' || both.err.name === 'SecurityError')) {
      // The visitor answered the prompt with no. Asking twice would not prompt.
      refused.push('camera and microphone');
    } else {
      // One of the two may be missing or busy: ask for each of them alone, so
      // the other one still starts.
      const parts = await Promise.all([ask({ audio: MIC_AUDIO }), ask({ video: CAM_VIDEO })]);
      const mic = parts[0].stream ? parts[0].stream.getAudioTracks()[0] : null;
      const cam = parts[1].stream ? parts[1].stream.getVideoTracks()[0] : null;
      await adoptMic(mic);
      await adoptCam(cam);
      if (!mic) noteErr(parts[0].err, 'microphone');
      if (!cam) noteErr(parts[1].err, 'camera');
    }
  } else if (wantMic) {
    const mic = await ask({ audio: MIC_AUDIO });
    const track = mic.stream ? mic.stream.getAudioTracks()[0] : null;
    await adoptMic(track);
    if (!track) noteErr(mic.err, 'microphone');
  } else {
    const cam = await ask({ video: CAM_VIDEO });
    const track = cam.stream ? cam.stream.getVideoTracks()[0] : null;
    await adoptCam(track);
    if (!track) noteErr(cam.err, 'camera');
  }

  state.mic = !!state.micTrack;
  state.cam = !!state.camTrack;
  if (refused.length) {
    say(`the ${joinWords(refused)} ${refused.length > 1 ? 'were' : 'was'} refused; you joined without ${refused.length > 1 ? 'them' : 'it'}`);
  } else if (missing.length) {
    say(`no ${joinWords(missing)}; you joined without ${missing.length > 1 ? 'them' : 'it'}`);
  }
  refreshSelf();
}

// prepareLocal builds the empty local side: the output stream, the own tile
// and the buttons. The permission prompt belongs to requestLocal, which runs
// right after this and fills state.mic and state.cam.
function prepareLocal() {
  state.outStream = new MediaStream();
  // The own tile exists even with no camera and no microphone, so the mirror
  // preview, the name and the mute flags always have a place.
  const self = makeTile(state.name, state.name, true);
  self.dataset.state = 'connected';
  self.querySelector('.state').textContent = 'you';
  applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  applyMirror();
  updateButtons();
}

// refreshSelf paints the own tile flags and the buttons from the live state.
function refreshSelf() {
  const self = document.querySelector('.tile[data-local="yes"]');
  applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  updateButtons();
}

// addTrackToPeer is the one place that offers a track to one connection. In a
// plain room that is a bare addTrack. In a sealed room the sender must carry
// the frame transform before the first frame can leave, and a browser that
// cannot install it gets no track at all: a missing frame is better than a
// plaintext one.
function addTrackToPeer(peer, track) {
  if (!peer.pc || !track) return;
  if (!state.sealed) {
    try { peer.pc.addTrack(track, state.outStream); } catch { /* closing */ }
    return;
  }
  if (!sealingAvailable() || !state.worker) return;
  let sender;
  try {
    sender = peer.pc.addTrack(track, state.outStream);
  } catch {
    // The connection is closing; it is replaced by a reconnect.
    return;
  }
  try {
    sender.transform = new RTCRtpScriptTransform(state.worker, {
      pair: pairLabel(peer.id), peer: peer.id, dir: 'send', kind: track.kind,
    });
  } catch (err) {
    state.workerErrors.push('sender transform: ' + err);
  }
  // The setter can be accepted and ignored. A read back of null proves the
  // frame would go out in the clear, so the track comes off the connection.
  if (!sender.transform) {
    try { peer.pc.removeTrack(sender); } catch { /* closing */ }
    state.sealFault = 'this browser ignored the frame transform, so no media is sent';
    state.workerErrors.push('sender transform not accepted for ' + track.kind);
    say(state.sealFault);
  }
}

// publishTrack offers one new track to every peer. addTrack triggers the
// perfect negotiation on that connection, so no manual renegotiation is coded.
function publishTrack(track) {
  if (!track) return;
  for (const peer of state.peers.values()) {
    if (!peer.pc) continue;
    if (peer.pc.getSenders().some((s) => s.track === track)) continue;
    addTrackToPeer(peer, track);
  }
}

// adoptMic makes one microphone track the live input: it goes through RNNoise
// and the gain into the mixer, and the mixer track is what peers receive.
async function adoptMic(track) {
  if (!track) return;
  state.micTrack = track;
  track.enabled = true;
  if (!state.audioCtx) await buildAudio();
  if (!state.micSource && state.audioCtx) {
    state.micSource = state.audioCtx.createMediaStreamSource(new MediaStream([track]));
    await setNoise(state.noiseWanted);
  }
  startMeter();
  const out = state.mixer && state.mixer.stream.getAudioTracks()[0];
  if (out && state.outStream && !state.outStream.getAudioTracks().includes(out)) {
    state.outStream.addTrack(out);
  }
  publishTrack(out);
}

// adoptCam makes one camera track the live video. While a screen is shared the
// screen stays what peers receive, so only the preview would change later.
async function adoptCam(track) {
  if (!track) return;
  state.camTrack = track;
  track.contentHint = 'motion';
  track.enabled = true;
  const self = document.querySelector('.tile[data-local="yes"]');
  if (self && !state.screen) {
    self.querySelector('video').srcObject = new MediaStream([track]);
    self.classList.add('playing');
    self.querySelector('video').play().catch(() => {});
  }
  if (state.screen) return;
  if (state.outStream && !state.outStream.getVideoTracks().includes(track)) {
    state.outStream.addTrack(track);
  }
  publishTrack(track);
  applyMirror();
}

async function enableMic() {
  if (state.sealed && !sealingAvailable()) {
    // No transform, no frame: the microphone stays off and says why.
    say('this browser cannot seal media frames, so the microphone stays off');
    return;
  }
  if (!state.micTrack) {
    const mic = await ask({ audio: MIC_AUDIO });
    const track = mic.stream ? mic.stream.getAudioTracks()[0] : null;
    if (!track) {
      say(mic.err && mic.err.name === 'NotAllowedError'
        ? 'the microphone was refused'
        : 'the microphone is not available');
      return;
    }
    await adoptMic(track);
  }
  state.mic = true;
  state.prefMic = true;
  store('mic', 1);
  playSfx('timp');
  if (state.micGain) state.micGain.gain.value = 1;
  if (state.micTrack) state.micTrack.enabled = true;
  updateButtons();
  sendState();
}

function disableMic() {
  playSfx('hammer');
  state.mic = false;
  state.prefMic = false;
  store('mic', 0);
  if (state.micGain) state.micGain.gain.value = 0;
  updateButtons();
  sendState();
}

async function enableCam() {
  if (state.sealed && !sealingAvailable()) {
    say('this browser cannot seal media frames, so the camera stays off');
    return;
  }
  if (!state.camTrack) {
    const cam = await ask({ video: CAM_VIDEO });
    const track = cam.stream ? cam.stream.getVideoTracks()[0] : null;
    if (!track) {
      say(cam.err && cam.err.name === 'NotAllowedError'
        ? 'the camera was refused'
        : 'the camera is not available');
      return;
    }
    await adoptCam(track);
  }
  state.cam = true;
  state.prefCam = true;
  store('cam', 1);
  if (state.camTrack) state.camTrack.enabled = true;
  updateButtons();
  sendState();
}

function disableCam() {
  state.cam = false;
  state.prefCam = false;
  store('cam', 0);
  if (state.camTrack) state.camTrack.enabled = false;
  updateButtons();
  sendState();
}

// buildAudio wires mic -> (RNNoise) -> gain -> mixer. The mixer track is what
// the peers receive, and it is created even without a microphone so screen
// audio can be added later without touching the peer connections.
async function buildAudio() {
  // Safari still exposes the prefixed constructor, which the DOM lib omits.
  // @ts-expect-error -- vendor prefixed fallback
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
  startMeter();
  resumeAudio();
}

// startMeter reads the microphone before the gain, on a second branch of the
// source, so the stats show a live device even while the local mute is on. It
// does not touch the path to the peers: a muted gain still sends silence.
const METER_MS = 50;

function startMeter() {
  if (!state.audioCtx || !state.micSource) return;
  if (!state.micAnalyser) {
    try {
      state.micAnalyser = state.audioCtx.createAnalyser();
      state.micAnalyser.fftSize = 1024;
      state.micSource.connect(state.micAnalyser);
    } catch {
      state.micAnalyser = null;
      return;
    }
  }
  if (state.meterTimer) return;
  state.meterTimer = setInterval(readMeter, METER_MS);
}

// readMeter keeps a peak that falls slowly: the stats panel is read once a
// second, and a 50 ms sample of speech is mostly gaps.
function readMeter() {
  const a = state.micAnalyser;
  if (!a) return;
  if (!state.meterBuf || state.meterBuf.length !== a.fftSize) {
    state.meterBuf = new Float32Array(a.fftSize);
  }
  a.getFloatTimeDomainData(state.meterBuf);
  let sum = 0;
  for (let i = 0; i < state.meterBuf.length; i++) {
    const v = state.meterBuf[i];
    sum += v * v;
  }
  const rms = Math.sqrt(sum / state.meterBuf.length);
  state.meterPeak = Math.max(rms, state.meterPeak * 0.9);
}

function stopMeter() {
  if (state.meterTimer) clearInterval(state.meterTimer);
  state.meterTimer = null;
  state.micAnalyser = null;
  state.meterBuf = null;
  state.meterPeak = 0;
}

// micLevelLine reports the peak as a percent between -60 dB and full scale,
// with the dB value beside it, because that is what a phone's meter shows. A
// value near zero with a live track points at the graph, not at the device.
function micLevelLine() {
  if (!state.micAnalyser) return 'level none';
  const peak = state.meterPeak;
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  const pct = db > -60 ? Math.round(((db + 60) / 60) * 100) : 0;
  return db > -90 ? `level ${pct}% ${Math.round(db)} dB` : 'level 0% silent';
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

// ---------------------------------------------------------------- remote audio

// Remote audio does not play from the video element: one gain node per peer
// takes it to the output, so 100 percent is unity and 200 is a real boost.
// The context is created while the join click is still the last gesture, and a
// suspended context resumes on the next click.
function ensurePlayback() {
  if (state.playCtx) {
    resumePlayback();
    return state.playCtx;
  }
  // Safari still exposes the prefixed constructor, which the DOM lib omits.
  // @ts-expect-error -- vendor prefixed fallback
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    state.playCtx = new Ctx({ latencyHint: 'interactive' });
  } catch {
    state.playCtx = null;
    return null;
  }
  resumePlayback();
  return state.playCtx;
}

function resumePlayback() {
  const ctx = state.playCtx;
  if (!ctx || ctx.state !== 'suspended') return;
  ctx.resume().catch(() => {
    document.addEventListener('click', () => ctx.resume().catch(() => {}), { once: true });
  });
}

// routeAudio sends one incoming audio track through the gain of its peer. The
// element path is only used when the browser has no Web Audio; it can not go
// over 100 percent.
function routeAudio(peer, track) {
  const ctx = ensurePlayback();
  if (!ctx) {
    const el = peer.audioEl || new Audio();
    el.autoplay = true;
    el.srcObject = new MediaStream([track]);
    el.volume = Math.min(peer.vol / 100, 1);
    el.play().catch(() => {});
    peer.audioEl = el;
    return;
  }
  dropAudio(peer);
  peer.gain = ctx.createGain();
  peer.gain.gain.value = peer.vol / 100;
  peer.audioSrc = ctx.createMediaStreamSource(new MediaStream([track]));
  peer.audioSrc.connect(peer.gain);
  peer.gain.connect(ctx.destination);
  resumePlayback();
}

// dropAudio unhooks one peer from the output, so a closed peer is silent and
// its nodes can be collected.
function dropAudio(peer) {
  if (!peer) return;
  if (peer.audioSrc) {
    try { peer.audioSrc.disconnect(); } catch { /* already gone */ }
    peer.audioSrc = null;
  }
  if (peer.gain) {
    try { peer.gain.disconnect(); } catch { /* already gone */ }
    peer.gain = null;
  }
  if (peer.audioEl) {
    try { peer.audioEl.pause(); } catch { /* already gone */ }
    peer.audioEl.srcObject = null;
    peer.audioEl = null;
  }
}

// sendState tells the room that the microphone or the camera changed. The
// other clients show it as a small flag on the tile.
function sendState() {
  const self = document.querySelector('.tile[data-local="yes"]');
  applyFlags(self, state.mic, state.cam, isAdmin(state.self));
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
  // Without a microphone the switch still shows what the next microphone will
  // get, which is the stored choice.
  $('noise-live').checked = state.micSource ? state.rnnoiseOn : state.noiseWanted;
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
      addTrackToPeer(peer, track);
    }
  }
}

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    say('screen sharing is not supported by this browser');
    return;
  }
  if (state.sealed && !sealingAvailable()) {
    say('this browser cannot seal media frames, so screen sharing stays off');
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
  const hasTurn = (server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls || ''];
    return urls.every((u) => /^turns?:/i.test(u));
  };
  if (state.path === 'p2p') {
    // Direct only: hand over STUN servers and nothing that could relay.
    return all.filter((server) => !hasTurn(server));
  }
  if (state.path === 'relay') {
    // Relay only: a STUN server that is unreachable would only stall the
    // gathering and leave the peer with no candidate at all.
    return all.filter(hasTurn);
  }
  return all;
}

/**
 * @returns {RTCConfiguration}
 */
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
  // A sealed room has no name to draw yet: the name arrives sealed, later. The
  // short id keeps the tile readable until then.
  const initial = state.sealed ? String(id).slice(0, 6) : (name || 'guest');
  peer = {
    id,
    name: initial,
    mic: mic === undefined ? true : mic,
    cam: cam === undefined ? true : cam,
    vol: 100,
    pc: null,
    tile: null,
    video: null,
    gain: null,
    audioSrc: null,
    audioEl: null,
    statLast: new Map(),
    polite: String(state.self) > String(id),
    makingOffer: false,
    settingAnswer: false,
    ignoreOffer: false,
    tracksAdded: false,
    pending: [],
    state: 'new',
    initiator: false,
    // sealed handshake, inert in a plain room
    pub: null,
    keys: null,
    transcript: null,
    sas: '',
    confirmed: false,
    ready: '',
    myConfirm: '',
    sentConfirm: false,
    keyPromise: null,
    helloTimer: null,
    recvSet: new Set(),
    announcedName: '',
  };
  peer.vol = storedVolume(peer.name);
  peer.tile = makeTile(peer.name, peer.name);
  peer.video = peer.tile.querySelector('video');
  peer.tile.dataset.peer = id;
  applyFlags(peer.tile, peer.mic, peer.cam);
  wireVolume(peer);
  state.peers.set(id, peer);
  updateCount();
  return peer;
}

function addLocalTracks(peer) {
  if (peer.tracksAdded) return;
  if (state.outStream) {
    for (const track of state.outStream.getTracks()) {
      addTrackToPeer(peer, track);
    }
  }
  peer.tracksAdded = true;
  // A sealed answer must seal the new receivers too, before the answer leaves.
  if (state.sealed) installSealedReceivers(peer);
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
    const track = event.track;
    if (track.kind === 'audio') {
      // Audio is played through this peer gain, not through the video element,
      // so it can be louder than the browser maximum and silent at 0 percent.
      routeAudio(peer, track);
      track.addEventListener('ended', () => dropAudio(peer));
      return;
    }
    const video = peer.tile.querySelector('video');
    const stream = new MediaStream([track]);
    if (video.srcObject !== stream) video.srcObject = stream;
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
    // The receivers named by our own senders and transceivers need the
    // transform before the answer of the other side arrives.
    if (state.sealed) installSealedReceivers(peer);
  }
  return peer;
}

function setPeerState(peer, text) {
  peer.state = text;
  if (state.sealed) {
    // In a sealed room the badge on the tile names the key state, so the link
    // state lives in the data attribute only.
    if (peer.tile) peer.tile.dataset.state = text;
    if ((text === 'failed' || text === 'closed') && peer.tile) peer.tile.classList.remove('playing');
    if (text === 'connected') $('link-text').textContent = `sealed, ${state.peers.size + 1} in the room`;
    else if (text === 'failed') $('link-text').textContent = 'sealed, link failed';
    updateCount();
    return;
  }
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
    // The remote senders exist now; their transform has to be in place before
    // the first frame is decoded.
    if (state.sealed) installSealedReceivers(peer);

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
  if (peer.helloTimer) clearTimeout(peer.helloTimer);
  dropAudio(peer);
  if (peer.pc) peer.pc.close();
  if (peer.tile) peer.tile.remove();
  state.peers.delete(id);
  if (state.sealed) updateSealedBadge();
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
    stopLost();
    // A sealed room never sends a name: the server announces every peer as its
    // placeholder, and the real name travels sealed once the keys exist.
    send({ t: 'join', room: state.room, pass: state.pass, name: state.sealed ? '' : state.name, sealed: state.sealed });
  };

  ws.onmessage = (event) => {
    if (state.sealed) auditWire('in', event.data);
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
    startLost();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // A close event follows and does the bookkeeping.
  };
}

function handle(msg) {
  // A host command, a kick and a terminal join error mean the same in both
  // kinds of room, so they are answered before the mode split.
  if (msg.t === 'mod') {
    // The host asked for a mute. It is a request to this client; the server
    // can not mute a track, so this client turns its own gain down.
    if (msg.action === 'mute') {
      disableMic();
      say('the host muted your microphone');
    }
    return;
  }
  if (msg.t === 'kicked') {
    leave('the host removed you from the room');
    return;
  }
  if (msg.t === 'error') {
    if (msg.code === 'unavailable') {
      state.fatal = 'room unavailable or passphrase incorrect';
      leave(state.fatal);
    }
    return;
  }
  if (state.sealed) {
    handleSealed(msg);
    return;
  }
  switch (msg.t) {
    case 'joined': {
      state.self = msg.self;
      state.ice = msg.ice || [];
      state.modeClash = false;
      say('');
      setAdmins(msg.admins);
      const peers = msg.peers || [];
      if (plainModeClash(peers)) break;
      for (const peer of peers) {
        if (peer.sealed) continue;
        connectPeer(peer.id, peer.name, true, peer.mic, peer.cam);
      }
      markAdmins();
      renderChat(msg.chat);
      // Tell the room the real microphone and camera state right away.
      sendState();
      break;
    }
    case 'peer-joined': {
      if (msg.peer.sealed) {
        noteModeClash('a guest joined in a sealed room, so you can not see or hear each other');
        break;
      }
      ensurePeer(msg.peer.id, msg.peer.name, msg.peer.mic, msg.peer.cam);
      if (msg.peer.admin) state.admins.add(msg.peer.id);
      markAdmins();
      playSfx('pop');
      break;
    }
    case 'admin': {
      setAdmins(msg.admins);
      markAdmins();
      break;
    }
    case 'chat': {
      addChatLine(msg.kind, msg.name, msg.text, msg.ts, msg.from);
      break;
    }
    case 'state': {
      const peer = state.peers.get(msg.from);
      if (peer) {
        const wasMic = peer.mic;
        if (msg.mic !== undefined) peer.mic = msg.mic;
        if (msg.cam !== undefined) peer.cam = msg.cam;
        applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
        if (wasMic !== peer.mic) {
          addChatLine('note', '', `${peer.name} ${peer.mic ? 'turned the microphone on' : 'turned the microphone off'}`);
        }
      }
      break;
    }
    case 'peer-left': {
      dropPeer(msg.from);
      state.admins.delete(msg.from);
      markAdmins();
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
  }
}

// ---------------------------------------------------------------- room flow

async function enterRoom(room, pass) {
  ensureSfx();
  preloadSfx();
  cancelReconnect();
  state.fatal = '';
  state.modeClash = false;
  state.room = room;
  state.pass = pass;
  // The checkbox is the one choice that decides the whole call. It is read
  // once, here, and never changed silently afterwards.
  state.sealed = !!$('sealed').checked;
  store('sealed', state.sealed ? 1 : 0);
  state.name = state.sealed
    ? (cleanSealedName($('name').value) || 'guest')
    : (($('name').value || '').trim().slice(0, 32) || 'guest');
  state.path = $('path').value;
  state.quality = $('quality').value;
  state.noiseWanted = $('noise').checked;
  state.mirror = true;
  state.leaving = false;
  // The call starts with what the visitor chose last time.
  state.mic = state.prefMic;
  state.cam = state.prefCam;
  store('name', state.name);
  store('room', state.room);
  store('path', state.path);
  store('noise', state.noiseWanted ? 1 : 0);

  if (state.sealed) {
    await enterSealedRoom();
    return;
  }

  $('lobby').hidden = true;
  $('stage').hidden = false;
  $('room-label').textContent = room;
  $('room-label').title = room;
  setHash(room);

  prepareLocal();
  // The join click asks for the camera and the microphone. The signaling
  // socket waits for the answer, so the first offer already carries the tracks.
  try {
    await requestLocal();
  } catch {
    // Devices are optional; joining the room is not.
  }
  ensurePlayback();
  connectWS();
}

// enterSealedRoom opens the same stage as a sealed room. The post-quantum
// module and the frame worker are ready before the stage appears, so a browser
// that cannot seal stays in the lobby with a reason instead of quietly
// becoming a plain room.
async function enterSealedRoom() {
  const room = state.room;
  // The join click is the gesture the audio output needs.
  ensurePlayback();
  $('enter-btn').disabled = true;
  $('sealed-note').hidden = false;
  $('sealed-note').textContent = 'loading the post-quantum module';
  try {
    try {
      await ensureWasm();
      $('sealed-note').textContent = 'pq-e2e ready';
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      $('sealed-note').textContent = 'the post-quantum module did not load: ' + why;
      // No silent fallback: the lobby says what failed and the visitor decides.
      state.room = '';
      state.pass = '';
      say('cannot open a sealed room: ' + why);
      return;
    }

    // A fresh call: no counter from the last room may reach the stats panel.
    state.frames = {};
    state.encryptFrames = 0;
    state.decryptFrames = 0;
    state.chatSent = 0;
    state.chatRecv = 0;
    state.confirmFailures = 0;
    state.workerErrors = [];
    state.sealFault = '';
    state.wireFrames = 0;
    state.wireLeaks = [];
    state.canaries = [];
    state.samples = [];
    state.keyWait.clear();
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    startSealedWorker();
    state.identity = JSON.parse(pqModule().gen());
    canary(state.name);
    if (!sealingAvailable()) {
      state.sealFault = 'this browser cannot seal media frames, so no media is sent';
      state.mic = false;
      state.cam = false;
    }

    $('lobby').hidden = true;
    $('stage').hidden = false;
    $('room-label').textContent = room;
    $('room-label').title = room;
    $('chat-note').hidden = false;
    $('sealed-badge').hidden = false;
    updateSealedBadge();
    $('link-text').textContent = 'sealed, connecting';
    setHash(room);

    prepareLocal();
    if (sealingAvailable()) {
      // The same device request and the same microphone graph as a plain room;
      // only the senders carry a transform.
      try {
        await requestLocal();
      } catch {
        // Devices are optional; joining the room is not.
      }
    } else {
      updateButtons();
      say(state.sealFault + '; you joined without microphone and camera');
    }
    connectWS();
  } catch (err) {
    leave('');
    state.leaving = false;
    say('cannot open a sealed room: ' + (err && err.message ? err.message : String(err)));
  } finally {
    $('enter-btn').disabled = false;
  }
}

function leave(message) {
  const was = state.room;
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
  // The sealed worker holds the pair keys; it dies with the call. The module
  // itself stays loaded, so the next sealed join needs no second download.
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  state.identity = null;
  state.keyWait.clear();
  state.frames = {};
  state.encryptFrames = 0;
  state.decryptFrames = 0;
  state.chatSent = 0;
  state.chatRecv = 0;
  state.confirmFailures = 0;
  state.workerErrors = [];
  state.sealFault = '';
  state.wireFrames = 0;
  state.wireLeaks = [];
  state.canaries = [];
  state.samples = [];
  state.sealed = false;
  $('sealed-badge').hidden = true;
  $('sealed-badge').textContent = '';
  $('sealed-badge').removeAttribute('title');
  $('chat-note').hidden = true;
  $('link-text').textContent = 'connected';
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
  if (state.playCtx) {
    state.playCtx.close().catch(() => {});
    state.playCtx = null;
  }
  stopLost();
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
  stopMeter();
  state.outStream = null;
  state.camTrack = null;
  state.micTrack = null;
  stopStats();
  clearStatsPanel();
  $('stats-panel').hidden = true;
  $('stats-btn').setAttribute('aria-pressed', 'false');
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
  state.modeClash = false;
  state.reconnectDelay = 500;
  state.mic = false;
  state.cam = false;
  setAdmins([]);
  state.peers.clear();
  if ($('chat-log')) $('chat-log').replaceChildren();
  setHash('');
  // The room field keeps the room the visitor was just in, so another try
  // needs no retyping.
  if (was) $('room').value = was;
  else suggestRoom();
  state.reconnectDelay = 500;
  if (message) say(message);
}

// ---------------------------------------------------------------- chat

// The room log carries text lines and events in one shape. Events are drawn in
// a duller colour, so the talk stays readable.
const CHAT_MAX = 200;
const chatNames = new Map();

function chatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function chatEventText(kind, name, text) {
  switch (kind) {
    case 'join': return `${name} joined`;
    case 'leave': return `${name} left`;
    case 'kick': return `${text} removed ${name}`;
    case 'mute': return `${text} muted ${name}`;
    case 'admin': return `${name} is now host`;
    case 'note': return text;
    default: return '';
  }
}

function addChatLine(kind, name, text, ts, from) {
  const log = $('chat-log');
  if (!log) return;
  const fill = () => {
    const li = document.createElement('li');
    if (kind !== 'text') li.className = 'event';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = chatTime(ts);
    li.appendChild(when);
    if (kind === 'text') {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${name || 'guest'}:`;
      li.appendChild(who);
      li.appendChild(document.createTextNode(` ${text}`));
    } else {
      li.appendChild(document.createTextNode(chatEventText(kind, name, text)));
    }
    log.appendChild(li);
    while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  };
  if (from) chatNames.set(from, name);
  fill();
}

function renderChat(lines) {
  const log = $('chat-log');
  if (!log) return;
  log.replaceChildren();
  for (const line of lines || []) {
    addChatLine(line.kind, line.name, line.text, line.ts, line.from);
  }
}

function sendChat() {
  if (state.sealed) {
    sendSealedChat();
    return;
  }
  const input = $('chat-text');
  const text = (input.value || '').trim();
  if (!text) return;
  send({ t: 'chat', text });
  input.value = '';
}

// ---------------------------------------------------------------- sound effects

// The four cartoon cues come from the Hanna-Barbera sound effects library that
// is on archive.org. They are stored as 48 kHz mono Opus, which is about 27 kB
// for all four files together. An mp3 copy stays next to each one for a
// browser that can not decode Opus.
//
// The fifth cue is the lost connection chime: it is synthesized here, so it has
// no source sample to credit, and it is a seamless loop instead of a one shot.
const SFX_NAMES = ['pop', 'bonk', 'timp', 'hammer', 'lost'];
const SFX_RATE = 0.35;
// The pad sits under the room for as long as the socket is down, so it plays
// quieter than a one shot cue.
const LOST_RATE = 0.2;
// The lost cue is 8.32 s long and loops the middle 8.0 s of it: two soft
// chimes four seconds apart, with real silence at the loop point.
const LOST_LOOP_START = 0.16;
const LOST_LOOP_END = 8.16;
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
  // Safari still exposes the prefixed constructor, which the DOM lib omits.
  // @ts-expect-error -- vendor prefixed fallback
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    state.sfxCtx = new Ctx();
  } catch {
    state.sfxCtx = null;
  }
}

// preloadSfx decodes the cues once, so a click never waits for a fetch.
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
      .then((buffer) => {
        sfxCache.set(name, buffer);
        // A lost connection may already have asked for the pad.
        if (name === 'lost' && state.lostWanted) startLost();
      })
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

// startLost loops the waiting chime while the signaling socket is down. A second
// call while it already plays does nothing, so a chain of reconnect attempts
// can never stack copies of it.
function startLost() {
  state.lostWanted = true;
  if (state.lostSource) return;
  const ctx = state.sfxCtx;
  const buffer = sfxCache.get('lost');
  if (!ctx || !buffer) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    // The file carries a little head and tail around the 8.0 s loop, so the
    // codec padding at the file edges stays outside the loop point: the pad
    // runs on with no gap and no click.
    if (buffer.duration >= LOST_LOOP_END) {
      src.loopStart = LOST_LOOP_START;
      src.loopEnd = LOST_LOOP_END;
    }
    const gain = ctx.createGain();
    gain.gain.value = LOST_RATE;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    state.lostSource = src;
    state.lostGain = gain;
  } catch {
    state.lostSource = null;
    state.lostGain = null;
  }
}

// stopLost cuts the pad as soon as the client is connected again.
function stopLost() {
  state.lostWanted = false;
  const src = state.lostSource;
  state.lostSource = null;
  if (state.lostGain) {
    try { state.lostGain.disconnect(); } catch { /* already gone */ }
    state.lostGain = null;
  }
  if (!src) return;
  try { src.stop(); } catch { /* already finished */ }
  try { src.disconnect(); } catch { /* already gone */ }
}

// ---------------------------------------------------------------- telemetry

// The stats panel is read at 1 Hz from getStats deltas: two byte counters give
// a bitrate, and the selected candidate pair gives the round trip time and the
// path. Polling stops when the panel is closed or the tab is hidden.
const STATS_MS = 1000;

function statsOpen() {
  const panel = $('stats-panel');
  return !!panel && !panel.hidden;
}

function startStats() {
  if (state.statsTimer || !statsOpen()) return;
  for (const peer of state.peers.values()) peer.statLast.clear();
  clearStatsPanel();
  updateStats();
  state.statsTimer = setInterval(() => updateStats(), STATS_MS);
}

function stopStats() {
  if (state.statsTimer) clearInterval(state.statsTimer);
  state.statsTimer = null;
}

// setStatsOpen is the one place that shows or hides the panel, so the toolbar
// button and the close button on the panel head cannot disagree.
function setStatsOpen(open) {
  $('stats-panel').hidden = !open;
  $('stats-btn').setAttribute('aria-pressed', String(open));
  if (open && !document.hidden) startStats();
  else stopStats();
}

function clearStatsPanel() {
  const body = $('stats-body');
  if (body) body.replaceChildren();
}

// bitrate turns two samples of one byte counter into kbit/s. The first sample
// of a counter yields 0, which is honest: nothing was measured yet.
function bitrate(last, report, field) {
  const bytes = report[field] || 0;
  const ts = report.timestamp || 0;
  const key = `${report.id || report.type + ':' + report.kind}:${field}`;
  const prev = last.get(key);
  last.set(key, { bytes, ts });
  if (!prev || !(ts > prev.ts)) return 0;
  const kbit = ((bytes - prev.bytes) * 8) / (ts - prev.ts);
  return kbit > 0 ? Math.round(kbit) : 0;
}

function isDirectType(type) {
  return type === 'host' || type === 'srflx' || type === 'prflx';
}

// peerStats reads one report of one peer. Every access is guarded: a peer that
// closed between two ticks must not throw.
async function peerStats(peer) {
  const pc = peer.pc;
  if (!pc || typeof pc.getStats !== 'function') return null;
  if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return null;
  let report;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }
  if (!report || typeof report.forEach !== 'function') return null;
  if (!(peer.statLast instanceof Map)) peer.statLast = new Map();

  const out = { up: { audio: 0, video: 0 }, down: { audio: 0, video: 0 }, rtt: null, path: '' };
  let pairId = null;
  const pairs = new Map();
  const cands = new Map();
  try {
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
        out.up[r.kind] += bitrate(peer.statLast, r, 'bytesSent');
      } else if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
        out.down[r.kind] += bitrate(peer.statLast, r, 'bytesReceived');
      } else if (r.type === 'transport' && r.selectedCandidatePairId) {
        pairId = r.selectedCandidatePairId;
      } else if (r.type === 'candidate-pair') {
        pairs.set(r.id, r);
      } else if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
        cands.set(r.id, r);
      }
    });
  } catch {
    // A report can change under the loop; the next tick reads a fresh one.
  }

  let pair = pairId ? pairs.get(pairId) : null;
  if (!pair) {
    for (const p of pairs.values()) {
      if (p.selected || p.nominated) { pair = p; break; }
    }
  }
  if (!pair) {
    for (const p of pairs.values()) {
      if (p.state === 'succeeded') { pair = p; break; }
    }
  }
  if (pair) {
    if (typeof pair.currentRoundTripTime === 'number') {
      out.rtt = Math.round(pair.currentRoundTripTime * 1000);
    }
    const local = cands.get(pair.localCandidateId);
    const remote = cands.get(pair.remoteCandidateId);
    const lt = local ? local.candidateType || local.type || '' : '';
    const rt = remote ? remote.candidateType || remote.type || '' : '';
    const relays = [];
    if (lt === 'relay') relays.push('you');
    if (rt === 'relay') relays.push('them');
    if (relays.length) out.path = `relay (${relays.join(' + ')})`;
    else if (isDirectType(lt) && isDirectType(rt)) out.path = 'p2p';
  }
  return out;
}

// ownMediaLine describes the local devices: the microphone and its input
// level, rnnoise, the state of the microphone graph and the camera
// resolution. A live track with a silent meter points at the graph; a dead
// context points at the autoplay rule of a phone.
function ownMediaLine() {
  const parts = [];
  const live = !!(state.mic && state.micTrack && state.micTrack.readyState === 'live');
  const mic = live && state.micTrack && state.micTrack.getSettings ? state.micTrack.getSettings() : null;
  let label = live ? 'mic on' : 'mic off';
  // Safari reports no sample rate on an audio track, so the rate is a bonus
  // and a missing rate never means off.
  if (mic && mic.sampleRate) label += ` ${Math.round(mic.sampleRate / 1000)} kHz ${mic.channelCount || 1}ch`;
  parts.push(label);
  if (live) parts.push(micLevelLine());
  parts.push(state.rnnoiseOn ? 'rnnoise on' : 'rnnoise off');
  parts.push(`audio ${state.audioCtx ? state.audioCtx.state : 'none'}`);
  const cam = state.camTrack && state.camTrack.getSettings ? state.camTrack.getSettings() : null;
  if (cam && cam.width && cam.height) parts.push(`camera ${cam.width}x${cam.height}`);
  else parts.push('camera off');
  return parts.join(' | ');
}

function pathLine(s) {
  const bits = [];
  if (s.rtt !== null) bits.push(`${s.rtt} ms`);
  if (s.path) bits.push(s.path);
  return bits.join(' | ') || 'no pair yet';
}

function rateLine(s) {
  return `video ${s.up.video}/${s.down.video} | audio ${s.up.audio}/${s.down.audio}`;
}

function statsRow(title, lines, mark) {
  const row = document.createElement('div');
  row.className = 'srow';
  const head = document.createElement('div');
  head.className = 'sname';
  head.textContent = title;
  row.appendChild(head);
  for (const text of lines) {
    const line = document.createElement('div');
    line.className = 'sline' + (mark === true ? ' good' : mark === false ? ' bad' : '');
    line.textContent = text;
    row.appendChild(line);
  }
  return row;
}

// updateStats draws one round. The totals of the own tile are the sums of the
// per peer numbers across every connection. A sealed room adds its own rows
// (suite, self test, room code, sealed frame counters, wire audit) above the
// per peer rate rows, in the same panel and the same sheet on a phone.
async function updateStats() {
  if (!statsOpen() || state.statsBusy) return;
  const body = $('stats-body');
  if (!body) return;
  state.statsBusy = true;
  try {
    const total = { up: { audio: 0, video: 0 }, down: { audio: 0, video: 0 } };
    const rows = [];
    for (const peer of state.peers.values()) {
      const s = await peerStats(peer);
      if (!s) {
        rows.push(statsRow(peer.name, ['connecting']));
        continue;
      }
      for (const dir of ['up', 'down']) {
        for (const kind of ['audio', 'video']) total[dir][kind] += s[dir][kind];
      }
      rows.push(statsRow(peer.name, [pathLine(s), rateLine(s)]));
    }
    const own = statsRow('you', [ownMediaLine(), rateLine(total)]);
    const sealed = state.sealed ? sealedStatsRows() : [];
    body.replaceChildren(own, ...sealed, ...rows);
  } finally {
    state.statsBusy = false;
  }
}

// ---------------------------------------------------------------- sealed rooms
//
// A sealed room keeps the stage and the plumbing of a plain one and changes
// three things: the join never carries a name, the chat never uses the server
// `chat` message, and every encoded media frame goes through an AES-GCM
// transform in a worker. The keys come from the WebAssembly build of X25519 +
// ML-KEM-768 (static/pq.wasm) through the JSON bridge in wasm_exec.js, so the
// relay only ever sees opaque blobs.

// The short code is 13 base32 characters, which is fine to compare on a screen
// but clumsy to read aloud. The same bits are shown as six emoji with a
// different shape and a different name each, so two people on a voice call can
// compare them without spelling anything and without confusing two of them.
const VERIFY_EMOJI = [
  ['⚓', 'anchor'], ['🔔', 'bell'], ['🚲', 'bicycle'], ['🌵', 'cactus'],
  ['📷', 'camera'], ['🕯', 'candle'], ['🥕', 'carrot'], ['🕐', 'clock'],
  ['☁️', 'cloud'], ['👑', 'crown'], ['🐬', 'dolphin'], ['🐉', 'dragon'],
  ['🥁', 'drum'], ['🦅', 'eagle'], ['🐟', 'fish'], ['👻', 'ghost'],
  ['🎸', 'guitar'], ['🔨', 'hammer'], ['🚁', 'helicopter'], ['🔑', 'key'],
  ['🧲', 'magnet'], ['🍄', 'mushroom'], ['🦉', 'owl'], ['✏️', 'pencil'],
  ['🚀', 'rocket'], ['✂️', 'scissors'], ['🚢', 'ship'], ['☀️', 'sun'],
  ['☂️', 'umbrella'], ['🎻', 'violin'], ['🐝', 'bee'], ['🐌', 'snail'],
];

const sealUtf8 = new TextEncoder();

/** @returns {any} */
function win() {
  return /** @type {any} */ (window);
}

/** @returns {any} */
function pqModule() {
  return win().stanzePQ;
}

function b64e(bytes) {
  let raw = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) raw += String.fromCharCode(view[i]);
  return btoa(raw);
}

function b64d(s) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function encOpaque(obj) {
  return b64e(sealUtf8.encode(JSON.stringify(obj)));
}

function decOpaque(s) {
  return JSON.parse(new TextDecoder().decode(b64d(s)));
}

// A sealed name never reaches the server, but it does reach a tile and a chat
// line, so control characters are dropped exactly like a plain name.
function cleanSealedName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
}

function shortPeer(id) {
  return String(id || '').slice(0, 6);
}

function pairLabel(peerId) {
  return [state.self, peerId].sort().join('|');
}

function verifyEmojis(code) {
  const out = [];
  for (const ch of String(code || '').toLowerCase()) {
    const index = B32.indexOf(ch);
    if (index < 0) continue;
    out.push(VERIFY_EMOJI[index % VERIFY_EMOJI.length]);
    if (out.length === 6) break;
  }
  return out;
}

function verifyText(code) {
  return verifyEmojis(code).map((pair) => pair[0]).join(' ');
}

function verifyNames(code) {
  return verifyEmojis(code).map((pair) => pair[1]).join(', ');
}

function chatAAD(peerId) {
  return sealUtf8.encode('pq-e2e v1 chat ' + pairLabel(peerId));
}

// sealingAvailable answers the only question that matters for the media: can
// this browser put every encoded frame through the worker before it leaves? A
// browser without the transform would send the microphone and the camera in the
// clear, so the answer gates the media, not just a badge.
function sealingAvailable() {
  return typeof RTCRtpScriptTransform === 'function' &&
    typeof RTCRtpSender !== 'undefined' && 'transform' in RTCRtpSender.prototype &&
    typeof RTCRtpReceiver !== 'undefined' && 'transform' in RTCRtpReceiver.prototype;
}

// ------------------------------------------------------------- wasm loading

// wasm_exec.js is only fetched when a sealed room is wanted, so a plain visit
// never pays for the module. The script defines the Go class; the module then
// starts the JSON bridge.
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (win().Go) {
      resolve(null);
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve(null);
    el.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(el);
  });
}

function loadWasmModule() {
  return new Promise((resolve, reject) => {
    const Go = win().Go;
    if (!window.WebAssembly || typeof Go !== 'function') {
      reject(new Error('webassembly unavailable'));
      return;
    }
    const go = new Go();
    fetch('/pq.wasm')
      .then((res) => {
        if (!res.ok) throw new Error('wasm ' + res.status);
        return WebAssembly.instantiateStreaming(res, go.importObject);
      })
      .catch(async () => {
        const res = await fetch('/pq.wasm');
        if (!res.ok) throw new Error('wasm ' + res.status);
        const buf = await res.arrayBuffer();
        return WebAssembly.instantiate(buf, go.importObject);
      })
      .then((res) => {
        go.run(res.instance); // the Go runtime does not return
        const started = Date.now();
        const timer = setInterval(() => {
          if (pqModule()) {
            clearInterval(timer);
            resolve(null);
          } else if (Date.now() - started > 30000) {
            clearInterval(timer);
            reject(new Error('wasm module did not start'));
          }
        }, 20);
      })
      .catch(reject);
  });
}

// pqSelfTest runs the handshake twice inside the module and proves that both
// halves agree and that one side can open what the other seals. It runs once
// per page and the result is shown in the stats panel.
function pqSelfTest() {
  const pq = pqModule();
  const a = JSON.parse(pq.gen());
  const b = JSON.parse(pq.gen());
  const off = JSON.parse(pq.initiate(JSON.stringify({
    self: 'a', peer: 'b', selfX: a.xpub, selfK: a.ek, peerX: b.xpub, peerK: b.ek,
  })));
  const acc = JSON.parse(pq.respond(JSON.stringify({
    self: 'b', peer: 'a', selfX: b.xpub, selfSK: b.xsk, selfK: b.ek, selfDK: b.dk,
    peerX: a.xpub, peerK: a.ek, epk: off.epk, ct: off.ct,
  })));
  const verifyA = JSON.parse(pq.verify(JSON.stringify({
    key: off.keys.recvMedia, transcript: off.transcript, tag: acc.confirm,
  })));
  const verifyB = JSON.parse(pq.verify(JSON.stringify({
    key: acc.keys.recvMedia, transcript: off.transcript, tag: off.confirm,
  })));
  const pt = b64e(sealUtf8.encode('sealed hello'));
  const aad = b64e(sealUtf8.encode('pq-e2e v1 chat a|b'));
  const sealed = JSON.parse(pq.seal(JSON.stringify({ key: off.keys.sendChat, aad, pt })));
  const opened = JSON.parse(pq.open(JSON.stringify({
    key: acc.keys.recvChat, aad, b: sealed.b,
  })));
  const wrong = JSON.parse(pq.open(JSON.stringify({
    key: b64e(crypto.getRandomValues(new Uint8Array(32))), aad, b: sealed.b,
  })));
  return {
    sas: off.keys.sas,
    sasMatch: off.keys.sas === acc.keys.sas,
    confirm: !!(verifyA.ok && verifyB.ok),
    open: opened.pt === pt,
    wrongKeyRefused: !!wrong.error,
  };
}

// ensureWasm loads the script, the module and the self test once. A failure is
// remembered as a failure of that attempt only, so a reload of the page (or a
// second click) can try again.
let wasmLoad = null;

function ensureWasm() {
  if (state.wasmOk) return Promise.resolve();
  if (wasmLoad) return wasmLoad;
  wasmLoad = loadScriptOnce('/wasm_exec.js')
    .then(loadWasmModule)
    .then(() => {
      const test = pqSelfTest();
      state.wasmTest = test;
      if (!test.sasMatch || !test.confirm || !test.open || !test.wrongKeyRefused) {
        throw new Error('crypto self test failed');
      }
      state.wasmOk = true;
    })
    .catch((err) => {
      wasmLoad = null;
      throw err;
    });
  return wasmLoad;
}

// preloadSealed warms the module as soon as the checkbox is on (or a sealed
// link is opened), so the join itself is only a microphone prompt.
function preloadSealed() {
  $('sealed-note').hidden = false;
  $('sealed-note').textContent = 'loading the post-quantum module';
  ensureWasm()
    .then(() => {
      if (!$('lobby').hidden && $('sealed').checked) {
        $('sealed-note').textContent = 'pq-e2e ready';
      }
    })
    .catch((err) => {
      if (!$('lobby').hidden && $('sealed').checked) {
        $('sealed-note').textContent = 'the post-quantum module did not load: '
          + (err && err.message ? err.message : err);
      }
    });
}

// ------------------------------------------------------------- wire audit

// The audit watches every signaling frame in both directions for the strings
// that must never leave the sealed channel (the name and the chat lines). It is
// the client half of the server log check.
function canary(value) {
  const s = String(value || '');
  if (s.length >= 4 && !state.canaries.includes(s)) state.canaries.push(s);
}

function auditWire(where, raw) {
  if (!state.sealed) return;
  const text = typeof raw === 'string' ? raw : String(raw);
  state.wireFrames++;
  for (const c of state.canaries) {
    if (text.includes(c) && state.wireLeaks.length < 20) {
      state.wireLeaks.push({ where, canary: c });
    }
  }
}

// ------------------------------------------------------------- opaque payloads

function sealedSendOpaque(to, obj) {
  send({ t: 'enc', to, b: encOpaque(obj) });
}

function sealedOpenOpaque(b) {
  return decOpaque(b);
}

// pqCall parses one JSON answer of the module and turns any fault into null, so
// a broken bridge can never throw through an event handler.
/** @param {(json: string) => string} fn @param {any} input @returns {any} */
function pqCall(fn, input) {
  try {
    return JSON.parse(fn(JSON.stringify(input)));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- frame worker

function startSealedWorker() {
  const worker = new Worker('/e2e-transform.js');
  worker.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'stats') {
      state.frames[msg.pair + '|' + msg.dir + (msg.kind ? '|' + msg.kind : '')] = msg;
      paintFrameCounters();
    } else if (msg.type === 'keys-ok') {
      const resolve = state.keyWait.get(msg.pair);
      if (resolve) {
        state.keyWait.delete(msg.pair);
        resolve();
      }
    } else if (msg.type === 'sample') {
      if (state.samples.length < 40) state.samples.push(msg);
    } else if (msg.type === 'error') {
      state.workerErrors.push(msg.msg || 'worker error');
    }
  };
  worker.onerror = (event) => state.workerErrors.push(String(event.message || event));
  state.worker = worker;
}

function paintFrameCounters() {
  let enc = 0;
  let dec = 0;
  for (const st of Object.values(state.frames)) {
    if (!st) continue;
    if (st.dir === 'send') enc += st.ok || 0;
    else if (st.dir === 'recv') dec += st.ok || 0;
  }
  state.encryptFrames = enc;
  state.decryptFrames = dec;
}

// installSealedReceivers puts the receive transform on every receiver the
// connection has, before a frame of that sender is decoded. The set makes it
// idempotent, so it can run after every description and every addTrack.
function installSealedReceivers(peer) {
  const pc = peer.pc;
  if (!pc || !state.sealed || !state.worker) return;
  for (const receiver of pc.getReceivers()) {
    if (peer.recvSet.has(receiver)) continue;
    peer.recvSet.add(receiver);
    try {
      receiver.transform = new RTCRtpScriptTransform(state.worker, {
        pair: pairLabel(peer.id), peer: peer.id, dir: 'recv', kind: receiver.track.kind,
      });
    } catch (err) {
      state.workerErrors.push('receiver transform: ' + err);
    }
  }
}

// ------------------------------------------------------------- handshake

function sealedSendPub(peer) {
  if (!state.identity) return;
  sealedSendOpaque(peer.id, { k: 'pub', x: state.identity.xpub, m: state.identity.ek });
}

// sealedOnPub decides which side initiates: the lower peer id. The other side
// answers the hello, and asks once more for the bundle if a reconnect race ate
// it. A duplicate bundle is harmless.
function sealedOnPub(peer, msg) {
  peer.pub = { x: msg.x, m: msg.m };
  if (peer.keys || peer.keyPromise) return;
  if (String(state.self) < String(peer.id)) {
    sealedInitiate(peer);
    return;
  }
  if (peer.helloTimer) clearTimeout(peer.helloTimer);
  peer.helloTimer = setTimeout(() => {
    if (!peer.keys && !state.leaving && state.peers.has(peer.id)) sealedSendPub(peer);
  }, 3000);
}

// sealedInstallKeys hands the pair keys to the worker and waits for the import.
// The peer connection is not built before that: a first frame without a key
// would be dropped, and a dropped key frame costs seconds of video.
function sealedInstallKeys(peer, out) {
  peer.keys = out.keys;
  peer.transcript = out.transcript;
  peer.sas = out.keys.sas;
  peer.ready = 'handshake';
  if (peer.tile) peer.tile.dataset.sas = peer.sas;
  const pair = pairLabel(peer.id);
  const ready = new Promise((resolve) => {
    state.keyWait.set(pair, resolve);
    setTimeout(() => resolve(null), 5000);
  });
  if (state.worker) {
    state.worker.postMessage({
      type: 'keys', pair, peer: peer.id, enc: out.keys.sendMedia, dec: out.keys.recvMedia,
    });
  } else {
    state.workerErrors.push('sealed worker missing');
  }
  sealedSetE2E(peer, 'handshake');
  return ready;
}

function sealedInitiate(peer) {
  if (!state.identity) return;
  const out = pqCall((json) => pqModule().initiate(json), {
    self: state.self,
    peer: peer.id,
    selfX: state.identity.xpub,
    selfK: state.identity.ek,
    peerX: peer.pub.x,
    peerK: peer.pub.m,
  });
  if (!out) {
    say('handshake failed: the post-quantum module refused the key bundle');
    return;
  }
  if (out.error) {
    say('handshake failed: ' + out.error);
    return;
  }
  peer.keyPromise = sealedInstallKeys(peer, out);
  peer.myConfirm = out.confirm;
  sealedSendOpaque(peer.id, { k: 'hello', epk: out.epk, ct: out.ct });
}

function sealedRespond(peer, msg) {
  if (!state.identity) return;
  const out = pqCall((json) => pqModule().respond(json), {
    self: state.self,
    peer: peer.id,
    selfX: state.identity.xpub,
    selfSK: state.identity.xsk,
    selfK: state.identity.ek,
    selfDK: state.identity.dk,
    peerX: peer.pub.x,
    peerK: peer.pub.m,
    epk: msg.epk,
    ct: msg.ct,
  });
  if (!out) {
    say('handshake failed: the post-quantum module refused the hello');
    return;
  }
  if (out.error) {
    say('handshake failed: ' + out.error);
    return;
  }
  peer.keyPromise = sealedInstallKeys(peer, out);
  // Our confirmation lets the initiator check that we decapsulated the same
  // secret; we start media right away because our own keys are final.
  peer.myConfirm = out.confirm;
  sealedSendOpaque(peer.id, { k: 'ok', c: out.confirm });
  peer.sentConfirm = true;
  sealedSetE2E(peer, 'ready');
  sealedAnnounceName(peer);
  // The initiator owns the offer; this side answers it.
}

function sealedOnConfirm(peer, msg) {
  if (!peer.keys) return;
  const res = pqCall((json) => pqModule().verify(json), {
    key: peer.keys.recvMedia, transcript: peer.transcript, tag: msg.c,
  });
  if (!res || !res.ok) {
    state.confirmFailures++;
    sealedSetE2E(peer, 'failed');
    say('key confirmation failed for ' + shortPeer(peer.id) + ': keys do not match');
    return;
  }
  peer.confirmed = true;
  sealedSetE2E(peer, 'ready');
  if (!peer.sentConfirm && peer.myConfirm) {
    peer.sentConfirm = true;
    sealedSendOpaque(peer.id, { k: 'ok', c: peer.myConfirm });
  }
  sealedAnnounceName(peer);
  if (!peer.pc && String(state.self) < String(peer.id)) {
    Promise.resolve(peer.keyPromise).then(() => {
      if (!peer.pc && !state.leaving) connectPeer(peer.id, null, true);
    });
  }
}

function sealedHandleOpaque(from, b) {
  const peer = state.peers.get(from);
  if (!peer) return;
  let msg;
  try {
    msg = sealedOpenOpaque(b);
  } catch {
    return;
  }
  switch (msg.k) {
    case 'pub':
      sealedOnPub(peer, msg);
      break;
    case 'hello':
      if (!peer.pub) return;
      if (String(state.self) < String(from)) return; // we are the initiator
      if (peer.keys || peer.keyPromise) return; // duplicate hello, keys already set
      sealedRespond(peer, msg);
      break;
    case 'ok':
      sealedOnConfirm(peer, msg);
      break;
    case 'app':
      if (!peer.keys) return;
      sealedOnApp(peer, msg.b);
      break;
    default:
      break;
  }
}

function sealedOnApp(peer, b) {
  const out = pqCall((json) => pqModule().open(json), {
    key: peer.keys.recvChat, aad: b64e(chatAAD(peer.id)), b,
  });
  if (!out || out.error) return;
  let obj;
  try {
    obj = decOpaque(out.pt);
  } catch {
    return;
  }
  if (obj.k === 'name') {
    sealedSetName(peer, obj.n);
  } else if (obj.k === 'chat') {
    state.chatRecv++;
    addChatLine('text', peer.name || shortPeer(peer.id), String(obj.x || ''), Date.now());
  }
}

function sealedAnnounceName(peer) {
  if (!peer.keys || !state.name || peer.announcedName === state.name) return;
  peer.announcedName = state.name;
  sealedSend(peer, { k: 'name', n: state.name });
}

function sealedSend(peer, obj) {
  if (!peer.keys) return;
  const out = pqCall((json) => pqModule().seal(json), {
    key: peer.keys.sendChat,
    aad: b64e(chatAAD(peer.id)),
    pt: b64e(sealUtf8.encode(JSON.stringify(obj))),
  });
  if (out && out.b) sealedSendOpaque(peer.id, { k: 'app', b: out.b });
}

function sendSealedChat() {
  const input = $('chat-text');
  const text = (input.value || '').trim();
  if (!text || !state.self) return;
  input.value = '';
  canary(text);
  addChatLine('text', state.name, text, Date.now());
  state.chatSent++;
  for (const peer of state.peers.values()) {
    if (!peer.keys) continue;
    sealedSend(peer, { k: 'chat', n: state.name, x: text, ts: Date.now() });
  }
}

// sealedSetName paints the decrypted name and moves the stored volume to it.
function sealedSetName(peer, raw) {
  const name = cleanSealedName(raw);
  if (!name || !peer.tile || peer.name === name) return;
  peer.name = name;
  peer.tile.querySelector('.name').textContent = name;
  peer.vol = storedVolume(name);
  paintVolume(peer);
}

// sealedSetE2E paints the key state and the short code on one tile.
function sealedSetE2E(peer, status) {
  peer.ready = status;
  if (state.sealed) updateSealedBadge();
  if (!peer.tile) return;
  peer.tile.dataset.e2e = status;
  const badge = peer.tile.querySelector('.state');
  if (badge) {
    badge.textContent = status === 'ready' ? 'e2e ready'
      : status === 'failed' ? 'e2e FAILED'
        : status;
  }
  const sas = /** @type {HTMLElement} */ (peer.tile.querySelector('.sas'));
  if (!sas) return;
  if (!peer.sas) {
    sas.hidden = true;
    sas.textContent = '';
    sas.removeAttribute('title');
    return;
  }
  sas.hidden = false;
  sas.textContent = verifyText(peer.sas) + '  code ' + peer.sas;
  // The names behind the emoji are a title, so a screen reader and a nervous
  // guest can both tell what they are looking at.
  sas.title = verifyNames(peer.sas) + ' (' + peer.sas + ')';
}

// ------------------------------------------------------------- sealed signaling

// The room code is the code of the peers, never the code of the local self
// test: that one is ours alone and proves nothing about the other side. Two
// peers with two different codes is the alarm, so it is said out loud.
function sealedRoomCodes() {
  const codes = new Set();
  for (const peer of state.peers.values()) if (peer.sas) codes.add(peer.sas);
  return codes;
}

function sealedRoomCode() {
  const codes = sealedRoomCodes();
  return codes.size === 1 ? [...codes][0] : '';
}

function sealedCodesDiffer() {
  return sealedRoomCodes().size > 1;
}

// updateSealedBadge keeps the badge and the stats row on the same code. It is
// called whenever a peer code appears or a peer leaves, so the two can never
// disagree.
function updateSealedBadge() {
  const badge = $('sealed-badge');
  if (!badge) return;
  if (!state.sealed) {
    badge.hidden = true;
    badge.textContent = '';
    badge.removeAttribute('title');
    return;
  }
  badge.hidden = false;
  if (sealedCodesDiffer()) {
    badge.textContent = 'pq-e2e codes differ';
    badge.title = 'the peers derived different codes, so do not trust this call';
    return;
  }
  const code = sealedRoomCode();
  badge.textContent = code ? 'pq-e2e ' + verifyText(code) + ' ' + code : 'pq-e2e handshaking';
  badge.title = code ? verifyNames(code) + ' (' + code + ')' : 'no peer code yet';
}async function sealedOnOffer(peer, sdp) {
  if (state.leaving) return;
  // Wait for our transform keys so the first frames decrypt without a gap.
  if (peer.keyPromise) {
    try {
      await peer.keyPromise;
    } catch {
      // A key import that failed is reported by the worker; answer anyway so
      // the link itself can still come up.
    }
  }
  const target = connectPeer(peer.id, null, false);
  await onDescription(target, 'offer', sdp);
}

// noteModeClash shows one line about a mode clash, and only one per call, so a
// room with several guests of the other mode does not repeat it.
function noteModeClash(text) {
  if (state.modeClash) return;
  state.modeClash = true;
  say(text);
}

// plainModeClash reads the mode the guests had before this join. Sealed peers
// seal every frame and every name, so a plain client can not reach them. A room
// where all guests seal can never work for this client: it goes back to the
// form with the box already on. In a mixed room the plain guests still hear
// each other, so the call stays and one line says what is out of reach.
function plainModeClash(peers) {
  if (state.sealed || peers.length === 0) return false;
  const sealed = peers.filter((peer) => !!peer.sealed);
  if (sealed.length === 0) return false;
  if (sealed.length === peers.length) {
    $('sealed').checked = true;
    leave('this room is sealed end to end; tick the post-quantum box and join again');
    return true;
  }
  noteModeClash('a guest is in a sealed room, so you can not see or hear that guest');
  return false;
}

// sealedModeClash is the other side of the same check: a sealed client that
// walks into a room with no sealed guest has nothing to seal to, so it goes
// back to the form with the box off. A mixed room keeps only the sealed peers.
function sealedModeClash(peers) {
  if (!state.sealed || peers.length === 0) return false;
  const sealed = peers.filter((peer) => !!peer.sealed);
  if (sealed.length === peers.length) return false;
  if (sealed.length === 0) {
    $('sealed').checked = false;
    leave('this room is not sealed; untick the post-quantum box and join again');
    return true;
  }
  noteModeClash('a guest is in a plain room, so this call can not be sealed with that guest');
  return false;
}

function handleSealed(msg) {
  switch (msg.t) {
    case 'joined': {
      state.self = msg.self;
      state.ice = msg.ice || [];
      state.modeClash = false;
      say('');
      setAdmins(msg.admins);
      const infos = msg.peers || [];
      if (sealedModeClash(infos)) break;
      for (const info of infos) {
        if (!info.sealed) continue;
        const peer = ensurePeer(info.id, '', info.mic, info.cam);
        sealedSendPub(peer);
      }
      markAdmins();
      $('link-text').textContent = 'sealed, handshaking';
      // Tell the room the microphone and camera state; only the flags travel.
      sendState();
      updateCount();
      break;
    }
    case 'peer-joined': {
      if (!msg.peer) break;
      if (!msg.peer.sealed) {
        noteModeClash('a guest joined in a plain room, so this call can not be sealed with that guest');
        break;
      }
      const peer = ensurePeer(msg.peer.id, '', msg.peer.mic, msg.peer.cam);
      if (msg.peer.admin) state.admins.add(msg.peer.id);
      markAdmins();
      sealedSendPub(peer);
      playSfx('pop');
      break;
    }
    case 'peer-left': {
      dropPeer(msg.from);
      state.admins.delete(msg.from);
      markAdmins();
      playSfx('bonk');
      break;
    }
    case 'admin': {
      setAdmins(msg.admins);
      markAdmins();
      break;
    }
    case 'enc': {
      if (msg.from && typeof msg.b === 'string') sealedHandleOpaque(msg.from, msg.b);
      break;
    }
    case 'offer': {
      // A plain guest never gets a peer here, so its description has nothing
      // to answer: the mode line already said why.
      const peer = state.peers.get(msg.from);
      if (!peer) break;
      if (msg.sdp) sealedOnOffer(peer, msg.sdp);
      break;
    }
    case 'answer': {
      const peer = state.peers.get(msg.from);
      if (peer && msg.sdp) onDescription(peer, 'answer', msg.sdp);
      break;
    }
    case 'ice': {
      const peer = state.peers.get(msg.from);
      if (peer && msg.candidate) onCandidate(peer, msg.candidate);
      break;
    }
    case 'state': {
      const peer = state.peers.get(msg.from);
      if (peer) {
        if (msg.mic !== undefined) peer.mic = msg.mic;
        if (msg.cam !== undefined) peer.cam = msg.cam;
        applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
      }
      break;
    }
    case 'chat': {
      // A sealed room has no plaintext chat path; the server line is ignored.
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------- sealed stats

function sealedPairCount(id) {
  const label = pairLabel(id);
  let out = 0;
  let inn = 0;
  let refused = 0;
  for (const st of Object.values(state.frames)) {
    if (!st || st.pair !== label) continue;
    if (st.dir === 'send') out += st.ok || 0;
    else if (st.dir === 'recv') {
      inn += st.ok || 0;
      refused += st.fail || 0;
    }
  }
  return { out, inn, refused };
}

// sealedStatsRows is the sealed half of the one stats panel. It shows what the
// relay cannot see: the suite, the codes both ends share, the sealed frame
// counters and the wire audit that looks for a name or a chat line in every
// signaling frame. A red row is a real fault.
function sealedStatsRows() {
  const rows = [];
  const available = sealingAvailable();
  rows.push(statsRow('pq-e2e', [
    'suite pq-e2e v1 | X25519 + ML-KEM-768 | HKDF-SHA256 | AES-256-GCM',
    available
      ? 'media sealing available: every frame leaves through the worker'
      : 'media sealing NOT available in this browser: no media is sent',
  ], available));
  if (state.sealFault) rows.push(statsRow('sealing fault', [state.sealFault], false));

  const wt = state.wasmTest;
  if (wt) {
    const ok = !!(wt.sasMatch && wt.confirm && wt.open && wt.wrongKeyRefused);
    rows.push(statsRow('self test', [
      `${ok ? 'pass' : 'FAIL'} | sas ${wt.sasMatch ? 'match' : 'no'} | confirm ${wt.confirm ? 'ok' : 'no'} | open ${wt.open ? 'ok' : 'no'} | wrong key ${wt.wrongKeyRefused ? 'refused' : 'OPENED'} | code ${wt.sas || '-'}`,
    ], ok));
  }

  const code = sealedRoomCode();
  const codes = sealedRoomCodes();
  if (codes.size > 1) {
    rows.push(statsRow('room code', [
      'CODES DIFFER ' + [...codes].map((c) => verifyText(c) + ' ' + c).join(' vs '),
      'the peers did not derive the same key, so do not trust this call',
    ], false));
  } else {
    rows.push(statsRow('room code', [
      `${verifyText(code) || '-'}  ${code || 'pending'}`,
      verifyNames(code) || 'no peer code yet',
    ], code ? true : undefined));
  }

  for (const peer of state.peers.values()) {
    const c = sealedPairCount(peer.id);
    rows.push(statsRow('peer ' + shortPeer(peer.id), [
      `${peer.name || 'unnamed'} | ${verifyText(peer.sas) || 'code -'}`,
      `keys ${peer.keys ? 'yes' : 'no'} | link ${peer.pc ? peer.pc.connectionState : 'none'} | confirmed ${peer.confirmed ? 'yes' : 'no'}`,
      `sealed out ${c.out} in ${c.inn} | refused ${c.refused}`,
    ], peer.keys && peer.sas && peer.confirmed ? true : undefined));
  }

  let refused = 0;
  for (const st of Object.values(state.frames)) {
    if (st && st.dir === 'recv') refused += st.fail || 0;
  }
  rows.push(statsRow('sealed frames', [
    `out ${state.encryptFrames} | in ${state.decryptFrames} | refused ${refused} | worker errors ${state.workerErrors.length}`,
  ], refused === 0 && state.workerErrors.length === 0));
  rows.push(statsRow('wire audit', [
    `frames ${state.wireFrames} | canaries ${state.canaries.length} | plaintext leaks ${state.wireLeaks.length}`,
  ], state.wireLeaks.length === 0));
  rows.push(statsRow('sealed chat', [
    `out ${state.chatSent} | in ${state.chatRecv} | confirm failures ${state.confirmFailures}`,
  ], state.confirmFailures === 0));

  const ctx = state.playCtx;
  const play = ctx ? ctx.state : 'none';
  rows.push(statsRow('sound out', [
    `${play}${play === 'suspended' ? ' (tap the page once)' : ''} | videos muted`,
  ], play === 'running' ? true : undefined));

  if (state.wireLeaks.length) {
    rows.push(statsRow('leak', state.wireLeaks.map((w) => `${w.where}: ${w.canary}`), false));
  }
  if (state.workerErrors.length) {
    rows.push(statsRow('worker', state.workerErrors.slice(0, 5), false));
  }
  return rows;
}

// ---------------------------------------------------------------- lab proof

// runLab answers one question with the real code path: an encrypted video
// stream whose receiver starts with a wrong key. It must receive RTP but decode
// nothing, and decoding must start only after the right key is installed live.
// The browser test drives it through window.e2eApp; the UI never calls it.
async function runLab() {
  const worker = new Worker('/e2e-transform.js');
  const messages = [];
  worker.onmessage = (event) => messages.push(event.data);

  const key = b64e(crypto.getRandomValues(new Uint8Array(32)));
  const wrong = b64e(crypto.getRandomValues(new Uint8Array(32)));
  worker.postMessage({ type: 'keys', pair: 'lab', peer: 'lab', enc: key, dec: wrong });

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const paint = canvas.getContext('2d');
  let tick = 0;
  const draw = () => {
    tick++;
    paint.fillStyle = 'hsl(' + ((tick * 7) % 360) + ' 70% 40%)';
    paint.fillRect(0, 0, 320, 180);
    paint.fillStyle = '#fff';
    paint.font = '20px monospace';
    paint.fillText('pq frame ' + tick, 16, 40);
  };
  draw();
  const timer = setInterval(draw, 33);
  const videoStream = canvas.captureStream(30);

  const audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  osc.frequency.value = 440;
  const dest = audioCtx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const stream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

  const pc1 = new RTCPeerConnection({ iceServers: [] });
  const pc2 = new RTCPeerConnection({ iceServers: [] });
  const sink = new MediaStream();
  pc2.ontrack = (event) => sink.addTrack(event.track);
  // A sink element makes the receiver decode even without a visible tile.
  const labVideo = document.createElement('video');
  labVideo.muted = true;
  labVideo.autoplay = true;
  labVideo.playsInline = true;
  labVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
  labVideo.srcObject = sink;
  document.body.appendChild(labVideo);
  labVideo.play().catch(() => {});

  const gathered = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve(null);
      return;
    }
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve(null);
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(() => resolve(null), 4000);
  });

  for (const track of stream.getTracks()) {
    const sender = pc1.addTrack(track, stream);
    sender.transform = new RTCRtpScriptTransform(worker, { pair: 'lab', peer: 'lab', dir: 'send' });
  }

  await pc1.setLocalDescription();
  await gathered(pc1);
  await pc2.setRemoteDescription(pc1.localDescription);
  for (const receiver of pc2.getReceivers()) {
    receiver.transform = new RTCRtpScriptTransform(worker, { pair: 'lab', peer: 'lab', dir: 'recv' });
  }
  await pc2.setLocalDescription();
  await gathered(pc2);
  await pc1.setRemoteDescription(pc2.localDescription);

  const read = async () => {
    const out = { videoDecoded: 0, audioDecoded: 0, packets: 0, bytes: 0 };
    const report = await pc2.getStats();
    report.forEach((r) => {
      if (r.type !== 'inbound-rtp') return;
      out.packets += r.packetsReceived || 0;
      out.bytes += r.bytesReceived || 0;
      if (r.kind === 'video') out.videoDecoded += r.framesDecoded || 0;
      if (r.kind === 'audio') out.audioDecoded += r.framesDecoded || 0;
    });
    return out;
  };

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const before = await read();
  const early = messages.filter((m) => m.type === 'stats');

  worker.postMessage({ type: 'keys', pair: 'lab', peer: 'lab', dec: key });
  for (const receiver of pc2.getReceivers()) {
    const ask = /** @type {any} */ (receiver);
    if (ask.requestKeyFrame) ask.requestKeyFrame();
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const after = await read();
  const late = messages.filter((m) => m.type === 'stats');

  clearInterval(timer);
  osc.stop();
  audioCtx.close().catch(() => {});
  labVideo.remove();
  for (const t of stream.getTracks()) t.stop();
  pc1.close();
  pc2.close();
  worker.terminate();

  const sum = (list, dir) => list.filter((m) => m.dir === dir).reduce((n, m) => n + m.ok, 0);
  return {
    before,
    after,
    packetsArrived: before.packets > 0,
    decodedNothingWithoutKey: before.videoDecoded === 0 && before.audioDecoded === 0,
    decryptedAfterKey: after.videoDecoded > 0 || after.audioDecoded > 0,
    refusedFrames: early.reduce((n, m) => n + (m.fail || 0), 0),
    openedFrames: sum(late, 'recv'),
    samples: messages.filter((m) => m.type === 'sample').slice(0, 6),
    workerErrors: messages.filter((m) => m.type === 'error'),
  };
}

// window.e2eApp is the hook the browser test drives; a person never needs it.
// It exposes the same shape the old sealed page had, so a test can read the
// counters of a sealed call from the one client.
win().e2eApp = {
  get state() {
    return state;
  },
  peers: () => [...state.peers.values()].map((p) => ({
    id: p.id,
    name: p.name,
    sas: p.sas || '',
    confirmed: !!p.confirmed,
    ready: p.tile ? (p.tile.dataset.e2e || p.ready) : p.ready,
    pc: p.pc ? p.pc.connectionState : 'none',
    videoW: p.video ? p.video.videoWidth : 0,
    videoT: p.video ? p.video.currentTime : 0,
    video: p.video,
  })),
  counters: () => ({
    encryptFrames: state.encryptFrames,
    decryptFrames: state.decryptFrames,
    chatSent: state.chatSent,
    chatRecv: state.chatRecv,
    confirmFailures: state.confirmFailures,
    workerErrors: state.workerErrors,
    wireFrames: state.wireFrames,
    wireLeaks: state.wireLeaks,
    samples: state.samples,
  }),
  selfTest: pqSelfTest,
  lab: runLab,
};

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
  const last = load('room');
  if (fromHash) {
    $('room').value = fromHash;
  } else if (last && ROOM_RE.test(last)) {
    $('room').value = last;
  } else {
    suggestRoom();
  }
  const lastName = load('name');
  if (lastName) $('name').value = lastName;

  // The last microphone, camera, path and rnnoise choice comes back, like the
  // name. No stored value means on: the join asks for both by default. A
  // stored off is honoured, and that device is not asked for at all.
  state.prefMic = load('mic') !== '0';
  state.prefCam = load('cam') !== '0';
  state.mic = state.prefMic;
  state.cam = state.prefCam;
  const storedPath = load('path');
  if (['auto', 'p2p', 'relay'].includes(storedPath)) {
    state.path = storedPath;
    $('path').value = storedPath;
  }
  state.noiseWanted = load('noise') !== '0';
  $('noise').checked = state.noiseWanted;
  $('noise-live').checked = state.noiseWanted;

  // The sealed choice comes back like the name and the devices, and it is on
  // for a new visitor: post-quantum end-to-end encryption is the default. A
  // link wins over the stored choice, in both directions.
  const flag = sealedFlag();
  state.sealed = flag ? flag === '1' : load('sealed') !== '0';
  $('sealed').checked = state.sealed;

  $('sealed').addEventListener('change', () => {
    state.sealed = $('sealed').checked;
    store('sealed', state.sealed ? 1 : 0);
    if (state.sealed) preloadSealed();
    else {
      $('sealed-note').hidden = true;
      $('sealed-note').textContent = '';
    }
  });
  if (state.sealed) preloadSealed();

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

  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendChat();
  });

  $('noise-live').addEventListener('change', async () => {
    const on = $('noise-live').checked;
    state.noiseWanted = on;
    store('noise', on ? 1 : 0);
    $('noise').checked = on;
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

  $('path').addEventListener('change', () => {
    state.path = $('path').value;
    store('path', state.path);
  });

  $('stats-btn').addEventListener('click', () => setStatsOpen(!statsOpen()));
  $('stats-close').addEventListener('click', () => setStatsOpen(false));

  // A hidden tab has no one to read the numbers, so the polling sleeps until
  // it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopStats();
    else if (statsOpen()) startStats();
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
    // A sealed link carries the flag, so the guest lands on the same kind of
    // room instead of a plain one that can not read the keys.
    const link = state.sealed
      ? `${location.origin}/#r=${encodeURIComponent(state.room)}&sealed=1`
      : `${location.origin}/#r=${encodeURIComponent(state.room)}`;
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
