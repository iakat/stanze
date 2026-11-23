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
  lookParked: false,  // true while a hidden tab sends the raw camera
  audioCtx: null,     // the microphone graph
  mixer: null,
  micGain: null,
  micSource: null,
  micAnalyser: null,  // tap on the microphone input, for the stats level
  meterPeak: 0,       // decaying peak, so one tick per second can see a word
  denoise: null,
  denoiseOn: false,
  noiseWasm: null,    // one fetch of the noise model, shared by every node
  playCtx: null,      // the remote audio graph, so a peer can go over 100%
  screen: null,       // display stream while sharing
  screenSource: null,
  screenTile: null,   // own screen tile while sharing
  mic: false,         // live in this call, and the stored choice
  cam: false,
  deaf: false,        // this browser plays no sound and sends no microphone
  micBeforeDeaf: false, // the microphone state to go back to when the ears open
  camBeforeDeaf: false, // the camera state to go back to when the ears open
  camId: '',          // deviceId of the chosen camera, '' = the system device
  micId: '',          // the same for the microphone
  devCams: [],        // last enumerateDevices() video inputs
  devMics: [],        // last enumerateDevices() audio inputs
  path: 'auto',
  quality: '1280x720@30',
  shareQuality: '1920x1080@30', // the screen has its own quality step
  perf: 0,            // performance step, 0 = full quality (the default)
  sounds: true,       // the four cues and the lost connection chime
  waitingRoom: false, // the room switch an admin sets
  waiting: false,     // this guest is held outside until a member lets it in
  hand: false,        // this guest has a raised hand
  handSeq: 0,         // the queue number the server gave that hand
  insideFps: new Set(), // fingerprints of proven guests seen inside this call, for a quick return
  mirror: true,
  selfPip: false,     // the own picture is a small preview, not a tile in the grid
  voiceTiles: true,   // a guest without a camera also gets a tile in the large area
  look: 'none',       // the look of the own camera, drawn in this tab
  masks: [],          // masks drawn on the face, any number at once
  lookPipe: null,     // the canvas pipeline while a look or a mask is on
  lookOut: null,      // the canvas video track that peers receive
  lookSrc: null,      // the camera track the running pipeline was built from
  lookGrace: 0,       // ms deadline: a pipeline kept after the last effect went off
  lookGraceMs: 120000, // how long that pipeline is kept, for a test to shorten
  lookSwaps: 0,       // sender track swaps made by lookPublish, for a test
  lookTimer: null,    // the timer that ends that grace
  noiseWanted: true,
  leaving: false,
  reconnectTimer: null,
  reconnectDelay: 500,
  fatal: '',
  statsTimer: null,
  statsBusy: false,
  notice: '',         // the text on the status line now, so a later step can tell whose it is
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
  canaries: new Set(), // the name and the chat lines that must never leak
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
 *   'peer-count': HTMLElement, 'copy-btn': HTMLButtonElement, grid: HTMLElement,
 *   'stage-main': HTMLElement, 'stage-rail': HTMLElement, 'self-pip': HTMLElement,
 *   'guest-pip': HTMLElement,
 *   'pin-count': HTMLElement,
 *   'stats-panel': HTMLElement, 'stats-graph-box': HTMLElement,
 *   'stats-graph-down': HTMLCanvasElement, 'stats-graph-rtt': HTMLCanvasElement,
 *   'stats-graph-loss': HTMLCanvasElement, 'stats-note-down': HTMLElement,
 *   'stats-note-rtt': HTMLElement, 'stats-note-loss': HTMLElement,
 *   'stats-sum': HTMLElement, 'stats-body': HTMLElement, 'chat-log': HTMLElement, 'chat-form': HTMLFormElement,
 *   'chat-text': HTMLInputElement, 'chat-note': HTMLElement, 'mic-btn': HTMLButtonElement,
 *   'chat-panel': HTMLElement, 'file-btn': HTMLButtonElement, 'file-input': HTMLInputElement,
 *   'cam-btn': HTMLButtonElement, 'deaf-btn': HTMLButtonElement,
 *   'hand-btn': HTMLButtonElement, 'share-btn': HTMLButtonElement,
 *   'stats-btn': HTMLButtonElement, 'stats-close': HTMLButtonElement,
 *   'leave-btn': HTMLButtonElement, 'call-timer': HTMLElement,
 *   mirror: HTMLInputElement, pip: HTMLInputElement,
 *   'voice-tiles': HTMLInputElement,
 *   menubar: HTMLElement, 'chrome-btn': HTMLButtonElement,
 *   'menu-settings-btn': HTMLButtonElement, 'menu-settings': HTMLElement,
 *   'menu-asr': HTMLElement,
 *   'menu-effects-btn': HTMLButtonElement, 'menu-effects': HTMLElement,
 *   'noise-live': HTMLInputElement, 'stage-error': HTMLElement,
 *   'cam-select': HTMLSelectElement, 'mic-select': HTMLSelectElement,
 *   'menu-devices-btn': HTMLButtonElement, 'menu-devices': HTMLElement,
 *   'dev-mic-list': HTMLElement, 'dev-cam-list': HTMLElement,
 *   'dev-camq-list': HTMLElement, 'dev-scrq-list': HTMLElement,
 *   perf: HTMLInputElement, sounds: HTMLInputElement, 'waiting-room': HTMLInputElement,
 *   'waiting-banner': HTMLElement, 'perf-live': HTMLInputElement,
 *   'perf-text': HTMLElement, 'perf-live-text': HTMLElement,
 *   'menu-asr-btn': HTMLButtonElement, 'asr-on': HTMLInputElement,
 *   'asr-lang': HTMLSelectElement,
 *   'asr-note': HTMLElement,
 *   'look-filter': HTMLSelectElement,
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
// The performance slider trades the picture against bandwidth and compute in
// four steps. It works on top of the quality step above: step 0 is that step
// unchanged, the full quality path, and every later step sends fewer pixels
// from the camera itself, fewer frames and a lower bitrate ceiling. Sound is
// never touched, so a weak link or a weak machine thins the picture first.
const PERF = [
  { name: 'full quality', scale: 1, fps: 0, bits: 1 },
  { name: 'balanced', scale: 0.75, fps: 24, bits: 0.6 },
  { name: 'light', scale: 0.5, fps: 20, bits: 0.35 },
  { name: 'minimum', scale: 0.35, fps: 15, bits: 0.18 },
];
const QUALITY = {
  '640x360@30': { w: 640, h: 360, fps: 30, max: 400000 },
  '1280x720@30': { w: 1280, h: 720, fps: 30, max: 1500000 },
  '1920x1080@30': { w: 1920, h: 1080, fps: 30, max: 3000000 },
  '1920x1080@60': { w: 1920, h: 1080, fps: 60, max: 5000000 },
  '2560x1440@30': { w: 2560, h: 1440, fps: 30, max: 6000000 },
};

// The look of the own camera. A colour step is a canvas filter, and a mask is
// drawn on the face patch that a small skin tone search finds. Both run in this
// tab before the frame is sealed: the other side needs nothing, and the camera
// keeps working, so its light stays on. One choice per guest, off by default.
/** @type {Record<string, string>} */
const LOOKS = {
  none: '',
  soft: 'brightness(1.05) contrast(0.97) saturate(1.03) blur(0.5px)',
  warm: 'saturate(1.15) sepia(0.18) brightness(1.04)',
  cool: 'saturate(1.06) hue-rotate(-10deg) brightness(1.02)',
  mono: 'grayscale(1) contrast(1.06)',
  sepia: 'sepia(0.85) contrast(1.04)',
  vivid: 'saturate(1.4) contrast(1.08)',
};
/** @type {string[]} */
const MASKS = ['none', 'big', 'wide', 'small', 'glasses', 'moustache', 'cat', 'dog', 'halo', 'shades', 'miku'];
// The landmarker is three files of this origin: the module, the wasm and the
// model. Nothing of a face leaves the tab, and no byte comes from outside.
const MESH_DIR = '/facemesh/';
// Its input is a small copy of the frame, wide enough for a mesh and small
// enough to run on a laptop without dropping the sent picture.
const MESH_W = 256;
// The mesh runs on every painted frame, so its rate is the camera rate, and
// the clock below ticks at that rate as well. A machine that cannot hold it
// drops a frame instead of queueing one.
const MESH_HZ_MIN = 5;
const MESH_HZ_MAX = 60;
// The long side of the canvas. A camera step above this is scaled down before
// the look runs, so a filter never costs more pixels than it has to.
const LOOK_MAX = 1280;

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
  state.notice = text;
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

// ---------------------------------------------------------------- menu bar

// The menu bar carries one thin entry per drop-down. Both panels are wired by
// the same code, and only one panel is open at a time, the way a Windows menu
// bar behaves.
/** @type {[keyof Elements, keyof Elements][]} */
const MENUS = [
  ['menu-settings-btn', 'menu-settings'],
  ['menu-effects-btn', 'menu-effects'],
  ['menu-asr-btn', 'menu-asr'],
  ['menu-devices-btn', 'menu-devices'],
];

// fitMenu keeps a drop-down inside the window. A menu hangs from its slot to
// the left, which is right for the left of the bar and wrong for the right: on
// a narrow screen the last slot would push its panel past the edge. The panel
// is slid back by the pixels it hangs out, and never past the left edge, so a
// wrapped bar of two lines still keeps every panel on the glass.
function fitMenu(list) {
  if (!(list instanceof HTMLElement)) return;
  const room = document.documentElement.clientWidth;
  list.style.left = '';
  const box = list.getBoundingClientRect();
  let shift = 0;
  if (box.right > room - 2) shift = room - 2 - box.right;
  if (box.left + shift < 2) shift = 2 - box.left;
  if (shift) list.style.left = Math.round(shift) + 'px';
}

// menuSet opens one panel, closes the others, and moves the focus to its first
// row when it opens. A panel keeps its own DOM, so a switch keeps its listener
// and its tick while the panel is closed.
function menuSet(open, which) {
  for (const [btnId, listId] of MENUS) {
    const btn = $(btnId);
    const list = $(listId);
    if (!btn || !list) continue;
    const on = open && (!which || which === listId);
    const was = !list.hidden;
    list.hidden = !on;
    // A closed panel takes its nested lists with it.
    if (!on) closeSubmenus(list);
    btn.setAttribute('aria-expanded', String(on));
    if (on && !was) {
      fitMenu(list);
      const first = /** @type {HTMLElement | null} */ (list.querySelector('input[type="checkbox"], select, .menu-choice, .menu-sub'));
      if (first) first.focus();
    }
  }
}

// menuClose closes every panel and says whether one of them was open, so the
// global Esc handler can leave the rest of the page alone.
function menuClose() {
  let any = false;
  for (const [, listId] of MENUS) {
    const list = $(listId);
    if (list && !list.hidden) any = true;
  }
  if (any) menuSet(false);
  return any;
}

// closeSubmenus puts every nested list of one panel back to closed.
function closeSubmenus(panel) {
  if (!panel) return;
  for (const sub of Array.from(panel.querySelectorAll('.menu-sub-list'))) {
    if (sub instanceof HTMLElement) sub.hidden = true;
  }
  for (const btn of Array.from(panel.querySelectorAll('.menu-sub'))) btn.setAttribute('aria-expanded', 'false');
}

// wireSubmenus gives every nested row its list: a hover opens it and closes
// its siblings, a click toggles it, the right arrow walks in and the left
// arrow walks back out, the way a Windows menu of the era behaved.
function wireSubmenus() {
  for (const wrap of Array.from(document.querySelectorAll('.menu-subwrap'))) {
    const btn = /** @type {HTMLElement | null} */ (wrap.querySelector('.menu-sub'));
    const list = /** @type {HTMLElement | null} */ (wrap.querySelector('.menu-sub-list'));
    if (!btn || !list) continue;
    /** @type {(on: boolean) => void} */
    const openSub = (on) => {
      list.hidden = !on;
      btn.setAttribute('aria-expanded', String(on));
      if (!on) return;
      for (const other of Array.from(document.querySelectorAll('.menu-subwrap'))) {
        if (other === wrap) continue;
        const otherList = /** @type {HTMLElement | null} */ (other.querySelector('.menu-sub-list'));
        const otherBtn = other.querySelector('.menu-sub');
        if (otherList) otherList.hidden = true;
        if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
      }
    };
    wrap.addEventListener('mouseenter', () => openSub(true));
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openSub(!list.hidden);
    });
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSub(true);
      const first = /** @type {HTMLElement | null} */ (list.querySelector('.menu-choice'));
      if (first) first.focus();
    });
    list.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      openSub(false);
      btn.focus();
    });
  }
}

// wireMenuBar gives each entry its behaviour: a click opens its panel and
// closes the other one, a click inside the panel keeps it open so several
// switches can be set at once, a click anywhere else or Esc closes it, and the
// arrow keys walk the rows.
function wireMenuBar() {
  for (const [btnId, listId] of MENUS) {
    const btn = $(btnId);
    const list = $(listId);
    if (!btn || !list) continue;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      menuSet(list.hidden, listId);
    });
    list.addEventListener('click', (event) => event.stopPropagation());
    list.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      const rows = Array.from(list.querySelectorAll('input[type="checkbox"], select, .menu-choice, .menu-sub'))
        .filter((el) => !(/** @type {HTMLElement} */ (el)).hidden);
      const at = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        menuSet(false);
        btn.focus();
        return;
      }
      if (event.key === 'Tab') {
        menuSet(false);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = /** @type {HTMLElement | undefined} */ (rows[(at + step + rows.length) % rows.length]);
      if (next) next.focus();
    });
  }
  document.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('#menubar')) return;
    menuSet(false);
  });
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

// rowOf maps a tile to its row in the list of members. Both nodes live for as
// long as the tile does, so the map is weak and carries no name of its own.
const rowOf = new WeakMap();

// paintName keeps the small tag and the large centre label in step. The centre
// label carries the whole name, so a guest without a camera is not a pair of
// letters.
function paintName(tile, name, local) {
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = name || '?';
  tile.setAttribute('aria-label', local ? `${name}, you` : name);
  paintRowName(rowOf.get(tile), name, local);
}

// paintRowName keeps the label of a list row in step with the label of its
// tile. A guest that names itself once the keys are proven shows the name in
// both places at the same moment.
function paintRowName(row, name, local) {
  if (!row) return;
  row.querySelector('.row-name').textContent = local ? `${name} (you)` : name;
  row.setAttribute('aria-label', local ? `${name}, you` : name);
}

// paintRowDeaf shows the deafened drawing on the list row of one member. The
// row is the only place that carries the state: a deaf member hears nothing
// and sends nothing, and every other member sees that on their list.
function paintRowDeaf(row, deaf) {
  if (!row) return;
  const mark = row.querySelector('.row-deaf');
  if (mark) mark.hidden = !deaf;
}

// paintRowHand shows the raised hand of one member on its row. The queue panel
// carries the order; the row only says that this hand is up.
function paintRowHand(row, hand) {
  if (!row) return;
  const mark = row.querySelector('.row-hand');
  if (mark) mark.hidden = !hand;
}

// tileId is the spotlight key of one tile: the peer id, or 'self'. The screen
// tile of a guest carries ':screen', so each picture is its own key.
function tileId(tile) {
  const id = tile.dataset.peer || (tile.dataset.local ? 'self' : '');
  return id && tile.dataset.screen ? id + ':screen' : id;
}

// makeTile builds one picture. A screen tile is the second picture of a guest:
// it has no row and no volume of its own, because the row of the guest already
// carries both.
function makeTile(id, name, local = false, screen = false) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.state = 'new';
  if (local && !screen) tile.dataset.local = 'yes';
  if (local && screen) tile.dataset.local = 'screen';
  if (screen) {
    tile.dataset.screen = 'yes';
    tile.classList.add('screenshare');
  }
  const plain = local || screen;
  // The tile is a focus stop: Enter or Space on it enlarges that guest, the
  // same as a click. The controls on it show on hover, on focus and, on a
  // touch screen, after a tap.
  tile.tabIndex = 0;
  tile.setAttribute('role', 'group');
  tile.innerHTML = `
    <video autoplay playsinline${local ? ' muted' : ''}></video>
    <div class="avatar"></div>
    <span class="ring" aria-hidden="true"></span>
    ${plain ? '' : `<div class="vol">
      <img class="vol-ico" src="/openmoji/1F50A.svg" alt="" width="16" height="16">
      <input class="vol-range" type="range" min="0" max="200" step="5" value="100" aria-label="volume of this participant">
      <span class="vol-num">100%</span>
    </div>`}
    <button class="zoom" type="button" aria-pressed="false" aria-label="enlarge this picture" title="enlarge"></button>
    <div class="tag"><span class="name"></span><span class="flags"></span><span class="state"></span>${plain ? '' : '<span class="route" title="the media goes through the relay server">relay</span><span class="pin" hidden></span>'}</div>
    ${plain ? '' : '<button class="admit" type="button" title="let this guest into the room">let in</button><button class="dots" type="button" aria-label="member actions">&#8943;</button><div class="menu" hidden></div>'}`;
  paintName(tile, name, local && !screen);
  // A remote guest is heard through its own gain node, so the video element
  // only ever carries pictures and stays muted.
  if (!local) tile.querySelector('video').muted = true;
  if (!plain) wireDots(tile);
  if (!plain) wireAdmit(tile);
  tile.addEventListener('keydown', (event) => {
    if (event.target !== tile || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const id = tileId(tile);
    if (id) setSpotlight(id);
  });
  $('stage-main').appendChild(tile);
  if (!screen) rowOf.set(tile, makeRow(id, name, local));
  return tile;
}

// makeRow builds the list row of one member. Every member has one, with a
// picture or without: the picture stays in the large area and the row carries
// the name, the two lamps and the volume slider. The row is one line and the
// slider is always open, so a pointer that crosses it never moves the stage.
function makeRow(id, name, local = false) {
  const row = document.createElement('div');
  row.className = 'plist-row';
  if (local) row.dataset.local = 'yes';
  else row.dataset.peer = id;
  row.dataset.state = 'new';
  row.dataset.mic = 'on';
  row.tabIndex = 0;
  row.setAttribute('role', 'group');
  row.innerHTML = `<span class="row-name"></span><span class="row-deaf" hidden><img src="/openmoji/1F507.svg" alt="deafened" title="deafened" width="16" height="16"></span><span class="row-hand" hidden>hand</span>${local ? '<span class="row-you">you</span>' : `
    <input class="vol-range" type="range" min="0" max="200" step="5" value="100" aria-label="volume of this participant">
    <span class="vol-num">100%</span>
    <button class="admit" type="button" title="let this guest into the room">let in</button>
    <button class="dots" type="button" aria-label="member actions">&#8943;</button>`}`;
  paintRowName(row, name, local);
  if (!local) {
    wireDots(row);
    wireAdmit(row);
  }
  row.addEventListener('keydown', (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const id = tileId(row);
    if (id) setSpotlight(id);
  });
  $('stage-rail').appendChild(row);
  return row;
}

// ---------------------------------------------------------------- stage layout

let localTile = null; // the own preview tile, made once per room
function ownTile() {
  return localTile && localTile.isConnected ? localTile : null;
}

// stageTiles is every tile in a stable order: the own preview first, then the
// guests in the order they joined. The order of the two zones follows it, so a
// relayout never reshuffles the room. A shared screen is its own tile and stands
// right after the picture of the guest that shares it.
function stageTiles() {
  const out = [];
  const self = ownTile();
  if (self) out.push(self);
  if (state.screenTile) out.push(state.screenTile);
  for (const peer of state.peers.values()) {
    if (peer.tile) out.push(peer.tile);
    if (peer.screenTile) out.push(peer.screenTile);
  }
  return out;
}

// tileHasPicture answers "does this tile show a moving picture now". A camera
// that is off, a track that the sender muted and a track that stopped all say
// no, and that guest belongs in the rail as a row. A screen tile needs a
// decoded frame too: its receiver track exists from the negotiation on, so the
// live flag alone would show an empty box.
function tileHasPicture(tile) {
  if (!tile || tile.classList.contains('camoff')) return false;
  const video = tile.querySelector('video');
  const stream = video && video.srcObject;
  if (!stream || typeof stream.getVideoTracks !== 'function') return false;
  const live = stream.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);
  return live && (!tile.dataset.screen || video.videoWidth > 0);
}

// spotlightTile is the one tile that holds the large area while the spotlight
// is on. A guest that left takes the spotlight with it, and a screen tile is
// its own key.
function spotlightTile() {
  if (!state.spotlight) return null;
  if (state.spotlight === 'self') return ownTile();
  const screen = state.spotlight.endsWith(':screen');
  const id = screen ? state.spotlight.slice(0, -7) : state.spotlight;
  if (id === 'self') return document.querySelector('.tile[data-local="screen"]');
  for (const peer of state.peers.values()) {
    if (peer.id !== id) continue;
    return screen ? peer.screenTile : peer.tile;
  }
  return null;
}

// ---------------------------------------------------------------- corners

// A stage with two pictures puts one guest small in a corner. A corner is two
// letters, the vertical side first and then the horizontal one, and the own
// preview gives way to the guest by taking the opposite corner while it is on.
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const OPPOSITE_CORNER = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
const cornerCall = new Map();   // peer id -> corner, this call only
let cornerDropAt = 0;           // when a drag ended, so its click is not a zoom

// peerOfTile is the peer record of one tile, or null for the own tile.
function peerOfTile(tile) {
  const id = tile && tile.dataset.peer;
  return id && state.peers ? state.peers.get(id) || null : null;
}

// storedCorner reads the kept place of one guest. A guest that proved its key
// keeps it on the disk under the fingerprint, the same key as its volume; a
// guest without a key keeps it for this call only. The default is the bottom
// right corner, where the own preview also sits.
function storedCorner(peer) {
  const raw = peer && peer.fp ? load(`corner.fp.${peer.fp}`) : (peer ? cornerCall.get(peer.id) || '' : '');
  return CORNERS.includes(raw) ? raw : 'br';
}

function saveCorner(peer, corner) {
  if (!peer || !CORNERS.includes(corner)) return;
  cornerCall.set(peer.id, corner);
  if (peer.fp) store(`corner.fp.${peer.fp}`, corner);
}

