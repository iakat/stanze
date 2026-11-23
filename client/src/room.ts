/*
 Create, join, wait, leave and the lobby that drives them.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { say, setAdmins } from './util.js';
import { load, store } from './prefs.js';
import { menuSet, setHash, suggestRoom } from './menu.js';
import { setLocalTile } from './tiles.js';
import { startCallClock, stopCallClock } from './clock.js';
import { paintWaiting } from './host.js';
import { prepareLocal, requestLocal } from './devices.js';
import {
  ensurePlayback,
  paintHandQueue,
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
      say('cannot open a sealed room: ' + why);
      return;
    }

    // The passphrase becomes a scalar before the socket opens, and the plain
    // text is dropped right after: the join frame carries the room id only,
    // and the scalar is the only form the proof ever needs.
    $('sealed-note').textContent = 'deriving the room key';
    canary(pass);
    state.w = roomW(pass, room);
    // The value a guest typed is the gate it starts from. A room that changed
    // its gate later hands the current value down the sealed pair, so the
    // typed one is only the first word.
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
    for (const track of state.screen.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
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
  if (state.micTrack) {
    try {
      state.micTrack.stop();
    } catch {
      /* already stopped */
    }
  }
  if (state.camTrack) {
    try {
      state.camTrack.stop();
    } catch {
      /* already stopped */
    }
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
  // The room field keeps the room the visitor was just in, so another try
  // needs no retyping.
  if (was) $('room').value = was;
  else suggestRoom();
  if (message) {
    say(message);
    // The chat log goes with the call, so the lobby says why this page is back
    // in it. A guest removed by the host must not be left guessing.
    const note = $('sealed-note');
    if (note) {
      note.hidden = false;
      note.textContent = message;
    }
  }
}
