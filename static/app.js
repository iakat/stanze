'use strict';

// Small full mesh: every peer keeps one RTCPeerConnection per other peer.
// The server only relays SDP and ICE. Negotiation follows the "perfect
// negotiation" pattern so both sides can renegotiate without glare.
//
// Every room is sealed end to end. Names and chat stay inside opaque `enc`
// payloads and every encoded media frame goes through an AES-GCM transform in a
// worker, so the relay only ever forwards sealed blobs.
//
// Microphone audio always goes through one output track that is built here:
// mic -> GTCRN (optional) -> gain -> mixer destination. Sharing a screen
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
  camTrack: null,
  micTrack: null,
  outStream: null,    // what is sent to peers
  audioCtx: null,     // the microphone graph
  mixer: null,
  micGain: null,
  micSource: null,
  micAnalyser: null,  // tap on the microphone input, for the stats level
  meterPeak: 0,       // decaying peak, so one tick per second can see a word
  denoise: null,
  denoiseOn: false,
  playCtx: null,      // the remote audio graph, so a peer can go over 100%
  screen: null,       // display stream while sharing
  screenSource: null,
  mic: false,         // live in this call, and the stored choice
  cam: false,
  camId: '',          // deviceId of the chosen camera, '' = the system device
  micId: '',          // the same for the microphone
  devCams: [],        // last enumerateDevices() video inputs
  devMics: [],        // last enumerateDevices() audio inputs
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
  statHist: [],       // one sample a second, for the graph in the stats panel
  callStart: 0,       // ms at the join, for the header timer
  callTimer: null,
  sfxCtx: null,
  sfxSource: null,
  lostSource: null,   // the loop that plays while the socket is down
  lostGain: null,
  lostWanted: false,
  speakTimer: null,   // the green light on each tile while a person talks
  ownSpoke: null,
  spotlight: '',       // peer id or 'self' while one guest holds the large area

  // Sealed room state, live for the whole call: the worker, the identity and
  // the frame counters belong to one join and die with it.
  wasmOk: false,       // /pq.wasm loaded and the self test passed once
  wasmTest: null,      // the result of that self test, for the stats panel
  identity: null,      // our per-call key bundle, wiped in leave
  idKey: null,         // our long-term Ed25519 identity, kept by the browser
  device: '',          // kept, fresh (a reset record) or session (nothing kept)
  sid: '',             // session id of this call, public, never a secret
  pins: new Map(),     // local label -> {label, fp, first, last}
  revoked: new Map(),  // fingerprint -> {fp, label, at}, a pin that was replaced
  identityFailures: 0, // a peer that sent no identity or could not prove one
  worker: null,        // /e2e-transform.js, one per sealed call
  keyWait: new Map(),  // pair -> {gen, resolve}, waiting for the worker to import keys
  keyGen: 0,           // one rising number for every key agreement on the page
  frames: {},          // pair|dir|kind -> last counter message of the worker
  encryptFrames: 0,
  decryptFrames: 0,
  chatSent: 0,
  chatRecv: 0,
  replayDrops: 0,      // a sealed chat or name frame out of order or replayed
  fileOffers: 0,       // file offers this guest sent
  fileRecv: 0,         // file offers this guest received and saved
  fileChunksSent: 0,   // sealed chunks that went over a data channel
  fileChunksRecv: 0,
  fileRefused: 0,
  fileCancelled: 0,
  files: new Map(),    // transfer id -> offer this guest sent
  filesIn: new Map(),  // peer id and transfer id -> offer this guest received
  fileLinks: new Set(), // blob urls handed to the guest, revoked on leave
  confirmFailures: 0,
  workerErrors: [],    // a red row in the stats panel, never ignored
  sealFault: '',       // why this browser can not seal media, if it can not
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
 *   'sealed-note': HTMLElement,
 *   'lobby-error': HTMLElement, stage: HTMLElement, 'room-label': HTMLElement,
 *   'peer-count': HTMLElement, 'copy-btn': HTMLButtonElement, 'link-dot': HTMLElement,
 *   'link-text': HTMLElement, grid: HTMLElement,
 *   'stage-main': HTMLElement, 'stage-rail': HTMLElement,
 *   'pin-count': HTMLElement,
 *   'stats-panel': HTMLElement, 'stats-graph-box': HTMLElement,
 *   'stats-graph-down': HTMLCanvasElement, 'stats-graph-rtt': HTMLCanvasElement,
 *   'stats-graph-loss': HTMLCanvasElement, 'stats-note-down': HTMLElement,
 *   'stats-note-rtt': HTMLElement, 'stats-note-loss': HTMLElement,
 *   'stats-sum': HTMLElement, 'stats-body': HTMLElement, 'chat-log': HTMLElement, 'chat-form': HTMLFormElement,
 *   'chat-text': HTMLInputElement, 'chat-note': HTMLElement, 'mic-btn': HTMLButtonElement,
 *   'chat-panel': HTMLElement, 'file-btn': HTMLButtonElement, 'file-input': HTMLInputElement,
 *   'cam-btn': HTMLButtonElement, 'share-btn': HTMLButtonElement,
 *   'stats-btn': HTMLButtonElement, 'stats-close': HTMLButtonElement,
 *   'leave-btn': HTMLButtonElement, 'call-timer': HTMLElement,
 *   quality: HTMLSelectElement, mirror: HTMLInputElement,
 *   'noise-live': HTMLInputElement, 'stage-error': HTMLElement,
 *   'cam-select': HTMLSelectElement, 'mic-select': HTMLSelectElement,
 *   'cam-live': HTMLSelectElement, 'mic-live': HTMLSelectElement,
 *   'cam-pick': HTMLElement, 'mic-pick': HTMLElement,
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
  '640x360@30': { w: 640, h: 360, fps: 30, max: 400000 },
  '1280x720@30': { w: 1280, h: 720, fps: 30, max: 1500000 },
  '1920x1080@30': { w: 1920, h: 1080, fps: 30, max: 3000000 },
  '1920x1080@60': { w: 1920, h: 1080, fps: 60, max: 5000000 },
  '2560x1440@30': { w: 2560, h: 1440, fps: 30, max: 6000000 },
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
// microphone and camera choice, the media path, denoise, and the volume of
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

// setHash keeps the room in the fragment, so it never reaches the server.
function setHash(room) {
  history.replaceState(null, '', room ? `#r=${encodeURIComponent(room)}` : location.pathname);
}

function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws';
}

function send(msg) {
  const raw = JSON.stringify(msg);
  // The audit sees every frame the relay sees, in both directions. It is the
  // client half of the proof that a room never sends a name or a chat line in
  // the clear.
  auditWire('out', raw);
  // Every frame follows the join frame of an open socket; one that meets a
  // closed socket names a peer that the close already dropped.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(raw);
}

// ---------------------------------------------------------------- tiles

