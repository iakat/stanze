/*
 The device pickers of the join card and the toolbar.
*/

import { QUALITY } from './config.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { isAdmin, joinWords, say } from './util.js';
import { store } from './prefs.js';
import { layoutStage, makeTile, ownTile, paintRowDeaf, setLocalTile } from './tiles.js';
import { applyFlags, paintVolume } from './volume.js';
import { paintWaiting } from './host.js';
import { MIC_AUDIO, applyQuality, ask, camVideo, capVideoSender } from './media.js';
import { applyMirror, resumeAudio, sendState, setNoise, updateButtons } from './audio.js';
import { lookRestart, lookStop, lookTrack } from './look.js';
import { stopShare } from './screen.js';
import { playSfx } from './sfx.js';
import { pairLabel, sealingAvailable } from './sealed.js';

// ---------------------------------------------------------------- devices
//
// The join form carries one picker per kind, and the toolbar keeps a second pair
// for a switch during a call. Every picker shows the same list and the choice
// lives in state.camId and state.micId, so no two pickers can disagree. The
// browser hides the labels and the ids until the page has permission once:
// before that the options are numbered, and a stored id stays in its picker as
// one extra entry, so a reload never loses the camera.
export const DEVICE_NOUN = { video: 'camera', audio: 'microphone' };

export function devicePickers(kind) {
  return kind === 'video' ? [$('cam-select')] : [$('mic-select')];
}

export function deviceList(kind) {
  return kind === 'video' ? state.devCams : state.devMics;
}

export function chosenDevice(kind) {
  return (kind === 'video' ? state.camId : state.micId) || '';
}

export function setChosenDevice(kind, id) {
  if (kind === 'video') state.camId = id;
  else state.micId = id;
  store(kind === 'video' ? 'camId' : 'micId', id);
}

