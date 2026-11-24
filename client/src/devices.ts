/*
 The device pickers of the join card and the toolbar.
*/

import { QUALITY } from './config.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { detachMedia, isAdmin, joinWords, say } from './util.js';
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
// Pickers share one list and the choice in state.camId and state.micId, so they
// can not disagree. Labels and ids need one permission; a stored id stays in its
// picker as an extra entry until then, so a reload keeps the camera.
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
// while the browser lists it; a list without labels keeps it as one extra entry,
// a labelled list that lacks it falls back to the system device.
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
    // A label needs one permission; without it the picker counts the devices.
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

// paintDevices fills every picker from the last enumeration. A choice the
// enumeration does not carry is dropped with one line in the status box.
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

// refreshDevices reads the device list and repaints the pickers: at boot, after
// each device request and on every devicechange. Labels need the first permission.
export async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let all;
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

// deviceRows lists the system device, every enumerated device and the stored id
// as one extra row when the enumeration does not carry it.
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

export function qualityRows() {
  return Object.keys(QUALITY).map((value) => ({ value, label: QUALITY_LABEL[value] || value }));
}

// paintMenuChoice rewrites one submenu: a button row per choice, ticked on the
// choice in force, with one callback per row.
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

// paintDeviceMenu rebuilds the four lists: microphone, camera, camera quality and
// screen quality, ticked at the choice in force.
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

// constraintsFor builds one request: the chosen device when there is one, else the
// plain ideal request. Only that one takes facingMode; a deviceId names the lens.
export function constraintsFor(kind, pick) {
  if (kind === 'video') {
    const base = camVideo();
    return pick ? { ...base, deviceId: { exact: pick } } : { ...base, facingMode: 'user' };
  }
  return pick ? { ...MIC_AUDIO, deviceId: { exact: pick } } : { ...MIC_AUDIO };
}

// askKind opens one kind of device. A stored id the browser can not honour falls
// back to the plain request once, so a stale choice never blocks a join.
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

// switchDevice moves one live call to another device: audio rides the mixer the
// peers already receive, video replaces its track on the sender, so no rejoin.
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

// onDeviceChange reacts to a camera or a microphone that came or went. A live
// track that ended is dropped and the call marks that device off.
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