// paintName keeps the small tag and the large centre label in step. The centre
// label carries the whole name, so a guest without a camera is not a pair of
// letters.
function paintName(tile, name, local) {
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = name || '?';
}

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
    <div class="tag"><span class="name"></span><span class="flags"></span><span class="state"></span>${local ? '' : '<span class="pin" hidden></span>'}</div>
    ${local ? '' : '<div class="sas" hidden></div><button class="dots" type="button" aria-label="host actions">&#8943;</button><div class="menu" hidden></div>'}`;
  paintName(tile, name, local);
  // A remote guest is heard through its own gain node, so the video element
  // only ever carries pictures and stays muted.
  if (!local) tile.querySelector('video').muted = true;
  if (!local) wireDots(tile);
  $('stage-main').appendChild(tile);
  return tile;
}

// ---------------------------------------------------------------- stage layout

// stageTiles is every tile in a stable order: the own preview first, then the
// guests in the order they joined. The order of the two zones follows it, so a
// relayout never reshuffles the room.
function stageTiles() {
  const out = [];
  const self = document.querySelector('.tile[data-local="yes"]');
  if (self) out.push(self);
  for (const peer of state.peers.values()) if (peer.tile) out.push(peer.tile);
  return out;
}

// tileHasPicture answers "does this tile show a moving picture now". A camera
// that is off, a track that the sender muted and a track that stopped all say
// no, and that guest belongs in the rail as a row.
function tileHasPicture(tile) {
  if (!tile || tile.classList.contains('camoff')) return false;
  const video = tile.querySelector('video');
  const stream = video && video.srcObject;
  if (!stream || typeof stream.getVideoTracks !== 'function') return false;
  return stream.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
}

// spotlightTile is the one tile that holds the large area while the spotlight
// is on. A guest that left takes the spotlight with it.
function spotlightTile() {
  if (!state.spotlight) return null;
  if (state.spotlight === 'self') return document.querySelector('.tile[data-local="yes"]');
  for (const peer of state.peers.values()) {
    if (peer.id === state.spotlight) return peer.tile;
  }
  return null;
}

// layoutStage moves the existing tiles between the large area and the rail. A
// tile keeps its node, so its video element keeps its stream and its sliders
// keep their listener. Without a spotlight, the tiles with a picture take the
// large area and the rest become compact rows.
function layoutStage() {
  const main = $('stage-main');
  const rail = $('stage-rail');
  if (!main || !rail) return;
  const spot = spotlightTile();
  if (state.spotlight && !spot) state.spotlight = '';
  for (const tile of stageTiles()) {
    const big = spot ? tile === spot : tileHasPicture(tile);
    const host = big ? main : rail;
    if (tile.parentElement !== host) host.appendChild(tile);
    tile.classList.toggle('spot', big && !!spot);
  }
  const alone = main.childElementCount === 1 ? 'yes' : 'no';
  if (main.dataset.alone !== alone) main.dataset.alone = alone;
  main.hidden = main.childElementCount === 0;
  rail.hidden = rail.childElementCount === 0;
}

// setSpotlight puts one guest alone in the large area, or ends the spotlight
// when that guest already holds it.
function setSpotlight(id) {
  state.spotlight = id && state.spotlight !== id ? id : '';
  layoutStage();
}

// ---------------------------------------------------------------- volume

// The volume of one participant is a percent from 0 (silent) to 200. It is
// kept under the key fingerprint of a peer that proved its key, never under a
// name, so a machine that several people use keeps no list of who was called.
// A peer without a proven key keeps its setting in memory for this call only.
const volCall = new Map();   // peer id -> percent, this call only

// purgeNamedVolume deletes the keys of older builds, which held the guest name
// in the key itself. A machine that ran one of them loses that list now.
function purgeNamedVolume() {
  if (!window.localStorage) return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('rooms.vol.') && !key.startsWith('rooms.vol.fp.')) localStorage.removeItem(key);
    }
  } catch { /* private mode */ }
}

// storedVolume reads the kept percent of one peer: from the disk under its
// fingerprint once that key is proven, and from memory before that.
function storedVolume(peer) {
  const raw = peer && peer.fp ? load(`vol.fp.${peer.fp}`) : '';
  const n = parseInt(raw || (peer ? volCall.get(peer.id) : ''), 10);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(200, n));
}

// saveVolume keeps the percent of one peer. A proven guest is remembered on
// the disk by fingerprint; a guest without a key lives for this call only.
function saveVolume(peer) {
  if (!peer) return;
  volCall.set(peer.id, peer.vol);
  if (peer.fp) store(`vol.fp.${peer.fp}`, peer.vol);
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
    saveVolume(peer);
  });
  paintVolume(peer);
}

// applyFlags shows the mute and camera state of one tile. A tile with neither
// flag shows nothing extra.
function applyFlags(tile, mic, cam, admin) {
  if (!tile) return;
  // A camera that is off must show the centre name again. The last frame of a
  // disabled track is black, so the tile can not stay in the playing state.
  tile.classList.toggle('camoff', cam === false);
  tile.dataset.mic = mic === false ? 'off' : 'on';
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
  // The camera flag decides the zone of this tile: a picture goes to the large
  // area, a row without one goes to the rail.
  layoutStage();
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
    applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
  }
  const self = document.querySelector('.tile[data-local="yes"]');
  applyFlags(self, state.mic, state.cam, mine);
}

function updateCount() {
  const total = state.peers.size + 1;
  const live = [...state.peers.values()].filter((p) => p.state === 'connected').length + 1;
  $('peer-count').textContent = total === 1 ? '1 peer' : `${live}/${total} peers`;
  updatePinCount();
}

// ---------------------------------------------------------------- call clock

// clockText renders a duration as h:mm:ss.
function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// startCallClock counts from the moment the call UI appears, so the header
// always shows how long the call has lasted.
function startCallClock() {
  stopCallClock();
  state.callStart = Date.now();
  $('call-timer').textContent = clockText(0);
  state.callTimer = setInterval(() => {
    if (!state.callStart) return;
    $('call-timer').textContent = clockText(Date.now() - state.callStart);
  }, 1000);
}

// stopCallClock ends the count and clears the field when the call ends.
function stopCallClock() {
  if (state.callTimer) clearInterval(state.callTimer);
  state.callTimer = null;
  state.callStart = 0;
  const el = $('call-timer');
  if (el) el.textContent = '';
}

// ---------------------------------------------------------------- media

const MIC_AUDIO = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };

// qualityNow is the chosen step, with its encoder ceiling, or the default for a
// value this build does not know (a stored string from an older page).
function qualityNow() {
  return QUALITY[state.quality] || QUALITY['1280x720@30'];
}

// camVideo builds the camera request for the chosen step. The join, every later
// camera switch and the screen share go through it.
function camVideo() {
  const q = qualityNow();
  return {
    width: { ideal: q.w, max: q.w },
    height: { ideal: q.h, max: q.h },
    frameRate: { ideal: q.fps, max: q.fps },
  };
}

// ask opens one getUserMedia request and never throws, so the join can always
// go on with whatever the browser gives.
async function ask(constraints) {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(constraints) };
  } catch (err) {
    return { err };
  }
}

// capVideoSender sets the encoder ceiling on one video sender. The parameters
// object comes back from the sender and is copied, because a sender refuses a
// reused one. A sender has no encodings until its description exists, so an
// empty list is skipped; the same call runs again when the pair connects.
async function capVideoSender(sender) {
  if (!sender || !sender.getParameters || !sender.setParameters) return true;
  let params;
  try {
    params = sender.getParameters();
  } catch {
    return true;
  }
  if (!params || !Array.isArray(params.encodings) || params.encodings.length === 0) return true;
  const max = qualityNow().max;
  const next = {
    ...params,
    encodings: params.encodings.map((enc) => ({ ...enc, maxBitrate: max })),
  };
  try {
    await sender.setParameters(next);
    return true;
  } catch {
    return false;
  }
}

// capCameraSenders caps every sender that carries the camera. A sender for the
// screen share is left alone, because the share keeps its own quality.
function capCameraSenders(pc) {
  if (!pc || !state.camTrack) return;
  for (const sender of pc.getSenders()) {
    if (sender.track !== state.camTrack) continue;
    capVideoSender(sender);
  }
}

// applyQuality pushes the chosen step into the live camera: the raw track gets
// the new size and frame rate, and every peer's encoder gets the matching
// ceiling. The screen share is not touched; it carries its own quality.
async function applyQuality() {
  let refused = false;
  const track = state.camTrack;
  if (track && track.readyState === 'live') {
    try {
      await track.applyConstraints(camVideo());
    } catch {
      refused = true;
    }
  }
  for (const peer of state.peers.values()) {
    if (!peer.pc) continue;
    for (const sender of peer.pc.getSenders()) {
      if (!sender.track || sender.track !== track) continue;
      if (!(await capVideoSender(sender))) refused = true;
    }
  }
  if (refused) say('the browser refused the new camera quality; the old one stays in effect');
}

// ---------------------------------------------------------------- devices
//
// The join form carries one picker per kind, and the toolbar keeps a second pair
// for a switch during a call. Every picker shows the same list and the choice
// lives in state.camId and state.micId, so no two pickers can disagree. The
// browser hides the labels and the ids until the page has permission once:
// before that the options are numbered, and a stored id stays in its picker as
// one extra entry, so a reload never loses the camera.

const DEVICE_NOUN = { video: 'camera', audio: 'microphone' };

function devicePickers(kind) {
  return kind === 'video' ? [$('cam-select'), $('cam-live')] : [$('mic-select'), $('mic-live')];
}

function deviceList(kind) {
  return kind === 'video' ? state.devCams : state.devMics;
}

function chosenDevice(kind) {
  return (kind === 'video' ? state.camId : state.micId) || '';
}

function setChosenDevice(kind, id) {
  if (kind === 'video') state.camId = id;
  else state.micId = id;
  store(kind === 'video' ? 'camId' : 'micId', id);
}

// paintDeviceSelect rewrites one picker in place. The wanted id keeps its place
// while the browser still lists it; a list without ids (no permission yet)
// keeps it as one extra entry; a list with labels that no longer has it drops
// it, so the next request asks for the system device.
function paintDeviceSelect(select, kind, list, wanted) {
  if (!select) return '';
  const noun = DEVICE_NOUN[kind];
  const seen = new Set();
  const frag = document.createDocumentFragment();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = `system ${noun}`;
  frag.appendChild(auto);
  let count = 0;
  for (const device of list) {
    if (!device.deviceId || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    count++;
    const opt = document.createElement('option');
    // A label needs permission once. Before that the picker counts the
    // devices, so a guest still sees that there is more than one.
    opt.textContent = device.label || `${noun} ${count}`;
    opt.value = device.deviceId;
    frag.appendChild(opt);
  }
  const complete = list.some((device) => !!device.label);
  let value = '';
  if (wanted && seen.has(wanted)) value = wanted;
  else if (wanted && !complete) {
    const opt = document.createElement('option');
    opt.value = wanted;
    opt.textContent = `${noun} (last used)`;
    frag.appendChild(opt);
    value = wanted;
  }
  select.replaceChildren(frag);
  select.value = value;
  return value;
}

// paintDevices fills every picker from the last enumeration, and a choice that
// the browser no longer offers is dropped with one line in the status box. The
// toolbar pickers only appear when a kind has more than one device to offer.
function paintDevices() {
  for (const kind of ['video', 'audio']) {
    const wanted = chosenDevice(kind);
    const list = deviceList(kind);
    let kept = '';
    for (const select of devicePickers(kind)) kept = paintDeviceSelect(select, kind, list, wanted);
    if (wanted && kept !== wanted) {
      setChosenDevice(kind, '');
      say(`the ${DEVICE_NOUN[kind]} you chose is gone; the system ${DEVICE_NOUN[kind]} will be used`);
    }
  }
  $('cam-pick').hidden = deviceList('video').filter((d) => d.deviceId).length < 2;
  $('mic-pick').hidden = deviceList('audio').filter((d) => d.deviceId).length < 2;
}

// refreshDevices re-reads the device list and repaints the pickers. It runs at
// boot, after every successful device request (the labels arrive with the first
// permission) and on every devicechange.
async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let all = [];
  try {
    all = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  state.devCams = all.filter((device) => device.kind === 'videoinput');
  state.devMics = all.filter((device) => device.kind === 'audioinput');
  paintDevices();
}

// constraintsFor builds one request: the chosen device when there is one, the
// plain ideal request when there is not. facingMode only rides along with a
// plain camera request, because a deviceId already names the exact lens.
function constraintsFor(kind, pick) {
  if (kind === 'video') {
    const base = camVideo();
    return pick ? { ...base, deviceId: { exact: pick } } : { ...base, facingMode: 'user' };
  }
  return pick ? { ...MIC_AUDIO, deviceId: { exact: pick } } : { ...MIC_AUDIO };
}

// askKind opens one kind of device. A stored id the browser can no longer honour
// (unplugged, or a profile without it) falls back to the plain request once, so
// a stale choice never blocks a join or a switch.
async function askKind(kind, pick) {
  const want = (id) => (kind === 'video' ? { video: constraintsFor('video', id) } : { audio: constraintsFor('audio', id) });
  const first = await ask(want(pick));
  if (first.stream || !pick) return first;
  if (!first.err || (first.err.name !== 'OverconstrainedError' && first.err.name !== 'NotFoundError')) return first;
  if (pick === chosenDevice(kind)) {
    setChosenDevice(kind, '');
    paintDevices();
    say(`the ${DEVICE_NOUN[kind]} you chose was not available; the system ${DEVICE_NOUN[kind]} will be used`);
  }
  return ask(want(''));
}

// switchDevice moves one live call to another device. The microphone feeds the
// mixer, and the mixer track is what the peers receive, so an audio switch
// touches no sender. The camera replaces the track on the video sender that is
// already there, so the peers see the new camera without a rejoin; only a call
// that started with no camera at all adds a sender.
async function switchDevice(kind, id) {
  if (!sealingAvailable()) {
    say('this browser cannot seal media frames, so the device stays off');
    return;
  }
  const got = await askKind(kind, id);
  const track = got.stream
    ? (kind === 'video' ? got.stream.getVideoTracks()[0] : got.stream.getAudioTracks()[0])
    : null;
  if (!track) {
    const refused = got.err && got.err.name === 'NotAllowedError';
    say(refused ? `the ${DEVICE_NOUN[kind]} was refused` : `that ${DEVICE_NOUN[kind]} is not available`);
    paintDevices();
    return;
  }
  if (kind === 'video') {
    const wasOn = state.cam;
    await adoptCam(track);
    // A switch never changes the on and off choice of the call.
    if (!wasOn) {
      track.enabled = false;
      if (!state.screen) paintSelfCam(false);
    }
  } else {
    await adoptMic(track);
  }
  refreshSelf();
  sendState();
  refreshDevices();
}

// onDevicePicked stores the choice and, in a call, moves the live device.
function onDevicePicked(kind, id) {
  setChosenDevice(kind, id || '');
  for (const select of devicePickers(kind)) {
    if (select && select.value !== (id || '')) select.value = id || '';
  }
  if (!state.room || state.leaving) return;
  switchDevice(kind, id || '').catch(() => {});
}

// onDeviceChange reacts to a camera or a microphone that came or went. A device
// that is still listed keeps its place; one that is gone leaves the picker and
// the status line says so. A live track that ended is let go, so the flags of
// the call stay true until a device is chosen again.
let devTimer = null;

function onDeviceChange() {
  if (state.camTrack && state.camTrack.readyState === 'ended') {
    state.camTrack = null;
    if (state.cam) {
      state.cam = false;
      if (!state.screen) paintSelfCam(false);
      refreshSelf();
      sendState();
    }
  }
  if (state.micTrack && state.micTrack.readyState === 'ended') {
    state.micTrack = null;
    if (state.mic) {
      state.mic = false;
      refreshSelf();
      sendState();
    }
  }
  // Chrome fires several events for one plug, so the list is read once.
  if (devTimer) clearTimeout(devTimer);
  devTimer = setTimeout(() => { devTimer = null; refreshDevices(); }, 250);
}

// requestLocal asks for the camera and the microphone when the join button is
// pressed: one prompt when both are wanted, and the call starts with both on.
// A refusal or a missing device never stops the join; the devices that did not
// open stay off and a short status line says which ones.
async function requestLocal() {
  const wantMic = state.mic;
  const wantCam = state.cam;
  state.mic = false;
  state.cam = false;
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
    const both = await ask({
      audio: constraintsFor('audio', state.micId),
      video: constraintsFor('video', state.camId),
    });
    if (both.stream) {
      await adoptMic(both.stream.getAudioTracks()[0]);
      await adoptCam(both.stream.getVideoTracks()[0]);
    } else if (both.err && (both.err.name === 'NotAllowedError' || both.err.name === 'SecurityError')) {
      // The visitor answered the prompt with no. Asking twice would not prompt.
      refused.push('camera and microphone');
    } else {
      // One of the two may be missing or busy: ask for each of them alone, so
      // the other one still starts. A stored device that is gone falls back to
      // the system device here.
      const parts = await Promise.all([askKind('audio', state.micId), askKind('video', state.camId)]);
      const mic = parts[0].stream ? parts[0].stream.getAudioTracks()[0] : null;
      const cam = parts[1].stream ? parts[1].stream.getVideoTracks()[0] : null;
      await adoptMic(mic);
      await adoptCam(cam);
      if (!mic) noteErr(parts[0].err, 'microphone');
      if (!cam) noteErr(parts[1].err, 'camera');
    }
  } else if (wantMic) {
    const mic = await askKind('audio', state.micId);
    const track = mic.stream ? mic.stream.getAudioTracks()[0] : null;
    await adoptMic(track);
    if (!track) noteErr(mic.err, 'microphone');
  } else {
    const cam = await askKind('video', state.camId);
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
  // The first permission is what turns the placeholders into real labels.
  refreshDevices();
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

// sealOne puts the frame transform on one sender or receiver. This is the only
// install path: it runs once, on a transceiver that already exists, and nothing
// in it waits for the keys. A setter that throws becomes a stated fault.
function sealOne(peer, side, dir, kind) {
  try {
    side.transform = new RTCRtpScriptTransform(state.worker, {
      // `from` is the sender of the frames this transform sees: this page on a
      // sender, the peer on a receiver. The associated data names it, so both
      // ends build the same bytes and a frame can not be moved or reflected.
      pair: pairLabel(peer.id), peer: peer.id, dir, kind,
      from: dir === 'send' ? state.self : peer.id,
    });
  } catch (err) {
    state.workerErrors.push(dir + ' transform: ' + err);
    state.sealFault = 'this browser refused the frame transform, so no media is sent';
    say(state.sealFault);
    return false;
  }
  return true;
}

// preparePeer makes one transceiver per kind, seals both directions of it and
// puts the live track on its sender. It runs before the offer or the answer
// leaves, so the first frame always meets a key, a transform and a track.
function preparePeer(peer) {
  if (peer.tx) return;
  peer.tx = {};
  peer.sealed = true;
  for (const kind of ['audio', 'video']) {
    let tr = peer.pc.getTransceivers().find((t) => !t.stopped && t.receiver.track.kind === kind);
    if (!tr) tr = peer.pc.addTransceiver(kind, { direction: 'sendrecv' });
    // A transceiver from the remote offer is recvonly until this side says so.
    tr.direction = 'sendrecv';
    peer.tx[kind] = tr;
    const send = sealOne(peer, tr.sender, 'send', kind);
    const recv = sealOne(peer, tr.receiver, 'recv', kind);
    // no transform, no track: a clear frame is worse than a missing one
    if (!send || !recv) {
      peer.sealed = false;
      continue;
    }
    const track = state.outStream && state.outStream.getTracks().find((t) => t.kind === kind);
    if (!track) continue;
    tr.sender.replaceTrack(track).catch(() => {});
    if (kind === 'video') capVideoSender(tr.sender);
  }
}

// attachTrack points the sender of that kind at a track. The transceiver and
// its transform already exist, so a track can come and go without a second
// install path and without a renegotiation.
function attachTrack(peer, track) {
  if (peer.sealed === false) return;
  const tr = peer.tx && peer.tx[track.kind];
  if (!tr) return;
  tr.sender.replaceTrack(track).catch(() => {});
  if (track.kind === 'video') capVideoSender(tr.sender);
}

// publishTrack hands one new track to every connection that already has its
// transceivers. A connection that is still handshaking picks it up in
// preparePeer.
function publishTrack(track) {
  if (!track) return;
  for (const peer of state.peers.values()) {
    if (peer.pc) attachTrack(peer, track);
  }
}

// adoptMic makes one microphone track the live input: it goes through GTCRN
// and the gain into the mixer, and the mixer track is what peers receive. A
// second device needs a new source, because a source can not be repointed; the
// analyser is rebuilt with it and the noise choice of the call is kept.
async function adoptMic(track) {
  if (!track) return;
  const prev = state.micTrack;
  state.micTrack = track;
  track.enabled = true;
  if (!state.audioCtx) await buildAudio();
  if (state.audioCtx) {
    if (!state.micSource) {
      state.micSource = state.audioCtx.createMediaStreamSource(new MediaStream([track]));
      await setNoise(state.noiseWanted);
    } else if (prev && prev !== track) {
      try { state.micSource.disconnect(); } catch { /* not connected */ }
      if (state.micAnalyser) {
        try { state.micAnalyser.disconnect(); } catch { /* not connected */ }
        state.micAnalyser = null;
      }
      state.micSource = state.audioCtx.createMediaStreamSource(new MediaStream([track]));
      await setNoise(state.denoiseOn);
    }
  }
  startMeter();
  const out = state.mixer && state.mixer.stream.getAudioTracks()[0];
  if (out && state.outStream && !state.outStream.getAudioTracks().includes(out)) {
    state.outStream.addTrack(out);
  }
  publishTrack(out);
  if (prev && prev !== track) {
    try { prev.stop(); } catch { /* already stopped */ }
  }
}

// paintSelfCam paints the local preview from the camera state. A disabled
// track gives black frames, so the element is emptied and the tile leaves the
// playing state: the centre name is back until the camera works again.
function paintSelfCam(on) {
  const self = document.querySelector('.tile[data-local="yes"]');
  if (!self) return;
  const video = self.querySelector('video');
  if (on && state.camTrack) {
    const stream = new MediaStream([state.camTrack]);
    if (video.srcObject !== stream) video.srcObject = stream;
    self.classList.add('playing');
    video.play().catch(() => {});
  } else {
    self.classList.remove('playing');
    try { video.pause(); } catch { /* not playing */ }
    video.srcObject = null;
  }
  layoutStage();
}

// adoptCam makes one camera track the live video. While a screen is shared the
// screen stays what peers receive, so only the camera and the preview change. A
// track that replaces an earlier camera is handed to the video sender that is
// already there, so a switch needs no renegotiation.
async function adoptCam(track) {
  if (!track) return;
  const prev = state.camTrack;
  state.camTrack = track;
  track.contentHint = 'motion';
  track.enabled = true;
  if (!state.screen) paintSelfCam(true);
  if (!state.screen && state.outStream) {
    for (const old of state.outStream.getVideoTracks()) {
      if (old !== track) state.outStream.removeTrack(old);
    }
    if (!state.outStream.getVideoTracks().includes(track)) state.outStream.addTrack(track);
    publishTrack(track);
  }
  if (prev && prev !== track) {
    try { prev.stop(); } catch { /* already stopped */ }
  }
  applyMirror();
}

async function enableMic() {
  if (!sealingAvailable()) {
    // No transform, no frame: the microphone stays off and says why.
    say('this browser cannot seal media frames, so the microphone stays off');
    return;
  }
  if (!state.micTrack) {
    const mic = await askKind('audio', state.micId);
    const track = mic.stream ? mic.stream.getAudioTracks()[0] : null;
    if (!track) {
      say(mic.err && mic.err.name === 'NotAllowedError'
        ? 'the microphone was refused'
        : 'the microphone is not available');
      return;
    }
    await adoptMic(track);
    refreshDevices();
  }
  state.mic = true;
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
  store('mic', 0);
  if (state.micGain) state.micGain.gain.value = 0;
  updateButtons();
  sendState();
}

async function enableCam() {
  if (!sealingAvailable()) {
    say('this browser cannot seal media frames, so the camera stays off');
    return;
  }
  if (!state.camTrack) {
    const cam = await askKind('video', state.camId);
    const track = cam.stream ? cam.stream.getVideoTracks()[0] : null;
    if (!track) {
      say(cam.err && cam.err.name === 'NotAllowedError'
        ? 'the camera was refused'
        : 'the camera is not available');
      return;
    }
    await adoptCam(track);
    refreshDevices();
  }
  state.cam = true;
  store('cam', 1);
  if (state.camTrack) state.camTrack.enabled = true;
  if (!state.screen) paintSelfCam(true);
  updateButtons();
  sendState();
}

function disableCam() {
  state.cam = false;
  store('cam', 0);
  // A disabled track keeps the device open, so the camera light stays on. Stop
  // the track and drop it: enableCam asks the device again, and the video
  // sender that still holds the old track gets the new one in adoptCam.
  const track = state.camTrack;
  state.camTrack = null;
  if (track) {
    try { track.stop(); } catch { /* already stopped */ }
  }
  if (!state.screen) paintSelfCam(false);
  updateButtons();
  sendState();
}

// buildAudio wires mic -> (GTCRN) -> gain -> mixer. The mixer track is what
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

// startMeter taps the microphone before the gain, on a second branch of the
// source, so the stats show a live device even while the local mute is on. It
// does not touch the path to the peers: speakTick reads that tap.
function startMeter() {
  if (!state.audioCtx || !state.micSource || state.micAnalyser) return;
  state.micAnalyser = state.audioCtx.createAnalyser();
  state.micAnalyser.fftSize = 1024;
  state.micSource.connect(state.micAnalyser);
}

// ------------------------------------------------------------- talking light
//
// Every audio source has a small RMS tap, and a green light marks the tile of
// the person who speaks. The tap sits before the per peer gain, so a guest
// turned down to zero still lights up. A short hold keeps the light steady
// between syllables instead of blinking.

const SPEAK_MS = 100;
const SPEAK_ON = 0.03;
const SPEAK_HOLD_MS = 400;

const speakBufs = new WeakMap();

function analyserLevel(a) {
  if (!a) return 0;
  let buf = speakBufs.get(a);
  if (!buf || buf.length !== a.fftSize) {
    buf = new Float32Array(a.fftSize);
    speakBufs.set(a, buf);
  }
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// paintSpeaking turns the light on for a level over the threshold and keeps it
// on for the hold. The last time is kept in the given object.
function paintSpeaking(tile, level, hold) {
  if (!tile) return;
  const now = performance.now();
  if (level >= SPEAK_ON) hold.last = now;
  tile.classList.toggle('speaking', now - (hold.last || 0) < SPEAK_HOLD_MS);
}

function speakTick() {
  const own = document.querySelector('.tile[data-local="yes"]');
  // One read of the microphone tap feeds the talking light and the stats row.
  // The peak falls slowly, so one stats tick can still see a word.
  const level = analyserLevel(state.micAnalyser);
  state.meterPeak = Math.max(level, state.meterPeak * 0.9);
  if (own && state.ownSpoke) {
    // A muted microphone sends silence, so the guest is not shown as talking.
    paintSpeaking(own, state.mic ? level : 0, state.ownSpoke);
  }
  for (const peer of state.peers.values()) {
    // One read per tick feeds the light and the stats line. The light follows
    // the microphone flag, but the level is measured either way, so a stats row
    // still shows what arrives from a peer that reports a muted microphone.
    const level = analyserLevel(peer.meter);
    peer.meterPeak = Math.max(level, (peer.meterPeak || 0) * 0.9);
    if (!peer.tile) continue;
    if (!peer.spoke) peer.spoke = { last: 0 };
    paintSpeaking(peer.tile, peer.mic ? level : 0, peer.spoke);
  }
}

function startSpeaking() {
  if (state.speakTimer) return;
  state.ownSpoke = { last: 0 };
  state.speakTimer = setInterval(speakTick, SPEAK_MS);
}

function stopSpeaking() {
  if (state.speakTimer) clearInterval(state.speakTimer);
  state.speakTimer = null;
  state.ownSpoke = null;
}

// levelText renders one RMS peak as a percent between -60 dB and full scale,
// with the dB value beside it, because that is what a phone's meter shows.
function levelText(peak) {
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  const pct = db > -60 ? Math.round(((db + 60) / 60) * 100) : 0;
  return db > -90 ? `${pct}% ${Math.round(db)} dB` : '0% silent';
}

// micLevelCells splits the own input into the four columns of the microphone
// row: the level in decibels, the share of the scale it fills, and the state
// word. A peak under -60 dB is below anything a person hears, so it reads as
// silent rather than as a number.
function micLevelCells(peak) {
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  if (!(db > -60)) return { db: '0 dB', pct: '0 %', state: 'silent' };
  return {
    db: `${Math.round(db)} dB`,
    pct: `${Math.round(((db + 60) / 60) * 100)} %`,
    state: 'transmitting',
  };
}

// micLevelLine reports the local input. A value near zero with a live track
// points at the graph, not at the device.
function micLevelLine() {
  if (!state.micAnalyser) return 'level none';
  return `level ${levelText(state.meterPeak)}`;
}

// inLevelLine reports what arrives from one peer, read at its source node
// before the gain. A silent line beside a live inbound rate points at the
// decode or the graph, not at the network; a live line with no sound points
// after the gain. It returns the level alone, so the caller names the line.
function inLevelLine(peer) {
  if (!peer.audioSrc || !peer.meter) return '';
  return levelText(peer.meterPeak || 0);
}

// setNoise switches the microphone between the raw path and the GTCRN path.
// The output of the mixer does not change, so no peer is disturbed.
async function setNoise(on) {
  if (!state.micSource || !state.audioCtx) {
    state.denoiseOn = false;
    return false;
  }
  if (on && !state.denoise) {
    try {
      // The worklet module gets the wasm bytes from the page: a worklet can
      // only build a module from bytes it already holds, so the binary comes
      // over the wire as a file and travels in processorOptions.
      const [binary] = await Promise.all([
        fetch('/gtcrn.wasm').then((res) => {
          if (!res.ok) throw new Error('gtcrn.wasm ' + res.status);
          return res.arrayBuffer();
        }),
        state.audioCtx.audioWorklet.addModule('/gtcrn-node.js'),
      ]);
      state.denoise = new AudioWorkletNode(state.audioCtx, 'gtcrn', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { wasm: new Uint8Array(binary) },
      });
      state.denoise.connect(state.micGain);
    } catch (err) {
      console.warn('noise suppression unavailable', err);
      state.denoise = null;
      state.denoiseOn = false;
      return false;
    }
  }
  try { state.micSource.disconnect(); } catch { /* not connected */ }
  if (on) {
    state.micSource.connect(state.denoise);
    state.denoiseOn = true;
  } else {
    state.micSource.connect(state.micGain);
    state.denoiseOn = false;
  }
  return state.denoiseOn;
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
  // A silent element is the decode sink for the remote track. Chromium does not
  // always pull the decoder for a source node alone, and then every node reads
  // zeros while the packets arrive. A muted element adds no sound.
  const pump = new Audio();
  pump.muted = true;
  pump.volume = 0;
  pump.autoplay = true;
  pump.srcObject = new MediaStream([track]);
  pump.play().catch(() => {});
  peer.pump = pump;
  peer.gain = ctx.createGain();
  peer.gain.gain.value = peer.vol / 100;
  peer.audioSrc = ctx.createMediaStreamSource(new MediaStream([track]));
  peer.audioSrc.connect(peer.gain);
  peer.gain.connect(ctx.destination);
  // The talking light reads the source, before the gain, so a guest turned
  // down to zero still shows that they speak.
  peer.meter = ctx.createAnalyser();
  peer.meter.fftSize = 1024;
  peer.audioSrc.connect(peer.meter);
  resumePlayback();
  // A context that is still suspended after a resume attempt plays nothing.
  // Say it, because the video looks correct and only the sound is missing.
  if (ctx.state === 'suspended') say('the browser holds the audio output; tap the page once to hear the room');
}

// dropAudio unhooks one peer from the output, so a closed peer is silent and
// its nodes can be collected.
function dropAudio(peer) {
  if (!peer) return;
  if (peer.audioSrc) {
    try { peer.audioSrc.disconnect(); } catch { /* already gone */ }
    peer.audioSrc = null;
  }
  if (peer.meter) {
    try { peer.meter.disconnect(); } catch { /* already gone */ }
    peer.meter = null;
  }
  if (peer.gain) {
    try { peer.gain.disconnect(); } catch { /* already gone */ }
    peer.gain = null;
  }
  if (peer.pump) {
    try { peer.pump.pause(); } catch { /* already gone */ }
    peer.pump.srcObject = null;
    peer.pump = null;
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
  refreshSelf();
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
  $('noise-live').checked = state.micSource ? state.denoiseOn : state.noiseWanted;
}

function applyMirror() {
  const tile = document.querySelector('.tile[data-local="yes"]');
  if (!tile) return;
  const camera = !state.screen;
  tile.classList.toggle('mirrored', state.mirror && camera);
  tile.classList.toggle('screenshare', !!state.screen);
  const badge = tile.querySelector('.state');
  if (badge) badge.textContent = state.screen ? 'your screen' : 'you';
  layoutStage();
}

// ---------------------------------------------------------------- screen share

// replaceOutVideo swaps the track that is sent to every peer and keeps the
// local preview in sync. replaceTrack on the video transceiver avoids a
// renegotiation. The old camera track stays alive so the share can be stopped
// again.
async function replaceOutVideo(track) {
  if (!state.outStream) return;
  // A room never sends a clear frame: without the worker there is no transform,
  // so the screen track is not offered at all.
  if (track && (!sealingAvailable() || !state.worker)) {
    state.sealFault = 'this browser cannot seal media frames, so no screen is sent';
    say(state.sealFault);
    return;
  }
  for (const old of state.outStream.getVideoTracks()) {
    state.outStream.removeTrack(old);
  }
  if (track) state.outStream.addTrack(track);
  for (const peer of state.peers.values()) {
    const tr = peer.tx && peer.tx.video;
    if (tr) await tr.sender.replaceTrack(track || null).catch(() => {});
  }
}

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    say('screen sharing is not supported by this browser');
    return;
  }
  if (!sealingAvailable()) {
    say('this browser cannot seal media frames, so screen sharing stays off');
    return;
  }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: camVideo(), audio: true });
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

// iceServers drops the TURN servers on a direct only path. A relay only path
// needs no filter: the transport policy below already drops every other
// candidate.
function iceServers() {
  const all = state.ice || [];
  if (state.path !== 'p2p') return all;
  return all.filter((server) => !/^turns?:/i.test(String(server.urls)));
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

function ensurePeer(id, mic, cam) {
  let peer = state.peers.get(id);
  if (peer) {
    if (mic !== undefined || cam !== undefined) {
      peer.mic = mic === undefined ? peer.mic : mic;
      peer.cam = cam === undefined ? peer.cam : cam;
      applyFlags(peer.tile, peer.mic, peer.cam);
    }
    return peer;
  }
  // The name arrives sealed, later, so the short id keeps the tile readable
  // until then.
  const initial = String(id).slice(0, 6);
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
    meter: null,     // tap on the incoming audio, for the talking light
    meterPeak: 0,    // decaying peak of that tap, so one stats tick sees a word
    spoke: null,     // last time this peer was heard, for the hold

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
    gen: 0,           // bumps on every new key agreement on this pair
    ctlPending: [],   // hello/ok held until the pub and the keys are here
    seqOut: 0, // sealed chat/name frames sent on this pair
    seqIn: 0,  // the last one opened, inbound only grows
    dc: null,          // the file data channel of this pair
    dcPromise: null,   // resolves with that channel, or null when it never comes
    dcResolve: null,
    mySig: '',
    fp: '',            // fingerprint once the peer proved its identity
    pin: '',           // 'changed' when a label here holds another key
    pinLabel: '',      // the local label this guest is pinned under
    proven: false,
    desc: null,        // the description chain of this pair
    announcedName: '',
  };
  peer.vol = storedVolume(peer);
  peer.tile = makeTile(peer.name, peer.name);
  peer.video = peer.tile.querySelector('video');
  peer.tile.dataset.peer = id;
  applyFlags(peer.tile, peer.mic, peer.cam);
  wireVolume(peer);
  state.peers.set(id, peer);
  layoutStage();
  updateCount();
  return peer;
}

function connectPeer(id, initiator, mic, cam) {
  const peer = ensurePeer(id, mic, cam);
  if (peer.pc) {
    peer.initiator = peer.initiator || initiator;
    return peer;
  }
  peer.initiator = initiator;

  const pc = new RTCPeerConnection(rtcConfig());
  peer.pc = pc;

  // One ordered data channel per pair carries file bytes. Only the initiator
  // opens it and the answerer takes the channel that the offer brings, so both
  // sides hold the same one. The channel is peer to peer: no server sees it.
  peer.dc = null;
  peer.dcPromise = new Promise((resolve) => { peer.dcResolve = resolve; });
  pc.ondatachannel = (event) => {
    if (event.channel && event.channel.label === FILE_LABEL) fileBindChannel(peer, event.channel);
  };
  if (initiator) fileBindChannel(peer, pc.createDataChannel(FILE_LABEL, { ordered: true }));

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
    // A sender that stops its camera mutes the track here instead of ending
    // it, so both edges of the track move the guest between the zones.
    track.addEventListener('mute', () => layoutStage());
    track.addEventListener('unmute', () => layoutStage());
    track.addEventListener('ended', () => layoutStage());
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

function setPeerState(peer, text) {
  peer.state = text;
  // The badge on the tile names the key state, so the link state lives in the
  // data attribute only. The status line carries no guest count: the chip at
  // the far end of it counts the peers, so the two can never disagree.
  if (peer.tile) peer.tile.dataset.state = text;
  if ((text === 'failed' || text === 'closed') && peer.tile) peer.tile.classList.remove('playing');
  layoutStage();
  if (text === 'connected') $('link-text').textContent = '';
  else if (text === 'failed') $('link-text').textContent = 'link failed';
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

// onDescription queues one description per peer. Two offers, or an answer that
// races a rejoin, would interleave setRemoteDescription and
// setLocalDescription and leave the pair at "new"; the chain makes them run one
// after the other in arrival order.
function onDescription(peer, type, sdp) {
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
    // Perfect negotiation: the polite side rolls its offer back, so the remote
    // offer can be applied; without this the pair stays at "new".
    if (collision && peer.polite && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription({ type: 'rollback' });
    }
    peer.settingAnswer = type === 'answer';
    await pc.setRemoteDescription({ type, sdp });
    peer.settingAnswer = false;
    // The transceivers exist now, so this is where both directions get their
    // transform and their track. It happens before the answer leaves.
    preparePeer(peer);

    if (type === 'offer') {
      await pc.setLocalDescription();
      send({ t: 'answer', to: peer.id, sdp: pc.localDescription.sdp });
    }
    await flushPending(peer);
    // The description is in place, so the encodings exist; a camera cap set
    // before the negotiation can land now.
    capCameraSenders(pc);
  } catch (err) {
    peer.settingAnswer = false;
    // A description that the browser rejects leaves the pair at "new": no
    // media, no retry, and nothing on screen. Say it, and keep the detail.
    const why = err && err.message ? err.message : String(err);
    state.workerErrors.push('description failed for ' + shortPeer(peer.id) + ': ' + why);
    say('the ' + type + ' with ' + shortPeer(peer.id) + ' failed; the link has no media');
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

  dropAudio(peer);
  fileDropPeer(peer);
  if (peer.pc) peer.pc.close();
  if (peer.tile) peer.tile.remove();
  // The pair secrets go with the peer, zeroed: no later join can resume them.
  wipeKeys(peer);
  state.peers.delete(id);
  layoutStage();
  updatePinCount();
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
    // The join carries no name: the server announces every peer as its
    // placeholder, and the real name travels sealed once the keys exist.
    send({ t: 'join', room: state.room, pass: state.pass });
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
  // A host command, a kick and a terminal join error are answered first.
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
  switch (msg.t) {
    case 'joined': {
      state.self = msg.self;
      state.ice = msg.ice || [];
      say('');
      setAdmins(msg.admins);
      for (const info of msg.peers || []) {
        if (!info) continue;
        const peer = ensurePeer(info.id, info.mic, info.cam);
        sealedSendPub(peer);
      }
      markAdmins();
      $('link-text').textContent = 'handshaking';
      // Tell the room the microphone and camera state; only the flags travel.
      sendState();
      updateCount();
      break;
    }
    case 'peer-joined': {
      if (!msg.peer) break;
      const peer = ensurePeer(msg.peer.id, msg.peer.mic, msg.peer.cam);
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
    case 'state': {
      const peer = state.peers.get(msg.from);
      if (peer) {
        if (msg.mic !== undefined) peer.mic = msg.mic;
        if (msg.cam !== undefined) peer.cam = msg.cam;
        applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
      }
      break;
    }
    case 'enc': {
      if (msg.from && typeof msg.b === 'string') sealedHandleOpaque(msg.from, msg.b);
      break;
    }
    case 'offer': {
      // The peer exists already: the handshake opened its connection.
      const peer = state.peers.get(msg.from);
      if (peer && msg.sdp) sealedOnOffer(peer, msg.sdp);
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
  state.name = cleanSealedName($('name').value) || 'guest';
  state.path = $('path').value;
  state.quality = $('quality').value;
  state.noiseWanted = $('noise').checked;
  state.mirror = true;
  state.leaving = false;
  // The call starts with what the visitor chose last time.
  state.mic = load('mic') !== '0';
  state.cam = load('cam') !== '0';
  store('name', state.name);
  store('room', state.room);
  store('path', state.path);
  store('noise', state.noiseWanted ? 1 : 0);

  // The post-quantum module and the frame worker are ready before the stage
  // appears, so a browser that cannot seal stays in the lobby with a reason
  // instead of quietly opening an unsealed room.
  // The join click is the gesture the audio output needs.
  ensurePlayback();
  $('enter-btn').disabled = true;
  $('sealed-note').hidden = false;
  $('sealed-note').textContent = 'loading the post-quantum module';
  try {
    try {
      await ensureReady();
      $('sealed-note').textContent = 'pq-e2e ready, ' + deviceNote();
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      $('sealed-note').textContent = 'the sealed client did not start: ' + why;
      // No silent fallback: the lobby says what failed and the visitor decides.
      state.room = '';
      state.pass = '';
      say('cannot open a sealed room: ' + why);
      return;
    }

    startSealedWorker();
    const made = JSON.parse(pqModule().gen());
    // The secret halves stay Uint8Arrays, so leave can zero them.
    state.identity = { xpub: made.xpub, ek: made.ek, xsk: b64d(made.xsk), dk: b64d(made.dk) };
    state.sid = b64e(crypto.getRandomValues(new Uint8Array(16)));
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
    updatePinCount();
    $('link-text').textContent = 'connecting';
    setHash(room);
    startCallClock();
    startSpeaking();

    prepareLocal();
    if (sealingAvailable()) {
      // The join click asks for the camera and the microphone. The signaling
      // socket waits for the answer, so the first offer already carries the
      // tracks, and preparePeer seals and attaches both before the offer.
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
  // itself stays loaded, so the next sealed join needs no second download. The
  // per-call identity is wiped, not just dropped: the X25519 and ML-KEM secret
  // halves are zeroed in their buffers, and nothing on this page can resume a
  // call after it ended. The long-term key and the pins survive, by design.
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  wipeIdentity();
  state.sid = '';
  state.identityFailures = 0;
  state.keyWait.clear();
  state.frames = {};
  state.encryptFrames = 0;
  state.decryptFrames = 0;
  state.chatSent = 0;
  state.chatRecv = 0;
  state.replayDrops = 0;
  fileClearAll();
  state.confirmFailures = 0;
  state.workerErrors = [];
  state.sealFault = '';
  state.wireFrames = 0;
  state.wireLeaks = [];
  state.canaries = [];
  state.samples = [];
  updatePinCount();
  $('chat-note').hidden = true;
  $('link-text').textContent = '';
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
  state.denoise = null;
  state.denoiseOn = false;
  state.micAnalyser = null;
  state.meterPeak = 0;
  stopSpeaking();
  state.outStream = null;
  state.camTrack = null;
  state.micTrack = null;
  stopStats();
  clearStatsPanel();
  $('stats-panel').hidden = true;
  $('stats-btn').setAttribute('aria-pressed', 'false');
  state.spotlight = '';
  $('stage-main').replaceChildren();
  $('stage-rail').replaceChildren();
  $('stage-rail').hidden = true;
  stopCallClock();
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
  if (message) say(message);
}

// ---------------------------------------------------------------- chat

// The room log carries the sealed chat lines of this call. They never leave the
// browser in the clear, so there is no server history to replay.
const CHAT_MAX = 200;

function chatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function addChatLine(name, text, ts) {
  const log = $('chat-log');
  if (!log) return;
  const li = document.createElement('li');
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = chatTime(ts);
  li.appendChild(when);
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${name || 'guest'}:`;
  li.appendChild(who);
  li.appendChild(document.createTextNode(` ${text}`));
  log.appendChild(li);
  while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------ chat files