// layoutStage picks the tiles that hold the large area and keeps the list of
// members in step. A tile keeps its node, so its video element keeps its stream
// and its sliders keep their listener. Without a spotlight, the tiles with a
// picture take the large area; a tile without one stays out of the frame,
// because its row in the list already names the guest, unless the voice-only
// switch is on, which is the default: then it holds a tile with its avatar and
// its name in the size of a picture tile. A guest that still waits stays in
// the rail.
// The list is a block of reserved height that scrolls, so no tile and no row
// can move the stage.
function layoutStage() {
  const main = $('stage-main');
  const rail = $('stage-rail');
  const pipBox = $('self-pip');
  const cornerBox = $('guest-pip');
  if (!main || !rail) return;
  const spot = spotlightTile();
  if (state.spotlight && !spot) state.spotlight = '';
  const self = ownTile();
  // The own picture is a small preview while the switch is on. The node is
  // moved, never copied, so the preview keeps the own stream and the mirror.
  const pip = !!(self && pipBox && state.selfPip);
  if (pipBox) pipBox.hidden = !pip;
  if (self && pip && self.parentElement !== pipBox) pipBox.appendChild(self);
  if (self && !pip && self.parentElement !== main) main.appendChild(self);
  // Two pictures and no spotlight: the later guest sits small in a corner and
  // the other one keeps the whole frame. The small tile keeps its node too.
  const bigs = [];
  for (const tile of stageTiles()) {
    const inPip = pip && tile === self;
    // A screen tile without a picture has nothing to show: it leaves the stage
    // instead of standing there as a name.
    const voice = state.voiceTiles && !tile.dataset.waiting && !tile.dataset.screen;
    const big = !inPip && (spot ? tile === spot : (tileHasPicture(tile) || voice));
    if (big) bigs.push(tile);
    tile.hidden = inPip ? false : !big;
    const on = big && !!spot;
    tile.classList.toggle('spot', on);
    const row = rowOf.get(tile);
    if (row) row.classList.toggle('spot', on);
    const zoom = tile.querySelector('.zoom');
    if (zoom) {
      zoom.setAttribute('aria-pressed', String(on));
      zoom.setAttribute('aria-label', on ? 'back to the grid' : 'enlarge this picture');
      zoom.title = on ? 'back to the grid' : 'enlarge';
    }
  }
  // The small corner goes to a person, not to a screen: a shared screen needs
  // the whole frame.
  const small = !spot && !pip && bigs.length === 2 ? bigs.find((t) => !t.dataset.screen) : null;
  if (cornerBox) {
    cornerBox.hidden = !small;
    for (const tile of stageTiles()) {
      if (tile !== small && tile.parentElement === cornerBox) main.appendChild(tile);
    }
    if (small && small.parentElement !== cornerBox) cornerBox.appendChild(small);
    if (small) {
      const corner = storedCorner(peerOfTile(small));
      cornerBox.dataset.corner = corner;
      // The own preview gives way to the guest: it takes the opposite corner.
      if (pip && pipBox) pipBox.dataset.corner = OPPOSITE_CORNER[corner];
    } else if (pipBox) {
      pipBox.removeAttribute('data-corner');
    }
  }
  const alone = bigs.length - (small ? 1 : 0) === 1 ? 'yes' : 'no';
  if (main.dataset.alone !== alone) main.dataset.alone = alone;
  main.hidden = bigs.length - (small ? 1 : 0) === 0;
}

// wireCornerDrag lets the small guest tile of a two person stage follow the
// pointer and snap to the nearest of the four corners when it is let go. A
// pointer that stays put does not start a drag, so a click on the tile keeps
// its meaning and enlarges that guest.
function wireCornerDrag() {
  const box = $('guest-pip');
  const grid = $('grid');
  if (!box || !grid) return;
  let drag = /** @type {any} */ (null);
  box.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = /** @type {Element} */ (event.target);
    if (target.closest('.vol, .vol-range, .vol-num, .dots, .menu, .sas, .pin, .admit, .zoom')) return;
    const rect = box.getBoundingClientRect();
    const frame = grid.getBoundingClientRect();
    if (!frame.width || !frame.height) return;
    drag = {
      id: event.pointerId,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      w: rect.width,
      h: rect.height,
      frame,
      moved: false,
    };
    try { box.setPointerCapture(event.pointerId); } catch { /* no capture */ }
  });
  box.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) < 4 && Math.abs(event.clientY - drag.startY) < 4) return;
      drag.moved = true;
      box.classList.add('dragging');
      box.style.width = `${drag.w}px`;
      box.style.height = `${drag.h}px`;
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    }
    const frame = drag.frame;
    const x = Math.min(Math.max(event.clientX - drag.grabX - frame.left, 0), Math.max(0, frame.width - drag.w));
    const y = Math.min(Math.max(event.clientY - drag.grabY - frame.top, 0), Math.max(0, frame.height - drag.h));
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    const frame = drag.frame;
    const rect = box.getBoundingClientRect();
    drag = null;
    try { box.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    box.classList.remove('dragging');
    box.style.width = '';
    box.style.height = '';
    box.style.left = '';
    box.style.top = '';
    box.style.right = '';
    box.style.bottom = '';
    if (!moved) return;
    // The nearest corner wins: the side of each middle line that holds the
    // centre of the tile.
    const right = rect.left + rect.width / 2 > frame.left + frame.width / 2;
    const bottom = rect.top + rect.height / 2 > frame.top + frame.height / 2;
    const corner = `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`;
    saveCorner(peerOfTile(box.querySelector('.tile')), corner);
    box.dataset.corner = corner;
    if (state.selfPip && $('self-pip')) $('self-pip').dataset.corner = OPPOSITE_CORNER[corner];
    cornerDropAt = Date.now();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// setSpotlight puts one guest alone in the large area, or ends the spotlight
// when that guest already holds it.
function setSpotlight(id) {
  // The own picture is a preview now, so asking for it puts it back in the
  // grid instead of leaving an empty stage behind.
  if (id === 'self' && state.selfPip) {
    state.selfPip = false;
    store('selfpip', 0);
    updateButtons();
    state.spotlight = '';
    layoutStage();
    return;
  }
  state.spotlight = id && state.spotlight !== id ? id : '';
  for (const open of document.querySelectorAll('.tile.ctl')) open.classList.remove('ctl');
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

// The slider is a position, not an amplitude. Loudness is heard on a log scale,
// so a straight line from 0 to 2 in amplitude puts all the change at the
// bottom and almost none at the top. The gain is a power of the position:
// position 100 is unity, and every 50 points of travel is about 10 dB, which
// the ear takes for half or double the loudness. 0 is silence, 200 is +10 dB.
// What is stored is the position, the same percent as before.
const VOL_MAX = 200;
const VOL_EXP = 5 / 3;   // 2^(5/3) is 3.17, +10 dB

// volGain turns a slider position (0 to 200) into the gain of the node.
function volGain(pos) {
  const n = Number(pos);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.pow(Math.min(n, VOL_MAX) / 100, VOL_EXP);
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

// volumePairs is every slider of one peer: the one on its tile and the one on
// its row. Both write the one peer.vol, so the two can never disagree.
function volumePairs(peer) {
  const out = [];
  for (const host of [peer.tile, rowOf.get(peer.tile)]) {
    const range = host ? host.querySelector('.vol-range') : null;
    const num = host ? host.querySelector('.vol-num') : null;
    if (range && num) out.push({ range, num });
  }
  return out;
}

// paintVolume draws the percent of one peer on its sliders, its labels and the
// live gain. It is called when a slider moves, and again when a sealed guest
// tells us the name that its stored volume is kept under.
function paintVolume(peer) {
  for (const { range, num } of volumePairs(peer)) {
    num.textContent = `${peer.vol}%`;
    range.value = String(peer.vol);
  }
  const g = state.deaf ? 0 : volGain(peer.vol);
  if (peer.gain) peer.gain.gain.value = g;
  // The element path is only a fallback and can not go over unity.
  if (peer.audioEl) peer.audioEl.volume = Math.min(g, 1);
}

// wireVolume connects the tile slider and the row slider of one peer to the
// one value. The gain and the labels are painted from peer.vol, which the audio
// path and both sliders share.
function wireVolume(peer) {
  for (const { range } of volumePairs(peer)) {
    range.addEventListener('input', () => {
      const n = parseInt(range.value, 10);
      peer.vol = Number.isFinite(n) ? Math.max(0, Math.min(200, n)) : 100;
      paintVolume(peer);
      saveVolume(peer);
    });
  }
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
  // The row of this member shows the same two lamps and the same picture state.
  const row = rowOf.get(tile);
  if (row) {
    row.dataset.mic = mic === false ? 'off' : 'on';
    row.classList.toggle('camoff', cam === false);
  }
  // A guest that waits is marked on its tile and its row, and a member sees the
  // let in button there; the CSS shows it.
  const who = tile.dataset.peer ? state.peers.get(tile.dataset.peer) : null;
  const waiting = who ? !!who.waiting : !!(tile.dataset.local && state.waiting);
  tile.dataset.waiting = waiting ? 'yes' : '';
  if (row) row.dataset.waiting = waiting ? 'yes' : '';
  const box = tile.querySelector('.flags');
  // A raised hand is on the tile with its place in the queue, and on the row
  // of the same member, so a small picture still shows it.
  const handOn = who ? !!who.hand : !!(tile.dataset.local && state.hand);
  const handSeq = who ? who.handSeq : state.handSeq;
  paintRowHand(row, handOn);
  if (!box) return;
  const out = [];
  if (waiting) out.push('waiting');
  if (admin) out.push('host');
  if (mic === false) out.push('muted');
  if (cam === false) out.push('no cam');
  if (handOn) out.push(handSeq ? `hand #${handSeq}` : 'hand');
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

// hostMenu returns the menu element of one member, a tile or a rail row. A
// tile holds its own menu, because nothing scrolls around it. The rail does
// scroll and is short, so a row hands the work to one popup on the page: the
// entries would be cut off inside the list. One popup serves every row.
let rowMenuEl = null;
function hostMenu(host) {
  if (!host) return null;
  if (!host.classList.contains('plist-row')) return host.querySelector('.menu');
  if (!rowMenuEl) {
    rowMenuEl = document.createElement('div');
    rowMenuEl.className = 'menu row-menu';
    rowMenuEl.hidden = true;
    document.body.appendChild(rowMenuEl);
  }
  return rowMenuEl;
}

// wireDots opens the small menu of one remote member. Every guest sees it; the
// host commands appear only for the admin, and the server checks the role
// again on every command. It takes the tile or the row of that member, because
// both carry the peer id.
function wireDots(host) {
  const dots = host.querySelector('.dots');
  const menu = hostMenu(host);
  if (!dots || !menu) return;
  dots.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.menu:not([hidden])'));
    for (const other of open) {
      if (other !== menu) other.hidden = true;
    }
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    menu.replaceChildren();
    menu.dataset.peer = host.dataset.peer || '';
    const peer = state.peers.get(host.dataset.peer);
    const add = (label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        menu.hidden = true;
        run();
      });
      menu.appendChild(b);
    };
    if (isAdmin(state.self)) {
      add('give admin', () => send({ t: 'mod', to: host.dataset.peer, action: 'admin' }));
      add('mute', () => send({ t: 'mod', to: host.dataset.peer, action: 'mute' }));
      add('remove from room', () => {
        // A guest who was let in keeps that key; a removed guest must wait
        // again on the next return, so the key goes when the guest is kicked.
        const gone = state.peers.get(host.dataset.peer);
        if (gone && gone.fp) state.insideFps.delete(gone.fp);
        send({ t: 'mod', to: host.dataset.peer, action: 'kick' });
      });
    }
    const noiseOn = !!(peer && peer.inNoise);
    add('local noise cancel: ' + (noiseOn ? 'on' : 'off'), () => { void setPeerNoise(peer, !noiseOn); });
    // The sealed code lives here, not as a banner over the picture: one card,
    // built by the same function that feeds the stats panel.
    if (peer && peer.sas) {
      const card = document.createElement('div');
      card.className = 'sas';
      card.append(...sealedCodePanel(peer));
      menu.appendChild(card);
    }
    if (menu.classList.contains('row-menu')) {
      // The popup sits under the three dots of its row, and above them when
      // there is no room below, so every entry stays on the screen.
      const r = dots.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 16);
      menu.style.left = Math.round(Math.max(4, Math.min(r.left, window.innerWidth - width - 4))) + 'px';
      const below = r.bottom + 2;
      const height = menu.offsetHeight;
      const top = below + height > window.innerHeight - 4
        ? Math.max(4, window.innerHeight - 4 - height)
        : below;
      menu.style.top = Math.round(top) + 'px';
    }
    menu.hidden = false;
  });
}

// wireAdmit connects the let in button of one remote member. Any guest that is
// inside may press it; the server checks that again and tells the whole room.
function wireAdmit(host) {
  const button = host.querySelector('.admit');
  if (!button) return;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.waiting || !host.dataset.peer) return;
    send({ t: 'admit', to: host.dataset.peer });
  });
}

// waitingText says to a waiting guest what the room can see and hear. It is
// built from the real state of the two devices, so it is never wrong about
// them, and it is shown again whenever one of them changes.
function waitingText() {
  const both = state.mic && state.cam;
  const lead = 'You are in the waiting room. ';
  const mid = both
    ? 'Your camera and your microphone are on, and every member of the meeting can see and hear you right now, before you are let in. '
    : `Your camera is ${state.cam ? 'on' : 'off'} and your microphone is ${state.mic ? 'on' : 'off'}. Every member of the meeting can see and hear whatever is on, before you are let in. `;
  return `${lead}${mid}Use the buttons below to turn them off if you do not want that. You can not see or hear the meeting, or chat, until a member lets you in.`;
}

// paintWaiting draws everything that depends on the waiting room: the notice
// of a waiting guest, the admin switch, the chat lock and the count in the
// header. It is cheap and safe to call at any time.
function paintWaiting() {
  document.body.classList.toggle('self-waiting', state.waiting);
  const banner = document.getElementById('waiting-banner');
  if (banner) {
    banner.hidden = !state.waiting;
    if (state.waiting) banner.textContent = waitingText();
  }
  const sw = /** @type {HTMLInputElement | null} */ (document.getElementById('waiting-room'));
  if (sw) sw.checked = state.waitingRoom;
  // A waiting guest has no chat and offers no files: the room is not theirs yet.
  $('chat-text').disabled = state.waiting;
  $('file-btn').disabled = state.waiting;
  $('chat-text').placeholder = state.waiting ? 'chat opens when you are let in' : 'say something';
  for (const peer of state.peers.values()) {
    if (peer.tile) applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
    if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
  }
  const self = ownTile();
  if (self) applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  updateCount();
  paintHandQueue();
}

// admitPeer runs when the server says that a guest is inside now. Our own media
// goes to that guest from this moment on; before it, nothing of it did.
function admitPeer(id) {
  if (id === state.self) {
    state.waiting = false;
    // The waiting room held every outgoing track back. Now the guest is
    // inside, so the tracks go to every connection that is already built.
    // Without this the room hears nothing of a guest it has just let in.
    if (state.outStream) {
      for (const peer of state.peers.values()) {
        for (const track of state.outStream.getTracks()) attachTrack(peer, track);
        attachScreen(peer);
      }
    }
    paintWaiting();
    playSfx('pop');
    return;
  }
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.waiting = false;
  if (peer.fp) state.insideFps.add(peer.fp);
  asrAnnounce(peer);
  if (peer.pc && state.outStream) {
    for (const track of state.outStream.getTracks()) attachTrack(peer, track);
    attachScreen(peer);
  }
  paintWaiting();
}

// closeMenus hides every host menu. One listener on the page does it, because
// a listener per tile was never removed when its tile left.
function closeMenus() {
  for (const menu of document.querySelectorAll('.menu:not([hidden])')) {
    /** @type {HTMLElement} */ (menu).hidden = true;
  }
}

// markAdmins redraws the host chip on every tile. The member menu is open to
// every guest, so only the chip and the host commands depend on the role.
function markAdmins() {
  const mine = isAdmin(state.self);
  document.body.classList.toggle('is-admin', mine);
  for (const peer of state.peers.values()) {
    applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
    if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
  }
  const self = ownTile();
  applyFlags(self, state.mic, state.cam, mine);
  paintHandQueue();
}

