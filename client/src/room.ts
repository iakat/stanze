/*
 Create, join, wait, leave and the lobby that drives them.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { say, setAdmins, stopQuietly, stopTracks } from './util.js';
import { load, store } from './prefs.js';
import { menuSet, setHash, suggestRoom } from './menu.js';
import { setLocalTile } from './tiles.js';
import { startCallClock, stopCallClock } from './clock.js';
import { paintWaiting } from './host.js';
import { prepareLocal, requestLocal } from './devices.js';
import {
  ensurePlayback,
  paintHandQueue,
  prefetchNoise,
  startSpeaking,
  stopSpeaking,
  updateButtons,
} from './audio.js';
import { cancelReconnect, connectWS, dropPeers } from './signaling.js';
import { fileClearAll } from './files.js';
import { ensureSfx, preloadSfx, sfxCache, stopLost } from './sfx.js';
import { clearStatsPanel, stopStats } from './stats.js';
import { b64d, b64e, cleanSealedName, pqModule, sealingAvailable } from './sealed.js';
import { deviceNote, updatePinCount } from './identity.js';
import { paintGate, wipeIdentity } from './handshake.js';
import { startSealedWorker } from './frame.js';
import { ensureReady } from './wasm.js';
import { asrStop, omniStop } from './asr.js';
import { canary } from './audit.js';
import { roomW } from './gate.js';
import { applyImmersive } from './phone.js';

// ---------------------------------------------------------------- room flow
export async function enterRoom(room, pass) {
  ensureSfx();
  preloadSfx();
  cancelReconnect();
  state.fatal = '';
  state.room = room;
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

  // The post-quantum module loads before the stage appears, so a browser that
  // cannot seal stays in the lobby with a reason.
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
      // No silent fallback to an unsealed room: the lobby says what failed.
      state.room = '';
      say('cannot open a sealed room: ' + why);
      return;
    }

    // The passphrase becomes the SPAKE2 scalar before the socket opens; the
    // join frame carries the room id and no secret.
    $('sealed-note').textContent = 'deriving the room key';
    canary(pass);
    state.w = roomW(pass, room);
    // The typed passphrase is the first gate value; an admin change comes
    // sealed down the pair.
    state.gate = { v: pass, n: 0 };
    paintGate();
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
    // A phone folds the call to the picture; a tap brings the frame back.
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
    // The incoming noise filter downloads 15 MB on first use; start that now,
    // while the devices and the socket come up, not on the first talker.
    prefetchNoise();
    if (sealingAvailable()) {
      // Devices are asked for before the signaling socket opens, so the first
      // offer already carries both tracks.
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

export function leave(message) {
  const was = state.room;
  state.leaving = true;
  cancelReconnect();
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
  if (state.screen) {
    stopTracks(state.screen);
    state.screen = null;
    if (state.screenTile) {
      state.screenTile.remove();
      state.screenTile = null;
    }
  }
  dropPeers();
  // The worker holds the pair keys and dies with the call; the wasm and the
  // long-term identity stay, only the per-call secrets are zeroed.
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  wipeIdentity();
  state.w = '';
  state.gate = { v: null, n: 0 };
  state.auth = { n: -1, admins: [], by: '', sig: '' };
  if (state.authTimer) clearTimeout(state.authTimer);
  state.authTimer = null;
  state.wait = { on: false, n: 0 };
  state.kickedFps = new Set();
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
  state.clearSignaling = 0;
  state.canaries = new Set();
  state.samples = [];
  asrStop();
  omniStop();
  state.waiting = false;
  state.waitingRoom = false;
  state.hand = false;
  state.handTs = 0;
  state.insideFps.clear();
  paintWaiting();
  paintHandQueue();
  updatePinCount();
  $('chat-note').hidden = true;
  if (state.micTrack) stopQuietly(state.micTrack);
  if (state.camTrack) stopQuietly(state.camTrack);
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
  setLocalTile(null);
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
  // The room field keeps the last room, so another try needs no retyping.
  if (was) $('room').value = was;
  else suggestRoom();
  if (message) {
    say(message);
    // The chat log goes with the call, so the lobby says why this page is back in it.
    const note = $('sealed-note');
    if (note) {
      note.hidden = false;
      note.textContent = message;
    }
  }
}