//
// A file offer is a chat line. The name, the size and the type travel as a
// sealed `app` frame on the same key and the same AAD shape as chat text, so
// the server relays an opaque blob and never reads a name or a size.
//
// The bytes never touch the signaling socket. They go over one ordered data
// channel per pair, one sealed frame per chunk, and stay in memory on both
// sides. The receiver assembles a Blob and shows a link that the guest clicks,
// so no file is written to disk without that click. Cancel clears the waits,
// the chunks and the link at once.

const FILE_LABEL = 'files';
// 16 KiB of plaintext seals to about 22 KiB with the 16 byte tag and base64.
// The SCTP floor for one message is 64 KiB, which every stack must accept, so
// a sealed chunk stays well under it on every browser, whatever it reports.
const FILE_CHUNK = 16 * 1024;
// The sender pauses when the channel holds this much and resumes when the low
// mark fires, so a large file never fills the send buffer of the call.
const FILE_BUFFER = 256 * 1024;
const FILE_LOW = 64 * 1024;
const FILE_OPEN_WAIT = 15000;

// A file name is shown in the chat only, but it comes from another page, so it
// is cleaned the same way as a sealed guest name.
function cleanFileName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 64);
}

function fileID() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fileBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  const units = ['kB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[i];
}

// fileRateText is the speed a guest reads beside a transfer. A rate is bytes
// over a window, so it starts empty on the first chunk and becomes a number
// once the window has run. kB/s is 1024 based, like fileBytes, and stays a
// whole number above ten so the line does not jitter in width.
function fileRateText(kbs) {
  if (!kbs || !isFinite(kbs) || kbs <= 0) return '';
  return (kbs >= 10 ? Math.round(kbs) : kbs.toFixed(1)) + ' kB/s';
}

// fileMarkRate keeps a short window per transfer, so the number is the rate
// now and not the average since the first byte. The first chunk only starts
// the window; until it is 500 ms old the line shows the average so far, so a
// fast transfer still reads a speed before it ends.
function fileMarkRate(o, bytes, now) {
  if (!o.rateT) {
    o.rateT = now;
    o.rateB = bytes;
    const secs = (now - (o.rateAt || now)) / 1000;
    o.rate = secs > .05 ? bytes / 1024 / secs : 0;
    return;
  }
  const dt = now - o.rateT;
  if (dt < 500) return;
  o.rate = (bytes - o.rateB) / 1024 / (dt / 1000);
  o.rateT = now;
  o.rateB = bytes;
}

// fileAverageRate is the one number kept after the transfer ends: the whole
// file over the whole time it took, so a finished line still says how fast it
// went.
function fileAverageRate(bytes, start, now) {
  if (!start || !bytes) return '';
  const secs = (now - start) / 1000;
  if (secs < .2) return '';
  return fileRateText(bytes / 1024 / secs);
}

function fileButton(label, fn) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => {
    button.disabled = true;
    fn(button);
  });
  return button;
}

// addFileRow draws one offer in the room log, in the same list and with the
// same time and speaker spans as a chat line. The progress bar is a span, not
// a native meter, so the old desktop look holds.
function addFileRow(who, name, size) {
  const log = $('chat-log');
  if (!log) return null;
  const li = document.createElement('li');
  li.className = 'chat-file';
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = chatTime();
  const speaker = document.createElement('span');
  speaker.className = 'who';
  speaker.textContent = (who || 'guest') + ':';
  const head = document.createElement('span');
  head.className = 'file-head';
  const label = document.createElement('span');
  label.className = 'file-name';
  label.textContent = name;
  label.title = name;
  const labelSize = document.createElement('span');
  labelSize.className = 'file-size';
  labelSize.textContent = fileBytes(size);
  head.append(label, labelSize);
  const bar = document.createElement('span');
  bar.className = 'file-bar';
  bar.hidden = true;
  const fill = document.createElement('span');
  fill.className = 'file-fill';
  bar.appendChild(fill);
  const status = document.createElement('span');
  status.className = 'file-status';
  const acts = document.createElement('span');
  acts.className = 'file-acts';
  li.append(when, speaker, head, bar, status, acts);
  log.appendChild(li);
  while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
  return { li, bar, fill, status, acts };
}

function fileSetBar(el, show, frac) {
  if (!el) return;
  el.bar.hidden = !show;
  el.fill.style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + '%';
}

// fileOffer announces one file to every sealed peer of the room. Each peer
// gets its own state, so one refusal never stops another transfer.
function fileOffer(file) {
  if (!file || !state.self || state.leaving) return;
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    say('that file cannot be read');
    return;
  }
  const name = cleanFileName(file.name) || 'file';
  const type = String(file.type || '').slice(0, 64);
  const x = fileID();
  const out = { x, file, name, size, type, peers: new Map(), cancelled: false, el: null };
  for (const peer of state.peers.values()) {
    if (!peer.keys) continue;
    out.peers.set(peer.id, { peer, status: 'offered', sent: 0, dead: false, wake: null });
    sealedSend(peer, { k: 'file', a: 'offer', x, n: name, z: size, m: type });
  }
  if (!out.peers.size) {
    addChatLine(state.name, 'no sealed peer for ' + name, Date.now());
    return;
  }
  canary(name);
  state.fileOffers++;
  state.files.set(x, out);
  out.el = addFileRow(state.name, name, size);
  if (out.el) out.el.acts.append(fileButton('cancel', () => fileCancelOut(out)));
  filePaintOut(out);
}

// fileOnMessage handles the sealed metadata of one offer. The bytes never
// arrive here; they only use the data channel.
function fileOnMessage(peer, msg) {
  switch (msg.a) {
    case 'offer':
      fileOnOffer(peer, msg);
      break;
    case 'accept':
      fileOnAccept(peer, msg);
      break;
    case 'refuse':
      fileOnRefuse(peer, msg);
      break;
    case 'cancel':
      fileOnCancel(peer, msg);
      break;
    case 'done':
      fileOnDone(peer, msg);
      break;
    default:
      break;
  }
}