// requestLocal asks for the camera and the microphone on join, both in one
// prompt. A refusal or a missing device never stops the join, it stays off.
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
      // The visitor said no to the prompt; asking again would not prompt.
      refused.push('camera and microphone');
    } else {
      // One of the two may be missing or busy: ask for each alone, so the other
      // starts. A stored device that is unavailable falls back to the system.
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

// prepareLocal builds the empty local side: output stream, own tile and buttons.
// requestLocal runs right after it and fills in the devices.
export function prepareLocal() {
  state.outStream = new MediaStream();
  // The own tile exists without a camera and a microphone too, so the mirror, the
  // name and the mute flags always have a place.
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

// setDeaf shuts both directions: devices off, guests turned down, no picture
// drawn, and a share ends. Undeafen gives the devices and every volume back.
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

// sealOne puts the frame transform on one sender or receiver. It is the only
// install path and never waits for keys; a setter that throws becomes a fault.
export function sealOne(peer, side, dir, kind) {
  try {
    side.transform = new RTCRtpScriptTransform(state.worker, {
      // `from` names who sends these frames: the page on send, the peer on receive;
      // the AAD binds it, so a moved or reflected frame can not match.
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

// preparePeer seals one transceiver per kind both ways and attaches the live track
// before the offer leaves. Screen has its own, so a share needs no renegotiation.
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
    // A waiting guest gets no media until it is let in.
    if (peer.waiting) continue;
    tr.sender.replaceTrack(track).catch(() => {});
    if (kind === 'video') capVideoSender(tr.sender);
  }
}

// attachTrack points the sender of that kind at a track. Transceiver and transform
// already exist, so a track change needs no renegotiation.
export function attachTrack(peer, track) {
  if (peer.sealed === false || peer.waiting) return;
  const tr = peer.tx && peer.tx[track.kind];
  if (!tr) return;
  tr.sender.replaceTrack(track).catch(() => {});
  if (track.kind === 'video') capVideoSender(tr.sender);
}

// attachScreen puts the live screen track on the screen sender of one peer; the
// camera keeps its own track.
export function attachScreen(peer) {
  if (peer.sealed === false || peer.waiting) return;
  const tr = peer.tx && peer.tx.screen;
  const track = state.screen && state.screen.getVideoTracks()[0];
  if (tr && track) tr.sender.replaceTrack(track).catch(() => {});
}

// publishTrack hands one new track to every connection that has transceivers; a
// connection that is handshaking picks it up in preparePeer.
export function publishTrack(track) {
  if (!track) return;
  for (const peer of state.peers.values()) {
    if (peer.pc) attachTrack(peer, track);
  }
}

// adoptMic makes one microphone track the live input: GTCRN and the gain feed the
// mixer that peers receive. A source can not be repointed, so a switch rebuilds it.
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

// setVideoTrack reuses the stream when the same track is attached, so a repaint
// does not restart the element.
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

// camSource is the own preview picture: the frozen still while the freeze is on,
// else the drawn track, else the camera.
export function camSource() {
  if (state.freeze && state.freezeTrack && state.freezeTrack.readyState === 'live')
    return state.freezeTrack;
  return lookTrack() || state.camTrack;
}

// paintSelfCam paints the local preview. A disabled track gives black frames, so
// the element is emptied and the tile leaves the playing state for the name.
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
    detachMedia(video);
  }
  layoutStage();
}

// paintPeerVideo shows or hides one guest picture. A deafened guest draws none,
// and a muted track takes it down too, though its last frame would stay.
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

// dropPeerCamera empties the element and lets the tile fall back to its name. The
// receiver track stays, so the same picture comes back with the camera.
export function dropPeerCamera(peer) {
  const video = peer.tile && peer.tile.querySelector('video');
  if (!video) return;
  peer.tile.classList.remove('playing');
  detachMedia(video);
}

// paintRemoteVideo applies the deaf state to every guest in the room.
export function paintRemoteVideo() {
  for (const peer of state.peers.values()) {
    paintPeerVideo(peer);
    paintPeerScreen(peer);
  }
}

// makeScreenTile builds the second picture of a guest on its first screen track.
// It has no row of its own, and the node stays for the pair so a share reuses it.
export function makeScreenTile(peer) {
  if (peer.screenTile) return peer.screenTile;
  peer.screenTile = makeTile(peer.id, `${peer.name}, screen`, false, true);
  peer.screenTile.dataset.peer = peer.id;
  // A new frame size lays the stage out again.
  peer.screenTile.querySelector('video').addEventListener('resize', () => layoutStage());
  // The camera flag stays out: this tile is the screen, not the face.
  applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
  return peer.screenTile;
}

// paintPeerScreen shows or hides one guest screen. The tile is built on the first
// live track, so no empty second tile stands in the stage.
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
    detachMedia(video);
  }
  layoutStage();
}

// dropPeerScreen removes the tile and its frozen last frame. The receiver track
// stays for the pair, so the next share reuses it.
export function dropPeerScreen(peer) {
  if (!peer.screenTile) return;
  const video = peer.screenTile.querySelector('video');
  peer.screenTile.classList.remove('playing');
  detachMedia(video);
  peer.screenTile.remove();
  peer.screenTile = null;
  layoutStage();
}

// adoptCam makes one camera track the live video. The picture goes to the camera
// sender, never the share, and a switch needs no renegotiation.
export async function adoptCam(track) {
  if (!track) return;
  const prev = state.camTrack;
  state.camTrack = track;
  // A new camera hands the live picture back: the frozen frame is stale.
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

// disableMic mutes the microphone. A mute the guest chose is remembered, a mute
// the host forced is not, or the guest joins muted for ever after one request.
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
  // A disabled track keeps the device open and its light on. Stop and drop it;
  // enableCam asks again and adoptCam hands the new track to the sender.
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

// buildAudio wires mic -> GTCRN -> gain -> mixer, and the mixer track is what the
// peers receive. The mixer exists without a microphone so screen audio fits later.
export async function buildAudio() {
  // Safari exposes only the prefixed constructor, which the DOM lib omits.
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

// startMeter taps the microphone before the gain on a second branch, so the stats
// show a live device while the local mute is on. speakTick reads that tap.
export function startMeter() {
  if (!state.audioCtx || !state.micSource || state.micAnalyser) return;
  state.micAnalyser = state.audioCtx.createAnalyser();
  state.micAnalyser.fftSize = 1024;
  state.micSource.connect(state.micAnalyser);
}
