/*
 The one function that wires the page and runs.
*/

import { LOOKS, PERF, QUALITY, ROOM_RE } from './config.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { isAdmin, newRoomID, say } from './util.js';
import { load, store } from './prefs.js';
import {
  menuClose,
  normalizeRoom,
  roomFromHash,
  suggestRoom,
  wireMenuBar,
  wireSubmenus,
} from './menu.js';
import {
  cornerDropAt,
  layoutStage,
  pairStage,
  setSpotlight,
  tileId,
  wirePipDrag,
} from './tiles.js';
import { purgeNamedVolume } from './volume.js';
import { closeMenus } from './host.js';
import { applyQuality, paintPerf } from './media.js';
import {
  devicePickers,
  disableCam,
  disableMic,
  enableCam,
  enableMic,
  onDeviceChange,
  onDevicePicked,
  paintDeviceMenu,
  refreshDevices,
  setDeaf,
} from './devices.js';
import { applyMirror, ensurePlayback, setHand, setNoise, updateButtons } from './audio.js';
import {
  lookInit,
  lookOn,
  lookPark,
  lookRestart,
  lookTrack,
  maskBoxes,
  maskSet,
  setFreeze,
} from './look.js';
import { startShare, stopShare } from './screen.js';
import { enterRoom, leave } from './room.js';
import { fileOffer } from './files.js';
import { setSounds, startLost, stopLost } from './sfx.js';
import { setStatsOpen, startStats, statsOpen, stopStats, updateStats } from './stats.js';
import { win } from './sealed.js';
import {
  deviceNote,
  pinPeer,
  pinState,
  renamePin,
  resetDevice,
  storageAudit,
  verifiedPeers,
} from './identity.js';
import { paintGate, setGate } from './handshake.js';
import { pqSelfTest, preloadSealed } from './wasm.js';
import { asrStats, initAsr } from './asr.js';
import { initLobbyWindow } from './lobby.js';
import { renameSelf, sendSealedChat, setWaitingRoom } from './gate.js';
import { runLab } from './lab.js';
import { applyImmersive, phoneQuery, setChrome } from './phone.js';

// window.e2eApp is the hook the browser test drives; a person never needs it.
// It exposes the counters of a sealed call from the one client.
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
  peers: () =>
    [...state.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      sas: p.sas || '',
      fp: p.fp || '',
      pin: pinState(p),
      proven: !!p.proven,
      confirmed: !!p.confirmed,
      ready: p.tile ? p.tile.dataset.e2e || p.ready : p.ready,
      pc: p.pc ? p.pc.connectionState : 'none',
      dc: p.dc ? p.dc.readyState : 'none',
      videoW: p.video ? p.video.videoWidth : 0,
      videoT: p.video ? p.video.currentTime : 0,
      video: p.video,
    })),
  identity: () =>
    state.idKey
      ? {
          kind: state.idKey.kind,
          fp: state.idKey.fp,
          device: state.device,
          note: deviceNote(),
          sid: state.sid,
        }
      : null,
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
    clearSignaling: state.clearSignaling,
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

// ---------------------------------------------------------------- boot

// restorePrefs the stored choices and the last room come back before any listener is wired.
function restorePrefs() {
  // A volume kept under a guest name is a list of the people who used this
  // machine, so the purge goes before anything else reads it.
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
  // name. No stored value means on; a stored off is honoured and not asked for.
  state.mic = load('mic') !== '0';
  state.cam = load('cam') !== '0';
  // The chosen devices come back like the on and off choices. An id is only
  // meaningful inside this browser profile, so a stale one is not found and the
  // system device is used.
  state.camId = load('camId').slice(0, 256);
  state.micId = load('micId').slice(0, 256);
  const storedPath = load('path');
  if (['auto', 'p2p', 'relay'].includes(storedPath)) {
    state.path = storedPath;
    $('path').value = storedPath;
  }
  // The quality step comes back too, so the first camera request is already the
  // chosen size.
  const storedQuality = load('quality');
  if (Object.hasOwn(QUALITY, storedQuality)) state.quality = storedQuality;
  // The screen has its own step, kept the same way.
  const storedShare = load('sharequality');
  if (Object.hasOwn(QUALITY, storedShare)) state.shareQuality = storedShare;
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
  // A guest without a camera holds a tile by default, so the switch hides those
  // tiles. The older key that stored the opposite meaning is dropped.
  state.voiceTiles = load('hidevoicetiles') !== '1';
  $('voice-tiles').checked = !state.voiceTiles;
  localStorage.removeItem('rooms.voicetiles');

  // The module is warming before the first click, so a failure is visible in
  // the lobby and the join is only a microphone prompt.
  preloadSealed();
}