function fileOnOffer(peer, msg) {
  const x = String(msg.x || '').slice(0, 32);
  const name = cleanFileName(msg.n);
  const size = Number(msg.z);
  const type = String(msg.m || '').slice(0, 64);
  if (!x || !name || !Number.isSafeInteger(size) || size < 0) return;
  const key = peer.id + '|' + x;
  if (state.filesIn.has(key)) return;
  const rec = {
    key, x, peerId: peer.id, name, size, type,
    status: 'offered', chunks: [], got: 0, expect: 0, el: null, url: '',
    rateT: 0, rateB: 0, rate: 0, rateAt: 0,
  };
  state.filesIn.set(key, rec);
  canary(name);
  rec.el = addFileRow(peer.name || shortPeer(peer.id), name, size);
  if (rec.el) {
    rec.el.acts.append(
      fileButton('accept', (button) => fileAccept(rec, button)),
      fileButton('refuse', () => fileRefuse(rec)),
    );
  }
  filePaintIn(rec);
}

// A big file should not sit in the tab twice. When the browser has the File
// System Access API the guest picks a place on disk at the accept click and
// every chunk is written as it arrives, so the page holds one chunk and not
// the whole file. A browser without it, or an accept the guest sends without
// the picker, keeps the in-memory path and its save link.
function fileDiskWanted() {
  const pick = /** @type {any} */ (window).showSaveFilePicker;
  return typeof pick === 'function' && !/** @type {any} */ (window).e2eNoPicker;
}

// fileDiskOpen asks for the place on disk. It returns true when a writer is
// ready, false when the page must keep the bytes in memory, and null when the
// guest closed the picker: then the offer stays untouched, as if accept was
// never pressed.
async function fileDiskOpen(rec) {
  if (!fileDiskWanted()) return false;
  let handle;
  try {
    handle = await /** @type {any} */ (window).showSaveFilePicker({ suggestedName: rec.name });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    return false;
  }
  try {
    rec.writer = await handle.createWritable();
    rec.disk = true;
    return true;
  } catch {
    return false;
  }
}

// fileDiskWrite queues one chunk on the writable. The queue keeps the byte
// order, and a slow disk applies its pressure to the queue instead of the page
// buffering the whole file. A failed write ends the transfer and removes the
// partial file.
function fileDiskWrite(rec, bytes) {
  const writer = rec.writer;
  if (!writer) return;
  rec.writes = (rec.writes || Promise.resolve()).then(() => writer.write(bytes)).catch(() => {
    fileDiskAbort(rec);
    const peer = state.peers.get(rec.peerId);
    if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
    fileFinishIn(rec, 'cancelled');
  });
}

// fileDiskAbort drops a partial file after a cancel. It waits for the writes
// that are already queued, so the abort can not land in the middle of one.
function fileDiskAbort(rec) {
  const writer = rec.writer;
  rec.writer = null;
  rec.chunks = [];
  if (!writer) return;
  const pending = rec.writes || Promise.resolve();
  rec.writes = pending.then(() => writer.abort()).catch(() => {});
}

function fileAccept(rec, button) {
  const peer = state.peers.get(rec.peerId);
  if (!peer || !peer.keys) {
    fileFinishIn(rec, 'gone');
    return;
  }
  // The picker runs inside the click that accepted, so a browser lets it
  // open. A closed picker means no accept was sent, and the offer is still
  // there for a second click.
  return fileDiskOpen(rec).then((ok) => {
    if (ok === null) {
      if (button) button.disabled = false;
      return;
    }
    fileAcceptGo(rec, peer, ok);
  });
}

function fileAcceptGo(rec, peer, disk) {
  if (disk === null || !state.peers.has(peer.id) || !peer.keys) return;
  rec.status = 'receiving';
  rec.got = 0;
  rec.expect = 0;
  rec.chunks = [];
  rec.rateT = 0;
  rec.rateB = 0;
  rec.rate = 0;
  rec.rateAt = performance.now();
  fileArmIn(rec);
  if (rec.el) {
    rec.el.acts.replaceChildren(fileButton('cancel', () => fileCancelIn(rec)));
  }
  sealedSend(peer, { k: 'file', a: 'accept', x: rec.x });
  filePaintIn(rec);
}

function fileRefuse(rec) {
  const peer = state.peers.get(rec.peerId);
  if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'refuse', x: rec.x });
  fileFinishIn(rec, 'refused');
}

function fileCancelIn(rec) {
  const peer = state.peers.get(rec.peerId);
  if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
  state.fileCancelled++;
  fileFinishIn(rec, 'cancelled');
}

function fileCancelOut(out, why) {
  if (!out || out.cancelled) return;
  out.cancelled = true;
  state.fileCancelled++;
  for (const st of out.peers.values()) {
    if (st.status === 'done' || st.status === 'refused' || st.status === 'gone') continue;
    st.status = 'cancelled';
    fileStop(st);
    if (st.peer.keys) sealedSend(st.peer, { k: 'file', a: 'cancel', x: out.x, y: why || '' });
  }
  // The file object is not needed any more, so the page can let it go.
  out.file = null;
  filePaintOut(out);
  fileSettle(out);
}

function fileCancelPeer(out, st, why) {
  if (st.status === 'done' || st.status === 'refused' || st.status === 'gone') return;
  st.status = 'cancelled';
  fileStop(st);
  if (st.peer.keys) sealedSend(st.peer, { k: 'file', a: 'cancel', x: out.x, y: why || '' });
  filePaintOut(out);
  fileSettle(out);
}

function fileOnAccept(peer, msg) {
  const out = state.files.get(String(msg.x || ''));
  if (!out || out.cancelled) {
    if (peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: String(msg.x || '') });
    return;
  }
  const st = out.peers.get(peer.id);
  if (!st || st.status !== 'offered') return;
  st.status = 'sending';
  st.rateAt = performance.now();
  filePaintOut(out);
  filePump(out, st).catch(() => fileCancelPeer(out, st, 'the transfer failed'));
}

function fileOnRefuse(peer, msg) {
  const out = state.files.get(String(msg.x || ''));
  if (!out || out.cancelled) return;
  const st = out.peers.get(peer.id);
  if (!st || st.status === 'refused') return;
  st.status = 'refused';
  fileStop(st);
  state.fileRefused++;
  filePaintOut(out);
  fileSettle(out);
}

function fileOnCancel(peer, msg) {
  const x = String(msg.x || '');
  // A cancel from a receiver ends that one outgoing transfer only; the other
  // accepted peers keep their own bytes. A cancel from the sender ends the
  // incoming transfer.
  const out = state.files.get(x);
  if (out) {
    const st = out.peers.get(peer.id);
    if (st && st.status !== 'done' && st.status !== 'refused' && st.status !== 'cancelled' && st.status !== 'gone') {
      st.status = 'cancelled';
      fileStop(st);
      state.fileCancelled++;
      filePaintOut(out);
      fileSettle(out);
    }
    return;
  }
  const rec = state.filesIn.get(peer.id + '|' + x);
  if (!rec || rec.status === 'done' || rec.status === 'refused' || rec.status === 'cancelled') return;
  rec.status = 'cancelled';
  fileFinishIn(rec, 'cancelled');
}

function fileOnDone(peer, msg) {
  const rec = state.filesIn.get(peer.id + '|' + String(msg.x || ''));
  if (!rec || rec.status !== 'receiving') return;
  // The metadata comes over the WebSocket and the bytes over the data channel,
  // so the last chunk can arrive after this frame. The byte count decides the
  // end; a channel that closes or a watchdog ends a transfer that never fills.
  if (rec.got !== rec.size) return;
  fileFinishIn(rec, 'done');
}

function fileOnChunk(peer, raw) {
  if (typeof raw !== 'string') return;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (!frame || typeof frame.b !== 'string') return;
  const rec = state.filesIn.get(peer.id + '|' + String(frame.x || ''));
  if (!rec || rec.status !== 'receiving' || !peer.keys) return;
  const q = Number(frame.q);
  // The channel is ordered, so the next number is the only one that can be
  // current. A repeat, a gap or a chunk of another transfer is dropped before
  // it is opened.
  if (!Number.isSafeInteger(q) || q !== rec.expect) {
    state.replayDrops++;
    return;
  }
  const out = pqCall((json) => pqModule().open(json), {
    key: b64e(peer.keys.recvChat),
    aad: b64e(fileAAD(peer.id, peer.id, rec.x, q)),
    b: frame.b,
  });
  if (!out || out.error) {
    state.replayDrops++;
    return;
  }
  const bytes = b64d(out.pt);
  if (rec.got + bytes.length > rec.size) {
    if (peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
    fileFinishIn(rec, 'cancelled');
    return;
  }
  if (rec.writer) fileDiskWrite(rec, bytes);
  else rec.chunks.push(bytes);
  rec.got += bytes.length;
  rec.expect = q + 1;
  state.fileChunksRecv++;
  fileMarkRate(rec, rec.got, performance.now());
  filePaintIn(rec);
  fileArmIn(rec);
  if (rec.got === rec.size) fileFinishIn(rec, 'done');
}

// fileArmIn ends a transfer that stops halfway. Every chunk resets it, so a
// slow link is fine and a peer that goes silent is not waited on forever.
function fileArmIn(rec) {
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => {
    rec.timer = 0;
    if (rec.status !== 'receiving') return;
    const peer = state.peers.get(rec.peerId);
    if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
    fileFinishIn(rec, 'cancelled');
  }, 20000);
}

// filePump sends one accepted offer to one peer. It reads the file in slices,
// seals each chunk with the chat key of the pair and waits for the channel to
// drain when the buffer is full. A cancel, a closed channel or a missing peer
// ends the loop at the next step.
async function filePump(out, st) {
  const peer = st.peer;
  const dc = await fileWaitOpen(peer, st);
  if (!dc || st.dead || out.cancelled || !out.file) return;
  const total = Math.ceil(out.size / FILE_CHUNK);
  for (let q = 0; q < total; q++) {
    if (st.dead || out.cancelled || !out.file) return;
    if (!state.peers.has(peer.id) || !peer.keys) {
      fileStop(st);
      return;
    }
    let buf;
    try {
      buf = new Uint8Array(await out.file.slice(q * FILE_CHUNK, (q + 1) * FILE_CHUNK).arrayBuffer());
    } catch {
      fileCancelPeer(out, st, 'the file could not be read');
      return;
    }
    if (st.dead || out.cancelled) return;
    const sealed = pqCall((json) => pqModule().seal(json), {
      key: b64e(peer.keys.sendChat),
      aad: b64e(fileAAD(peer.id, state.self, out.x, q)),
      pt: b64e(buf),
    });
    if (!sealed || !sealed.b) {
      fileCancelPeer(out, st, 'a chunk could not be sealed');
      return;
    }
    const ready = await fileSpace(dc, st);
    if (!ready || st.dead || out.cancelled) return;
    try {
      dc.send(JSON.stringify({ x: out.x, q, b: sealed.b }));
    } catch {
      fileCancelPeer(out, st, 'the file channel closed');
      return;
    }
    st.sent = q + 1;
    state.fileChunksSent++;
    fileMarkRate(st, st.sent * FILE_CHUNK, performance.now());
    filePaintOut(out);
  }
  if (st.dead || out.cancelled) return;
  st.status = 'done';
  if (peer.keys) sealedSend(peer, { k: 'file', a: 'done', x: out.x });
  filePaintOut(out);
  fileSettle(out);
}

// fileWaitOpen resolves with the open channel of the pair, or null when it
// never opens, closes or the transfer stops. The wait is cleared on cancel.
function fileWaitOpen(peer, st) {
  return new Promise((resolve) => {
    let timer = 0;
    let dc = null;
    const done = (value) => {
      if (st.wake !== wake) return;
      st.wake = null;
      clearTimeout(timer);
      if (dc) {
        dc.removeEventListener('open', onOpen);
        dc.removeEventListener('close', onClose);
      }
      resolve(value);
    };
    const wake = () => done(null);
    const onOpen = () => done(dc);
    const onClose = () => done(null);
    const attach = (channel) => {
      dc = channel;
      if (!dc) return done(null);
      if (dc.readyState === 'open') return done(dc);
      if (dc.readyState !== 'connecting') return done(null);
      dc.addEventListener('open', onOpen);
      dc.addEventListener('close', onClose);
    };
    st.wake = wake;
    if (peer.dc) attach(peer.dc);
    else if (peer.dcPromise) {
      peer.dcPromise.then((channel) => {
        if (st.wake === wake) attach(channel);
      });
    }
    timer = setTimeout(wake, FILE_OPEN_WAIT);
  });
}

// fileSpace waits while the channel holds more than FILE_BUFFER. The low mark
// wakes it, and a timer rechecks, so a lost event can not stall the transfer.
function fileSpace(dc, st) {
  if (dc.readyState !== 'open') return Promise.resolve(false);
  if (dc.bufferedAmount <= FILE_BUFFER) return Promise.resolve(true);
  dc.bufferedAmountLowThreshold = FILE_LOW;
  return new Promise((resolve) => {
    let timer = 0;
    const done = (value) => {
      if (st.wake !== wake) return;
      st.wake = null;
      clearTimeout(timer);
      dc.removeEventListener('bufferedamountlow', onLow);
      resolve(value);
    };
    const wake = () => done(false);
    const onLow = () => {
      if (dc.bufferedAmount <= FILE_BUFFER) done(true);
    };
    st.wake = wake;
    dc.addEventListener('bufferedamountlow', onLow);
    timer = setTimeout(() => done(dc.readyState === 'open' && dc.bufferedAmount <= FILE_BUFFER), 2000);
  });
}

function fileBindChannel(peer, dc) {
  if (!dc || peer.dc === dc) return;
  if (peer.dc) {
    peer.dc.onmessage = null;
    peer.dc.onclose = null;
    peer.dc.onerror = null;
  }
  peer.dc = dc;
  dc.onmessage = (event) => fileOnChunk(peer, typeof event.data === 'string' ? event.data : '');
  dc.onclose = () => {
    if (peer.dc !== dc) return;
    peer.dc = null;
    fileChannelClosed(peer);
  };
  dc.onerror = () => { /* the close event does the bookkeeping */ };
  if (peer.dcResolve) {
    const resolve = peer.dcResolve;
    peer.dcResolve = null;
    peer.dcPromise = Promise.resolve(dc);
    resolve(dc);
  }
}

// fileChannelClosed ends every transfer of a pair whose channel went away. The
// peer may still be in the room, so the name stays; only the files stop.
function fileChannelClosed(peer) {
  for (const out of state.files.values()) {
    const st = out.peers.get(peer.id);
    if (!st || st.status === 'done' || st.status === 'refused' || st.status === 'cancelled' || st.status === 'gone') continue;
    st.status = 'gone';
    fileStop(st);
    if (!out.cancelled) filePaintOut(out);
    fileSettle(out);
  }
  for (const rec of state.filesIn.values()) {
    if (rec.peerId === peer.id && rec.status === 'receiving') fileFinishIn(rec, 'cancelled');
  }
}

// fileDropPeer clears the channel listeners and the waits of a peer that
// leaves. Called from dropPeer and sealedRestart before the connection closes.
function fileDropPeer(peer) {
  const dc = peer.dc;
  peer.dc = null;
  if (dc) {
    dc.onmessage = null;
    dc.onopen = null;
    dc.onclose = null;
    dc.onerror = null;
  }
  if (peer.dcResolve) {
    const resolve = peer.dcResolve;
    peer.dcResolve = null;
    peer.dcPromise = Promise.resolve(null);
    resolve(null);
  }
  filePeerGone(peer.id);
}

function filePeerGone(id) {
  for (const out of state.files.values()) {
    const st = out.peers.get(id);
    if (!st) continue;
    if (st.status !== 'done' && st.status !== 'refused' && st.status !== 'cancelled' && st.status !== 'gone') {
      st.status = 'gone';
      fileStop(st);
      if (!out.cancelled) filePaintOut(out);
      fileSettle(out);
    }
  }
  for (const rec of state.filesIn.values()) {
    if (rec.peerId !== id) continue;
    if (rec.status === 'done' || rec.status === 'refused' || rec.status === 'cancelled' || rec.status === 'gone') continue;
    fileFinishIn(rec, 'gone');
  }
}

function fileStop(st) {
  st.dead = true;
  if (st.wake) st.wake();
}

function fileInText(rec) {
  if (rec.status === 'offered') return 'waiting for you';
  if (rec.status === 'receiving') {
    const pct = rec.size ? Math.round((rec.got / rec.size) * 100) : 0;
    const rate = fileRateText(rec.rate);
    return 'receiving ' + pct + ' percent' + (rate ? ', ' + rate : '');
  }
  if (rec.status === 'done') {
    return rec.disk ? 'saved to disk' + (rec.avg ? ', ' + rec.avg : '')
      : 'ready, click save' + (rec.avg ? ', ' + rec.avg : '');
  }
  if (rec.status === 'refused') return 'refused';
  if (rec.status === 'cancelled') return 'cancelled';
  if (rec.status === 'gone') return 'the sender left';
  return '';
}

function filePaintIn(rec) {
  if (!rec.el) return;
  const pct = rec.size ? rec.got / rec.size : 0;
  fileSetBar(rec.el, rec.status === 'receiving', pct);
  rec.el.status.textContent = fileInText(rec);
}

// fileFinishDisk closes the writable after the last queued chunk. The bytes
// are on disk with the name the guest chose, so the row carries no save link
// and the page keeps no byte of the file.
function fileFinishDisk(rec) {
  const writer = rec.writer;
  rec.writer = null;
  rec.avg = fileAverageRate(rec.size, rec.rateAt, performance.now());
  if (rec.el) rec.el.status.textContent = 'saving to disk' + (rec.avg ? ', ' + rec.avg : '');
  const pending = rec.writes || Promise.resolve();
  pending.then(() => writer.close()).then(() => {
    state.fileRecv++;
    state.filesIn.delete(rec.key);
    if (rec.el) {
      rec.el.acts.replaceChildren();
      rec.el.status.textContent = fileInText(rec);
    }
  }).catch(() => {
    state.filesIn.delete(rec.key);
    if (rec.el) {
      rec.el.acts.replaceChildren();
      rec.el.status.textContent = 'the disk write failed';
    }
  });
}

function fileFinishIn(rec, status) {
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = 0;
  }
  if (status === 'done' && rec.got !== rec.size) status = 'cancelled';
  rec.status = status;
  if (rec.el) rec.el.bar.hidden = true;
  if (status === 'done' && rec.writer) {
    fileFinishDisk(rec);
    return;
  }
  if (status === 'done') {
    // The bytes live in this Blob only. The link hands them to the guest when
    // the guest clicks it, so nothing is written before that click.
    rec.avg = fileAverageRate(rec.size, rec.rateAt, performance.now());
    const blob = new Blob(rec.chunks, { type: rec.type || 'application/octet-stream' });
    rec.chunks = [];
    if (rec.url) {
      URL.revokeObjectURL(rec.url);
      state.fileLinks.delete(rec.url);
    }
    rec.url = URL.createObjectURL(blob);
    state.fileLinks.add(rec.url);
    state.fileRecv++;
    if (rec.el) {
      const link = document.createElement('a');
      link.className = 'file-save';
      link.href = rec.url;
      link.download = rec.name;
      link.textContent = 'save ' + fileBytes(rec.size);
      rec.el.acts.replaceChildren(link);
      rec.el.status.textContent = 'ready, click save' + (rec.avg ? ', ' + rec.avg : '');
    }
    state.filesIn.delete(rec.key);
    return;
  }
  // A refused, cancelled or orphaned transfer keeps no bytes at all, and a
  // half written file on disk is dropped.
  fileDiskAbort(rec);
  if (rec.url) {
    URL.revokeObjectURL(rec.url);
    state.fileLinks.delete(rec.url);
    rec.url = '';
  }
  if (rec.el) {
    rec.el.acts.replaceChildren();
    rec.el.status.textContent = fileInText(rec);
  }
  state.filesIn.delete(rec.key);
}

