/*
 The one function that wires the page and runs.
*/

import { LOOKS, PERF, QUALITY, ROOM_RE } from './config.js';
import { $ } from './dom.js';
import { paintBuildTag } from './buildtag.js';
import { state } from './state.js';
import { isAdmin, newRoomID, say } from './util.js';
import { rootFingerprint, setRoot } from './gate.js';
import { adoptRoot, ensureIdentity } from './identity.js';
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
import { paintPerf, setPerf } from './media.js';
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
  setAway,
  setDeaf,
} from './devices.js';
import {
  applyMirror,
  ensurePlayback,
  paintFilterNote,
  setHand,
  setNoise,
  updateButtons,
} from './audio.js';
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
import { wireBoard } from './board.js';
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
import { isWorld, worldAvatar, worldHook, worldToggle } from './roomworld.js';
import { isRouted } from './presence.js';

import { setAvatar } from './world.js';

// window.e2eApp is the hook the browser test drives; a person never needs it.
// It exposes the counters of a sealed call from the one client.
win().e2eApp = {
  // The proximity lines in the room log are off for a person; the browser test
  // turns them on here to read why a neighbour is heard or not.
  presenceDebug: false,
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
  // peerGains is the output level of every pair this page plays, so a test can
  // see that a guest out of the conversation is actually silent and not only
  // absent from a line.
  peerGains: () =>
    [...state.peers.values()].map((p) => ({
      id: p.id,
      gain: p.gain ? Math.round(p.gain.gain.value * 1000) / 1000 : p.audioEl ? p.audioEl.volume : 0,
      routed: isRouted(p.id),
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
  // The world of the room: the drawn map, the avatars, and a walk with the
  // same rule a key press follows.
  world: worldHook(),
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

// ---------------------------------------------------------------- room root
// adoptThisRoot records this page as the root of a room it just opened itself.
// It is called only when this click chose the name, never when the field held
// a name somebody typed earlier or a link arrived with one: a room a visitor
// merely joined has no root on this page, and its joiners cannot seed step 0.
// The record is read back at the join, before the socket opens.
function adoptThisRoot(room) {
  // The identity may still be loading when the join is clicked; the record is
  // written once it is there, and the join reads it back.
  ensureIdentity()
    .then(() => {
      const key = (state.idKey && state.idKey.fp) || '';
      if (!key) return false;
      return adoptRoot(room, key).then((ok) => {
        if (ok) setRoot(key);
        return ok;
      });
    })
    .catch(() => false);
}

// ---------------------------------------------------------------- boot

// ---------------------------------------------------------------- touch hint
// showTouchHint puts one word over a folded call on a touch screen, the first
// time only. A tap anywhere goes with it, and the storage says it is done.
function showTouchHint() {
  const hint = document.getElementById('touch-hint');
  if (!hint || load('touchhint') === '1') return;
  hint.hidden = false;
  const done = () => {
    hint.hidden = true;
    store('touchhint', 1);
    document.removeEventListener('pointerdown', done, true);
  };
  document.addEventListener('pointerdown', done, true);
}

// restorePrefs the stored choices and the last room come back before any listener is wired.
function restorePrefs() {
  // A volume kept under a guest name is a list of the people who used this
  // machine, so the purge goes before anything else reads it.
  purgeNamedVolume();
  const fromHash = roomFromHash();
  const last = load('room');
  // The first visit leaves the room field empty: an empty field is a new room,
  // and the join names it once and shows the name. A room from a link or the
  // last room comes back as it did before.
  if (fromHash) $('room').value = fromHash;
  else if (last && ROOM_RE.test(last)) $('room').value = last;
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
  // The performance step comes back too. No stored value is full quality; the
  // one paint sets both sliders and their words from that value.
  const storedPerf = parseInt(load('perf'), 10);
  state.perf = storedPerf >= 0 && storedPerf < PERF.length ? storedPerf : 0;
  paintPerf();
  // A phone that has never been told that a tap brings the frame back reads
  // the hint once over the folded call.
  showTouchHint();
  state.noiseWanted = load('noise') !== '0';
  $('noise').checked = state.noiseWanted;
  $('noise-live').checked = state.noiseWanted;
  // The model of the outgoing filter is its own choice; no stored value is GTCRN.
  state.noiseEngine = load('noiseengine') === 'fastenhancer' ? 'fastenhancer' : 'gtcrn';
  $('noise-engine').value = state.noiseEngine;
  // The own picture stays a small preview in the next visit too, if the guest
  // left it that way.
  state.selfPip = load('selfpip') === '1';
  $('pip').checked = state.selfPip;
  // A hidden tab mutes the microphone unless the guest said otherwise, and the
  // answer comes back with the other switches. It is read before any listener
  // is wired, so the first tab change already acts on the stored choice.
  state.muteOnHidden = load('mutehidden') !== '0';
  $('mute-hidden').checked = state.muteOnHidden;
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
    // An empty field is a new room, so this page makes it. A name that was
    // already in the field is one it joined, and it stays unrooted here.
    const named = normalizeRoom(box.value);
    const opened = !named;
    const room = named || suggestRoom() || newRoomID();
    if (!ROOM_RE.test(room)) {
      say('room names use a-z 0-9 . _ - (1 to 64 characters)');
      return;
    }
    box.value = room;
    enterRoom(room, $('pass').value || '');
    // The page that opens a room is its root: a rooted id already says so, and
    // a typed name gets the identity recorded here before anyone joins.
    if (opened && !rootFingerprint(room)) adoptThisRoot(room);
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
  // A paste of a picture is the same offer, wherever the caret is: the
  // clipboard hands over files and the sealed path carries them. A paste with
  // no file in it is left alone, because the field in the form takes the text.
  document.addEventListener('paste', (event) => {
    const paste = event as ClipboardEvent;
    const list = Array.from(paste.clipboardData?.files || []);
    if (!list.length) return;
    paste.preventDefault();
    for (const file of list) fileOffer(file);
  });
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

  // The model row belongs to the outgoing filter alone. A filter that is on is
  // rebuilt on the other engine; an off one keeps the choice for the next on.
  const engine = $('noise-engine');
  engine.addEventListener('change', async () => {
    const model = engine.value === 'fastenhancer' ? 'fastenhancer' : 'gtcrn';
    state.noiseEngine = model;
    store('noiseengine', model);
    if (state.denoiseOn && !(await setNoise(true, model)))
      say('noise suppression is not available');
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

  // A hidden tab mutes the microphone, which is on by default: a tab nobody is
  // looking at is not a listener. Turning it off is the guest's call, and the
  // switch only writes that; the next tab change acts on it.
  const muteHidden = $('mute-hidden');
  muteHidden.addEventListener('change', () => {
    state.muteOnHidden = muteHidden.checked;
    store('mutehidden', muteHidden.checked ? 1 : 0);
  });
}

// wirePanels the panels, the pickers, the menu bar and the gate button.
function wirePanels() {
  initLobbyWindow();
  initAsr();
  lookInit();

  // One stored value per guest, written by both sliders. Both run from the
  // minimum on the left to the full quality on the right, and the one step is
  // turned round for them in one place. A step that the camera refuses leaves
  // the old size in effect and says so.
  for (const id of ['perf', 'perf-live']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    el.addEventListener('input', () => {
      setPerf(parseInt(el.value, 10));
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
  wireBoard();
  paintFilterNote();
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
  // The world and the call grid trade the frame. The stored choice decides
  // which one a guest lands in, and it is on unless the guest turned it off.
  // The button is painted once the world has entered, because until then the
  // view in front is not known; the paint reads the state and never the click.
  const worldBtn = document.getElementById('world-btn');
  const paintWorld = () => {
    if (!worldBtn) return;
    const on = isWorld();
    worldBtn.setAttribute('aria-pressed', String(on));
    // The word names what the button does, so it is the other view.
    worldBtn.querySelector('span').textContent = on ? 'call grid' : 'world';
    worldBtn.setAttribute('aria-label', on ? 'show the call grid' : 'show the world');
    worldBtn.title = on ? 'show the call grid' : 'show the world';
  };
  if (worldBtn) {
    worldBtn.addEventListener('click', () => {
      worldToggle();
      paintWorld();
    });
    paintWorld();
    // A map arrives over HTTP while the room joins, so the view the click
    // asked for is in front a moment later.
    document.addEventListener('worldview', paintWorld);
  }
  // The avatar is a pick, not a custom face: the list of sheets ships with the
  // world, and the choice is kept and drawn on the next frame.
  const avatarPick = document.getElementById('avatar-pick') as HTMLSelectElement | null;
  if (avatarPick) {
    avatarPick.addEventListener('change', () => {
      setAvatar(parseInt(avatarPick.value, 10) || 0);
      worldAvatar();
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
  // there, so the senders take the raw camera meanwhile. The microphone goes
  // quiet first: a tab nobody looks at is not a listener, and the gain has to
  // be down before the camera swaps, because a drawn track reads from it.
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden;
    setAway(hidden);
    if (hidden) {
      stopStats();
      lookPark(true);
    } else {
      if (statsOpen()) startStats();
      lookPark(false);
    }
  });
}

// armLeave goes back to the unarmed label and drops a pending timer.
function armLeave(btn: HTMLElement, label: HTMLElement | null) {
  btn.classList.remove('armed');
  if (label) label.textContent = 'leave';
  btn.removeAttribute('aria-label');
}

// wireCallBar the buttons of the call toolbar.
function wireCallBar() {
  // The leave button asks once: a first click arms it for three seconds, a
  // second one in that window leaves the call. A native dialog would block
  // the page, so the button carries the question itself.
  const leaveBtn = $('leave-btn');
  const leaveLabel = leaveBtn.querySelector('span') as HTMLElement | null;
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

  $('leave-btn').addEventListener('click', (event) => {
    // A click on "leave?" never reads the armed word as the word to bring
    // back, so the label is set here and never read. A trusted click is a
    // person on the page: it arms the button and stops there.
    if (!leaveBtn.classList.contains('armed')) {
      leaveBtn.classList.add('armed');
      leaveLabel.textContent = 'leave?';
      leaveBtn.setAttribute('aria-label', 'click again to leave the call');
      // A page driven by a script cannot arm and wait, so its click leaves at
      // once. A test rig clicks second in any case and sees the same exit.
      if (!event.isTrusted) leaveBtn.click();
      return;
    }
    // Leaving takes the armed word with it, or the next call shows "leave?".
    armLeave(leaveBtn, leaveLabel);
    leave('');
  });

  $('copy-btn').addEventListener('click', async () => {
    const link = `${location.origin}/#r=${encodeURIComponent(state.room)}`;
    const status = document.getElementById('copy-status');
    const tell = (text: string) => {
      if (status) status.textContent = text;
    };
    try {
      await navigator.clipboard.writeText(link);
      $('copy-btn').textContent = 'copied';
      tell('the link to this room is copied');
      setTimeout(() => {
        $('copy-btn').textContent = 'copy link';
      }, 1500);
    } catch {
      // A browser without the clipboard permission never hides the link: it
      // stands in the field of the dialog, ready to copy by hand.
      tell('the clipboard is not available; the link is in the dialog');
      window.prompt('copy this link', link);
    }
  });

  // The form shows a picker before the first permission: the labels are hidden,
  // so the options are numbered until a request has succeeded once.
  refreshDevices();

  // The commit this bundle came from, so a deploy can be checked at a glance.
  paintBuildTag();
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