// wireJoinCard the join card and the chat form, with the file button and the drop zone.
function wireJoinCard() {
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
    const box = $('room');
    // Nothing typed: the suggested id is used.
    const room = normalizeRoom(box.value) || newRoomID();
    if (!ROOM_RE.test(room)) {
      say('room names use a-z 0-9 . _ - (1 to 64 characters)');
      return;
    }
    box.value = room;
    enterRoom(room, $('pass').value || '');
  });

  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendSealedChat();
  });

  // A file goes into the chat either way: the button opens the picker and a
  // drop on the chat panel does the same without the picker.
  const input = $('file-input');
  $('file-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const list = Array.from(input.files || []);
    input.value = '';
    for (const file of list) fileOffer(file);
  });
  const panel = $('chat-panel');
  panel.addEventListener('dragover', (event) => {
    event.preventDefault();
    panel.classList.add('drop');
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
  panel.addEventListener('drop', (event) => {
    const drop = event as DragEvent;
    drop.preventDefault();
    panel.classList.remove('drop');
    for (const file of drop.dataTransfer?.files || []) fileOffer(file);
  });
}

// wireSwitches the switches under the form that keep their choice.
function wireSwitches() {
  const noise = $('noise-live');
  noise.addEventListener('change', async () => {
    const on = noise.checked;
    state.noiseWanted = on;
    store('noise', on ? 1 : 0);
    $('noise').checked = on;
    const applied = await setNoise(on);
    if (applied !== on) say('noise suppression is not available');
    updateButtons();
  });

  const mirror = $('mirror');
  mirror.addEventListener('change', () => {
    state.mirror = mirror.checked;
    applyMirror();
  });

  // A frozen camera keeps sending the frame it held.
  const freeze = $('freeze');
  freeze.addEventListener('change', async () => {
    const ok = await setFreeze(freeze.checked);
    if (!ok) freeze.checked = !!state.freeze;
  });

  // The own picture leaves the large area and becomes a small preview in the
  // corner of the stage. The choice is kept, like the other switches.
  const pip = $('pip');
  pip.addEventListener('change', () => {
    state.selfPip = pip.checked;
    store('selfpip', state.selfPip ? 1 : 0);
    layoutStage();
  });

  // A guest without a camera can put its own tile away and leave only the rail
  // row. The choice is kept, like the other switches.
  const voice = $('voice-tiles');
  voice.addEventListener('change', () => {
    const hide = voice.checked;
    state.voiceTiles = !hide;
    store('hidevoicetiles', hide ? 1 : 0);
    layoutStage();
  });
}

// wirePanels the panels, the pickers, the menu bar and the gate button.
function wirePanels() {
  initLobbyWindow();
  initAsr();
  lookInit();

  // One stored value per guest, written by both sliders. A step that the
  // camera refuses leaves the old size in effect and says so.
  for (const id of ['perf', 'perf-live']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', async () => {
      const n = parseInt((el as HTMLInputElement).value, 10);
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
  const soundBox = $('sounds');
  if (soundBox) {
    soundBox.addEventListener('change', () => {
      const on = (soundBox as HTMLInputElement).checked;
      store('sounds', on ? 1 : 0);
      setSounds(on);
    });
  }

  // The stats setting reads its rates in bytes. One stored choice for the
  // guest, and an open panel redraws at once instead of waiting for a tick.
  state.statsBytes = load('statsbytes') === '1';
  const bytesBox = $('stats-bytes');
  if (bytesBox) {
    bytesBox.checked = state.statsBytes;
    bytesBox.addEventListener('change', () => {
      state.statsBytes = bytesBox.checked;
      store('statsbytes', state.statsBytes ? 1 : 0);
      if (statsOpen()) updateStats();
    });
  }

  // The waiting room switch is for the admin; the commit is sealed, so no page
  // obeys a sender that holds no role and the server sees nothing. The box
  // follows the room, so it goes back if another admin changed it first.
  const waitBox = $('waiting-room');
  if (waitBox) {
    waitBox.addEventListener('change', () => {
      setWaitingRoom((waitBox as HTMLInputElement).checked);
    });
  }

  wireMenuBar();
  wirePipDrag();
  wireSubmenus();
  // The room passphrase can be set or changed during the call. The new value
  // goes sealed to every pair, and a guest that joins later must know it.
  const gateBtn = document.getElementById('gate-pick');
  if (gateBtn) {
    gateBtn.addEventListener('click', () => {
      if (!isAdmin(state.self) || state.waiting) return;
      const next = window.prompt('room passphrase (leave empty for an open room)', '');
      if (next === null) return;
      setGate(next.trim().slice(0, 256));
    });
  }
  // The name can change after the join: the new one is kept and goes sealed to
  // every pair that already proved its keys.
  const renameBtn = document.getElementById('rename-pick');
  if (renameBtn) {
    renameBtn.addEventListener('click', () => {
      const next = window.prompt('your name in this room', state.name || '');
      if (next === null) return;
      renameSelf(next);
    });
  }
  paintGate();
  $('stats-btn').addEventListener('click', () => setStatsOpen(!statsOpen()));
  $('stats-close').addEventListener('click', () => setStatsOpen(false));
}

// wireStage the stage: spotlight, the phone chrome, the rail list and the key handler.
function wireStage() {
  // A click on a tile is a spotlight: that guest takes the large area and the
  // others become rail rows. The same click, a click on the empty stage or Esc
  // gives the normal layout back, and a click on a control stays with it.
  // A touch screen has no hover, so the first tap opens the controls and a
  // second tap, or the enlarge button, enlarges. Controls close after 5 s.
  const touch = window.matchMedia ? window.matchMedia('(hover: none)') : { matches: false };
  $('grid').addEventListener('click', (event) => {
    // The click that ends a drag of the small tile is not a zoom.
    if (Date.now() - cornerDropAt < 300) return;
    const target = event.target as Element;
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
    // Two pictures and no spotlight: a click on either tile trades the small
    // own preview for the two pictures side by side, and the other way back.
    // It is the same switch as the menu item, so one state feeds both.
    if (pairStage()) {
      state.selfPip = !state.selfPip;
      store('selfpip', state.selfPip ? 1 : 0);
      updateButtons();
      layoutStage();
      return;
    }
    const el = tile as HTMLElement;
    const id = tileId(el);
    if (!id) return;
    if (
      touch.matches &&
      !target.closest('.zoom') &&
      el.parentElement === $('stage-main') &&
      !el.classList.contains('ctl')
    ) {
      for (const open of document.querySelectorAll('.tile.ctl')) open.classList.remove('ctl');
      el.classList.add('ctl');
      clearTimeout((el as any).ctlTimer);
      (el as any).ctlTimer = setTimeout(() => el.classList.remove('ctl'), 5000);
      return;
    }
    setSpotlight(id);
  });
  // A tap on the picture folds the app frame away on a phone and the next tap
  // brings it back; a tap on the frame itself never folds it, or no button of
  // the frame could be used while it is open. A desktop has no immersive class.
  $('stage').addEventListener('click', (event) => {
    if (Date.now() - cornerDropAt < 300) return;
    if (!$('stage').classList.contains('immersive')) return;
    const target = event.target as Element;
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
      const target = event.target as Element;
      if (target.closest('.vol-range, .vol-num, .dots, .menu, .sas, .admit')) return;
      const row = target.closest('.plist-row');
      if (!row) return;
      const id = tileId(row as HTMLElement);
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
}

// wireCallBar the buttons of the call toolbar.
function wireCallBar() {
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
      setTimeout(() => {
        $('copy-btn').textContent = 'copy link';
      }, 1500);
    } catch {
      window.prompt('copy this link', link);
    }
  });

  // The form shows a picker before the first permission: the labels are hidden,
  // so the options are numbered until a request has succeeded once.
  refreshDevices();
}

function init() {
  restorePrefs();
  wireJoinCard();
  wireSwitches();
  wirePanels();
  wireStage();
  wireCallBar();

  // The form shows a picker before the first permission: the labels are hidden,
  // so the options are numbered until a request has succeeded once.
  refreshDevices();
}

init();

// The bundle closes over its top level names, and the browser tests read a few
// of them from the page, so the same names are put back here. The page itself
// never reads them.
Object.assign(globalThis, {
  state,
  disableCam,
  enableMic,
  disableMic,
  startLost,
  stopLost,
  leave,
});
