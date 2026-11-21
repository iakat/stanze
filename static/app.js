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
  admins: new Set(),  // filled by `joined`; empty until then
  raw: null,          // camera + microphone from getUserMedia
  camTrack: null,
  micTrack: null,
  outStream: null,    // what is sent to peers
  audioCtx: null,     // the microphone graph
  mixer: null,
  micGain: null,
  micSource: null,
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
};

// The markup is the single source of truth for the element types: an id that
// is not listed here is a typo, and a listed id hands back the right DOM type.
/**
 * @typedef {{
 *   lobby: HTMLElement, 'join-form': HTMLFormElement, name: HTMLInputElement,
 *   room: HTMLInputElement, 'newid-btn': HTMLButtonElement, pass: HTMLInputElement,
 *   path: HTMLSelectElement, noise: HTMLInputElement, 'enter-btn': HTMLButtonElement,
 *   'lobby-error': HTMLElement, stage: HTMLElement, 'room-label': HTMLElement,
 *   'peer-count': HTMLElement, 'copy-btn': HTMLButtonElement, 'link-dot': HTMLElement,
 *   'link-text': HTMLElement, grid: HTMLElement, 'stats-panel': HTMLElement,
 *   'stats-body': HTMLElement, 'chat-log': HTMLElement, 'chat-form': HTMLFormElement,
 *   'chat-text': HTMLInputElement, 'mic-btn': HTMLButtonElement,
 *   'cam-btn': HTMLButtonElement, 'share-btn': HTMLButtonElement,
 *   'stats-btn': HTMLButtonElement, 'leave-btn': HTMLButtonElement,
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
    ${local ? '' : `<div class="vol">
      <input class="vol-range" type="range" min="0" max="200" step="5" value="100" aria-label="volume of this participant">
      <span class="vol-num">100%</span>
    </div>`}
    <div class="tag"><span class="name"></span><span class="flags"></span><span class="state"></span></div>
    ${local ? '' : '<button class="dots" type="button" aria-label="host actions">&#8943;</button><div class="menu" hidden></div>'}`;
  tile.querySelector('.name').textContent = local ? `${name} (you)` : name;
  tile.querySelector('.avatar').textContent = (name || '?').slice(0, 2);
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

// wireVolume connects one tile slider to one peer. The gain and the label are
// painted from peer.vol, which the audio path and the slider share.
function wireVolume(peer) {
  const range = peer.tile.querySelector('.vol-range');
  const num = peer.tile.querySelector('.vol-num');
  if (!range || !num) return;
  const paint = () => {
    num.textContent = `${peer.vol}%`;
    if (peer.gain) peer.gain.gain.value = peer.vol / 100;
    // The element path is only a fallback and can not go over 100 percent.
    if (peer.audioEl) peer.audioEl.volume = Math.min(peer.vol / 100, 1);
  };
  range.value = String(peer.vol);
  range.addEventListener('input', () => {
    const n = parseInt(range.value, 10);
    peer.vol = Number.isFinite(n) ? Math.max(0, Math.min(200, n)) : 100;
    paint();
    store(`vol.${peer.name}`, peer.vol);
  });
  paint();
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
  peer = {
    id,
    name: name || 'guest',
    mic: mic === undefined ? true : mic,
    cam: cam === undefined ? true : cam,
    vol: 100,
    pc: null,
    tile: null,
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
  };
  peer.vol = storedVolume(peer.name);
  peer.tile = makeTile(peer.name, peer.name);
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
  dropAudio(peer);
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
    stopLost();
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
    startLost();
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
      setAdmins(msg.admins);
      for (const peer of msg.peers || []) connectPeer(peer.id, peer.name, true, peer.mic, peer.cam);
      markAdmins();
      renderChat(msg.chat);
      // Tell the room the real microphone and camera state right away.
      sendState();
      break;
    }
    case 'peer-joined': {
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
  // The call starts with what the visitor chose last time.
  state.mic = state.prefMic;
  state.cam = state.prefCam;
  store('name', state.name);
  store('room', state.room);
  store('path', state.path);
  store('noise', state.noiseWanted ? 1 : 0);

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

// ownMediaLine describes the local devices: rnnoise, the microphone rate and
// the camera resolution, which is what the own tile contributes.
function ownMediaLine() {
  const parts = [];
  if (!state.micTrack) parts.push('rnnoise off');
  else parts.push(state.rnnoiseOn ? 'rnnoise on' : 'rnnoise off');
  const mic = state.micTrack && state.micTrack.getSettings ? state.micTrack.getSettings() : null;
  if (mic && mic.sampleRate) parts.push(`mic ${Math.round(mic.sampleRate / 1000)} kHz ${mic.channelCount || 1}ch`);
  else parts.push('mic off');
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

function statsRow(title, lines) {
  const row = document.createElement('div');
  row.className = 'srow';
  const head = document.createElement('div');
  head.className = 'sname';
  head.textContent = title;
  row.appendChild(head);
  for (const text of lines) {
    const line = document.createElement('div');
    line.className = 'sline';
    line.textContent = text;
    row.appendChild(line);
  }
  return row;
}

// updateStats draws one round. The totals of the own tile are the sums of the
// per peer numbers across every connection.
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
    body.replaceChildren(statsRow('you', [ownMediaLine(), rateLine(total)]), ...rows);
  } finally {
    state.statsBusy = false;
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

  $('stats-btn').addEventListener('click', () => {
    const open = !statsOpen();
    $('stats-panel').hidden = !open;
    $('stats-btn').setAttribute('aria-pressed', String(open));
    if (open && !document.hidden) startStats();
    else stopStats();
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

  setInterval(pollRelay, 5000);
}

init();