function filePaintOut(out) {
  if (!out.el) return;
  const list = [...out.peers.values()];
  const accepted = list.filter((s) => s.status === 'sending' || s.status === 'done');
  const refused = list.filter((s) => s.status === 'refused');
  const gone = list.filter((s) => s.status === 'gone');
  const stopped = list.filter((s) => s.status === 'cancelled');
  const open = list.some((s) => s.status === 'offered' || s.status === 'sending');
  const bytes = accepted.reduce((n, s) => n + Math.min(out.size, s.sent * FILE_CHUNK), 0);
  const total = accepted.length * Math.max(1, out.size);
  const allDone = accepted.length > 0 && accepted.every((s) => s.status === 'done');
  const frac = out.size === 0 ? (allDone ? 1 : 0) : (total ? bytes / total : 0);
  fileSetBar(out.el, !out.cancelled && accepted.length > 0 && !allDone, frac);
  if (out.cancelled) {
    out.el.acts.replaceChildren();
    out.el.status.textContent = 'cancelled';
    return;
  }
  const words = ['accepted ' + accepted.length + ' of ' + list.length];
  if (accepted.length) {
    words.push(accepted.map((s) => {
      const pct = out.size ? Math.round((Math.min(out.size, s.sent * FILE_CHUNK) / Math.max(1, out.size)) * 100) : (s.status === 'done' ? 100 : 0);
      const sent = Math.min(out.size, s.sent * FILE_CHUNK);
      const rate = s.status === 'done'
        ? fileAverageRate(sent, s.rateAt, performance.now())
        : fileRateText(s.rate);
      return s.peer.name + ' ' + (s.status === 'done' ? 'done' : pct + ' percent') + (rate ? ', ' + rate : '');
    }).join(', '));
  }
  if (refused.length) words.push('refused ' + refused.map((s) => s.peer.name).join(', '));
  if (stopped.length) words.push('cancelled ' + stopped.map((s) => s.peer.name).join(', '));
  if (gone.length) words.push('left ' + gone.map((s) => s.peer.name).join(', '));
  out.el.status.textContent = words.join(' | ');
  // A settled offer keeps no button: there is nothing left to cancel.
  if (!open) out.el.acts.replaceChildren();
}

// fileSettle drops the file handle of an offer once no peer can take it any
// more, so a long call keeps no closed transfers and no file memory.
function fileSettle(out) {
  const list = [...out.peers.values()];
  if (!list.length) return;
  const open = list.some((s) => s.status === 'offered' || s.status === 'sending');
  if (open) return;
  out.file = null;
  state.files.delete(out.x);
}

