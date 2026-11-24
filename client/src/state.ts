/*
 The client state, one object per page.
*/

// CUST_DEFAULTS are the knobs of the custom effect: each a percent of a face
// measure, so they hold near and far from the camera. 100 is neutral for a size
// and 0 for a shift or the pinch.
export const CUST_DEFAULTS = {
  head: 100,
  width: 100,
  eyes: 100,
  spread: 100,
  eyey: 0,
  nose: 100,
  mouth: 100,
  mshift: 0,
  pinch: 0,
  swap: false,
};

export const state = {
  ws: null,
  self: null,
  room: '',
  name: '',
  ice: [],
  peers: new Map(),
  admins: new Set(), // the role list of the sealed claim; empty until one arrives
  camTrack: null,
  freeze: false, // the outgoing camera picture is locked to one frame
  freezeTrack: null, // the still that carries that frame
  freezeCanvas: null, // the canvas behind the still, kept so it stays live
  freezeVideo: null, // hidden video on the camera, used when no look draws a frame
  micTrack: null,
  outStream: null, // what is sent to peers
  lookParked: false, // true while a hidden tab sends the raw camera
  // Face effect knobs, each a percent of a face measure, so they hold near and far from the camera.
  cust: { ...CUST_DEFAULTS },
  audioCtx: null, // the microphone graph
  mixer: null,
  micGain: null,
  micSource: null,
  micAnalyser: null, // tap on the microphone input, for the stats level
  meterPeak: 0, // decaying peak, so one tick per second can see a word
  denoise: null,
  denoiseOn: false,
  noiseWasm: null, // one fetch of the noise model, shared by every node
  playCtx: null, // the remote audio graph, so a peer can go over 100%
  screen: null, // display stream while sharing
  screenSource: null,
  screenTile: null, // own screen tile while sharing
  mic: false, // live in this call, and the stored choice
  cam: false,
  deaf: false, // this browser plays no sound and sends no microphone
  micBeforeDeaf: false, // the microphone state to restore when deaf mode ends
  camBeforeDeaf: false, // the camera state to restore when deaf mode ends
  camId: '', // deviceId of the chosen camera, '' = the system device
  micId: '', // the same for the microphone
  devCams: [], // last enumerateDevices() video inputs
  devMics: [], // last enumerateDevices() audio inputs
  path: 'auto',
  quality: '1280x720@30',
  shareQuality: '1920x1080@30', // the screen has its own quality step
  perf: 0, // performance step, 0 = full quality (the default)
  sounds: true, // the four cues and the lost connection chime
  statsBytes: false, // the stats panel reads its rates in kibibytes and mebibytes
  waitingRoom: false, // the room switch an admin sets
  waiting: false, // this guest is held outside until a member lets it in
  hand: false, // this guest has a raised hand
  handTs: 0, // when it went up, so every guest orders the queue the same
  insideFps: new Set(), // fingerprints of proven guests seen inside this call, for a quick return
  mirror: true,
  selfPip: false, // the own picture is a small preview, not a tile in the grid
  voiceTiles: true, // a guest without a camera also gets a tile in the large area
  look: 'none', // the look of the own camera, drawn in this tab
  masks: [], // masks drawn on the face, any number at once
  lookPipe: null, // the canvas pipeline while a look or a mask is on
  lookOut: null, // the canvas video track that peers receive
  lookSrc: null, // the camera track the running pipeline was built from
  lookGrace: 0, // when the kept look pipeline goes off, 0 = no grace running
  lookGraceMs: 120000, // how long that grace lasts, for a test to shorten
  lookSwaps: 0, // sender track swaps made by lookPublish, for a test
  lookTimer: null, // the timer that ends that grace
  noiseWanted: true,
  leaving: false,
  reconnectTimer: null,
  reconnectDelay: 500,
  fatal: '',
  statsTimer: null,
  statsBusy: false,
  notice: '', // the text on the status line now, so a later step can tell whose it is
  statHist: [], // one sample a second, for the graph in the stats panel
  callStart: 0, // ms at the join, for the header timer
  callTimer: null,
  sfxCtx: null,
  sfxSource: null,
  lostSource: null, // the loop that plays while the socket is down
  lostGain: null,
  lostWanted: false,
  speakTimer: null, // the green light on each tile while a person talks
  ownSpoke: null,
  spotlight: '', // peer id or 'self' while one guest holds the large area

  // Sealed state for one join: the worker, the identity and the counters die with it.
  wasmOk: false, // /pq.wasm loaded and the self test passed once
  wasmTest: null, // the result of that self test, for the stats panel
  identity: null, // our per-call key bundle, wiped in leave
  idKey: null, // our long-term Ed25519 identity, kept when the browser allows it
  device: '', // kept, fresh (stored record would not reopen) or session (nothing kept)
  sid: '', // session id of this call, public, never a secret
  w: '', // SPAKE2 scalar of the room passphrase, never sent
  gate: { v: null, n: 0 }, // the room passphrase the members hold now, with a counter
  auth: { n: -1, admins: [], by: '', sig: '' }, // the signed role claim this page holds
  authTimer: null, // the one timer that gives a room with no member a first admin
  wait: { on: false, n: 0 }, // the sealed waiting-room switch, with a counter
  kickedFps: new Set(), // identities this page removed for good in this call
  pins: new Map(), // local label -> {label, fp, first, last}
  revoked: new Map(), // fingerprint -> {fp, label, at}, a pin that was replaced
  identityFailures: 0, // a peer that sent no identity or could not prove one
  worker: null, // /e2e-transform.js, one per sealed call
  keyWait: new Map(), // pair -> {gen, resolve}, waiting for the worker to import keys
  keyGen: 0, // one rising number for every key agreement on the page
  frames: {} as Record<string, { pair?: string; dir?: string; ok?: number; fail?: number }>, // pair|dir|kind -> last counter message of the worker
  encryptFrames: 0,
  decryptFrames: 0,
  chatSent: 0,
  chatRecv: 0,
  replayDrops: 0, // a sealed app or file frame out of order or replayed
  fileOffers: 0, // file offers this guest sent
  fileRecv: 0, // file offers this guest received and saved
  fileChunksSent: 0, // sealed chunks that went over a data channel
  fileChunksRecv: 0,
  fileRefused: 0,
  fileCancelled: 0,
  files: new Map(), // transfer id -> offer this guest sent
  filesIn: new Map(), // peer id and transfer id -> offer this guest received
  fileLinks: new Set<string>(), // blob urls handed to the guest, revoked on leave
  confirmFailures: 0,
  workerErrors: [], // a red row in the stats panel
  sealFault: '', // why this browser can not seal media
  wireFrames: 0, // signaling frames inspected by the audit
  wireLeaks: [] as { where: string; canary: string }[], // a canary that appeared on the wire, must stay empty
  clearSignaling: 0, // frames that still carried a clear sdp or candidate
  canaries: new Set<string>(), // the passphrase, names, chat lines and file names that must never leak
  samples: [], // a few frame samples, for the in-page lab proof
};

// The markup is the single source of truth for the element types: a listed id
// hands back the right DOM type, and an unlisted one is a typo.
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
 *   'look-filter': HTMLSelectElement, freeze: HTMLInputElement,
 * }} Elements
 */

/**
 * @template {keyof Elements} K
 * @param {K} id
 * @returns {Elements[K]}
 */