// paintDeviceSelect rewrites one picker in place. The wanted id keeps its place
// while the browser still lists it; a list without ids (no permission yet)
// keeps it as one extra entry; a list with labels that no longer has it drops
// it, so the next request asks for the system device.
export function paintDeviceSelect(select, kind, list, wanted) {
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
export function paintDevices() {
  for (const kind of ['video', 'audio']) {
    const wanted = chosenDevice(kind);
    const list = deviceList(kind);
    let kept = '';
    for (const select of devicePickers(kind)) kept = paintDeviceSelect(select, kind, list, wanted);
    if (wanted && kept !== wanted) {
      setChosenDevice(kind, '');
      say(
        `the ${DEVICE_NOUN[kind]} you chose is gone; the system ${DEVICE_NOUN[kind]} will be used`,
      );
    }
  }
  paintDeviceMenu();
}

// refreshDevices re-reads the device list and repaints the pickers. It runs at
// boot, after every successful device request (the labels arrive with the first
// permission) and on every devicechange.
export async function refreshDevices() {
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
export const QUALITY_LABEL = {
  '640x360@30': '360p 30',
  '1280x720@30': '720p 30',
  '1920x1080@30': '1080p 30',
  '1920x1080@60': '1080p 60',
  '2560x1440@30': '1440p 30',
};

// deviceRows lists the system device, every enumerated device and, before the
// first permission, the stored id as one extra row, the way the odd select did.
export function deviceRows(kind) {
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
export function qualityRows() {
  return Object.keys(QUALITY).map((value) => ({ value, label: QUALITY_LABEL[value] || value }));
}

// paintMenuChoice rewrites one submenu: a button row per choice, a tick on the
// choice in force, and one callback per row.
export function paintMenuChoice(list, rows, current, pick) {
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
export function paintDeviceMenu() {
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
export function constraintsFor(kind, pick) {
  if (kind === 'video') {
    const base = camVideo();
    return pick ? { ...base, deviceId: { exact: pick } } : { ...base, facingMode: 'user' };
  }
  return pick ? { ...MIC_AUDIO, deviceId: { exact: pick } } : { ...MIC_AUDIO };
}

// askKind opens one kind of device. A stored id the browser can no longer honour
// (unplugged, or a profile without it) falls back to the plain request once, so
// a stale choice never blocks a join or a switch.
export async function askKind(kind, pick) {
  const want = (id) =>
    kind === 'video'
      ? { video: constraintsFor('video', id) }
      : { audio: constraintsFor('audio', id) };
  const first = await ask(want(pick));
  if (first.stream || !pick) return first;
  if (
    !first.err ||
    (first.err.name !== 'OverconstrainedError' && first.err.name !== 'NotFoundError')
  )
    return first;
  if (pick === chosenDevice(kind)) {
    setChosenDevice(kind, '');
    paintDevices();
    say(
      `the ${DEVICE_NOUN[kind]} you chose was not available; the system ${DEVICE_NOUN[kind]} will be used`,
    );
  }
  return ask(want(''));
}

// switchDevice moves one live call to another device. The microphone feeds the
// mixer, and the mixer track is what the peers receive, so an audio switch
// touches no sender. The camera replaces the track on the video sender that is
// already there, so the peers see the new camera without a rejoin; only a call
// that started with no camera at all adds a sender.
export async function switchDevice(kind, id) {
  if (!sealingAvailable()) {
    say('this browser cannot seal media frames, so the device stays off');
    return;
  }
  const got = await askKind(kind, id);
  const track = got.stream
    ? kind === 'video'
      ? got.stream.getVideoTracks()[0]
      : got.stream.getAudioTracks()[0]
    : null;
  if (!track) {
    const refused = got.err && got.err.name === 'NotAllowedError';
    say(
      refused
        ? `the ${DEVICE_NOUN[kind]} was refused`
        : `that ${DEVICE_NOUN[kind]} is not available`,
    );
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
export function onDevicePicked(kind, id) {
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
export let devTimer = null;

export function onDeviceChange() {
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
  devTimer = setTimeout(() => {
    devTimer = null;
    refreshDevices();
  }, 250);
}

// requestLocal asks for the camera and the microphone when the join button is
// pressed: one prompt when both are wanted, and the call starts with both on.
// A refusal or a missing device never stops the join; the devices that did not
// open stay off and a short status line says which ones.
export async function requestLocal() {
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
    } else if (
      both.err &&
      (both.err.name === 'NotAllowedError' || both.err.name === 'SecurityError')
    ) {
      // The visitor answered the prompt with no. Asking twice would not prompt.
      refused.push('camera and microphone');
    } else {
      // One of the two may be missing or busy: ask for each of them alone, so
      // the other one still starts. A stored device that is gone falls back to
      // the system device here.
      const parts = await Promise.all([
        askKind('audio', state.micId),
        askKind('video', state.camId),
      ]);
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
    say(
      `the ${joinWords(refused)} ${refused.length > 1 ? 'were' : 'was'} refused; you joined without ${refused.length > 1 ? 'them' : 'it'}`,
    );
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
export function prepareLocal() {
  state.outStream = new MediaStream();
  // The own tile exists even with no camera and no microphone, so the mirror
  // preview, the name and the mute flags always have a place.
  const self = makeTile(state.name, state.name, true);
  setLocalTile(self);
  self.dataset.state = 'connected';
  self.querySelector('.state').textContent = 'you';
  applyFlags(self, state.mic, state.cam, isAdmin(state.self));
  applyMirror();
  updateButtons();
}

// refreshSelf paints the own tile flags and the buttons from the live state.
export function refreshSelf() {
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
export function setDeaf(on) {
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
export function sealOne(peer, side, dir, kind) {
  try {
    side.transform = new RTCRtpScriptTransform(state.worker, {
      // `from` is the sender of the frames this transform sees: this page on a
      // sender, the peer on a receiver. The associated data names it, so both
      // ends build the same bytes and a frame can not be moved or reflected.
      pair: pairLabel(peer.id),
      peer: peer.id,
      dir,
      kind,
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
export function preparePeer(peer) {
  if (peer.tx) return;
  peer.tx = {};
  peer.sealed = true;
  const used = new Set();
  for (const kind of ['audio', 'video', 'screen']) {
    const media = kind === 'screen' ? 'video' : kind;
    let tr = peer.pc
      .getTransceivers()
      .find((t) => !t.stopped && !used.has(t) && t.receiver.track.kind === media);
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
    const track =
      kind === 'screen'
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
export function attachTrack(peer, track) {
  if (peer.sealed === false || peer.waiting) return;
  const tr = peer.tx && peer.tx[track.kind];
  if (!tr) return;
  tr.sender.replaceTrack(track).catch(() => {});
  if (track.kind === 'video') capVideoSender(tr.sender);
}

// attachScreen puts the live screen track on the screen sender of one peer.
// Only the screen sender is touched; the camera keeps its own track.
export function attachScreen(peer) {
  if (peer.sealed === false || peer.waiting) return;
  const tr = peer.tx && peer.tx.screen;
  const track = state.screen && state.screen.getVideoTracks()[0];
  if (tr && track) tr.sender.replaceTrack(track).catch(() => {});
}

// publishTrack hands one new track to every connection that already has its
// transceivers. A connection that is still handshaking picks it up in
// preparePeer.
export function publishTrack(track) {
  if (!track) return;
  for (const peer of state.peers.values()) {
    if (peer.pc) attachTrack(peer, track);
  }
}

// adoptMic makes one microphone track the live input: it goes through GTCRN
// and the gain into the mixer, and the mixer track is what peers receive. A
// second device needs a new source, because a source can not be repointed; the
// analyser is rebuilt with it and the noise choice of the call is kept.
export async function adoptMic(track) {
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
      try {
        state.micSource.disconnect();
      } catch {
        /* not connected */
      }
      if (state.micAnalyser) {
        try {
          state.micAnalyser.disconnect();
        } catch {
          /* not connected */
        }
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
    try {
      prev.stop();
    } catch {
      /* already stopped */
    }
  }
}

// setVideoTrack reuses the stream when the same track is still attached, so a
// repaint does not restart the element.
export function setVideoTrack(video, track) {
  const stream = video.srcObject;
  if (
    !stream ||
    typeof stream.getVideoTracks !== 'function' ||
    stream.getVideoTracks()[0] !== track
  ) {
    video.srcObject = new MediaStream([track]);
  }
}

// camSource is the picture the own preview shows: the frozen still while the
// freeze is on, else the drawn track, else the camera.
export function camSource() {
  if (state.freeze && state.freezeTrack && state.freezeTrack.readyState === 'live')
    return state.freezeTrack;
  return lookTrack() || state.camTrack;
}

// paintSelfCam paints the local preview from the camera state. A disabled
// track gives black frames, so the element is emptied and the tile leaves the
// playing state: the centre name is back until the camera works again.
export function paintSelfCam(on) {
  const self = ownTile();
  if (!self) return;
  const video = self.querySelector('video');
  const track = camSource();
  if (on && track) {
    setVideoTrack(video, track);
    self.classList.add('playing');
    video.play().catch(() => {});
  } else {
    self.classList.remove('playing');
    try {
      video.pause();
    } catch {
      /* not playing */
    }
    video.srcObject = null;
  }
  layoutStage();
}

// paintPeerVideo shows or hides the incoming picture of one guest. A deafened
// guest draws no picture at all, so only names remain; the same track goes back
// when the ears open, so no new negotiation is needed. A camera that its owner
// turned off mutes the receiver track and leaves its last frame in the element,
// so a muted track takes the picture down the same way.
export function paintPeerVideo(peer) {
  const video = peer.tile && peer.tile.querySelector('video');
  if (!video) return;
  const track = peer.videoTrack;
  const live = track && track.readyState === 'live' && !track.muted && peer.cam !== false;
  if (!state.deaf && live) {
    setVideoTrack(video, track);
    peer.tile.classList.add('playing');
    video.play().catch(() => {});
  } else {
    dropPeerCamera(peer);
  }
  layoutStage();
}

// dropPeerCamera takes the last decoded frame out of the element and lets the
// tile fall back to its name. The receiver track is kept, so the same track
// comes back when the camera does, and a sender that only replaces its track
// with nothing leaves no picture behind.
export function dropPeerCamera(peer) {
  const video = peer.tile && peer.tile.querySelector('video');
  if (!video) return;
  peer.tile.classList.remove('playing');
  try {
    video.pause();
  } catch {
    /* not playing */
  }
  video.srcObject = null;
}

// paintRemoteVideo applies the deaf state to every guest already in the room.
export function paintRemoteVideo() {
  for (const peer of state.peers.values()) {
    paintPeerVideo(peer);
    paintPeerScreen(peer);
  }
}

// makeScreenTile builds the second picture of a guest on its first screen
// track. It has no row of its own: the list already carries the guest, and the
// label says which picture it is. The node stays for the pair, so a share that
// stops and starts again reuses it.
export function makeScreenTile(peer) {
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
export function paintPeerScreen(peer) {
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
    try {
      video.pause();
    } catch {
      /* not playing */
    }
    video.srcObject = null;
  }
  layoutStage();
}

// dropPeerScreen takes the screen tile of a guest out of the stage and lets go
// of the frozen last frame. The receiver track itself stays for the pair, so the
// next share of that guest reuses it and needs no new negotiation.
export function dropPeerScreen(peer) {
  if (!peer.screenTile) return;
  const video = peer.screenTile.querySelector('video');
  peer.screenTile.classList.remove('playing');
  try {
    video.pause();
  } catch {
    /* not playing */
  }
  video.srcObject = null;
  peer.screenTile.remove();
  peer.screenTile = null;
  layoutStage();
}

// adoptCam makes one camera track the live video. The camera keeps its own
// sender while a screen is shared, so the picture goes to the camera sender and
// the share is not touched. A track that replaces an earlier camera is handed to
// the video sender that is already there, so a switch needs no renegotiation.
export async function adoptCam(track) {
  if (!track) return;
  const prev = state.camTrack;
  state.camTrack = track;
  // A new camera hands the live picture back: the still was of the old one.
  if (state.freeze) {
    if (state.freezeTrack) {
      try {
        state.freezeTrack.stop();
      } catch {
        /* already stopped */
      }
    }
    state.freeze = false;
    state.freezeTrack = null;
    state.freezeCanvas = null;
    const box = $('freeze');
    if (box) box.checked = false;
  }
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
    try {
      prev.stop();
    } catch {
      /* already stopped */
    }
  }
  applyMirror();
}

export async function enableMic() {
  if (!sealingAvailable()) {
    // No transform, no frame: the microphone stays off and says why.
    say('this browser cannot seal media frames, so the microphone stays off');
    return;
  }
  if (!state.micTrack) {
    const mic = await askKind('audio', state.micId);
    const track = mic.stream ? mic.stream.getAudioTracks()[0] : null;
    if (!track) {
      say(
        mic.err && mic.err.name === 'NotAllowedError'
          ? 'the microphone was refused'
          : 'the microphone is not available',
      );
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
export function disableMic(persist = true) {
  playSfx('hammer');
  state.mic = false;
  if (persist) store('mic', 0);
  if (state.micGain) state.micGain.gain.value = 0;
  updateButtons();
  sendState();
}

export async function enableCam() {
  if (!sealingAvailable()) {
    say('this browser cannot seal media frames, so the camera stays off');
    return;
  }
  if (!state.camTrack) {
    const cam = await askKind('video', state.camId);
    const track = cam.stream ? cam.stream.getVideoTracks()[0] : null;
    if (!track) {
      say(
        cam.err && cam.err.name === 'NotAllowedError'
          ? 'the camera was refused'
          : 'the camera is not available',
      );
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

export function disableCam(persist = true) {
  state.cam = false;
  if (persist) store('cam', 0);
  // A disabled track keeps the device open, so the camera light stays on. Stop
  // the track and drop it: enableCam asks the device again, and the video
  // sender that still holds the old track gets the new one in adoptCam.
  const track = state.camTrack;
  state.camTrack = null;
  // A frozen still has no camera behind it any more, so the freeze goes too.
  if (state.freeze) {
    if (state.freezeTrack) {
      try {
        state.freezeTrack.stop();
      } catch {
        /* already stopped */
      }
    }
    state.freeze = false;
    state.freezeTrack = null;
    state.freezeCanvas = null;
    const box = $('freeze');
    if (box) box.checked = false;
  }
  // The drawn track reads from the camera, so it goes with it.
  lookStop();
  if (track) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
  paintSelfCam(false);
  updateButtons();
  sendState();
}

// buildAudio wires mic -> (GTCRN) -> gain -> mixer. The mixer track is what
// the peers receive, and it is created even without a microphone so screen
// audio can be added later without touching the peer connections.
export async function buildAudio() {
  // Safari still exposes the prefixed constructor, which the DOM lib omits.
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
export function startMeter() {
  if (!state.audioCtx || !state.micSource || state.micAnalyser) return;
  state.micAnalyser = state.audioCtx.createAnalyser();
  state.micAnalyser.fftSize = 1024;
  state.micSource.connect(state.micAnalyser);
}