function fileClearAll() {
  for (const out of state.files.values()) {
    out.cancelled = true;
    for (const st of out.peers.values()) fileStop(st);
    out.file = null;
  }
  state.files.clear();
  for (const rec of state.filesIn.values()) {
    fileDiskAbort(rec);
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.url = '';
  }
  state.filesIn.clear();
  for (const url of state.fileLinks) URL.revokeObjectURL(url);
  state.fileLinks.clear();
  state.fileOffers = 0;
  state.fileRecv = 0;
  state.fileChunksSent = 0;
  state.fileChunksRecv = 0;
  state.fileRefused = 0;
  state.fileCancelled = 0;
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
// a bitrate, two packet counters give the loss, the inbound streams give the
// jitter, and the selected candidate pair gives the round trip time and the
// path. Polling stops when the panel is closed or the tab is hidden.
const STATS_MS = 1000;
const STATS_HISTORY = 60;   // one sample a second, so a minute of the call

function statsOpen() {
  const panel = $('stats-panel');
  return !!panel && !panel.hidden;
}

function startStats() {
  if (state.statsTimer || !statsOpen()) return;
  for (const peer of state.peers.values()) {
    peer.statLast.clear();
    peer.statLoss = undefined;
  }
  state.statHist.length = 0;
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
  const sum = $('stats-sum');
  if (sum) sum.replaceChildren();
}

// bitrate turns two samples of one byte counter into kilobits per second. The first sample
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

// counterDelta is the movement of one cumulative counter since the last tick.
// A counter that is missing or that went backwards yields null, so a restarted
// report cannot turn into a burst of invented packets.
function counterDelta(last, report, field) {
  const value = report[field];
  if (typeof value !== 'number') return null;
  const key = `${report.id || report.type + ':' + report.kind}:${field}`;
  const prev = last.get(key);
  last.set(key, { bytes: value, ts: report.timestamp || 0 });
  return prev ? value - prev.bytes : null;
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

  const out = {
    up: { audio: 0, video: 0 }, down: { audio: 0, video: 0 },
    rtt: null, path: '', jitter: null, loss: null, shot: '',
  };
  let jitterMax = null;   // seconds, the worse of the two inbound streams
  let lost = 0;           // packets lost in this tick, both streams
  let got = 0;            // packets received in this tick, both streams
  let pairId = null;
  const pairs = new Map();
  const cands = new Map();
  try {
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
        out.up[r.kind] += bitrate(peer.statLast, r, 'bytesSent');
      } else if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
        out.down[r.kind] += bitrate(peer.statLast, r, 'bytesReceived');
        // The decoder reports the picture it is handed, which is the only
        // size that matters: the sender may clamp for its own bandwidth.
        if (r.kind === 'video' && r.frameWidth && r.frameHeight) {
          out.shot = `${r.frameWidth}x${r.frameHeight}`;
        }
        // Jitter and loss belong to the side that listens: a packet lost on
        // the way here is a packet gone for this guest, so this report is the
        // only honest place to read them.
        if (typeof r.jitter === 'number') {
          jitterMax = jitterMax === null ? r.jitter : Math.max(jitterMax, r.jitter);
        }
        const dLost = counterDelta(peer.statLast, r, 'packetsLost');
        const dGot = counterDelta(peer.statLast, r, 'packetsReceived');
        if (dLost !== null && dGot !== null && dGot >= 0) {
          lost += Math.max(0, dLost);
          got += dGot;
        }
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
  if (jitterMax !== null) out.jitter = jitterMax * 1000;
  if (got > 0) {
    // One tick is a short window, so the share is smoothed: a single burst
    // moves the number without pinning it for the rest of the call.
    const now = (lost / (lost + got)) * 100;
    out.loss = typeof peer.statLoss === 'number' ? peer.statLoss * 0.7 + now * 0.3 : now;
    peer.statLoss = out.loss;
  }
  return out;
}

// rateText renders a bitrate as the number and the first letter of its unit,
// because the column beside it already says what the number is. A rate of
// zero returns an empty string, so a cell with nothing to say stays empty.
function rateText(kbit) {
  if (!(kbit > 0)) return '';
  if (kbit >= 1000) return (kbit / 1000).toFixed(kbit >= 10000 ? 0 : 1) + 'm';
  return Math.round(kbit) + 'k';
}

// msText renders one round trip time in milliseconds, as "12 ms". The unit is
// spelled out because the bitrate column already uses a bare "m" for megabits.
function msText(ms) {
  return Math.round(ms) + ' ms';
}

// jitterText renders one jitter in milliseconds. The numbers are small and a
// few milliseconds decide whether a voice sounds clear, so under 10 keeps one
// decimal.
function jitterText(ms) {
  if (typeof ms !== 'number') return '';
  return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
}

// lossText renders a packet loss share. Under a twentieth of a percent is not
// a loss that a person can hear, so it reads as none; two percent and more is
// the point where a voice starts to break, and the caller marks it red.
function lossText(pct) {
  if (typeof pct !== 'number') return '';
  if (pct < 0.05) return 'none';
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + ' %';
}

// lossMark is the colour rule for a loss row: red from two percent, no mark
// below it.
function lossMark(pct) {
  return pct >= 2 ? false : undefined;
}

// The drawings of the panel. Each stands where a word would and carries the
// word in its title, so a hover names it.
const VIDEO_ICON = ['1F3A5', 'video'];
const AUDIO_ICON = ['1F50A', 'audio'];
const PICTURE_ICON = ['1F5BC', 'picture size'];
const PING_ICON = ['1F3D3', 'round trip'];
const JITTER_ICON = ['1F30A', 'jitter, how far apart the packets arrive'];
const LOSS_ICON = ['1F4C9', 'packet loss'];
const DIRECT_ICON = ['1F517', 'direct, the two browsers talk to each other'];
const RELAY_ICON = ['1F4E1', 'relay, the media goes through the server'];
const UP_ICON = ['2B06', 'out, what this browser sends'];
const DOWN_ICON = ['2B07', 'in, what this browser receives'];

// routeCell is the value of the route row: the drawing and the word. A link
// when the two browsers talk to each other, a satellite when the media has to
// pass the server.
function routeCell(path) {
  if (!path) return ['', '', 'not known yet'];
  const direct = path === 'direct' || path === 'p2p';
  return [...(direct ? DIRECT_ICON : RELAY_ICON), path === 'p2p' ? 'direct' : path];
}

// rateCell is one bitrate with the arrow of its direction. Both directions sit
// on the same row, so the two rates of the video row and of the audio row line
// up under each other.
function rateCell(dir, kbit) {
  return [...(dir === 'up' ? UP_ICON : DOWN_ICON), rateText(kbit) || '-'];
}

// tripCells are the three numbers of one path: how long a packet takes, how
// far apart the packets arrive, and how many of them never arrive. A number
// that is not there yet leaves its cell empty, and the column stays.
function tripCells(rtt, jitter, loss) {
  return [
    [...PING_ICON, typeof rtt === 'number' ? msText(rtt) : ''],
    [...JITTER_ICON, typeof jitter === 'number' ? jitterText(jitter) : ''],
    [...LOSS_ICON, typeof loss === 'number' ? lossText(loss) : '', lossMark(loss)],
  ];
}

// pathText is the word a guest reads for one route: the report says p2p for a
// direct pair, and the panel says direct.
function pathText(path) {
  return path === 'p2p' ? 'direct' : path;
}

// callPath is the route of the whole call: one word when every pair takes the
// same route, and the list of routes when they do not.
function callPath(live) {
  const words = new Set();
  for (const s of live) if (s.path) words.add(pathText(s.path));
  if (words.size === 0) return '';
  if (words.size === 1) return [...words][0];
  return 'mixed: ' + [...words].join(', ');
}

// callPairs is the first card and the glance of the panel: the route with the
// three numbers of the path on one row, then what the whole call sends and
// receives. A number that is not there yet leaves its cell empty, so the rows
// below it still line up.
/** @returns {(string | (string | boolean)[][])[][]} */
function callPairs(live, total) {
  const out = [];
  const path = callPath(live);
  const worst = (key) => {
    const nums = live.map((s) => s[key]).filter((n) => typeof n === 'number');
    return nums.length ? Math.max(...nums) : null;
  };
  const rtt = worst('rtt');
  const jitter = worst('jitter');
  const loss = worst('loss');
  if (path) out.push(['route ', [routeCell(path)]]);
  if (rtt !== null || jitter !== null || loss !== null) {
    out.push(['link ', tripCells(rtt, jitter, loss), undefined, 'metrics']);
  }
  out.push([VIDEO_ICON, [['', '', ''], rateCell('up', total.up.video), rateCell('down', total.down.video)]]);
  out.push([AUDIO_ICON, [['', '', ''], rateCell('up', total.up.audio), rateCell('down', total.down.audio)]]);
  return out;
}

// levelDb is one input peak as decibels, or the word silent under -60 dB, which
// is below anything a person hears.
function levelDb(peak) {
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  return db > -60 ? `${Math.round(db)} dB` : 'silent';
}

// levelFraction is the share of the -60 dB to 0 dB scale that one peak fills,
// from 0 to 1, for the bar of a meter row.
function levelFraction(peak) {
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

// peerLevel is what arrives from one guest, read before the gain. It is empty
// until the audio path of that guest exists.
function peerLevel(peer) {
  if (!peer.audioSrc || !peer.meter) return '';
  return levelDb(peer.meterPeak || 0);
}

// ownPairs is the own card: the key this browser holds, then what its own
// camera and microphone do. A live track with a silent meter points at the
// graph; a dead context points at the autoplay rule of a phone, so the sound
// state only shows when it needs a click.
/** @returns {(string | (string | boolean)[][])[][]} */
function ownPairs(total) {
  const out = [];
  // The long-term identity of this browser: the fingerprint alone, under the
  // name of the card, because where the key lives is the panel's noise.
  if (state.idKey) out.push(['key ', state.idKey.fp, undefined, 'mono']);
  const live = !!(state.mic && state.micTrack && state.micTrack.readyState === 'live');
  const mic = live && state.micTrack && state.micTrack.getSettings ? state.micTrack.getSettings() : null;
  const cam = state.camTrack && state.camTrack.getSettings ? state.camTrack.getSettings() : null;
  const shot = cam && cam.width && cam.height ? `${cam.width}x${cam.height}` : 'off';
  out.push([VIDEO_ICON, [
    [...PICTURE_ICON, shot],
    rateCell('up', total ? total.up.video : 0),
    rateCell('down', total ? total.down.video : 0),
  ]]);
  const sample = mic && mic.sampleRate ? `${Math.round(mic.sampleRate / 1000)} kHz ${mic.channelCount || 1}ch` : '';
  out.push([AUDIO_ICON, [
    ['', '', live ? (sample || 'on') : 'off'],
    rateCell('up', total ? total.up.audio : 0),
    rateCell('down', total ? total.down.audio : 0),
  ]]);
  // The microphone has a meter of its own: a bar that fills with the level,
  // so a speaker sees at once that the voice is going out.
  const level = live && state.micAnalyser ? micLevelCells(state.meterPeak) : null;
  out.push(['mic ', [['', '', level ? (level.state === 'silent' ? 'silent' : level.db) : 'off']],
    undefined, false, level ? levelFraction(state.meterPeak) : 0]);
  const ctx = state.playCtx;
  const play = ctx ? ctx.state : 'none';
  if (play !== 'running') out.push(['sound ', `${play}, tap the page once`, false]);
  return out;
}

// peerPairs is one guest card: the identity first, then the path and the two
// media rows of that pair. A cell with no number stays empty, so the columns
// line up with the row above it, and with one guest in the room this card is
// the whole call.
/** @returns {(string | (string | boolean)[][])[][]} */
function peerPairs(peer, s) {
  const out = [];
  const pin = pinState(peer);
  if (peer.fp && pin !== 'new') {
    // The key sits right under the name of the card, with a green tick when
    // this browser can name that guest and the state word when it cannot. A
    // key is read letter by letter, so it is monospace.
    const bad = pin === 'changed' || pin === 'rollback';
    const cells = [pin === 'known' ? ['2714', 'verified', peer.fp] : ['', '', peer.fp]];
    if (pin !== 'known') cells.push(['', '', pin]);
    out.push(['key ', cells, bad ? false : undefined, 'mono']);
  }
  if (!s) {
    out.push(['', 'connecting', undefined, true]);
  } else {
    out.push(['route ', [routeCell(s.path)]]);
    out.push(['link ', tripCells(s.rtt, s.jitter, s.loss), undefined, 'metrics']);
    out.push([VIDEO_ICON, [
      [...PICTURE_ICON, s.shot || ''],
      rateCell('up', s.up.video),
      rateCell('down', s.down.video),
    ]]);
    out.push([AUDIO_ICON, [
      ['', '', peerLevel(peer)],
      rateCell('up', s.up.audio),
      rateCell('down', s.down.audio),
    ]]);
  }
  // With one code in the room the code card below names it once, and a line
  // on every guest would say the same thing again.
  if (peer.sas && sealedRoomCodes().size > 1) out.push(['code ', verifyText(peer.sas), undefined, true]);
  if (!peer.keys) out.push(['keys ', 'none', false, true]);
  else if (peer.ready === 'ready' && !peer.confirmed) out.push(['keys ', 'not confirmed', false, true]);
  const c = sealedPairCount(peer.id);
  if (c.refused) out.push(['frames ', `${c.refused} refused`, false, true]);
  return out;
}

// statsRow is one card of the panel: a name and a short list of key/value
// lines. A line is [key, value] or [key, value, mark] with a mark of true for
// green and false for red. The fourth field is true for an indented sub row,
// or 'mono' for a value that is read letter by letter, such as a key.
// statIcon is one OpenMoji drawing with the word it stands for in its title,
// so a line can say "video" with a picture and still answer a hover.
function statIcon(hex, title) {
  const img = document.createElement('img');
  img.className = 'sico';
  img.src = `/openmoji/${hex}.svg`;
  img.alt = title;
  img.title = title;
  return img;
}

// statCells fills one row with one cell per part. A part is text, or
// [drawing, word, text] with the word in the title, or the same with a fourth
// false to mark that cell red. An empty part keeps its column, so the numbers
// of the row below still line up with it.
function statCells(value, metrics) {
  const span = document.createElement('span');
  span.className = 'sv';
  const parts = Array.isArray(value) ? value : [value];
  for (const raw of parts) {
    const p = Array.isArray(raw) ? raw : [raw];
    const cell = document.createElement('span');
    cell.className = 'cell' + (p[3] === true ? ' good' : p[3] === false ? ' bad' : '');
    const word = p.length > 1 ? p[2] : p[0];
    const text = document.createElement('span');
    text.textContent = word === null || word === undefined ? '' : String(word);
    if (metrics && p.length > 1 && p[1]) {
      // A metric reads as a small label over a number: the word is the first
      // part of the title of its drawing, so the two never disagree.
      const label = document.createElement('span');
      label.className = 'cl';
      label.title = String(p[1]);
      label.textContent = String(p[1]).split(',')[0];
      text.className = 'cv';
      cell.append(label, text);
    } else {
      if (p.length > 1 && p[0]) cell.appendChild(statIcon(p[0], p[1]));
      cell.appendChild(text);
    }
    span.appendChild(cell);
  }
  return span;
}

function statLine(key, value, mark, sub, meter) {
  const line = document.createElement('div');
  const parts = Array.isArray(value) ? value : [value];
  line.className = 'sline' + (sub === 'mono' ? ' mono' : sub === 'metrics' ? ' metrics' : sub ? ' sub' : '') +
    (typeof meter === 'number' ? ' meterline' : '') +
    (mark === true ? ' good' : mark === false ? ' bad' : '');
  line.dataset.n = String(parts.length);
  const k = document.createElement('span');
  k.className = 'sk';
  // A key of two is [drawing, word]: the drawing and the first words of its
  // title, so the row reads without a hover. A key with no drawing keeps its
  // word as text.
  if (Array.isArray(key) && key[0]) {
    k.appendChild(statIcon(key[0], key[1]));
    k.appendChild(document.createTextNode(String(key[1]).split(',')[0]));
  } else k.textContent = Array.isArray(key) ? (key[1] || '') : key;
  line.appendChild(k);
  if (typeof meter === 'number') {
    const bar = document.createElement('span');
    bar.className = 'meter';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `level ${Math.round(meter * 100)} percent`);
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(meter * 100)}%`;
    bar.appendChild(fill);
    line.appendChild(bar);
  }
  line.appendChild(statCells(value, sub === 'metrics'));
  return line;
}

function statsRow(title, pairs, mark, badge) {
  const row = document.createElement('div');
  row.className = 'srow';
  const head = document.createElement('div');
  head.className = 'sname';
  const name = document.createElement('span');
  name.className = 'stitle';
  name.textContent = title;
  head.appendChild(name);
  // The badge is the verdict of one guest: a lamp and a word, so the card says
  // how that link is before a number has to be read.
  if (badge && badge.level) {
    const chip = document.createElement('span');
    chip.className = 'sbadge';
    chip.dataset.level = badge.level;
    chip.textContent = badge.text || badge.level;
    head.appendChild(chip);
  }
  row.appendChild(head);
  for (const p of pairs) {
    row.appendChild(statLine(p[0], p[1], p.length > 2 ? p[2] : mark, p.length > 3 ? p[3] : false, p[4]));
  }
  return row;
}

// linkLevel is the verdict on one link: poor from 5 percent loss or 400 ms,
// fair from 2 percent, 200 ms or 40 ms of jitter, good otherwise. A link with
// nothing measured yet has no verdict, because a guess would be a lie.
function linkLevel(s) {
  if (!s) return '';
  const { rtt, loss, jitter } = s;
  if (rtt === null && loss === null) return '';
  if ((loss !== null && loss >= 5) || (rtt !== null && rtt >= 400)) return 'poor';
  if ((loss !== null && loss >= 2) || (rtt !== null && rtt >= 200) || (jitter !== null && jitter >= 40)) return 'fair';
  return 'good';
}

function worstLevel(levels) {
  for (const word of ['poor', 'fair', 'good']) if (levels.includes(word)) return word;
  return '';
}

// statsSummary is the first card: one lamp and one sentence for the whole
// call, so a healthy call needs no reading and a weak one says what to do.
function statsSummary(live, guestCount) {
  const level = worstLevel(live.map(linkLevel));
  const box = document.createElement('div');
  box.className = 'ssum';
  box.dataset.level = level;
  const lamp = document.createElement('span');
  lamp.className = 'slamp';
  const text = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'ssum-head';
  const sub = document.createElement('div');
  sub.className = 'ssum-sub';
  if (guestCount === 0) {
    head.textContent = 'waiting for guests';
    sub.textContent = 'the numbers start when someone joins';
  } else if (!level) {
    head.textContent = 'measuring';
    sub.textContent = 'the first numbers arrive in a second';
  } else {
    head.textContent = `connection ${level}`;
    const nums = live.map((s) => s.rtt).filter((n) => typeof n === 'number');
    const loss = live.map((s) => s.loss).filter((n) => typeof n === 'number');
    const bits = [callPath(live)];
    if (nums.length) bits.push(msText(Math.max(...nums)));
    if (loss.length) bits.push(`loss ${lossText(Math.max(...loss))}`);
    sub.textContent = bits.filter(Boolean).join(' | ');
    if (level === 'poor') sub.textContent += '. Try a lower quality in the toolbar.';
  }
  text.append(head, sub);
  box.append(lamp, text);
  return box;
}

// recordStatsHistory appends one sample of the whole call: what came down,
// the worst round trip and the worst loss of that second. The graph is a
// glance, so a healthy call draws a flat floor and not a row of numbers.
function recordStatsHistory(total, live) {
  const worst = (key) => {
    const nums = live.map((s) => s[key]).filter((n) => typeof n === 'number');
    return nums.length ? Math.max(...nums) : null;
  };
  state.statHist.push({ down: total.down.video + total.down.audio, rtt: worst('rtt'), loss: worst('loss') });
  if (state.statHist.length > STATS_HISTORY) state.statHist.shift();
}

// statsPlot draws one series on one small canvas. A filled series is an area
// that stands on the floor, a line series is a stroke that breaks where a
// sample has no value. The peak comes from the caller, so a small number still
// fills the box, and the floor under it keeps a quiet call from reading as a
// dead one.
function statsPlot(canvas, values, peak, fill, color) {
  if (!canvas) return;
  const cssW = canvas.clientWidth || 288;
  const cssH = canvas.clientHeight || 34;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // A black screen with a dark green grid, like the performance monitor of the
  // era: the shape reads at a glance and the colours need no legend.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cssW, cssH);
  const n = values.length;
  // One step is one second of a fixed minute and the newest sample sits at the
  // right edge, so a call that has run for ten seconds fills a sixth of the
  // box and the picture scrolls left from there, instead of stretching.
  const stepX = (cssW - 2) / (STATS_HISTORY - 1);
  const px = (i) => cssW - 1 - (n - 1 - i) * stepX;
  const py = (v) => cssH - 1 - (Math.min(v, peak) / peak) * (cssH - 2);

  ctx.strokeStyle = '#0c3c0c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 1; g < 3; g++) {
    const y = Math.round((cssH * g) / 3) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
  }
  for (let g = 1; g < 6; g++) {
    const x = Math.round((cssW * g) / 6) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssH);
  }
  ctx.stroke();
  if (n < 1) return;

  if (fill) {
    ctx.beginPath();
    ctx.moveTo(px(0), cssH - 1);
    for (let i = 0; i < n; i++) ctx.lineTo(px(i), py(values[i] === null ? 0 : values[i]));
    ctx.lineTo(px(n - 1), cssH - 1);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  let drawing = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null) { drawing = false; continue; }
    if (drawing) ctx.lineTo(px(i), py(v));
    else { ctx.moveTo(px(i), py(v)); drawing = true; }
  }
  ctx.stroke();
}

// statsNote writes the text line under one drawing. The drawing is a glance,
// the line under it carries the numbers, so a guest who cannot read the shapes
// loses nothing.
function statsNote(id, text) {
  const note = $(id);
  if (note) note.textContent = text;
}

// rateWords is a bitrate with its unit spelled out, for the line under a graph.
function rateWords(kbit) {
  if (!(kbit > 0)) return '0 kbit/s';
  if (kbit >= 1000) return (kbit / 1000).toFixed(kbit >= 10000 ? 0 : 1) + ' Mbit/s';
  return Math.round(kbit) + ' kbit/s';
}

// drawStatsGraphs draws the last minute as three drawings: the downlink as a
// filled area, the round trip and the loss as lines. Each keeps its own peak,
// so one guest with a bad path shows on its own drawing and not as a small
// bump under a big one.
function drawStatsGraphs() {
  const box = $('stats-graph-box');
  if (!box) return;
  const hist = state.statHist;
  box.hidden = hist.length < 2;
  if (hist.length < 2) return;
  const series = (key) => hist.map((p) => (typeof p[key] === 'number' ? p[key] : null));
  const values = (arr) => arr.filter((v) => v !== null);
  const peak = (arr, floor) => Math.max(floor, ...values(arr));
  const now = (arr) => {
    const kept = values(arr);
    return kept.length ? kept[kept.length - 1] : null;
  };
  const secs = `last ${hist.length} s`;

  // Downlink: the area says "steady" or "collapsing" at a glance. The floor of
  // 100 kbit/s keeps a quiet call on the floor of the box, not off it.
  const down = series('down');
  statsPlot($('stats-graph-down'), down, peak(down, 100), true, '#00e000');
  const downMax = Math.max(0, ...values(down));
  statsNote('stats-note-down', `down ${rateWords(now(down))} now, peak ${rateWords(downMax)}, ${secs}`);

  // Round trip: a line, broken where a sample has no value, so a gap is a gap.
  const rtt = series('rtt');
  statsPlot($('stats-graph-rtt'), rtt, peak(rtt, 100), false, '#f0e000');
  statsNote('stats-note-rtt', values(rtt).length
    ? `round trip ${msText(now(rtt))} now, peak ${msText(Math.max(...values(rtt)))}, ${secs}`
    : `round trip not measured, ${secs}`);

  // Loss: a line on a scale that starts at one percent, so a clean call is a
  // flat floor and any loss at all leaves the floor.
  const loss = series('loss');
  statsPlot($('stats-graph-loss'), loss, peak(loss, 1), false, '#ff5050');
  const lossMax = Math.max(0, ...values(loss));
  statsNote('stats-note-loss', lossMax > 0
    ? `loss ${lossText(now(loss))} now, peak ${lossText(lossMax)}, ${secs}`
    : `loss none, ${secs}`);
}

// updateStats draws one round: the faults and the verdict of the call, the
// graphs of the last minute, then one card per guest, the own side and the
// crypto counters.
async function updateStats() {
  if (!statsOpen() || state.statsBusy) return;
  const body = $('stats-body');
  if (!body) return;
  state.statsBusy = true;
  try {
    const total = { up: { audio: 0, video: 0 }, down: { audio: 0, video: 0 } };
    const live = [];
    const guests = [];
    for (const peer of state.peers.values()) {
      const s = await peerStats(peer);
      if (s) {
        live.push(s);
        for (const dir of ['up', 'down']) {
          for (const kind of ['audio', 'video']) total[dir][kind] += s[dir][kind];
        }
      }
      guests.push({ peer, s });
    }
    const rows = [];
    recordStatsHistory(total, live);
    // With one guest in the room that card is the whole call, and a second
    // card of the same numbers would only be read twice.
    if (state.peers.size > 1) {
      const call = callPairs(live, total);
      if (call.length) rows.push(statsRow('call', call));
    }
    for (const { peer, s } of guests) {
      const level = linkLevel(s);
      const pairs = peerPairs(peer, s);
      if (pairs.length) {
        rows.push(statsRow(peer.name || shortPeer(peer.id), pairs, undefined, level ? { level, text: level } : null));
      }
    }
    rows.push(statsRow('you', ownPairs(total)));
    // The faults and the verdict sit in their own block above the graphs, so a
    // red line is the first thing on the panel and a healthy call needs no scroll.
    $('stats-sum').replaceChildren(...sealedAlarms(), statsSummary(live, state.peers.size));
    const legend = document.createElement('p');
    legend.className = 'slegend';
    legend.textContent = 'k is kbit/s and m is Mbit/s. The up arrow is what you send, the down arrow what you receive.';
    body.replaceChildren(...rows, ...sealedCards(), legend);
    drawStatsGraphs();
  } finally {
    state.statsBusy = false;
  }
}

// ---------------------------------------------------------------- sealing
//
// Every room is sealed end to end and keeps the stage and the plumbing of any
// call, with three differences from a relayed one: the join never carries a
// name, the chat never uses the server `chat` message, and every encoded media
// frame goes through an AES-GCM transform in a worker. The keys come from the
// WebAssembly build of X25519 + ML-KEM-768 (static/pq.wasm) through the JSON
// bridge in wasm_exec.js, so the relay only ever sees opaque blobs.
// The wasm and its shim must be the build this page is. app.js carries the
// build query, so both fetches inherit it and a cached old pair can never meet
// a newer page, which would fail every handshake without a word.
const BUILD_Q = '?' + ((/** @type {HTMLScriptElement} */ (document.currentScript) || { src: '' }).src.split('?')[1] || 'v=1');

// The short code is 13 base32 characters, which is fine to compare on a screen
// but clumsy to read aloud. The same bits are shown as six OpenMoji drawings
// with a different shape and a different name each, so two people on a voice
// call can compare them without spelling anything and without confusing two of
// them. The third field is the file name of the drawing in static/openmoji.
const VERIFY_EMOJI = [
  ['⚓', 'anchor', '2693'], ['🔔', 'bell', '1F514'], ['🚲', 'bicycle', '1F6B2'], ['🌵', 'cactus', '1F335'],
  ['📷', 'camera', '1F4F7'], ['🕯', 'candle', '1F56F'], ['🥕', 'carrot', '1F955'], ['🕐', 'clock', '1F550'],
  ['☁️', 'cloud', '2601'], ['👑', 'crown', '1F451'], ['🐬', 'dolphin', '1F42C'], ['🐉', 'dragon', '1F409'],
  ['🥁', 'drum', '1F941'], ['🦅', 'eagle', '1F985'], ['🐟', 'fish', '1F41F'], ['👻', 'ghost', '1F47B'],
  ['🎸', 'guitar', '1F3B8'], ['🔨', 'hammer', '1F528'], ['🚁', 'helicopter', '1F681'], ['🔑', 'key', '1F511'],
  ['🧲', 'magnet', '1F9F2'], ['🍄', 'mushroom', '1F344'], ['🦉', 'owl', '1F989'], ['✏️', 'pencil', '270F'],
  ['🚀', 'rocket', '1F680'], ['✂️', 'scissors', '2702'], ['🚢', 'ship', '1F6A2'], ['☀️', 'sun', '2600'],
  ['☂️', 'umbrella', '2602'], ['🎻', 'violin', '1F3BB'], ['🐝', 'bee', '1F41D'], ['🐌', 'snail', '1F40C'],
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

// The associated data names the protocol version, the pair and the sequence
// number of the frame, so a blob sealed for one pair can not be replayed into
// another, and one captured frame can not be shown twice.
function chatAAD(peerId, seq) {
  return sealUtf8.encode('pq-e2e v2 chat ' + pairLabel(peerId) + ' ' + seq);
}

// A file chunk uses the chat key of the pair and the same shape of associated
// data: the version, the pair, the sender, the transfer id and the chunk
// number. The sender id is written the same way on both sides, so a chunk can
// not be moved to another pair or another transfer, and the chunk number must
// rise by one in the order the data channel delivers it.
function fileAAD(peerId, fromId, xfer, seq) {
  return sealUtf8.encode('pq-e2e v2 file ' + pairLabel(peerId) + ' from ' + String(fromId) + ' ' + xfer + ' ' + seq);
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

// wasm_exec.js is fetched when the lobby opens, so the join form paints first.
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (win().Go) return resolve(null);
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
    if (!window.WebAssembly || typeof Go !== 'function') return reject(new Error('webassembly unavailable'));
    const go = new Go();
    fetch('/pq.wasm' + BUILD_Q)
      .then((res) => {
        if (!res.ok) throw new Error('wasm ' + res.status);
        return WebAssembly.instantiateStreaming(res, go.importObject);
      })
      .catch(async () => {
        const res = await fetch('/pq.wasm' + BUILD_Q);
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
  const k1 = JSON.parse(pq.idgen());
  const k2 = JSON.parse(pq.idgen());
  const sidA = b64e(crypto.getRandomValues(new Uint8Array(16)));
  const sidB = b64e(crypto.getRandomValues(new Uint8Array(16)));
  const off = JSON.parse(pq.initiate(JSON.stringify({
    self: 'a', peer: 'b',
    selfX: a.xpub, selfK: a.ek, selfID: k1.pub, selfSID: sidA,
    peerX: b.xpub, peerK: b.ek, peerID: k2.pub, peerSID: sidB,
  })));
  const helloSig = JSON.parse(pq.idsign(JSON.stringify({ seed: k1.seed, msg: off.transcript })));
  const acc = JSON.parse(pq.respond(JSON.stringify({
    self: 'b', peer: 'a',
    selfX: b.xpub, selfSK: b.xsk, selfK: b.ek, selfDK: b.dk, selfID: k2.pub, selfSID: sidB,
    peerX: a.xpub, peerK: a.ek, peerID: k1.pub, peerSID: sidA,
    epk: off.epk, ct: off.ct, sig: helloSig.sig,
  })));
  const okSig = JSON.parse(pq.idsign(JSON.stringify({ seed: k2.seed, msg: acc.transcript })));
  // Both sides pass the same gate: the peer's identity signature and its
  // confirmation tag. A missing signature on either side is refused.
  const verifyA = JSON.parse(pq.proved(JSON.stringify({
    key: off.keys.recvMedia, transcript: off.transcript, tag: acc.confirm,
    id: k2.pub, sig: okSig.sig,
  })));
  const verifyB = JSON.parse(pq.proved(JSON.stringify({
    key: acc.keys.recvMedia, transcript: off.transcript, tag: off.confirm,
    id: k1.pub, sig: helloSig.sig,
  })));
  const verifyNoSig = JSON.parse(pq.proved(JSON.stringify({
    key: off.keys.recvMedia, transcript: off.transcript, tag: acc.confirm, id: k2.pub, sig: '',
  })));
  const pt = b64e(sealUtf8.encode('sealed hello'));
  const aad = b64e(sealUtf8.encode('pq-e2e v2 chat a|b 1'));
  const sealed = JSON.parse(pq.seal(JSON.stringify({ key: off.keys.sendChat, aad, pt })));
  const opened = JSON.parse(pq.open(JSON.stringify({
    key: acc.keys.recvChat, aad, b: sealed.b,
  })));
  const wrong = JSON.parse(pq.open(JSON.stringify({
    key: b64e(crypto.getRandomValues(new Uint8Array(32))), aad, b: sealed.b,
  })));
  // The identity half: one key signs the transcript, the other does not verify
  // it, and a tampered message never verifies. The same check runs here, so a
  // broken bridge shows up in the stats panel before a call starts.
  const idOk = JSON.parse(pq.idverify(JSON.stringify({ id: k1.pub, msg: off.transcript, sig: helloSig.sig })));
  const idOther = JSON.parse(pq.idverify(JSON.stringify({ id: k2.pub, msg: off.transcript, sig: helloSig.sig })));
  const idOk2 = JSON.parse(pq.idverify(JSON.stringify({ id: k2.pub, msg: acc.transcript, sig: okSig.sig })));
  const idTampered = JSON.parse(pq.idverify(JSON.stringify({
    id: k1.pub, msg: b64e(sealUtf8.encode('another transcript')), sig: helloSig.sig,
  })));
  const idFp = JSON.parse(pq.idfp(JSON.stringify({ id: k1.pub })));
  // A hello without a signature is refused, which is the downgrade path.
  const noSig = JSON.parse(pq.respond(JSON.stringify({
    self: 'b', peer: 'a',
    selfX: b.xpub, selfSK: b.xsk, selfK: b.ek, selfDK: b.dk, selfID: k2.pub, selfSID: sidB,
    peerX: a.xpub, peerK: a.ek, peerID: k1.pub, peerSID: sidA,
    epk: off.epk, ct: off.ct,
  })));
  return {
    sas: off.keys.sas,
    sasMatch: off.keys.sas === acc.keys.sas,
    confirm: !!(verifyA.ok && verifyB.ok && !verifyNoSig.ok),
    open: opened.pt === pt,
    wrongKeyRefused: !!wrong.error,
    idSign: idOk.ok === true && idOther.ok === false && idOk2.ok === true && idTampered.ok === false,
    idUnsigned: !!noSig.error,
    idFp: /^[a-z2-7]{4}(-[a-z2-7]{4}){4}$/.test(idFp.fp || ''),
  };
}

// ensureWasm loads the script, the module and the self test once. A failure is
// remembered as a failure of that attempt only, so a reload of the page (or a
// second click) can try again.
let wasmLoad = null;

function ensureWasm() {
  if (state.wasmOk) return Promise.resolve();
  if (wasmLoad) return wasmLoad;
  wasmLoad = loadScriptOnce('/wasm_exec.js' + BUILD_Q)
    .then(loadWasmModule)
    .then(() => {
      const test = pqSelfTest();
      state.wasmTest = test;
      if (!test.sasMatch || !test.confirm || !test.open || !test.wrongKeyRefused ||
        !test.idSign || !test.idUnsigned || !test.idFp) {
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

// preloadSealed warms the module as soon as the lobby opens, so the join itself
// is only a microphone prompt. A failure stays in the note, and the join says
// it again.
function preloadSealed() {
  $('sealed-note').hidden = false;
  $('sealed-note').textContent = 'loading the post-quantum module';
  ensureReady()
    .then(() => {
      if (!$('lobby').hidden) $('sealed-note').textContent = 'pq-e2e ready, ' + deviceNote();
    })
    .catch((err) => {
      if (!$('lobby').hidden) {
        $('sealed-note').textContent = 'the sealed client did not start: '
          + (err && err.message ? err.message : err);
      }
    });
}

// ensureReady is everything a sealed join needs before it draws the stage: the
// module, the long-term identity and the pins.
function ensureReady() {
  return ensureWasm().then(ensureIdentity);
}

// ------------------------------------------------------------- identity and pins
//
// The long-term identity is Ed25519 and signing only: it signs the handshake
// transcript and is never a KDF input, never does static ECDH and never takes a
// KEM encapsulation, so a stolen copy can impersonate a pinned peer and can
// decrypt nothing. It lives in IndexedDB, non-extractable where the browser can
// hold such a key, and never in localStorage, a cookie or the server. A browser
// that can not keep a key gets a fresh one per page load and says so.

const ID_DB = 'stanze-identity';
const ID_CHALLENGE = 'stanze identity';
const ID_NOTE = {
  kept: 'the identity is kept in this browser',
  fresh: 'the stored identity could not be reopened: a new key for this page',
  session: 'this browser keeps no identity: a new key each load, the device stays unverified',
};

let idDb = null;

// idStore opens the one local database: the identity, the pins this guest made
// and the fingerprints a pin replaced. No session material is ever written.
function idStore() {
  if (idDb) return idDb;
  idDb = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('no indexeddb'));
      return;
    }
    const req = indexedDB.open(ID_DB, 1);
    req.onupgradeneeded = () => {
      for (const name of ['id', 'pins', 'revoked']) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb refused'));
  });
  // A failed open is not remembered, so a later attempt can still work.
  idDb.catch(() => { idDb = null; });
  return idDb;
}

function idbRequest(store, mode, fn) {
  return idStore().then((db) => new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbGet(store, key) { return idbRequest(store, 'readonly', (s) => s.get(key)); }

function idbAll(store) { return idbRequest(store, 'readonly', (s) => s.getAll()); }

function idbPut(store, key, value) { return idbRequest(store, 'readwrite', (s) => s.put(value, key)); }

function idbDelete(store, key) { return idbRequest(store, 'readwrite', (s) => s.delete(key)); }

function fingerprint(pub) {
  const out = pqCall((json) => pqModule().idfp(json), { id: pub });
  return out && out.fp ? out.fp : '';
}

// provesKey checks that a stored record still signs for its own public key. A
// browser that kept a CryptoKey it can not use (Safari has done that) fails here
// rather than in the first handshake.
async function provesKey(pub, sign) {
  if (!pub || typeof sign !== 'function') return false;
  const msg = b64e(sealUtf8.encode(ID_CHALLENGE));
  let sig = '';
  try { sig = await sign(msg); } catch { /* an unusable key */ }
  const res = pqCall((json) => pqModule().idverify(json), { id: pub, msg, sig });
  return !!(res && res.ok);
}

// subtleIdentity is the preferred shape: WebCrypto holds a non-extractable
// Ed25519 key and no script can export it, not even this origin.
function subtleIdentity(key, pub) {
  return {
    kind: 'webcrypto', pub, fp: fingerprint(pub),
    sign: (msg) => crypto.subtle.sign({ name: 'Ed25519' }, key, b64d(msg)).then(b64e),
    store: () => ({ kind: 'webcrypto', key, pub }),
  };
}

// seedIdentity is the fallback: the wasm module signs with a 32 byte seed, and
// the record on disk keeps that seed sealed under a non-extractable AES-GCM key,
// so an offline copy of the database is useless without this profile.
function seedIdentity(seed, pub, kind) {
  return {
    kind, pub, fp: fingerprint(pub), seed,
    sign: async (msg) => {
      const out = pqCall((json) => pqModule().idsign(json), { seed: b64e(seed), msg });
      return out && out.sig ? out.sig : '';
    },
    store: async () => {
      const wrap = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrap, seed));
      return { kind: 'sealed', wrap, iv, ct, pub };
    },
  };
}

function createIdentity() {
  return Promise.resolve()
    .then(() => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']))
    .then(async (pair) => subtleIdentity(pair.privateKey, b64e(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))))
    .catch(() => {
      // No WebCrypto Ed25519 (Chromium before 137, older Safari): the module
      // draws the identity and keeps the seed for as long as this page lives.
      const made = pqCall((json) => pqModule().idgen(json), {});
      return made && made.pub && made.seed ? seedIdentity(b64d(made.seed), made.pub, 'sealed') : null;
    });
}

async function reopenIdentity(rec) {
  if (!rec || !rec.pub) return null;
  let key = null;
  try {
    if (rec.kind === 'webcrypto' && rec.key) {
      key = subtleIdentity(rec.key, rec.pub);
    } else if (rec.kind === 'sealed' && rec.wrap && rec.iv && rec.ct) {
      const seed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, rec.wrap, rec.ct));
      key = seedIdentity(seed, rec.pub, 'sealed');
    }
  } catch {
    return null;
  }
  return key && await provesKey(rec.pub, key.sign) ? key : null;
}

function loadPins() {
  return Promise.all([idbAll('pins'), idbAll('revoked')])
    .then(([pins, revoked]) => {
      for (const rec of pins || []) if (rec && rec.label && rec.fp) state.pins.set(rec.label, rec);
      for (const rec of revoked || []) if (rec && rec.fp) state.revoked.set(rec.fp, rec);
    })
    .catch(() => { /* no local database: the pins live in this page only */ });
}

let identityLoad = null;

// ensureIdentity loads or creates the long-term key and the pins, once per page.
function ensureIdentity() {
  if (identityLoad) return identityLoad;
  identityLoad = (async () => {
    await loadPins();
    let rec = null;
    try { rec = await idbGet('id', 'self'); } catch { /* no local database */ }
    let key = await reopenIdentity(rec);
    if (key) {
      state.device = 'kept';
    } else {
      key = await createIdentity();
      if (!key) throw new Error('no identity key');
      state.device = rec ? 'fresh' : 'kept';
      try {
        await idbPut('id', 'self', await key.store());
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
          navigator.storage.persist().catch(() => {});
        }
      } catch {
        // Private mode, or a browser that refuses the record: the key still
        // works for this page, and the device is honest about not being kept.
        key.kind = 'session';
        state.device = 'session';
      }
    }
    state.idKey = key;
    return key;
  })().catch((err) => {
    identityLoad = null;
    throw err;
  });
  return identityLoad;
}

function deviceNote() {
  return ID_NOTE[state.device] || ID_NOTE.session;
}

// pinState says what the fingerprint a peer proved means here. A pin is stored
// by fingerprint, never by a name the peer chose, so nobody can claim a label.
// A fingerprint this browser revoked and now sees again is the alarm: a key
// that was replaced can not come back unless something replays it.
function pinState(peer) {
  if (peer.pin === 'changed') return 'changed';
  if (!peer.fp) return 'new';
  if (state.revoked.has(peer.fp)) return 'rollback';
  for (const rec of state.pins.values()) if (rec.fp === peer.fp) return 'known';
  return 'new';
}

// pinLabelOf is the label this browser pinned under the fingerprint of a peer.
function pinLabelOf(peer) {
  for (const rec of state.pins.values()) if (rec.fp === peer.fp) return rec.label;
  return peer.pinLabel || '';
}

// pinPeer attaches the fingerprint a guest is showing to a local label. A label
// that already holds another fingerprint is the changed state, and the guest
// decides what happens next; nothing is overwritten in silence.
function pinPeer(peer, label) {
  if (!peer || !peer.fp) return 'new';
  const name = String(label || pinLabelOf(peer) || peer.name || shortPeer(peer.id)).slice(0, 32);
  const held = state.pins.get(name);
  if (held && held.fp !== peer.fp) {
    peer.pin = 'changed';
    peer.pinLabel = name;
    paintPin(peer);
    return 'changed';
  }
  const now = Date.now();
  const rec = { label: name, fp: peer.fp, first: held ? held.first : now, last: now };
  state.pins.set(name, rec);
  idbPut('pins', name, rec).catch(() => {});
  if (state.revoked.has(peer.fp)) {
    state.revoked.delete(peer.fp);
    idbDelete('revoked', peer.fp).catch(() => {});
  }
  peer.pin = '';
  peer.pinLabel = name;
  paintPin(peer);
  return 'known';
}

// renamePin moves a pin to a new label and keeps its fingerprint and first
// sighting. A name that already holds another key goes through pinPeer, so a
// rename can never hide a swapped device.
function renamePin(peer, label) {
  if (!peer || pinState(peer) !== 'known') return 'new';
  const old = pinLabelOf(peer);
  const name = String(label || '').trim().slice(0, 32);
  if (!name || name === old) return 'known';
  const held = state.pins.get(name);
  if (held && held.fp !== peer.fp) return pinPeer(peer, name);
  const was = state.pins.get(old);
  state.pins.delete(old);
  idbDelete('pins', old).catch(() => {});
  const now = Date.now();
  state.pins.set(name, { label: name, fp: peer.fp, first: was ? was.first : now, last: now });
  idbPut('pins', name, state.pins.get(name)).catch(() => {});
  peer.pin = '';
  peer.pinLabel = name;
  paintPin(peer);
  return 'known';
}

// resetDevice is the calm path of a changed identity: the guest was told that
// the other device was reset, so the old fingerprint stays remembered as revoked
// and the new one takes the label. It is a deliberate click, never automatic.
function resetDevice(peer, label) {
  const name = String(label || pinLabelOf(peer) || peer.name || shortPeer(peer.id)).slice(0, 32);
  const held = state.pins.get(name);
  if (held && held.fp && held.fp !== peer.fp) {
    const gone = { fp: held.fp, label: name, at: Date.now() };
    state.revoked.set(gone.fp, gone);
    idbPut('revoked', gone.fp, gone).catch(() => {});
    state.pins.delete(name);
    idbDelete('pins', name).catch(() => {});
  }
  peer.pin = '';
  const state_ = pinPeer(peer, name);
  // A pair that was closed for a changed identity gets one more handshake, now
  // that the guest has said the other device was reset.
  if (!peer.proven) sealedRestart(peer, true);
  return state_;
}

function verifiedPeers() {
  let n = 0;
  for (const peer of state.peers.values()) if (peer.fp && pinState(peer) === 'known') n++;
  return n;
}

// updatePinCount is the room summary at the far end of the status line: how
// many guests this browser can name by identity, out of the guests present.
// The chip is green when every guest is verified and red when one is not; a
// pair whose keys do not match keeps it red and the title names that pair.
function updatePinCount() {
  const el = $('pin-count');
  if (!el) return;
  const total = state.peers.size;
  const known = verifiedPeers();
  const failed = sealedFailedPairs();
  el.hidden = total === 0;
  el.textContent = total ? `verified ${known}/${total}` : '';
  el.dataset.verified = total > 0 && known === total && failed.length === 0 ? 'all' : 'part';
  if (total === 0) {
    el.removeAttribute('title');
  } else if (failed.length > 0) {
    el.title = 'the keys do not match with ' + sealedPairNames(failed) + ', so do not trust this call';
  } else {
    el.title = `${known} of ${total} guests present an identity this browser pinned; each pair has its own code on its tile`;
  }
}

function paintPin(peer) {
  updatePinCount();
  paintState(peer);
  const idRow = peer.tile ? peer.tile.querySelector('.sas .id-row') : null;
  if (idRow) idRow.replaceWith(sealedIdentityRow(peer));
  const chip = peer.tile ? peer.tile.querySelector('.pin') : null;
  if (!chip) return;
  const what = pinState(peer);
  chip.hidden = !peer.fp;
  chip.dataset.pin = what === 'rollback' ? 'changed' : what;
  chip.textContent = what === 'known' ? pinLabelOf(peer)
    : what === 'changed' ? 'identity changed'
      : what === 'rollback' ? 'old key came back'
        : 'unverified';
  chip.title = peer.fp ? 'identity ' + peer.fp : '';
  // A named device keeps its pin, so the name can change later without asking
  // for the fingerprint again. The click is the whole interface.
  const named = what === 'known';
  chip.dataset.action = named ? 'rename' : '';
  if (named) {
    chip.title = (chip.title ? chip.title + ' | ' : '') + 'click to rename';
    chip.onclick = () => renamePin(peer, prompt('new name for this device', pinLabelOf(peer)) || '');
  } else {
    chip.onclick = null;
  }
}

// storageAudit lists what this page keeps on disk, so the browser test can say
// plainly that no session secret is in it.
async function storageAudit() {
  const out = { local: Object.keys(localStorage), stores: {}, keys: 0 };
  try {
    const db = await idStore();
    for (const name of db.objectStoreNames) {
      const rows = await idbAll(name);
      out.stores[name] = rows.map((row) => {
        const shape = {};
        for (const [k, v] of Object.entries(row || {})) {
          if (v instanceof Uint8Array) shape[k] = 'bytes:' + v.length;
          else if (v && v.type) shape[k] = 'key:' + v.type;
          else if (typeof v === 'string') shape[k] = v.length > 40 ? 'string:' + v.length : v;
          else shape[k] = typeof v;
        }
        return shape;
      });
    }
  } catch {
    out.stores = null;
  }
  return out;
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
      const waiting = state.keyWait.get(msg.pair);
      // An import that belongs to an older handshake must not open this gate:
      // the slot it filled may already hold newer keys.
      if (waiting && waiting.gen === msg.gen) {
        state.keyWait.delete(msg.pair);
        waiting.resolve(true);
      }
    } else if (msg.type === 'sample') {
      if (state.samples.length < 40) state.samples.push(msg);
    } else if (msg.type === 'error') {
      state.workerErrors.push(msg.msg || 'worker error');
      // A key import that failed resolves the gate false. The pair says so and
      // never builds a connection that can only drop frames.
      const waiting = msg.pair && state.keyWait.get(msg.pair);
      if (waiting && (msg.gen === undefined || waiting.gen === msg.gen)) {
        state.keyWait.delete(msg.pair);
        waiting.resolve(false);
        say('the frame keys did not install; the link stays without video');
      }
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

// ------------------------------------------------------------- handshake
//
// The bundle carries the per-call keys, the long-term identity and a session id
// that is fresh on every join. Both sides sign the same transcript and each one
// checks the other's signature and confirmation tag in one gate, so there is no
// half-proven pair: the initiator knows who answered, and the responder knows
// who asked. The keys themselves are still HKDF over the ephemeral secrets
// alone, and they only reach the worker once that gate has passed.

function sealedSendPub(peer) {
  if (!state.identity || !state.idKey) return;
  sealedSendOpaque(peer.id, {
    k: 'pub', x: state.identity.xpub, m: state.identity.ek, id: state.idKey.pub, sid: state.sid,
  });
}

// sealedRefuse closes a pair for good. There is no path that continues without
// an identity: a relay that strips the fields would otherwise leave a working
// pair with no authentication at all, which is exactly the downgrade.
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

// sealedRestart drops a pair's state so a new handshake can run. The deliberate
// case is "this device was reset", which re-pins and starts over; the automatic
// case is a peer that comes back with a fresh session id.
function sealedRestart(peer, resend) {
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
  // Frames held for the old pair can never open with the new keys.
  peer.appPending = [];
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

// sealedOnPub decides which side initiates: the lower peer id. The other side
// answers the hello. A duplicate bundle is harmless; a bundle with a new session
// id is the same guest on a fresh call, so the old pair goes first.
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
}

// wipeKeys zeroes one pair's secrets. They are the only copies outside the
// worker and the module, and they last as long as the pair does.
function wipeKeys(peer) {
  if (!peer || !peer.keys) return;
  for (const value of Object.values(peer.keys)) {
    if (value instanceof Uint8Array) value.fill(0);
  }
  peer.keys = null;
  peer.keysInstalled = false;
}

// wipeIdentity zeroes the per-call X25519 and ML-KEM secret halves.
function wipeIdentity() {
  if (!state.identity) return;
  for (const name of ['xsk', 'dk']) {
    const value = state.identity[name];
    if (value instanceof Uint8Array) value.fill(0);
  }
  state.identity = null;
}

// sealedHoldKeys keeps the agreed pair keys in this page until the peer has
// proved itself. They are not handed to the worker yet, so no frame of this
// pair can be opened before the identity is checked.
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
      type: 'keys', pair, peer: peer.id, gen,
      enc: b64e(peer.keys.sendMedia), dec: b64e(peer.keys.recvMedia),
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

async function sealedInitiate(peer) {
  if (!state.identity || !state.idKey || !peer.pub) return;
  const out = pqCall((json) => pqModule().initiate(json), {
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
  });
  if (!out || out.error) {
    sealedRefuse(peer, 'refused the key bundle');
    return;
  }
  const sig = await state.idKey.sign(out.transcript);
  if (!state.peers.has(peer.id) || state.leaving) return;
  if (!sig) {
    sealedRefuse(peer, 'could not sign the handshake');
    return;
  }
  sealedHoldKeys(peer, out);
  peer.mySig = sig;
  sealedSendOpaque(peer.id, {
    k: 'hello', epk: out.epk, ct: out.ct, id: state.idKey.pub, sid: state.sid, sig,
  });
  // Our own confirmation and signature go out at once, so the responder can
  // check us as soon as it has its keys. The same transcript covers both sides.
  peer.sentConfirm = true;
  sealedSendOpaque(peer.id, {
    k: 'ok', c: out.confirm, id: state.idKey.pub, sid: state.sid, sig,
  });
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
    self: state.self,
    peer: peer.id,
    selfX: state.identity.xpub,
    selfSK: b64e(state.identity.xsk),
    selfK: state.identity.ek,
    selfDK: b64e(state.identity.dk),
    selfID: state.idKey.pub,
    selfSID: state.sid,
    peerX: peer.pub.x,
    peerK: peer.pub.m,
    peerID: peer.pub.id,
    peerSID: peer.pub.sid,
    epk: msg.epk,
    ct: msg.ct,
    sig: msg.sig || '',
  });
  if (!out || out.error) {
    sealedRefuse(peer, 'refused the hello');
    return;
  }
  const sig = await state.idKey.sign(out.transcript);
  if (!state.peers.has(peer.id) || state.leaving) return;
  if (!sig) {
    sealedRefuse(peer, 'could not sign the handshake');
    return;
  }
  sealedHoldKeys(peer, out);
  peer.mySig = sig;
  peer.sentConfirm = true;
  sealedSendOpaque(peer.id, {
    k: 'ok', c: out.confirm, id: state.idKey.pub, sid: state.sid, sig,
  });
  // The pair is not ready yet: the initiator's own ok still has to prove it,
  // which is the half that used to be missing. That ok may have arrived while
  // this hello was still being answered, so the hold is drained here.
  sealedDrainCtl(peer);
}

// sealedOnProof is an `ok` from the peer, on either side. Nothing about the
// pair is announced as established until this passes: the signature names the
// peer, the tag shows that both ends hold the same keys, and the pin state
// decides whether that name is one this browser already trusts.
async function sealedOnProof(peer, msg) {
  if (!peer.keys || !peer.pub || !peer.transcript) return;
  if (peer.confirmed) return;
  if (msg.id !== peer.pub.id || msg.sid !== peer.pub.sid) {
    // A proof for another session is the old handshake arriving late, not an
    // attack: the gate below checks the signature over *this* transcript, so
    // a real mismatch still fails there. Dropping it here would tear down the
    // fresh pair whenever a rejoin crossed its own tail.
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
  // The pin is the answer to "who", and it is checked before anything is
  // established. A revoked key that comes back is an alarm, and a label that
  // already holds another key is the changed state: both close the pair, and
  // the guest can say that the device was reset.
  const pin = pinState(peer);
  if (pin === 'rollback' || pin === 'changed') {
    sealedRefuse(peer, pin === 'rollback'
      ? 'came back with an identity this browser revoked'
      : 'proved an identity another label here holds');
    return;
  }
  peer.keyPromise = sealedInstallKeys(peer);
  sealedSetE2E(peer, 'ready');
  // The name and the offer both wait for the keys in the worker: a name sent
  // before that point is dropped by the guard and would never be sent again.
  Promise.resolve(peer.keyPromise).then((ok) => {
    if (!ok || !state.peers.has(peer.id) || state.leaving) return;
    sealedAnnounceName(peer);
    for (const held of peer.appPending || []) sealedHandleOpaque(peer.id, encOpaque(held));
    peer.appPending = [];
    if (!peer.pc && String(state.self) < String(peer.id)) connectPeer(peer.id, true);
  });
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

function sealedHandleOpaque(from, b) {
  const peer = state.peers.get(from);
  if (!peer) return;
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
    key: b64e(peer.keys.recvChat), aad: b64e(chatAAD(peer.id, seq)), b,
  });
  if (!out || out.error) return;
  let obj;
  try {
    obj = decOpaque(out.pt);
  } catch {
    return;
  }
  peer.seqIn = seq;
  if (obj.k === 'name') {
    sealedSetName(peer, obj.n);
  } else if (obj.k === 'chat') {
    state.chatRecv++;
    addChatLine(peer.name || shortPeer(peer.id), String(obj.x || ''), Date.now());
  } else if (obj.k === 'file') {
    fileOnMessage(peer, obj);
  }
}

function sealedAnnounceName(peer) {
  if (!peer.keys || !state.name || peer.announcedName === state.name) return;
  peer.announcedName = state.name;
  sealedSend(peer, { k: 'name', n: state.name });
}

function sealedSend(peer, obj) {
  if (!peer.keys) return;
  const seq = peer.seqOut + 1;
  const out = pqCall((json) => pqModule().seal(json), {
    key: b64e(peer.keys.sendChat),
    aad: b64e(chatAAD(peer.id, seq)),
    pt: b64e(sealUtf8.encode(JSON.stringify(obj))),
  });
  if (!out || !out.b) return;
  peer.seqOut = seq;
  sealedSendOpaque(peer.id, { k: 'app', q: seq, b: out.b });
}

function sendSealedChat() {
  const input = $('chat-text');
  const text = (input.value || '').trim();
  if (!text || !state.self) return;
  input.value = '';
  canary(text);
  addChatLine(state.name, text, Date.now());
  state.chatSent++;
  for (const peer of state.peers.values()) {
    if (!peer.keys) continue;
    sealedSend(peer, { k: 'chat', n: state.name, x: text, ts: Date.now() });
  }
}

// sealedSetName paints the decrypted name. The volume is kept under the peer
// key, so a name that arrives late never moves it.
function sealedSetName(peer, raw) {
  const name = cleanSealedName(raw);
  if (!name || peer.name === name) return;
  peer.name = name;
  if (peer.tile) paintName(peer.tile, name, false);
}

// sealedSetE2E paints the key state and the short code on one tile.
function sealedSetE2E(peer, status) {
  peer.ready = status;
  updatePinCount();
  if (!peer.tile) return;
  peer.tile.dataset.e2e = status;
  paintState(peer);
  paintPin(peer);
  const sas = /** @type {HTMLElement} */ (peer.tile.querySelector('.sas'));
  if (!sas) return;
  if (!peer.sas) {
    sas.hidden = true;
    sas.replaceChildren();
    sas.removeAttribute('title');
    return;
  }
  sas.hidden = false;
  sas.replaceChildren(...sealedCodePanel(peer));
  // The names behind the drawings are a title, so a screen reader and a
  // nervous guest can both tell what they are looking at.
  sas.title = verifyNames(peer.sas) + ' (' + peer.sas + ')';
}

// paintState is the one place a tile says how far the link is. A ready link is
// called unverified, in red, until its fingerprint is one this browser pinned.
// Once it is pinned the words go away: the tile then carries the guest's own
// label and a green chip, and a second label beside the name says nothing new.
// A signature alone proves continuity inside the call, which is a weaker claim.
function paintState(peer) {
  if (!peer.tile) return;
  const badge = peer.tile.querySelector('.state');
  if (!badge) return;
  const known = peer.ready === 'ready' && pinState(peer) === 'known';
  badge.hidden = known;
  badge.dataset.e2e = known ? 'known'
    : peer.ready === 'ready' ? 'unverified'
      : peer.ready === 'failed' ? 'failed'
        : '';
  badge.textContent = known ? ''
    : peer.ready === 'ready' ? 'e2e unverified'
      : peer.ready === 'failed' ? 'e2e FAILED'
        : peer.ready || '';
}

// sealedCodePanel builds the code card of one guest: a small heading, the six
// OpenMoji drawings, the code in groups of four, and the identity line. The two
// prove different things and the card keeps them apart: the code proves that
// this pair shares one secret now, the fingerprint names who the peer is.
// Neither tells how long the secret will live, which is one call.
function sealedCodePanel(peer) {
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
  state.textContent = what === 'changed' ? 'changed'
    : what === 'rollback' ? 'old key back' : 'unverified';
  const which = document.createElement('span');
  which.className = 'id-fp';
  which.textContent = peer.fp || 'no fingerprint yet';
  // a pinned pair shows its label as the button: one click renames it
  if (what === 'known') {
    row.append(pinButton(pinLabelOf(peer) || 'pinned',
      () => renamePin(peer, prompt('new name for this device', pinLabelOf(peer)) || '')));
  } else row.append(state);
  row.append(which);
  if (what === 'new' && peer.fp) {
    row.append(pinButton('pin this device', () => pinPeer(peer, prompt('label for this device', peer.name) || '')));
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

// ------------------------------------------------------------- sealed signaling

// The code of a pair is derived from the keys of that pair, never from the
// local self test: that one is ours alone and proves nothing about the other
// side. A mesh has one pair per two guests, so two different codes in one room
// are normal and only the code of one pair can be checked by voice. A pair
// whose key confirmation failed is the alarm, and it stays on that pair.
function sealedRoomCodes() {
  const codes = new Set();
  for (const peer of state.peers.values()) if (peer.sas) codes.add(peer.sas);
  return codes;
}

function sealedRoomCode() {
  const codes = sealedRoomCodes();
  return codes.size === 1 ? [...codes][0] : '';
}

function sealedFailedPairs() {
  const out = [];
  for (const peer of state.peers.values()) if (peer.ready === 'failed') out.push(peer);
  return out;
}

function sealedPairNames(pairs) {
  return pairs.map((peer) => peer.name || shortPeer(peer.id)).join(', ');
}

async function sealedOnOffer(peer, sdp) {
  if (state.leaving) return;
  // The answer is made from the keys the worker holds. A first frame without
  // them stays sealed, and no retry brings it back.
  if (peer.keyPromise && !(await peer.keyPromise.catch(() => false))) {
    sealedSetE2E(peer, 'failed');
    return;
  }
  if (!state.peers.has(peer.id)) return; // the peer left while the keys installed
  const target = connectPeer(peer.id, false);
  await onDescription(target, 'offer', sdp);
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

// sealedAlarms are the lines that mean something is wrong now. A healthy call
// shows none of them, so the panel opens on the numbers and not on a warning
// that has to be read twice to be dismissed.
function sealedAlarms() {
  const out = [];
  if (state.sealFault) out.push(statsRow('sealing fault', [['', state.sealFault, false]]));
  const failed = sealedFailedPairs();
  if (failed.length) {
    const tags = failed.map((peer) => `${peer.name || shortPeer(peer.id)} ${verifyText(peer.sas) || 'no code'}`);
    out.push(statsRow('room code', [
      ['', 'KEY MISMATCH ' + tags.join(', '), false],
      ['', 'do not trust this call', false],
    ]));
  }
  if (state.wireLeaks.length) {
    out.push(statsRow('leak', state.wireLeaks.map((w) => ['', `${w.where}: ${w.canary}`, false])));
  }
  if (state.workerErrors.length) {
    out.push(statsRow('worker', state.workerErrors.slice(0, 5).map((e) => ['', e, false])));
  }
  const wt = state.wasmTest;
  if (wt && !wasmTestOk(wt)) out.push(statsRow('self test', wasmTestFaults(wt)));
  return out;
}

function wasmTestOk(wt) {
  return !!(wt.sasMatch && wt.confirm && wt.open && wt.wrongKeyRefused &&
    wt.idSign && wt.idUnsigned && wt.idFp);
}

// wasmTestFaults lists only the checks that failed.
// The whole list belongs in the test output, not on a screen a guest reads
// during a call.
/** @returns {(string | boolean)[][]} */
function wasmTestFaults(wt) {
  const bad = [
    ['sas ', wt.sasMatch ? 'match' : 'no', !!wt.sasMatch],
    ['confirm ', wt.confirm ? 'ok' : 'no', !!wt.confirm],
    ['open ', wt.open ? 'ok' : 'no', !!wt.open],
    ['wrong key ', wt.wrongKeyRefused ? 'refused' : 'OPENED', !!wt.wrongKeyRefused],
    ['identity ', wt.idSign ? 'signs' : 'BROKEN', !!wt.idSign],
    ['unsigned ', wt.idUnsigned ? 'refused' : 'ACCEPTED', !!wt.idUnsigned],
    ['fingerprint ', wt.idFp ? 'ok' : 'BROKEN', !!wt.idFp],
  ];
  const out = [['', 'FAIL', false]];
  for (const b of bad) if (!b[2]) out.push(b);
  return out;
}

// sealedCards is the crypto half of the panel, below the person cards: what
// the relay cannot see, in the few lines that answer it. A line that only
// repeats the suite or says "not run yet" is left out.
function sealedCards() {
  const out = [];
  const available = sealingAvailable();
  const wt = state.wasmTest;
  const seal = [['media ', available ? 'sealed, every frame' : 'NO SEALING, no media is sent', available]];
  if (wt) seal.push(['self test ', wasmTestOk(wt) ? 'pass' : 'FAIL', wasmTestOk(wt)]);
  out.push(statsRow('crypto', seal));

  let refused = 0;
  for (const st of Object.values(state.frames)) {
    if (st && st.dir === 'recv') refused += st.fail || 0;
  }
  const clean = state.workerErrors.length === 0;
  const counts = [
    ['frames ', `out ${state.encryptFrames} in ${state.decryptFrames} refused ${refused}`, refused === 0 && clean],
    ['wire ', `frames ${state.wireFrames} leaks ${state.wireLeaks.length}`, state.wireLeaks.length === 0],
  ];
  const files = state.fileOffers + state.fileRecv + state.fileChunksRecv + state.fileChunksSent +
    state.fileRefused + state.fileCancelled;
  if (files) {
    counts.push(['files ', `offers ${state.fileOffers} saved ${state.fileRecv} in ${state.fileChunksRecv} out ${state.fileChunksSent} refused ${state.fileRefused} cancelled ${state.fileCancelled}`,
      state.fileRefused === 0 && state.fileCancelled === 0]);
  }
  const chat = state.chatSent + state.chatRecv + state.replayDrops + state.confirmFailures + state.identityFailures;
  if (chat) {
    counts.push(['chat ', `out ${state.chatSent} in ${state.chatRecv} replays ${state.replayDrops}`,
      state.replayDrops === 0 && state.confirmFailures === 0 && state.identityFailures === 0]);
  }
  out.push(statsRow('counters', counts));
  return out;
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
    sender.transform = new RTCRtpScriptTransform(worker, {
      pair: 'lab', peer: 'lab', dir: 'send', kind: track.kind, from: 'lab',
    });
  }

  await pc1.setLocalDescription();
  await gathered(pc1);
  await pc2.setRemoteDescription(pc1.localDescription);
  for (const receiver of pc2.getReceivers()) {
    receiver.transform = new RTCRtpScriptTransform(worker, {
      pair: 'lab', peer: 'lab', dir: 'recv', kind: receiver.track.kind, from: 'lab',
    });
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
    fp: p.fp || '',
    pin: pinState(p),
    proven: !!p.proven,
    confirmed: !!p.confirmed,
    ready: p.tile ? (p.tile.dataset.e2e || p.ready) : p.ready,
    pc: p.pc ? p.pc.connectionState : 'none',
    dc: p.dc ? p.dc.readyState : 'none',
    videoW: p.video ? p.video.videoWidth : 0,
    videoT: p.video ? p.video.currentTime : 0,
    video: p.video,
  })),
  identity: () => (state.idKey
    ? { kind: state.idKey.kind, fp: state.idKey.fp, device: state.device, note: deviceNote(), sid: state.sid }
    : null),
  pins: () => [...state.pins.values()].map((r) => ({ label: r.label, fp: r.fp })),
  revoked: () => [...state.revoked.values()].map((r) => ({ label: r.label, fp: r.fp })),
  pin: (peerId, label) => {
    const peer = state.peers.get(peerId);
    return peer ? pinPeer(peer, label) : 'no peer';
  },
  resetDevice: (peerId, label) => {
    const peer = state.peers.get(peerId);
    return peer ? resetDevice(peer, label) : 'no peer';
  },
  rename: (peerId, label) => {
    const peer = state.peers.get(peerId);
    return peer ? renamePin(peer, label) : 'no peer';
  },
  storageAudit,
  pinCount: () => ({ verified: verifiedPeers(), total: state.peers.size }),
  pinState: (peerId) => {
    const peer = state.peers.get(peerId);
    return peer ? pinState(peer) : 'no peer';
  },
  counters: () => ({
    encryptFrames: state.encryptFrames,
    decryptFrames: state.decryptFrames,
    chatSent: state.chatSent,
    chatRecv: state.chatRecv,
    fileOffers: state.fileOffers,
    fileRecv: state.fileRecv,
    fileChunksSent: state.fileChunksSent,
    fileChunksRecv: state.fileChunksRecv,
    fileRefused: state.fileRefused,
    fileCancelled: state.fileCancelled,
    replayDrops: state.replayDrops,
    confirmFailures: state.confirmFailures,
    identityFailures: state.identityFailures,
    workerErrors: state.workerErrors,
    wireFrames: state.wireFrames,
    wireLeaks: state.wireLeaks,
    samples: state.samples,
  }),
  selfTest: pqSelfTest,
  lab: runLab,
};

// ---------------------------------------------------------------- relay badge

// paintRelay marks a tile when the link to that peer runs through the TURN
// relay. The selected pair is read once, when the link comes up; a reconnect
// runs this again.
async function paintRelay(peer) {
  try {
    let pair = null;
    const stats = await peer.pc.getStats();
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.selected) pair = r;
    });
    const local = pair && stats.get(pair.localCandidateId);
    peer.tile.dataset.relay = local && local.candidateType === 'relay' ? 'yes' : 'no';
  } catch {
    /* stats are best effort */
  }
}

// ---------------------------------------------------------------- boot

function init() {
  // Older builds kept a volume under the guest name. That is a list of the
  // people who used this machine, so it goes before anything else reads it.
  purgeNamedVolume();
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

  // The last microphone, camera, path and denoise choice comes back, like the
  // name. No stored value means on: the join asks for both by default. A
  // stored off is honoured, and that device is not asked for at all.
  state.mic = load('mic') !== '0';
  state.cam = load('cam') !== '0';
  // The chosen devices come back like the on and off choices. An id is opaque
  // and only meaningful inside this browser profile, so a stale one is simply
  // not found and the system device is used.
  state.camId = load('camId').slice(0, 256);
  state.micId = load('micId').slice(0, 256);
  const storedPath = load('path');
  if (['auto', 'p2p', 'relay'].includes(storedPath)) {
    state.path = storedPath;
    $('path').value = storedPath;
  }
  // The quality step comes back like the devices, and the picker shows it, so
  // the first camera request is already the chosen size.
  const storedQuality = load('quality');
  if (QUALITY[storedQuality]) {
    state.quality = storedQuality;
    $('quality').value = storedQuality;
  }
  state.noiseWanted = load('noise') !== '0';
  $('noise').checked = state.noiseWanted;
  $('noise-live').checked = state.noiseWanted;

  // The module is warming before the first click, so a failure is visible in
  // the lobby and the join is only a microphone prompt.
  preloadSealed();

  $('newid-btn').addEventListener('click', (event) => {
    event.preventDefault();
    suggestRoom();
  });

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    // Chrome ties the audio context to the click that created it. Create the
    // playback context here, before the first await, or the join starts with a
    // suspended context and the room stays silent while the video plays.
    ensurePlayback();
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
    sendSealedChat();
  });

  // A file goes into the chat either way: the button opens the picker and a
  // drop on the chat panel does the same without the picker.
  $('file-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => {
    const input = $('file-input');
    const files = input.files;
    const list = [];
    for (let i = 0; files && i < files.length; i++) list.push(files[i]);
    input.value = '';
    for (const file of list) fileOffer(file);
  });
  $('chat-panel').addEventListener('dragover', (event) => {
    event.preventDefault();
    $('chat-panel').classList.add('drop');
  });
  $('chat-panel').addEventListener('dragleave', () => $('chat-panel').classList.remove('drop'));
  $('chat-panel').addEventListener('drop', (event) => {
    event.preventDefault();
    $('chat-panel').classList.remove('drop');
    const drop = /** @type {DragEvent} */ (event);
    const files = drop.dataTransfer ? drop.dataTransfer.files : null;
    for (let i = 0; files && i < files.length; i++) fileOffer(files[i]);
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

  $('quality').addEventListener('change', async () => {
    state.quality = $('quality').value;
    store('quality', state.quality);
    await applyQuality();
  });

  $('path').addEventListener('change', () => {
    state.path = $('path').value;
    store('path', state.path);
  });

  // Both pickers of a kind read the same list and write the same choice, so a
  // change in the toolbar and a change in the form can not disagree.
  for (const kind of ['video', 'audio']) {
    for (const select of devicePickers(kind)) {
      if (!select) continue;
      select.addEventListener('change', () => onDevicePicked(kind, select.value));
    }
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  }

  $('stats-btn').addEventListener('click', () => setStatsOpen(!statsOpen()));
  $('stats-close').addEventListener('click', () => setStatsOpen(false));

  // A click on a tile is a spotlight: that guest takes the large area alone
  // and every other guest becomes a rail row. The same click again, a click on
  // the empty stage, or Esc gives the normal layout back. A click on a control
  // in the tile stays with that control.
  $('grid').addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    const tile = target.closest('.tile');
    if (!tile) {
      setSpotlight('');
      return;
    }
    if (target.closest('.vol, .dots, .menu, .sas, .pin')) return;
    const el = /** @type {HTMLElement} */ (tile);
    const id = el.dataset.peer || (el.dataset.local ? 'self' : '');
    if (id) setSpotlight(id);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.spotlight) setSpotlight('');
  });

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
    const link = `${location.origin}/#r=${encodeURIComponent(state.room)}`;
    try {
      await navigator.clipboard.writeText(link);
      $('copy-btn').textContent = 'copied';
      setTimeout(() => { $('copy-btn').textContent = 'copy link'; }, 1500);
    } catch {
      window.prompt('copy this link', link);
    }
  });

  // The form shows a picker before the first permission: the labels are hidden,
  // so the options are numbered until a request has succeeded once.
  refreshDevices();
}

init();