function updateCount() {
  const total = state.peers.size + 1;
  const live = [...state.peers.values()].filter((p) => p.state === 'connected').length + 1;
  const held = [...state.peers.values()].filter((p) => p.waiting).length;
  $('peer-count').textContent = (total === 1 ? '1 peer' : `${live}/${total} peers`) +
    (held && !state.waiting ? `, ${held} waiting` : '');
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

// perfNow is the chosen performance step, full quality for an unknown value.
function perfNow() {
  return PERF[state.perf] || PERF[0];
}

// evenPx scales a side and keeps it even, which every encoder accepts.
function evenPx(n, scale) {
  return scale === 1 ? n : Math.max(2, Math.round((n * scale) / 2) * 2);
}

// perfFps is the frame rate the camera sends at the chosen steps.
function perfFps(q, p) {
  return p.fps ? Math.min(q.fps, p.fps) : q.fps;
}

// videoFor builds one video request from a quality step and a performance step.
function videoFor(q, p) {
  const w = evenPx(q.w, p.scale);
  const h = evenPx(q.h, p.scale);
  const fps = perfFps(q, p);
  return {
    width: { ideal: w, max: w },
    height: { ideal: h, max: h },
    frameRate: { ideal: fps, max: fps },
  };
}

// camVideo builds the camera request for the chosen steps. The join and every
// later camera switch go through it, so the performance step sets the size the
// camera itself delivers, and not only what the encoder does with it.
function camVideo() {
  return videoFor(qualityNow(), perfNow());
}

// shareVideo is the screen share request. A shared screen is read as text, so
// it has a step of its own and never takes the performance step. The camera
// step does not touch it.
function shareVideo() {
  return videoFor(QUALITY[state.shareQuality] || QUALITY['1920x1080@30'], PERF[0]);
}

// perfText says what the chosen step sends, in words and in numbers.
function perfText() {
  const q = qualityNow();
  const p = perfNow();
  const v = videoFor(q, p);
  return `${p.name}: camera ${v.width.ideal}x${v.height.ideal} at ${v.frameRate.ideal} frames, up to ${Math.round((q.max * p.bits) / 1000)} kbit/s. Sound is not changed.`;
}

// paintPerf shows the step on both sliders, the one in the form and the one in
// the toolbar, so the two can never disagree.
function paintPerf() {
  for (const id of ['perf', 'perf-live']) {
    const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    // The slider runs from the minimum on the left to the full quality on the
    // right, so the stored step is turned round for it.
    if (el) el.value = String(PERF.length - 1 - state.perf);
  }
  for (const id of ['perf-text', 'perf-live-text']) {
    const el = document.getElementById(id);
    if (!el) continue;
    // The toolbar has room for the name only; the form carries the numbers.
    el.textContent = id === 'perf-text' ? perfText() : perfNow().name;
  }
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
  const q = qualityNow();
  const p = perfNow();
  // Step 0 sets the same ceiling as before and no frame cap, so the default
  // path is the one that always ran.
  const max = Math.round(q.max * p.bits);
  const fps = p.fps ? perfFps(q, p) : 0;
  const next = {
    ...params,
    encodings: params.encodings.map((enc) => {
      const out = { ...enc, maxBitrate: max };
      if (fps) out.maxFramerate = fps;
      else delete out.maxFramerate;
      return out;
    }),
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
  const drawn = lookTrack();
  for (const sender of pc.getSenders()) {
    if (sender.track !== state.camTrack && sender.track !== drawn) continue;
    capVideoSender(sender);
  }
}

// applyQuality pushes the chosen steps into the live camera: the raw track gets
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
    const drawn = lookTrack();
    for (const sender of peer.pc.getSenders()) {
      if (!sender.track || (sender.track !== track && sender.track !== drawn)) continue;
      if (!(await capVideoSender(sender))) refused = true;
    }
  }
  lookResize();
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
  return kind === 'video' ? [$('cam-select')] : [$('mic-select')];
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
  paintDeviceMenu();
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

// The words of the quality steps, used by both quality lists.
const QUALITY_LABEL = {
  '640x360@30': '360p 30',
  '1280x720@30': '720p 30',
  '1920x1080@30': '1080p 30',
  '1920x1080@60': '1080p 60',
  '2560x1440@30': '1440p 30',
};

// deviceRows lists the system device, every enumerated device and, before the
// first permission, the stored id as one extra row, the way the odd select did.
function deviceRows(kind) {
  const noun = DEVICE_NOUN[kind];
  const rows = [{ value: '', label: `system ${noun}` }];
  const seen = new Set();
  let count = 0;
  for (const device of deviceList(kind)) {
    if (!device.deviceId || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    count++;
    rows.push({ value: device.deviceId, label: device.label || `${noun} ${count}` });
  }
  const wanted = chosenDevice(kind);
  if (wanted && !seen.has(wanted)) rows.push({ value: wanted, label: `${noun} (last used)` });
  return rows;
}

// qualityRows lists every quality step with its words.
function qualityRows() {
  return Object.keys(QUALITY).map((value) => ({ value, label: QUALITY_LABEL[value] || value }));
}

// paintMenuChoice rewrites one submenu: a button row per choice, a tick on the
// choice in force, and one callback per row.
function paintMenuChoice(list, rows, current, pick) {
  if (!list) return;
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-item menu-choice';
    button.setAttribute('aria-pressed', String(row.value === current));
    const tick = document.createElement('span');
    tick.className = 'menu-tick';
    tick.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'menu-text';
    text.textContent = row.label;
    button.append(tick, text);
    button.addEventListener('click', () => pick(row.value));
    frag.appendChild(button);
  }
  list.replaceChildren(frag);
}

// paintDeviceMenu rebuilds the four lists: microphone, camera, camera quality
// and screen quality. The tick marks the choice in force.
function paintDeviceMenu() {
  paintMenuChoice($('dev-mic-list'), deviceRows('audio'), state.micId, (value) => {
    onDevicePicked('audio', value);
    paintDeviceMenu();
  });
  paintMenuChoice($('dev-cam-list'), deviceRows('video'), state.camId, (value) => {
    onDevicePicked('video', value);
    paintDeviceMenu();
  });
  paintMenuChoice($('dev-camq-list'), qualityRows(), state.quality, (value) => {
    state.quality = value;
    store('quality', value);
    paintDeviceMenu();
    applyQuality();
  });
  paintMenuChoice($('dev-scrq-list'), qualityRows(), state.shareQuality, (value) => {
    state.shareQuality = value;
    store('sharequality', value);
    paintDeviceMenu();
  });
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
      paintSelfCam(false);
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
      paintSelfCam(false);
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
  localTile = self;
  self.dataset.state = 'connected';
  self.querySelector('.state').textContent = 'you';
  applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  applyMirror();
  updateButtons();
}

// refreshSelf paints the own tile flags and the buttons from the live state.
function refreshSelf() {
  const self = ownTile();
  applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  paintRowDeaf(document.querySelector('.plist-row[data-local="yes"]'), state.deaf);
  updateButtons();
  // The notice of a waiting guest names the real state of both devices.
  if (state.waiting) paintWaiting();
}

// setDeaf closes both directions at once: the microphone and the camera go
// off, every guest is turned down to zero and no incoming picture is drawn, so
// nothing is sent and nothing is heard or shown. The stored microphone and
// camera choices survive, so undeafen gives the guest their devices back, and
// every volume is where it was before. A screen share ends here: a deafened
// guest does not keep sending a picture.
function setDeaf(on) {
  if (state.deaf === on) return;
  state.deaf = on;
  if (on) {
    state.micBeforeDeaf = state.mic;
    if (state.mic) disableMic(false);
    state.camBeforeDeaf = state.cam;
    if (state.cam) disableCam(false);
    if (state.screen) stopShare();
  } else {
    if (state.micBeforeDeaf) enableMic();
    if (state.camBeforeDeaf) enableCam();
  }
  paintRemoteVideo();
  for (const peer of state.peers.values()) paintVolume(peer);
  playSfx(on ? 'hammer' : 'timp');
  refreshSelf();
  sendState();
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
// leaves, so the first frame always meets a key, a transform and a track. The
// screen has a transceiver of its own from the start, so a share needs no
// renegotiation and the camera keeps its sender.
function preparePeer(peer) {
  if (peer.tx) return;
  peer.tx = {};
  peer.sealed = true;
  const used = new Set();
  for (const kind of ['audio', 'video', 'screen']) {
    const media = kind === 'screen' ? 'video' : kind;
    let tr = peer.pc.getTransceivers().find((t) => !t.stopped && !used.has(t) && t.receiver.track.kind === media);
    if (!tr) tr = peer.pc.addTransceiver(media, { direction: 'sendrecv' });
    used.add(tr);
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
    const track = kind === 'screen'
      ? state.screen && state.screen.getVideoTracks()[0]
      : state.outStream && state.outStream.getTracks().find((t) => t.kind === kind);
    if (!track) continue;
    // A guest that waits outside gets none of our media until it is let in.
    if (peer.waiting) continue;
    tr.sender.replaceTrack(track).catch(() => {});
    if (kind === 'video') capVideoSender(tr.sender);
  }
}

// attachTrack points the sender of that kind at a track. The transceiver and
// its transform already exist, so a track can come and go without a second
// install path and without a renegotiation.
function attachTrack(peer, track) {
  if (peer.sealed === false || peer.waiting) return;
  const tr = peer.tx && peer.tx[track.kind];
  if (!tr) return;
  tr.sender.replaceTrack(track).catch(() => {});
  if (track.kind === 'video') capVideoSender(tr.sender);
}

// attachScreen puts the live screen track on the screen sender of one peer.
// Only the screen sender is touched; the camera keeps its own track.
function attachScreen(peer) {
  if (peer.sealed === false || peer.waiting) return;
  const tr = peer.tx && peer.tx.screen;
  const track = state.screen && state.screen.getVideoTracks()[0];
  if (tr && track) tr.sender.replaceTrack(track).catch(() => {});
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

// setVideoTrack reuses the stream when the same track is still attached, so a
// repaint does not restart the element.
function setVideoTrack(video, track) {
  const stream = video.srcObject;
  if (!stream || typeof stream.getVideoTracks !== 'function' || stream.getVideoTracks()[0] !== track) {
    video.srcObject = new MediaStream([track]);
  }
}

// paintSelfCam paints the local preview from the camera state. A disabled
// track gives black frames, so the element is emptied and the tile leaves the
// playing state: the centre name is back until the camera works again.
function paintSelfCam(on) {
  const self = ownTile();
  if (!self) return;
  const video = self.querySelector('video');
  const track = lookTrack() || state.camTrack;
  if (on && track) {
    setVideoTrack(video, track);
    self.classList.add('playing');
    video.play().catch(() => {});
  } else {
    self.classList.remove('playing');
    try { video.pause(); } catch { /* not playing */ }
    video.srcObject = null;
  }
  layoutStage();
}

// paintPeerVideo shows or hides the incoming picture of one guest. A deafened
// guest draws no picture at all, so only names remain; the same track goes back
// when the ears open, so no new negotiation is needed.
function paintPeerVideo(peer) {
  const video = peer.tile && peer.tile.querySelector('video');
  if (!video) return;
  if (!state.deaf && peer.videoTrack) {
    setVideoTrack(video, peer.videoTrack);
    peer.tile.classList.add('playing');
    video.play().catch(() => {});
  } else {
    peer.tile.classList.remove('playing');
    try { video.pause(); } catch { /* not playing */ }
    video.srcObject = null;
  }
  layoutStage();
}

// paintRemoteVideo applies the deaf state to every guest already in the room.
function paintRemoteVideo() {
  for (const peer of state.peers.values()) {
    paintPeerVideo(peer);
    paintPeerScreen(peer);
  }
}

// makeScreenTile builds the second picture of a guest on its first screen
// track. It has no row of its own: the list already carries the guest, and the
// label says which picture it is. The node stays for the pair, so a share that
// stops and starts again reuses it.
function makeScreenTile(peer) {
  if (peer.screenTile) return peer.screenTile;
  peer.screenTile = makeTile(peer.id, `${peer.name}, screen`, false, true);
  peer.screenTile.dataset.peer = peer.id;
  // The receiver track of the screen exists from the negotiation on, so the
  // tile stands in the stage only once its first frame is decoded.
  peer.screenTile.querySelector('video').addEventListener('resize', () => layoutStage());
  // The camera flag stays out of it: this tile is the screen, not the face.
  applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
  return peer.screenTile;
}

// paintPeerScreen shows or hides the shared screen of one guest. The tile is
// built on the first live screen track, so no empty second tile stands in the
// stage; a track that the sender muted for a stopped share, or that ended,
// leaves the stage while the same track comes back when the share does.
function paintPeerScreen(peer) {
  const track = peer.screenTrack;
  if (!track) return;
  if (!state.deaf && peer.screenShared !== false && track.readyState === 'live' && !track.muted) {
    const tile = makeScreenTile(peer);
    const video = tile.querySelector('video');
    setVideoTrack(video, track);
    tile.classList.add('playing');
    video.play().catch(() => {});
  } else if (peer.screenTile) {
    const video = peer.screenTile.querySelector('video');
    peer.screenTile.classList.remove('playing');
    try { video.pause(); } catch { /* not playing */ }
    video.srcObject = null;
  }
  layoutStage();
}

// dropPeerScreen takes the screen tile of a guest out of the stage and lets go
// of the frozen last frame. The receiver track itself stays for the pair, so the
// next share of that guest reuses it and needs no new negotiation.
function dropPeerScreen(peer) {
  if (!peer.screenTile) return;
  const video = peer.screenTile.querySelector('video');
  peer.screenTile.classList.remove('playing');
  try { video.pause(); } catch { /* not playing */ }
  video.srcObject = null;
  peer.screenTile.remove();
  peer.screenTile = null;
  layoutStage();
}

// adoptCam makes one camera track the live video. The camera keeps its own
// sender while a screen is shared, so the picture goes to the camera sender and
// the share is not touched. A track that replaces an earlier camera is handed to
// the video sender that is already there, so a switch needs no renegotiation.
async function adoptCam(track) {
  if (!track) return;
  const prev = state.camTrack;
  state.camTrack = track;
  track.contentHint = 'motion';
  track.enabled = true;
  paintSelfCam(true);
  if (state.outStream) {
    for (const old of state.outStream.getVideoTracks()) {
      if (old !== track) state.outStream.removeTrack(old);
    }
    if (!state.outStream.getVideoTracks().includes(track)) state.outStream.addTrack(track);
    publishTrack(track);
    // A look or a mask follows the camera it was drawn from.
    await lookRestart();
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

// disableMic mutes the microphone. A mute that the guest chose is remembered
// for the next visit; a mute that the host forced is not, or the guest would
// join muted for ever after one request.
function disableMic(persist = true) {
  playSfx('hammer');
  state.mic = false;
  if (persist) store('mic', 0);
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
  paintSelfCam(true);
  updateButtons();
  sendState();
}

function disableCam(persist = true) {
  state.cam = false;
  if (persist) store('cam', 0);
  // A disabled track keeps the device open, so the camera light stays on. Stop
  // the track and drop it: enableCam asks the device again, and the video
  // sender that still holds the old track gets the new one in adoptCam.
  const track = state.camTrack;
  state.camTrack = null;
  // The drawn track reads from the camera, so it goes with it.
  lookStop();
  if (track) {
    try { track.stop(); } catch { /* already stopped */ }
  }
  paintSelfCam(false);
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
  const on = now - (hold.last || 0) < SPEAK_HOLD_MS;
  tile.classList.toggle('speaking', on);
  // The row of this member carries the same light, so a guest without a
  // picture still shows that it talks.
  const row = rowOf.get(tile);
  if (row) row.classList.toggle('speaking', on);
}

function speakTick() {
  const own = ownTile();
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

// noiseWasm fetches the model once; every processor builds its module from the
// same copy.
function noiseWasm() {
  if (!state.noiseWasm) {
    state.noiseWasm = fetch('/gtcrn.wasm').then((res) => {
      if (!res.ok) throw new Error('gtcrn.wasm ' + res.status);
      return res.arrayBuffer();
    });
  }
  return state.noiseWasm;
}

// makeDenoiseNode builds one GTCRN processor on one context. The microphone and
// every incoming stream that wants it own a node, because the filter state
// belongs to one stream.
async function makeDenoiseNode(ctx) {
  const [binary] = await Promise.all([
    noiseWasm(),
    ctx.audioWorklet.addModule('/gtcrn-node.js'),
  ]);
  return new AudioWorkletNode(ctx, 'gtcrn', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { wasm: new Uint8Array(binary) },
  });
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
      state.denoise = await makeDenoiseNode(state.audioCtx);
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
    el.volume = state.deaf ? 0 : Math.min(volGain(peer.vol), 1);
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
  peer.gain.gain.value = state.deaf ? 0 : volGain(peer.vol);
  peer.audioSrc = ctx.createMediaStreamSource(new MediaStream([track]));
  peer.audioSrc.connect(peer.gain);
  peer.gain.connect(ctx.destination);
  // The talking light reads the source, before the gain, so a guest turned
  // down to zero still shows that they speak.
  peer.meter = ctx.createAnalyser();
  peer.meter.fftSize = 1024;
  peer.audioSrc.connect(peer.meter);
  // A guest whose noise cancel was asked for before this track existed gets it
  // now, without a second toggle.
  if (peer.inNoise) void setPeerNoise(peer, true);
  resumePlayback();
  // A context that is still suspended after a resume attempt plays nothing.
  // Say it, because the video looks correct and only the sound is missing.
  if (ctx.state === 'suspended') say('the browser holds the audio output; tap the page once to hear the room');
}

// dropAudio unhooks one peer from the output, so a closed peer is silent and
// its nodes can be collected.
function dropAudio(peer) {
  if (!peer) return;
  if (peer.inDenoise) {
    try { peer.inDenoise.disconnect(); } catch { /* already gone */ }
  }
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

// wirePlayNoise connects the source of one guest to its gain, through that
// guest's own noise cancel when it is on. The talking light reads the source
// directly, so it keeps working on either path.
function wirePlayNoise(peer) {
  if (!peer.audioSrc || !peer.gain) return;
  try { peer.audioSrc.disconnect(); } catch { /* not connected */ }
  if (peer.inDenoise) {
    try { peer.inDenoise.disconnect(); } catch { /* not connected */ }
  }
  if (peer.inNoise && peer.inDenoise) {
    peer.audioSrc.connect(peer.inDenoise);
    peer.inDenoise.connect(peer.gain);
  } else {
    peer.audioSrc.connect(peer.gain);
  }
  if (peer.meter) peer.audioSrc.connect(peer.meter);
}

// setPeerNoise turns the local noise cancel of one incoming stream on or off.
// The processor is built on the first use of that guest; a browser without Web
// Audio says so once and keeps the raw audio.
async function setPeerNoise(peer, on) {
  if (!peer) return;
  if (on) {
    const ctx = state.playCtx || ensurePlayback();
    if (!ctx) {
      say('this browser can not cancel noise without Web Audio');
      return;
    }
    if (!peer.inDenoise) {
      try {
        peer.inDenoise = await makeDenoiseNode(ctx);
      } catch (err) {
        console.warn('noise cancel unavailable', err);
        say('the local noise cancel is not available in this browser');
        return;
      }
    }
  }
  peer.inNoise = on;
  wirePlayNoise(peer);
}

// sendState tells the room that the microphone, the camera or the hand
// changed. The other clients show it as a small flag on the tile.
function sendState() {
  refreshSelf();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ t: 'state', mic: state.mic, cam: state.cam, deaf: state.deaf, screen: !!state.screen, hand: state.hand });
  }
}

// setHand raises or lowers the own hand and tells the room. The server numbers
// every raise, so the queue order is the same in every client, and a hand that
// is lowered and raised again goes to the back.
function setHand(on) {
  if (state.waiting || state.hand === on) return;
  state.hand = on;
  if (!on) state.handSeq = 0;
  const self = ownTile();
  if (self) applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  updateButtons();
  sendState();
  paintHandQueue();
}

// paintHandQueue draws the raised hands in the order the server numbered them:
// the first row holds the hand that the room answers next. An admin gets a
// button on every row that takes that hand down.
function paintHandQueue() {
  const panel = document.getElementById('hand-queue');
  const list = document.getElementById('hand-queue-list');
  if (!panel || !list) return;
  const rows = [];
  for (const peer of state.peers.values()) {
    if (peer.hand) rows.push({ id: peer.id, name: peer.name, seq: peer.handSeq, self: false });
  }
  if (state.hand) {
    rows.push({ id: state.self, name: state.name || 'you', seq: state.handSeq, self: true });
  }
  // A hand whose number has not arrived yet goes last, never first.
  rows.sort((a, b) => (a.seq || 1e9) - (b.seq || 1e9));
  panel.hidden = rows.length === 0;
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'hq-row';
    const name = document.createElement('span');
    name.className = 'hq-name';
    name.textContent = row.self ? `${row.name} (you)` : row.name;
    li.appendChild(name);
    if (isAdmin(state.self) && !row.self) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hq-lower';
      b.textContent = 'lower';
      b.setAttribute('aria-label', `take the hand of ${row.name} down`);
      b.addEventListener('click', () => send({ t: 'mod', to: row.id, action: 'lowerhand' }));
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

// setCtrl writes the label of one toolbar button and its pressed state. The
// drawing sits in its own place left of the label, so only the label text and
// the pressed state change here.
function setCtrl(id, text, on) {
  const btn = $(id);
  const label = btn.querySelector('span');
  if (label) label.textContent = text;
  else btn.textContent = text;
  btn.setAttribute('aria-pressed', String(!!on));
}

function updateButtons() {
  setCtrl('mic-btn', state.mic ? 'mic on' : 'mic off', state.mic);
  setCtrl('cam-btn', state.cam ? 'camera on' : 'camera off', state.cam);
  setCtrl('deaf-btn', state.deaf ? 'undeafen' : 'deafen', state.deaf);
  setCtrl('share-btn', state.screen ? 'stop share' : 'share screen', !!state.screen);
  setCtrl('hand-btn', state.hand ? 'lower hand' : 'raise hand', state.hand);
  $('mirror').checked = state.mirror;
  $('pip').checked = state.selfPip;
  $('voice-tiles').checked = !state.voiceTiles;
  // Without a microphone the switch still shows what the next microphone will
  // get, which is the stored choice.
  $('noise-live').checked = state.micSource ? state.denoiseOn : state.noiseWanted;
}

function applyMirror() {
  const tile = ownTile();
  if (!tile) return;
  tile.classList.toggle('mirrored', state.mirror);
  layoutStage();
}

// ---------------------------------------------------------------- camera look

// lookOn answers "is any drawn step wanted". The camera itself is not touched.
function lookOn() {
  return (state.look && state.look !== 'none') || state.masks.length > 0;
}

// maskSet reads a stored or a remote mask choice into the list the frame draws,
// in the order the drawings are layered. One name, a plus-joined list and an
// array all land here; a name this page does not know is dropped.
function maskSet(value) {
  const names = Array.isArray(value) ? value : String(value || '').split(/[+,\s]+/);
  return MASKS.filter((m) => m !== 'none' && names.includes(m));
}

// lookTrack is the drawn track while it is live and the tab draws, or null.
// A parked pipeline hands the camera back to the senders, so the drawn track is
// not the live picture then.
function lookTrack() {
  if (state.lookParked) return null;
  return state.lookOut && state.lookOut.readyState === 'live' ? state.lookOut : null;
}

// The drawn track is painted from a worker clock, not from an animation frame
// loop: a tab that is not in front is handed no animation frames at all, so a
// display-driven loop stops dead and the peers keep the last picture for ever.
// The worker timer lives outside the page's timer budget and ticks at the rate
// of the camera, in front or behind, so one tick is one camera frame and one
// mesh detection.
/** @type {Map<number, string>} */
const drawClockURLs = new Map();
function drawClockURL(fps) {
  const hz = Math.max(MESH_HZ_MIN, Math.min(MESH_HZ_MAX, Math.round(fps) || 30));
  if (!drawClockURLs.has(hz)) {
    drawClockURLs.set(hz, URL.createObjectURL(new Blob(
      [`setInterval(() => postMessage(1), ${Math.round(1000 / hz)});`],
      { type: 'text/javascript' })));
  }
  return drawClockURLs.get(hz);
}

// The mesh points every mask reads, by their canonical FaceMesh numbers. L and
// R are the sides of the drawn frame, which is the camera frame unmirrored: the
// mirror the guest sees is a css flip of the preview, so a landmark x is a
// plain fraction here and needs no turn.
const LM = {
  noseTip: 1, noseBase: 2, lipTop: 0, lip: 13, lipLow: 14, mouthL: 61, mouthR: 291,
  eyeOuterL: 33, eyeInnerL: 133, eyeOuterR: 263, eyeInnerR: 362,
  browL: 105, browR: 334, hairline: 10, chin: 152,
  cheekL: 234, cheekR: 454, templeL: 127, templeR: 356, earL: 93, earR: 323,
};
// The hairline from the temple on the image left to the temple on the right, so
// a fringe follows a head that turns.
const HAIRLINE = [127, 162, 21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 389, 356];

// meshOpenTask is the one landmarker of the page. It outlives a pipeline, so a
// mask switch or a camera switch does not load the wasm again; a failure is
// remembered as null and the skin patch stays in charge for the session.
/** @type {Promise<any> | null} */
let meshOpenTask = null;

// meshOpen loads the landmarker in the background. It never throws into a call:
// a browser without wasm, without the memory or too old gives null and the
// colour test keeps placing the mask.
function meshOpen() {
  if (!meshOpenTask) {
    meshOpenTask = (async () => {
      const vision = await import(MESH_DIR + 'vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks(MESH_DIR.slice(0, -1));
      // The cpu delegate: a software renderer and a driver without webgl2 both
      // refuse the gpu graph, and one face per frame is small work.
      return await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MESH_DIR + 'face_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    })().catch(() => null);
  }
  return meshOpenTask;
}

// lookStart builds the pipeline once: the camera feeds a video element, every
// frame is drawn on a canvas with the colour step and the mask, and the canvas
// track becomes what peers receive. Nothing is uploaded. A shared screen has its
// own sender, so a look never touches it.
async function lookStart() {
  if (!lookOn() || !state.camTrack) return;
  if (state.lookPipe) return;
  const src = state.camTrack;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([src]);
  // A video element that the page never shows can be treated as unrendered and
  // left undecoded, so it lives off screen instead of outside the document.
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  try { await video.play(); } catch { /* the first frame comes later */ }
  const settings = src.getSettings ? src.getSettings() : {};
  // The picture and the mesh both run at the camera rate: the camera states
  // its own frame rate, and a step without one is a camera at thirty.
  const fps = Math.max(MESH_HZ_MIN, Math.min(MESH_HZ_MAX, Math.round(settings.frameRate) || 30));
  const scale = Math.min(1, LOOK_MAX / Math.max(settings.width || 1280, settings.height || 720));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round((settings.width || 1280) * scale));
  canvas.height = Math.max(2, Math.round((settings.height || 720) * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;
  const stream = canvas.captureStream(fps);
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.contentHint = 'motion';
  // A 64 x 48 sample for the skin patch of a mask. It is read in this tab
  // only, and it never leaves it.
  const sample = document.createElement('canvas');
  sample.width = 64;
  sample.height = 48;
  const sctx = sample.getContext('2d', { alpha: false, willReadFrequently: true });
  // A second, bigger sample for the landmarker. It keeps the shape of the
  // camera, so a landmark x is a fraction of the frame the mask is drawn on,
  // and it is only read here.
  const meshCanvas = document.createElement('canvas');
  meshCanvas.width = MESH_W;
  meshCanvas.height = Math.min(320, Math.max(128, 2 * Math.round((MESH_W * (settings.height || 720)) / (settings.width || 1280) / 2)));
  const meshCtx = meshCanvas.getContext('2d', { alpha: false });
  const pipe = {
    src, video, canvas, ctx, sample, sctx, meshCanvas, meshCtx, stream, track, fps,
    clock: null, clockURL: drawClockURL(fps), anchor: null, frame: 0,
    mesh: null, meshTried: false, meshBusy: false, meshLast: 0,
  };
  state.lookPipe = pipe;
  state.lookSrc = src;
  // A hidden tab can leave the source element paused, and the clock draws from
  // it, so it is asked to play on every move of the tab.
  pipe.wake = () => {
    const playing = video.play();
    if (playing && playing.catch) playing.catch(() => {});
  };
  document.addEventListener('visibilitychange', pipe.wake);
  state.lookOut = track;
  // A hidden tab paints nothing, so a pipeline that starts while the tab is
  // away keeps the camera on the senders and the drawn track comes back with
  // the first frame after the tab returns.
  state.lookParked = !!document.hidden;
  if (!state.lookParked) pipe.clock = lookClock(pipe);
  await lookPublish(state.lookParked ? src : track);
}

// lookClock starts the frame clock of a pipeline. It stops with a parked tab:
// a background tab draws nothing, so it should not read a camera either.
function lookClock(p) {
  const clock = new Worker(p.clockURL || drawClockURL(p.fps));
  clock.onmessage = () => {
    if (state.lookPipe === p) lookDraw(p);
  };
  return clock;
}

// lookDraw paints one frame: the colour step, then the mask on the face patch.
// The camera goes in unmirrored, which is what the peers get and what the
// landmarks are measured on.
function lookDraw(p) {
  if (state.lookParked) return;
  if (p.video.readyState < 2 || !p.video.videoWidth) return;
  const filter = LOOKS[state.look] || 'none';
  if (filter !== 'none') p.ctx.filter = filter;
  p.ctx.drawImage(p.video, 0, 0, p.canvas.width, p.canvas.height);
  if (filter !== 'none') p.ctx.filter = 'none';
  if (!state.masks.length || !p.sctx) return;
  p.frame++;
  lookMesh(p);
  // The colour test leads only until a mesh anchor exists, and it holds the
  // place for the whole session when the landmarker never arrives.
  if (p.frame % 2 === 1 && !(p.anchor && p.anchor.lm)) lookAnchor(p);
  const a = p.anchor || { x: 0.5, y: 0.42, w: 0.4, h: 0.42 };
  for (const which of state.masks) {
    if (which === 'big') lookWarp(p, a, filter);
    else if (which === 'wide') lookWide(p, a, filter);
    else if (which === 'small') lookSmall(p, a, filter);
    else drawMask(p.ctx, p.canvas.width, p.canvas.height, which, a);
  }
}

// lookMesh runs the landmarker on the small copy of the frame, once per painted
// frame: the mesh rate is the camera rate. One detection at a time and no
// queue, so a slow machine drops frames instead of piling them up.
function lookMesh(p) {
  if (!p.meshTried) {
    p.meshTried = true;
    meshOpen().then((fm) => { p.mesh = fm; });
  }
  if (!p.mesh || p.meshBusy || !p.meshCtx || document.hidden) return;
  p.meshBusy = true;
  try {
    p.meshCtx.drawImage(p.video, 0, 0, p.meshCanvas.width, p.meshCanvas.height);
    // The landmarker refuses two detections with one timestamp, so the stamp of
    // a frame is the clock and never a repeat of the one before.
    const now = Math.round(performance.now());
    const last = p.meshLast || 0;
    p.meshLast = now > last ? now : last + 1;
    const res = p.mesh.detectForVideo(p.meshCanvas, p.meshLast);
    const lm = res && res.faceLandmarks && res.faceLandmarks[0];
    if (lm && lm.length) lookMeshAnchor(p, lm);
  } catch {
    // A frame that came in half decoded can fail a detect; the last anchor
    // keeps the mask in place and the next frame tries again.
  } finally {
    p.meshBusy = false;
  }
}

// lookMeshAnchor turns the first face into the same anchor the colour test
// makes, plus every point of the mesh, and smooths both. A face that leaves the
// frame finds the last anchor still there, so a mask does not flick to a corner.
function lookMeshAnchor(p, lm) {
  const pts = new Float32Array(lm.length * 2);
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < lm.length; i++) {
    const x = lm[i].x, y = lm[i].y;
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const next = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, lm: pts };
  // How far the lips are apart, as a share of the face height: the dog tongue
  // reads it, and a mouth that closes keeps it for about a second.
  const faceH = Math.hypot(pts[LM.chin * 2] - pts[LM.hairline * 2], pts[LM.chin * 2 + 1] - pts[LM.hairline * 2 + 1]) || 1;
  const lipGap = Math.hypot(pts[LM.lipLow * 2] - pts[LM.lip * 2], pts[LM.lipLow * 2 + 1] - pts[LM.lip * 2 + 1]);
  next.tongue = lipGap / faceH > 0.03 ? 1 : 0;
  const a = p.anchor;
  // A first face, or one from the colour test, is taken whole: the points carry
  // the shape, and a blend with a box would only blur the first mask.
  if (!a || !a.lm || a.lm.length !== pts.length) {
    p.anchor = next;
    return;
  }
  const k = 0.35;
  a.x += (next.x - a.x) * k;
  a.y += (next.y - a.y) * k;
  a.w += (next.w - a.w) * k;
  a.h += (next.h - a.h) * k;
  a.tongue = Math.max(next.tongue, (a.tongue || 0) * 0.9);
  for (let i = 0; i < pts.length; i++) a.lm[i] += (pts[i] - a.lm[i]) * k;
}

// lookAnchor finds the face patch with the classic skin tone test on the small
// sample, and moves the last place towards it, so a mask does not jump.
function lookAnchor(p) {
  try { p.sctx.drawImage(p.video, 0, 0, 64, 48); } catch { return; }
  let data;
  try { data = p.sctx.getImageData(0, 0, 64, 48).data; } catch { return; }
  let n = 0, sx = 0, sy = 0, x0 = 64, y0 = 48, x1 = 0, y1 = 0;
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 95 && g > 40 && b > 20 && r > b + 15 && r > g && g > b && Math.abs(r - g) > 15) {
        n++; sx += x; sy += y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  // Too few skin pixels: no face in this frame, so the last place stays.
  if (n < 50) return;
  const next = { x: sx / n / 64, y: sy / n / 48, w: (x1 - x0 + 1) / 64, h: (y1 - y0 + 1) / 48 };
  if (!p.anchor) { p.anchor = next; return; }
  const k = 0.25;
  p.anchor = {
    x: p.anchor.x + (next.x - p.anchor.x) * k,
    y: p.anchor.y + (next.y - p.anchor.y) * k,
    w: p.anchor.w + (next.w - p.anchor.w) * k,
    h: p.anchor.h + (next.h - p.anchor.h) * k,
  };
}

// roundPath draws a rounded rectangle path, so the glasses fit a face.
function roundPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// gap is the distance between two points in pixels.
function gap(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

// unit is a direction of length one, so a face axis can be used as a ruler.
function unit(x, y) {
  const m = Math.hypot(x, y) || 1;
  return [x / m, y / m];
}

// roll is the angle of the eye line, the tilt a head has when it leans.
function roll(g) {
  return Math.atan2(g.eyeR[1][1] - g.eyeL[0][1], g.eyeR[1][0] - g.eyeL[0][0]);
}

// maskGeo reads an anchor into pixels. A mesh anchor carries every point of the
// face; a skin anchor carries only a box, so the same points are stood in the
// box and one drawing serves both, fine on a mesh and sane without one.
function maskGeo(a, W, H) {
  const cx = a.x * W;
  const cy = a.y * H;
  const bw = Math.max(a.w * W, W * 0.22);
  const bh = Math.max(a.h * H, H * 0.26);
  const lm = a.lm && a.lm.length >= 468 * 2 ? a.lm : null;
  // A face point, or the same place in the box when there is no mesh.
  const at = (i, fx, fy) => (lm ? [lm[i * 2] * W, lm[i * 2 + 1] * H] : [cx + bw * fx, cy + bh * fy]);
  const outerL = at(LM.eyeOuterL, -0.34, -0.12);
  const innerL = at(LM.eyeInnerL, -0.16, -0.12);
  const innerR = at(LM.eyeInnerR, 0.16, -0.12);
  const outerR = at(LM.eyeOuterR, 0.34, -0.12);
  const top = at(LM.hairline, 0, -0.52);
  const chin = at(LM.chin, 0, 0.5);
  const sideL = at(LM.cheekL, -0.5, 0);
  const sideR = at(LM.cheekR, 0.5, 0);
  // The face is measured from the chin to the hairline and ear to ear, so a
  // mask is sized from the face and not from the box the colour test finds.
  const fw = (lm && gap(sideL, sideR)) || bw;
  const fh = (lm && gap(top, chin)) || bh;
  // The face axes: across the frame and up the face. A head that turns or leans
  // carries every mask with it.
  const ax = unit(sideR[0] - sideL[0], sideR[1] - sideL[1]);
  const ay = unit(top[0] - chin[0], top[1] - chin[1]);
  const spot = (o, s, t) => [o[0] + ax[0] * s * fw + ay[0] * t * fh, o[1] + ax[1] * s * fw + ay[1] * t * fh];
  return {
    fw, fh, spot, top, chin, ax, ay,
    nose: at(LM.noseTip, 0, 0.1),
    noseBase: at(LM.noseBase, 0, 0.16),
    lipTop: at(LM.lipTop, 0, 0.22),
    lip: at(LM.lip, 0, 0.26),
    lipLow: at(LM.lipLow, 0, 0.3),
    mouthL: at(LM.mouthL, -0.2, 0.28),
    mouthR: at(LM.mouthR, 0.2, 0.28),
    eyeL: [outerL, innerL],
    eyeR: [innerR, outerR],
    browL: at(LM.browL, -0.25, -0.24),
    browR: at(LM.browR, 0.25, -0.24),
    templeL: at(LM.templeL, -0.46, -0.16),
    templeR: at(LM.templeR, 0.46, -0.16),
    earL: at(LM.earL, -0.48, 0.02),
    earR: at(LM.earR, 0.48, 0.02),
    // The hairline from the temple on the left of the frame over the head to
    // the right one, so a fringe follows a head that turns.
    hair: HAIRLINE.map((i, k) => at(i, -0.44 + (0.88 * k) / (HAIRLINE.length - 1),
      -0.4 - 0.1 * Math.cos((k / (HAIRLINE.length - 1) - 0.5) * Math.PI))),
    tongue: a.tongue || 0,
  };
}

// The big effect is a warp and not a drawing: a patch of the camera picture is
// scaled about the middle of an eye or of the mouth and laid back on the face,
// the way a phone filter does it. Every patch is read from the video element,
// so a frame is never read back, and its own edge is feathered so no seam shows.
function lookWarp(p, a, filter) {
  const W = p.canvas.width, H = p.canvas.height;
  const g = maskGeo(a, W, H);
  for (const eye of [g.eyeL, g.eyeR]) {
    const cx = (eye[0][0] + eye[1][0]) / 2;
    const cy = (eye[0][1] + eye[1][1]) / 2;
    const rx = Math.max(gap(eye[0], eye[1]) * 0.64, 5);
    warpPatch(p, cx, cy, rx, rx * 0.78, 1.5, 1.62, filter);
  }
  const cx = (g.mouthL[0] + g.mouthR[0]) / 2;
  const cy = (g.lipTop[1] + g.lipLow[1]) / 2;
  const rx = Math.max(gap(g.mouthL, g.mouthR) * 0.62, 5);
  const ry = Math.max((g.lipLow[1] - g.lipTop[1]) * 1.1, rx * 0.42);
  warpPatch(p, cx, cy, rx, ry, 1.3, 1.5, filter);
}

// The wide effect stretches the whole head sideways: one box over the face,
// widened and left at its own height, so the eyes, the nose and the mouth all
// move out together and the head reads as very wide. The box takes the crown
// as well as the face, because the head above the hairline is a third of the
// face height, and a stretch of the face alone would leave a narrow forehead.
// The patch is measured on the face, so a head that turns or leans keeps it.
function lookWide(p, a, filter) {
  const W = p.canvas.width, H = p.canvas.height;
  const g = maskGeo(a, W, H);
  // The middle of the face from the two outer eye corners, and the box from
  // above the crown to below the chin.
  const cx = (g.eyeL[0][0] + g.eyeR[1][0]) / 2;
  // The box takes the hair as well as the face: a head is wider than the
  // cheeks and taller than the hairline, so a box on the face alone leaves the
  // hair outside it and a cut shows. The top sits two crowns above the
  // hairline, which is empty frame above most heads, so its fade never lands
  // on hair.
  const top = g.top[1] - g.fh * 0.78;
  const bottom = g.chin[1] + g.fh * 0.08;
  const rx = Math.max(g.fw * 0.78, 8);
  const ry = Math.max((bottom - top) / 2, 8);
  warpWide(p, cx, (top + bottom) / 2, rx, ry, 1.8, roll(g), filter);
}

// warpWide draws one box of the video, stretched by kx across and kept at its
// own height, along the axes of the face: the box turns with the head, so a
// lean does not cut it. A short fade on each edge meets the untouched frame,
// and the box stays solid inside, so the forehead and the hair widen with the
// rest of the head instead of fading back to their own width.
function warpWide(p, cx, cy, rx, ry, kx, rollAngle, filter) {
  const W = p.canvas.width, H = p.canvas.height;
  const vw = p.video.videoWidth, vh = p.video.videoHeight;
  const dw = 2 * rx * kx, dh = 2 * ry;
  const iw = Math.ceil(dw), ih = Math.ceil(dh);
  if (iw < 8 || ih < 8 || !vw || !vh) return;
  if (!p.wideCanvas) {
    p.wideCanvas = document.createElement('canvas');
    p.wideCtx = p.wideCanvas.getContext('2d');
  }
  const c = p.wideCanvas, cc = p.wideCtx;
  if (c.width < iw) c.width = iw;
  if (c.height < ih) c.height = ih;
  // The box turns with the head: the canvas is laid along the face axes, and
  // the video goes in through one transform. Only the turning bounding box of
  // the box is read, so a lean does not read the whole frame.
  const cos = Math.abs(Math.cos(rollAngle)), sin = Math.abs(Math.sin(rollAngle));
  const ex = rx * cos + ry * sin, ey = rx * sin + ry * cos;
  const x0 = Math.max(0, (cx - ex) * vw / W), x1 = Math.min(vw, (cx + ex) * vw / W);
  const y0 = Math.max(0, (cy - ey) * vh / H), y1 = Math.min(vh, (cy + ey) * vh / H);
  const bx = x0, by = y0, bw = x1 - x0, bh = y1 - y0;
  cc.clearRect(0, 0, iw, ih);
  cc.globalCompositeOperation = 'source-over';
  if (bw > 2 && bh > 2) {
    cc.save();
    cc.translate(iw / 2, ih / 2);
    cc.scale(iw / (2 * rx), ih / (2 * ry));
    cc.rotate(-rollAngle);
    cc.translate(-cx, -cy);
    cc.scale(W / vw, H / vh);
    cc.drawImage(p.video, bx, by, bw, bh, bx, by, bw, bh);
    cc.restore();
  }
  // Two fades, one per axis, so the short edge is a straight line and not a
  // ring: twelve percent at each side, and the head itself stays solid.
  cc.globalCompositeOperation = 'destination-in';
  const fade = (x0, y0, x1, y1) => {
    const grad = cc.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.12, 'rgba(0,0,0,1)');
    grad.addColorStop(0.88, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    cc.fillStyle = grad;
    cc.fillRect(0, 0, iw, ih);
  };
  fade(0, 0, iw, 0);
  fade(0, 0, 0, ih);
  cc.globalCompositeOperation = 'source-over';
  // The patch goes back along the same angle, so the widened head sits on the
  // face it came from.
  if (filter && filter !== 'none') p.ctx.filter = filter;
  p.ctx.save();
  p.ctx.translate(cx, cy);
  p.ctx.rotate(rollAngle);
  p.ctx.drawImage(c, 0, 0, iw, ih, -dw / 2, -dh / 2, dw, dh);
  p.ctx.restore();
  if (filter && filter !== 'none') p.ctx.filter = 'none';
}

// The small effect shrinks the middle of the face and pads it out: the skin
// above the brows is stretched over a box as a plain pad, and the eyes, the
// nose and the mouth are drawn small in the middle of it, so the face keeps a
// wide ring of skin around them. Both layers come from the camera element, the
// pad is skin and not a colour, and the box fades at its edge onto the cheeks.
function lookSmall(p, a, filter) {
  const W = p.canvas.width, H = p.canvas.height;
  const g = maskGeo(a, W, H);
  const vw = p.video.videoWidth, vh = p.video.videoHeight;
  const cx = (g.eyeL[0][0] + g.eyeR[1][0]) / 2;
  const browY = Math.min(g.browL[1], g.browR[1]);
  const lipY = g.lipLow[1];
  const fcy = (browY + lipY) / 2;
  // The block of skin that is drawn small takes a margin around the features
  // and not the features alone: the soft edge of the block cuts the outer
  // tenth, and a mouth on that edge would fade away with it.
  const frx = Math.max((g.eyeR[1][0] - g.eyeL[0][0]) / 2, g.fw * 0.3) * 1.25;
  const fry = Math.max((lipY - browY) / 2, g.fh * 0.12) * 1.55;
  // The pad takes the whole face and not a box around the middle: the cheeks
  // left and right, the hairline above and the chin below, so every feature
  // sits well inside it and the edge of the pad is the edge of the face.
  const pcx = cx;
  const pcy = (g.top[1] + g.chin[1]) / 2;
  const prx = Math.max(g.fw * 0.52, 8), pry = Math.max(g.fh * 0.54, 8);
  const iw = Math.ceil(2 * prx), ih = Math.ceil(2 * pry);
  if (iw < 8 || ih < 8 || !vw || !vh) return;
  const vx = (x) => x * vw / W, vy = (y) => y * vh / H;
  if (!p.smallCanvas) {
    p.smallCanvas = document.createElement('canvas');
    p.smallCtx = p.smallCanvas.getContext('2d');
    p.smallFeat = document.createElement('canvas');
    p.smallFeatCtx = p.smallFeat.getContext('2d');
  }
  const c = p.smallCanvas, cc = p.smallCtx;
  if (c.width < iw) c.width = iw;
  if (c.height < ih) c.height = ih;
  // A pad of forehead skin, stretched over the box: the only face skin that no
  // feature sits on. A small blur hides the stretch.
  const bandY = g.top[1] + g.fh * 0.02;
  const bandH = Math.max(g.fh * 0.14, 4);
  cc.clearRect(0, 0, iw, ih);
  cc.globalCompositeOperation = 'source-over';
  cc.filter = 'blur(6px)';
  cc.drawImage(p.video, vx(pcx - prx), vy(bandY), vx(2 * prx), vy(bandH), 0, 0, iw, ih);
  cc.filter = 'none';
  // The middle of the face, small, on the pad.
  const k = 0.55;
  const fw = Math.ceil(2 * frx * k), fh = Math.ceil(2 * fry * k);
  const f = p.smallFeat, fc = p.smallFeatCtx;
  if (f.width < fw) f.width = fw;
  if (f.height < fh) f.height = fh;
  fc.clearRect(0, 0, fw, fh);
  fc.globalCompositeOperation = 'source-over';
  fc.drawImage(p.video, vx(cx - frx), vy(fcy - fry), vx(2 * frx), vy(2 * fry), 0, 0, fw, fh);
  // A soft edge, so the small middle sits on the pad and not as a pasted block.
  fc.globalCompositeOperation = 'destination-in';
  fc.save();
  fc.translate(fw / 2, fh / 2);
  fc.scale(1, fh / fw);
  const soft = fc.createRadialGradient(0, 0, 0, 0, 0, fw / 2);
  soft.addColorStop(0, 'rgba(0,0,0,1)');
  soft.addColorStop(0.72, 'rgba(0,0,0,1)');
  soft.addColorStop(1, 'rgba(0,0,0,0)');
  fc.fillStyle = soft;
  fc.fillRect(-fw / 2, -fw / 2, fw, fw);
  fc.restore();
  fc.globalCompositeOperation = 'source-over';
  cc.drawImage(f, 0, 0, fw, fh, iw / 2 - fw / 2, ih / 2 + (fcy - pcy) / (2 * pry) * ih - fh / 2, fw, fh);
  // The pad keeps the shape of a face and not of a box: the edge is an ellipse
  // that fades over the last part of the cheek, so no corner and no straight
  // line shows.
  cc.globalCompositeOperation = 'destination-in';
  cc.save();
  cc.translate(iw / 2, ih / 2);
  cc.scale(1, ih / iw);
  const edge = cc.createRadialGradient(0, 0, 0, 0, 0, iw / 2);
  edge.addColorStop(0, 'rgba(0,0,0,1)');
  edge.addColorStop(0.84, 'rgba(0,0,0,1)');
  edge.addColorStop(1, 'rgba(0,0,0,0)');
  cc.fillStyle = edge;
  cc.fillRect(-iw / 2, -iw / 2, iw, iw);
  cc.restore();
  cc.globalCompositeOperation = 'source-over';
  if (filter && filter !== 'none') p.ctx.filter = filter;
  p.ctx.drawImage(c, 0, 0, iw, ih, pcx - prx, pcy - pry, 2 * prx, 2 * pry);
  if (filter && filter !== 'none') p.ctx.filter = 'none';
}

// warpPatch draws one ellipse of the video, widened by kx and heightened by ky
// about its centre. The patch is prepared on a small reused canvas; a frame
// pays three of them, and the colour step of the look is applied again so the
// patch matches the picture around it.
function warpPatch(p, cx, cy, rx, ry, kx, ky, filter) {
  const W = p.canvas.width, H = p.canvas.height;
  const dw = 2 * rx * kx, dh = 2 * ry * ky;
  const iw = Math.ceil(dw), ih = Math.ceil(dh);
  const vw = p.video.videoWidth, vh = p.video.videoHeight;
  if (iw < 8 || ih < 8 || !vw || !vh) return;
  if (!p.warpCanvas) {
    p.warpCanvas = document.createElement('canvas');
    p.warpCtx = p.warpCanvas.getContext('2d');
  }
  const c = p.warpCanvas, cc = p.warpCtx;
  if (c.width < iw) c.width = iw;
  if (c.height < ih) c.height = ih;
  // The same ellipse in the frame, in video pixels, as the source.
  const sx = (cx - rx) * vw / W, sy = (cy - ry) * vh / H;
  cc.clearRect(0, 0, iw, ih);
  cc.globalCompositeOperation = 'source-over';
  cc.drawImage(p.video, sx, sy, 2 * rx * vw / W, 2 * ry * vh / H, 0, 0, iw, ih);
  // The edge fades out, so the enlarged patch sits on the face and not on it
  // as a pasted oval. The gradient is stretched to the patch shape.
  cc.globalCompositeOperation = 'destination-in';
  cc.save();
  cc.translate(iw / 2, ih / 2);
  cc.scale(1, ih / iw);
  const grad = cc.createRadialGradient(0, 0, 0, 0, 0, iw / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.72, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  cc.fillStyle = grad;
  cc.fillRect(-iw / 2, -iw / 2, iw, iw);
  cc.restore();
  cc.globalCompositeOperation = 'source-over';
  if (filter && filter !== 'none') p.ctx.filter = filter;
  p.ctx.drawImage(c, 0, 0, iw, ih, cx - dw / 2, cy - dh / 2, dw, dh);
  if (filter && filter !== 'none') p.ctx.filter = 'none';
}


// drawMask puts one mask on a face. Every mask reads the face geometry, so the
// same points carry a mesh mask and the box the colour test gives.
function drawMask(ctx, W, H, which, a) {
  const g = maskGeo(a, W, H);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (which === 'glasses') drawGlasses(ctx, g);
  else if (which === 'shades') drawShades(ctx, g);
  else if (which === 'moustache') drawMoustache(ctx, g);
  else if (which === 'cat') drawCat(ctx, g);
  else if (which === 'dog') drawDog(ctx, g);
  else if (which === 'halo') drawHalo(ctx, g);
  else if (which === 'miku') drawMiku(ctx, g);
  ctx.restore();
}

// eyeFrame is the middle, width and angle of one eye, from its two corners.
function eyeFrame(e) {
  const [o, i] = e;
  return {
    x: (o[0] + i[0]) / 2,
    y: (o[1] + i[1]) / 2,
    w: gap(o, i),
    ang: Math.atan2(i[1] - o[1], i[0] - o[0]),
  };
}

// drawGlasses puts a lens on each eye, the bridge between the inner corners and
// one arm to each temple, so the frame follows a face that leans.
function drawGlasses(ctx, g) {
  ctx.fillStyle = 'rgba(20, 24, 32, 0.5)';
  ctx.strokeStyle = '#14181f';
  ctx.lineWidth = Math.max(2, g.fw * 0.022);
  const sides = [
    { e: g.eyeL, brow: g.browL, out: g.templeL },
    { e: g.eyeR, brow: g.browR, out: g.templeR },
  ];
  for (const s of sides) {
    const f = eyeFrame(s.e);
    const ew = f.w || g.fw * 0.16;
    const bw = ew * 1.8;
    const bh = ew * 1.2;
    // A lens sits a little towards the brow, which is where glasses sit.
    const lift = Math.max(0, (f.y - s.brow[1]) * 0.18);
    ctx.save();
    ctx.translate(f.x, f.y - lift);
    ctx.rotate(f.ang);
    roundPath(ctx, -bw / 2, -bh / 2, bw, bh, bh * 0.42);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // The arm leaves the outer half of the lens for the side of the face.
    const ux = unit(s.e[0][0] - s.e[1][0], s.e[0][1] - s.e[1][1]);
    ctx.beginPath();
    ctx.moveTo(f.x + ux[0] * bw * 0.5, f.y - lift + ux[1] * bw * 0.5);
    ctx.lineTo(s.out[0], s.out[1]);
    ctx.stroke();
  }
  // The bridge sits on the inner corners.
  ctx.beginPath();
  ctx.moveTo(g.eyeL[1][0], g.eyeL[1][1]);
  ctx.lineTo(g.eyeR[1][0], g.eyeR[1][1]);
  ctx.stroke();
}

// drawShades puts a tilted teardrop lens over each eye, dark at the top and lit
// along the upper edge, on the eye line across the whole frame.
function drawShades(ctx, g) {
  const ang = roll(g);
  const sides = [
    { e: g.eyeL, brow: g.browL, out: g.templeL },
    { e: g.eyeR, brow: g.browR, out: g.templeR },
  ];
  ctx.strokeStyle = '#0d1117';
  ctx.lineWidth = Math.max(1.5, g.fw * 0.016);
  for (const s of sides) {
    const f = eyeFrame(s.e);
    const ew = f.w || g.fw * 0.16;
    const w = ew * 2.1;
    const h = ew * 1.5;
    // The brow holds the frame down, so a look up does not lift the glasses.
    const lift = Math.max(0, (f.y - s.brow[1]) * 0.3);
    ctx.save();
    ctx.translate(f.x, f.y - lift);
    ctx.rotate(ang);
    const grad = ctx.createLinearGradient(0, -h * 0.6, 0, h * 0.6);
    grad.addColorStop(0, 'rgba(10, 14, 22, 0.85)');
    grad.addColorStop(1, 'rgba(62, 102, 138, 0.6)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, -h * 0.16);
    ctx.bezierCurveTo(-w * 0.46, -h * 0.62, -w * 0.12, -h * 0.6, 0, -h * 0.56);
    ctx.bezierCurveTo(w * 0.12, -h * 0.6, w * 0.46, -h * 0.62, w * 0.5, -h * 0.16);
    ctx.bezierCurveTo(w * 0.44, h * 0.5, w * 0.16, h * 0.56, 0, h * 0.56);
    ctx.bezierCurveTo(-w * 0.16, h * 0.56, -w * 0.44, h * 0.5, -w * 0.5, -h * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // The bright top edge, where the sky and the ring catch the glass.
    ctx.strokeStyle = 'rgba(176, 220, 255, 0.9)';
    ctx.lineWidth = Math.max(1, g.fw * 0.012);
    ctx.beginPath();
    ctx.moveTo(-w * 0.44, -h * 0.2);
    ctx.bezierCurveTo(-w * 0.4, -h * 0.56, -w * 0.12, -h * 0.54, 0, -h * 0.5);
    ctx.bezierCurveTo(w * 0.12, -h * 0.54, w * 0.4, -h * 0.56, w * 0.44, -h * 0.2);
    ctx.stroke();
    ctx.restore();
    // The arm leaves the outer edge for the side of the face.
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = Math.max(1.5, g.fw * 0.016);
    const ux = unit(s.e[0][0] - s.e[1][0], s.e[0][1] - s.e[1][1]);
    ctx.beginPath();
    ctx.moveTo(f.x + ux[0] * w * 0.5, f.y - lift + ux[1] * w * 0.5);
    ctx.lineTo(s.out[0], s.out[1]);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(g.eyeL[1][0], g.eyeL[1][1]);
  ctx.lineTo(g.eyeR[1][0], g.eyeR[1][1]);
  ctx.stroke();
}

// drawMoustache follows the upper lip from one corner to the other and sits
// between the nose base and the lip line.
function drawMoustache(ctx, g) {
  const l = g.mouthL;
  const r = g.mouthR;
  const mx = (l[0] + r[0]) / 2;
  const half = gap(l, r) / 2 || g.fw * 0.2;
  const room = Math.max(2, g.lip[1] - g.noseBase[1]);
  const ty = g.noseBase[1] + room * 0.15;
  const by = g.lip[1] + room * 0.12;
  ctx.fillStyle = '#2a1c14';
  ctx.beginPath();
  ctx.moveTo(l[0], l[1]);
  // Over the lip: up at the nose wings, a dip in the middle.
  ctx.bezierCurveTo(l[0] + half * 0.5, ty - room * 0.2, mx - half * 0.5, ty - room * 0.3, mx, ty + room * 0.12);
  ctx.bezierCurveTo(mx + half * 0.5, ty - room * 0.3, r[0] - half * 0.5, ty - room * 0.2, r[0], r[1]);
  // Back under the lip, with a droop at each corner.
  ctx.bezierCurveTo(r[0] - half * 0.3, by + room * 0.35, mx + half * 0.4, by + room * 0.4, mx, by);
  ctx.bezierCurveTo(mx - half * 0.4, by + room * 0.4, l[0] + half * 0.3, by + room * 0.35, l[0], l[1]);
  ctx.closePath();
  ctx.fill();
}

// drawCat puts two ears on the hairline, one each side of the head, along the
// face axes so a leaning head keeps them on.
function drawCat(ctx, g) {
  ctx.strokeStyle = '#20242c';
  ctx.lineWidth = Math.max(1.5, g.fw * 0.012);
  for (const side of [-1, 1]) {
    const a = g.spot(g.top, side * 0.42, -0.04);
    const b = g.spot(g.top, side * 0.18, 0.02);
    const t = g.spot(g.top, side * 0.38, 0.17);
    ctx.fillStyle = '#3a3f4b';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(t[0], t[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // The inner ear, the same triangle pulled a little towards its middle.
    const mx = (a[0] + b[0] + t[0]) / 3;
    const my = (a[1] + b[1] + t[1]) / 3;
    const k = 0.45;
    ctx.fillStyle = '#e08aa8';
    ctx.beginPath();
    ctx.moveTo(a[0] + (mx - a[0]) * k, a[1] + (my - a[1]) * k);
    ctx.lineTo(t[0] + (mx - t[0]) * k, t[1] + (my - t[1]) * k);
    ctx.lineTo(b[0] + (mx - b[0]) * k, b[1] + (my - b[1]) * k);
    ctx.closePath();
    ctx.fill();
  }
}

// drawDog puts two floppy ears on the sides of the head, a nose on the nose tip
// and a tongue under the lip that hangs out while the mouth is open.
function drawDog(ctx, g) {
  ctx.strokeStyle = '#241a15';
  ctx.lineWidth = Math.max(1.5, g.fw * 0.012);
  for (const side of [-1, 1]) {
    const base = side < 0 ? g.templeL : g.templeR;
    const a = g.spot(base, side * 0.04, 0.02);
    const b = g.spot(base, -side * 0.04, -0.02);
    const tip = g.spot(base, side * 0.16, -0.5);
    const c1 = g.spot(base, side * 0.22, -0.1);
    const c2 = g.spot(base, side * 0.24, -0.36);
    const d2 = g.spot(base, side * 0.02, -0.38);
    const d1 = g.spot(base, -side * 0.04, -0.12);
    ctx.fillStyle = '#4a352a';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], tip[0], tip[1]);
    ctx.bezierCurveTo(d2[0], d2[1], d1[0], d1[1], b[0], b[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // A lighter fold inside the ear, so it reads as a flap of skin.
    const i1 = g.spot(base, side * 0.1, -0.12);
    const i2 = g.spot(base, side * 0.12, -0.34);
    const i3 = g.spot(base, side * 0.2, -0.24);
    ctx.strokeStyle = 'rgba(255, 214, 194, 0.22)';
    ctx.beginPath();
    ctx.moveTo(i1[0], i1[1]);
    ctx.quadraticCurveTo(i3[0], i3[1], i2[0], i2[1]);
    ctx.stroke();
    ctx.strokeStyle = '#241a15';
  }
  // The nose, on the tip of the nose.
  ctx.save();
  ctx.translate(g.nose[0], g.nose[1]);
  ctx.rotate(roll(g));
  ctx.fillStyle = '#2a2320';
  ctx.beginPath();
  ctx.ellipse(0, 0, g.fw * 0.075, g.fw * 0.055, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.beginPath();
  ctx.ellipse(-g.fw * 0.022, -g.fw * 0.018, g.fw * 0.02, g.fw * 0.013, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // The mouth must be open: the anchor holds the openness for about a second,
  // so a talking mouth does not make the tongue flicker.
  const open = Math.max(0, Math.min(1, g.tongue));
  if (open > 0.06) {
    const mx = (g.mouthL[0] + g.mouthR[0]) / 2;
    const my = (g.lip[1] + g.lipLow[1]) / 2;
    const half = (gap(g.mouthL, g.mouthR) * 0.42) || g.fw * 0.08;
    const tip = g.spot(g.lip, 0, -(0.05 + 0.14 * open));
    ctx.fillStyle = '#e2707f';
    ctx.beginPath();
    ctx.moveTo(mx - half, my);
    ctx.quadraticCurveTo(mx - half * 1.15, tip[1], mx, tip[1]);
    ctx.quadraticCurveTo(mx + half * 1.15, tip[1], mx + half, my);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 54, 74, 0.55)';
    ctx.lineWidth = Math.max(1, g.fw * 0.008);
    ctx.beginPath();
    ctx.moveTo(mx, my + (tip[1] - my) * 0.15);
    ctx.lineTo(mx, tip[1] - (tip[1] - my) * 0.2);
    ctx.stroke();
  }
}

// drawHalo puts a glowing ring over the head, on the forehead line, turned with
// the eye line and sized from the face.
function drawHalo(ctx, g) {
  const c = g.spot(g.top, 0, 0.26);
  const rx = g.fw * 0.42;
  const ry = g.fw * 0.12;
  ctx.save();
  ctx.translate(c[0], c[1]);
  ctx.rotate(roll(g));
  ctx.shadowColor = 'rgba(255, 214, 102, 0.95)';
  ctx.shadowBlur = Math.max(4, g.fw * 0.14);
  ctx.strokeStyle = 'rgba(255, 222, 122, 0.9)';
  ctx.lineWidth = Math.max(2, g.fw * 0.035);
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255, 250, 224, 0.95)';
  ctx.lineWidth = Math.max(1, g.fw * 0.014);
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// The miku mask wears a real drawing: a wig with the face cut out, a CC0 file
// from Wikimedia Commons (static/miku/NOTICE.txt keeps the source and the
// licence). The cut-out is placed on the face and the camera shows through it,
// so the hair is the artist's and the face is the guest's.
const WIG_URL = '/miku/wig.svg';
const WIG_FILE_ASPECT = 334.55 / 366.31;
// The face cut-out inside the drawing, as shares of its width and height, read
// off the file: the fringe edge at the top, the chin at the bottom.
const WIG_HOLE = { x0: 0.2951, y0: 0.3632, x1: 0.7122, y1: 0.7409 };
// The drawing is rastered once at this width and kept as a bitmap, so a frame
// pays for one drawImage and not for the vector work again.
const WIG_PX = 640;
/** @type {HTMLCanvasElement|null} */
let wigArt = null;
let wigTried = false;

// wigLoad reads the drawing into a canvas. It is asked for on the first masked
// frame and never twice; a missing file leaves the vector fringe in place.
function wigLoad() {
  if (wigTried) return;
  wigTried = true;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = WIG_PX;
    c.height = Math.round(WIG_PX * WIG_FILE_ASPECT);
    const cc = c.getContext('2d');
    cc.imageSmoothingQuality = 'high';
    cc.drawImage(img, 0, 0, c.width, c.height);
    wigArt = c;
    // A mask already on screen takes the drawing on the next painted frame.
    const p = state.lookPipe;
    if (p && state.masks.includes('miku')) lookDraw(p);
  };
  img.src = WIG_URL;
}

// drawMiku puts the wig on the face, or the vector fringe while the file is on
// its way. The cut-out is the anchor: it is the width of the face and it runs
// from a little under the hairline to the chin, so the crown sits on the head
// and a tail falls past each ear.
function drawMiku(ctx, g) {
  wigLoad();
  if (!wigArt) return drawMikuFringe(ctx, g);
  const H = WIG_HOLE;
  const top = g.spot(g.top, 0, -0.05);
  const holeW = Math.max(g.fw * 0.98, 1);
  const holeH = Math.max(gap(top, g.chin), g.fh * 0.5);
  // The drawing is a little wider than the face and taller than the cut-out,
  // and it is stretched to the face it wears, so one file fits every face.
  const artW = holeW / (H.x1 - H.x0);
  const artH = holeH / (H.y1 - H.y0);
  const cx = ((H.x0 + H.x1) / 2) * artW;
  const cy = ((H.y0 + H.y1) / 2) * artH;
  const mid = [(top[0] + g.chin[0]) / 2, (top[1] + g.chin[1]) / 2];
  // Local pixels go across the frame with the face axis and down the face with
  // the other, so a head that turns or leans carries the wig with it.
  const ax = g.ax, ay = g.ay;
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.transform(ax[0], ax[1], -ay[0], -ay[1],
    mid[0] - ax[0] * cx + ay[0] * cy, mid[1] - ax[1] * cx + ay[1] * cy);
  ctx.drawImage(wigArt, 0, 0, artW, artH);
  ctx.restore();
}

// drawMikuFringe is the mask without the drawing: a teal fringe along the
// hairline and one long tail behind each ear, in the same colours. It is what a
// missing wig file or a blocked image falls back to.
function drawMikuFringe(ctx, g) {
  const hair = '#39c5bb';
  const h = g.hair;
  if (h.length > 2) {
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.moveTo(h[0][0], h[0][1]);
    for (let i = 1; i < h.length; i++) ctx.lineTo(h[i][0], h[i][1]);
    // Back along a deeper line, with the points taking turns, so the edge is a
    // fringe and not a cap.
    for (let i = h.length - 1; i >= 0; i--) {
      const p = g.spot(h[i], 0, i % 2 ? -0.16 : -0.1);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fill();
  }
  for (const side of [-1, 1]) {
    const base = side < 0 ? g.earL : g.earR;
    const a = g.spot(base, side * 0.05, 0.04);
    const b = g.spot(base, -side * 0.05, -0.02);
    const tip = g.spot(base, side * 0.34, -0.95);
    const c1 = g.spot(base, side * 0.38, -0.22);
    const c2 = g.spot(base, side * 0.44, -0.66);
    const d2 = g.spot(base, side * 0.2, -0.68);
    const d1 = g.spot(base, side * 0.1, -0.26);
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], tip[0], tip[1]);
    ctx.bezierCurveTo(d2[0], d2[1], d1[0], d1[1], b[0], b[1]);
    ctx.closePath();
    ctx.fill();
    // The tie at the base of the tail.
    ctx.fillStyle = '#e8455c';
    ctx.beginPath();
    const t1 = g.spot(base, side * 0.02, -0.02);
    const t2 = g.spot(base, side * 0.14, -0.06);
    const t3 = g.spot(base, side * 0.13, -0.11);
    const t4 = g.spot(base, side * 0.01, -0.07);
    ctx.moveTo(t1[0], t1[1]);
    ctx.lineTo(t2[0], t2[1]);
    ctx.lineTo(t3[0], t3[1]);
    ctx.lineTo(t4[0], t4[1]);
    ctx.closePath();
    ctx.fill();
  }
}

// lookPublish swaps the drawn track into every camera sender and the own
// preview. The screen sender is left alone: it carries the share. It is the
// only path that touches the camera senders, so a look never reaches the screen
// share.
async function lookPublish(track) {
  if (!state.outStream) return;
  const senders = Array.from(state.peers.values()).filter((peer) => {
    const tr = peer.tx && peer.tx.video;
    return tr && !peer.waiting && tr.sender.track !== track;
  });
  if (senders.length) state.lookSwaps++;
  for (const old of state.outStream.getVideoTracks()) {
    if (old !== track) state.outStream.removeTrack(old);
  }
  if (track && !state.outStream.getVideoTracks().includes(track)) state.outStream.addTrack(track);
  await Promise.all(senders.map(async (peer) => {
    await peer.tx.video.sender.replaceTrack(track).catch(() => {});
  }));
  paintSelfCam(true);
}

// lookPark answers a hidden tab. The clock that paints the canvas also runs in
// the background, but a browser may hold the camera element still there, and
// then the canvas would carry one picture for as long as the tab is away. The
// camera track keeps running, so the senders take it while the tab is hidden,
// and the drawn track comes back with the next frame. The camera is not
// stopped, so its light stays on.
async function lookPark(hidden) {
  const p = state.lookPipe;
  if (!p || !state.camTrack || state.lookParked === hidden) return;
  state.lookParked = hidden;
  if (hidden) {
    if (p.clock) {
      p.clock.terminate();
      p.clock = null;
    }
    await lookPublish(state.camTrack);
    return;
  }
  // A paused element may be held by the browser while the tab is away, so one
  // play() and one draw put a fresh frame on the canvas before the swap back.
  try { await p.video.play(); } catch { /* it plays already */ }
  lookDraw(p);
  p.clock = lookClock(p);
  await lookPublish(p.track);
}

// lookStop drops the pipeline. With restore it puts the camera track back on the
// camera senders and the preview.
function lookStop(restore = true) {
  const p = state.lookPipe;
  state.lookPipe = null;
  state.lookOut = null;
  state.lookParked = false;
  state.lookSrc = null;
  state.lookGrace = 0;
  if (state.lookTimer) {
    clearTimeout(state.lookTimer);
    state.lookTimer = null;
  }
  if (p) {
    if (p.wake) document.removeEventListener('visibilitychange', p.wake);
    if (p.clock) p.clock.terminate();
    try { p.video.pause(); } catch { /* already paused */ }
    p.video.srcObject = null;
    if (p.video.parentNode) p.video.parentNode.removeChild(p.video);
    for (const t of p.stream.getTracks()) {
      try { t.stop(); } catch { /* already stopped */ }
    }
  }
  if (!restore) return;
  const track = state.camTrack;
  if (state.outStream) {
    for (const old of state.outStream.getVideoTracks()) state.outStream.removeTrack(old);
    if (track) state.outStream.addTrack(track);
    for (const peer of state.peers.values()) {
      const tr = peer.tx && peer.tx.video;
      if (tr && !peer.waiting) tr.sender.replaceTrack(track || null).catch(() => {});
    }
  }
  paintSelfCam(!!track && state.cam);
}

// lookRestart starts or stops the pipeline to match the current choice and the
// live camera. It is the one path the menu uses, and the camera path calls it
// when the track changes.
//
// A running pipeline is kept while the choice still draws something, and for a
// short grace after the last effect goes off. Every swap of a sender track
// costs a fresh keyframe and the picture blinks, so a menu click that only
// changes what is drawn must not rebuild the pipeline. Only a new camera track,
// or the end of the grace, does that.
function armLookTearDown() {
  if (state.lookTimer) {
    clearTimeout(state.lookTimer);
    state.lookTimer = null;
  }
  if (lookOn()) return;
  if (!state.lookGrace) return;
  const left = Math.max(0, state.lookGrace - Date.now());
  state.lookTimer = setTimeout(() => {
    state.lookTimer = null;
    lookRestart();
  }, left + 250);
}

async function lookRestart() {
  // The camera changed under a running pipeline: the old one is stale.
  if (state.lookPipe && state.lookSrc !== state.camTrack) lookStop(false);
  if (state.lookPipe) {
    if (lookOn()) {
      // An effect is back, so no tear-down is owed. The grace starts again
      // from the next moment every effect is off.
      state.lookGrace = 0;
      armLookTearDown();
      return;
    }
    // Plain passthrough frames keep the track alive, so turning an effect off
    // and on again does not touch the senders.
    if (!state.lookGrace) state.lookGrace = Date.now() + state.lookGraceMs;
    if (Date.now() < state.lookGrace) {
      armLookTearDown();
      return;
    }
    lookStop();
    return;
  }
  if (!lookOn() || !state.camTrack) return;
  await lookStart();
  if (state.lookPipe) {
    state.lookGrace = 0;
    armLookTearDown();
    return;
  }
  lookStop();
}

// lookInit puts the stored choice on the menu rows and wires them. A change
// restarts the pipeline at once; the camera is not asked again. The masks are
// boxes, so any number of them is on at one time.
function lookInit() {
  const saved = load('look');
  state.look = Object.prototype.hasOwnProperty.call(LOOKS, saved) ? saved : 'none';
  state.masks = maskSet(load('mask'));
  const lookPick = $('look-filter');
  if (lookPick) {
    lookPick.value = state.look;
    lookPick.addEventListener('change', () => {
      state.look = Object.prototype.hasOwnProperty.call(LOOKS, lookPick.value) ? lookPick.value : 'none';
      store('look', state.look);
      lookRestart();
    });
  }
  for (const box of maskBoxes()) {
    box.checked = state.masks.includes(box.dataset.mask);
    box.addEventListener('change', () => {
      state.masks = maskSet([...maskBoxes()].filter((b) => b.checked).map((b) => b.dataset.mask));
      store('mask', state.masks.join('+'));
      lookRestart();
    });
  }
}

// maskBoxes is the mask row of the effects menu: one box per drawing.
function maskBoxes() {
  return document.querySelectorAll('#menu-effects input[data-mask]');
}

// lookResize follows a camera step so the canvas keeps the picture's shape.
function lookResize() {
  const p = state.lookPipe;
  if (!p) return;
  const s = state.camTrack && state.camTrack.getSettings ? state.camTrack.getSettings() : {};
  const scale = Math.min(1, LOOK_MAX / Math.max(s.width || 1280, s.height || 720));
  const w = Math.max(2, Math.round((s.width || 1280) * scale));
  const h = Math.max(2, Math.round((s.height || 720) * scale));
  if (w !== p.canvas.width || h !== p.canvas.height) {
    p.canvas.width = w;
    p.canvas.height = h;
  }
}

// ---------------------------------------------------------------- screen share

// replaceScreenTrack points the screen sender of every peer at the display
// track, or at nothing. The camera sender is not touched, so the two pictures
// travel side by side and a share needs no renegotiation.
async function replaceScreenTrack(track) {
  for (const peer of state.peers.values()) {
    const tr = peer.tx && peer.tx.screen;
    if (tr && !peer.waiting) await tr.sender.replaceTrack(track || null).catch(() => {});
  }
}

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    say('screen sharing is not supported by this browser');
    return;
  }
  if (!sealingAvailable() || !state.worker) {
    say('this browser cannot seal media frames, so screen sharing stays off');
    return;
  }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: shareVideo(), audio: true });
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
    await replaceScreenTrack(video);
    // The screen gets its own tile, so the own camera keeps its picture, its
    // mirror and its badge.
    const tile = makeTile(state.name, state.name, true, true);
    tile.dataset.state = 'connected';
    tile.querySelector('.state').textContent = 'your screen';
    tile.classList.add('playing');
    const el = tile.querySelector('video');
    el.srcObject = display;
    el.play().catch(() => {});
    // A screen tile stands in the stage only while it has a picture, and a
    // capture on a slow display gives its first frame after this function
    // returns. The own tile waits for it like a guest's tile does, or the
    // sharer sees nothing of the screen that everyone else sees.
    el.addEventListener('resize', () => layoutStage());
    el.addEventListener('loadedmetadata', () => layoutStage());
    state.screenTile = tile;
  }
  const audio = display.getAudioTracks()[0];
  if (audio && state.audioCtx) {
    state.screenSource = state.audioCtx.createMediaStreamSource(new MediaStream([audio]));
    state.screenSource.connect(state.mixer);
    resumeAudio();
  }
  sendState();
  layoutStage();
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
  sendState();
  await replaceScreenTrack(null);
  if (state.screenTile) {
    state.screenTile.remove();
    state.screenTile = null;
  }
  layoutStage();
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

function ensurePeer(id, mic, cam, deaf, hand, seq) {
  let peer = state.peers.get(id);
  if (peer) {
    if (mic !== undefined || cam !== undefined || deaf !== undefined) {
      peer.mic = mic === undefined ? peer.mic : mic;
      peer.cam = cam === undefined ? peer.cam : cam;
      peer.deaf = deaf === undefined ? peer.deaf : deaf;
      if (hand !== undefined) {
        peer.hand = !!hand;
        peer.handSeq = seq || 0;
      }
      applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
      paintRowDeaf(rowOf.get(peer.tile), peer.deaf);
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
    deaf: deaf === undefined ? false : deaf,
    waiting: false,   // held outside the room, see the waiting room
    hand: !!hand,     // a raised hand, with its place in the queue
    handSeq: seq || 0,
    vol: 100,
    pc: null,
    tile: null,
    video: null,
    screenTile: null, // the second tile of this guest, built on the first screen track
    screenTrack: null,
    gain: null,
    audioSrc: null,
    audioEl: null,
    meter: null,     // tap on the incoming audio, for the talking light
    meterPeak: 0,    // decaying peak of that tap, so one stats tick sees a word
    inDenoise: null, // local noise cancel of this incoming stream
    inNoise: false,  // that noise cancel is asked for
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
    // The screen has a transceiver of its own, matched by its mid. Its track
    // goes to a second tile, so the camera keeps its tile and its sender. A
    // track that arrives before preparePeer runs is named by the second video
    // transceiver, which is the same object that preparePeer seals.
    const named = peer.tx && peer.tx.screen;
    const screen = named || peer.pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video')[1];
    if (screen && (event.transceiver === screen || (named && named.mid !== null && event.transceiver.mid === named.mid))) {
      peer.screenTrack = track;
      paintPeerScreen(peer);
      // A share that stops or starts again mutes and unmutes the same track.
      track.addEventListener('mute', () => paintPeerScreen(peer));
      track.addEventListener('unmute', () => paintPeerScreen(peer));
      track.addEventListener('ended', () => paintPeerScreen(peer));
      return;
    }
    // The track is kept, so undeafen can put the same picture back without a
    // new negotiation, and a deafened guest never draws it at all.
    peer.videoTrack = track;
    paintPeerVideo(peer);
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
  const row = peer.tile ? rowOf.get(peer.tile) : null;
  if (row) row.dataset.state = text;
  if ((text === 'failed' || text === 'closed') && peer.tile) peer.tile.classList.remove('playing');
  layoutStage();
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
      disableMic(false);
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
      // Only the reconnect notice ends here. A device or sealing notice that
      // the join itself wrote must stay up until the guest has read it.
      if (state.notice === 'connection lost, reconnecting') say('');
      setAdmins(msg.admins);
      state.waiting = !!msg.waiting;
      state.waitingRoom = !!msg.waitingRoom;
      asrProbe();
      omniProbe();
      for (const info of msg.peers || []) {
        if (!info) continue;
        const peer = ensurePeer(info.id, info.mic, info.cam, info.deaf, info.hand, info.handSeq);
        peer.waiting = !!info.waiting;
        // A guest who shares nothing on join has no tile to wait for.
        peer.screenShared = !!info.screen;
        sealedSendPub(peer);
      }
      markAdmins();
      paintWaiting();
      // Tell the room the microphone and camera state; only the flags travel.
      sendState();
      updateCount();
      break;
    }
    case 'peer-joined': {
      if (!msg.peer) break;
      const peer = ensurePeer(msg.peer.id, msg.peer.mic, msg.peer.cam, msg.peer.deaf, msg.peer.hand, msg.peer.handSeq);
      peer.waiting = !!msg.peer.waiting;
      peer.screenShared = !!msg.peer.screen;
      if (msg.peer.admin) state.admins.add(msg.peer.id);
      markAdmins();
      paintWaiting();
      paintHandQueue();
      sealedSendPub(peer);
      playSfx('pop');
      break;
    }
    case 'waiting-room': {
      state.waitingRoom = !!msg.waitingRoom;
      paintWaiting();
      break;
    }
    case 'admitted': {
      if (msg.peer && msg.peer.id) admitPeer(msg.peer.id);
      break;
    }
    case 'peer-left': {
      dropPeer(msg.from);
      state.admins.delete(msg.from);
      markAdmins();
      paintWaiting();
      playSfx('bonk');
      break;
    }
    case 'admin': {
      setAdmins(msg.admins);
      markAdmins();
      break;
    }
    case 'state': {
      if (msg.from === state.self) {
        // The echo of our own state carries the queue number of a hand that
        // has just gone up, and it keeps the button in step if two tabs of
        // one guest disagree.
        if (msg.hand !== undefined) {
          state.hand = !!msg.hand;
          state.handSeq = msg.handSeq || 0;
        }
        if (msg.mic !== undefined) state.mic = msg.mic;
        if (msg.cam !== undefined) state.cam = msg.cam;
        if (msg.deaf !== undefined) state.deaf = msg.deaf;
        const self = ownTile();
        if (self) applyFlags(self, state.mic, state.cam, isAdmin(state.self));
        updateButtons();
        paintHandQueue();
        break;
      }
      const peer = state.peers.get(msg.from);
      if (peer) {
        if (msg.mic !== undefined) peer.mic = msg.mic;
        if (msg.cam !== undefined) peer.cam = msg.cam;
        if (msg.deaf !== undefined) peer.deaf = msg.deaf;
        if (msg.screen !== undefined) {
          peer.screenShared = !!msg.screen;
          // A share that stops must leave the stage, not stand there frozen on
          // its last frame: the sender's track stays live and unmuted when it
          // only replaces it with nothing, so the flag is the only news.
          if (peer.screenShared) paintPeerScreen(peer);
          else dropPeerScreen(peer);
        }
        if (msg.hand !== undefined) {
          const was = peer.hand;
          peer.hand = !!msg.hand;
          peer.handSeq = msg.handSeq || 0;
          if (peer.hand !== was) {
            playSfx(peer.hand ? 'pop' : 'bonk');
            // A hand that goes up on a phone brings the frame back, or
            // nobody would see the queue on a screen that shows only the
            // picture.
            if (peer.hand) setChrome(true);
          }
        }
        applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
        if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
        paintRowDeaf(rowOf.get(peer.tile), peer.deaf);
        paintHandQueue();
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
    // The call opens on the picture alone, and the frame waits for a tap.
    $('stage').classList.remove('chrome');
    applyImmersive();
    $('room-label').textContent = room;
    $('room-label').title = room;
    $('chat-note').hidden = false;
    updatePinCount();
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
    if (state.screenTile) {
      state.screenTile.remove();
      state.screenTile = null;
    }
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
  state.canaries = new Set();
  state.samples = [];
  asrStop();
  omniStop();
  state.waiting = false;
  state.waitingRoom = false;
  state.hand = false;
  state.handSeq = 0;
  state.insideFps.clear();
  paintWaiting();
  paintHandQueue();
  updatePinCount();
  $('chat-note').hidden = true;
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
  localTile = null;
  $('stage-main').replaceChildren();
  $('self-pip').replaceChildren();
  $('self-pip').hidden = true;
  $('stage-rail').replaceChildren();
  $('stage-rail').hidden = false;
  stopCallClock();
  menuSet(false);
  $('stage').hidden = true;
  $('lobby').hidden = false;
  applyImmersive();
  $('room-label').textContent = '';
  $('peer-count').textContent = '';
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

// A posted address becomes a link, http and https only. It is a link and not a
// preview: nothing is fetched and no picture is loaded until a guest clicks it,
// because a link that phones home tells the other side who reads the room.
// The text shown is the address itself, the title says where a click goes
// (with punycode spelled out for a lookalike name), and the click opens a new
// tab that gets no referrer and no handle back to this page.
const LINK_RE = /https?:\/\/[^\s<>"']+/gi;

// splitLink cuts the trailing marks that belong to the sentence and not to the
// address: a full stop, a comma, a closing bracket without an opening one.
function splitLink(raw) {
  let url = raw;
  let tail = '';
  for (;;) {
    const last = url[url.length - 1];
    if (!last) break;
    let cut = '.,;:!?\'"'.includes(last);
    if (!cut && (last === ')' || last === ']' || last === '}')) {
      const open = { ')': '(', ']': '[', '}': '{' }[last];
      cut = url.split(last).length > url.split(open).length;
    }
    if (!cut) break;
    tail = last + tail;
    url = url.slice(0, -1);
  }
  return { url, tail };
}

// safeLink returns the parsed address when it may become a link, else null. A
// name with a user part (https://good.example@evil.example) is refused: the
// text would show one host and a click would go to another.
function safeLink(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return u;
}

// linkify returns the text as nodes: plain text, and an anchor for each address.
function linkify(text) {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const { url, tail } = splitLink(m[0]);
    const u = safeLink(url);
    if (!u) continue;
    if (m.index > at) out.appendChild(document.createTextNode(text.slice(at, m.index)));
    const a = document.createElement('a');
    a.textContent = url;
    a.href = u.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.referrerPolicy = 'no-referrer';
    a.title = `opens ${u.href}`;
    a.className = 'chat-link';
    out.appendChild(a);
    at = m.index + url.length;
  }
  if (at < text.length) out.appendChild(document.createTextNode(text.slice(at)));
  return out;
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
  li.appendChild(document.createTextNode(' '));
  li.appendChild(linkify(String(text)));
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
  if (!file || !state.self || state.leaving || state.waiting) return;
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
    if (!peer.keys || peer.waiting) continue;
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
  if (!state.sounds) return;
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
  // The wish stays, so a guest who switches the sound back on in the middle of
  // an outage hears the chime from then on.
  state.lostWanted = true;
  if (!state.sounds) return;
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

// setSounds is the switch for the four cues and the lost connection chime. Off
// cuts whatever plays now. The jitsi skin reads the same switch from the body.
function setSounds(on) {
  state.sounds = on;
  document.body.dataset.sounds = on ? 'on' : 'off';
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('sounds'));
  if (box) box.checked = on;
  if (!on) {
    if (state.sfxSource) {
      try { state.sfxSource.stop(); } catch { /* already finished */ }
      state.sfxSource = null;
    }
    // Cut the pad but keep the wish for it.
    const wanted = state.lostWanted;
    stopLost();
    state.lostWanted = wanted;
  } else if (state.lostWanted) {
    startLost();
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
      // The route can change in a call, so the tile mark follows what the
      // report says now and not only what it said when the link came up.
      if (s && s.path && peer.tile) peer.tile.dataset.relay = s.path.startsWith('relay') ? 'yes' : 'no';
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
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if ('toBase64' in view) return /** @type {any} */ (view).toBase64();
  let raw = '';
  for (let i = 0; i < view.length; i += 0x8000) raw += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
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
    pad: padRoundTripOk(),
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

// ------------------------------------------------------------- transcription

// Optional, off by default, two engines in this tab. Vosk holds one model per
// language and the guest picks the language. The multilingual engine holds one
// model for every language, so it has no picker and is offered only when the
// server lists its files. Nothing is loaded until the guest asks. For either
// engine the page downloads what it needs once (the size is shown first), keeps
// it in a browser cache, and runs the recognition for each incoming voice. The
// text goes out as sealed chat, labelled with the name of the guest who
// transcribes, and every other guest is told that someone transcribes before
// the first line. A refused or failed download leaves the call exactly as it
// was.
const ASR_MODELS = '/vosk/models';
const ASR_LIB = '/vosk/vosk.js';
const ASR_CACHE = 'stanze-vosk';
const ASR_LINE_MAX = 400;

// The multilingual engine is the sherpa-onnx OfflineRecognizer wasm build with
// one Omnilingual model for every language. Its five files, their sizes and
// their hashes come from /omni/models, which answers only when the operator
// set the directory; without it the engine is not offered at all.
const OMNI_MODELS = '/omni/models';
const OMNI_DIR = '/omni/';
const OMNI_CACHE = 'stanze-omni';
const OMNI_MODEL = 'model.int8.onnx';
const OMNI_TOKENS = 'tokens.txt';
const OMNI_API = 'sherpa-onnx-asr.js';
const OMNI_GLUE = 'sherpa-onnx-wasm-main-vad-asr.js';

const asr = {
  probed: false,
  models: [],      // [{ lang, file, size, modified }] as the server lists them
  lang: '',        // the label the guest picked, en by default
  engine: '',      // 'vosk' or 'omni', the kept choice, see asrEngine
  busy: false,     // a download or a start is under way
  on: false,
  abort: null,
  model: null,
  ctx: null,
  timer: 0,
  recs: new Map(), // peer id -> { rec, proc, src, sink }
  lib: null,
};

const omni = {
  probed: false,
  files: [],       // [{ name, size, modified, sha256 }] as the server lists them
  model: null,     // the one model entry, null when the engine is not offered
  size: 0,
  sha: '',
  stamp: '',       // size, time and hash of the model, used as the cache key
  busy: false,     // a download or a start is under way
  on: false,
  worker: null,
  url: '',         // the worker blob, kept while the engine runs
  timer: 0,
  recs: new Map(), // peer id -> { proc, src, sink }
};

// asrStats is what the engine last said about itself: the start, the tail of
// the phrases it decoded with the time each one took, and what the tap saw. A
// browser test reads it through window.e2eApp; the page itself never does.
const asrStats = { engine: '', ready: false, initMs: null, segments: [], blocks: 0, peak: 0, decoded: 0 };

const mb = (n) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;

function asrNote(text) {
  const el = document.getElementById('asr-note');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// asrPaintOthers tells a guest who else in the room transcribes, and what the
// chosen engine costs before it runs.
function asrPaintOthers() {
  if (asr.busy || asr.on || omni.busy || omni.on) return;
  const names = [...state.peers.values()].filter((p) => p.asr).map((p) => p.name || shortPeer(p.id));
  if (names.length) {
    asrNote(`${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} transcribing this meeting. The text appears in the chat.`);
    return;
  }
  if (asrEngine() === 'omni' && omni.size) {
    asrNote(`multilingual transcription: one model for every language, ${mb(omni.size)} on the first use.`);
    return;
  }
  asrNote('');
}

// asrProbe asks the server, once, which vosk models it offers. Without any
// model that engine stays out of the menu, and there is no second name to try:
// the list is the only offer.
async function asrProbe() {
  if (asr.probed) return;
  asr.probed = true;
  let list = [];
  try {
    const res = await fetch(ASR_MODELS, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      list = (body && Array.isArray(body.langs)) ? body.langs : [];
    }
  } catch { /* offline or blocked: not offered */ }
  asr.models = list.filter((m) => m && typeof m.file === 'string' && m.file);
  if (asr.models.length) asrPick(asrDefaultLang());
  asrOffers();
}

// omniProbe asks the server, once, whether the multilingual engine is on
// offer. The one model covers every language, so there is no picker here. A
// 404, a partial list or a blocked request simply leaves the engine out of the
// menu.
async function omniProbe() {
  if (omni.probed) return;
  omni.probed = true;
  let list = [];
  try {
    const res = await fetch(OMNI_MODELS, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      list = (body && Array.isArray(body.files)) ? body.files : [];
    }
  } catch { /* offline or blocked: not offered */ }
  omni.files = list.filter((f) => f && typeof f.name === 'string' && f.name);
  const find = (name) => omni.files.find((f) => f.name === name) || null;
  omni.model = find(OMNI_MODEL);
  const tokens = find(OMNI_TOKENS);
  const api = find(OMNI_API);
  const glue = find(OMNI_GLUE);
  if (!omni.model || !tokens || !api || !glue || !(omni.model.size > 0)) {
    omni.files = [];
    omni.model = null;
    asrOffers();
    return;
  }
  omni.size = omni.model.size;
  omni.sha = String(omni.model.sha256 || '');
  omni.stamp = `${omni.size}-${Number(omni.model.modified) || 0}-${omni.sha.slice(0, 8)}`;
  asrOffers();
}

// asrOffers reveals the transcribe entry once at least one engine is on offer
// and settles the engine choice on one the server still serves. The kept choice
// is not written here: only a guest's own pick is.
function asrOffers() {
  if (!asr.models.length && !omni.model) return;
  asrSetEngine(asrEngine(), false);
  const entry = document.getElementById('menu-asr-btn');
  if (entry) entry.hidden = false;
}

// asrEngine is the engine the guest picked, else the one this browser kept,
// and never an engine the server does not offer. Vosk wins the first visit
// when both are on offer, so an existing room behaves as it did.
function asrEngine() {
  const kept = asr.engine || load('asr.engine');
  if (kept === 'omni' && omni.model) return 'omni';
  if (kept === 'vosk' && asr.models.length) return 'vosk';
  if (asr.models.length) return 'vosk';
  if (omni.model) return 'omni';
  return '';
}

// asrSetEngine keeps the choice and paints the picker and the menu entry.
function asrSetEngine(name, keep) {
  const engine = (name === 'omni' && omni.model) ? 'omni'
    : (name === 'vosk' && asr.models.length) ? 'vosk' : asrEngine();
  if (keep !== false) {
    asr.engine = engine;
    store('asr.engine', engine);
  }
  if (engine === 'vosk' && asr.models.length) asrPick(asr.lang || asrDefaultLang());
  asrPaintLangRow();
  asrPaintEntry();
  asrPaintOthers();
}

// asrChoices is everything the one picker offers: each vosk language, then the
// multilingual model, which covers every language alone. Every entry carries
// the size of what it downloads, so the price of a pick is on the pick.
function asrChoices() {
  const list = asr.models.map((m) => ({
    value: `vosk:${m.lang}`,
    text: m.size ? `${m.lang} (${mb(m.size)})` : m.lang,
  }));
  if (omni.model) {
    list.push({
      value: 'omni',
      text: omni.size ? `omni, every language (${mb(omni.size)})` : 'omni, every language',
    });
  }
  return list;
}

// asrChoice is the picker value of the engine and language in force.
function asrChoice() {
  if (asrEngine() === 'omni') return 'omni';
  const model = asrModel();
  return model ? `vosk:${model.lang}` : '';
}

// asrChoose takes one value of the picker: a language of the vosk engine or
// the multilingual model.
function asrChoose(value) {
  if (value === 'omni') {
    asrSetEngine('omni');
    return;
  }
  if (value.startsWith('vosk:')) {
    asrSetEngine('vosk');
    asrPick(value.slice('vosk:'.length));
  }
}

// asrPaintLangRow fills the one picker from asrChoices and hides the row while
// there is no second thing to pick: one model that is the only offer needs no
// menu. The row and the select go together, so the picker is never drawn inside
// a row the page declares hidden.
function asrPaintLangRow() {
  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('asr-lang'));
  if (!select) return;
  const choices = asrChoices();
  const value = asrChoice();
  select.replaceChildren(...choices.map((choice) => {
    const o = document.createElement('option');
    o.value = choice.value;
    o.textContent = choice.text;
    o.selected = choice.value === value;
    return o;
  }));
  select.value = value;
  select.hidden = choices.length < 2;
  const row = select.closest('.menu-item');
  if (row) /** @type {HTMLElement} */ (row).hidden = choices.length < 2;
}

// asrPaintEntry puts the engine and its size on the menu entry, before the
// guest opens the menu.
function asrPaintEntry() {
  const btn = document.getElementById('menu-asr-btn');
  if (!btn) return;
  if (asrEngine() === 'omni') {
    btn.title = `transcription, every language, ${omni.size ? mb(omni.size) : 'one model'}`;
    return;
  }
  const model = asrModel();
  if (model) btn.title = `transcription, language ${model.lang}, ${mb(model.size)}`;
}

// asrDefaultLang is the kept choice, else the language of the browser, else the
// first model the server lists, which is en by the server's order.
function asrDefaultLang() {
  const have = asr.models.map((m) => m.lang);
  const kept = load('asr.lang');
  if (kept && have.includes(kept)) return kept;
  const want = String(navigator.language || '').toLowerCase().slice(0, 2);
  if (want && have.includes(want)) return want;
  return have[0];
}

// asrModel is the entry the guest picked, and never nothing once a model is on
// offer.
function asrModel() {
  return asr.models.find((m) => m.lang === asr.lang) || asr.models[0] || null;
}

// asrPick sets the label and paints the picker and the size of that model.
function asrPick(lang) {
  const model = asr.models.find((m) => m.lang === lang) || asr.models[0];
  if (!model) return;
  asr.lang = model.lang;
  store('asr.lang', model.lang);
  asrPaintLangRow();
  const btn = document.getElementById('menu-asr-btn');
  if (btn) asrPaintEntry();
}

// asrCacheKey is a request that is only ever used as a key. The file name is in
// the key, so a second language gets its own entry and the old one goes.
function asrCacheKey() {
  const model = asrModel();
  const file = model ? model.file : '';
  const stamp = model ? `${model.size}-${model.modified}` : '';
  return new Request(`${location.origin}/vosk/${file}?m=${encodeURIComponent(stamp)}`);
}

async function asrCached() {
  try {
    if (!window.caches) return null;
    const cache = await caches.open(ASR_CACHE);
    const hit = await cache.match(asrCacheKey());
    return hit ? await hit.blob() : null;
  } catch { return null; }
}

// asrFetchModel downloads the model with a progress line. It reads the body to
// the end, keeps it in the cache and returns the blob.
async function asrFetchModel(signal) {
  const model = asrModel();
  if (!model) throw new Error('no model is on offer');
  const res = await fetch(`/vosk/${model.file}`, { signal, cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
  const total = model.size || parseInt(res.headers.get('content-length') || '0', 10) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    asrNote(total
      ? `downloading the transcription model: ${mb(got)} of ${mb(total)} (${Math.floor((got * 100) / total)}%)`
      : `downloading the transcription model: ${mb(got)}`);
  }
  const blob = new Blob(parts, { type: 'application/gzip' });
  try {
    if (window.caches) {
      // Older entries go, so the cache holds one model only.
      await caches.delete(ASR_CACHE);
      const cache = await caches.open(ASR_CACHE);
      await cache.put(asrCacheKey(), new Response(blob, { headers: { 'content-type': 'application/gzip' } }));
    }
  } catch { /* no cache: the model is used now and fetched again next time */ }
  return blob;
}

function asrLoadLib() {
  if (asr.lib) return asr.lib;
  asr.lib = new Promise((resolve, reject) => {
    const have = /** @type {any} */ (window).Vosk;
    if (have) return resolve(have);
    const el = document.createElement('script');
    el.src = ASR_LIB;
    el.onload = () => {
      const lib = /** @type {any} */ (window).Vosk;
      return lib ? resolve(lib) : reject(new Error('the engine did not load'));
    };
    el.onerror = () => reject(new Error('the engine could not be loaded'));
    document.head.appendChild(el);
  }).catch((err) => {
    asr.lib = null;
    throw err;
  });
  return asr.lib;
}

// asrSay sends one sealed transcription message to everyone inside.
function asrSay(obj) {
  toSealed({ k: 'asr', ...obj });
}

// asrAnnounce tells a guest who joined later that we transcribe, whichever
// engine runs: the message is the same one for both.
function asrAnnounce(peer) {
  if ((!asr.on && !omni.on) || !peer.keys || peer.waiting) return;
  sealedSend(peer, { k: 'asr', s: 'on' });
}

// asrTap hooks one incoming voice to a recognizer of its own. It reads the
// source before the volume of that guest, so a guest turned down is still heard
// by the engine.
function asrTap(peer) {
  const ctx = state.playCtx;
  if (!asr.on || !asr.model || !ctx || !peer.audioSrc) return;
  const have = asr.recs.get(peer.id);
  if (have && have.src === peer.audioSrc) return;
  if (have) asrUntap(peer.id);
  const rec = new asr.model.KaldiRecognizer(ctx.sampleRate);
  const speaker = () => peer.name || shortPeer(peer.id);
  rec.on('result', (message) => {
    const text = String((message.result && message.result.text) || '').trim();
    if (!text || !asr.on) return;
    const line = text.slice(0, ASR_LINE_MAX);
    const who = speaker();
    addChatLine(`transcript by ${state.name || 'you'}`, `${who}: ${line}`, Date.now());
    asrSay({ w: who.slice(0, 64), x: line, ts: Date.now() });
  });
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (event) => {
    // A copy, because the engine takes the buffer to its worker.
    try { rec.acceptWaveformFloat(new Float32Array(event.inputBuffer.getChannelData(0)), ctx.sampleRate); } catch { /* recognizer gone */ }
  };
  // The processor only runs when it is wired to an output; the gain of zero
  // keeps it silent.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  peer.audioSrc.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  asr.recs.set(peer.id, { rec, proc, src: peer.audioSrc, sink });
}

function asrUntap(id) {
  const h = asr.recs.get(id);
  if (!h) return;
  asr.recs.delete(id);
  try { h.src.disconnect(h.proc); } catch { /* source already gone */ }
  try { h.proc.disconnect(); h.sink.disconnect(); } catch { /* already gone */ }
  h.proc.onaudioprocess = null;
  try { h.rec.retrieveFinalResult(); } catch { /* recognizer gone */ }
  setTimeout(() => { try { h.rec.remove(); } catch { /* recognizer gone */ } }, 1500);
}

// asrSync follows the room: a recognizer for each guest inside who has a voice,
// none for a guest who waits, and none for a guest who left.
function asrSync() {
  if (!asr.on) return;
  for (const id of [...asr.recs.keys()]) {
    const peer = state.peers.get(id);
    if (!peer || peer.waiting) asrUntap(id);
  }
  for (const peer of state.peers.values()) {
    if (!peer.waiting) asrTap(peer);
  }
}

function asrStop() {
  if (asr.abort) asr.abort.abort();
  asr.abort = null;
  const was = asr.on;
  asr.on = false;
  clearInterval(asr.timer);
  asr.timer = 0;
  for (const id of [...asr.recs.keys()]) asrUntap(id);
  if (asr.model) {
    const model = asr.model;
    // After the recognizers are gone, the worker and its memory go too.
    setTimeout(() => { try { model.terminate(); } catch { /* already gone */ } }, 2000);
    asr.model = null;
  }
  asr.busy = false;
  if (was) asrSay({ s: 'off' });
  paintAsr();
  asrNote('');
  asrPaintOthers();
}

async function asrStart() {
  asr.busy = true;
  asr.abort = new AbortController();
  const signal = asr.abort.signal;
  paintAsr();
  try {
    let blob = await asrCached();
    if (!blob) {
      const model = asrModel();
      const size = model && model.size ? mb(model.size) : 'a large file';
      // The guest asked for transcription; this is the size, before any byte.
      if (!window.confirm(`Transcription runs in this tab and needs a one-time download of ${size}. The model is kept in the browser cache. Download it now?`)) {
        asrStop();
        return;
      }
      blob = await asrFetchModel(signal);
    }
    if (signal.aborted) return;
    asrNote('starting the transcription engine');
    const Vosk = await asrLoadLib();
    const url = URL.createObjectURL(blob);
    try {
      asr.model = await Vosk.createModel(url);
    } finally {
      // The worker has fetched the blob once the model is ready.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if (signal.aborted) {
      asr.model.terminate();
      asr.model = null;
      return;
    }
    asr.on = true;
    asr.busy = false;
    asr.abort = null;
    paintAsr();
    asrNote('You transcribe this meeting. The text goes to the chat under your name, and your own voice is not transcribed.');
    asrSay({ s: 'on' });
    asrSync();
    asr.timer = setInterval(asrSync, 2000);
  } catch (err) {
    if (signal.aborted) return;
    asrStop();
    asrNote(`Transcription could not start: ${err && err.message ? err.message : 'the download failed'}. The call is not affected.`);
  }
}

// paintAsr puts the state of the chosen engine on the tick row of the menu: a
// tick while it runs, and the same tick while its model is on the way, so the
// row stays a way to cancel a download that has started. A start in progress
// therefore does not lock the row.
function paintAsr() {
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('asr-on'));
  if (!box) return;
  const engine = asrEngine();
  const busy = engine === 'omni' ? omni.busy : asr.busy;
  box.checked = busy || (engine === 'omni' ? omni.on : asr.on);
  box.disabled = false;
}

function initAsr() {
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('asr-on'));
  if (!box) return;
  box.addEventListener('change', () => {
    if (!box.checked) {
      asrStop();
      omniStop();
    } else if (asrEngine() === 'omni') {
      omniStart();
    } else {
      asrStart();
    }
  });
  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('asr-lang'));
  if (select) {
    select.addEventListener('change', () => {
      // One engine runs at a time and a pick may be a 348 MB download, so a
      // change stops what runs and restarts only the engine that was running:
      // the new pick is started by the guest's own tick otherwise.
      const was = asr.on || omni.on;
      asrStop();
      omniStop();
      asrChoose(select.value);
      paintAsr();
      if (!was) return;
      if (asrEngine() === 'omni') omniStart();
      else asrStart();
    });
  }
}

// asrOnMessage handles a sealed transcription message from a guest.
function asrOnMessage(peer, obj) {
  const name = peer.name || shortPeer(peer.id);
  if (obj.s === 'on' || obj.s === 'off') {
    peer.asr = obj.s === 'on';
    if (peer.asr) addChatLine('stanze', `${name} started transcribing this meeting`, Date.now());
    asrPaintOthers();
    return;
  }
  const text = String(obj.x || '').slice(0, ASR_LINE_MAX);
  const who = String(obj.w || '').slice(0, 64);
  if (!text) return;
  // The label is the guest who sent it, as this tab knows that guest, and never
  // a name taken from the message.
  state.chatRecv++;
  addChatLine(`transcript by ${name}`, `${who}: ${text}`, Date.now());
}

// ------------------------------------------------- multilingual transcription

// The multilingual engine runs in one worker of its own. Its model is 348 MB,
// so the page keeps it in the browser cache in parts, checks it against the
// hash the server lists, and mounts it into the wasm filesystem. A stop
// terminates the worker, which drops the model, the threads and any download
// at once, and leaves the call untouched.
async function omniStart() {
  if (omni.busy || omni.on || !omni.model) return;
  if (!window.crossOriginIsolated) {
    asrNote('The multilingual engine needs a cross-origin isolated page. The call is not affected.');
    paintAsr();
    return;
  }
  const size = omni.size ? mb(omni.size) : 'a large file';
  // The model is best effort in the browser cache, so ask for a durable store
  // and say when the space is not there, before the download and not after it.
  let tight = false;
  try {
    if (navigator.storage && navigator.storage.persist) {
      Promise.resolve(navigator.storage.persist()).catch(() => {});
    }
    const est = navigator.storage && navigator.storage.estimate
      ? await navigator.storage.estimate() : null;
    tight = !!(est && est.quota && est.quota - est.usage < omni.size);
  } catch { /* no estimate */ }
  const keep = tight
    ? 'The browser has less free storage than that, so the model cannot be kept and the next visit downloads it again.'
    : 'The model is kept in the browser cache, so this is the only download.';
  // The guest asked for transcription; this is the size, before any byte.
  if (!window.confirm(`Multilingual transcription runs in this tab and needs a one-time download of ${size}. ${keep} Download it now?`)) {
    paintAsr();
    return;
  }
  omni.busy = true;
  paintAsr();
  asrNote(`starting the multilingual engine: one model for every language, ${size}`);
  try {
    omni.worker = omniSpawn();
  } catch (err) {
    omniFail(`the engine could not start: ${err && err.message ? err.message : 'the worker was refused'}`);
  }
}

// omniSpawn starts the engine worker. The script is built here, so the client
// stays one file, and its blob lives as long as the engine: the wasm build
// starts its own threads from the same url.
function omniSpawn() {
  const cfg = {
    base: location.origin + OMNI_DIR,
    api: location.origin + OMNI_DIR + OMNI_API,
    glue: location.origin + OMNI_DIR + OMNI_GLUE,
    modelUrl: location.origin + OMNI_DIR + OMNI_MODEL,
    tokensUrl: location.origin + OMNI_DIR + OMNI_TOKENS,
    modelName: OMNI_MODEL,
    tokensName: OMNI_TOKENS,
    cache: OMNI_CACHE,
    size: omni.size,
    sha: omni.sha,
    stamp: omni.stamp,
  };
  const url = URL.createObjectURL(new Blob([omniWorkerSource(cfg)], { type: 'text/javascript' }));
  const worker = new Worker(url);
  omni.url = url;
  worker.onmessage = (event) => omniOnWorker(event.data || {});
  worker.onerror = (event) => omniFail(event.message || 'the engine stopped');
  return worker;
}

// omniOnWorker is every word the engine says: its progress, its ready, one line
// of text for each phrase, and its faults.
function omniOnWorker(msg) {
  if (!omni.busy && !omni.on) return;
  switch (msg.ev) {
    case 'status':
      if (omni.busy) asrNote(String(msg.text || 'starting the multilingual engine'));
      return;
    case 'progress':
      omniProgress(msg);
      return;
    case 'ready':
      if (!omni.busy) return;
      omni.busy = false;
      omni.on = true;
      asrStats.engine = 'omni';
      asrStats.ready = true;
      asrStats.initMs = Number(msg.ms) || null;
      paintAsr();
      asrNote('You transcribe this meeting. The text goes to the chat under your name, and your own voice is not transcribed.');
      asrSay({ s: 'on' });
      omniSync();
      omni.timer = setInterval(omniSync, 2000);
      return;
    case 'decoded':
      asrStats.decoded++;
      return;
    case 'line': {
      const ms = Number(msg.ms);
      const sec = Number(msg.sec);
      if (Number.isFinite(ms) && ms > 0 && sec > 0) {
        asrStats.segments.push({ ms, audioSec: sec });
        if (asrStats.segments.length > 8) asrStats.segments.shift();
      }
      omniLine(String(msg.id || ''), String(msg.text || ''));
      return;
    }
    case 'error':
      omniFail(String(msg.text || 'the engine stopped'));
      return;
    default:
      return;
  }
}

function omniProgress(msg) {
  if (!omni.busy) return;
  const total = Number(msg.total) || omni.size;
  const got = Number(msg.got) || 0;
  const where = msg.cached
    ? 'reading the transcription model from the browser cache'
    : 'downloading the transcription model';
  asrNote(total
    ? `${where}: ${mb(got)} of ${mb(total)} (${Math.floor((got * 100) / total)}%)`
    : `${where}: ${mb(got)}`);
}

// omniFail fails the engine and nothing else: the note says so and the call
// keeps working.
function omniFail(text) {
  const was = omni.on;
  omniStop();
  asrNote(was
    ? `Transcription stopped: ${text}. The call is not affected.`
    : `Transcription could not start: ${text}. The call is not affected.`);
}

function omniStop() {
  const was = omni.on;
  omni.on = false;
  omni.busy = false;
  asrStats.engine = '';
  asrStats.ready = false;
  clearInterval(omni.timer);
  omni.timer = 0;
  for (const id of [...omni.recs.keys()]) omniUntap(id);
  if (omni.worker) {
    try { omni.worker.terminate(); } catch { /* already gone */ }
    omni.worker = null;
  }
  if (omni.url) {
    try { URL.revokeObjectURL(omni.url); } catch { /* already gone */ }
    omni.url = '';
  }
  if (was) asrSay({ s: 'off' });
  paintAsr();
  asrNote('');
  asrPaintOthers();
}

// omniTap hooks one incoming voice to the engine worker. It reads the source
// before the volume of that guest, like the vosk tap, so a guest turned down is
// still heard by the engine.
function omniTap(peer) {
  const ctx = state.playCtx;
  if (!omni.on || !omni.worker || !ctx || !peer.audioSrc) return;
  const have = omni.recs.get(peer.id);
  if (have && have.src === peer.audioSrc) return;
  if (have) omniUntap(peer.id);
  const id = peer.id;
  const worker = omni.worker;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (event) => {
    if (!omni.on || omni.worker !== worker) return;
    const block = event.inputBuffer.getChannelData(0);
    // What the tap saw, so a test can tell a silent source from a deaf engine.
    asrStats.blocks++;
    let top = 0;
    for (let i = 0; i < block.length; i++) {
      const v = block[i] < 0 ? -block[i] : block[i];
      if (v > top) top = v;
    }
    if (top > asrStats.peak) asrStats.peak = top;
    const samples = omniDown(block, ctx.sampleRate);
    if (!samples.length) return;
    try { worker.postMessage({ cmd: 'audio', id, samples }, [samples.buffer]); } catch { /* engine gone */ }
  };
  // The processor only runs when it is wired to an output; the gain of zero
  // keeps it silent.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  peer.audioSrc.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  omni.recs.set(id, { proc, src: peer.audioSrc, sink });
}

function omniUntap(id) {
  const h = omni.recs.get(id);
  if (!h) return;
  omni.recs.delete(id);
  try { h.src.disconnect(h.proc); } catch { /* source already gone */ }
  try { h.proc.disconnect(); h.sink.disconnect(); } catch { /* already gone */ }
  h.proc.onaudioprocess = null;
}

// omniSync follows the room like the vosk one: a tap for each guest inside who
// has a voice, none for a guest who waits, and none for a guest who left.
function omniSync() {
  if (!omni.on) return;
  for (const id of [...omni.recs.keys()]) {
    const peer = state.peers.get(id);
    if (!peer || peer.waiting) omniUntap(id);
  }
  for (const peer of state.peers.values()) {
    if (!peer.waiting) omniTap(peer);
  }
}

// omniDown mixes one block to mono at 16 kHz with a box filter. The engine
// takes 16 kHz and a speech model needs nothing finer.
function omniDown(input, rate) {
  if (rate === 16000) return new Float32Array(input);
  const ratio = rate / 16000;
  const n = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    out[i] = to > from ? sum / (to - from) : 0;
  }
  return out;
}

// omniLine puts one decoded phrase on the chat and sends it to the others, in
// the same shape the vosk engine uses.
function omniLine(id, text) {
  if (!omni.on) return;
  const line = text.slice(0, ASR_LINE_MAX);
  if (!line) return;
  const peer = state.peers.get(id);
  const who = peer ? (peer.name || shortPeer(id)) : shortPeer(id);
  addChatLine(`transcript by ${state.name || 'you'}`, `${who}: ${line}`, Date.now());
  asrSay({ w: who.slice(0, 64), x: line, ts: Date.now() });
}

// omniWorkerSource turns the function below into the worker script. The blob
// needs no extra file and no build step.
function omniWorkerSource(cfg) {
  return `(${omniWorker.toString()})(${JSON.stringify(cfg)});`;
}

// omniWorker is the engine in its own thread: a model load takes seconds and
// one phrase most of a second, and the call must keep its picture and its sound
// meanwhile. The wasm build is the sherpa-onnx OfflineRecognizer with the
// Omnilingual model. No voice activity model is served, so the phrase gate here
// is a plain level gate: four quiet frames end a phrase, the quiet tail is cut
// and three frames before the first loud one are kept, so the first word is not
// lost.
function omniWorker(cfg) {
  const G = /** @type {any} */ (self);
  G.Module = {
    // The wasm and its worker threads live under /omni/. The base is absolute,
    // because a blob worker has no useful directory of its own.
    locateFile: (path) => cfg.base + path,
    print: (text) => { if (text) console.log('[omni] ' + text); },
    printErr: (text) => { if (text) console.warn('[omni] ' + text); },
    onAbort: (why) => G.postMessage({ ev: 'error', text: String(why || 'the engine stopped') }),
  };
  // The API layer first, then the emscripten glue that starts the wasm.
  G.importScripts(cfg.api, cfg.glue);
  // One of the wasm build's own threads runs this same script again. The glue
  // then owns the port, so nothing below may run there.
  if (/^em-pthread/.test(G.name || '')) return;

  const RATE = 16000;
  const FRAME = 1600;        // 100 ms, the step of the level gate
  const THRESHOLD = 0.012;   // root mean square that counts as speech
  const TAIL = 4;            // quiet frames that end a phrase
  const PRE = 3;             // frames kept before the first loud one
  const MAXLEN = RATE * 30;  // a longer phrase is cut and decoded
  const PART = 32 * 1048576; // one browser cache entry per 32 MB

  const post = (msg, transfer) => G.postMessage(msg, transfer || []);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const segs = new Map();    // peer id -> gate and phrase state
  const queue = [];          // phrases waiting for the recognizer
  let rec = null;
  let decoding = false;
  let lastProgress = 0;

  function short(err) {
    const text = String((err && err.message) || err || 'the engine stopped');
    return text.slice(0, 200);
  }

  function hex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      const end = Math.min(i + 4096, bytes.length);
      for (let j = i; j < end; j++) out += bytes[j].toString(16).padStart(2, '0');
    }
    return out;
  }

  async function hash(bytes) {
    if (!G.crypto || !G.crypto.subtle) return '';
    const sum = await G.crypto.subtle.digest('SHA-256', bytes);
    return hex(new Uint8Array(sum));
  }

  function partKey(index) {
    return `${cfg.base}${cfg.modelName}?part=${index}&m=${encodeURIComponent(cfg.stamp)}`;
  }

  // fromCache reads the model out of the browser cache in parts. A part that is
  // missing or short means no hit at all. The hash is checked before the wasm
  // reads a byte, so a cut or stale entry goes instead of breaking the engine.
  async function fromCache() {
    if (!G.caches || !cfg.size) return null;
    const count = Math.ceil(cfg.size / PART);
    let cache = null;
    let first = null;
    try {
      cache = await G.caches.open(cfg.cache);
      first = await cache.match(partKey(0));
    } catch { return null; }
    if (!first) return null;
    post({ ev: 'progress', got: 0, total: cfg.size, cached: true });
    const bytes = new Uint8Array(cfg.size);
    try {
      for (let i = 0; i < count; i++) {
        const hit = i === 0 ? first : await cache.match(partKey(i));
        if (!hit) return null;
        const body = new Uint8Array(await hit.arrayBuffer());
        const at = i * PART;
        if (body.length !== Math.min(PART, cfg.size - at)) return null;
        bytes.set(body, at);
      }
    } catch { return null; }
    if (cfg.sha) {
      const sum = await hash(bytes);
      if (sum && sum !== cfg.sha) {
        try { await G.caches.delete(cfg.cache); } catch { /* not ours */ }
        return null;
      }
    }
    post({ ev: 'progress', got: cfg.size, total: cfg.size, cached: true });
    return bytes;
  }

  // fromNetwork downloads the model once and writes every finished part to the
  // cache. The cache is best effort: a tab without cache storage still
  // transcribes now, it just pays the download again next time.
  async function fromNetwork() {
    const res = await fetch(cfg.modelUrl, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
    const bytes = new Uint8Array(cfg.size);
    let cache = null;
    try { if (G.caches) cache = await G.caches.open(cfg.cache); } catch { cache = null; }
    const reader = res.body.getReader();
    let got = 0;
    let part = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > cfg.size) throw new Error('the server sent more than the model size');
      bytes.set(value, got);
      got += value.length;
      if (got - lastProgress >= 2097152) {
        lastProgress = got;
        post({ ev: 'progress', got, total: cfg.size, cached: false });
      }
      // Finished parts go at once, so a stopped tab keeps what it paid for.
      while (cache && got - part * PART >= PART) {
        const at = part * PART;
        try { await cache.put(partKey(part), new Response(bytes.subarray(at, at + PART))); } catch { cache = null; }
        part++;
      }
    }
    if (got !== cfg.size) {
      throw new Error(`the download stopped at ${Math.round(got / 1048576)} of ${Math.round(cfg.size / 1048576)} MB`);
    }
    if (cache && part * PART < cfg.size) {
      const at = part * PART;
      try { await cache.put(partKey(part), new Response(bytes.subarray(at, cfg.size))); } catch { /* no cache */ }
    }
    post({ ev: 'progress', got: cfg.size, total: cfg.size, cached: false });
    if (cfg.sha) {
      const sum = await hash(bytes);
      if (sum && sum !== cfg.sha) {
        try { await G.caches.delete(cfg.cache); } catch { /* not ours */ }
        throw new Error('the model did not match its hash');
      }
    }
    return bytes;
  }

  function mount(name, bytes) {
    try { G.Module.FS_unlink('/' + name); } catch { /* not mounted before */ }
    G.Module.FS_createDataFile('/', name, bytes, true, true, true);
  }

  async function waitRuntime() {
    const t0 = performance.now();
    while (!G.Module.calledRun) {
      if (performance.now() - t0 > 180000) throw new Error('the engine never started');
      await sleep(50);
    }
  }

  async function start() {
    const t0 = performance.now();
    post({ ev: 'status', text: 'starting the engine' });
    await waitRuntime();
    post({ ev: 'status', text: 'loading the model' });
    let bytes = await fromCache();
    if (!bytes) {
      post({ ev: 'status', text: 'downloading the model' });
      bytes = await fromNetwork();
    }
    const res = await fetch(cfg.tokensUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`the token table answered ${res.status}`);
    const tokens = new Uint8Array(await res.arrayBuffer());
    mount(cfg.modelName, bytes);
    mount(cfg.tokensName, tokens);
    post({ ev: 'status', text: 'starting the recognizer' });
    const config = {
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        omnilingual: { model: './' + cfg.modelName },
        tokens: './' + cfg.tokensName,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        modelType: '',
      },
      decodingMethod: 'greedy_search',
    };
    // The API layer declares this class in the worker's global scope.
    // @ts-ignore
    rec = new OfflineRecognizer(config, G.Module);
    if (!rec || !rec.handle) throw new Error('the recognizer did not start');
    post({ ev: 'ready', ms: Math.round(performance.now() - t0) });
    pump();
  }

  function rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  function begin() {
    return { rest: new Float32Array(0), pre: [], samples: [], len: 0, speech: false, quiet: 0 };
  }

  // flush hands one finished phrase to the queue. A phrase shorter than half a
  // second carries no word, only a door or a chair.
  function flush(id, st) {
    const parts = st.samples;
    const len = st.len;
    st.samples = [];
    st.len = 0;
    st.speech = false;
    st.quiet = 0;
    if (len < RATE / 2) return;
    const all = new Float32Array(len);
    let at = 0;
    for (const part of parts) { all.set(part, at); at += part.length; }
    // The queue is short on purpose: a slow tab drops the oldest phrase rather
    // than grow without end.
    queue.push({ id, samples: all });
    if (queue.length > 8) queue.shift();
    setTimeout(pump, 0);
  }

  function frame(id, st, f) {
    const loud = rms(f) >= THRESHOLD;
    if (!st.speech) {
      if (!loud) {
        st.pre.push(new Float32Array(f));
        if (st.pre.length > PRE) st.pre.shift();
        return;
      }
      st.speech = true;
      st.quiet = 0;
      st.samples = st.pre.concat([new Float32Array(f)]);
      st.len = st.samples.reduce((n, part) => n + part.length, 0);
      st.pre = [];
      return;
    }
    st.samples.push(new Float32Array(f));
    st.len += f.length;
    st.quiet = loud ? 0 : st.quiet + 1;
    if (st.quiet >= TAIL || st.len >= MAXLEN) {
      // The quiet tail goes, it carries no word.
      while (st.quiet > 0 && st.samples.length > 1) {
        st.len -= st.samples.pop().length;
        st.quiet--;
      }
      flush(id, st);
    }
  }

  function pushAudio(id, samples) {
    let st = segs.get(id);
    if (!st) {
      st = begin();
      segs.set(id, st);
    }
    const all = new Float32Array(st.rest.length + samples.length);
    all.set(st.rest);
    all.set(samples, st.rest.length);
    let at = 0;
    for (; all.length - at >= FRAME; at += FRAME) frame(id, st, all.subarray(at, at + FRAME));
    st.rest = all.subarray(at);
  }

  function pump() {
    if (decoding || !rec || queue.length === 0) return;
    const job = queue.shift();
    decoding = true;
    const t0 = performance.now();
    let text = '';
    try {
      const stream = rec.createStream();
      stream.acceptWaveform(RATE, job.samples);
      rec.decode(stream);
      const result = rec.getResult(stream);
      text = String((result && result.text) || '').trim();
      stream.free();
    } catch (err) {
      decoding = false;
      post({ ev: 'error', text: short(err) });
      return;
    }
    decoding = false;
    // Every phrase decoded goes to the page, empty or not, so its counters show
    // a deaf engine apart from a silent room.
    post({ ev: 'decoded', ms: Math.round(performance.now() - t0), sec: job.samples.length / RATE, len: text.length });
    if (text) post({ ev: 'line', id: job.id, text, ms: Math.round(performance.now() - t0), sec: job.samples.length / RATE });
    // One phrase per turn of the event loop, so queued audio is read first.
    setTimeout(pump, 0);
  }

  G.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.cmd === 'audio' && rec && msg.samples) pushAudio(String(msg.id || ''), msg.samples);
  };

  start().catch((err) => post({ ev: 'error', text: short(err) }));
}

// ------------------------------------------------------------- lobby window

// The lobby is a desktop window: the guest drags it by the title bar with a
// mouse, a pen or a finger, it never leaves the viewport, and the place is
// kept for the guest. The arrow keys move it too, for a guest without a
// pointer. The call stage is maximised and has no drag.
const LOBBY_STEP = 16;

// lobbyPlace puts the window at x, y inside the viewport and returns the place.
function lobbyPlace(win, x, y) {
  const w = win.offsetWidth;
  const h = win.offsetHeight;
  const maxX = Math.max(0, document.documentElement.clientWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  const cx = Math.min(Math.max(0, Math.round(x)), maxX);
  const cy = Math.min(Math.max(0, Math.round(y)), maxY);
  win.classList.add('moved');
  win.style.left = `${cx}px`;
  win.style.top = `${cy}px`;
  return { x: cx, y: cy };
}

function initLobbyWindow() {
  const win = document.getElementById('lobby');
  const bar = /** @type {HTMLElement | null} */ (win && win.querySelector('.titlebar'));
  // The jitsi skin has no title bar and so no drag.
  if (!win || !bar || getComputedStyle(bar).display === 'none') return;

  const keep = (pos) => store('lobbypos', JSON.stringify(pos));
  const at = () => {
    const r = win.getBoundingClientRect();
    return { x: r.left, y: r.top };
  };

  // The kept place, if a valid one is stored. Anything else is ignored.
  try {
    const kept = JSON.parse(load('lobbypos') || 'null');
    if (kept && Number.isFinite(kept.x) && Number.isFinite(kept.y)) lobbyPlace(win, kept.x, kept.y);
  } catch { /* no kept place */ }

  let grab = null;
  bar.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const here = at();
    grab = { id: event.pointerId, dx: event.clientX - here.x, dy: event.clientY - here.y };
    // The window is fixed from the first grab, at the place it has now.
    lobbyPlace(win, here.x, here.y);
    win.classList.add('dragging');
    bar.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  bar.addEventListener('pointermove', (/** @type {PointerEvent} */ event) => {
    if (!grab || event.pointerId !== grab.id) return;
    lobbyPlace(win, event.clientX - grab.dx, event.clientY - grab.dy);
  });
  const drop = (/** @type {PointerEvent} */ event) => {
    if (!grab || event.pointerId !== grab.id) return;
    grab = null;
    win.classList.remove('dragging');
    keep(at());
  };
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);

  bar.tabIndex = 0;
  bar.setAttribute('aria-label', 'stanze window, move it with the arrow keys');
  bar.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!d) return;
    event.preventDefault();
    const here = at();
    keep(lobbyPlace(win, here.x + d[0] * LOBBY_STEP, here.y + d[1] * LOBBY_STEP));
  });

  // A smaller viewport pulls the window back in.
  window.addEventListener('resize', () => {
    if (!win.classList.contains('moved') || win.hidden) return;
    const here = at();
    lobbyPlace(win, here.x, here.y);
  });
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

// updatePinCount is the room summary in the middle of the title bar: how many
// guests this browser can name by identity, out of the guests present. The bar
// is green when every guest is verified and red when one is not; a pair whose
// keys do not match keeps it red and the title names that pair.
function updatePinCount() {
  const el = $('pin-count');
  if (!el) return;
  const total = state.peers.size;
  const known = verifiedPeers();
  const failed = sealedFailedPairs();
  const full = total > 0 && known === total && failed.length === 0;
  el.hidden = total === 0;
  el.textContent = total ? `verified ${known}/${total}` : '';
  el.dataset.verified = full ? 'all' : 'part';
  // The bar is never the plain blue one: green only when every guest present is
  // verified, red otherwise, and red while the room is empty because nothing is
  // verified yet.
  $('stage').dataset.verified = full ? 'all' : 'part';
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
  for (const host of [peer.tile, rowOf.get(peer.tile)]) refreshCodeCard(host, peer);
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
  if (s.length >= 4) state.canaries.add(s);
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
  waitingReturn(peer);
  asrAnnounce(peer);
}

// waitingReturn keeps the waiting room from locking out a member whose link
// dropped. A guest that was inside this call under a proven key is remembered
// here. When the same key comes back and waits, the admin's client lets it in
// by itself. Only a key proof counts, never a name, so nobody can pose as a
// member to skip the room. A guest the admin removed is forgotten, and so is
// not let back in. The list lives in this tab and ends with the call.
function waitingReturn(peer) {
  if (!peer.fp) return;
  if (!peer.waiting) {
    state.insideFps.add(peer.fp);
    return;
  }
  if (state.waiting || !isAdmin(state.self)) return;
  if (state.insideFps.has(peer.fp)) send({ t: 'admit', to: peer.id });
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
  if (obj.z !== undefined) delete obj.z; // the padding bucket, never content
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
  } else if (obj.k === 'file') {
    fileOnMessage(peer, obj);
  }
}

function sealedAnnounceName(peer) {
  if (!peer.keys || !state.name || peer.announcedName === state.name) return;
  peer.announcedName = state.name;
  sealedSend(peer, { k: 'name', n: state.name });
}

// A sealed payload is padded to a fixed bucket before it is sealed, so the
// length of the ciphertext stops saying what was sent: a two word chat line, a
// name and a file offer all leave as the same size. The true length travels
// inside as the filler field, and the receiver drops it. Buckets are powers of
// two and the biggest repeats, so a large payload still lands on a round size.
const PAD_BUCKETS = [512, 2048, 8192];
const PAD_LAST = PAD_BUCKETS[PAD_BUCKETS.length - 1];

function padPayload(obj) {
  const withPad = /** @type {any} */ (Object.assign({}, obj, { z: '' }));
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
function padRoundTripOk() {
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

function sealedSend(peer, obj) {
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
function toSealed(obj) {
  for (const peer of state.peers.values()) {
    if (!peer.keys || peer.waiting) continue;
    sealedSend(peer, obj);
  }
}

function sendSealedChat() {
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
function sealedSetName(peer, raw) {
  const name = cleanSealedName(raw);
  if (!name || peer.name === name) return;
  peer.name = name;
  if (peer.tile) paintName(peer.tile, name, false);
  if (peer.screenTile) paintName(peer.screenTile, `${name}, screen`, false);
}

// sealedSetE2E paints the key state and the short code on one tile.
function sealedSetE2E(peer, status) {
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
function refreshCodeCard(host, peer) {
  const menu = hostMenu(host);
  if (!menu || menu.hidden) return;
  if (menu.classList.contains('row-menu') && menu.dataset.peer !== (host.dataset.peer || '')) return;
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
    wt.idSign && wt.idUnsigned && wt.idFp && wt.pad);
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
    ['padding ', wt.pad ? 'ok' : 'BROKEN', !!wt.pad],
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
  get asrStats() {
    return {
      engine: asrStats.engine,
      ready: asrStats.ready,
      initMs: asrStats.initMs,
      segments: asrStats.segments.slice(),
    };
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
  // The drawn camera is reported by the track each camera sender carries, so a
  // test can see the swap a hidden tab makes without reading a picture.
  effects: () => ({
    look: state.look,
    masks: state.masks.slice(),
    mask: state.masks.join('+') || 'none',
    on: lookOn(),
    drawn: !!lookTrack(),
    parked: !!state.lookParked,
    loop: !!(state.lookPipe && state.lookPipe.clock),
    swaps: state.lookSwaps,
    cam: state.camTrack ? state.camTrack.readyState : 'none',
    senders: [...state.peers.values()].map((peer) => {
      const tr = peer.tx && peer.tx.video;
      const track = tr && tr.sender ? tr.sender.track : null;
      if (!track) return 'none';
      if (track === state.camTrack) return 'camera';
      if (track === state.lookOut) return 'drawn';
      return 'other';
    }),
  }),
  setLook: (name) => {
    state.look = Object.prototype.hasOwnProperty.call(LOOKS, name) ? name : 'none';
    store('look', state.look);
    const pick = $('look-filter');
    if (pick) pick.value = state.look;
    return lookRestart();
  },
  setLookGrace: (ms) => {
    state.lookGraceMs = Math.max(0, Number(ms) || 0);
    state.lookGrace = 0;
    if (!lookOn()) return lookRestart();
  },
  setMask: (names) => {
    state.masks = maskSet(names);
    store('mask', state.masks.join('+'));
    for (const box of maskBoxes()) box.checked = state.masks.includes(box.dataset.mask);
    return lookRestart();
  },
};

// ---------------------------------------------------------------- relay badge

// selectedPair is the candidate pair that carries the media. The standard way
// to find it is the transport report; the `selected` flag on the pair is a
// Firefox extra, so a lookup that relied on it never marked a Chrome guest.
function selectedPair(stats) {
  let pair = null;
  stats.forEach((r) => {
    if (!pair && r.type === 'transport' && r.selectedCandidatePairId) {
      pair = stats.get(r.selectedCandidatePairId) || null;
    }
  });
  if (pair) return pair;
  stats.forEach((r) => {
    if (!pair && r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
  });
  return pair;
}

// paintRelay marks a tile when the link to that peer runs through the TURN
// relay. The selected pair is read once, when the link comes up; a reconnect
// runs this again.
async function paintRelay(peer) {
  try {
    const stats = await peer.pc.getStats();
    const pair = selectedPair(stats);
    const local = pair ? stats.get(pair.localCandidateId) : null;
    const remote = pair ? stats.get(pair.remoteCandidateId) : null;
    const relayed = !!((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay'));
    if (peer.tile) peer.tile.dataset.relay = relayed ? 'yes' : 'no';
  } catch {
    /* stats are best effort */
  }
}

// ---------------------------------------------------------------- phone frame

// A phone shows the call as a picture. The class folds the frame of the app
// away in the stylesheet, and a tap on the picture brings it back over it. The
// query is the one the stylesheet uses, so a desktop never gets the class and
// keeps its frame in place.
const phoneQuery = window.matchMedia ? window.matchMedia('(max-width: 620px), (max-height: 520px) and (hover: none)') : null;

// applyImmersive turns the folded call view on or off for the window that is
// here now, and every window that comes after a rotation. It only ever folds a
// stage that is on screen, so the lobby stays a whole card.
function applyImmersive() {
  const stage = $('stage');
  const on = !!phoneQuery && phoneQuery.matches && !stage.hidden;
  stage.classList.toggle('immersive', on);
  if (!on) stage.classList.remove('chrome');
  $('chrome-btn').setAttribute('aria-expanded', String(stage.classList.contains('chrome')));
}

// setChrome shows or folds the frame of the app. The menus and the stats sheet
// go with it when it folds, because their buttons leave with the frame and a
// sheet whose button is gone cannot be shut.
function setChrome(show) {
  const stage = $('stage');
  if (!stage.classList.contains('immersive')) return;
  stage.classList.toggle('chrome', show);
  $('chrome-btn').setAttribute('aria-expanded', String(show));
  if (show) return;
  menuClose();
  if (statsOpen()) setStatsOpen(false);
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
  if (QUALITY[storedQuality]) state.quality = storedQuality;
  // The screen has its own step, kept the same way.
  const storedShare = load('sharequality');
  if (QUALITY[storedShare]) state.shareQuality = storedShare;
  paintDeviceMenu();
  // The performance step comes back too. No stored value is full quality.
  const storedPerf = parseInt(load('perf'), 10);
  state.perf = storedPerf >= 0 && storedPerf < PERF.length ? storedPerf : 0;
  paintPerf();
  state.noiseWanted = load('noise') !== '0';
  $('noise').checked = state.noiseWanted;
  $('noise-live').checked = state.noiseWanted;
  // The own picture stays a small preview in the next visit too, if the guest
  // left it that way.
  state.selfPip = load('selfpip') === '1';
  $('pip').checked = state.selfPip;
  // A guest without a camera holds a tile of its own by default, so the switch
  // is the one that hides those tiles. It comes back on the next visit. The
  // key before this one stored the opposite meaning and is dropped.
  state.voiceTiles = load('hidevoicetiles') !== '1';
  $('voice-tiles').checked = !state.voiceTiles;
  localStorage.removeItem('rooms.voicetiles');

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

  // The own picture leaves the large area and becomes a small preview in the
  // corner of the stage. The choice is kept, like the other switches.
  $('pip').addEventListener('change', () => {
    state.selfPip = $('pip').checked;
    store('selfpip', state.selfPip ? 1 : 0);
    layoutStage();
  });

  // A guest without a camera can put its own tile away and leave only the rail
  // row. The choice is kept, like the other switches.
  $('voice-tiles').addEventListener('change', () => {
    const hide = $('voice-tiles').checked;
    state.voiceTiles = !hide;
    store('hidevoicetiles', hide ? 1 : 0);
    layoutStage();
  });

  initLobbyWindow();
  initAsr();
  lookInit();

  // One stored value per guest, written by both sliders. A step that the
  // camera refuses leaves the old size in effect and says so.
  for (const id of ['perf', 'perf-live']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', async () => {
      const n = parseInt(/** @type {HTMLInputElement} */ (el).value, 10);
      // The slider is minimum first; the stored step counts down.
      state.perf = n >= 0 && n < PERF.length ? PERF.length - 1 - n : 0;
      store('perf', state.perf);
      paintPerf();
      await applyQuality();
    });
  }

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

  // The sound switch: on by default, one stored choice for the guest.
  setSounds(load('sounds') !== '0');
  const soundBox = document.getElementById('sounds');
  if (soundBox) {
    soundBox.addEventListener('change', () => {
      const on = /** @type {HTMLInputElement} */ (soundBox).checked;
      store('sounds', on ? 1 : 0);
      setSounds(on);
    });
  }

  // The waiting room switch is for the admin; the server ignores anyone else.
  // The box follows the room, so it is put back if the server did not take it.
  const waitBox = document.getElementById('waiting-room');
  if (waitBox) {
    waitBox.addEventListener('change', () => {
      const on = /** @type {HTMLInputElement} */ (waitBox).checked;
      send({ t: 'mod', action: 'waitingroom', on });
      paintWaiting();
    });
  }

  wireMenuBar();
  wireCornerDrag();
  wireSubmenus();
  $('stats-btn').addEventListener('click', () => setStatsOpen(!statsOpen()));
  $('stats-close').addEventListener('click', () => setStatsOpen(false));

  // A click on a tile is a spotlight: that guest takes the large area alone
  // and every other guest becomes a rail row. The same click again, a click on
  // the empty stage, or Esc gives the normal layout back. A click on a control
  // in the tile stays with that control.
  // A touch screen has no hover, so the first tap on a picture opens its
  // controls (volume, code card, enlarge) and a second tap, or the enlarge
  // button, enlarges it. The controls close on their own after a few seconds.
  const touch = window.matchMedia ? window.matchMedia('(hover: none)') : { matches: false };
  $('grid').addEventListener('click', (event) => {
    // The click that ends a drag of the small tile is not a zoom.
    if (Date.now() - cornerDropAt < 300) return;
    const target = /** @type {Element} */ (event.target);
    // A click on the small preview puts the own picture back in the grid.
    if (target.closest('#self-pip')) {
      state.selfPip = false;
      store('selfpip', 0);
      updateButtons();
      layoutStage();
      return;
    }
    const tile = target.closest('.tile');
    if (!tile) {
      setSpotlight('');
      return;
    }
    if (target.closest('.vol, .dots, .menu, .sas, .pin, .admit')) return;
    const el = /** @type {HTMLElement} */ (tile);
    const id = tileId(el);
    if (!id) return;
    if (touch.matches && !target.closest('.zoom') && el.parentElement === $('stage-main') && !el.classList.contains('ctl')) {
      for (const open of document.querySelectorAll('.tile.ctl')) open.classList.remove('ctl');
      el.classList.add('ctl');
      clearTimeout(/** @type {any} */ (el).ctlTimer);
      /** @type {any} */ (el).ctlTimer = setTimeout(() => el.classList.remove('ctl'), 5000);
      return;
    }
    setSpotlight(id);
  });
  // A tap on the picture folds the frame of the app away on a phone, and the
  // next tap brings it back. A tap on the frame itself never folds it, or no
  // button of the frame could be used while the frame is open. A desktop has
  // no immersive class, so nothing here reaches it.
  $('stage').addEventListener('click', (event) => {
    if (Date.now() - cornerDropAt < 300) return;
    if (!$('stage').classList.contains('immersive')) return;
    const target = /** @type {Element} */ (event.target);
    if (target.closest('.titlebar, .menubar, .statusline, .side, .stats, .chrome-handle')) return;
    setChrome(!$('stage').classList.contains('chrome'));
  });
  $('chrome-btn').addEventListener('click', () => setChrome(true));
  if (phoneQuery) phoneQuery.addEventListener('change', applyImmersive);
  // The list of members sits outside the frame of the grid, so it carries its
  // own listener: a click on a row enlarges that member, the way a click on a
  // tile does.
  const railEl = $('stage-rail');
  if (railEl) {
    railEl.addEventListener('click', (event) => {
      const target = /** @type {Element} */ (event.target);
      if (target.closest('.vol-range, .vol-num, .dots, .menu, .sas, .admit')) return;
      const row = target.closest('.plist-row');
      if (!row) return;
      const id = tileId(/** @type {HTMLElement} */ (row));
      if (id) setSpotlight(id);
    });
  }
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (menuClose()) return;
    closeMenus();
    if (state.spotlight) setSpotlight('');
  });

  // A hidden tab has no one to read the numbers, so the polling sleeps until
  // it comes back. A drawn camera has the same trouble: no frame is painted
  // there, so the senders take the raw camera meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopStats();
      lookPark(true);
    } else {
      if (statsOpen()) startStats();
      lookPark(false);
    }
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

  $('deaf-btn').addEventListener('click', () => setDeaf(!state.deaf));

  $('hand-btn').addEventListener('click', () => setHand(!state.hand));

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
