(() => {
  // src/config.ts
  var ROOM_RE = /^[a-z0-9._-]{1,64}$/;
  var B32 = "abcdefghijklmnopqrstuvwxyz234567";
  var PERF = [
    { name: "full quality", scale: 1, fps: 0, bits: 1 },
    { name: "balanced", scale: 0.75, fps: 24, bits: 0.6 },
    { name: "light", scale: 0.5, fps: 20, bits: 0.35 },
    { name: "minimum", scale: 0.35, fps: 15, bits: 0.18 }
  ];
  var QUALITY = {
    "640x360@30": { w: 640, h: 360, fps: 30, max: 4e5 },
    "1280x720@30": { w: 1280, h: 720, fps: 30, max: 15e5 },
    "1920x1080@30": { w: 1920, h: 1080, fps: 30, max: 3e6 },
    "1920x1080@60": { w: 1920, h: 1080, fps: 60, max: 5e6 },
    "2560x1440@30": { w: 2560, h: 1440, fps: 30, max: 6e6 }
  };
  var LOOKS = {
    none: "",
    soft: "brightness(1.05) contrast(0.97) saturate(1.03) blur(0.5px)",
    warm: "saturate(1.15) sepia(0.18) brightness(1.04)",
    cool: "saturate(1.06) hue-rotate(-10deg) brightness(1.02)",
    mono: "grayscale(1) contrast(1.06)",
    sepia: "sepia(0.85) contrast(1.04)",
    vivid: "saturate(1.4) contrast(1.08)"
  };
  var MASKS = [
    "none",
    "big",
    "wide",
    "small",
    "glasses",
    "moustache",
    "cat",
    "dog",
    "halo",
    "shades",
    "miku",
    "fawkes",
    "potion",
    "custom"
  ];
  var MESH_DIR = "/facemesh/";
  var MESH_W = 256;
  var MESH_HZ_MIN = 5;
  var MESH_HZ_MAX = 60;
  var LOOK_MAX = 1280;

  // src/dom.ts
  function $(id) {
    return document.getElementById(id);
  }

  // src/state.ts
  var CUST_DEFAULTS = {
    head: 100,
    width: 100,
    eyes: 100,
    spread: 100,
    eyey: 0,
    nose: 100,
    mouth: 100,
    mshift: 0,
    pinch: 0,
    swap: false
  };
  var state = {
    ws: null,
    self: null,
    room: "",
    name: "",
    ice: [],
    peers: /* @__PURE__ */ new Map(),
    admins: /* @__PURE__ */ new Set(),
    // the role list of the sealed claim; empty until one arrives
    camTrack: null,
    freeze: false,
    // the outgoing camera picture is locked to one frame
    freezeTrack: null,
    // the still that carries that frame
    freezeCanvas: null,
    // the canvas behind the still, kept so it stays live
    freezeSource: null,
    // a copy of the frozen picture, drawn into the canvas again
    freezeTimer: null,
    // redraws the frozen canvas so late peers get a frame
    freezeVideo: null,
    // hidden video on the camera, used when no look draws a frame
    micTrack: null,
    outStream: null,
    // what is sent to peers
    lookParked: false,
    // true while a hidden tab sends the raw camera
    // Face effect knobs, each a percent of a face measure, so they hold near and far from the camera.
    cust: { ...CUST_DEFAULTS },
    audioCtx: null,
    // the microphone graph
    mixer: null,
    micGain: null,
    micSource: null,
    micAnalyser: null,
    // tap on the microphone input, for the stats level
    meterPeak: 0,
    // decaying peak, so one tick per second can see a word
    denoise: null,
    denoiseFeId: 0,
    // worker lane of the microphone filter when FastEnhancer owns it
    denoiseOn: false,
    noiseWasm: null,
    // one fetch of the noise model, shared by every node
    feWorker: null,
    // the worker that holds FastEnhancer, shared by every stream
    feSeq: 0,
    // lane ids of the streams that attach to that worker
    playCtx: null,
    // the remote audio graph, so a peer can go over 100%
    screen: null,
    // display stream while sharing
    screenSource: null,
    screenTile: null,
    // own screen tile while sharing
    mic: false,
    // live in this call, and the stored choice
    cam: false,
    deaf: false,
    // this browser plays no sound and sends no microphone
    micBeforeDeaf: false,
    // the microphone state to restore when deaf mode ends
    camBeforeDeaf: false,
    // the camera state to restore when deaf mode ends
    camId: "",
    // deviceId of the chosen camera, '' = the system device
    micId: "",
    // the same for the microphone
    devCams: [],
    // last enumerateDevices() video inputs
    devMics: [],
    // last enumerateDevices() audio inputs
    path: "auto",
    quality: "1280x720@30",
    shareQuality: "1920x1080@30",
    // the screen has its own quality step
    perf: 0,
    // performance step, 0 = full quality (the default)
    sounds: true,
    // the four cues and the lost connection chime
    statsBytes: false,
    // the stats panel reads its rates in kibibytes and mebibytes
    waitingRoom: false,
    // the room switch an admin sets
    waiting: false,
    // this guest is held outside until a member lets it in
    hand: false,
    // this guest has a raised hand
    handTs: 0,
    // when it went up, so every guest orders the queue the same
    insideFps: /* @__PURE__ */ new Set(),
    // fingerprints of proven guests seen inside this call, for a quick return
    mirror: true,
    selfPip: false,
    // the own picture is a small preview, not a tile in the grid
    voiceTiles: true,
    // a guest without a camera also gets a tile in the large area
    look: "none",
    // the look of the own camera, drawn in this tab
    masks: [],
    // masks drawn on the face, any number at once
    lookPipe: null,
    // the canvas pipeline while a look or a mask is on
    lookOut: null,
    // the canvas video track that peers receive
    lookSrc: null,
    // the camera track the running pipeline was built from
    lookGrace: 0,
    // when the kept look pipeline goes off, 0 = no grace running
    lookGraceMs: 12e4,
    // how long that grace lasts, for a test to shorten
    lookSwaps: 0,
    // sender track swaps made by lookPublish, for a test
    lookTimer: null,
    // the timer that ends that grace
    noiseWanted: true,
    leaving: false,
    reconnectTimer: null,
    reconnectDelay: 500,
    fatal: "",
    statsTimer: null,
    statsBusy: false,
    notice: "",
    // the text on the status line now, so a later step can tell whose it is
    statHist: [],
    // one sample a second, for the graph in the stats panel
    callStart: 0,
    // ms at the join, for the header timer
    callTimer: null,
    sfxCtx: null,
    sfxSource: null,
    lostSource: null,
    // the loop that plays while the socket is down
    lostGain: null,
    lostWanted: false,
    speakTimer: null,
    // the green light on each tile while a person talks
    ownSpoke: null,
    spotlight: "",
    // peer id or 'self' while one guest holds the large area
    // Sealed state for one join: the worker, the identity and the counters die with it.
    wasmOk: false,
    // /pq.wasm loaded and the self test passed once
    wasmTest: null,
    // the result of that self test, for the stats panel
    identity: null,
    // our per-call key bundle, wiped in leave
    idKey: null,
    // our long-term Ed25519 identity, kept when the browser allows it
    device: "",
    // kept, fresh (stored record would not reopen) or session (nothing kept)
    sid: "",
    // session id of this call, public, never a secret
    w: "",
    // SPAKE2 scalar of the room passphrase, never sent
    gate: { v: null, n: 0 },
    // the room passphrase the members hold now, with a counter
    auth: { n: -1, admins: [], by: "", sig: "" },
    // the signed role claim this page holds
    authTimer: null,
    // the one timer that gives a room with no member a first admin
    wait: { on: false, n: 0 },
    // the sealed waiting-room switch, with a counter
    kickedFps: /* @__PURE__ */ new Set(),
    // identities this page removed for good in this call
    pins: /* @__PURE__ */ new Map(),
    // local label -> {label, fp, first, last}
    revoked: /* @__PURE__ */ new Map(),
    // fingerprint -> {fp, label, at}, a pin that was replaced
    identityFailures: 0,
    // a peer that sent no identity or could not prove one
    worker: null,
    // /e2e-transform.js, one per sealed call
    keyWait: /* @__PURE__ */ new Map(),
    // pair -> {gen, resolve}, waiting for the worker to import keys
    keyGen: 0,
    // one rising number for every key agreement on the page
    frames: {},
    // pair|dir|kind -> last counter message of the worker
    encryptFrames: 0,
    decryptFrames: 0,
    chatSent: 0,
    chatRecv: 0,
    replayDrops: 0,
    // a sealed app or file frame out of order or replayed
    fileOffers: 0,
    // file offers this guest sent
    fileRecv: 0,
    // file offers this guest received and saved
    fileChunksSent: 0,
    // sealed chunks that went over a data channel
    fileChunksRecv: 0,
    fileRefused: 0,
    fileCancelled: 0,
    files: /* @__PURE__ */ new Map(),
    // transfer id -> offer this guest sent
    filesIn: /* @__PURE__ */ new Map(),
    // peer id and transfer id -> offer this guest received
    fileLinks: /* @__PURE__ */ new Set(),
    // blob urls handed to the guest, revoked on leave
    confirmFailures: 0,
    workerErrors: [],
    // a red row in the stats panel
    sealFault: "",
    // why this browser can not seal media
    wireFrames: 0,
    // signaling frames inspected by the audit
    wireLeaks: [],
    // a canary that appeared on the wire, must stay empty
    clearSignaling: 0,
    // frames that still carried a clear sdp or candidate
    canaries: /* @__PURE__ */ new Set(),
    // the passphrase, names, chat lines and file names that must never leak
    samples: []
    // a few frame samples, for the in-page lab proof
  };

  // src/util.ts
  function newRoomID() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let bits = 0;
    let value = 0;
    let out = "";
    for (const b of bytes) {
      value = value << 8 | b;
      bits += 8;
      while (bits >= 5) {
        out += B32[value >>> bits - 5 & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += B32[value << 5 - bits & 31];
    return out;
  }
  function say(text) {
    const box = state.room ? $("stage-error") : $("lobby-error");
    state.notice = text;
    box.textContent = text;
    box.hidden = !text;
  }
  function isAdmin(id) {
    return !!(id && state.admins && state.admins.has(id));
  }
  function setAdmins(list) {
    if (!(state.admins instanceof Set)) state.admins = /* @__PURE__ */ new Set();
    state.admins.clear();
    for (const id of list || []) state.admins.add(id);
  }
  function detachMedia(media) {
    try {
      media.pause();
    } catch {
    }
    media.srcObject = null;
  }
  function clamp(n, lo, hi) {
    return Math.min(Math.max(n, lo), hi);
  }
  function stopQuietly(node) {
    try {
      node.stop();
    } catch {
    }
  }
  function disconnectQuietly(node) {
    try {
      node.disconnect();
    } catch {
    }
  }
  function stopTracks(stream) {
    for (const track of stream.getTracks()) stopQuietly(track);
  }
  function joinWords(list) {
    if (list.length <= 1) return list[0] || "";
    return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  }

  // src/prefs.ts
  function store(key, value) {
    if (!window.localStorage) return;
    try {
      localStorage.setItem("rooms." + key, String(value));
    } catch {
    }
  }
  function load(key) {
    if (!window.localStorage) return "";
    try {
      return localStorage.getItem("rooms." + key) || "";
    } catch {
      return "";
    }
  }

  // src/audit.ts
  function canary(value) {
    const s = String(value || "");
    if (s.length >= 4) state.canaries.add(s);
  }
  function auditWire(where, raw) {
    const text = typeof raw === "string" ? raw : String(raw);
    state.wireFrames++;
    for (const c of state.canaries) {
      if (text.includes(c) && state.wireLeaks.length < 20) {
        state.wireLeaks.push({ where, canary: c });
      }
    }
    if (/"sdp"|"candidate"|v=0|a=fingerprint/.test(text)) state.clearSignaling++;
  }

  // src/menu.ts
  var MENUS = [
    ["menu-settings-btn", "menu-settings"],
    ["menu-effects-btn", "menu-effects"],
    ["menu-asr-btn", "menu-asr"],
    ["menu-devices-btn", "menu-devices"]
  ];
  function fitMenu(list) {
    if (!(list instanceof HTMLElement)) return;
    const room = document.documentElement.clientWidth;
    list.style.left = "";
    const box = list.getBoundingClientRect();
    let shift = 0;
    if (box.right > room - 2) shift = room - 2 - box.right;
    if (box.left + shift < 2) shift = 2 - box.left;
    if (shift) list.style.left = Math.round(shift) + "px";
  }
  function menuSet(open, which = null) {
    for (const [btnId, listId] of MENUS) {
      const btn = $(btnId);
      const list = $(listId);
      if (!btn || !list) continue;
      const on = open && (!which || which === listId);
      const was = !list.hidden;
      list.hidden = !on;
      if (!on) closeSubmenus(list);
      btn.setAttribute("aria-expanded", String(on));
      if (on && !was) {
        fitMenu(list);
        const first = list.querySelector(
          'input[type="checkbox"], select, .menu-choice, .menu-sub'
        );
        if (first) first.focus();
      }
    }
  }
  function menuClose() {
    let any = false;
    for (const [, listId] of MENUS) {
      const list = $(listId);
      if (list && !list.hidden) any = true;
    }
    if (any) menuSet(false);
    return any;
  }
  function closeSubmenus(panel) {
    if (!panel) return;
    for (const sub of Array.from(panel.querySelectorAll(".menu-sub-list"))) {
      if (sub instanceof HTMLElement) sub.hidden = true;
    }
    for (const btn of Array.from(panel.querySelectorAll(".menu-sub")))
      btn.setAttribute("aria-expanded", "false");
  }
  function wireSubmenus() {
    for (const wrap of Array.from(document.querySelectorAll(".menu-subwrap"))) {
      const btn = wrap.querySelector(".menu-sub");
      const list = wrap.querySelector(".menu-sub-list");
      if (!btn || !list) continue;
      const openSub = (on) => {
        list.hidden = !on;
        btn.setAttribute("aria-expanded", String(on));
        if (!on) return;
        for (const other of Array.from(document.querySelectorAll(".menu-subwrap"))) {
          if (other === wrap) continue;
          const otherList = other.querySelector(".menu-sub-list");
          const otherBtn = other.querySelector(".menu-sub");
          if (otherList) otherList.hidden = true;
          if (otherBtn) otherBtn.setAttribute("aria-expanded", "false");
        }
      };
      wrap.addEventListener("mouseenter", () => openSub(true));
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        openSub(!list.hidden);
      });
      btn.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openSub(true);
        const first = list.querySelector(".menu-choice");
        if (first) first.focus();
      });
      list.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        openSub(false);
        btn.focus();
      });
    }
  }
  function wireMenuBar() {
    for (const [btnId, listId] of MENUS) {
      const btn = $(btnId);
      const list = $(listId);
      if (!btn || !list) continue;
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        menuSet(list.hidden, listId);
      });
      list.addEventListener("click", (event) => event.stopPropagation());
      list.addEventListener("keydown", (event) => {
        const rows = Array.from(
          list.querySelectorAll('input[type="checkbox"], select, .menu-choice, .menu-sub')
        ).filter((el2) => !el2.hidden);
        const at = rows.indexOf(document.activeElement);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          menuSet(false);
          btn.focus();
          return;
        }
        if (event.key === "Tab") {
          menuSet(false);
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = rows[(at + step + rows.length) % rows.length];
        if (next) next.focus();
      });
    }
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest("#menubar")) return;
      menuSet(false);
    });
  }
  function suggestRoom() {
    $("room").value = newRoomID();
  }
  function normalizeRoom(raw) {
    let text = String(raw || "").trim();
    const hash = text.match(/#r=([^&\s"'<>]+)/);
    if (hash) text = hash[1];
    try {
      text = decodeURIComponent(text);
    } catch {
    }
    return text.trim().toLowerCase();
  }
  function roomFromHash() {
    const raw = location.hash.replace(/^#/, "");
    const id = normalizeRoom(new URLSearchParams(raw).get("r") || "");
    return ROOM_RE.test(id) ? id : "";
  }
  function setHash(room) {
    history.replaceState(null, "", room ? `#r=${encodeURIComponent(room)}` : location.pathname);
  }
  function wsURL() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    return proto + location.host + "/ws";
  }
  function send(msg) {
    const raw = JSON.stringify(msg);
    auditWire("out", raw);
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(raw);
  }

  // src/trust.ts
  var factory = window.trustedTypes;
  var policy = factory ? factory.createPolicy("stanze", {
    createScriptURL(url) {
      let parsed;
      try {
        parsed = new URL(url, location.href);
      } catch {
        throw new TypeError("script url refused: " + url);
      }
      if (parsed.origin !== location.origin) throw new TypeError("script url refused: " + url);
      return url;
    }
  }) : null;
  function scriptURL(url) {
    return policy ? policy.createScriptURL(url) : url;
  }

  // src/look.ts
  function lookOn() {
    return state.look && state.look !== "none" || state.masks.length > 0;
  }
  function maskSet(value) {
    const names = Array.isArray(value) ? value : String(value || "").split(/[+,\s]+/);
    return MASKS.filter((m) => m !== "none" && names.includes(m));
  }
  function lookTrack() {
    if (state.lookParked) return null;
    return state.lookOut && state.lookOut.readyState === "live" ? state.lookOut : null;
  }
  var drawClockURLs = /* @__PURE__ */ new Map();
  function drawClockURL(fps) {
    const hz = clamp(Math.round(fps) || 30, MESH_HZ_MIN, MESH_HZ_MAX);
    if (!drawClockURLs.has(hz)) {
      drawClockURLs.set(
        hz,
        URL.createObjectURL(
          new Blob([`setInterval(() => postMessage(1), ${Math.round(1e3 / hz)});`], {
            type: "text/javascript"
          })
        )
      );
    }
    return drawClockURLs.get(hz);
  }
  var LM = {
    noseTip: 1,
    noseBase: 2,
    lipTop: 0,
    lip: 13,
    lipLow: 14,
    mouthL: 61,
    mouthR: 291,
    eyeOuterL: 33,
    eyeInnerL: 133,
    eyeOuterR: 263,
    eyeInnerR: 362,
    lidUpL: 159,
    lidLoL: 145,
    lidUpR: 386,
    lidLoR: 374,
    browL: 105,
    browR: 334,
    hairline: 10,
    chin: 152,
    cheekL: 234,
    cheekR: 454,
    templeL: 127,
    templeR: 356,
    earL: 93,
    earR: 323
  };
  var HAIRLINE = [127, 162, 21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 389, 356];
  var meshOpenTask = null;
  function meshOpen() {
    if (!meshOpenTask) {
      meshOpenTask = (async () => {
        const vision = await import(MESH_DIR + "vision_bundle.mjs");
        const files = await vision.FilesetResolver.forVisionTasks(MESH_DIR.slice(0, -1));
        return await vision.FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MESH_DIR + "face_landmarker.task", delegate: "CPU" },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false
        });
      })().catch(() => null);
    }
    return meshOpenTask;
  }
  async function lookStart() {
    if (!lookOn() || !state.camTrack) return;
    if (state.lookPipe) return;
    const src = state.camTrack;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([src]);
    video.className = "offstage";
    document.body.appendChild(video);
    try {
      await video.play();
    } catch {
    }
    const settings = src.getSettings ? src.getSettings() : {};
    const fps = clamp(Math.round(settings.frameRate) || 30, MESH_HZ_MIN, MESH_HZ_MAX);
    const scale = Math.min(1, LOOK_MAX / Math.max(settings.width || 1280, settings.height || 720));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round((settings.width || 1280) * scale));
    canvas.height = Math.max(2, Math.round((settings.height || 720) * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const stream = canvas.captureStream(fps);
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    track.contentHint = "motion";
    const sample = document.createElement("canvas");
    sample.width = 64;
    sample.height = 48;
    const sctx = sample.getContext("2d", { alpha: false, willReadFrequently: true });
    const meshCanvas = document.createElement("canvas");
    meshCanvas.width = MESH_W;
    meshCanvas.height = Math.min(
      320,
      Math.max(
        128,
        2 * Math.round(MESH_W * (settings.height || 720) / (settings.width || 1280) / 2)
      )
    );
    const meshCtx = meshCanvas.getContext("2d", { alpha: false });
    const pipe = {
      src,
      video,
      canvas,
      ctx,
      sample,
      sctx,
      meshCanvas,
      meshCtx,
      stream,
      track,
      fps,
      clock: null,
      clockURL: drawClockURL(fps),
      anchor: null,
      frame: 0,
      mesh: null,
      meshTried: false,
      meshBusy: false,
      meshLast: 0,
      wake: null,
      armApply: false
    };
    state.lookPipe = pipe;
    state.lookSrc = src;
    pipe.wake = () => {
      const playing = video.play();
      if (playing && playing.catch) playing.catch(() => {
      });
    };
    document.addEventListener("visibilitychange", () => pipe.wake && pipe.wake());
    state.lookOut = track;
    state.lookParked = !!document.hidden;
    pipe.armApply = false;
    if (!state.lookParked) {
      if (video.readyState >= 2 && video.videoWidth) lookDraw(pipe);
      else pipe.armApply = true;
    }
    await lookPublish(state.lookParked || pipe.armApply ? src : track);
    if (!state.lookParked) pipe.clock = lookClock(pipe);
  }
  function lookClock(p) {
    const clock = new Worker(scriptURL(p.clockURL || drawClockURL(p.fps)));
    clock.onmessage = () => {
      if (state.lookPipe === p) lookDraw(p);
    };
    return clock;
  }
  function lookDraw(p) {
    if (state.lookParked) return;
    if (p.video.readyState < 2 || !p.video.videoWidth) return;
    const filter = LOOKS[state.look] || "none";
    if (filter !== "none") p.ctx.filter = filter;
    p.ctx.drawImage(p.video, 0, 0, p.canvas.width, p.canvas.height);
    if (filter !== "none") p.ctx.filter = "none";
    if (!state.masks.length || !p.sctx) {
      armPublish(p);
      return;
    }
    p.frame++;
    lookMesh(p);
    if (p.frame % 2 === 1 && !(p.anchor && p.anchor.lm)) lookAnchor(p);
    const a = p.anchor || { x: 0.5, y: 0.42, w: 0.4, h: 0.42 };
    for (const which of state.masks) {
      if (which === "big") lookWarp(p, a, filter);
      else if (which === "wide") lookWide(p, a, filter);
      else if (which === "small") lookSmall(p, a, filter);
      else if (which === "potion") lookPotion(p, a);
      else if (which === "custom") lookCustom(p, a);
      else drawMask(p.ctx, p.canvas.width, p.canvas.height, which, a);
    }
    armPublish(p);
  }
  function armPublish(p) {
    if (!p.armApply) return;
    p.armApply = false;
    lookPublish(p.track);
  }
  var FRAME_MARK_FRESH_MS = 300;
  function frameMark(p) {
    const v = p.video;
    if (v.requestVideoFrameCallback) {
      if (!p.meshRVFC) {
        p.meshRVFC = true;
        const wait = () => v.requestVideoFrameCallback(() => {
          p.meshFrames = (p.meshFrames || 0) + 1;
          p.meshFrameAt = performance.now();
          if (p.meshRVFC && state.lookPipe === p) wait();
          else p.meshRVFC = false;
        });
        wait();
      }
      if (!p.meshFrameAt || performance.now() - p.meshFrameAt > FRAME_MARK_FRESH_MS) return void 0;
      return p.meshFrames;
    }
    const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
    return q ? q.totalVideoFrames : void 0;
  }
  function lookMesh(p) {
    if (!p.meshTried) {
      p.meshTried = true;
      meshOpen().then((fm) => {
        p.mesh = fm;
      });
    }
    if (!p.mesh || p.meshBusy || !p.meshCtx || document.hidden) return;
    const mark = frameMark(p);
    const quiet = !p.meshAt || performance.now() - p.meshAt > FRAME_MARK_FRESH_MS;
    if (mark !== void 0 && mark === p.meshMark && !quiet) return;
    p.meshMark = mark;
    const period = 1e3 / (p.fps || 30);
    const stride = quiet ? 1 : p.meshStride || 1;
    p.meshTick = (p.meshTick || 0) + 1;
    if ((p.meshTick - 1) % stride !== 0) return;
    meshSize(p);
    p.meshBusy = true;
    const t0 = performance.now();
    p.meshAt = t0;
    try {
      p.meshCtx.drawImage(p.video, 0, 0, p.meshCanvas.width, p.meshCanvas.height);
      const now = Math.round(performance.now());
      const last = p.meshLast || 0;
      p.meshLast = now > last ? now : last + 1;
      const res = p.mesh.detectForVideo(p.meshCanvas, p.meshLast);
      const lm = res && res.faceLandmarks && res.faceLandmarks[0];
      if (lm && lm.length) lookMeshAnchor(p, lm);
    } catch {
    } finally {
      p.meshBusy = false;
      const cost = performance.now() - t0;
      p.meshCost = p.meshCost ? p.meshCost * 0.75 + cost * 0.25 : cost;
      p.meshStride = p.meshCost > period * 0.9 ? 3 : p.meshCost > period * 0.55 ? 2 : 1;
    }
  }
  function meshSize(p) {
    const vw = p.video.videoWidth || 1280;
    const vh = p.video.videoHeight || 720;
    const k = MESH_W / Math.max(vw, vh);
    const w = Math.max(64, Math.round(vw * k));
    const h = Math.max(64, Math.round(vh * k));
    if (p.meshCanvas.width !== w || p.meshCanvas.height !== h) {
      p.meshCanvas.width = w;
      p.meshCanvas.height = h;
    }
  }
  var ONEEURO_MIN_HZ = 1;
  var ONEEURO_BETA = 30;
  var ONEEURO_D_HZ = 1;
  function oneEuroState() {
    return { x: new Float64Array(0), dx: new Float64Array(0), t: 0, on: false };
  }
  function oneEuroAlpha(hz, dt) {
    const tau = 1 / (2 * Math.PI * hz);
    return 1 / (1 + tau / dt);
  }
  function oneEuroRun(s, src, t) {
    const n = src.length;
    if (!s.on || s.x.length !== n) {
      s.x = Float64Array.from(src);
      s.dx = new Float64Array(n);
      s.t = t;
      s.on = true;
      return s.x;
    }
    let dt = (t - s.t) / 1e3;
    if (!(dt > 0)) dt = 1 / 30;
    if (dt > 0.5) dt = 0.5;
    s.t = t;
    const aD = oneEuroAlpha(ONEEURO_D_HZ, dt);
    for (let i = 0; i < n; i++) {
      const v = src[i];
      const d = (v - s.x[i]) / dt;
      s.dx[i] += aD * (d - s.dx[i]);
      const a = oneEuroAlpha(ONEEURO_MIN_HZ + ONEEURO_BETA * Math.abs(s.dx[i]), dt);
      s.x[i] += a * (v - s.x[i]);
    }
    return s.x;
  }
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
    const next = {
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2,
      w: x1 - x0,
      h: y1 - y0,
      lm: pts,
      tongue: 0,
      lid: 1,
      gaze: [0, 0, 0, 0],
      smile: 0
    };
    const faceH = Math.hypot(
      pts[LM.chin * 2] - pts[LM.hairline * 2],
      pts[LM.chin * 2 + 1] - pts[LM.hairline * 2 + 1]
    ) || 1;
    const lipGap = Math.hypot(
      pts[LM.lipLow * 2] - pts[LM.lip * 2],
      pts[LM.lipLow * 2 + 1] - pts[LM.lip * 2 + 1]
    );
    const mouthW = Math.hypot(
      pts[LM.mouthR * 2] - pts[LM.mouthL * 2],
      pts[LM.mouthR * 2 + 1] - pts[LM.mouthL * 2 + 1]
    ) || faceH * 0.35;
    next.tongue = clamp((lipGap / mouthW - 0.06) / 0.34, 0, 1);
    const lidL = Math.hypot(
      pts[LM.lidLoL * 2] - pts[LM.lidUpL * 2],
      pts[LM.lidLoL * 2 + 1] - pts[LM.lidUpL * 2 + 1]
    );
    const lidR = Math.hypot(
      pts[LM.lidLoR * 2] - pts[LM.lidUpR * 2],
      pts[LM.lidLoR * 2 + 1] - pts[LM.lidUpR * 2 + 1]
    );
    const eyeWL = Math.hypot(
      pts[LM.eyeOuterL * 2] - pts[LM.eyeInnerL * 2],
      pts[LM.eyeOuterL * 2 + 1] - pts[LM.eyeInnerL * 2 + 1]
    ) || faceH * 0.18;
    const eyeWR = Math.hypot(
      pts[LM.eyeOuterR * 2] - pts[LM.eyeInnerR * 2],
      pts[LM.eyeOuterR * 2 + 1] - pts[LM.eyeInnerR * 2 + 1]
    ) || faceH * 0.18;
    const openL = clamp((lidL / eyeWL - 0.05) / 0.2, 0, 1);
    const openR = clamp((lidR / eyeWR - 0.05) / 0.2, 0, 1);
    next.lid = Math.min(openL, openR);
    const gaze = [0, 0, 0, 0];
    if (pts.length >= 478 * 2) {
      const cL = [(pts[LM.eyeOuterL * 2] + pts[LM.eyeInnerL * 2]) / 2, (pts[LM.eyeOuterL * 2 + 1] + pts[LM.eyeInnerL * 2 + 1]) / 2];
      const cR = [(pts[LM.eyeOuterR * 2] + pts[LM.eyeInnerR * 2]) / 2, (pts[LM.eyeOuterR * 2 + 1] + pts[LM.eyeInnerR * 2 + 1]) / 2];
      const i0 = [pts[468 * 2], pts[468 * 2 + 1]];
      const i1 = [pts[473 * 2], pts[473 * 2 + 1]];
      const d0 = Math.hypot(i0[0] - cL[0], i0[1] - cL[1]) + Math.hypot(i1[0] - cR[0], i1[1] - cR[1]);
      const d1 = Math.hypot(i0[0] - cR[0], i0[1] - cR[1]) + Math.hypot(i1[0] - cL[0], i1[1] - cL[1]);
      const [li, ri, cLi, cRi, wLi, wRi] = d0 <= d1 ? [i0, i1, cL, cR, eyeWL, eyeWR] : [i1, i0, cR, cL, eyeWR, eyeWL];
      gaze[0] = clamp((li[0] - cLi[0]) / (wLi || faceH * 0.18), -0.4, 0.4);
      gaze[1] = clamp((li[1] - cLi[1]) / (wLi || faceH * 0.18), -0.35, 0.35);
      gaze[2] = clamp((ri[0] - cRi[0]) / (wRi || faceH * 0.18), -0.4, 0.4);
      gaze[3] = clamp((ri[1] - cRi[1]) / (wRi || faceH * 0.18), -0.35, 0.35);
    }
    next.gaze = gaze;
    next.smile = clamp((pts[LM.lip * 2 + 1] - (pts[LM.mouthL * 2 + 1] + pts[LM.mouthR * 2 + 1]) / 2) / mouthW * 1.6, -0.7, 0.7);
    const a = p.anchor;
    const t = performance.now();
    const sl = oneEuroRun(p.meshLm || (p.meshLm = oneEuroState()), pts, t);
    const box = oneEuroRun(
      p.meshBox || (p.meshBox = oneEuroState()),
      [next.x, next.y, next.w, next.h],
      t
    );
    if (!a || !a.lm || a.lm.length !== pts.length) {
      next.lm = Float32Array.from(sl);
      p.anchor = next;
      return;
    }
    a.x = box[0];
    a.y = box[1];
    a.w = box[2];
    a.h = box[3];
    a.tongue = Math.max(next.tongue, (a.tongue || 0) * 0.9);
    const lid = next.lid;
    if (a.lid == null) a.lid = lid;
    else a.lid += (lid - a.lid) * (lid < a.lid ? 0.6 : 0.3);
    if (!a.gaze) a.gaze = next.gaze.slice();
    else for (let i = 0; i < 4; i++) a.gaze[i] += (next.gaze[i] - a.gaze[i]) * 0.4;
    if (a.smile == null) a.smile = next.smile;
    else a.smile += (next.smile - a.smile) * 0.35;
    for (let i = 0; i < pts.length; i++) a.lm[i] = sl[i];
  }
  function lookAnchor(p) {
    try {
      p.sctx.drawImage(p.video, 0, 0, 64, 48);
    } catch {
      return;
    }
    let data;
    try {
      data = p.sctx.getImageData(0, 0, 64, 48).data;
    } catch {
      return;
    }
    let n = 0, sx = 0, sy = 0, x0 = 64, y0 = 48, x1 = 0, y1 = 0;
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 95 && g > 40 && b > 20 && r > b + 15 && r > g && g > b && Math.abs(r - g) > 15) {
          n++;
          sx += x;
          sy += y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (n < 50) return;
    const next = { x: sx / n / 64, y: sy / n / 48, w: (x1 - x0 + 1) / 64, h: (y1 - y0 + 1) / 48 };
    if (!p.anchor) {
      p.anchor = next;
      return;
    }
    const k = 0.25;
    p.anchor = {
      x: p.anchor.x + (next.x - p.anchor.x) * k,
      y: p.anchor.y + (next.y - p.anchor.y) * k,
      w: p.anchor.w + (next.w - p.anchor.w) * k,
      h: p.anchor.h + (next.h - p.anchor.h) * k
    };
  }
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
  function gap(p, q) {
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  }
  function unit(x, y) {
    const m = Math.hypot(x, y) || 1;
    return [x / m, y / m];
  }
  function roll(g) {
    return Math.atan2(g.eyeR[1][1] - g.eyeL[0][1], g.eyeR[1][0] - g.eyeL[0][0]);
  }
  function maskGeo(a, W, H) {
    const cx = a.x * W;
    const cy = a.y * H;
    const bw = Math.max(a.w * W, W * 0.22);
    const bh = Math.max(a.h * H, H * 0.26);
    const lm = a.lm && a.lm.length >= 468 * 2 ? a.lm : null;
    const at = (i, fx, fy) => lm ? [lm[i * 2] * W, lm[i * 2 + 1] * H] : [cx + bw * fx, cy + bh * fy];
    const outerL = at(LM.eyeOuterL, -0.34, -0.12);
    const innerL = at(LM.eyeInnerL, -0.16, -0.12);
    const innerR = at(LM.eyeInnerR, 0.16, -0.12);
    const outerR = at(LM.eyeOuterR, 0.34, -0.12);
    const top = at(LM.hairline, 0, -0.52);
    const chin = at(LM.chin, 0, 0.5);
    const sideL = at(LM.cheekL, -0.5, 0);
    const sideR = at(LM.cheekR, 0.5, 0);
    const fw = lm && gap(sideL, sideR) || bw;
    const fh = lm && gap(top, chin) || bh;
    const ax = unit(sideR[0] - sideL[0], sideR[1] - sideL[1]);
    const ay = unit(top[0] - chin[0], top[1] - chin[1]);
    const spot = (o, s, t) => [
      o[0] + ax[0] * s * fw + ay[0] * t * fh,
      o[1] + ax[1] * s * fw + ay[1] * t * fh
    ];
    return {
      fw,
      fh,
      spot,
      top,
      chin,
      ax,
      ay,
      nose: at(LM.noseTip, 0, 0.1),
      noseBase: at(LM.noseBase, 0, 0.16),
      lipTop: at(LM.lipTop, 0, 0.22),
      lip: at(LM.lip, 0, 0.26),
      lipLow: at(LM.lipLow, 0, 0.3),
      mouthL: at(LM.mouthL, -0.2, 0.28),
      mouthR: at(LM.mouthR, 0.2, 0.28),
      eyeL: [outerL, innerL],
      eyeR: [innerR, outerR],
      lid: a.lid != null ? a.lid : 1,
      browL: at(LM.browL, -0.25, -0.24),
      browR: at(LM.browR, 0.25, -0.24),
      templeL: at(LM.templeL, -0.46, -0.16),
      templeR: at(LM.templeR, 0.46, -0.16),
      earL: at(LM.earL, -0.48, 0.02),
      earR: at(LM.earR, 0.48, 0.02),
      // The hairline in box coordinates, over the head from temple to temple.
      hair: HAIRLINE.map(
        (i, k) => at(
          i,
          -0.44 + 0.88 * k / (HAIRLINE.length - 1),
          -0.4 - 0.1 * Math.cos((k / (HAIRLINE.length - 1) - 0.5) * Math.PI)
        )
      ),
      tongue: a.tongue || 0,
      gaze: a.gaze || [0, 0, 0, 0],
      smile: a.smile || 0
    };
  }
  function lookWarp(p, a, filter) {
    const W = p.canvas.width, H = p.canvas.height;
    const g = maskGeo(a, W, H);
    for (const eye of [g.eyeL, g.eyeR]) {
      const cx2 = (eye[0][0] + eye[1][0]) / 2;
      const cy2 = (eye[0][1] + eye[1][1]) / 2;
      const rx2 = Math.max(gap(eye[0], eye[1]) * 0.64, 5);
      warpPatch(p, cx2, cy2, rx2, rx2 * 0.78, 1.5, 1.62, filter);
    }
    const cx = (g.mouthL[0] + g.mouthR[0]) / 2;
    const cy = (g.lipTop[1] + g.lipLow[1]) / 2;
    const rx = Math.max(gap(g.mouthL, g.mouthR) * 0.62, 5);
    const ry = Math.max((g.lipLow[1] - g.lipTop[1]) * 1.1, rx * 0.42);
    warpPatch(p, cx, cy, rx, ry, 1.3, 1.5, filter);
  }
  function lookWide(p, a, filter) {
    const W = p.canvas.width, H = p.canvas.height;
    const g = maskGeo(a, W, H);
    const cx = (g.eyeL[0][0] + g.eyeR[1][0]) / 2;
    const top = g.top[1] - g.fh * 0.78;
    const bottom = g.chin[1] + g.fh * 0.08;
    const rx = Math.max(g.fw * 0.78, 8);
    const ry = Math.max((bottom - top) / 2, 8);
    warpWide(p, cx, (top + bottom) / 2, rx, ry, 1.8, roll(g), filter);
  }
  function warpWide(p, cx, cy, rx, ry, kx, rollAngle, filter) {
    const W = p.canvas.width, H = p.canvas.height;
    const vw = p.video.videoWidth, vh = p.video.videoHeight;
    const dw = 2 * rx * kx, dh = 2 * ry;
    const iw = Math.ceil(dw), ih = Math.ceil(dh);
    if (iw < 8 || ih < 8 || !vw || !vh) return;
    if (!p.wideCanvas) {
      p.wideCanvas = document.createElement("canvas");
      p.wideCtx = p.wideCanvas.getContext("2d");
    }
    const c = p.wideCanvas, cc = p.wideCtx;
    if (c.width < iw) c.width = iw;
    if (c.height < ih) c.height = ih;
    const cos = Math.abs(Math.cos(rollAngle)), sin = Math.abs(Math.sin(rollAngle));
    const ex = rx * cos + ry * sin, ey = rx * sin + ry * cos;
    const x0 = Math.max(0, (cx - ex) * vw / W), x1 = Math.min(vw, (cx + ex) * vw / W);
    const y0 = Math.max(0, (cy - ey) * vh / H), y1 = Math.min(vh, (cy + ey) * vh / H);
    const bx = x0, by = y0, bw = x1 - x0, bh = y1 - y0;
    cc.clearRect(0, 0, iw, ih);
    cc.globalCompositeOperation = "source-over";
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
    cc.globalCompositeOperation = "destination-in";
    const fade = (x02, y02, x12, y12) => {
      const grad = cc.createLinearGradient(x02, y02, x12, y12);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.12, "rgba(0,0,0,1)");
      grad.addColorStop(0.88, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      cc.fillStyle = grad;
      cc.fillRect(0, 0, iw, ih);
    };
    fade(0, 0, iw, 0);
    fade(0, 0, 0, ih);
    cc.globalCompositeOperation = "source-over";
    if (filter && filter !== "none") p.ctx.filter = filter;
    p.ctx.save();
    p.ctx.translate(cx, cy);
    p.ctx.rotate(rollAngle);
    p.ctx.drawImage(c, 0, 0, iw, ih, -dw / 2, -dh / 2, dw, dh);
    p.ctx.restore();
    if (filter && filter !== "none") p.ctx.filter = "none";
  }
  function lookSmall(p, a, filter) {
    const W = p.canvas.width, H = p.canvas.height;
    const g = maskGeo(a, W, H);
    const vw = p.video.videoWidth, vh = p.video.videoHeight;
    const cx = (g.eyeL[0][0] + g.eyeR[1][0]) / 2;
    const browY = Math.min(g.browL[1], g.browR[1]);
    const lipY = g.lipLow[1];
    const fcy = (browY + lipY) / 2;
    const frx = Math.max((g.eyeR[1][0] - g.eyeL[0][0]) / 2, g.fw * 0.3) * 1.25;
    const fry = Math.max((lipY - browY) / 2, g.fh * 0.12) * 1.55;
    const pcx = cx;
    const pcy = (g.top[1] + g.chin[1]) / 2;
    const prx = Math.max(g.fw * 0.52, 8), pry = Math.max(g.fh * 0.54, 8);
    const iw = Math.ceil(2 * prx), ih = Math.ceil(2 * pry);
    if (iw < 8 || ih < 8 || !vw || !vh) return;
    const vx = (x) => x * vw / W, vy = (y) => y * vh / H;
    if (!p.smallCanvas) {
      p.smallCanvas = document.createElement("canvas");
      p.smallCtx = p.smallCanvas.getContext("2d");
      p.smallFeat = document.createElement("canvas");
      p.smallFeatCtx = p.smallFeat.getContext("2d");
    }
    const c = p.smallCanvas, cc = p.smallCtx;
    if (c.width < iw) c.width = iw;
    if (c.height < ih) c.height = ih;
    const bandY = g.top[1] + g.fh * 0.02;
    const bandH = Math.max(g.fh * 0.14, 4);
    cc.clearRect(0, 0, iw, ih);
    cc.globalCompositeOperation = "source-over";
    cc.filter = "blur(6px)";
    cc.drawImage(p.video, vx(pcx - prx), vy(bandY), vx(2 * prx), vy(bandH), 0, 0, iw, ih);
    cc.filter = "none";
    const k = 0.55;
    const fw = Math.ceil(2 * frx * k), fh = Math.ceil(2 * fry * k);
    const f = p.smallFeat, fc = p.smallFeatCtx;
    if (f.width < fw) f.width = fw;
    if (f.height < fh) f.height = fh;
    fc.clearRect(0, 0, fw, fh);
    fc.globalCompositeOperation = "source-over";
    fc.drawImage(p.video, vx(cx - frx), vy(fcy - fry), vx(2 * frx), vy(2 * fry), 0, 0, fw, fh);
    fc.globalCompositeOperation = "destination-in";
    fc.save();
    fc.translate(fw / 2, fh / 2);
    fc.scale(1, fh / fw);
    const soft = fc.createRadialGradient(0, 0, 0, 0, 0, fw / 2);
    soft.addColorStop(0, "rgba(0,0,0,1)");
    soft.addColorStop(0.72, "rgba(0,0,0,1)");
    soft.addColorStop(1, "rgba(0,0,0,0)");
    fc.fillStyle = soft;
    fc.fillRect(-fw / 2, -fw / 2, fw, fw);
    fc.restore();
    fc.globalCompositeOperation = "source-over";
    cc.drawImage(
      f,
      0,
      0,
      fw,
      fh,
      iw / 2 - fw / 2,
      ih / 2 + (fcy - pcy) / (2 * pry) * ih - fh / 2,
      fw,
      fh
    );
    cc.globalCompositeOperation = "destination-in";
    cc.save();
    cc.translate(iw / 2, ih / 2);
    cc.scale(1, ih / iw);
    const edge = cc.createRadialGradient(0, 0, 0, 0, 0, iw / 2);
    edge.addColorStop(0, "rgba(0,0,0,1)");
    edge.addColorStop(0.84, "rgba(0,0,0,1)");
    edge.addColorStop(1, "rgba(0,0,0,0)");
    cc.fillStyle = edge;
    cc.fillRect(-iw / 2, -iw / 2, iw, iw);
    cc.restore();
    cc.globalCompositeOperation = "source-over";
    if (filter && filter !== "none") p.ctx.filter = filter;
    p.ctx.drawImage(c, 0, 0, iw, ih, pcx - prx, pcy - pry, 2 * prx, 2 * pry);
    if (filter && filter !== "none") p.ctx.filter = "none";
  }
  var WARP_RINGS = 36;
  function warpEllipse(p, cx, cy, rx, ry, ang, kx, ky) {
    const W = p.canvas.width, H = p.canvas.height;
    if (rx < 8 || ry < 8) return;
    if (Math.abs(kx - 1) < 0.02 && Math.abs(ky - 1) < 0.02) return;
    const E = Math.ceil(Math.max(rx, ry)) + 2;
    const bx = Math.max(0, Math.floor(cx - E)), by = Math.max(0, Math.floor(cy - E));
    const bw = Math.min(W, Math.ceil(cx + E)) - bx, bh = Math.min(H, Math.ceil(cy + E)) - by;
    if (bw < 8 || bh < 8) return;
    if (!p.ringCanvas) {
      p.ringCanvas = document.createElement("canvas");
      p.ringCtx = p.ringCanvas.getContext("2d");
    }
    const c = p.ringCanvas, cc = p.ringCtx;
    if (c.width < bw) c.width = bw;
    if (c.height < bh) c.height = bh;
    cc.clearRect(0, 0, c.width, c.height);
    cc.drawImage(p.canvas, bx, by, bw, bh, 0, 0, bw, bh);
    const ctx = p.ctx;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const rim = (t) => {
      ctx.moveTo(cx + rx * t * cos, cy + rx * t * sin);
      ctx.ellipse(cx, cy, rx * t, ry * t, ang, 0, 2 * Math.PI);
    };
    const overlap = 1.5 / Math.min(rx, ry);
    for (let j = 0; j < WARP_RINGS; j++) {
      const t1 = 1 - j / WARP_RINGS, t0 = 1 - (j + 1) / WARP_RINGS;
      const mid = (t0 + t1) / 2;
      const f = (1 - mid) * (1 - mid);
      const mx = 1 + (kx - 1) * f, my = 1 + (ky - 1) * f;
      if (Math.abs(mx - 1) < 4e-3 && Math.abs(my - 1) < 4e-3) continue;
      ctx.save();
      ctx.beginPath();
      rim(t1);
      if (j < WARP_RINGS - 1) rim(Math.max(0, t0 - overlap));
      ctx.clip("evenodd");
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.scale(1 / mx, 1 / my);
      ctx.rotate(-ang);
      ctx.translate(-cx, -cy);
      ctx.drawImage(c, 0, 0, bw, bh, bx, by, bw, bh);
      ctx.restore();
    }
  }
  function pinchFace(p, g, k) {
    const eyeX = (g.eyeL[0][0] + g.eyeR[1][0]) / 2, eyeY = (g.eyeL[0][1] + g.eyeR[1][1]) / 2;
    const cx = eyeX * 0.5 + g.nose[0] * 0.5, cy = eyeY * 0.5 + g.nose[1] * 0.5;
    warpEllipse(p, cx, cy, g.fw * 0.95, g.fh * 0.9, roll(g), k, k);
  }
  var POTION_PINCH = 2.6;
  function lookPotion(p, a) {
    const g = maskGeo(a, p.canvas.width, p.canvas.height);
    pinchFace(p, g, POTION_PINCH);
  }
  function custom() {
    return state.cust;
  }
  function bandPut(s, k) {
    return 0.5 + (s - 0.5) * (1 + (k - 1) * Math.sin(Math.PI * s) ** 2);
  }
  function headBand(p, a, k) {
    const W = p.canvas.width, H = p.canvas.height;
    const y0 = Math.max(0, Math.round((a.y - a.h * 1.2) * H));
    const ih = Math.min(H, Math.round((a.y + a.h * 1.25) * H)) - y0;
    if (ih < 32 || W < 32) return;
    if (!p.bandCanvas) {
      p.bandCanvas = document.createElement("canvas");
      p.bandCtx = p.bandCanvas.getContext("2d");
    }
    const c = p.bandCanvas, cc = p.bandCtx;
    if (c.width !== W || c.height !== ih) {
      c.width = W;
      c.height = ih;
    }
    cc.clearRect(0, 0, W, ih);
    cc.drawImage(p.canvas, 0, y0, W, ih, 0, 0, W, ih);
    const N = 28;
    for (let i = 0; i < N; i++) {
      const s0 = i / N, s1 = (i + 1) / N;
      const sy = s0 * ih, sh = (s1 - s0) * ih;
      const dy = bandPut(s0, k) * ih, dh = (bandPut(s1, k) - bandPut(s0, k)) * ih;
      if (dh <= 0) continue;
      p.ctx.drawImage(c, 0, sy, W, sh, 0, y0 + dy, W, dh + 1);
    }
  }
  function featureCopy(p, slot, src) {
    const W = p.canvas.width, H = p.canvas.height;
    const sx = Math.max(0, Math.round(src.x)), sy = Math.max(0, Math.round(src.y));
    const sw = Math.min(W - sx, Math.round(src.w)), sh = Math.min(H - sy, Math.round(src.h));
    if (sw < 6 || sh < 6) return null;
    const key = "feat" + slot;
    let c = p[key];
    if (!c) {
      c = document.createElement("canvas");
      p[key] = c;
      p[key + "Ctx"] = c.getContext("2d");
    }
    const cc = p[key + "Ctx"];
    if (c.width < sw) c.width = sw;
    if (c.height < sh) c.height = sh;
    cc.clearRect(0, 0, c.width, c.height);
    cc.drawImage(p.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    cc.globalCompositeOperation = "destination-in";
    cc.save();
    cc.translate(sw / 2, sh / 2);
    cc.scale(1, sh / sw);
    const grad = cc.createRadialGradient(0, 0, 0, 0, 0, sw / 2);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(0.62, "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    cc.fillStyle = grad;
    cc.fillRect(-sw / 2, -sw / 2, sw, sw);
    cc.restore();
    cc.globalCompositeOperation = "source-over";
    return { w: sw, h: sh };
  }
  function featurePaste(p, slot, size, dst) {
    if (!size) return;
    const c = p["feat" + slot];
    if (!c) return;
    const dw = Math.max(6, Math.round(dst.w)), dh = Math.max(6, Math.round(dst.h));
    p.ctx.drawImage(c, 0, 0, size.w, size.h, Math.round(dst.x), Math.round(dst.y), dw, dh);
  }
  function featureMoves(p, moves) {
    const held = [];
    for (const m of moves) {
      const size = featureCopy(p, m.slot, m.src);
      const off = m.skin || [0, 0.62];
      const under = featureCopy(p, m.slot + "skin", {
        x: m.src.x + off[0] * m.src.w,
        y: m.src.y + off[1] * m.src.h,
        w: m.src.w,
        h: m.src.h
      });
      held.push({ m, size, under });
    }
    for (const h of held) featurePaste(p, h.m.slot + "skin", h.under, h.m.src);
    for (const h of held) featurePaste(p, h.m.slot, h.size, h.m.dst);
  }
  function lookCustom(p, a) {
    const cfg = custom();
    const W = p.canvas.width, H = p.canvas.height;
    const es = cfg.eyes / 100, sp = cfg.spread / 100, lift = cfg.eyey / 100, ns = cfg.nose / 100, ms = cfg.mouth / 100, mshift = cfg.mshift / 100, hk = cfg.head / 100, wk = cfg.width / 100, pk = cfg.pinch / 100;
    const g = maskGeo(a, W, H);
    const fL = eyeFrame(g.eyeL), fR = eyeFrame(g.eyeR);
    const cxe = (fL.x + fR.x) / 2, cye = (fL.y + fR.y) / 2;
    const gapE = Math.max(8, Math.hypot(fR.x - fL.x, fR.y - fL.y));
    const eyeW = Math.max(g.fw * 0.2, gapE * 0.34);
    const ew = eyeW * 2, eh = eyeW * 1.15;
    const mcx = (g.mouthL[0] + g.mouthR[0]) / 2, mcy = (g.mouthL[1] + g.mouthR[1]) / 2;
    const mw = Math.max(g.fw * 0.34, gap(g.mouthL, g.mouthR) * 1.7);
    const mh = Math.max(mw * 0.62, g.fh * 0.16);
    const box = (cx, cy, w, h) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
    const mouthAt = g.spot([mcx, mcy], 0, -mshift);
    const moves = [];
    if (cfg.swap) {
      const eyesBox = box(cxe, cye, gapE * 1.35 + ew * 0.5, eh * 1.7);
      const mouthBox = box(mcx, mcy, mw, mh);
      moves.push({
        slot: "A",
        src: eyesBox,
        dst: box(mouthAt[0], mouthAt[1], mw * 1.05, mw * 1.05 * (eyesBox.h / eyesBox.w)),
        skin: [0, 0.7]
      });
      moves.push({
        slot: "B",
        src: mouthBox,
        dst: box(cxe, cye, gapE * 1.15, gapE * 1.15 * (mouthBox.h / mouthBox.w)),
        skin: [0, 0.7]
      });
    } else {
      if (es !== 1 || sp !== 1 || lift !== 0) {
        const eyes = [
          [fL, fL.x < cxe ? -1 : 1],
          [fR, fR.x > cxe ? 1 : -1]
        ];
        eyes.forEach(([f, side], i) => {
          const to = g.spot([cxe + (f.x - cxe) * sp, cye + (f.y - cye) * sp], 0, lift);
          moves.push({
            slot: "E" + i,
            src: box(f.x, f.y, ew, eh),
            dst: box(to[0], to[1], ew * es, eh * es),
            skin: [side * 0.06, 0.62]
          });
        });
      }
      if (ns !== 1) {
        const n = g.spot(g.nose, 0, 0.03);
        const nw = g.fw * 0.34, nh = g.fh * 0.26;
        moves.push({
          slot: "N",
          src: box(n[0], n[1], nw, nh),
          dst: box(n[0], n[1], nw * ns, nh * ns),
          skin: [-0.95, 0.05]
        });
      }
      if (ms !== 1 || mshift !== 0) {
        moves.push({
          slot: "M",
          src: box(mcx, mcy, mw, mh),
          dst: box(mouthAt[0], mouthAt[1], mw * ms, mh * ms)
        });
      }
    }
    if (moves.length) featureMoves(p, moves);
    if (pk !== 0) pinchFace(p, g, pk > 0 ? 1 + 1.8 * pk : 1 + 0.5 * pk);
    if (Math.abs(wk - 1) > 0.02) {
      const mx = (g.top[0] + g.chin[0]) / 2, my = (g.top[1] + g.chin[1]) / 2;
      warpEllipse(p, mx, my, g.fw * (0.8 + 0.4 * Math.max(wk, 1)), g.fh * 1.15, roll(g), 1 / wk, 1);
    }
    if (Math.abs(hk - 1) > 0.02) headBand(p, a, hk);
  }
  function warpPatch(p, cx, cy, rx, ry, kx, ky, filter) {
    const W = p.canvas.width, H = p.canvas.height;
    const dw = 2 * rx * kx, dh = 2 * ry * ky;
    const iw = Math.ceil(dw), ih = Math.ceil(dh);
    const vw = p.video.videoWidth, vh = p.video.videoHeight;
    if (iw < 8 || ih < 8 || !vw || !vh) return;
    if (!p.warpCanvas) {
      p.warpCanvas = document.createElement("canvas");
      p.warpCtx = p.warpCanvas.getContext("2d");
    }
    const c = p.warpCanvas, cc = p.warpCtx;
    if (c.width < iw) c.width = iw;
    if (c.height < ih) c.height = ih;
    const sx = (cx - rx) * vw / W, sy = (cy - ry) * vh / H;
    cc.clearRect(0, 0, iw, ih);
    cc.globalCompositeOperation = "source-over";
    cc.drawImage(p.video, sx, sy, 2 * rx * vw / W, 2 * ry * vh / H, 0, 0, iw, ih);
    cc.globalCompositeOperation = "destination-in";
    cc.save();
    cc.translate(iw / 2, ih / 2);
    cc.scale(1, ih / iw);
    const grad = cc.createRadialGradient(0, 0, 0, 0, 0, iw / 2);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(0.72, "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    cc.fillStyle = grad;
    cc.fillRect(-iw / 2, -iw / 2, iw, iw);
    cc.restore();
    cc.globalCompositeOperation = "source-over";
    if (filter && filter !== "none") p.ctx.filter = filter;
    p.ctx.drawImage(c, 0, 0, iw, ih, cx - dw / 2, cy - dh / 2, dw, dh);
    if (filter && filter !== "none") p.ctx.filter = "none";
  }
  function drawMask(ctx, W, H, which, a) {
    const g = maskGeo(a, W, H);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (which === "glasses") drawGlasses(ctx, g);
    else if (which === "shades") drawShades(ctx, g);
    else if (which === "moustache") drawMoustache(ctx, g);
    else if (which === "cat") drawCat(ctx, g);
    else if (which === "dog") drawDog(ctx, g);
    else if (which === "halo") drawHalo(ctx, g);
    else if (which === "miku") drawMiku(ctx, g);
    else if (which === "fawkes") drawFawkes(ctx, g);
    ctx.restore();
  }
  function eyeFrame(e) {
    const [o, i] = e;
    return {
      x: (o[0] + i[0]) / 2,
      y: (o[1] + i[1]) / 2,
      w: gap(o, i),
      ang: Math.atan2(i[1] - o[1], i[0] - o[0])
    };
  }
  function drawGlasses(ctx, g) {
    ctx.fillStyle = "rgba(20, 24, 32, 0.5)";
    ctx.strokeStyle = "#14181f";
    ctx.lineWidth = Math.max(2, g.fw * 0.022);
    const sides = [
      { e: g.eyeL, brow: g.browL, out: g.templeL },
      { e: g.eyeR, brow: g.browR, out: g.templeR }
    ];
    for (const s of sides) {
      const f = eyeFrame(s.e);
      const ew = f.w || g.fw * 0.16;
      const bw = ew * 1.8;
      const bh = ew * 1.2;
      const lift = Math.max(0, (f.y - s.brow[1]) * 0.18);
      ctx.save();
      ctx.translate(f.x, f.y - lift);
      ctx.rotate(f.ang);
      roundPath(ctx, -bw / 2, -bh / 2, bw, bh, bh * 0.42);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      const ux = unit(s.e[0][0] - s.e[1][0], s.e[0][1] - s.e[1][1]);
      ctx.beginPath();
      ctx.moveTo(f.x + ux[0] * bw * 0.5, f.y - lift + ux[1] * bw * 0.5);
      ctx.lineTo(s.out[0], s.out[1]);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(g.eyeL[1][0], g.eyeL[1][1]);
    ctx.lineTo(g.eyeR[1][0], g.eyeR[1][1]);
    ctx.stroke();
  }
  function drawShades(ctx, g) {
    const ang = roll(g);
    const sides = [
      { e: g.eyeL, brow: g.browL, out: g.templeL },
      { e: g.eyeR, brow: g.browR, out: g.templeR }
    ];
    ctx.strokeStyle = "#0d1117";
    ctx.lineWidth = Math.max(1.5, g.fw * 0.016);
    for (const s of sides) {
      const f = eyeFrame(s.e);
      const ew = f.w || g.fw * 0.16;
      const w = ew * 2.1;
      const h = ew * 1.5;
      const lift = Math.max(0, (f.y - s.brow[1]) * 0.3);
      ctx.save();
      ctx.translate(f.x, f.y - lift);
      ctx.rotate(ang);
      const grad = ctx.createLinearGradient(0, -h * 0.6, 0, h * 0.6);
      grad.addColorStop(0, "rgba(10, 14, 22, 0.85)");
      grad.addColorStop(1, "rgba(62, 102, 138, 0.6)");
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
      ctx.strokeStyle = "rgba(176, 220, 255, 0.9)";
      ctx.lineWidth = Math.max(1, g.fw * 0.012);
      ctx.beginPath();
      ctx.moveTo(-w * 0.44, -h * 0.2);
      ctx.bezierCurveTo(-w * 0.4, -h * 0.56, -w * 0.12, -h * 0.54, 0, -h * 0.5);
      ctx.bezierCurveTo(w * 0.12, -h * 0.54, w * 0.4, -h * 0.56, w * 0.44, -h * 0.2);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = "#0d1117";
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
  function drawMoustache(ctx, g) {
    const l = g.mouthL;
    const r = g.mouthR;
    const mx = (l[0] + r[0]) / 2;
    const half = gap(l, r) / 2 || g.fw * 0.2;
    const room = Math.max(2, g.lip[1] - g.noseBase[1]);
    const ty = g.noseBase[1] + room * 0.15;
    const by = g.lip[1] + room * 0.12;
    ctx.fillStyle = "#2a1c14";
    ctx.beginPath();
    ctx.moveTo(l[0], l[1]);
    ctx.bezierCurveTo(
      l[0] + half * 0.5,
      ty - room * 0.2,
      mx - half * 0.5,
      ty - room * 0.3,
      mx,
      ty + room * 0.12
    );
    ctx.bezierCurveTo(
      mx + half * 0.5,
      ty - room * 0.3,
      r[0] - half * 0.5,
      ty - room * 0.2,
      r[0],
      r[1]
    );
    ctx.bezierCurveTo(r[0] - half * 0.3, by + room * 0.35, mx + half * 0.4, by + room * 0.4, mx, by);
    ctx.bezierCurveTo(
      mx - half * 0.4,
      by + room * 0.4,
      l[0] + half * 0.3,
      by + room * 0.35,
      l[0],
      l[1]
    );
    ctx.closePath();
    ctx.fill();
  }
  function drawCat(ctx, g) {
    ctx.strokeStyle = "#20242c";
    ctx.lineWidth = Math.max(1.5, g.fw * 0.012);
    for (const side of [-1, 1]) {
      const a = g.spot(g.top, side * 0.42, -0.04);
      const b = g.spot(g.top, side * 0.18, 0.02);
      const t = g.spot(g.top, side * 0.38, 0.17);
      ctx.fillStyle = "#3a3f4b";
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(t[0], t[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const mx = (a[0] + b[0] + t[0]) / 3;
      const my = (a[1] + b[1] + t[1]) / 3;
      const k = 0.45;
      ctx.fillStyle = "#e08aa8";
      ctx.beginPath();
      ctx.moveTo(a[0] + (mx - a[0]) * k, a[1] + (my - a[1]) * k);
      ctx.lineTo(t[0] + (mx - t[0]) * k, t[1] + (my - t[1]) * k);
      ctx.lineTo(b[0] + (mx - b[0]) * k, b[1] + (my - b[1]) * k);
      ctx.closePath();
      ctx.fill();
    }
  }
  function drawDog(ctx, g) {
    ctx.strokeStyle = "#241a15";
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
      ctx.fillStyle = "#4a352a";
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], tip[0], tip[1]);
      ctx.bezierCurveTo(d2[0], d2[1], d1[0], d1[1], b[0], b[1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const i1 = g.spot(base, side * 0.1, -0.12);
      const i2 = g.spot(base, side * 0.12, -0.34);
      const i3 = g.spot(base, side * 0.2, -0.24);
      ctx.strokeStyle = "rgba(255, 214, 194, 0.22)";
      ctx.beginPath();
      ctx.moveTo(i1[0], i1[1]);
      ctx.quadraticCurveTo(i3[0], i3[1], i2[0], i2[1]);
      ctx.stroke();
      ctx.strokeStyle = "#241a15";
    }
    ctx.save();
    ctx.translate(g.nose[0], g.nose[1]);
    ctx.rotate(roll(g));
    ctx.fillStyle = "#2a2320";
    ctx.beginPath();
    ctx.ellipse(0, 0, g.fw * 0.075, g.fw * 0.055, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.beginPath();
    ctx.ellipse(-g.fw * 0.022, -g.fw * 0.018, g.fw * 0.02, g.fw * 0.013, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const open = clamp(g.tongue, 0, 1);
    if (open > 0.02) {
      const mx = (g.mouthL[0] + g.mouthR[0]) / 2;
      const my = (g.lip[1] + g.lipLow[1]) / 2;
      const half = gap(g.mouthL, g.mouthR) * 0.42 || g.fw * 0.08;
      const tip = g.spot(g.lip, 0, -(0.02 + 0.17 * open));
      ctx.fillStyle = "#e2707f";
      ctx.beginPath();
      ctx.moveTo(mx - half, my);
      ctx.quadraticCurveTo(mx - half * 1.15, tip[1], mx, tip[1]);
      ctx.quadraticCurveTo(mx + half * 1.15, tip[1], mx + half, my);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(150, 54, 74, 0.55)";
      ctx.lineWidth = Math.max(1, g.fw * 8e-3);
      ctx.beginPath();
      ctx.moveTo(mx, my + (tip[1] - my) * 0.15);
      ctx.lineTo(mx, tip[1] - (tip[1] - my) * 0.2);
      ctx.stroke();
    }
  }
  function drawHalo(ctx, g) {
    const c = g.spot(g.top, 0, 0.26);
    const rx = g.fw * 0.42;
    const ry = g.fw * 0.12;
    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.rotate(roll(g));
    ctx.shadowColor = "rgba(255, 214, 102, 0.95)";
    ctx.shadowBlur = Math.max(4, g.fw * 0.14);
    ctx.strokeStyle = "rgba(255, 222, 122, 0.9)";
    ctx.lineWidth = Math.max(2, g.fw * 0.035);
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 250, 224, 0.95)";
    ctx.lineWidth = Math.max(1, g.fw * 0.014);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  var WIG_URL = "/miku/wig.svg";
  var WIG_FILE_ASPECT = 334.55 / 366.31;
  var WIG_HOLE = { x0: 0.2951, y0: 0.3632, x1: 0.7122, y1: 0.7409 };
  var WIG_PX = 640;
  var wigArt = null;
  var wigTried = false;
  function wigLoad() {
    if (wigTried) return;
    wigTried = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = WIG_PX;
      c.height = Math.round(WIG_PX * WIG_FILE_ASPECT);
      const cc = c.getContext("2d");
      cc.imageSmoothingQuality = "high";
      cc.drawImage(img, 0, 0, c.width, c.height);
      wigArt = c;
      const p = state.lookPipe;
      if (p && state.masks.includes("miku")) lookDraw(p);
    };
    img.src = WIG_URL;
  }
  var MIKU = {
    skin: "#f8dfd3",
    shade: "rgba(196, 142, 126, 0.35)",
    lash: "#123943",
    iris: ["#7ff0e6", "#0d6a82"],
    blush: "rgba(243, 154, 166, 0.5)",
    mouth: "#93404f",
    tongue: "#e37a83",
    inside: "#45161d",
    teeth: "#fbf3ef"
  };
  function drawMikuEye(ctx, x, y, w, h, open, gx = 0, gy = 0) {
    const o = clamp(open, 0, 1);
    const rw = w / 2;
    const rh = Math.max(h / 2 * (0.16 + 0.84 * o), 0.8);
    ctx.lineCap = "round";
    if (o < 0.14) {
      ctx.strokeStyle = MIKU.lash;
      ctx.lineWidth = Math.max(1.8, h * 0.16);
      ctx.beginPath();
      ctx.moveTo(x - rw, y);
      ctx.quadraticCurveTo(x, y + Math.max(1.5, h * 0.2), x + rw, y);
      ctx.stroke();
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y, rw, rh, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#fdfbf8";
    ctx.fillRect(x - rw, y - rh, w, rh * 2);
    const ir = Math.min(rw * 0.82, rh * 0.95);
    const ix = x + clamp(gx, -1, 1) * Math.max(rw - ir * 0.9, 0) * 0.95;
    const iy = y + rh * 0.08 + clamp(gy, -1, 1) * Math.max(rh - ir, 0) * 0.9;
    const ig = ctx.createLinearGradient(x, iy - ir, x, iy + ir);
    ig.addColorStop(0, MIKU.iris[0]);
    ig.addColorStop(1, MIKU.iris[1]);
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.ellipse(ix, iy, ir * 0.9, ir, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#082026";
    ctx.beginPath();
    ctx.ellipse(ix, iy + ir * 0.05, ir * 0.38, ir * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.beginPath();
    ctx.ellipse(ix - ir * 0.3, iy - ir * 0.42, ir * 0.24, ir * 0.3, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(ix + ir * 0.3, iy + ir * 0.32, ir * 0.12, ir * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = MIKU.lash;
    ctx.lineWidth = Math.max(1.8, h * 0.16);
    ctx.beginPath();
    ctx.ellipse(x, y, rw * 0.99, rh * 0.99, 0, Math.PI * 1.04, Math.PI * 1.96);
    ctx.stroke();
    ctx.strokeStyle = "rgba(18, 57, 67, 0.55)";
    ctx.lineWidth = Math.max(1, h * 0.07);
    ctx.beginPath();
    ctx.ellipse(x, y, rw * 0.96, rh * 0.96, 0, Math.PI * 0.06, Math.PI * 0.94);
    ctx.stroke();
  }
  function drawMikuSkin(ctx, g, cx, cy) {
    const rx = Math.max(g.fw * 0.54, 1);
    const ry = Math.max(g.fh * 0.6, 1);
    ctx.beginPath();
    ctx.ellipse(cx, cy + g.fh * 0.03, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = MIKU.skin;
    ctx.fill();
    const shade = ctx.createRadialGradient(cx, cy + g.fh * 0.05, rx * 0.2, cx, cy + g.fh * 0.05, rx);
    shade.addColorStop(0, "rgba(255, 255, 255, 0)");
    shade.addColorStop(1, MIKU.shade);
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(cx, cy + g.fh * 0.03, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const side of [-1, 1]) {
      const bx = cx + side * g.fw * 0.26;
      const by = cy + g.fh * 0.17;
      const bg = ctx.createRadialGradient(bx, by, 0, bx, by, g.fw * 0.1);
      bg.addColorStop(0, MIKU.blush);
      bg.addColorStop(1, "rgba(243, 154, 166, 0)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.ellipse(bx, by, g.fw * 0.1, g.fw * 0.055, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawMiku(ctx, g) {
    wigLoad();
    const H = WIG_HOLE;
    const top = g.spot(g.top, 0, -0.05);
    const holeW = Math.max(g.fw * 0.98, 1);
    const holeH = Math.max(gap(top, g.chin), g.fh * 0.5);
    const artW = holeW / (H.x1 - H.x0);
    const artH = holeH / (H.y1 - H.y0);
    const cx = (H.x0 + H.x1) / 2 * artW;
    const cy = (H.y0 + H.y1) / 2 * artH;
    const mid = [(top[0] + g.chin[0]) / 2, (top[1] + g.chin[1]) / 2];
    const ax = g.ax, ay = g.ay;
    const home = (pt) => {
      const dx = pt[0] - mid[0], dy = pt[1] - mid[1];
      return [cx + dx * ax[0] + dy * ax[1], cy - (dx * ay[0] + dy * ay[1])];
    };
    const at = (p, q) => home([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    ctx.save();
    ctx.imageSmoothingQuality = "high";
    ctx.transform(
      ax[0],
      ax[1],
      -ay[0],
      -ay[1],
      mid[0] - ax[0] * cx + ay[0] * cy,
      mid[1] - ax[1] * cx + ay[1] * cy
    );
    drawMikuSkin(ctx, g, cx, cy);
    const [nx, ny] = home(g.nose);
    ctx.fillStyle = "rgba(190, 130, 118, 0.5)";
    ctx.beginPath();
    ctx.ellipse(nx, ny + g.fh * 0.02, g.fw * 0.018, g.fw * 0.01, 0, 0, Math.PI * 2);
    ctx.fill();
    const ml = home(g.mouthL);
    const mr = home(g.mouthR);
    const mcx = (ml[0] + mr[0]) / 2;
    const mcy = (ml[1] + mr[1]) / 2;
    const halfW = Math.max(gap(ml, mr) * 0.56, g.fw * 0.085);
    const lift = clamp(g.smile, -0.7, 0.7) * halfW * 0.5;
    const cornerY = mcy - lift;
    const open = clamp(g.tongue, 0, 1);
    const lipW = Math.max(1.4, halfW * 0.1);
    if (open < 0.12) {
      ctx.strokeStyle = MIKU.mouth;
      ctx.lineWidth = lipW;
      ctx.beginPath();
      ctx.moveTo(mcx - halfW, cornerY);
      ctx.quadraticCurveTo(mcx, mcy + halfW * 0.16, mcx + halfW, cornerY);
      ctx.stroke();
      ctx.fillStyle = "rgba(206, 108, 122, 0.35)";
      ctx.beginPath();
      ctx.ellipse(mcx, mcy + halfW * 0.17, halfW * 0.72, halfW * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 235, 235, 0.5)";
      ctx.beginPath();
      ctx.ellipse(mcx - halfW * 0.18, mcy + halfW * 0.12, halfW * 0.2, halfW * 0.05, -0.1, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const mh = halfW * (0.5 + 1.5 * open);
      const bottom = mcy + mh * 0.62;
      ctx.beginPath();
      ctx.moveTo(mcx - halfW, cornerY);
      ctx.bezierCurveTo(
        mcx - halfW * 0.62,
        cornerY - mh * 0.12,
        mcx - halfW * 0.2,
        cornerY - mh * 0.1,
        mcx,
        cornerY - mh * 0.06
      );
      ctx.bezierCurveTo(
        mcx + halfW * 0.2,
        cornerY - mh * 0.1,
        mcx + halfW * 0.62,
        cornerY - mh * 0.12,
        mcx + halfW,
        cornerY
      );
      ctx.bezierCurveTo(
        mcx + halfW * 0.86,
        bottom - mh * 0.06,
        mcx + halfW * 0.44,
        bottom + mh * 0.06,
        mcx,
        bottom + mh * 0.06
      );
      ctx.bezierCurveTo(
        mcx + halfW * 0.44,
        bottom + mh * 0.06,
        mcx - halfW * 0.86,
        bottom - mh * 0.06,
        mcx - halfW,
        cornerY
      );
      ctx.closePath();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = MIKU.inside;
      ctx.fillRect(mcx - halfW, cornerY - mh, halfW * 2, mh * 3);
      if (open > 0.22) {
        ctx.fillStyle = MIKU.teeth;
        ctx.beginPath();
        ctx.ellipse(mcx, cornerY - mh * 0.03, halfW * 0.88, mh * (0.16 + 0.08 * (1 - open)), 0, 0, Math.PI);
        ctx.fill();
      }
      if (open > 0.4) {
        ctx.fillStyle = MIKU.tongue;
        ctx.beginPath();
        ctx.ellipse(mcx, bottom + mh * 0.06, halfW * 0.5, mh * (0.1 + 0.16 * open), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = MIKU.mouth;
      ctx.lineWidth = lipW;
      ctx.beginPath();
      ctx.moveTo(mcx - halfW, cornerY);
      ctx.bezierCurveTo(
        mcx - halfW * 0.9,
        bottom - mh * 0.04,
        mcx - halfW * 0.4,
        bottom + mh * 0.08,
        mcx,
        bottom + mh * 0.08
      );
      ctx.bezierCurveTo(
        mcx + halfW * 0.4,
        bottom + mh * 0.08,
        mcx + halfW * 0.9,
        bottom - mh * 0.04,
        mcx + halfW,
        cornerY
      );
      ctx.stroke();
    }
    if (wigArt) ctx.drawImage(wigArt, 0, 0, artW, artH);
    const eyeLW = Math.max(gap(g.eyeL[0], g.eyeL[1]) * 1.4, g.fw * 0.19);
    const eyeRW = Math.max(gap(g.eyeR[0], g.eyeR[1]) * 1.4, g.fw * 0.19);
    const eyeH = Math.max(eyeLW, eyeRW) * 0.74;
    const lid = g.lid == null ? 1 : g.lid;
    const [elx, ely] = at(g.eyeL[0], g.eyeL[1]);
    const [erx, ery] = at(g.eyeR[0], g.eyeR[1]);
    for (const [ex, ey, ew, eh] of [
      [elx, ely, eyeLW, eyeH],
      [erx, ery, eyeRW, eyeH]
    ]) {
      const skin = ctx.createRadialGradient(ex, ey, Math.min(ew, eh) * 0.18, ex, ey, Math.max(ew, eh) * 0.72);
      skin.addColorStop(0, "rgba(248, 223, 211, 1)");
      skin.addColorStop(0.72, "rgba(248, 223, 211, 0.96)");
      skin.addColorStop(1, "rgba(248, 223, 211, 0)");
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.ellipse(ex, ey, ew * 0.72, eh * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const gaze = g.gaze || [0, 0, 0, 0];
    drawMikuEye(ctx, elx, ely, eyeLW, eyeH, lid, gaze[0], gaze[1]);
    drawMikuEye(ctx, erx, ery, eyeRW, eyeH, lid, gaze[2], gaze[3]);
    for (const [brow, eye, w] of [
      [g.browL, ely, eyeLW],
      [g.browR, ery, eyeRW]
    ]) {
      const [bx, by] = home(brow);
      const lift2 = Math.min(by, eye - eyeH * 0.95);
      ctx.strokeStyle = "rgba(23, 92, 90, 0.95)";
      ctx.lineWidth = Math.max(1.4, eyeH * 0.09);
      ctx.beginPath();
      ctx.moveTo(bx - w * 0.5, lift2 + eyeH * 0.1);
      ctx.quadraticCurveTo(bx, lift2 - eyeH * 0.16, bx + w * 0.5, lift2 + eyeH * 0.1);
      ctx.stroke();
    }
    ctx.restore();
  }
  var FAWKES = {
    white: ["#fdfdfb", "#eeece5", "#c6c3ba"],
    ink: "#111111",
    shade: "rgba(120, 118, 108, 0.28)"
  };
  function drawFawkes(ctx, g) {
    const fw = Math.max(g.fw, 1);
    const fh = Math.max(g.fh, 1);
    const mid = [(g.top[0] + g.chin[0]) / 2, (g.top[1] + g.chin[1]) / 2];
    const ax = g.ax, ay = g.ay;
    ctx.save();
    ctx.transform(ax[0] * fw, ax[1] * fw, -ay[0] * fh, -ay[1] * fh, mid[0], mid[1]);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const shape = () => {
      ctx.beginPath();
      ctx.moveTo(0, -0.68);
      ctx.bezierCurveTo(0.19, -0.66, 0.34, -0.53, 0.38, -0.3);
      ctx.bezierCurveTo(0.42, -0.08, 0.4, 0.16, 0.31, 0.35);
      ctx.bezierCurveTo(0.22, 0.52, 0.11, 0.64, 0, 0.7);
      ctx.bezierCurveTo(-0.11, 0.64, -0.22, 0.52, -0.31, 0.35);
      ctx.bezierCurveTo(-0.4, 0.16, -0.42, -0.08, -0.38, -0.3);
      ctx.bezierCurveTo(-0.34, -0.53, -0.19, -0.66, 0, -0.68);
      ctx.closePath();
    };
    const skin = ctx.createRadialGradient(0, -0.2, 0.05, 0, -0.05, 0.78);
    skin.addColorStop(0, FAWKES.white[0]);
    skin.addColorStop(0.62, FAWKES.white[1]);
    skin.addColorStop(1, FAWKES.white[2]);
    shape();
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.save();
    shape();
    ctx.clip();
    for (const side of [-1, 1]) {
      const cx = side * 0.26, cy = 0.06;
      const cg = ctx.createRadialGradient(cx, cy, 0.02, cx, cy, 0.24);
      cg.addColorStop(0, FAWKES.shade);
      cg.addColorStop(1, "rgba(120, 118, 108, 0)");
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 0.24, 0.3, side * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    const brow = ctx.createLinearGradient(0, -0.5, 0, -0.2);
    brow.addColorStop(0, "rgba(120, 118, 108, 0.3)");
    brow.addColorStop(1, "rgba(120, 118, 108, 0)");
    ctx.fillStyle = brow;
    ctx.fillRect(-0.5, -0.5, 1, 0.3);
    ctx.restore();
    for (const side of [-1, 1]) {
      ctx.strokeStyle = FAWKES.ink;
      ctx.lineWidth = 0.022;
      ctx.beginPath();
      ctx.moveTo(side * 0.06, -0.28);
      ctx.quadraticCurveTo(side * 0.17, -0.36, side * 0.29, -0.3);
      ctx.stroke();
    }
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * 0.16, -0.16);
      ctx.rotate(side * 0.12);
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.125, 0.062, 0, 0, Math.PI * 2);
      ctx.fillStyle = FAWKES.ink;
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
      ctx.lineWidth = 8e-3;
      ctx.beginPath();
      ctx.ellipse(0, -6e-3, 0.11, 0.052, 0, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(130, 128, 118, 0.5)";
    ctx.lineWidth = 0.018;
    ctx.beginPath();
    ctx.moveTo(-0.015, -0.06);
    ctx.quadraticCurveTo(-0.03, 0.03, -0.01, 0.075);
    ctx.stroke();
    for (const side of [-1, 1]) {
      ctx.fillStyle = "rgba(110, 108, 100, 0.45)";
      ctx.beginPath();
      ctx.ellipse(side * 0.045, 0.09, 0.016, 0.01, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = FAWKES.ink;
    ctx.lineWidth = 0.02;
    ctx.beginPath();
    ctx.moveTo(-0.26, 0.2);
    ctx.bezierCurveTo(-0.1, 0.3, 0.1, 0.3, 0.26, 0.2);
    ctx.stroke();
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 0.26, 0.2);
      ctx.bezierCurveTo(side * 0.34, 0.17, side * 0.34, 0.09, side * 0.28, 0.1);
      ctx.bezierCurveTo(side * 0.25, 0.105, side * 0.25, 0.14, side * 0.28, 0.145);
      ctx.stroke();
    }
    ctx.lineWidth = 0.017;
    ctx.beginPath();
    ctx.moveTo(-0.19, 0.135);
    ctx.quadraticCurveTo(-0.07, 0.105, 0, 0.125);
    ctx.quadraticCurveTo(0.07, 0.105, 0.19, 0.135);
    ctx.stroke();
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 0.19, 0.135);
      ctx.quadraticCurveTo(side * 0.235, 0.1, side * 0.2, 0.06);
      ctx.stroke();
    }
    ctx.fillStyle = FAWKES.ink;
    ctx.beginPath();
    ctx.moveTo(-0.055, 0.32);
    ctx.quadraticCurveTo(-0.03, 0.44, 0, 0.52);
    ctx.quadraticCurveTo(0.03, 0.44, 0.055, 0.32);
    ctx.quadraticCurveTo(0, 0.36, -0.055, 0.32);
    ctx.closePath();
    ctx.fill();
    shape();
    ctx.strokeStyle = "rgba(90, 88, 80, 0.4)";
    ctx.lineWidth = 0.018;
    ctx.stroke();
    ctx.restore();
  }
  async function lookPublish(track) {
    if (!state.outStream) return;
    if (state.freeze && track !== state.freezeTrack) return;
    const senders = Array.from(state.peers.values()).filter((peer) => {
      const tr = peer.tx && peer.tx.video;
      return tr && !peer.waiting && tr.sender.track !== track;
    });
    if (senders.length) state.lookSwaps++;
    for (const old of state.outStream.getVideoTracks()) {
      if (old !== track) state.outStream.removeTrack(old);
    }
    if (track && !state.outStream.getVideoTracks().includes(track)) state.outStream.addTrack(track);
    await Promise.all(
      senders.map(async (peer) => {
        await peer.tx.video.sender.replaceTrack(track).catch(() => {
        });
      })
    );
    paintSelfCam(true);
  }
  async function freezeShot() {
    let src;
    const p = state.lookPipe;
    if (lookOn() && p && p.canvas && p.canvas.width > 1) {
      src = p.canvas;
    } else {
      if (!state.freezeVideo) {
        const v2 = document.createElement("video");
        v2.muted = true;
        v2.playsInline = true;
        v2.className = "offstage";
        document.body.appendChild(v2);
        state.freezeVideo = v2;
      }
      const v = state.freezeVideo;
      const now = v.srcObject && v.srcObject.getVideoTracks()[0];
      if (now !== state.camTrack) v.srcObject = new MediaStream([state.camTrack]);
      try {
        await v.play();
      } catch {
      }
      for (let i = 0; i < 20 && !v.videoWidth; i += 1) await new Promise((r) => setTimeout(r, 25));
      src = v;
    }
    const w = src.width || src.videoWidth || 0;
    const h = src.height || src.videoHeight || 0;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, w, h);
    const held = document.createElement("canvas");
    held.width = w;
    held.height = h;
    const hg = held.getContext("2d");
    if (hg) hg.drawImage(canvas, 0, 0);
    state.freezeSource = held;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track) return null;
    track.contentHint = "detail";
    if (track.requestFrame) track.requestFrame();
    state.freezeCanvas = canvas;
    return track;
  }
  function freezePulse() {
    if (state.freezeTimer) clearInterval(state.freezeTimer);
    state.freezeTimer = setInterval(() => {
      if (!state.freeze || !state.freezeCanvas || !state.freezeSource) {
        clearInterval(state.freezeTimer);
        state.freezeTimer = null;
        return;
      }
      const g = state.freezeCanvas.getContext("2d");
      if (g) g.drawImage(state.freezeSource, 0, 0);
      const t = state.freezeTrack;
      if (t && t.requestFrame) t.requestFrame();
    }, 500);
  }
  async function setFreeze(on) {
    on = !!on;
    if (on === !!state.freeze) return true;
    if (on) {
      if (!state.camTrack) {
        say("the camera is off, so there is nothing to freeze");
        return false;
      }
      const track = await freezeShot();
      if (!track) {
        say("the camera gave no frame to freeze");
        return false;
      }
      state.freeze = true;
      state.freezeTrack = track;
      freezePulse();
      await lookPublish(track);
      return true;
    }
    state.freeze = false;
    if (state.freezeTimer) {
      clearInterval(state.freezeTimer);
      state.freezeTimer = null;
    }
    const old = state.freezeTrack;
    state.freezeTrack = null;
    state.freezeCanvas = null;
    state.freezeSource = null;
    await lookPublish(lookTrack() || state.camTrack);
    if (old) stopQuietly(old);
    return true;
  }
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
    try {
      await p.video.play();
    } catch {
    }
    lookDraw(p);
    p.clock = lookClock(p);
    await lookPublish(p.track);
  }
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
      if (p.wake) document.removeEventListener("visibilitychange", p.wake);
      if (p.clock) p.clock.terminate();
      detachMedia(p.video);
      if (p.video.parentNode) p.video.parentNode.removeChild(p.video);
      stopTracks(p.stream);
    }
    if (!restore) return;
    const track = state.camTrack;
    if (state.outStream) {
      for (const old of state.outStream.getVideoTracks()) state.outStream.removeTrack(old);
      if (track) state.outStream.addTrack(track);
      for (const peer of state.peers.values()) {
        const tr = peer.tx && peer.tx.video;
        if (tr && !peer.waiting) tr.sender.replaceTrack(track || null).catch(() => {
        });
      }
    }
    paintSelfCam(!!track && state.cam);
  }
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
    if (state.lookPipe && state.lookSrc !== state.camTrack) lookStop(false);
    if (state.lookPipe) {
      if (lookOn()) {
        state.lookGrace = 0;
        armLookTearDown();
        return;
      }
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
  function lookInit() {
    const saved = load("look");
    state.look = Object.prototype.hasOwnProperty.call(LOOKS, saved) ? saved : "none";
    state.masks = maskSet(load("mask"));
    const lookPick = $("look-filter");
    if (lookPick) {
      lookPick.value = state.look;
      lookPick.addEventListener("change", () => {
        state.look = Object.prototype.hasOwnProperty.call(LOOKS, lookPick.value) ? lookPick.value : "none";
        store("look", state.look);
        lookRestart();
      });
    }
    for (const box of maskBoxes()) {
      box.checked = state.masks.includes(box.dataset.mask);
      box.addEventListener("change", () => {
        state.masks = maskSet([...maskBoxes()].filter((b) => b.checked).map((b) => b.dataset.mask));
        store("mask", state.masks.join("+"));
        paintCustomPanel();
        lookRestart();
      });
    }
    customInit();
    paintCustomPanel();
  }
  function customInit() {
    customRowsAdd();
    const raw = load("cust");
    if (raw) {
      try {
        const saved = JSON.parse(raw);
        for (const key of Object.keys(state.cust)) {
          if (saved && Object.hasOwn(saved, key) && typeof saved[key] === typeof state.cust[key]) {
            state.cust[key] = saved[key];
          }
        }
      } catch {
      }
    }
    for (const [id, key] of CUSTOM_ROWS) {
      const el2 = document.getElementById(id);
      if (!el2) continue;
      el2.addEventListener("input", () => {
        const n = Number(el2.value);
        state.cust[key] = Number.isFinite(n) ? n : 0;
        paintCustomValue(key);
        store("cust", JSON.stringify(state.cust));
      });
    }
    const swap = $("cx-swap");
    if (swap) {
      swap.addEventListener("change", () => {
        state.cust.swap = swap.checked;
        store("cust", JSON.stringify(state.cust));
      });
    }
    const reset = document.getElementById("cx-reset");
    if (reset) {
      reset.addEventListener("click", () => {
        state.cust = { ...CUST_DEFAULTS };
        store("cust", JSON.stringify(state.cust));
        paintCustomValues();
      });
    }
    paintCustomValues();
  }
  var CUSTOM_ROWS = [
    ["cx-head", "head", "cx-head-v"],
    ["cx-width", "width", "cx-width-v"],
    ["cx-eyes", "eyes", "cx-eyes-v"],
    ["cx-spread", "spread", "cx-spread-v"],
    ["cx-eyey", "eyey", "cx-eyey-v"],
    ["cx-nose", "nose", "cx-nose-v"],
    ["cx-mouth", "mouth", "cx-mouth-v"],
    ["cx-mshift", "mshift", "cx-mshift-v"],
    ["cx-pinch", "pinch", "cx-pinch-v"]
  ];
  var CUSTOM_EXTRA = [
    ["cx-width", "width", "head width", 60, 200, "cx-head"],
    ["cx-eyey", "eyey", "eye height", -25, 25, "cx-spread"],
    ["cx-nose", "nose", "nose size", 40, 220, "cx-eyey"],
    ["cx-pinch", "pinch", "pinch / bulge", -100, 100, "cx-mshift"]
  ];
  function customRowsAdd() {
    const panel = document.getElementById("cx-panel");
    const source = document.getElementById("cx-mshift")?.closest(".cx-row");
    if (!panel || !source || source.parentElement !== panel) return;
    for (const [id, key, label, lo, hi, after] of CUSTOM_EXTRA) {
      if (document.getElementById(id)) continue;
      const row = document.getElementById(after)?.closest(".cx-row");
      if (!row || row.parentElement !== panel) continue;
      const copy = source.cloneNode(true);
      const range = copy.querySelector("input");
      const name = copy.querySelector(".cx-name");
      const readout = copy.querySelector(".cx-val");
      if (!range || !name || !readout) continue;
      for (const el2 of copy.querySelectorAll("[id]")) el2.removeAttribute("id");
      range.id = id;
      readout.id = id + "-v";
      range.min = String(lo);
      range.max = String(hi);
      range.value = String(state.cust[key]);
      range.setAttribute("aria-label", label);
      name.textContent = label;
      row.after(copy);
    }
  }
  function paintCustomValue(key) {
    for (const [id, name, out] of CUSTOM_ROWS) {
      if (name !== key) continue;
      const el2 = document.getElementById(id);
      const tag = document.getElementById(out);
      if (el2) el2.value = String(state.cust[key]);
      if (tag) tag.textContent = String(state.cust[key]);
    }
  }
  function paintCustomValues() {
    for (const [, key] of CUSTOM_ROWS) paintCustomValue(key);
    const swap = $("cx-swap");
    if (swap) swap.checked = !!state.cust.swap;
  }
  function paintCustomPanel() {
    const panel = document.getElementById("cx-panel");
    if (panel) panel.hidden = !state.masks.includes("custom");
  }
  function maskBoxes() {
    return document.querySelectorAll(
      "#menu-effects input[data-mask]"
    );
  }
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

  // src/media.ts
  var MIC_AUDIO = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
  function qualityNow() {
    return QUALITY[state.quality] || QUALITY["1280x720@30"];
  }
  function perfNow() {
    return PERF[state.perf] || PERF[0];
  }
  function evenPx(n, scale) {
    return scale === 1 ? n : Math.max(2, Math.round(n * scale / 2) * 2);
  }
  function perfFps(q, p) {
    return p.fps ? Math.min(q.fps, p.fps) : q.fps;
  }
  function videoFor(q, p) {
    const w = evenPx(q.w, p.scale);
    const h = evenPx(q.h, p.scale);
    const fps = perfFps(q, p);
    return {
      width: { ideal: w, max: w },
      height: { ideal: h, max: h },
      frameRate: { ideal: fps, max: fps }
    };
  }
  function camVideo() {
    return videoFor(qualityNow(), perfNow());
  }
  function shareVideo() {
    return videoFor(QUALITY[state.shareQuality] || QUALITY["1920x1080@30"], PERF[0]);
  }
  function perfText() {
    const q = qualityNow();
    const p = perfNow();
    const v = videoFor(q, p);
    return `${p.name}: camera ${v.width.ideal}x${v.height.ideal} at ${v.frameRate.ideal} frames, up to ${Math.round(q.max * p.bits / 1e3)} kbit/s. Sound is not changed.`;
  }
  function paintPerf() {
    for (const id of ["perf", "perf-live"]) {
      const el2 = document.getElementById(id);
      if (el2) el2.value = String(PERF.length - 1 - state.perf);
    }
    for (const id of ["perf-text", "perf-live-text"]) {
      const el2 = document.getElementById(id);
      if (!el2) continue;
      el2.textContent = id === "perf-text" ? perfText() : perfNow().name;
    }
  }
  async function ask(constraints) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia(constraints) };
    } catch (err) {
      return { err };
    }
  }
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
    const max = Math.round(q.max * p.bits);
    const fps = p.fps ? perfFps(q, p) : 0;
    const next = {
      ...params,
      encodings: params.encodings.map((enc) => {
        const out = { ...enc, maxBitrate: max };
        if (fps) out.maxFramerate = fps;
        else delete out.maxFramerate;
        return out;
      })
    };
    try {
      await sender.setParameters(next);
      return true;
    } catch {
      return false;
    }
  }
  function capCameraSenders(pc) {
    if (!pc || !state.camTrack) return;
    const drawn = lookTrack();
    for (const sender of pc.getSenders()) {
      if (sender.track !== state.camTrack && sender.track !== drawn) continue;
      capVideoSender(sender);
    }
  }
  async function applyQuality() {
    let refused = false;
    const track = state.camTrack;
    if (track && track.readyState === "live") {
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
        if (!sender.track || sender.track !== track && sender.track !== drawn) continue;
        if (!await capVideoSender(sender)) refused = true;
      }
    }
    lookResize();
    if (refused) say("the browser refused the new camera quality; the old one stays in effect");
  }

  // src/chat.ts
  var CHAT_MAX = 200;
  function chatTime(ts = null) {
    const d = ts ? new Date(ts) : /* @__PURE__ */ new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  var LINK_RE = /https?:\/\/[^\s<>"']+/gi;
  function splitLink(raw) {
    let url = raw;
    let tail = "";
    for (; ; ) {
      const last = url[url.length - 1];
      if (!last) break;
      let cut = `.,;:!?'"`.includes(last);
      if (!cut && (last === ")" || last === "]" || last === "}")) {
        const open = { ")": "(", "]": "[", "}": "{" }[last];
        cut = url.split(last).length > url.split(open).length;
      }
      if (!cut) break;
      tail = last + tail;
      url = url.slice(0, -1);
    }
    return { url, tail };
  }
  function safeLink(text) {
    let u;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || u.username || u.password) return null;
    return u;
  }
  function linkify(text) {
    const out = document.createDocumentFragment();
    let at = 0;
    for (const m of text.matchAll(LINK_RE)) {
      const { url } = splitLink(m[0]);
      const u = safeLink(url);
      if (!u) continue;
      if (m.index > at) out.appendChild(document.createTextNode(text.slice(at, m.index)));
      const a = document.createElement("a");
      a.textContent = url;
      a.href = u.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      a.referrerPolicy = "no-referrer";
      a.title = `opens ${u.href}`;
      a.className = "chat-link";
      out.appendChild(a);
      at = m.index + url.length;
    }
    if (at < text.length) out.appendChild(document.createTextNode(text.slice(at)));
    return out;
  }
  function addChatLine(name, text, ts) {
    const log = $("chat-log");
    if (!log) return;
    const li = document.createElement("li");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = chatTime(ts);
    li.appendChild(when);
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = `${name || "guest"}:`;
    li.appendChild(who);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(linkify(String(text)));
    log.appendChild(li);
    while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // src/clock.ts
  function clockText(ms) {
    const total = Math.max(0, Math.floor(ms / 1e3));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = total % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  function startCallClock() {
    stopCallClock();
    state.callStart = Date.now();
    $("call-timer").textContent = clockText(0);
    state.callTimer = setInterval(() => {
      if (!state.callStart) return;
      $("call-timer").textContent = clockText(Date.now() - state.callStart);
    }, 1e3);
  }
  function stopCallClock() {
    if (state.callTimer) clearInterval(state.callTimer);
    state.callTimer = null;
    state.callStart = 0;
    const el2 = $("call-timer");
    if (el2) el2.textContent = "";
  }

  // src/sfx.ts
  var SFX_NAMES = ["pop", "bonk", "timp", "hammer", "lost"];
  var SFX_RATE = 0.35;
  var LOST_RATE = 0.2;
  var LOST_LOOP_START = 0.16;
  var LOST_LOOP_END = 8.16;
  var sfxCache = /* @__PURE__ */ new Map();
  var sfxExt = "";
  function pickSfxExt() {
    if (sfxExt) return sfxExt;
    const probe = document.createElement("audio");
    const tries = [
      ["ogg", "audio/ogg; codecs=opus"],
      ["webm", "audio/webm; codecs=opus"],
      ["mp3", "audio/mpeg"]
    ];
    for (const [ext, type] of tries) {
      if (probe.canPlayType && probe.canPlayType(type)) {
        sfxExt = ext;
        return ext;
      }
    }
    sfxExt = "webm";
    return sfxExt;
  }
  function ensureSfx() {
    if (!state.sfxCtx) state.sfxCtx = newAudioCtx();
  }
  function preloadSfx() {
    ensureSfx();
    const ctx = state.sfxCtx;
    if (!ctx) return;
    const ext = pickSfxExt();
    for (const name of SFX_NAMES) {
      if (sfxCache.has(name)) continue;
      fetch(`sfx/${name}.${ext}`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buffer) => {
        sfxCache.set(name, buffer);
        if (name === "lost" && state.lostWanted) startLost();
      }).catch(() => {
      });
    }
  }
  function playSfx(name) {
    if (!state.sounds) return;
    if (!state.sfxCtx || !SFX_NAMES.includes(name)) return;
    const ctx = state.sfxCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {
    });
    const buffer = sfxCache.get(name);
    if (!buffer) {
      return;
    }
    if (state.sfxSource) {
      stopQuietly(state.sfxSource);
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
    }
  }
  function startLost() {
    state.lostWanted = true;
    if (!state.sounds) return;
    if (state.lostSource) return;
    const ctx = state.sfxCtx;
    const buffer = sfxCache.get("lost");
    if (!ctx || !buffer) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {
    });
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
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
  function setSounds(on) {
    state.sounds = on;
    document.body.dataset.sounds = on ? "on" : "off";
    const box = $("sounds");
    if (box) box.checked = on;
    if (!on) {
      if (state.sfxSource) {
        stopQuietly(state.sfxSource);
        state.sfxSource = null;
      }
      const wanted = state.lostWanted;
      stopLost();
      state.lostWanted = wanted;
    } else if (state.lostWanted) {
      startLost();
    }
  }
  function stopLost() {
    state.lostWanted = false;
    const src = state.lostSource;
    state.lostSource = null;
    if (state.lostGain) {
      disconnectQuietly(state.lostGain);
      state.lostGain = null;
    }
    if (!src) return;
    stopQuietly(src);
    disconnectQuietly(src);
  }

  // src/identity.ts
  var ID_DB = "stanze-identity";
  var ID_CHALLENGE = "stanze identity";
  var ID_NOTE = {
    kept: "the identity is kept in this browser",
    fresh: "the stored identity could not be reopened: a new key for this page",
    session: "this browser keeps no identity: a new key each load, the device stays unverified"
  };
  var idDb = null;
  function idStore() {
    if (idDb) return idDb;
    idDb = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("no indexeddb"));
        return;
      }
      const req = indexedDB.open(ID_DB, 1);
      req.onupgradeneeded = () => {
        for (const name of ["id", "pins", "revoked"]) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("indexeddb refused"));
    });
    idDb.catch(() => {
      idDb = null;
    });
    return idDb;
  }
  function idbRequest(store2, mode, fn) {
    return idStore().then(
      (db) => new Promise((resolve, reject) => {
        const req = fn(db.transaction(store2, mode).objectStore(store2));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
    );
  }
  function idbGet(store2, key) {
    return idbRequest(store2, "readonly", (s) => s.get(key));
  }
  function idbAll(store2) {
    return idbRequest(store2, "readonly", (s) => s.getAll());
  }
  function idbPut(store2, key, value) {
    return idbRequest(store2, "readwrite", (s) => s.put(value, key));
  }
  function idbDelete(store2, key) {
    return idbRequest(store2, "readwrite", (s) => s.delete(key));
  }
  function fingerprint(pub) {
    const out = pqCall((json) => pqModule().idfp(json), { id: pub });
    return out && out.fp ? out.fp : "";
  }
  async function provesKey(pub, sign) {
    if (!pub || typeof sign !== "function") return false;
    const msg = b64e(sealUtf8.encode(ID_CHALLENGE));
    let sig = "";
    try {
      sig = await sign(msg);
    } catch {
    }
    const res = pqCall((json) => pqModule().idverify(json), { id: pub, msg, sig });
    return !!(res && res.ok);
  }
  function subtleIdentity(key, pub) {
    return {
      kind: "webcrypto",
      pub,
      fp: fingerprint(pub),
      sign: (msg) => crypto.subtle.sign({ name: "Ed25519" }, key, b64d(msg)).then(b64e),
      store: () => ({ kind: "webcrypto", key, pub })
    };
  }
  function seedIdentity(seed, pub, kind) {
    return {
      kind,
      pub,
      fp: fingerprint(pub),
      seed,
      sign: async (msg) => {
        const out = pqCall((json) => pqModule().idsign(json), { seed: b64e(seed), msg });
        return out && out.sig ? out.sig : "";
      },
      store: async () => {
        const wrap = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt"
        ]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrap, seed));
        return { kind: "sealed", wrap, iv, ct, pub };
      }
    };
  }
  function createIdentity() {
    return Promise.resolve().then(() => crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])).then(
      async (pair) => subtleIdentity(
        pair.privateKey,
        b64e(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
      )
    ).catch(() => {
      const made = pqCall((json) => pqModule().idgen(json), {});
      return made && made.pub && made.seed ? seedIdentity(b64d(made.seed), made.pub, "sealed") : null;
    });
  }
  async function reopenIdentity(rec) {
    if (!rec || !rec.pub) return null;
    let key = null;
    try {
      if (rec.kind === "webcrypto" && rec.key) {
        key = subtleIdentity(rec.key, rec.pub);
      } else if (rec.kind === "sealed" && rec.wrap && rec.iv && rec.ct) {
        const seed = new Uint8Array(
          await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, rec.wrap, rec.ct)
        );
        key = seedIdentity(seed, rec.pub, "sealed");
      }
    } catch {
      return null;
    }
    return key && await provesKey(rec.pub, key.sign) ? key : null;
  }
  function loadPins() {
    return Promise.all([idbAll("pins"), idbAll("revoked")]).then(([pins, revoked]) => {
      for (const rec of pins || []) if (rec && rec.label && rec.fp) state.pins.set(rec.label, rec);
      for (const rec of revoked || []) if (rec && rec.fp) state.revoked.set(rec.fp, rec);
    }).catch(() => {
    });
  }
  var identityLoad = null;
  function ensureIdentity() {
    if (identityLoad) return identityLoad;
    identityLoad = (async () => {
      await loadPins();
      let rec = null;
      try {
        rec = await idbGet("id", "self");
      } catch {
      }
      let key = await reopenIdentity(rec);
      if (key) {
        state.device = "kept";
      } else {
        key = await createIdentity();
        if (!key) throw new Error("no identity key");
        state.device = rec ? "fresh" : "kept";
        try {
          await idbPut("id", "self", await key.store());
          if (navigator.storage && typeof navigator.storage.persist === "function") {
            navigator.storage.persist().catch(() => {
            });
          }
        } catch {
          key.kind = "session";
          state.device = "session";
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
  function pinState(peer) {
    if (peer.pin === "changed") return "changed";
    if (!peer.fp) return "new";
    if (state.revoked.has(peer.fp)) return "rollback";
    for (const rec of state.pins.values()) if (rec.fp === peer.fp) return "known";
    return "new";
  }
  function pinLabelOf(peer) {
    for (const rec of state.pins.values()) if (rec.fp === peer.fp) return rec.label;
    return peer.pinLabel || "";
  }
  function pinPeer(peer, label) {
    if (!peer || !peer.fp) return "new";
    const name = String(label || pinLabelOf(peer) || peer.name || shortPeer(peer.id)).slice(0, 32);
    const held = state.pins.get(name);
    if (held && held.fp !== peer.fp) {
      peer.pin = "changed";
      peer.pinLabel = name;
      paintPin(peer);
      return "changed";
    }
    const now = Date.now();
    const rec = { label: name, fp: peer.fp, first: held ? held.first : now, last: now };
    state.pins.set(name, rec);
    idbPut("pins", name, rec).catch(() => {
    });
    if (state.revoked.has(peer.fp)) {
      state.revoked.delete(peer.fp);
      idbDelete("revoked", peer.fp).catch(() => {
      });
    }
    peer.pin = "";
    peer.pinLabel = name;
    paintPin(peer);
    return "known";
  }
  function renamePin(peer, label) {
    if (!peer || pinState(peer) !== "known") return "new";
    const old = pinLabelOf(peer);
    const name = String(label || "").trim().slice(0, 32);
    if (!name || name === old) return "known";
    const held = state.pins.get(name);
    if (held && held.fp !== peer.fp) return pinPeer(peer, name);
    const was = state.pins.get(old);
    state.pins.delete(old);
    idbDelete("pins", old).catch(() => {
    });
    const now = Date.now();
    state.pins.set(name, { label: name, fp: peer.fp, first: was ? was.first : now, last: now });
    idbPut("pins", name, state.pins.get(name)).catch(() => {
    });
    peer.pin = "";
    peer.pinLabel = name;
    paintPin(peer);
    return "known";
  }
  function resetDevice(peer, label) {
    const name = String(label || pinLabelOf(peer) || peer.name || shortPeer(peer.id)).slice(0, 32);
    const held = state.pins.get(name);
    if (held && held.fp && held.fp !== peer.fp) {
      const gone = { fp: held.fp, label: name, at: Date.now() };
      state.revoked.set(gone.fp, gone);
      idbPut("revoked", gone.fp, gone).catch(() => {
      });
      state.pins.delete(name);
      idbDelete("pins", name).catch(() => {
      });
    }
    peer.pin = "";
    const state_ = pinPeer(peer, name);
    if (!peer.proven) sealedRestart(peer, true);
    return state_;
  }
  function verifiedPeers() {
    let n = 0;
    for (const peer of state.peers.values()) if (peer.fp && pinState(peer) === "known") n++;
    return n;
  }
  function updatePinCount() {
    const el2 = $("pin-count");
    if (!el2) return;
    const total = state.peers.size;
    const known = verifiedPeers();
    const failed = sealedFailedPairs();
    const full = total > 0 && known === total && failed.length === 0;
    el2.hidden = total === 0;
    el2.textContent = total ? `verified ${known}/${total}` : "";
    el2.dataset.verified = full ? "all" : "part";
    $("stage").dataset.verified = full ? "all" : "part";
    if (total === 0) {
      el2.removeAttribute("title");
    } else if (failed.length > 0) {
      el2.title = "the keys do not match with " + sealedPairNames(failed) + ", so do not trust this call";
    } else {
      el2.title = `${known} of ${total} guests present an identity this browser pinned; each pair has its own code on its tile`;
    }
  }
  function paintPin(peer) {
    updatePinCount();
    paintState(peer);
    for (const host of [peer.tile, rowOf.get(peer.tile)]) refreshCodeCard(host, peer);
    const chip = peer.tile ? peer.tile.querySelector(".pin") : null;
    if (!chip) return;
    const what = pinState(peer);
    chip.hidden = !peer.fp;
    chip.dataset.pin = what === "rollback" ? "changed" : what;
    chip.textContent = what === "known" ? pinLabelOf(peer) : what === "changed" ? "identity changed" : what === "rollback" ? "old key came back" : "unverified";
    chip.title = peer.fp ? "identity " + peer.fp : "";
    const named = what === "known";
    chip.dataset.action = named ? "rename" : "";
    if (named) {
      chip.title = (chip.title ? chip.title + " | " : "") + "click to rename";
      chip.onclick = () => renamePin(peer, prompt("new name for this device", pinLabelOf(peer)) || "");
    } else {
      chip.onclick = null;
    }
  }
  async function storageAudit() {
    const out = { local: Object.keys(localStorage), stores: {}, keys: 0 };
    try {
      const db = await idStore();
      for (const name of db.objectStoreNames) {
        const rows = await idbAll(name);
        out.stores[name] = rows.map((row) => {
          const shape = {};
          for (const [k, v] of Object.entries(row || {})) {
            if (v instanceof Uint8Array) shape[k] = "bytes:" + v.length;
            else if (v && v.type) shape[k] = "key:" + v.type;
            else if (typeof v === "string") shape[k] = v.length > 40 ? "string:" + v.length : v;
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

  // src/asr.ts
  var ASR_MODELS = "/vosk/models";
  var ASR_LIB = "/vosk/vosk.js";
  var ASR_CACHE = "stanze-vosk";
  var ASR_LINE_MAX = 400;
  var OMNI_MODELS = "/omni/models";
  var OMNI_DIR = "/omni/";
  var OMNI_CACHE = "stanze-omni";
  var OMNI_MODEL = "model.int8.onnx";
  var OMNI_TOKENS = "tokens.txt";
  var OMNI_API = "sherpa-onnx-asr.js";
  var OMNI_GLUE = "sherpa-onnx-wasm-main-vad-asr.js";
  var asr = {
    probed: false,
    models: [],
    // [{ lang, file, size, modified }] as the server lists them
    lang: "",
    // the label the guest picked, empty until a pick
    engine: "",
    // 'vosk' or 'omni', the kept choice, see asrEngine
    busy: false,
    // a download or a start is under way
    on: false,
    abort: null,
    model: null,
    ctx: null,
    timer: 0,
    recs: /* @__PURE__ */ new Map(),
    // peer id -> { rec, proc, src, sink }
    lib: null
  };
  var omni = {
    probed: false,
    files: [],
    // [{ name, size, modified, sha256 }] as the server lists them
    model: null,
    // the one model entry, null when the engine is not offered
    size: 0,
    sha: "",
    stamp: "",
    // size, time and hash of the model, used as the cache key
    busy: false,
    // a download or a start is under way
    on: false,
    worker: null,
    url: "",
    // the worker blob, kept while the engine runs
    timer: 0,
    recs: /* @__PURE__ */ new Map()
    // peer id -> { proc, src, sink }
  };
  var asrStats = {
    engine: "",
    ready: false,
    initMs: null,
    segments: [],
    blocks: 0,
    peak: 0,
    decoded: 0
  };
  var mb = (n) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;
  function asrNote(text) {
    const el2 = $("asr-note");
    if (!el2) return;
    el2.textContent = text;
    el2.hidden = !text;
  }
  function asrPaintOthers() {
    if (asr.busy || asr.on || omni.busy || omni.on) return;
    const names = [...state.peers.values()].filter((p) => p.asr).map((p) => p.name || shortPeer(p.id));
    if (names.length) {
      asrNote(
        `${names.join(", ")} ${names.length > 1 ? "are" : "is"} transcribing this meeting. The text appears in the chat.`
      );
      return;
    }
    if (asrEngine() === "omni" && omni.size) {
      asrNote(
        `multilingual transcription: one model for every language, ${mb(omni.size)} on the first use.`
      );
      return;
    }
    asrNote("");
  }
  async function asrProbe() {
    if (asr.probed) return;
    asr.probed = true;
    let list = [];
    try {
      const res = await fetch(ASR_MODELS, { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        list = body && Array.isArray(body.langs) ? body.langs : [];
      }
    } catch {
    }
    asr.models = list.filter((m) => m && typeof m.file === "string" && m.file);
    if (asr.models.length) asrPick(asrDefaultLang());
    asrOffers();
  }
  async function omniProbe() {
    if (omni.probed) return;
    omni.probed = true;
    let list = [];
    try {
      const res = await fetch(OMNI_MODELS, { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        list = body && Array.isArray(body.files) ? body.files : [];
      }
    } catch {
    }
    omni.files = list.filter((f) => f && typeof f.name === "string" && f.name);
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
    omni.sha = String(omni.model.sha256 || "");
    omni.stamp = `${omni.size}-${Number(omni.model.modified) || 0}-${omni.sha.slice(0, 8)}`;
    asrOffers();
  }
  function asrOffers() {
    if (!asr.models.length && !omni.model) return;
    asrSetEngine(asrEngine(), false);
    const entry = document.getElementById("menu-asr-btn");
    if (entry) entry.hidden = false;
  }
  function asrEngine() {
    const kept = asr.engine || load("asr.engine");
    if (kept === "omni" && omni.model) return "omni";
    if (kept === "vosk" && asr.models.length) return "vosk";
    if (asr.models.length) return "vosk";
    if (omni.model) return "omni";
    return "";
  }
  function asrSetEngine(name, keep) {
    const engine = name === "omni" && omni.model ? "omni" : name === "vosk" && asr.models.length ? "vosk" : asrEngine();
    if (keep !== false) {
      asr.engine = engine;
      store("asr.engine", engine);
    }
    if (engine === "vosk" && asr.models.length) asrPick(asr.lang || asrDefaultLang());
    asrPaintLangRow();
    asrPaintEntry();
    asrPaintOthers();
  }
  function asrChoices() {
    const list = asr.models.map((m) => ({
      value: `vosk:${m.lang}`,
      text: m.size ? `${m.lang} (${mb(m.size)})` : m.lang
    }));
    if (omni.model) {
      list.push({
        value: "omni",
        text: omni.size ? `omni, every language (${mb(omni.size)})` : "omni, every language"
      });
    }
    return list;
  }
  function asrChoice() {
    if (asrEngine() === "omni") return "omni";
    const model = asrModel();
    return model ? `vosk:${model.lang}` : "";
  }
  function asrChoose(value) {
    if (value === "omni") {
      asrSetEngine("omni");
      return;
    }
    if (value.startsWith("vosk:")) {
      asrSetEngine("vosk");
      asrPick(value.slice("vosk:".length));
    }
  }
  function asrPaintLangRow() {
    const select = $("asr-lang");
    if (!select) return;
    const choices = asrChoices();
    const value = asrChoice();
    select.replaceChildren(
      ...choices.map((choice) => {
        const o = document.createElement("option");
        o.value = choice.value;
        o.textContent = choice.text;
        o.selected = choice.value === value;
        return o;
      })
    );
    select.value = value;
    select.hidden = choices.length < 2;
    const row = select.closest(".menu-item");
    if (row) row.hidden = choices.length < 2;
  }
  function asrPaintEntry() {
    const btn = $("menu-asr-btn");
    if (!btn) return;
    if (asrEngine() === "omni") {
      btn.title = `transcription, every language, ${omni.size ? mb(omni.size) : "one model"}`;
      return;
    }
    const model = asrModel();
    if (model) btn.title = `transcription, language ${model.lang}, ${mb(model.size)}`;
  }
  function asrDefaultLang() {
    const have = asr.models.map((m) => m.lang);
    const kept = load("asr.lang");
    if (kept && have.includes(kept)) return kept;
    const want = String(navigator.language || "").toLowerCase().slice(0, 2);
    if (want && have.includes(want)) return want;
    return have[0];
  }
  function asrModel() {
    return asr.models.find((m) => m.lang === asr.lang) || asr.models[0] || null;
  }
  function asrPick(lang) {
    const model = asr.models.find((m) => m.lang === lang) || asr.models[0];
    if (!model) return;
    asr.lang = model.lang;
    store("asr.lang", model.lang);
    asrPaintLangRow();
    const btn = $("menu-asr-btn");
    if (btn) asrPaintEntry();
  }
  function asrCacheKey() {
    const model = asrModel();
    const file = model ? model.file : "";
    const stamp = model ? `${model.size}-${model.modified}` : "";
    return new Request(`${location.origin}/vosk/${file}?m=${encodeURIComponent(stamp)}`);
  }
  async function asrCached() {
    try {
      if (!window.caches) return null;
      const cache = await caches.open(ASR_CACHE);
      const hit = await cache.match(asrCacheKey());
      return hit ? await hit.blob() : null;
    } catch {
      return null;
    }
  }
  async function asrFetchModel(signal) {
    const model = asrModel();
    if (!model) throw new Error("no model is on offer");
    const res = await fetch(`/vosk/${model.file}`, { signal, cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
    const total = model.size || parseInt(res.headers.get("content-length") || "0", 10) || 0;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      asrNote(
        total ? `downloading the transcription model: ${mb(got)} of ${mb(total)} (${Math.floor(got * 100 / total)}%)` : `downloading the transcription model: ${mb(got)}`
      );
    }
    const blob = new Blob(parts, { type: "application/gzip" });
    try {
      if (window.caches) {
        await caches.delete(ASR_CACHE);
        const cache = await caches.open(ASR_CACHE);
        await cache.put(
          asrCacheKey(),
          new Response(blob, { headers: { "content-type": "application/gzip" } })
        );
      }
    } catch {
    }
    return blob;
  }
  function asrLoadLib() {
    if (asr.lib) return asr.lib;
    asr.lib = new Promise((resolve, reject) => {
      const have = window.Vosk;
      if (have) return resolve(have);
      const el2 = document.createElement("script");
      el2.src = scriptURL(ASR_LIB);
      el2.onload = () => {
        const lib = window.Vosk;
        return lib ? resolve(lib) : reject(new Error("the engine did not load"));
      };
      el2.onerror = () => reject(new Error("the engine could not be loaded"));
      document.head.appendChild(el2);
    }).catch((err) => {
      asr.lib = null;
      throw err;
    });
    return asr.lib;
  }
  function asrSay(obj) {
    toSealed({ k: "asr", ...obj });
  }
  function asrAnnounce(peer) {
    if (!asr.on && !omni.on || !peer.keys || peer.waiting) return;
    sealedSend(peer, { k: "asr", s: "on" });
  }
  function tapVoice(peer, onBlock) {
    const ctx = state.playCtx;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (event) => onBlock(event.inputBuffer.getChannelData(0));
    const sink = ctx.createGain();
    sink.gain.value = 0;
    peer.audioSrc.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    return { proc, src: peer.audioSrc, sink };
  }
  function untapVoice(recs, id) {
    const h = recs.get(id);
    if (!h) return null;
    recs.delete(id);
    try {
      h.src.disconnect(h.proc);
    } catch {
    }
    disconnectQuietly(h.proc);
    disconnectQuietly(h.sink);
    h.proc.onaudioprocess = null;
    return h;
  }
  function sayLine(who, text) {
    const line = text.slice(0, ASR_LINE_MAX);
    if (!line) return;
    addChatLine(`transcript by ${state.name || "you"}`, `${who}: ${line}`, Date.now());
    asrSay({ w: who.slice(0, 64), x: line, ts: Date.now() });
  }
  function tapReady(recs, peer, untap) {
    const have = recs.get(peer.id);
    if (have && have.src === peer.audioSrc) return false;
    if (have) untap(peer.id);
    return true;
  }
  function asrTap(peer) {
    const ctx = state.playCtx;
    if (!asr.on || !asr.model || !ctx || !peer.audioSrc) return;
    if (!tapReady(asr.recs, peer, asrUntap)) return;
    const rec = new asr.model.KaldiRecognizer(ctx.sampleRate);
    const speaker = () => peer.name || shortPeer(peer.id);
    rec.on("result", (message) => {
      const text = String(message.result && message.result.text || "").trim();
      if (!text || !asr.on) return;
      sayLine(speaker(), text);
    });
    const tap = tapVoice(peer, (block) => {
      try {
        rec.acceptWaveformFloat(new Float32Array(block), ctx.sampleRate);
      } catch {
      }
    });
    asr.recs.set(peer.id, { rec, proc: tap.proc, src: tap.src, sink: tap.sink });
  }
  function asrUntap(id) {
    const h = untapVoice(asr.recs, id);
    if (!h) return;
    try {
      h.rec.retrieveFinalResult();
    } catch {
    }
    setTimeout(() => {
      try {
        h.rec.remove();
      } catch {
      }
    }, 1500);
  }
  function syncTaps(engine, tap, untap) {
    if (!engine.on) return;
    for (const id of [...engine.recs.keys()]) {
      const peer = state.peers.get(id);
      if (!peer || peer.waiting) untap(id);
    }
    for (const peer of state.peers.values()) {
      if (!peer.waiting) tap(peer);
    }
  }
  function asrSync() {
    syncTaps(asr, asrTap, asrUntap);
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
      setTimeout(() => {
        try {
          model.terminate();
        } catch {
        }
      }, 2e3);
      asr.model = null;
    }
    asr.busy = false;
    asrStopped(was);
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
        const size = model && model.size ? mb(model.size) : "a large file";
        if (!window.confirm(
          `Transcription runs in this tab and needs a one-time download of ${size}. The model is kept in the browser cache. Download it now?`
        )) {
          asrStop();
          return;
        }
        blob = await asrFetchModel(signal);
      }
      if (signal.aborted) return;
      asrNote("starting the transcription engine");
      const Vosk = await asrLoadLib();
      const url = URL.createObjectURL(blob);
      try {
        asr.model = await Vosk.createModel(url);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1e3);
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
      asrNote(
        "You transcribe this meeting. The text goes to the chat under your name, and your own voice is not transcribed."
      );
      asrSay({ s: "on" });
      asrSync();
      asr.timer = setInterval(asrSync, 2e3);
    } catch (err) {
      if (signal.aborted) return;
      asrStop();
      asrNote(
        `Transcription could not start: ${err && err.message ? err.message : "the download failed"}. The call is not affected.`
      );
    }
  }
  function paintAsr() {
    const box = $("asr-on");
    if (!box) return;
    const engine = asrEngine();
    const busy = engine === "omni" ? omni.busy : asr.busy;
    box.checked = busy || (engine === "omni" ? omni.on : asr.on);
    box.disabled = false;
  }
  function initAsr() {
    const box = $("asr-on");
    if (!box) return;
    box.addEventListener("change", () => {
      if (!box.checked) {
        asrStop();
        omniStop();
      } else if (asrEngine() === "omni") {
        omniStart();
      } else {
        asrStart();
      }
    });
    const select = $("asr-lang");
    if (select) {
      select.addEventListener("change", () => {
        const was = asr.on || omni.on;
        asrStop();
        omniStop();
        asrChoose(select.value);
        paintAsr();
        if (!was) return;
        if (asrEngine() === "omni") omniStart();
        else asrStart();
      });
    }
  }
  function asrOnMessage(peer, obj) {
    const name = peer.name || shortPeer(peer.id);
    if (obj.s === "on" || obj.s === "off") {
      peer.asr = obj.s === "on";
      if (peer.asr) addChatLine("stanze", `${name} started transcribing this meeting`, Date.now());
      asrPaintOthers();
      return;
    }
    const text = String(obj.x || "").slice(0, ASR_LINE_MAX);
    const who = String(obj.w || "").slice(0, 64);
    if (!text) return;
    state.chatRecv++;
    addChatLine(`transcript by ${name}`, `${who}: ${text}`, Date.now());
  }
  async function omniStart() {
    if (omni.busy || omni.on || !omni.model) return;
    if (!window.crossOriginIsolated) {
      asrNote(
        "The multilingual engine needs a cross-origin isolated page. The call is not affected."
      );
      paintAsr();
      return;
    }
    const size = omni.size ? mb(omni.size) : "a large file";
    let tight = false;
    try {
      if (navigator.storage && navigator.storage.persist) {
        Promise.resolve(navigator.storage.persist()).catch(() => {
        });
      }
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      tight = !!(est && est.quota && est.quota - est.usage < omni.size);
    } catch {
    }
    const keep = tight ? "The browser has less free storage than that, so the model cannot be kept and the next visit downloads it again." : "The model is kept in the browser cache, so this is the only download.";
    if (!window.confirm(
      `Multilingual transcription runs in this tab and needs a one-time download of ${size}. ${keep} Download it now?`
    )) {
      paintAsr();
      return;
    }
    omni.busy = true;
    paintAsr();
    asrNote(`starting the multilingual engine: one model for every language, ${size}`);
    try {
      omni.worker = omniSpawn();
    } catch (err) {
      omniFail(
        `the engine could not start: ${err && err.message ? err.message : "the worker was refused"}`
      );
    }
  }
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
      stamp: omni.stamp
    };
    const url = URL.createObjectURL(new Blob([omniWorkerSource(cfg)], { type: "text/javascript" }));
    const worker = new Worker(scriptURL(url));
    omni.url = url;
    worker.onmessage = (event) => omniOnWorker(event.data || {});
    worker.onerror = (event) => omniFail(event.message || "the engine stopped");
    return worker;
  }
  function omniOnWorker(msg) {
    if (!omni.busy && !omni.on) return;
    switch (msg.ev) {
      case "status":
        if (omni.busy) asrNote(String(msg.text || "starting the multilingual engine"));
        return;
      case "progress":
        omniProgress(msg);
        return;
      case "ready":
        if (!omni.busy) return;
        omni.busy = false;
        omni.on = true;
        asrStats.engine = "omni";
        asrStats.ready = true;
        asrStats.initMs = Number(msg.ms) || null;
        paintAsr();
        asrNote(
          "You transcribe this meeting. The text goes to the chat under your name, and your own voice is not transcribed."
        );
        asrSay({ s: "on" });
        omniSync();
        omni.timer = setInterval(omniSync, 2e3);
        return;
      case "decoded":
        asrStats.decoded++;
        return;
      case "line": {
        const ms = Number(msg.ms);
        const sec = Number(msg.sec);
        if (Number.isFinite(ms) && ms > 0 && sec > 0) {
          asrStats.segments.push({ ms, audioSec: sec });
          if (asrStats.segments.length > 8) asrStats.segments.shift();
        }
        omniLine(String(msg.id || ""), String(msg.text || ""));
        return;
      }
      case "error":
        omniFail(String(msg.text || "the engine stopped"));
        return;
      default:
        return;
    }
  }
  function omniProgress(msg) {
    if (!omni.busy) return;
    const total = Number(msg.total) || omni.size;
    const got = Number(msg.got) || 0;
    const where = msg.cached ? "reading the transcription model from the browser cache" : "downloading the transcription model";
    asrNote(
      total ? `${where}: ${mb(got)} of ${mb(total)} (${Math.floor(got * 100 / total)}%)` : `${where}: ${mb(got)}`
    );
  }
  function omniFail(text) {
    const was = omni.on;
    omniStop();
    asrNote(
      was ? `Transcription stopped: ${text}. The call is not affected.` : `Transcription could not start: ${text}. The call is not affected.`
    );
  }
  function omniStop() {
    const was = omni.on;
    omni.on = false;
    omni.busy = false;
    asrStats.engine = "";
    asrStats.ready = false;
    clearInterval(omni.timer);
    omni.timer = 0;
    for (const id of [...omni.recs.keys()]) omniUntap(id);
    if (omni.worker) {
      try {
        omni.worker.terminate();
      } catch {
      }
      omni.worker = null;
    }
    if (omni.url) {
      try {
        URL.revokeObjectURL(omni.url);
      } catch {
      }
      omni.url = "";
    }
    asrStopped(was);
  }
  function asrStopped(was) {
    if (was) asrSay({ s: "off" });
    paintAsr();
    asrNote("");
    asrPaintOthers();
  }
  function omniTap(peer) {
    const ctx = state.playCtx;
    if (!omni.on || !omni.worker || !ctx || !peer.audioSrc) return;
    if (!tapReady(omni.recs, peer, omniUntap)) return;
    const id = peer.id;
    const worker = omni.worker;
    const tap = tapVoice(peer, (block) => {
      if (!omni.on || omni.worker !== worker) return;
      asrStats.blocks++;
      let top = 0;
      for (let i = 0; i < block.length; i++) {
        const v = block[i] < 0 ? -block[i] : block[i];
        if (v > top) top = v;
      }
      if (top > asrStats.peak) asrStats.peak = top;
      const samples = omniDown(block, ctx.sampleRate);
      if (!samples.length) return;
      try {
        worker.postMessage({ cmd: "audio", id, samples }, [samples.buffer]);
      } catch {
      }
    });
    omni.recs.set(id, { proc: tap.proc, src: tap.src, sink: tap.sink });
  }
  function omniUntap(id) {
    untapVoice(omni.recs, id);
  }
  function omniSync() {
    syncTaps(omni, omniTap, omniUntap);
  }
  function omniDown(input, rate) {
    if (rate === 16e3) return new Float32Array(input);
    const ratio = rate / 16e3;
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
  function omniLine(id, text) {
    if (!omni.on) return;
    const peer = state.peers.get(id);
    sayLine(peer ? peer.name || shortPeer(id) : shortPeer(id), text);
  }
  function omniWorkerSource(cfg) {
    return `(${omniWorker.toString()})(${JSON.stringify(cfg)});`;
  }
  function omniWorker(cfg) {
    const G = self;
    function bootWasm() {
      G.Module = {
        // The wasm and its threads live under /omni/. The base is absolute, as a blob
        // worker has no useful directory of its own.
        locateFile: (path) => cfg.base + path,
        print: (text) => {
          if (text) console.log("[omni] " + text);
        },
        printErr: (text) => {
          if (text) console.warn("[omni] " + text);
        },
        onAbort: (why) => G.postMessage({ ev: "error", text: String(why || "the engine stopped") })
      };
      G.importScripts(cfg.api, cfg.glue);
      return !/^em-pthread/.test(G.name || "");
    }
    if (!bootWasm()) return;
    const RATE = 16e3;
    const FRAME = 1600;
    const THRESHOLD = 0.012;
    const TAIL = 4;
    const PRE = 3;
    const MAXLEN = RATE * 30;
    const PART = 32 * 1048576;
    const post = (msg, transfer = []) => G.postMessage(msg, transfer);
    const progress = (got, cached) => post({ ev: "progress", got, total: cfg.size, cached });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const join = (parts, len) => {
      const all = new Float32Array(len);
      let at = 0;
      for (const part of parts) {
        all.set(part, at);
        at += part.length;
      }
      return all;
    };
    const segs = /* @__PURE__ */ new Map();
    const queue = [];
    let rec = null;
    let decoding = false;
    let lastProgress = 0;
    function short(err) {
      const text = String(err && err.message || err || "the engine stopped");
      return text.slice(0, 200);
    }
    function hex(bytes) {
      let out = "";
      for (let i = 0; i < bytes.length; i += 4096) {
        const end = Math.min(i + 4096, bytes.length);
        for (let j = i; j < end; j++) out += bytes[j].toString(16).padStart(2, "0");
      }
      return out;
    }
    async function hash(bytes) {
      if (!G.crypto || !G.crypto.subtle) return "";
      const sum = await G.crypto.subtle.digest("SHA-256", bytes);
      return hex(new Uint8Array(sum));
    }
    function partKey(index) {
      return `${cfg.base}${cfg.modelName}?part=${index}&m=${encodeURIComponent(cfg.stamp)}`;
    }
    async function hashOk(bytes) {
      if (!cfg.sha) return true;
      const sum = await hash(bytes);
      if (!sum || sum === cfg.sha) return true;
      try {
        await G.caches.delete(cfg.cache);
      } catch {
      }
      return false;
    }
    async function readParts(cache, first, bytes) {
      const count = Math.ceil(cfg.size / PART);
      try {
        for (let i = 0; i < count; i++) {
          const hit = i === 0 ? first : await cache.match(partKey(i));
          if (!hit) return false;
          const body = new Uint8Array(await hit.arrayBuffer());
          const at = i * PART;
          if (body.length !== Math.min(PART, cfg.size - at)) return false;
          bytes.set(body, at);
        }
      } catch {
        return false;
      }
      return true;
    }
    async function fromCache() {
      if (!G.caches || !cfg.size) return null;
      let cache;
      let first;
      try {
        cache = await G.caches.open(cfg.cache);
        first = await cache.match(partKey(0));
      } catch {
        return null;
      }
      if (!first) return null;
      progress(0, true);
      const bytes = new Uint8Array(cfg.size);
      if (!await readParts(cache, first, bytes)) return null;
      if (!await hashOk(bytes)) return null;
      progress(cfg.size, true);
      return bytes;
    }
    async function putPart(cache, index, body) {
      try {
        await cache.put(partKey(index), new Response(body));
        return cache;
      } catch {
        return null;
      }
    }
    async function fromNetwork() {
      const res = await fetch(cfg.modelUrl, { cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
      const bytes = new Uint8Array(cfg.size);
      let cache = null;
      try {
        if (G.caches) cache = await G.caches.open(cfg.cache);
      } catch {
        cache = null;
      }
      const reader = res.body.getReader();
      let got = 0;
      let part = 0;
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > cfg.size)
          throw new Error("the server sent more than the model size");
        bytes.set(value, got);
        got += value.length;
        if (got - lastProgress >= 2097152) {
          lastProgress = got;
          progress(got, false);
        }
        while (cache && got - part * PART >= PART) {
          const at = part * PART;
          cache = await putPart(cache, part, bytes.subarray(at, at + PART));
          part++;
        }
      }
      if (got !== cfg.size) {
        throw new Error(
          `the download stopped at ${Math.round(got / 1048576)} of ${Math.round(cfg.size / 1048576)} MB`
        );
      }
      if (cache && part * PART < cfg.size) {
        const at = part * PART;
        await putPart(cache, part, bytes.subarray(at, cfg.size));
      }
      progress(cfg.size, false);
      if (!await hashOk(bytes)) throw new Error("the model did not match its hash");
      return bytes;
    }
    function mount(name, bytes) {
      try {
        G.Module.FS_unlink("/" + name);
      } catch {
      }
      G.Module.FS_createDataFile("/", name, bytes, true, true, true);
    }
    async function waitRuntime() {
      const t0 = performance.now();
      while (!G.Module.calledRun) {
        if (performance.now() - t0 > 18e4) throw new Error("the engine never started");
        await sleep(50);
      }
    }
    async function loadModel() {
      const bytes = await fromCache();
      if (bytes) return bytes;
      post({ ev: "status", text: "downloading the model" });
      return fromNetwork();
    }
    async function loadTokens() {
      const res = await fetch(cfg.tokensUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`the token table answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    function startRecognizer() {
      const config = {
        featConfig: { sampleRate: RATE, featureDim: 80 },
        modelConfig: {
          omnilingual: { model: "./" + cfg.modelName },
          tokens: "./" + cfg.tokensName,
          numThreads: 1,
          provider: "cpu",
          debug: 0,
          modelType: ""
        },
        decodingMethod: "greedy_search"
      };
      rec = new OfflineRecognizer(config, G.Module);
      if (!rec || !rec.handle) throw new Error("the recognizer did not start");
    }
    async function start() {
      const t0 = performance.now();
      post({ ev: "status", text: "starting the engine" });
      await waitRuntime();
      post({ ev: "status", text: "loading the model" });
      const bytes = await loadModel();
      const tokens = await loadTokens();
      mount(cfg.modelName, bytes);
      mount(cfg.tokensName, tokens);
      post({ ev: "status", text: "starting the recognizer" });
      startRecognizer();
      post({ ev: "ready", ms: Math.round(performance.now() - t0) });
      pump();
    }
    function rms(frame2) {
      let sum = 0;
      for (let i = 0; i < frame2.length; i++) sum += frame2[i] * frame2[i];
      return Math.sqrt(sum / frame2.length);
    }
    function begin() {
      return { rest: new Float32Array(0), pre: [], samples: [], len: 0, speech: false, quiet: 0 };
    }
    function flush(id, st) {
      const parts = st.samples;
      const len = st.len;
      st.samples = [];
      st.len = 0;
      st.speech = false;
      st.quiet = 0;
      if (len < RATE / 2) return;
      const all = join(parts, len);
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
      if (loud) st.quiet = 0;
      else st.quiet++;
      if (st.quiet < TAIL && st.len < MAXLEN) return;
      while (st.quiet > 0 && st.samples.length > 1) {
        st.len -= st.samples.pop().length;
        st.quiet--;
      }
      flush(id, st);
    }
    function pushAudio(id, samples) {
      let st = segs.get(id);
      if (!st) {
        st = begin();
        segs.set(id, st);
      }
      const all = join([st.rest, samples], st.rest.length + samples.length);
      let at = 0;
      for (; all.length - at >= FRAME; at += FRAME) frame(id, st, all.subarray(at, at + FRAME));
      st.rest = all.subarray(at);
    }
    function pump() {
      if (decoding || !rec || queue.length === 0) return;
      const job = queue.shift();
      decoding = true;
      const t0 = performance.now();
      let text;
      try {
        const stream = rec.createStream();
        stream.acceptWaveform(RATE, job.samples);
        rec.decode(stream);
        text = String((rec.getResult(stream) || {}).text || "").trim();
        stream.free();
      } catch (err) {
        post({ ev: "error", text: short(err) });
        return;
      } finally {
        decoding = false;
      }
      const ms = Math.round(performance.now() - t0), sec = job.samples.length / RATE;
      post({ ev: "decoded", ms, sec, len: text.length });
      if (text) post({ ev: "line", id: job.id, text, ms, sec });
      setTimeout(pump, 0);
    }
    function listen() {
      G.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.cmd === "audio" && rec && msg.samples) pushAudio(String(msg.id || ""), msg.samples);
      };
    }
    listen();
    start().catch((err) => post({ ev: "error", text: short(err) }));
  }

  // src/handshake.ts
  function sealedSendPub(peer) {
    if (!state.identity || !state.idKey) return;
    const bundle = {
      k: "pub",
      x: state.identity.xpub,
      m: state.identity.ek,
      id: state.idKey.pub,
      sid: state.sid
    };
    if (peer) sealedSendOpaque(peer.id, bundle);
    else send({ t: "enc", b: encOpaque(bundle) });
  }
  function sealedRefuse(peer, why) {
    if (!state.peers.has(peer.id)) return;
    state.identityFailures++;
    if (peer.pc) {
      peer.pc.close();
      peer.pc = null;
    }
    wipeKeys(peer);
    sealedSetE2E(peer, "failed");
    say(shortPeer(peer.id) + " " + why + "; the link stays closed");
    updatePinCount();
  }
  function sealedRefusePass(peer) {
    sealedRefuse(peer, "does not know the room passphrase");
    if (state.waiting) {
      setTimeout(() => leave("the room refused the passphrase"), 0);
      return;
    }
    if (!isAdmin(state.self) || isAdmin(peer.id)) return;
    sealedKick(peer.id);
  }
  function sealedRestart(peer, resend) {
    peer.gen = ++state.keyGen;
    const waiting = state.keyWait.get(pairLabel(peer.id));
    if (waiting) {
      state.keyWait.delete(pairLabel(peer.id));
      waiting.resolve(false);
    }
    wipeKeys(peer);
    peer.pub = null;
    peer.transcript = null;
    peer.sas = "";
    peer.confirmed = false;
    peer.myConfirm = "";
    peer.mySig = "";
    peer.sentConfirm = false;
    peer.fp = "";
    peer.proven = false;
    peer.ready = "";
    peer.keyPromise = null;
    peer.seqOut = 0;
    peer.seqIn = 0;
    peer.announcedName = "";
    peer.appPending = [];
    peer.appHeld = [];
    peer.pass = null;
    peer.passEarly = [];
    peer.ctlPending = [];
    fileDropPeer(peer);
    if (peer.pc) {
      peer.pc.close();
      peer.pc = null;
    }
    if (peer.tile) peer.tile.dataset.sas = "";
    sealedSetE2E(peer, "new");
    if (resend) sealedSendPub(peer);
  }
  function sealedOnPub(peer, msg) {
    if (peer.pub && peer.pub.sid && msg.sid && peer.pub.sid !== msg.sid) sealedRestart(peer, false);
    peer.pub = { x: msg.x, m: msg.m, id: msg.id || "", sid: msg.sid || "" };
    if (!peer.pub.id || !peer.pub.sid) {
      sealedRefuse(peer, "sent no identity");
      return;
    }
    if (!peer.keys && !peer.keyPromise && String(state.self) < String(peer.id)) {
      sealedInitiate(peer).catch(() => sealedRefuse(peer, "handshake failed"));
    }
    sealedDrainCtl(peer);
  }
  function sealedProved(peer) {
    peer.proven = true;
    peer.fp = fingerprint(peer.pub.id);
    paintPin(peer);
    peer.vol = storedVolume(peer);
    paintVolume(peer);
    rememberInside(peer);
    asrAnnounce(peer);
  }
  function rememberInside(peer) {
    if (peer.fp && !peer.waiting) state.insideFps.add(peer.fp);
  }
  function wipeKeys(peer) {
    if (!peer || !peer.keys) return;
    for (const value of Object.values(peer.keys)) {
      if (value instanceof Uint8Array) value.fill(0);
    }
    peer.keys = null;
    peer.keysInstalled = false;
  }
  function wipeIdentity() {
    if (!state.identity) return;
    for (const name of ["xsk", "dk"]) {
      const value = state.identity[name];
      if (value instanceof Uint8Array) value.fill(0);
    }
    state.identity = null;
  }
  function sealedHoldKeys(peer, out) {
    wipeKeys(peer);
    peer.keys = {
      sendMedia: b64d(out.keys.sendMedia),
      recvMedia: b64d(out.keys.recvMedia),
      sendChat: b64d(out.keys.sendChat),
      recvChat: b64d(out.keys.recvChat)
    };
    peer.transcript = out.transcript;
    peer.seqOut = 0;
    peer.seqIn = 0;
    peer.sas = out.keys.sas;
    peer.myConfirm = out.confirm;
    peer.ready = "handshake";
    if (peer.tile) peer.tile.dataset.sas = peer.sas;
    sealedSetE2E(peer, "handshake");
  }
  function sealedInstallKeys(peer) {
    peer.keysInstalled = true;
    const gen = peer.gen = ++state.keyGen;
    const pair = pairLabel(peer.id);
    return new Promise((resolve) => {
      if (!state.worker) {
        state.workerErrors.push("sealed worker missing");
        resolve(false);
        return;
      }
      state.keyWait.set(pair, { gen, resolve });
      state.worker.postMessage({
        type: "keys",
        pair,
        peer: peer.id,
        gen,
        enc: b64e(peer.keys.sendMedia),
        dec: b64e(peer.keys.recvMedia)
      });
    });
  }
  function sealedProve(peer, msg) {
    return pqCall((json) => pqModule().proved(json), {
      key: b64e(peer.keys.recvMedia),
      transcript: peer.transcript,
      tag: msg.c || "",
      id: msg.id || "",
      sig: msg.sig || ""
    });
  }
  function sealedPair(peer) {
    return {
      self: state.self,
      peer: peer.id,
      selfX: state.identity.xpub,
      selfK: state.identity.ek,
      selfID: state.idKey.pub,
      selfSID: state.sid,
      peerX: peer.pub.x,
      peerK: peer.pub.m,
      peerID: peer.pub.id,
      peerSID: peer.pub.sid
    };
  }
  async function sealedSigned(peer, out) {
    const sig = await state.idKey.sign(out.transcript);
    if (!state.peers.has(peer.id) || state.leaving) return "";
    if (!sig) {
      sealedRefuse(peer, "could not sign the handshake");
      return "";
    }
    sealedHoldKeys(peer, out);
    peer.mySig = sig;
    return sig;
  }
  function sealedSendOk(peer, out) {
    peer.sentConfirm = true;
    sealedSendOpaque(peer.id, {
      k: "ok",
      c: out.confirm,
      id: state.idKey.pub,
      sid: state.sid,
      sig: peer.mySig
    });
  }
  async function sealedInitiate(peer) {
    if (!state.identity || !state.idKey || !peer.pub) return;
    const out = pqCall((json) => pqModule().initiate(json), sealedPair(peer));
    if (!out || out.error) {
      sealedRefuse(peer, "refused the key bundle");
      return;
    }
    const sig = await sealedSigned(peer, out);
    if (!sig) return;
    sealedSendOpaque(peer.id, {
      k: "hello",
      epk: out.epk,
      ct: out.ct,
      id: state.idKey.pub,
      sid: state.sid,
      sig
    });
    sealedSendOk(peer, out);
  }
  async function sealedRespond(peer, msg) {
    if (!state.identity || !state.idKey || !peer.pub) return;
    if (msg.id !== peer.pub.id || msg.sid !== peer.pub.sid) {
      sealedRefuse(peer, "sent a hello for another identity");
      return;
    }
    const out = pqCall((json) => pqModule().respond(json), {
      ...sealedPair(peer),
      selfSK: b64e(state.identity.xsk),
      selfDK: b64e(state.identity.dk),
      epk: msg.epk,
      ct: msg.ct,
      sig: msg.sig || ""
    });
    if (!out || out.error) {
      sealedRefuse(peer, "refused the hello");
      return;
    }
    if (!await sealedSigned(peer, out)) return;
    sealedSendOk(peer, out);
    sealedDrainCtl(peer);
  }
  async function sealedOnProof(peer, msg) {
    if (!peer.keys || !peer.pub || !peer.transcript) return;
    if (peer.confirmed) return;
    if (msg.id !== peer.pub.id || msg.sid !== peer.pub.sid) {
      return;
    }
    const res = sealedProve(peer, msg);
    if (!res || !res.ok) {
      const why = res && res.error ? res.error : "the proof did not check out";
      if (/confirmation tag/.test(why)) {
        state.confirmFailures++;
        sealedSetE2E(peer, "failed");
        say("key confirmation failed for " + shortPeer(peer.id) + ": keys do not match");
        return;
      }
      sealedRefuse(peer, "did not prove its identity");
      return;
    }
    peer.confirmed = true;
    sealedProved(peer);
    const pin = pinState(peer);
    if (pin === "rollback" || pin === "changed") {
      sealedRefuse(
        peer,
        pin === "rollback" ? "came back with an identity this browser revoked" : "proved an identity another label here holds"
      );
      return;
    }
    if (state.kickedFps.has(peer.fp)) {
      sealedRefuse(peer, "was removed from this room");
      return;
    }
    peer.keyPromise = sealedInstallKeys(peer);
    sealedSetE2E(peer, "ready");
    Promise.resolve(peer.keyPromise).then((ok) => {
      if (!ok || !state.peers.has(peer.id) || state.leaving) return;
      sealedFlushApp(peer);
      sealedStartPass(peer);
    });
  }
  function sealedFlushApp(peer) {
    const held = peer.appPending || [];
    peer.appPending = [];
    for (const msg of held) sealedHandleOpaque(peer.id, encOpaque(msg));
  }
  function sealedStartPass(peer) {
    if (!state.w) {
      sealedRefuse(peer, "this page holds no room key");
      return;
    }
    const first = String(state.self) < String(peer.id);
    const a = b64e(sealUtf8.encode(first ? state.self : peer.id));
    const b = b64e(sealUtf8.encode(first ? peer.id : state.self));
    const out = pqCall((json) => pqModule().spakestart(json), {
      w: state.w,
      role: first ? "A" : "B",
      a,
      b
    });
    if (!out || !out.id) {
      sealedRefuse(peer, "the room key could not be used");
      return;
    }
    peer.pass = { id: out.id, mine: "", peerOk: false, finished: false, done: false };
    sealedSend(peer, { k: "spake", m: out.msg });
    sealedDrainPass(peer);
  }
  function sealedDrainPass(peer) {
    const held = peer.passEarly || [];
    peer.passEarly = [];
    for (const msg of held) sealedOnPassFrame(peer, msg);
  }
  function sealedOnPassFrame(peer, msg) {
    if (!peer.pass) {
      (peer.passEarly = peer.passEarly || []).push(msg);
      return;
    }
    if (msg.k === "spake") {
      if (peer.pass.finished) return;
      const out2 = pqCall((json) => pqModule().spakefinish(json), { id: peer.pass.id, msg: msg.m });
      if (!out2 || !out2.conf) {
        sealedRefuse(peer, "the passphrase exchange failed");
        return;
      }
      peer.pass.finished = true;
      peer.pass.mine = out2.conf;
      sealedSend(peer, { k: "spakeok", c: out2.conf });
      sealedDrainPass(peer);
      sealedPassMaybe(peer);
      return;
    }
    const out = pqCall((json) => pqModule().spakeverify(json), { id: peer.pass.id, tag: msg.c });
    if (!out || !out.ok) {
      sealedRefusePass(peer);
      return;
    }
    peer.pass.peerOk = true;
    sealedPassMaybe(peer);
  }
  function sealedPassMaybe(peer) {
    if (!peer.pass || peer.pass.done || !peer.pass.finished || !peer.pass.peerOk) return;
    peer.pass.done = true;
    sealedPassDone(peer);
  }
  function sealedPassDone(peer) {
    sealedAnnounceName(peer);
    sealedSendState(peer);
    if (!peer.waiting) sealedSend(peer, { k: "gateq" });
    sealedSend(peer, { k: "wait", on: state.wait.on, n: state.wait.n });
    sealedSend(peer, { k: "claimq" });
    if (state.waiting) sealedSend(peer, { k: "held" });
    else sealedSend(peer, { k: "in" });
    if (peer.waiting) maybeAdmitHeld(peer);
    const held = peer.appHeld || [];
    peer.appHeld = [];
    for (const obj of held) sealedDispatchApp(peer, obj);
    if (!peer.pc && String(state.self) < String(peer.id)) connectPeer(peer.id, true);
  }
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
    let peer = state.peers.get(from);
    if (!peer) {
      if (from === state.self || !/^[0-9a-f]{12}$/.test(String(from || ""))) return;
      peer = ensurePeer(from);
    }
    let msg;
    try {
      msg = decOpaque(b);
    } catch {
      return;
    }
    switch (msg.k) {
      case "pub":
        sealedOnPub(peer, msg);
        break;
      case "hello":
        if (!peer.pub) return sealedHoldCtl(peer, msg);
        if (String(state.self) < String(from)) return;
        if (peer.keys || peer.keyPromise) return;
        sealedRespond(peer, msg).catch(() => sealedRefuse(peer, "handshake failed"));
        break;
      case "ok":
        if (!peer.keys || !peer.pub || !peer.transcript) return sealedHoldCtl(peer, msg);
        sealedOnProof(peer, msg).catch(() => sealedRefuse(peer, "handshake failed"));
        break;
      case "key":
        if (state.worker) state.worker.postMessage({ type: "keyframe", pair: pairLabel(peer.id) });
        break;
      case "app": {
        if (!msg.b) return;
        if (!peer.keys || !peer.keysInstalled) {
          if ((peer.appPending = peer.appPending || []).length < 64) peer.appPending.push(msg);
          return;
        }
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
      key: b64e(peer.keys.recvChat),
      aad: b64e(chatAAD(peer.id, seq)),
      b
    });
    if (!out || out.error) return;
    let obj;
    try {
      obj = decOpaque(out.pt);
    } catch {
      return;
    }
    peer.seqIn = seq;
    if (obj[PAD_KEY] !== void 0) delete obj[PAD_KEY];
    if (obj.k !== "spake" && obj.k !== "spakeok" && obj.k !== "kick" && !(peer.pass && peer.pass.done)) {
      if ((peer.appHeld = peer.appHeld || []).length < 256) peer.appHeld.push(obj);
      return;
    }
    sealedDispatchApp(peer, obj);
  }
  function sealedDispatchApp(peer, obj) {
    if (obj.k === "sdp") {
      if (obj.d === "offer")
        sealedOnOffer(peer, obj.s).catch(() => sealedRefuse(peer, "the offer could not be applied"));
      else if (obj.d === "answer" && peer.pc) onDescription(peer, "answer", obj.s);
      return;
    }
    if (obj.k === "cand") {
      if (peer.pc) onCandidate(peer, obj.c);
      else (peer.candEarly = peer.candEarly || []).push(obj.c);
      return;
    }
    if (obj.k === "spake" || obj.k === "spakeok") {
      sealedOnPassFrame(peer, obj);
      return;
    }
    if (obj.k === "name") {
      sealedSetName(peer, obj.n);
    } else if ((obj.k === "chat" || obj.k === "file") && peer.waiting) {
      return;
    } else if (obj.k === "chat") {
      state.chatRecv++;
      addChatLine(peer.name || shortPeer(peer.id), String(obj.x || ""), Date.now());
    } else if (obj.k === "asr") {
      if (!peer.waiting) asrOnMessage(peer, obj);
    } else if (obj.k === "state") {
      sealedOnState(peer, obj);
    } else if (obj.k === "lower") {
      if (isAdmin(peer.id) && state.hand) setHand(false);
    } else if (obj.k === "gateq") {
      if (state.gate.v !== null) sealedSend(peer, { k: "gate", v: state.gate.v, n: state.gate.n });
    } else if (obj.k === "gate") {
      sealedOnGate(peer, obj);
    } else if (obj.k === "claim") {
      sealedOnClaim(peer, obj);
    } else if (obj.k === "claimq") {
      sealedSendClaim(peer);
    } else if (obj.k === "wait") {
      sealedOnWait(peer, obj);
    } else if (obj.k === "admit") {
      sealedOnAdmit(peer);
    } else if (obj.k === "held") {
      sealedOnHeld(peer);
    } else if (obj.k === "in") {
      sealedOnIn(peer);
    } else if (obj.k === "kick") {
      sealedOnKick(peer, obj);
    } else if (obj.k === "mute") {
      if (isAdmin(peer.id)) {
        disableMic(false);
        say("the host muted your microphone");
      }
    } else if (obj.k === "file") {
      fileOnMessage(peer, obj);
    }
  }
  function sealedOnGate(peer, obj) {
    if (!isAdmin(peer.id)) return;
    const n = Number(obj.n);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) return;
    if (typeof obj.v !== "string" || obj.v.length > 256) return;
    if (n < state.gate.n) return;
    if (n === state.gate.n && (state.gate.v === obj.v || String(peer.id) >= String(state.self)))
      return;
    adoptGate(obj.v, n);
  }
  function adoptGate(v, n) {
    state.gate = { v, n };
    try {
      state.w = roomW(v, state.room);
    } catch {
      state.w = "";
    }
    paintGate();
  }
  function paintGate() {
    const note = document.getElementById("gate-note");
    if (note) note.textContent = state.gate.v ? "set, " + state.gate.n : "open room";
  }
  function setGate(v) {
    if (!isAdmin(state.self) || state.waiting) return;
    const n = state.gate.n + 1;
    adoptGate(v, n);
    toSealed({ k: "gate", v, n });
  }

  // src/signaling.ts
  function dropPeers() {
    for (const id of [...state.peers.keys()]) dropPeer(id);
  }
  function scheduleReconnect() {
    if (state.leaving || state.fatal || state.reconnectTimer) return;
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 1e4);
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
      try {
        old.close();
      } catch {
      }
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
      send({ t: "join", room: state.room });
    };
    ws.onmessage = (event) => {
      auditWire("in", event.data);
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
      dropPeers();
      if (state.fatal) {
        leave(state.fatal);
        return;
      }
      say("connection lost, reconnecting");
      startLost();
      scheduleReconnect();
    };
    ws.onerror = () => {
    };
  }
  function handle(msg) {
    if (msg.t === "error") {
      if (msg.code === "unavailable") {
        state.fatal = "room unavailable or full";
        leave(state.fatal);
      } else if (msg.code === "sealed-only") {
        state.fatal = "this page is out of date; reload it to join";
        leave(state.fatal);
      }
      return;
    }
    switch (msg.t) {
      case "joined": {
        state.self = msg.self;
        state.ice = msg.ice || [];
        if (state.notice === "connection lost, reconnecting") say("");
        state.auth = { n: -1, admins: [], by: "", sig: "" };
        setAdmins([]);
        state.waiting = true;
        asrProbe();
        omniProbe();
        let listed = 0;
        for (const info of msg.peers || []) {
          if (!info || !info.id) continue;
          const peer = ensurePeer(info.id);
          peer.waiting = false;
          sealedSendPub(peer);
          listed++;
        }
        if (!listed) sealedSendPub(null);
        startAuthSeed();
        markAdmins();
        paintWaiting();
        sendState();
        updateCount();
        break;
      }
      case "peer-joined": {
        if (!msg.peer || !msg.peer.id) break;
        const peer = ensurePeer(msg.peer.id);
        markAdmins();
        paintWaiting();
        paintHandQueue();
        sealedSendPub(peer);
        playSfx("pop");
        break;
      }
      case "peer-left": {
        dropPeer(msg.from);
        state.admins.delete(msg.from);
        resealOnLeave(msg.from);
        markAdmins();
        paintWaiting();
        playSfx("bonk");
        break;
      }
      case "enc": {
        if (msg.from && typeof msg.b === "string") sealedHandleOpaque(msg.from, msg.b);
        break;
      }
    }
  }

  // src/stats.ts
  var STATS_MS = 1e3;
  var STATS_HISTORY = 60;
  function statsOpen() {
    const panel = $("stats-panel");
    return !!panel && !panel.hidden;
  }
  function startStats() {
    if (state.statsTimer || !statsOpen()) return;
    for (const peer of state.peers.values()) {
      peer.statLast.clear();
      peer.statLoss = void 0;
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
  function setStatsOpen(open) {
    $("stats-panel").hidden = !open;
    $("stats-btn").setAttribute("aria-pressed", String(open));
    if (open && !document.hidden) startStats();
    else stopStats();
  }
  function clearStatsPanel() {
    const body = $("stats-body");
    if (body) body.replaceChildren();
    const sum = $("stats-sum");
    if (sum) sum.replaceChildren();
  }
  function bitrate(last, report, field) {
    const bytes = report[field] || 0;
    const ts = report.timestamp || 0;
    const key = `${report.id || report.type + ":" + report.kind}:${field}`;
    const prev = last.get(key);
    last.set(key, { bytes, ts });
    if (!prev || !(ts > prev.ts)) return 0;
    const kbit = (bytes - prev.bytes) * 8 / (ts - prev.ts);
    return kbit > 0 ? Math.round(kbit) : 0;
  }
  function isDirectType(type) {
    return type === "host" || type === "srflx" || type === "prflx";
  }
  function counterDelta(last, report, field) {
    const value = report[field];
    if (typeof value !== "number") return null;
    const key = `${report.id || report.type + ":" + report.kind}:${field}`;
    const prev = last.get(key);
    last.set(key, { bytes: value, ts: report.timestamp || 0 });
    return prev ? value - prev.bytes : null;
  }
  async function peerStats(peer) {
    const pc = peer.pc;
    if (!pc || typeof pc.getStats !== "function") return null;
    if (pc.connectionState === "closed" || pc.signalingState === "closed") return null;
    let report;
    try {
      report = await pc.getStats();
    } catch {
      return null;
    }
    if (!report || typeof report.forEach !== "function") return null;
    if (!(peer.statLast instanceof Map)) peer.statLast = /* @__PURE__ */ new Map();
    const out = {
      up: { audio: 0, video: 0 },
      down: { audio: 0, video: 0 },
      rtt: null,
      path: "",
      jitter: null,
      loss: null,
      shot: ""
    };
    let jitterMax = null;
    let lost = 0;
    let got = 0;
    let pairId = null;
    const pairs = /* @__PURE__ */ new Map();
    const cands = /* @__PURE__ */ new Map();
    try {
      report.forEach((r) => {
        if (r.type === "outbound-rtp" && (r.kind === "audio" || r.kind === "video")) {
          out.up[r.kind] += bitrate(peer.statLast, r, "bytesSent");
        } else if (r.type === "inbound-rtp" && (r.kind === "audio" || r.kind === "video")) {
          out.down[r.kind] += bitrate(peer.statLast, r, "bytesReceived");
          if (r.kind === "video" && r.frameWidth && r.frameHeight) {
            out.shot = `${r.frameWidth}x${r.frameHeight}`;
          }
          if (typeof r.jitter === "number") {
            jitterMax = jitterMax === null ? r.jitter : Math.max(jitterMax, r.jitter);
          }
          const dLost = counterDelta(peer.statLast, r, "packetsLost");
          const dGot = counterDelta(peer.statLast, r, "packetsReceived");
          if (dLost !== null && dGot !== null && dGot >= 0) {
            lost += Math.max(0, dLost);
            got += dGot;
          }
        } else if (r.type === "transport" && r.selectedCandidatePairId) {
          pairId = r.selectedCandidatePairId;
        } else if (r.type === "candidate-pair") {
          pairs.set(r.id, r);
        } else if (r.type === "local-candidate" || r.type === "remote-candidate") {
          cands.set(r.id, r);
        }
      });
    } catch {
    }
    let pair = pairId ? pairs.get(pairId) : null;
    if (!pair) {
      for (const p of pairs.values()) {
        if (p.selected || p.nominated) {
          pair = p;
          break;
        }
      }
    }
    if (!pair) {
      for (const p of pairs.values()) {
        if (p.state === "succeeded") {
          pair = p;
          break;
        }
      }
    }
    if (pair) {
      if (typeof pair.currentRoundTripTime === "number") {
        out.rtt = Math.round(pair.currentRoundTripTime * 1e3);
      }
      const local = cands.get(pair.localCandidateId);
      const remote = cands.get(pair.remoteCandidateId);
      const lt = local ? local.candidateType || local.type || "" : "";
      const rt = remote ? remote.candidateType || remote.type || "" : "";
      const relays = [];
      if (lt === "relay") relays.push("you");
      if (rt === "relay") relays.push("them");
      if (relays.length) out.path = `relay (${relays.join(" + ")})`;
      else if (isDirectType(lt) && isDirectType(rt)) out.path = "p2p";
    }
    if (jitterMax !== null) out.jitter = jitterMax * 1e3;
    if (got > 0) {
      const now = lost / (lost + got) * 100;
      out.loss = typeof peer.statLoss === "number" ? peer.statLoss * 0.7 + now * 0.3 : now;
      peer.statLoss = out.loss;
    }
    return out;
  }
  function rateScale(kbit) {
    const bytes = state.statsBytes;
    const n = Math.max(0, kbit) * (bytes ? 125 : 1);
    const big = n >= (bytes ? 1048576 : 1e3);
    const v = n / (big ? bytes ? 1048576 : 1e3 : bytes ? 1024 : 1);
    const num = big ? v.toFixed(v >= 10 ? 0 : 1) : Math.round(v).toString();
    return { num, unit: big ? "m" : "k" };
  }
  function rateText(kbit) {
    if (!(kbit > 0)) return "";
    const r = rateScale(kbit);
    return r.num + r.unit;
  }
  function msText(ms) {
    return Math.round(ms) + " ms";
  }
  function jitterText(ms) {
    if (typeof ms !== "number") return "";
    return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + " ms";
  }
  function lossText(pct) {
    if (typeof pct !== "number") return "";
    if (pct < 0.05) return "none";
    return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + " %";
  }
  function lossMark(pct) {
    return pct >= 2 ? false : void 0;
  }
  var VIDEO_ICON = ["1F3A5", "video"];
  var AUDIO_ICON = ["1F50A", "audio"];
  var PICTURE_ICON = ["1F5BC", "picture size"];
  var PING_ICON = ["1F3D3", "round trip"];
  var JITTER_ICON = ["1F30A", "jitter, how far apart the packets arrive"];
  var LOSS_ICON = ["1F4C9", "packet loss"];
  var DIRECT_ICON = ["1F517", "direct, the two browsers talk to each other"];
  var RELAY_ICON = ["1F4E1", "relay, the media goes through the server"];
  var UP_ICON = ["2B06", "out, what this browser sends"];
  var DOWN_ICON = ["2B07", "in, what this browser receives"];
  function routeCell(path) {
    if (!path) return ["", "", "not known yet"];
    const direct = path === "direct" || path === "p2p";
    return [...direct ? DIRECT_ICON : RELAY_ICON, path === "p2p" ? "direct" : path];
  }
  function rateCell(dir, kbit) {
    return [...dir === "up" ? UP_ICON : DOWN_ICON, rateText(kbit) || "-"];
  }
  function tripCells(rtt, jitter, loss) {
    return [
      [...PING_ICON, typeof rtt === "number" ? msText(rtt) : ""],
      [...JITTER_ICON, typeof jitter === "number" ? jitterText(jitter) : ""],
      [...LOSS_ICON, typeof loss === "number" ? lossText(loss) : "", lossMark(loss)]
    ];
  }
  function pathText(path) {
    return path === "p2p" ? "direct" : path;
  }
  function callPath(live) {
    const words = /* @__PURE__ */ new Set();
    for (const s of live) if (s.path) words.add(pathText(s.path));
    if (words.size === 0) return "";
    if (words.size === 1) return [...words][0];
    return "mixed: " + [...words].join(", ");
  }
  function worstOf(live, key) {
    const nums = live.map((s) => s[key]).filter((n) => typeof n === "number");
    return nums.length ? Math.max(...nums) : null;
  }
  function callPairs(live, total) {
    const out = [];
    const path = callPath(live);
    const rtt = worstOf(live, "rtt");
    const jitter = worstOf(live, "jitter");
    const loss = worstOf(live, "loss");
    if (path) out.push(["route ", [routeCell(path)]]);
    if (rtt !== null || jitter !== null || loss !== null) {
      out.push(["link ", tripCells(rtt, jitter, loss), void 0, "metrics"]);
    }
    out.push([
      VIDEO_ICON,
      [["", "", ""], rateCell("up", total.up.video), rateCell("down", total.down.video)]
    ]);
    out.push([
      AUDIO_ICON,
      [["", "", ""], rateCell("up", total.up.audio), rateCell("down", total.down.audio)]
    ]);
    return out;
  }
  function levelDb(peak) {
    const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
    return db > -60 ? `${Math.round(db)} dB` : "silent";
  }
  function levelFraction(peak) {
    const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
    return clamp((db + 60) / 60, 0, 1);
  }
  function peerLevel(peer) {
    if (!peer.audioSrc || !peer.meter) return "";
    return levelDb(peer.meterPeak || 0);
  }
  function ownPairs(total) {
    const out = [];
    if (state.idKey) out.push(["key ", state.idKey.fp, void 0, "mono"]);
    const live = !!(state.mic && state.micTrack && state.micTrack.readyState === "live");
    const mic = live && state.micTrack && state.micTrack.getSettings ? state.micTrack.getSettings() : null;
    const cam = state.camTrack && state.camTrack.getSettings ? state.camTrack.getSettings() : null;
    const shot = cam && cam.width && cam.height ? `${cam.width}x${cam.height}` : "off";
    out.push([
      VIDEO_ICON,
      [
        [...PICTURE_ICON, shot],
        rateCell("up", total ? total.up.video : 0),
        rateCell("down", total ? total.down.video : 0)
      ]
    ]);
    const sample = mic && mic.sampleRate ? `${Math.round(mic.sampleRate / 1e3)} kHz ${mic.channelCount || 1}ch` : "";
    out.push([
      AUDIO_ICON,
      [
        ["", "", live ? sample || "on" : "off"],
        rateCell("up", total ? total.up.audio : 0),
        rateCell("down", total ? total.down.audio : 0)
      ]
    ]);
    const level = live && state.micAnalyser ? micLevelCells(state.meterPeak) : null;
    out.push([
      "mic ",
      [["", "", level ? level.state === "silent" ? "silent" : level.db : "off"]],
      void 0,
      false,
      level ? levelFraction(state.meterPeak) : 0
    ]);
    const ctx = state.playCtx;
    const play = ctx ? ctx.state : "none";
    if (play !== "running") out.push(["sound ", `${play}, tap the page once`, false]);
    return out;
  }
  function peerPairs(peer, s) {
    const out = [];
    const pin = pinState(peer);
    if (peer.fp && pin !== "new") {
      const bad = pin === "changed" || pin === "rollback";
      const cells = [pin === "known" ? ["2714", "verified", peer.fp] : ["", "", peer.fp]];
      if (pin !== "known") cells.push(["", "", pin]);
      out.push(["key ", cells, bad ? false : void 0, "mono"]);
    }
    if (!s) {
      out.push(["", "connecting", void 0, true]);
    } else {
      out.push(["route ", [routeCell(s.path)]]);
      out.push(["link ", tripCells(s.rtt, s.jitter, s.loss), void 0, "metrics"]);
      out.push([
        VIDEO_ICON,
        [[...PICTURE_ICON, s.shot || ""], rateCell("up", s.up.video), rateCell("down", s.down.video)]
      ]);
      out.push([
        AUDIO_ICON,
        [["", "", peerLevel(peer)], rateCell("up", s.up.audio), rateCell("down", s.down.audio)]
      ]);
    }
    if (peer.sas && sealedRoomCodes().size > 1)
      out.push(["code ", verifyText(peer.sas), void 0, true]);
    if (!peer.keys) out.push(["keys ", "none", false, true]);
    else if (peer.ready === "ready" && !peer.confirmed)
      out.push(["keys ", "not confirmed", false, true]);
    const c = sealedPairCount(peer.id);
    if (c.refused) out.push(["frames ", `${c.refused} refused`, false, true]);
    return out;
  }
  function statIcon(hex, title) {
    const img = document.createElement("img");
    img.className = "sico";
    img.src = `/openmoji/${hex}.svg`;
    img.alt = title;
    img.title = title;
    return img;
  }
  function statCells(value, metrics) {
    const span = document.createElement("span");
    span.className = "sv";
    const parts = Array.isArray(value) ? value : [value];
    for (const raw of parts) {
      const p = Array.isArray(raw) ? raw : [raw];
      const cell = document.createElement("span");
      cell.className = "cell" + (p[3] === true ? " good" : p[3] === false ? " bad" : "");
      const word = p.length > 1 ? p[2] : p[0];
      const text = document.createElement("span");
      text.textContent = word === null || word === void 0 ? "" : String(word);
      if (metrics && p.length > 1 && p[1]) {
        const label = document.createElement("span");
        label.className = "cl";
        label.title = String(p[1]);
        label.textContent = String(p[1]).split(",")[0];
        text.className = "cv";
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
    const line = document.createElement("div");
    const parts = Array.isArray(value) ? value : [value];
    line.className = "sline" + (sub === "mono" ? " mono" : sub === "metrics" ? " metrics" : sub ? " sub" : "") + (typeof meter === "number" ? " meterline" : "") + (mark === true ? " good" : mark === false ? " bad" : "");
    line.dataset.n = String(parts.length);
    const k = document.createElement("span");
    k.className = "sk";
    if (Array.isArray(key) && key[0]) {
      k.appendChild(statIcon(key[0], key[1]));
      k.appendChild(document.createTextNode(String(key[1]).split(",")[0]));
    } else k.textContent = Array.isArray(key) ? key[1] || "" : key;
    line.appendChild(k);
    if (typeof meter === "number") {
      const bar = document.createElement("span");
      bar.className = "meter";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", `level ${Math.round(meter * 100)} percent`);
      const fill = document.createElement("i");
      fill.style.width = `${Math.round(meter * 100)}%`;
      bar.appendChild(fill);
      line.appendChild(bar);
    }
    line.appendChild(statCells(value, sub === "metrics"));
    return line;
  }
  function statsRow(title, pairs, mark = null, badge = null) {
    const row = document.createElement("div");
    row.className = "srow";
    const head = document.createElement("div");
    head.className = "sname";
    const name = document.createElement("span");
    name.className = "stitle";
    name.textContent = title;
    head.appendChild(name);
    if (badge && badge.level) {
      const chip = document.createElement("span");
      chip.className = "sbadge";
      chip.dataset.level = badge.level;
      chip.textContent = badge.text || badge.level;
      head.appendChild(chip);
    }
    row.appendChild(head);
    for (const p of pairs) {
      row.appendChild(
        statLine(p[0], p[1], p.length > 2 ? p[2] : mark, p.length > 3 ? p[3] : false, p[4])
      );
    }
    return row;
  }
  function linkLevel(s) {
    if (!s) return "";
    const { rtt, loss, jitter } = s;
    if (rtt === null && loss === null) return "";
    if (loss !== null && loss >= 5 || rtt !== null && rtt >= 400) return "poor";
    if (loss !== null && loss >= 2 || rtt !== null && rtt >= 200 || jitter !== null && jitter >= 40)
      return "fair";
    return "good";
  }
  function worstLevel(levels) {
    for (const word of ["poor", "fair", "good"]) if (levels.includes(word)) return word;
    return "";
  }
  function statsSummary(live, guestCount) {
    const level = worstLevel(live.map(linkLevel));
    const box = document.createElement("div");
    box.className = "ssum";
    box.dataset.level = level;
    const lamp = document.createElement("span");
    lamp.className = "slamp";
    const text = document.createElement("div");
    const head = document.createElement("div");
    head.className = "ssum-head";
    const sub = document.createElement("div");
    sub.className = "ssum-sub";
    if (guestCount === 0) {
      head.textContent = "waiting for guests";
      sub.textContent = "the numbers start when someone joins";
    } else if (!level) {
      head.textContent = "measuring";
      sub.textContent = "the first numbers arrive in a second";
    } else {
      head.textContent = `connection ${level}`;
      const nums = live.map((s) => s.rtt).filter((n) => typeof n === "number");
      const loss = live.map((s) => s.loss).filter((n) => typeof n === "number");
      const bits = [callPath(live)];
      if (nums.length) bits.push(msText(Math.max(...nums)));
      if (loss.length) bits.push(`loss ${lossText(Math.max(...loss))}`);
      sub.textContent = bits.filter(Boolean).join(" | ");
      if (level === "poor") sub.textContent += ". Try a lower quality in the toolbar.";
    }
    text.append(head, sub);
    box.append(lamp, text);
    return box;
  }
  function recordStatsHistory(total, live) {
    state.statHist.push({
      down: total.down.video + total.down.audio,
      rtt: worstOf(live, "rtt"),
      loss: worstOf(live, "loss")
    });
    if (state.statHist.length > STATS_HISTORY) state.statHist.shift();
  }
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
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cssW, cssH);
    const n = values.length;
    const stepX = (cssW - 2) / (STATS_HISTORY - 1);
    const px = (i) => cssW - 1 - (n - 1 - i) * stepX;
    const py = (v) => cssH - 1 - Math.min(v, peak) / peak * (cssH - 2);
    ctx.strokeStyle = "#0c3c0c";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 1; g < 3; g++) {
      const y = Math.round(cssH * g / 3) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
    }
    for (let g = 1; g < 6; g++) {
      const x = Math.round(cssW * g / 6) + 0.5;
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
      if (v === null) {
        drawing = false;
        continue;
      }
      if (drawing) ctx.lineTo(px(i), py(v));
      else {
        ctx.moveTo(px(i), py(v));
        drawing = true;
      }
    }
    ctx.stroke();
  }
  function statsNote(id, text) {
    const note = $(id);
    if (note) note.textContent = text;
  }
  function rateWords(kbit) {
    const r = rateScale(kbit);
    const words = state.statsBytes ? ["KiB/s", "MiB/s"] : ["kbit/s", "Mbit/s"];
    return `${r.num} ${words[r.unit === "m" ? 1 : 0]}`;
  }
  function drawStatsGraphs() {
    const box = $("stats-graph-box");
    if (!box) return;
    const hist = state.statHist;
    box.hidden = hist.length < 2;
    if (hist.length < 2) return;
    const series = (key) => hist.map((p) => typeof p[key] === "number" ? p[key] : null);
    const values = (arr) => arr.filter((v) => v !== null);
    const peak = (arr, floor) => Math.max(floor, ...values(arr));
    const now = (arr) => {
      const kept = values(arr);
      return kept.length ? kept[kept.length - 1] : null;
    };
    const secs = `last ${hist.length} s`;
    const down = series("down");
    statsPlot($("stats-graph-down"), down, peak(down, 100), true, "#00e000");
    const downMax = Math.max(0, ...values(down));
    statsNote(
      "stats-note-down",
      `down ${rateWords(now(down))} now, peak ${rateWords(downMax)}, ${secs}`
    );
    const rtt = series("rtt");
    statsPlot($("stats-graph-rtt"), rtt, peak(rtt, 100), false, "#f0e000");
    statsNote(
      "stats-note-rtt",
      values(rtt).length ? `round trip ${msText(now(rtt))} now, peak ${msText(Math.max(...values(rtt)))}, ${secs}` : `round trip not measured, ${secs}`
    );
    const loss = series("loss");
    statsPlot($("stats-graph-loss"), loss, peak(loss, 1), false, "#ff5050");
    const lossMax = Math.max(0, ...values(loss));
    statsNote(
      "stats-note-loss",
      lossMax > 0 ? `loss ${lossText(now(loss))} now, peak ${lossText(lossMax)}, ${secs}` : `loss none, ${secs}`
    );
  }
  async function updateStats() {
    if (!statsOpen() || state.statsBusy) return;
    const body = $("stats-body");
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
          for (const dir of ["up", "down"]) {
            for (const kind of ["audio", "video"]) total[dir][kind] += s[dir][kind];
          }
        }
        guests.push({ peer, s });
      }
      const rows = [];
      recordStatsHistory(total, live);
      if (state.peers.size > 1) {
        const call = callPairs(live, total);
        if (call.length) rows.push(statsRow("call", call));
      }
      for (const { peer, s } of guests) {
        if (s && s.path && peer.tile)
          peer.tile.dataset.relay = s.path.startsWith("relay") ? "yes" : "no";
        const level = linkLevel(s);
        const pairs = peerPairs(peer, s);
        if (pairs.length) {
          rows.push(
            statsRow(
              peer.name || shortPeer(peer.id),
              pairs,
              void 0,
              level ? { level, text: level } : null
            )
          );
        }
      }
      rows.push(statsRow("you", ownPairs(total)));
      $("stats-sum").replaceChildren(...sealedAlarms(), statsSummary(live, state.peers.size));
      const legend = document.createElement("p");
      legend.className = "slegend";
      legend.textContent = state.statsBytes ? "k is KiB/s and m is MiB/s, eight bits to the byte. The up arrow is what you send, the down arrow what you receive." : "k is kbit/s and m is Mbit/s. The up arrow is what you send, the down arrow what you receive.";
      body.replaceChildren(...rows, ...sealedCards(), legend);
      drawStatsGraphs();
    } finally {
      state.statsBusy = false;
    }
  }
  function sealedPairCount(id) {
    const label = pairLabel(id);
    let out = 0;
    let inn = 0;
    let refused = 0;
    for (const st of Object.values(state.frames)) {
      if (!st || st.pair !== label) continue;
      if (st.dir === "send") out += st.ok || 0;
      else if (st.dir === "recv") {
        inn += st.ok || 0;
        refused += st.fail || 0;
      }
    }
    return { out, inn, refused };
  }
  function sealedAlarms() {
    const out = [];
    if (state.sealFault) out.push(statsRow("sealing fault", [["", state.sealFault, false]]));
    const failed = sealedFailedPairs();
    if (failed.length) {
      const tags = failed.map(
        (peer) => `${peer.name || shortPeer(peer.id)} ${verifyText(peer.sas) || "no code"}`
      );
      out.push(
        statsRow("room code", [
          ["", "KEY MISMATCH " + tags.join(", "), false],
          ["", "do not trust this call", false]
        ])
      );
    }
    if (state.wireLeaks.length) {
      out.push(
        statsRow(
          "leak",
          state.wireLeaks.map((w) => ["", `${w.where}: ${w.canary}`, false])
        )
      );
    }
    if (state.workerErrors.length) {
      out.push(
        statsRow(
          "worker",
          state.workerErrors.slice(0, 5).map((e) => ["", e, false])
        )
      );
    }
    const wt = state.wasmTest;
    if (wt && !wasmTestOk(wt)) out.push(statsRow("self test", wasmTestFaults(wt)));
    return out;
  }
  function wasmTestOk(wt) {
    return !!(wt.sasMatch && wt.confirm && wt.open && wt.wrongKeyRefused && wt.idSign && wt.idUnsigned && wt.idFp && wt.pad && wt.passGood && wt.passBad);
  }
  function wasmTestFaults(wt) {
    const bad = [
      ["sas ", wt.sasMatch ? "match" : "no", !!wt.sasMatch],
      ["confirm ", wt.confirm ? "ok" : "no", !!wt.confirm],
      ["open ", wt.open ? "ok" : "no", !!wt.open],
      ["padding ", wt.pad ? "ok" : "BROKEN", !!wt.pad],
      ["wrong key ", wt.wrongKeyRefused ? "refused" : "OPENED", !!wt.wrongKeyRefused],
      ["identity ", wt.idSign ? "signs" : "BROKEN", !!wt.idSign],
      ["unsigned ", wt.idUnsigned ? "refused" : "ACCEPTED", !!wt.idUnsigned],
      ["fingerprint ", wt.idFp ? "ok" : "BROKEN", !!wt.idFp],
      ["room key ", wt.passGood ? "ok" : "BROKEN", !!wt.passGood],
      ["wrong key ", wt.passBad ? "refused" : "ACCEPTED", !!wt.passBad]
    ];
    const out = [["", "FAIL", false]];
    for (const b of bad) if (!b[2]) out.push(b);
    return out;
  }
  function sealedCards() {
    const out = [];
    const available = sealingAvailable();
    const wt = state.wasmTest;
    const seal = [
      ["media ", available ? "sealed, every frame" : "NO SEALING, no media is sent", available]
    ];
    if (wt) seal.push(["self test ", wasmTestOk(wt) ? "pass" : "FAIL", wasmTestOk(wt)]);
    out.push(statsRow("crypto", seal));
    let refused = 0;
    for (const st of Object.values(state.frames)) {
      if (st && st.dir === "recv") refused += st.fail || 0;
    }
    const clean = state.workerErrors.length === 0;
    const counts = [
      [
        "frames ",
        `out ${state.encryptFrames} in ${state.decryptFrames} refused ${refused}`,
        refused === 0 && clean
      ],
      [
        "wire ",
        `frames ${state.wireFrames} leaks ${state.wireLeaks.length} clear ${state.clearSignaling}`,
        state.wireLeaks.length === 0 && state.clearSignaling === 0
      ]
    ];
    const files = state.fileOffers + state.fileRecv + state.fileChunksRecv + state.fileChunksSent + state.fileRefused + state.fileCancelled;
    if (files) {
      counts.push([
        "files ",
        `offers ${state.fileOffers} saved ${state.fileRecv} in ${state.fileChunksRecv} out ${state.fileChunksSent} refused ${state.fileRefused} cancelled ${state.fileCancelled}`,
        state.fileRefused === 0 && state.fileCancelled === 0
      ]);
    }
    const chat = state.chatSent + state.chatRecv + state.replayDrops + state.confirmFailures + state.identityFailures;
    if (chat) {
      counts.push([
        "chat ",
        `out ${state.chatSent} in ${state.chatRecv} replays ${state.replayDrops}`,
        state.replayDrops === 0 && state.confirmFailures === 0 && state.identityFailures === 0
      ]);
    }
    out.push(statsRow("counters", counts));
    return out;
  }

  // src/frame.ts
  function startSealedWorker() {
    const worker = new Worker(scriptURL("/e2e-transform.js"));
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "stats") {
        state.frames[msg.pair + "|" + msg.dir + (msg.kind ? "|" + msg.kind : "")] = msg;
        paintFrameCounters();
      } else if (msg.type === "keys-ok") {
        const waiting = state.keyWait.get(msg.pair);
        if (waiting && waiting.gen === msg.gen) {
          state.keyWait.delete(msg.pair);
          waiting.resolve(true);
        }
      } else if (msg.type === "sample") {
        if (state.samples.length < 40) state.samples.push(msg);
      } else if (msg.type === "error") {
        state.workerErrors.push(msg.msg || "worker error");
        const waiting = msg.pair && state.keyWait.get(msg.pair);
        if (waiting && (msg.gen === void 0 || waiting.gen === msg.gen)) {
          state.keyWait.delete(msg.pair);
          waiting.resolve(false);
          say("the frame keys did not install; the link stays without video");
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
      if (st.dir === "send") enc += st.ok || 0;
      else if (st.dir === "recv") dec += st.ok || 0;
    }
    state.encryptFrames = enc;
    state.decryptFrames = dec;
  }

  // src/wasm.ts
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (win().Go) return resolve(null);
      const el2 = document.createElement("script");
      el2.src = scriptURL(src);
      el2.onload = () => resolve(null);
      el2.onerror = () => reject(new Error("could not load " + src));
      document.head.appendChild(el2);
    });
  }
  function loadWasmModule() {
    return new Promise((resolve, reject) => {
      const Go = win().Go;
      if (!window.WebAssembly || typeof Go !== "function")
        return reject(new Error("webassembly unavailable"));
      const go = new Go();
      fetch("/pq.wasm" + BUILD_Q).then((res) => {
        if (!res.ok) throw new Error("wasm " + res.status);
        return WebAssembly.instantiateStreaming(res, go.importObject);
      }).catch(async () => {
        const res = await fetch("/pq.wasm" + BUILD_Q);
        if (!res.ok) throw new Error("wasm " + res.status);
        const buf = await res.arrayBuffer();
        return WebAssembly.instantiate(buf, go.importObject);
      }).then((res) => {
        go.run(res.instance);
        const started = Date.now();
        const timer = setInterval(() => {
          if (pqModule()) {
            clearInterval(timer);
            resolve(null);
          } else if (Date.now() - started > 3e4) {
            clearInterval(timer);
            reject(new Error("wasm module did not start"));
          }
        }, 20);
      }).catch(reject);
    });
  }
  function fpShape(fp) {
    const parts = String(fp || "").split("-");
    if (parts.length !== 5) return false;
    return parts.every((part) => part.length === 4 && /^[a-z2-7]+$/.test(part));
  }
  function pqSelfTest() {
    const pq = pqModule();
    const a = JSON.parse(pq.gen());
    const b = JSON.parse(pq.gen());
    const k1 = JSON.parse(pq.idgen());
    const k2 = JSON.parse(pq.idgen());
    const sidA = b64e(crypto.getRandomValues(new Uint8Array(16)));
    const sidB = b64e(crypto.getRandomValues(new Uint8Array(16)));
    const off = JSON.parse(
      pq.initiate(
        JSON.stringify({
          self: "a",
          peer: "b",
          selfX: a.xpub,
          selfK: a.ek,
          selfID: k1.pub,
          selfSID: sidA,
          peerX: b.xpub,
          peerK: b.ek,
          peerID: k2.pub,
          peerSID: sidB
        })
      )
    );
    const helloSig = JSON.parse(pq.idsign(JSON.stringify({ seed: k1.seed, msg: off.transcript })));
    const respond = (sig) => JSON.parse(
      pq.respond(
        JSON.stringify({
          self: "b",
          peer: "a",
          selfX: b.xpub,
          selfSK: b.xsk,
          selfK: b.ek,
          selfDK: b.dk,
          selfID: k2.pub,
          selfSID: sidB,
          peerX: a.xpub,
          peerK: a.ek,
          peerID: k1.pub,
          peerSID: sidA,
          epk: off.epk,
          ct: off.ct,
          ...sig ? { sig } : {}
        })
      )
    );
    const acc = respond(helloSig.sig);
    const okSig = JSON.parse(pq.idsign(JSON.stringify({ seed: k2.seed, msg: acc.transcript })));
    const proved = (key, tag, id, sig) => JSON.parse(pq.proved(JSON.stringify({ key, transcript: off.transcript, tag, id, sig })));
    const verifyA = proved(off.keys.recvMedia, acc.confirm, k2.pub, okSig.sig);
    const verifyB = proved(acc.keys.recvMedia, off.confirm, k1.pub, helloSig.sig);
    const verifyNoSig = proved(off.keys.recvMedia, acc.confirm, k2.pub, "");
    const pt = b64e(sealUtf8.encode("sealed hello"));
    const aad = b64e(sealUtf8.encode("pq-e2e v2 chat a|b 1"));
    const sealed = JSON.parse(pq.seal(JSON.stringify({ key: off.keys.sendChat, aad, pt })));
    const openWith = (key) => JSON.parse(pq.open(JSON.stringify({ key, aad, b: sealed.b })));
    const opened = openWith(acc.keys.recvChat);
    const wrong = openWith(b64e(crypto.getRandomValues(new Uint8Array(32))));
    const idV = (id, msg, sig) => JSON.parse(pq.idverify(JSON.stringify({ id, msg, sig })));
    const idOk = idV(k1.pub, off.transcript, helloSig.sig);
    const idOther = idV(k2.pub, off.transcript, helloSig.sig);
    const idOk2 = idV(k2.pub, acc.transcript, okSig.sig);
    const idTampered = idV(k1.pub, b64e(sealUtf8.encode("another transcript")), helloSig.sig);
    const idFp = JSON.parse(pq.idfp(JSON.stringify({ id: k1.pub })));
    const w1 = JSON.parse(pq.spakew(JSON.stringify({ pass: "a", salt: "room" }))).w;
    const wBad = (() => {
      const raw = b64d(w1);
      raw[raw.length - 1] ^= 1;
      return b64e(raw);
    })();
    const passRun = (wa, wb) => {
      const start = (w, role) => JSON.parse(
        pq.spakestart(
          JSON.stringify({
            w,
            role,
            a: b64e(sealUtf8.encode("a")),
            b: b64e(sealUtf8.encode("b"))
          })
        )
      );
      const one = start(wa, "A");
      const two = start(wb, "B");
      if (!one.id || !two.id) return { error: true };
      const finA = JSON.parse(pq.spakefinish(JSON.stringify({ id: one.id, msg: two.msg })));
      const finB = JSON.parse(pq.spakefinish(JSON.stringify({ id: two.id, msg: one.msg })));
      const okA = JSON.parse(pq.spakeverify(JSON.stringify({ id: one.id, tag: finB.conf })));
      const okB = JSON.parse(pq.spakeverify(JSON.stringify({ id: two.id, tag: finA.conf })));
      return {
        match: !!finA.ke && finA.ke === finB.ke,
        ok: !!(okA.ok && okB.ok)
      };
    };
    const passGood = passRun(w1, w1);
    const passBad = passRun(w1, wBad);
    const noSig = respond("");
    return {
      sas: off.keys.sas,
      sasMatch: off.keys.sas === acc.keys.sas,
      pad: padRoundTripOk(),
      confirm: !!(verifyA.ok && verifyB.ok && !verifyNoSig.ok),
      open: opened.pt === pt,
      wrongKeyRefused: !!wrong.error,
      idSign: idOk.ok === true && idOther.ok === false && idOk2.ok === true && idTampered.ok === false,
      idUnsigned: !!noSig.error,
      idFp: fpShape(idFp.fp),
      passGood: !!(passGood.match && passGood.ok),
      passBad: !!(passBad.match === false && passBad.ok === false)
    };
  }
  var wasmLoad = null;
  function ensureWasm() {
    if (state.wasmOk) return Promise.resolve();
    if (wasmLoad) return wasmLoad;
    wasmLoad = loadScriptOnce("/wasm_exec.js" + BUILD_Q).then(loadWasmModule).then(() => {
      const test = pqSelfTest();
      state.wasmTest = test;
      if (!test.sasMatch || !test.confirm || !test.open || !test.wrongKeyRefused || !test.idSign || !test.idUnsigned || !test.idFp || !test.passGood || !test.passBad) {
        throw new Error("crypto self test failed");
      }
      state.wasmOk = true;
    }).catch((err) => {
      wasmLoad = null;
      throw err;
    });
    return wasmLoad;
  }
  function preloadSealed() {
    $("sealed-note").hidden = false;
    $("sealed-note").textContent = "loading the post-quantum module";
    ensureReady().then(() => {
      if (!$("lobby").hidden) $("sealed-note").textContent = "pq-e2e ready, " + deviceNote();
    }).catch((err) => {
      if (!$("lobby").hidden) {
        $("sealed-note").textContent = "the sealed client did not start: " + (err && err.message ? err.message : err);
      }
    });
  }
  function ensureReady() {
    return ensureWasm().then(ensureIdentity);
  }

  // src/phone.ts
  var phoneQuery = window.matchMedia ? window.matchMedia("(max-width: 620px), (max-height: 520px) and (hover: none)") : null;
  function applyImmersive() {
    const stage = $("stage");
    const on = !!phoneQuery && phoneQuery.matches && !stage.hidden;
    stage.classList.toggle("immersive", on);
    if (!on) stage.classList.remove("chrome");
    $("chrome-btn").setAttribute("aria-expanded", String(stage.classList.contains("chrome")));
  }
  function setChrome(show) {
    const stage = $("stage");
    if (!stage.classList.contains("immersive")) return;
    stage.classList.toggle("chrome", show);
    $("chrome-btn").setAttribute("aria-expanded", String(show));
    if (show) return;
    menuClose();
    if (statsOpen()) setStatsOpen(false);
  }

  // src/room.ts
  async function enterRoom(room, pass) {
    ensureSfx();
    preloadSfx();
    cancelReconnect();
    state.fatal = "";
    state.room = room;
    state.name = cleanSealedName($("name").value) || "guest";
    state.path = $("path").value;
    state.noiseWanted = $("noise").checked;
    state.mirror = true;
    state.leaving = false;
    state.mic = load("mic") !== "0";
    state.cam = load("cam") !== "0";
    store("name", state.name);
    store("room", state.room);
    store("path", state.path);
    store("noise", state.noiseWanted ? 1 : 0);
    ensurePlayback();
    $("enter-btn").disabled = true;
    $("sealed-note").hidden = false;
    $("sealed-note").textContent = "loading the post-quantum module";
    try {
      try {
        await ensureReady();
        $("sealed-note").textContent = "pq-e2e ready, " + deviceNote();
      } catch (err) {
        const why = err && err.message ? err.message : String(err);
        $("sealed-note").textContent = "the sealed client did not start: " + why;
        state.room = "";
        say("cannot open a sealed room: " + why);
        return;
      }
      $("sealed-note").textContent = "deriving the room key";
      canary(pass);
      state.w = roomW(pass, room);
      state.gate = { v: pass, n: 0 };
      paintGate();
      startSealedWorker();
      const made = JSON.parse(pqModule().gen());
      state.identity = { xpub: made.xpub, ek: made.ek, xsk: b64d(made.xsk), dk: b64d(made.dk) };
      state.sid = b64e(crypto.getRandomValues(new Uint8Array(16)));
      canary(state.name);
      if (!sealingAvailable()) {
        state.sealFault = "this browser cannot seal media frames, so no media is sent";
        state.mic = false;
        state.cam = false;
      }
      $("lobby").hidden = true;
      $("stage").hidden = false;
      $("stage").classList.remove("chrome");
      applyImmersive();
      $("room-label").textContent = room;
      $("room-label").title = room;
      $("chat-note").hidden = false;
      updatePinCount();
      setHash(room);
      startCallClock();
      startSpeaking();
      prepareLocal();
      prefetchNoise();
      if (sealingAvailable()) {
        try {
          await requestLocal();
        } catch {
        }
      } else {
        updateButtons();
        say(state.sealFault + "; you joined without microphone and camera");
      }
      connectWS();
    } catch (err) {
      leave("");
      state.leaving = false;
      say("cannot open a sealed room: " + (err && err.message ? err.message : String(err)));
    } finally {
      $("enter-btn").disabled = false;
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
      try {
        ws.close();
      } catch {
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
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    wipeIdentity();
    state.w = "";
    state.gate = { v: null, n: 0 };
    state.auth = { n: -1, admins: [], by: "", sig: "" };
    if (state.authTimer) clearTimeout(state.authTimer);
    state.authTimer = null;
    state.wait = { on: false, n: 0 };
    state.kickedFps = /* @__PURE__ */ new Set();
    state.sid = "";
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
    state.sealFault = "";
    state.wireFrames = 0;
    state.wireLeaks = [];
    state.clearSignaling = 0;
    state.canaries = /* @__PURE__ */ new Set();
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
    $("chat-note").hidden = true;
    if (state.micTrack) stopQuietly(state.micTrack);
    if (state.camTrack) stopQuietly(state.camTrack);
    if (state.audioCtx) {
      state.audioCtx.close().catch(() => {
      });
      state.audioCtx = null;
    }
    if (state.playCtx) {
      state.playCtx.close().catch(() => {
      });
      state.playCtx = null;
    }
    stopLost();
    if (state.sfxCtx) {
      state.sfxCtx.close().catch(() => {
      });
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
    $("stats-panel").hidden = true;
    $("stats-btn").setAttribute("aria-pressed", "false");
    state.spotlight = "";
    setLocalTile(null);
    $("stage-main").replaceChildren();
    $("self-pip").replaceChildren();
    $("self-pip").hidden = true;
    $("stage-rail").replaceChildren();
    $("stage-rail").hidden = false;
    stopCallClock();
    menuSet(false);
    $("stage").hidden = true;
    $("lobby").hidden = false;
    applyImmersive();
    $("room-label").textContent = "";
    $("peer-count").textContent = "";
    state.room = "";
    state.self = null;
    state.ice = [];
    state.fatal = "";
    state.reconnectDelay = 500;
    state.mic = false;
    state.cam = false;
    setAdmins([]);
    state.peers.clear();
    if ($("chat-log")) $("chat-log").replaceChildren();
    setHash("");
    if (was) $("room").value = was;
    else suggestRoom();
    if (message) {
      say(message);
      const note = $("sealed-note");
      if (note) {
        note.hidden = false;
        note.textContent = message;
      }
    }
  }

  // src/gate.ts
  function claimText(n, admins) {
    return b64e(sealUtf8.encode(`stanze/claim/1|${state.room}|${n}|${admins.join(",")}`));
  }
  async function makeClaim(n, admins) {
    if (!state.idKey) return null;
    let sig;
    try {
      sig = await state.idKey.sign(claimText(n, admins));
    } catch {
      return null;
    }
    return sig ? { n, admins: admins.slice(), sig } : null;
  }
  function adoptClaim(claim) {
    state.auth = { n: claim.n, admins: claim.admins.slice(), by: claim.by, sig: claim.sig };
    setAdmins(claim.admins);
    markAdmins();
    paintWaiting();
  }
  async function issueClaim(n, admins) {
    const unique = [...new Set(admins)].filter((id) => /^[0-9a-f]{12}$/.test(String(id || "")));
    if (!unique.length) return false;
    const claim = await makeClaim(n, unique);
    if (!claim || state.leaving) return false;
    adoptClaim({ ...claim, by: state.self });
    toSealed({ k: "claim", n: claim.n, admins: claim.admins, sig: claim.sig });
    return true;
  }
  function sealedSendClaim(peer) {
    if (state.auth.n < 0) return;
    sealedSend(peer, { k: "claim", n: state.auth.n, admins: state.auth.admins, sig: state.auth.sig });
  }
  function sealedOnClaim(peer, obj) {
    if (!peer.proven || !peer.pub || !peer.pub.id) return;
    const n = Number(obj.n);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) return;
    if (!Array.isArray(obj.admins) || !obj.admins.length || obj.admins.length > 64) return;
    if (obj.admins.some((id) => typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id))) return;
    if (!obj.admins.includes(peer.id) || typeof obj.sig !== "string") return;
    const res = pqCall((json) => pqModule().idverify(json), {
      id: peer.pub.id,
      msg: claimText(n, obj.admins),
      sig: obj.sig
    });
    if (!res || !res.ok) return;
    if (n < state.auth.n) return;
    if (n === state.auth.n) {
      if (obj.admins.join(",") === state.auth.admins.join(",")) return;
      if (String(peer.id) >= String(state.auth.by)) return;
    }
    adoptClaim({ ...obj, by: peer.id });
  }
  function startAuthSeed() {
    if (state.authTimer) clearTimeout(state.authTimer);
    state.authTimer = setTimeout(() => {
      state.authTimer = null;
      if (state.leaving || !state.self) return;
      if (!state.peers.size && state.waiting) admitPeer(state.self);
      if (state.auth.n >= 0) return;
      void issueClaim(0, [state.self]);
    }, 1200);
  }
  function resealOnLeave(id) {
    if (!state.auth.admins.includes(id)) return;
    const rest = state.auth.admins.filter((other) => other !== id);
    if (!rest.length) {
      if (!state.waiting) void issueClaim(state.auth.n + 1, [state.self]);
      return;
    }
    if (rest[0] !== state.self) return;
    void issueClaim(state.auth.n + 1, rest);
  }
  function sealedOnWait(peer, obj) {
    if (!isAdmin(peer.id)) return;
    const n = Number(obj.n);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) return;
    const on = !!obj.on;
    if (n < state.wait.n) return;
    if (n === state.wait.n && (on === state.wait.on || String(peer.id) >= String(state.self))) return;
    state.wait = { on, n };
    state.waitingRoom = on;
    paintWaiting();
    if (!on) admitAllHeld();
  }
  function setWaitingRoom(on) {
    if (!isAdmin(state.self) || state.waiting) return;
    const n = state.wait.n + 1;
    state.wait = { on: !!on, n };
    state.waitingRoom = !!on;
    toSealed({ k: "wait", on: !!on, n });
    paintWaiting();
    if (!on) admitAllHeld();
  }
  function sealedAdmit(peer) {
    if (!peer || state.waiting) return;
    sealedSend(peer, { k: "admit" });
  }
  function admitAllHeld() {
    if (state.waiting) return;
    for (const peer of state.peers.values()) {
      if (!peer.waiting) continue;
      sealedAdmit(peer);
      admitPeer(peer.id);
    }
  }
  function maybeAdmitHeld(peer) {
    if (!peer || !peer.waiting) return;
    if (!state.waiting) {
      if (!state.waitingRoom || peer.fp && state.insideFps.has(peer.fp)) {
        sealedAdmit(peer);
        admitPeer(peer.id);
      }
      return;
    }
    if (String(state.self) < String(peer.id)) {
      admitPeer(state.self);
      sealedAdmit(peer);
      return;
    }
    askHeldAgain(peer);
  }
  function askHeldAgain(peer) {
    if (!peer || !state.waiting) return;
    if ((peer.heldAsks || 0) >= 6) return;
    peer.heldAsks = (peer.heldAsks || 0) + 1;
    const timer = setTimeout(() => {
      peer.heldTimers = (peer.heldTimers || []).filter((t) => t !== timer);
      if (state.leaving || !state.peers.has(peer.id) || !state.waiting) return;
      sealedSend(peer, { k: "held" });
    }, 2e3);
    (peer.heldTimers = peer.heldTimers || []).push(timer);
  }
  function sealedOnHeld(peer) {
    if (!peer) return;
    if (!peer.waiting) {
      peer.waiting = true;
      paintWaiting();
      paintHandQueue();
    }
    maybeAdmitHeld(peer);
  }
  function sealedOnAdmit(peer) {
    if (!state.waiting || !peer) return;
    admitPeer(state.self);
    toSealed({ k: "in" });
  }
  function sealedOnIn(peer) {
    if (state.waiting || !peer || !peer.waiting) return;
    maybeAdmitHeld(peer);
  }
  function sealedKick(id) {
    if (!isAdmin(state.self) || !id || id === state.self) return;
    const gone = state.peers.get(id);
    if (gone && gone.fp) state.kickedFps.add(gone.fp);
    toSealed({ k: "kick", of: id });
    dropPeer(id);
    state.admins.delete(id);
    resealOnLeave(id);
    markAdmins();
    paintWaiting();
  }
  function sealedMute(id) {
    if (!isAdmin(state.self) || !id || id === state.self) return;
    toSealed({ k: "mute", of: id });
  }
  function sealedOnKick(peer, obj) {
    if (!isAdmin(peer.id) || typeof obj.of !== "string") return;
    if (obj.of === state.self) {
      leave("the host removed you from the room");
      return;
    }
    const gone = state.peers.get(obj.of);
    if (!gone) return;
    if (gone.fp) state.kickedFps.add(gone.fp);
    dropPeer(obj.of);
    state.admins.delete(obj.of);
    resealOnLeave(obj.of);
    markAdmins();
    paintWaiting();
  }
  function padsOn(peer) {
    if (!state.worker || !peer || peer.padsOn) return;
    peer.padsOn = true;
    for (const kind of ["audio", "video"]) {
      state.worker.postMessage({ type: "pad", pair: pairLabel(peer.id), kind, on: true });
    }
  }
  function sealedOnState(peer, obj) {
    if (obj.pad) padsOn(peer);
    if (obj.mic !== void 0) peer.mic = !!obj.mic;
    if (obj.cam !== void 0) {
      peer.cam = !!obj.cam;
      if (peer.cam) paintPeerVideo(peer);
      else dropPeerCamera(peer);
    }
    if (obj.deaf !== void 0) peer.deaf = !!obj.deaf;
    if (obj.screen !== void 0) {
      peer.screenShared = !!obj.screen;
      if (peer.screenShared) paintPeerScreen(peer);
      else dropPeerScreen(peer);
    }
    if (obj.hand !== void 0) {
      const was = peer.hand;
      peer.hand = !!obj.hand;
      peer.handTs = peer.hand ? clamp(Number(obj.ts) || 0, 0, Date.now()) : 0;
      if (peer.hand !== was) {
        playSfx(peer.hand ? "pop" : "bonk");
        if (peer.hand) setChrome(true);
      }
    }
    applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
    if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
    paintRowDeaf(rowOf.get(peer.tile), peer.deaf);
    paintHandQueue();
  }
  function renameSelf(raw) {
    const name = cleanSealedName(raw);
    if (!name || name === state.name) return false;
    state.name = name;
    store("name", name);
    const self2 = ownTile();
    if (self2) paintName(self2, name, true);
    for (const peer of state.peers.values()) {
      if (!peer.keys) continue;
      peer.announcedName = "";
      sealedAnnounceName(peer);
    }
    return true;
  }
  function sealedAnnounceName(peer) {
    if (!peer.keys || !state.name || peer.announcedName === state.name) return;
    peer.announcedName = state.name;
    sealedSend(peer, { k: "name", n: state.name });
  }
  var PAD_KEY = "p";
  var PAD_BUCKETS = [512, 2048, 8192];
  var PAD_LAST = PAD_BUCKETS[PAD_BUCKETS.length - 1];
  function padPayload(obj) {
    if (Object.prototype.hasOwnProperty.call(obj, PAD_KEY)) throw new Error("the padding key is reserved");
    const withPad = Object.assign({}, obj, { [PAD_KEY]: "" });
    const bytes = sealUtf8.encode(JSON.stringify(withPad)).length;
    let target = PAD_BUCKETS.find((n) => n >= bytes);
    if (!target) target = Math.ceil(bytes / PAD_LAST) * PAD_LAST;
    const need = target - bytes;
    if (need > 0) withPad[PAD_KEY] = "A".repeat(need);
    return JSON.stringify(withPad);
  }
  function padRoundTripOk() {
    const cases = [
      { k: "name", n: "abc" },
      { k: "chat", n: "a", x: "hello", ts: 1 },
      { k: "chat", n: "b", x: "\xE9".repeat(400) },
      { k: "file", a: "offer", x: "0123456789abcdef", n: "probe.bin", z: 4096, m: "" },
      { k: "asr", n: "c", x: "z".repeat(9e3) }
    ];
    for (const c of cases) {
      const raw = JSON.stringify(c);
      const out = padPayload(c);
      const bytes = sealUtf8.encode(out).length;
      const onBucket = PAD_BUCKETS.includes(bytes) || bytes % PAD_LAST === 0;
      const back = JSON.parse(out);
      delete back[PAD_KEY];
      if (!onBucket || JSON.stringify(back) !== raw) return false;
    }
    return true;
  }
  function roomW(pass, room) {
    const secret = pass === "" ? "\0open room" : pass;
    const out = pqCall((json) => pqModule().spakew(json), { pass: secret, salt: room });
    if (!out || !out.w) throw new Error("the room key could not be derived");
    return out.w;
  }
  function sealedSendSdp(peer, kind, sdp) {
    if (!peer.keys || !sdp) return;
    sealedSend(peer, { k: "sdp", d: kind, s: sdp });
  }
  function sealedSendCand(peer, cand) {
    if (!peer.keys || !cand) return;
    sealedSend(peer, { k: "cand", c: cand });
  }
  function sealedSend(peer, obj) {
    if (!peer.keys) return;
    const seq = peer.seqOut + 1;
    const out = pqCall((json) => pqModule().seal(json), {
      key: b64e(peer.keys.sendChat),
      aad: b64e(chatAAD(peer.id, seq)),
      pt: b64e(sealUtf8.encode(padPayload(obj)))
    });
    if (!out || !out.b) return;
    peer.seqOut = seq;
    sealedSendOpaque(peer.id, { k: "app", q: seq, b: out.b });
  }
  function toSealed(obj) {
    for (const peer of state.peers.values()) {
      if (!peer.keys || peer.waiting) continue;
      sealedSend(peer, obj);
    }
  }
  function sendSealedChat() {
    const input = $("chat-text");
    const text = (input.value || "").trim();
    if (!text || !state.self || state.waiting) return;
    input.value = "";
    canary(text);
    addChatLine(state.name, text, Date.now());
    state.chatSent++;
    toSealed({ k: "chat", n: state.name, x: text, ts: Date.now() });
  }
  function sealedSetName(peer, raw) {
    const name = cleanSealedName(raw);
    if (!name || peer.name === name) return;
    peer.name = name;
    if (peer.tile) paintName(peer.tile, name, false);
    if (peer.screenTile) paintName(peer.screenTile, `${name}, screen`, false);
  }
  function sealedSetE2E(peer, status) {
    peer.ready = status;
    updatePinCount();
    if (!peer.tile) return;
    peer.tile.dataset.e2e = status;
    paintState(peer);
    paintPin(peer);
  }
  function refreshCodeCard(host, peer) {
    const menu = hostMenu(host);
    if (!menu || menu.hidden) return;
    if (menu.classList.contains("row-menu") && menu.dataset.peer !== (host.dataset.peer || ""))
      return;
    let card = menu.querySelector(".sas");
    if (!peer.sas) {
      if (card) card.remove();
      return;
    }
    if (!card) {
      card = document.createElement("div");
      card.className = "sas";
      menu.appendChild(card);
    }
    card.replaceChildren(...sealedCodePanel(peer));
  }
  function paintState(peer) {
    if (!peer.tile) return;
    const badge = peer.tile.querySelector(".state");
    if (!badge) return;
    const known = peer.ready === "ready" && pinState(peer) === "known";
    badge.hidden = known;
    badge.dataset.e2e = known ? "known" : peer.ready === "ready" ? "unverified" : peer.ready === "failed" ? "failed" : "";
    badge.textContent = known ? "" : peer.ready === "ready" ? "e2e unverified" : peer.ready === "failed" ? "e2e FAILED" : peer.ready || "";
  }
  function sealedCodePanel(peer) {
    const code = peer.sas;
    const head = document.createElement("span");
    head.className = "sas-head";
    head.textContent = "sealed code";
    const row = document.createElement("span");
    row.className = "sas-row";
    for (const [emoji, name, hex] of verifyEmojis(code)) {
      const cell = document.createElement("span");
      cell.className = "sas-cell";
      const img = document.createElement("img");
      img.className = "sas-emoji";
      img.src = `/openmoji/${hex}.svg`;
      img.alt = emoji;
      img.title = name;
      const tip = document.createElement("span");
      tip.className = "sas-tip";
      tip.textContent = name;
      cell.append(img, tip);
      row.appendChild(cell);
    }
    const text = document.createElement("span");
    text.className = "sas-code";
    text.textContent = String(code || "").replace(/(.{4})(?=.)/g, "$1 ");
    return [head, row, text, sealedIdentityRow(peer)];
  }
  function sealedIdentityRow(peer) {
    const row = document.createElement("span");
    row.className = "id-row";
    const what = pinState(peer);
    const state2 = document.createElement("span");
    state2.className = "id-state";
    state2.dataset.pin = what;
    state2.textContent = what === "changed" ? "changed" : what === "rollback" ? "old key back" : "unverified";
    const which = document.createElement("span");
    which.className = "id-fp";
    which.textContent = peer.fp || "no fingerprint yet";
    if (what === "known") {
      row.append(
        pinButton(
          pinLabelOf(peer) || "pinned",
          () => renamePin(peer, prompt("new name for this device", pinLabelOf(peer)) || "")
        )
      );
    } else row.append(state2);
    row.append(which);
    if (what === "new" && peer.fp) {
      row.append(
        pinButton(
          "pin this device",
          () => pinPeer(peer, prompt("label for this device", peer.name) || "")
        )
      );
    } else if (what === "changed" || what === "rollback") {
      row.append(pinButton("this device was reset", () => resetDevice(peer, peer.pinLabel)));
    }
    return row;
  }
  function pinButton(text, onclick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pin-btn";
    button.textContent = text;
    button.addEventListener("click", onclick);
    return button;
  }

  // src/files.ts
  var FILE_LABEL = "files";
  var FILE_CHUNK = 16 * 1024;
  var FILE_BUFFER = 256 * 1024;
  var FILE_LOW = 64 * 1024;
  var FILE_OPEN_WAIT = 15e3;
  var FILE_DONE = /* @__PURE__ */ new Set(["done", "refused", "cancelled", "gone"]);
  function cleanFileName(raw) {
    return String(raw || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 64);
  }
  function fileID() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }
  function fileBytes(n) {
    if (!n) return "0 B";
    if (n < 1024) return n + " B";
    const units = ["kB", "MB", "GB"];
    let value = n / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + units[i];
  }
  function fileRateText(kbs) {
    if (!kbs || !isFinite(kbs) || kbs <= 0) return "";
    return (kbs >= 10 ? Math.round(kbs) : kbs.toFixed(1)) + " kB/s";
  }
  function fileMarkRate(o, bytes, now) {
    if (!o.rateT) {
      o.rateT = now;
      o.rateB = bytes;
      const secs = (now - (o.rateAt || now)) / 1e3;
      o.rate = secs > 0.05 ? bytes / 1024 / secs : 0;
      return;
    }
    const dt = now - o.rateT;
    if (dt < 500) return;
    o.rate = (bytes - o.rateB) / 1024 / (dt / 1e3);
    o.rateT = now;
    o.rateB = bytes;
  }
  function fileAverageRate(bytes, start, now) {
    if (!start || !bytes) return "";
    const secs = (now - start) / 1e3;
    if (secs < 0.2) return "";
    return fileRateText(bytes / 1024 / secs);
  }
  function fileButton(label, fn) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      button.disabled = true;
      fn(button);
    });
    return button;
  }
  function addFileRow(who, name, size) {
    const log = $("chat-log");
    if (!log) return null;
    const li = document.createElement("li");
    li.className = "chat-file";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = chatTime();
    const speaker = document.createElement("span");
    speaker.className = "who";
    speaker.textContent = (who || "guest") + ":";
    const head = document.createElement("span");
    head.className = "file-head";
    const label = document.createElement("span");
    label.className = "file-name";
    label.textContent = name;
    label.title = name;
    const labelSize = document.createElement("span");
    labelSize.className = "file-size";
    labelSize.textContent = fileBytes(size);
    head.append(label, labelSize);
    const bar = document.createElement("span");
    bar.className = "file-bar";
    bar.hidden = true;
    const fill = document.createElement("span");
    fill.className = "file-fill";
    bar.appendChild(fill);
    const status = document.createElement("span");
    status.className = "file-status";
    const acts = document.createElement("span");
    acts.className = "file-acts";
    li.append(when, speaker, head, bar, status, acts);
    log.appendChild(li);
    while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    return { li, bar, fill, status, acts };
  }
  function fileSetBar(el2, show, frac) {
    if (!el2) return;
    el2.bar.hidden = !show;
    el2.fill.style.width = clamp(Math.round(frac * 100), 0, 100) + "%";
  }
  function fileOffer(file) {
    if (!file || !state.self || state.leaving || state.waiting) return;
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      say("that file cannot be read");
      return;
    }
    const name = cleanFileName(file.name) || "file";
    const type = String(file.type || "").slice(0, 64);
    const x = fileID();
    const out = { x, file, name, size, type, peers: /* @__PURE__ */ new Map(), cancelled: false, el: null };
    for (const peer of state.peers.values()) {
      if (!peer.keys || peer.waiting) continue;
      out.peers.set(peer.id, { peer, status: "offered", sent: 0, dead: false, wake: null });
      sealedSend(peer, { k: "file", a: "offer", x, n: name, z: size, m: type });
    }
    if (!out.peers.size) {
      addChatLine(state.name, "no sealed peer for " + name, Date.now());
      return;
    }
    canary(name);
    state.fileOffers++;
    state.files.set(x, out);
    out.el = addFileRow(state.name, name, size);
    if (out.el) out.el.acts.append(fileButton("cancel", () => fileCancelOut(out)));
    filePaintOut(out);
  }
  function fileOnMessage(peer, msg) {
    switch (msg.a) {
      case "offer":
        fileOnOffer(peer, msg);
        break;
      case "accept":
        fileOnAccept(peer, msg);
        break;
      case "refuse":
        fileOnRefuse(peer, msg);
        break;
      case "cancel":
        fileOnCancel(peer, msg);
        break;
      case "done":
        fileOnDone(peer, msg);
        break;
      default:
        break;
    }
  }
  function fileOnOffer(peer, msg) {
    const x = String(msg.x || "").slice(0, 32);
    const name = cleanFileName(msg.n);
    const size = Number(msg.z);
    const type = String(msg.m || "").slice(0, 64);
    if (!x || !name || !Number.isSafeInteger(size) || size < 0) return;
    const key = peer.id + "|" + x;
    if (state.filesIn.has(key)) return;
    const rec = {
      key,
      x,
      peerId: peer.id,
      name,
      size,
      type,
      status: "offered",
      chunks: [],
      got: 0,
      expect: 0,
      el: null,
      url: "",
      rateT: 0,
      rateB: 0,
      rate: 0,
      rateAt: 0
    };
    state.filesIn.set(key, rec);
    canary(name);
    rec.el = addFileRow(peer.name || shortPeer(peer.id), name, size);
    if (rec.el) {
      rec.el.acts.append(
        fileButton("accept", (button) => fileAccept(rec, button)),
        fileButton("refuse", () => fileRefuse(rec))
      );
    }
    filePaintIn(rec);
  }
  function fileDiskWanted() {
    const pick = window.showSaveFilePicker;
    return typeof pick === "function" && !window.e2eNoPicker;
  }
  async function fileDiskOpen(rec) {
    if (!fileDiskWanted()) return false;
    let handle2;
    try {
      handle2 = await window.showSaveFilePicker({ suggestedName: rec.name });
    } catch (err) {
      if (err && err.name === "AbortError") return null;
      return false;
    }
    try {
      rec.writer = await handle2.createWritable();
      rec.disk = true;
      return true;
    } catch {
      return false;
    }
  }
  function fileDiskWrite(rec, bytes) {
    const writer = rec.writer;
    if (!writer) return;
    rec.writes = (rec.writes || Promise.resolve()).then(() => writer.write(bytes)).catch(() => {
      fileDiskAbort(rec);
      const peer = state.peers.get(rec.peerId);
      if (peer && peer.keys) sealedSend(peer, { k: "file", a: "cancel", x: rec.x });
      fileFinishIn(rec, "cancelled");
    });
  }
  function fileDiskAbort(rec) {
    const writer = rec.writer;
    rec.writer = null;
    rec.chunks = [];
    if (!writer) return;
    const pending = rec.writes || Promise.resolve();
    rec.writes = pending.then(() => writer.abort()).catch(() => {
    });
  }
  function fileAccept(rec, button) {
    const peer = state.peers.get(rec.peerId);
    if (!peer || !peer.keys) {
      fileFinishIn(rec, "gone");
      return;
    }
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
    rec.status = "receiving";
    rec.got = 0;
    rec.expect = 0;
    rec.chunks = [];
    rec.rateT = 0;
    rec.rateB = 0;
    rec.rate = 0;
    rec.rateAt = performance.now();
    fileArmIn(rec);
    if (rec.el) {
      rec.el.acts.replaceChildren(fileButton("cancel", () => fileCancelIn(rec)));
    }
    sealedSend(peer, { k: "file", a: "accept", x: rec.x });
    filePaintIn(rec);
  }
  function fileRefuse(rec) {
    const peer = state.peers.get(rec.peerId);
    if (peer && peer.keys) sealedSend(peer, { k: "file", a: "refuse", x: rec.x });
    fileFinishIn(rec, "refused");
  }
  function fileCancelIn(rec) {
    const peer = state.peers.get(rec.peerId);
    if (peer && peer.keys) sealedSend(peer, { k: "file", a: "cancel", x: rec.x });
    state.fileCancelled++;
    fileFinishIn(rec, "cancelled");
  }
  function fileCancelOut(out, why = "") {
    if (!out || out.cancelled) return;
    out.cancelled = true;
    state.fileCancelled++;
    for (const st of out.peers.values()) {
      if (st.status === "done" || st.status === "refused" || st.status === "gone") continue;
      st.status = "cancelled";
      fileStop(st);
      if (st.peer.keys) sealedSend(st.peer, { k: "file", a: "cancel", x: out.x, y: why || "" });
    }
    out.file = null;
    filePaintOut(out);
    fileSettle(out);
  }
  function fileCancelPeer(out, st, why) {
    if (st.status === "done" || st.status === "refused" || st.status === "gone") return;
    st.status = "cancelled";
    fileStop(st);
    if (st.peer.keys) sealedSend(st.peer, { k: "file", a: "cancel", x: out.x, y: why || "" });
    filePaintOut(out);
    fileSettle(out);
  }
  function fileOnAccept(peer, msg) {
    const out = state.files.get(String(msg.x || ""));
    if (!out || out.cancelled) {
      if (peer.keys) sealedSend(peer, { k: "file", a: "cancel", x: String(msg.x || "") });
      return;
    }
    const st = out.peers.get(peer.id);
    if (!st || st.status !== "offered") return;
    st.status = "sending";
    st.rateAt = performance.now();
    filePaintOut(out);
    filePump(out, st).catch(() => fileCancelPeer(out, st, "the transfer failed"));
  }
  function fileOnRefuse(peer, msg) {
    const out = state.files.get(String(msg.x || ""));
    if (!out || out.cancelled) return;
    const st = out.peers.get(peer.id);
    if (!st || st.status === "refused") return;
    st.status = "refused";
    fileStop(st);
    state.fileRefused++;
    filePaintOut(out);
    fileSettle(out);
  }
  function fileOnCancel(peer, msg) {
    const x = String(msg.x || "");
    const out = state.files.get(x);
    if (out) {
      const st = out.peers.get(peer.id);
      if (st && st.status !== "done" && st.status !== "refused" && st.status !== "cancelled" && st.status !== "gone") {
        st.status = "cancelled";
        fileStop(st);
        state.fileCancelled++;
        filePaintOut(out);
        fileSettle(out);
      }
      return;
    }
    const rec = state.filesIn.get(peer.id + "|" + x);
    if (!rec || rec.status === "done" || rec.status === "refused" || rec.status === "cancelled")
      return;
    rec.status = "cancelled";
    fileFinishIn(rec, "cancelled");
  }
  function fileOnDone(peer, msg) {
    const rec = state.filesIn.get(peer.id + "|" + String(msg.x || ""));
    if (!rec || rec.status !== "receiving") return;
    if (rec.got !== rec.size) return;
    fileFinishIn(rec, "done");
  }
  function fileOnChunk(peer, raw) {
    if (typeof raw !== "string") return;
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame.b !== "string") return;
    const rec = state.filesIn.get(peer.id + "|" + String(frame.x || ""));
    if (!rec || rec.status !== "receiving" || !peer.keys) return;
    const q = Number(frame.q);
    if (!Number.isSafeInteger(q) || q !== rec.expect) {
      state.replayDrops++;
      return;
    }
    const out = pqCall((json) => pqModule().open(json), {
      key: b64e(peer.keys.recvChat),
      aad: b64e(fileAAD(peer.id, peer.id, rec.x, q)),
      b: frame.b
    });
    if (!out || out.error) {
      state.replayDrops++;
      return;
    }
    const bytes = b64d(out.pt);
    if (rec.got + bytes.length > rec.size) {
      if (peer.keys) sealedSend(peer, { k: "file", a: "cancel", x: rec.x });
      fileFinishIn(rec, "cancelled");
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
    if (rec.got === rec.size) fileFinishIn(rec, "done");
  }
  function fileArmIn(rec) {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      rec.timer = 0;
      if (rec.status !== "receiving") return;
      const peer = state.peers.get(rec.peerId);
      if (peer && peer.keys) sealedSend(peer, { k: "file", a: "cancel", x: rec.x });
      fileFinishIn(rec, "cancelled");
    }, 2e4);
  }
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
        buf = new Uint8Array(
          await out.file.slice(q * FILE_CHUNK, (q + 1) * FILE_CHUNK).arrayBuffer()
        );
      } catch {
        fileCancelPeer(out, st, "the file could not be read");
        return;
      }
      if (st.dead || out.cancelled) return;
      const sealed = pqCall((json) => pqModule().seal(json), {
        key: b64e(peer.keys.sendChat),
        aad: b64e(fileAAD(peer.id, state.self, out.x, q)),
        pt: b64e(buf)
      });
      if (!sealed || !sealed.b) {
        fileCancelPeer(out, st, "a chunk could not be sealed");
        return;
      }
      const ready = await fileSpace(dc, st);
      if (!ready || st.dead || out.cancelled) return;
      try {
        dc.send(JSON.stringify({ x: out.x, q, b: sealed.b }));
      } catch {
        fileCancelPeer(out, st, "the file channel closed");
        return;
      }
      st.sent = q + 1;
      state.fileChunksSent++;
      fileMarkRate(st, st.sent * FILE_CHUNK, performance.now());
      filePaintOut(out);
    }
    if (st.dead || out.cancelled) return;
    st.status = "done";
    if (peer.keys) sealedSend(peer, { k: "file", a: "done", x: out.x });
    filePaintOut(out);
    fileSettle(out);
  }
  function fileWaitOpen(peer, st) {
    return new Promise((resolve) => {
      let timer = 0;
      let dc = null;
      const done = (value) => {
        if (st.wake !== wake) return;
        st.wake = null;
        clearTimeout(timer);
        if (dc) {
          dc.removeEventListener("open", onOpen);
          dc.removeEventListener("close", onClose);
        }
        resolve(value);
      };
      const wake = () => done(null);
      const onOpen = () => done(dc);
      const onClose = () => done(null);
      const attach = (channel) => {
        dc = channel;
        if (!dc) return done(null);
        if (dc.readyState === "open") return done(dc);
        if (dc.readyState !== "connecting") return done(null);
        dc.addEventListener("open", onOpen);
        dc.addEventListener("close", onClose);
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
  function fileSpace(dc, st) {
    if (dc.readyState !== "open") return Promise.resolve(false);
    if (dc.bufferedAmount <= FILE_BUFFER) return Promise.resolve(true);
    dc.bufferedAmountLowThreshold = FILE_LOW;
    return new Promise((resolve) => {
      let timer = 0;
      const done = (value) => {
        if (st.wake !== wake) return;
        st.wake = null;
        clearTimeout(timer);
        dc.removeEventListener("bufferedamountlow", onLow);
        resolve(value);
      };
      const wake = () => done(false);
      const onLow = () => {
        if (dc.bufferedAmount <= FILE_BUFFER) done(true);
      };
      st.wake = wake;
      dc.addEventListener("bufferedamountlow", onLow);
      timer = setTimeout(
        () => done(dc.readyState === "open" && dc.bufferedAmount <= FILE_BUFFER),
        2e3
      );
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
    dc.onmessage = (event) => fileOnChunk(peer, typeof event.data === "string" ? event.data : "");
    dc.onclose = () => {
      if (peer.dc !== dc) return;
      peer.dc = null;
      fileChannelClosed(peer);
    };
    dc.onerror = () => {
    };
    if (peer.dcResolve) {
      const resolve = peer.dcResolve;
      peer.dcResolve = null;
      peer.dcPromise = Promise.resolve(dc);
      resolve(dc);
    }
  }
  function fileOutGone(id) {
    for (const out of state.files.values()) {
      const st = out.peers.get(id);
      if (!st || FILE_DONE.has(st.status)) continue;
      st.status = "gone";
      fileStop(st);
      if (!out.cancelled) filePaintOut(out);
      fileSettle(out);
    }
  }
  function fileChannelClosed(peer) {
    fileOutGone(peer.id);
    for (const rec of state.filesIn.values()) {
      if (rec.peerId === peer.id && rec.status === "receiving") fileFinishIn(rec, "cancelled");
    }
  }
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
    fileOutGone(id);
    for (const rec of state.filesIn.values()) {
      if (rec.peerId === id && !FILE_DONE.has(rec.status)) fileFinishIn(rec, "gone");
    }
  }
  function fileStop(st) {
    st.dead = true;
    if (st.wake) st.wake();
  }
  function fileInText(rec) {
    if (rec.status === "offered") return "waiting for you";
    if (rec.status === "receiving") {
      const pct = rec.size ? Math.round(rec.got / rec.size * 100) : 0;
      const rate = fileRateText(rec.rate);
      return "receiving " + pct + " percent" + (rate ? ", " + rate : "");
    }
    if (rec.status === "done") {
      return rec.disk ? "saved to disk" + (rec.avg ? ", " + rec.avg : "") : "ready, click save" + (rec.avg ? ", " + rec.avg : "");
    }
    if (rec.status === "refused") return "refused";
    if (rec.status === "cancelled") return "cancelled";
    if (rec.status === "gone") return "the sender left";
    return "";
  }
  function filePaintIn(rec) {
    if (!rec.el) return;
    const pct = rec.size ? rec.got / rec.size : 0;
    fileSetBar(rec.el, rec.status === "receiving", pct);
    rec.el.status.textContent = fileInText(rec);
  }
  function fileFinishDisk(rec) {
    const writer = rec.writer;
    rec.writer = null;
    rec.avg = fileAverageRate(rec.size, rec.rateAt, performance.now());
    if (rec.el) rec.el.status.textContent = "saving to disk" + (rec.avg ? ", " + rec.avg : "");
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
        rec.el.status.textContent = "the disk write failed";
      }
    });
  }
  function fileFinishIn(rec, status) {
    if (rec.timer) {
      clearTimeout(rec.timer);
      rec.timer = 0;
    }
    if (status === "done" && rec.got !== rec.size) status = "cancelled";
    rec.status = status;
    if (rec.el) rec.el.bar.hidden = true;
    if (status === "done" && rec.writer) {
      fileFinishDisk(rec);
      return;
    }
    if (status === "done") {
      rec.avg = fileAverageRate(rec.size, rec.rateAt, performance.now());
      const blob = new Blob(rec.chunks, { type: rec.type || "application/octet-stream" });
      rec.chunks = [];
      if (rec.url) {
        URL.revokeObjectURL(rec.url);
        state.fileLinks.delete(rec.url);
      }
      rec.url = URL.createObjectURL(blob);
      state.fileLinks.add(rec.url);
      state.fileRecv++;
      if (rec.el) {
        const link = document.createElement("a");
        link.className = "file-save";
        link.href = rec.url;
        link.download = rec.name;
        link.textContent = "save " + fileBytes(rec.size);
        rec.el.acts.replaceChildren(link);
        rec.el.status.textContent = "ready, click save" + (rec.avg ? ", " + rec.avg : "");
      }
      state.filesIn.delete(rec.key);
      return;
    }
    fileDiskAbort(rec);
    if (rec.url) {
      URL.revokeObjectURL(rec.url);
      state.fileLinks.delete(rec.url);
      rec.url = "";
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
    const accepted = list.filter((s) => s.status === "sending" || s.status === "done");
    const refused = list.filter((s) => s.status === "refused");
    const gone = list.filter((s) => s.status === "gone");
    const stopped = list.filter((s) => s.status === "cancelled");
    const open = list.some((s) => s.status === "offered" || s.status === "sending");
    const bytes = accepted.reduce((n, s) => n + Math.min(out.size, s.sent * FILE_CHUNK), 0);
    const total = accepted.length * Math.max(1, out.size);
    const allDone = accepted.length > 0 && accepted.every((s) => s.status === "done");
    const frac = out.size === 0 ? allDone ? 1 : 0 : total ? bytes / total : 0;
    fileSetBar(out.el, !out.cancelled && accepted.length > 0 && !allDone, frac);
    if (out.cancelled) {
      out.el.acts.replaceChildren();
      out.el.status.textContent = "cancelled";
      return;
    }
    const words = ["accepted " + accepted.length + " of " + list.length];
    if (accepted.length) {
      words.push(
        accepted.map((s) => {
          const pct = out.size ? Math.round(Math.min(out.size, s.sent * FILE_CHUNK) / Math.max(1, out.size) * 100) : s.status === "done" ? 100 : 0;
          const sent = Math.min(out.size, s.sent * FILE_CHUNK);
          const rate = s.status === "done" ? fileAverageRate(sent, s.rateAt, performance.now()) : fileRateText(s.rate);
          return s.peer.name + " " + (s.status === "done" ? "done" : pct + " percent") + (rate ? ", " + rate : "");
        }).join(", ")
      );
    }
    if (refused.length) words.push("refused " + refused.map((s) => s.peer.name).join(", "));
    if (stopped.length) words.push("cancelled " + stopped.map((s) => s.peer.name).join(", "));
    if (gone.length) words.push("left " + gone.map((s) => s.peer.name).join(", "));
    out.el.status.textContent = words.join(" | ");
    if (!open) out.el.acts.replaceChildren();
  }
  function fileSettle(out) {
    const list = [...out.peers.values()];
    if (!list.length) return;
    const open = list.some((s) => s.status === "offered" || s.status === "sending");
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
      rec.url = "";
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

  // src/badge.ts
  function selectedPair(stats) {
    let pair = null;
    stats.forEach((r) => {
      if (!pair && r.type === "transport" && r.selectedCandidatePairId) {
        pair = stats.get(r.selectedCandidatePairId) || null;
      }
    });
    if (pair) return pair;
    stats.forEach((r) => {
      if (!pair && r.type === "candidate-pair" && (r.selected || r.nominated && r.state === "succeeded"))
        pair = r;
    });
    return pair;
  }
  async function paintRelay(peer) {
    try {
      const stats = await peer.pc.getStats();
      const pair = selectedPair(stats);
      const local = pair ? stats.get(pair.localCandidateId) : null;
      const remote = pair ? stats.get(pair.remoteCandidateId) : null;
      const relayed = !!(local && local.candidateType === "relay" || remote && remote.candidateType === "relay");
      if (peer.tile) peer.tile.dataset.relay = relayed ? "yes" : "no";
    } catch {
    }
  }

  // src/peers.ts
  function iceServers() {
    const all = state.ice || [];
    if (state.path !== "p2p") return all;
    return all.filter((server) => !/^turns?:/i.test(String(server.urls)));
  }
  function rtcConfig() {
    return {
      iceServers: iceServers(),
      iceTransportPolicy: state.path === "relay" ? "relay" : "all",
      bundlePolicy: "max-bundle"
    };
  }
  function ensurePeer(id) {
    let peer = state.peers.get(id);
    if (peer) return peer;
    const initial = String(id).slice(0, 6);
    peer = {
      id,
      name: initial,
      mic: true,
      cam: true,
      deaf: false,
      waiting: !!state.waitingRoom && !state.waiting,
      // held outside the room
      hand: false,
      // a raised hand
      handTs: 0,
      screenShared: false,
      // a live share, until the sealed state says otherwise
      vol: 100,
      pc: null,
      tile: null,
      video: null,
      screenTile: null,
      // the second tile, built from the first screen track
      screenTrack: null,
      gain: null,
      audioSrc: null,
      audioEl: null,
      meter: null,
      // tap on the incoming audio, for the talking light
      meterPeak: 0,
      // decaying peak of that tap, so one stats tick sees a word
      inDenoise: null,
      // local noise cancel of this incoming stream
      inNoise: true,
      // that noise cancel is asked for, on by default
      inEngine: "fastenhancer",
      // which engine that noise cancel uses
      feId: 0,
      // the lane of this stream in the FastEnhancer worker, 0 = none
      spoke: null,
      // last time this peer was heard, for the hold
      statLast: /* @__PURE__ */ new Map(),
      polite: String(state.self) > String(id),
      makingOffer: false,
      settingAnswer: false,
      ignoreOffer: false,
      pending: [],
      state: "new",
      initiator: false,
      pub: null,
      keys: null,
      transcript: null,
      sas: "",
      confirmed: false,
      ready: "",
      myConfirm: "",
      sentConfirm: false,
      keyPromise: null,
      keysInstalled: false,
      gen: 0,
      // bumps on every new key agreement on this pair
      ctlPending: [],
      // hello/ok held until the pub and the keys are here
      seqOut: 0,
      // sealed chat/name frames sent on this pair
      seqIn: 0,
      // the last one opened, inbound only grows
      dc: null,
      dcPromise: null,
      // resolves with that channel, or null when it never comes
      dcResolve: null,
      mySig: "",
      fp: "",
      // fingerprint once the peer proved its identity
      pin: "",
      // 'changed' when a label here holds another key
      pinLabel: "",
      // the local label this guest is pinned under
      proven: false,
      desc: null,
      // the description chain of this pair
      announcedName: ""
    };
    peer.vol = storedVolume(peer);
    peer.tile = makeTile(peer.name, peer.name);
    peer.video = peer.tile.querySelector("video");
    peer.tile.dataset.peer = id;
    state.peers.set(id, peer);
    applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
    paintRowDeaf(rowOf.get(peer.tile), peer.deaf);
    wireVolume(peer);
    layoutStage();
    updateCount();
    paintHandQueue();
    return peer;
  }
  function connectPeer(id, initiator) {
    const peer = ensurePeer(id);
    if (peer.pc) {
      peer.initiator = peer.initiator || initiator;
      return peer;
    }
    peer.initiator = initiator;
    const pc = new RTCPeerConnection(rtcConfig());
    peer.pc = pc;
    peer.dc = null;
    peer.dcPromise = new Promise((resolve) => {
      peer.dcResolve = resolve;
    });
    pc.ondatachannel = (event) => {
      if (event.channel && event.channel.label === FILE_LABEL) fileBindChannel(peer, event.channel);
    };
    if (initiator) fileBindChannel(peer, pc.createDataChannel(FILE_LABEL, { ordered: true }));
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sealedSendSdp(peer, "offer", pc.localDescription.sdp);
      } catch (err) {
        console.warn("negotiation failed", err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) sealedSendCand(peer, event.candidate.toJSON());
    };
    pc.ontrack = (event) => {
      const track = event.track;
      if (track.kind === "audio") {
        routeAudio(peer, track);
        track.addEventListener("ended", () => dropAudio(peer));
        return;
      }
      const named = peer.tx && peer.tx.screen;
      const screen = named || peer.pc.getTransceivers().filter((t) => t.receiver.track.kind === "video")[1];
      if (screen && (event.transceiver === screen || named && named.mid !== null && event.transceiver.mid === named.mid)) {
        peer.screenTrack = track;
        paintPeerScreen(peer);
        track.addEventListener("mute", () => paintPeerScreen(peer));
        track.addEventListener("unmute", () => paintPeerScreen(peer));
        track.addEventListener("ended", () => paintPeerScreen(peer));
        return;
      }
      peer.videoTrack = track;
      paintPeerVideo(peer);
      track.addEventListener("mute", () => paintPeerVideo(peer));
      track.addEventListener("unmute", () => paintPeerVideo(peer));
      track.addEventListener("ended", () => paintPeerVideo(peer));
      layoutStage();
    };
    pc.onconnectionstatechange = () => {
      setPeerState(peer, pc.connectionState);
      if (pc.connectionState === "connected") {
        capCameraSenders(pc);
        paintRelay(peer);
        if (!peer.askedKey) {
          peer.askedKey = true;
          sealedSendOpaque(peer.id, { k: "key" });
        }
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" && peer.initiator) {
        pc.restartIce();
      }
    };
    if (initiator) preparePeer(peer);
    return peer;
  }
  function setPeerState(peer, text) {
    peer.state = text;
    if (peer.tile) peer.tile.dataset.state = text;
    const row = peer.tile ? rowOf.get(peer.tile) : null;
    if (row) row.dataset.state = text;
    if ((text === "failed" || text === "closed") && peer.tile) peer.tile.classList.remove("playing");
    layoutStage();
    updateCount();
  }
  async function flushPending(peer) {
    const queued = peer.pending.splice(0);
    for (const cand of queued) {
      try {
        await peer.pc.addIceCandidate(cand);
      } catch (err) {
        if (!peer.ignoreOffer) console.warn("candidate rejected", err);
      }
    }
  }
  function onDescription(peer, type, sdp) {
    const run = () => applyDescription(peer, type, sdp);
    peer.desc = (peer.desc || Promise.resolve()).then(run, run);
    return peer.desc;
  }
  async function applyDescription(peer, type, sdp) {
    const pc = peer.pc;
    if (!pc || pc.signalingState === "closed") return;
    const readyForOffer = !peer.makingOffer && (pc.signalingState === "stable" || peer.settingAnswer);
    const collision = type === "offer" && !readyForOffer;
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    if (type === "answer" && pc.signalingState !== "have-local-offer") return;
    try {
      if (collision && peer.polite && pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription({ type: "rollback" });
      }
      peer.settingAnswer = type === "answer";
      await pc.setRemoteDescription({ type, sdp });
      peer.settingAnswer = false;
      preparePeer(peer);
      if (type === "offer") {
        await pc.setLocalDescription();
        sealedSendSdp(peer, "answer", pc.localDescription.sdp);
      }
      await flushPending(peer);
      capCameraSenders(pc);
    } catch (err) {
      peer.settingAnswer = false;
      const why = err && err.message ? err.message : String(err);
      state.workerErrors.push("description failed for " + shortPeer(peer.id) + ": " + why);
      say("the " + type + " with " + shortPeer(peer.id) + " failed; the link has no media");
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
      if (!peer.ignoreOffer) console.warn("candidate rejected", err);
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
    wipeKeys(peer);
    state.peers.delete(id);
    layoutStage();
    updatePinCount();
    updateCount();
    paintHandQueue();
  }

  // src/sealed.ts
  var BUILD_Q = "?" + ((document.currentScript || { src: "" }).src.split("?")[1] || "v=1");
  var VERIFY_EMOJI = [
    ["\u2693", "anchor", "2693"],
    ["\u{1F514}", "bell", "1F514"],
    ["\u{1F6B2}", "bicycle", "1F6B2"],
    ["\u{1F335}", "cactus", "1F335"],
    ["\u{1F4F7}", "camera", "1F4F7"],
    ["\u{1F56F}", "candle", "1F56F"],
    ["\u{1F955}", "carrot", "1F955"],
    ["\u{1F550}", "clock", "1F550"],
    ["\u2601\uFE0F", "cloud", "2601"],
    ["\u{1F451}", "crown", "1F451"],
    ["\u{1F42C}", "dolphin", "1F42C"],
    ["\u{1F409}", "dragon", "1F409"],
    ["\u{1F941}", "drum", "1F941"],
    ["\u{1F985}", "eagle", "1F985"],
    ["\u{1F41F}", "fish", "1F41F"],
    ["\u{1F47B}", "ghost", "1F47B"],
    ["\u{1F3B8}", "guitar", "1F3B8"],
    ["\u{1F528}", "hammer", "1F528"],
    ["\u{1F681}", "helicopter", "1F681"],
    ["\u{1F511}", "key", "1F511"],
    ["\u{1F9F2}", "magnet", "1F9F2"],
    ["\u{1F344}", "mushroom", "1F344"],
    ["\u{1F989}", "owl", "1F989"],
    ["\u270F\uFE0F", "pencil", "270F"],
    ["\u{1F680}", "rocket", "1F680"],
    ["\u2702\uFE0F", "scissors", "2702"],
    ["\u{1F6A2}", "ship", "1F6A2"],
    ["\u2600\uFE0F", "sun", "2600"],
    ["\u2602\uFE0F", "umbrella", "2602"],
    ["\u{1F3BB}", "violin", "1F3BB"],
    ["\u{1F41D}", "bee", "1F41D"],
    ["\u{1F40C}", "snail", "1F40C"]
  ];
  var sealUtf8 = new TextEncoder();
  function win() {
    return window;
  }
  function pqModule() {
    return win().stanzePQ;
  }
  function b64e(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if ("toBase64" in view) return view.toBase64();
    let raw = "";
    for (let i = 0; i < view.length; i += 32768)
      raw += String.fromCharCode.apply(null, view.subarray(i, i + 32768));
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
  function cleanSealedName(raw) {
    return String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  }
  function shortPeer(id) {
    return String(id || "").slice(0, 6);
  }
  function pairLabel(peerId) {
    return [state.self, peerId].sort().join("|");
  }
  function verifyEmojis(code) {
    const out = [];
    for (const ch of String(code || "").toLowerCase()) {
      const index = B32.indexOf(ch);
      if (index < 0) continue;
      out.push(VERIFY_EMOJI[index % VERIFY_EMOJI.length]);
      if (out.length === 6) break;
    }
    return out;
  }
  function verifyText(code) {
    return verifyEmojis(code).map((pair) => pair[0]).join(" ");
  }
  function chatAAD(peerId, seq) {
    return sealUtf8.encode("pq-e2e v2 chat " + pairLabel(peerId) + " " + seq);
  }
  function fileAAD(peerId, fromId, xfer, seq) {
    return sealUtf8.encode(
      "pq-e2e v2 file " + pairLabel(peerId) + " from " + String(fromId) + " " + xfer + " " + seq
    );
  }
  function sealingAvailable() {
    return typeof RTCRtpScriptTransform === "function" && typeof RTCRtpSender !== "undefined" && "transform" in RTCRtpSender.prototype && typeof RTCRtpReceiver !== "undefined" && "transform" in RTCRtpReceiver.prototype;
  }
  function sealedSendOpaque(to, obj) {
    send({ t: "enc", to, b: encOpaque(obj) });
  }
  function pqCall(fn, input) {
    try {
      return JSON.parse(fn(JSON.stringify(input)));
    } catch {
      return null;
    }
  }
  function sealedRoomCodes() {
    const codes = /* @__PURE__ */ new Set();
    for (const peer of state.peers.values()) if (peer.sas) codes.add(peer.sas);
    return codes;
  }
  function sealedFailedPairs() {
    const out = [];
    for (const peer of state.peers.values()) if (peer.ready === "failed") out.push(peer);
    return out;
  }
  function sealedPairNames(pairs) {
    return pairs.map((peer) => peer.name || shortPeer(peer.id)).join(", ");
  }
  async function sealedOnOffer(peer, sdp) {
    if (state.leaving) return;
    if (peer.keyPromise && !await peer.keyPromise.catch(() => false)) {
      sealedSetE2E(peer, "failed");
      return;
    }
    if (!state.peers.has(peer.id)) return;
    const target = connectPeer(peer.id, false);
    for (const cand of target.candEarly || []) onCandidate(target, cand);
    target.candEarly = [];
    await onDescription(target, "offer", sdp);
  }

  // src/screen.ts
  async function replaceScreenTrack(track) {
    for (const peer of state.peers.values()) {
      const tr = peer.tx && peer.tx.screen;
      if (tr && !peer.waiting) await tr.sender.replaceTrack(track || null).catch(() => {
      });
    }
  }
  async function startShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      say("screen sharing is not supported by this browser");
      return;
    }
    if (!sealingAvailable() || !state.worker) {
      say("this browser cannot seal media frames, so screen sharing stays off");
      return;
    }
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: shareVideo(), audio: true });
    } catch (err) {
      if (err && err.name === "NotAllowedError") return;
      say("screen sharing failed");
      return;
    }
    state.screen = display;
    const video = display.getVideoTracks()[0];
    if (video) {
      video.contentHint = "detail";
      video.addEventListener("ended", () => stopShare());
      await replaceScreenTrack(video);
      const tile = makeTile(state.name, state.name, true, true);
      tile.dataset.state = "connected";
      tile.querySelector(".state").textContent = "your screen";
      tile.classList.add("playing");
      const el2 = tile.querySelector("video");
      el2.srcObject = display;
      el2.play().catch(() => {
      });
      el2.addEventListener("resize", () => layoutStage());
      el2.addEventListener("loadedmetadata", () => layoutStage());
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
    stopTracks(state.screen);
    if (state.screenSource) {
      disconnectQuietly(state.screenSource);
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

  // src/devices.ts
  var DEVICE_NOUN = { video: "camera", audio: "microphone" };
  function devicePickers(kind) {
    return kind === "video" ? [$("cam-select")] : [$("mic-select")];
  }
  function deviceList(kind) {
    return kind === "video" ? state.devCams : state.devMics;
  }
  function chosenDevice(kind) {
    return (kind === "video" ? state.camId : state.micId) || "";
  }
  function setChosenDevice(kind, id) {
    if (kind === "video") state.camId = id;
    else state.micId = id;
    store(kind === "video" ? "camId" : "micId", id);
  }
  function paintDeviceSelect(select, kind, list, wanted) {
    if (!select) return "";
    const noun = DEVICE_NOUN[kind];
    const seen = /* @__PURE__ */ new Set();
    const frag = document.createDocumentFragment();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = `system ${noun}`;
    frag.appendChild(auto);
    let count = 0;
    for (const device of list) {
      if (!device.deviceId || seen.has(device.deviceId)) continue;
      seen.add(device.deviceId);
      count++;
      const opt = document.createElement("option");
      opt.textContent = device.label || `${noun} ${count}`;
      opt.value = device.deviceId;
      frag.appendChild(opt);
    }
    const complete = list.some((device) => !!device.label);
    let value = "";
    if (wanted && seen.has(wanted)) value = wanted;
    else if (wanted && !complete) {
      const opt = document.createElement("option");
      opt.value = wanted;
      opt.textContent = `${noun} (last used)`;
      frag.appendChild(opt);
      value = wanted;
    }
    select.replaceChildren(frag);
    select.value = value;
    return value;
  }
  function paintDevices() {
    for (const kind of ["video", "audio"]) {
      const wanted = chosenDevice(kind);
      const list = deviceList(kind);
      let kept = "";
      for (const select of devicePickers(kind)) kept = paintDeviceSelect(select, kind, list, wanted);
      if (wanted && kept !== wanted) {
        setChosenDevice(kind, "");
        say(
          `the ${DEVICE_NOUN[kind]} you chose is gone; the system ${DEVICE_NOUN[kind]} will be used`
        );
      }
    }
    paintDeviceMenu();
  }
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let all;
    try {
      all = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    state.devCams = all.filter((device) => device.kind === "videoinput");
    state.devMics = all.filter((device) => device.kind === "audioinput");
    paintDevices();
  }
  var QUALITY_LABEL = {
    "640x360@30": "360p 30",
    "1280x720@30": "720p 30",
    "1920x1080@30": "1080p 30",
    "1920x1080@60": "1080p 60",
    "2560x1440@30": "1440p 30"
  };
  function deviceRows(kind) {
    const noun = DEVICE_NOUN[kind];
    const rows = [{ value: "", label: `system ${noun}` }];
    const seen = /* @__PURE__ */ new Set();
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
  function qualityRows() {
    return Object.keys(QUALITY).map((value) => ({ value, label: QUALITY_LABEL[value] || value }));
  }
  function paintMenuChoice(list, rows, current, pick) {
    if (!list) return;
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item menu-choice";
      button.setAttribute("aria-pressed", String(row.value === current));
      const tick = document.createElement("span");
      tick.className = "menu-tick";
      tick.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "menu-text";
      text.textContent = row.label;
      button.append(tick, text);
      button.addEventListener("click", () => pick(row.value));
      frag.appendChild(button);
    }
    list.replaceChildren(frag);
  }
  function paintDeviceMenu() {
    paintMenuChoice($("dev-mic-list"), deviceRows("audio"), state.micId, (value) => {
      onDevicePicked("audio", value);
      paintDeviceMenu();
    });
    paintMenuChoice($("dev-cam-list"), deviceRows("video"), state.camId, (value) => {
      onDevicePicked("video", value);
      paintDeviceMenu();
    });
    paintMenuChoice($("dev-camq-list"), qualityRows(), state.quality, (value) => {
      state.quality = value;
      store("quality", value);
      paintDeviceMenu();
      applyQuality();
    });
    paintMenuChoice($("dev-scrq-list"), qualityRows(), state.shareQuality, (value) => {
      state.shareQuality = value;
      store("sharequality", value);
      paintDeviceMenu();
    });
  }
  function constraintsFor(kind, pick) {
    if (kind === "video") {
      const base = camVideo();
      return pick ? { ...base, deviceId: { exact: pick } } : { ...base, facingMode: "user" };
    }
    return pick ? { ...MIC_AUDIO, deviceId: { exact: pick } } : { ...MIC_AUDIO };
  }
  async function askKind(kind, pick) {
    const want = (id) => kind === "video" ? { video: constraintsFor("video", id) } : { audio: constraintsFor("audio", id) };
    const first = await ask(want(pick));
    if (first.stream || !pick) return first;
    if (!first.err || first.err.name !== "OverconstrainedError" && first.err.name !== "NotFoundError")
      return first;
    if (pick === chosenDevice(kind)) {
      setChosenDevice(kind, "");
      paintDevices();
      say(
        `the ${DEVICE_NOUN[kind]} you chose was not available; the system ${DEVICE_NOUN[kind]} will be used`
      );
    }
    return ask(want(""));
  }
  async function switchDevice(kind, id) {
    if (!sealingAvailable()) {
      say("this browser cannot seal media frames, so the device stays off");
      return;
    }
    const got = await askKind(kind, id);
    const track = got.stream ? kind === "video" ? got.stream.getVideoTracks()[0] : got.stream.getAudioTracks()[0] : null;
    if (!track) {
      const refused = got.err && got.err.name === "NotAllowedError";
      say(
        refused ? `the ${DEVICE_NOUN[kind]} was refused` : `that ${DEVICE_NOUN[kind]} is not available`
      );
      paintDevices();
      return;
    }
    if (kind === "video") {
      const wasOn = state.cam;
      await adoptCam(track);
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
  function onDevicePicked(kind, id) {
    setChosenDevice(kind, id || "");
    for (const select of devicePickers(kind)) {
      if (select && select.value !== (id || "")) select.value = id || "";
    }
    if (!state.room || state.leaving) return;
    switchDevice(kind, id || "").catch(() => {
    });
  }
  var devTimer = null;
  function onDeviceChange() {
    if (state.camTrack && state.camTrack.readyState === "ended") {
      state.camTrack = null;
      if (state.cam) {
        state.cam = false;
        paintSelfCam(false);
        refreshSelf();
        sendState();
      }
    }
    if (state.micTrack && state.micTrack.readyState === "ended") {
      state.micTrack = null;
      if (state.mic) {
        state.mic = false;
        refreshSelf();
        sendState();
      }
    }
    if (devTimer) clearTimeout(devTimer);
    devTimer = setTimeout(() => {
      devTimer = null;
      refreshDevices();
    }, 250);
  }
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
      say("this browser offers no camera and no microphone: you joined to watch and listen");
      updateButtons();
      return;
    }
    const missing = [];
    const refused = [];
    const noteErr = (err, list) => {
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) refused.push(list);
      else missing.push(list);
    };
    if (wantMic && wantCam) {
      const both = await ask({
        audio: constraintsFor("audio", state.micId),
        video: constraintsFor("video", state.camId)
      });
      if (both.stream) {
        await adoptMic(both.stream.getAudioTracks()[0]);
        await adoptCam(both.stream.getVideoTracks()[0]);
      } else if (both.err && (both.err.name === "NotAllowedError" || both.err.name === "SecurityError")) {
        refused.push("camera and microphone");
      } else {
        const parts = await Promise.all([
          askKind("audio", state.micId),
          askKind("video", state.camId)
        ]);
        const mic = parts[0].stream ? parts[0].stream.getAudioTracks()[0] : null;
        const cam = parts[1].stream ? parts[1].stream.getVideoTracks()[0] : null;
        await adoptMic(mic);
        await adoptCam(cam);
        if (!mic) noteErr(parts[0].err, "microphone");
        if (!cam) noteErr(parts[1].err, "camera");
      }
    } else if (wantMic) {
      const mic = await askKind("audio", state.micId);
      const track = mic.stream ? mic.stream.getAudioTracks()[0] : null;
      await adoptMic(track);
      if (!track) noteErr(mic.err, "microphone");
    } else {
      const cam = await askKind("video", state.camId);
      const track = cam.stream ? cam.stream.getVideoTracks()[0] : null;
      await adoptCam(track);
      if (!track) noteErr(cam.err, "camera");
    }
    state.mic = !!state.micTrack;
    state.cam = !!state.camTrack;
    if (refused.length) {
      say(
        `the ${joinWords(refused)} ${refused.length > 1 ? "were" : "was"} refused; you joined without ${refused.length > 1 ? "them" : "it"}`
      );
    } else if (missing.length) {
      say(`no ${joinWords(missing)}; you joined without ${missing.length > 1 ? "them" : "it"}`);
    }
    refreshDevices();
    refreshSelf();
  }
  function prepareLocal() {
    state.outStream = new MediaStream();
    const self2 = makeTile(state.name, state.name, true);
    setLocalTile(self2);
    self2.dataset.state = "connected";
    self2.querySelector(".state").textContent = "you";
    applyFlags(self2, state.mic, state.cam, isAdmin(state.self));
    applyMirror();
    updateButtons();
  }
  function refreshSelf() {
    const self2 = ownTile();
    applyFlags(self2, state.mic, state.cam, isAdmin(state.self));
    paintRowDeaf(document.querySelector('.plist-row[data-local="yes"]'), state.deaf);
    updateButtons();
    if (state.waiting) paintWaiting();
  }
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
    playSfx(on ? "hammer" : "timp");
    refreshSelf();
    sendState();
  }
  function sealOne(peer, side, dir, kind) {
    try {
      side.transform = new RTCRtpScriptTransform(state.worker, {
        // `from` names who sends these frames: the page on send, the peer on receive;
        // the AAD binds it, so a moved or reflected frame can not match.
        pair: pairLabel(peer.id),
        peer: peer.id,
        dir,
        kind,
        from: dir === "send" ? state.self : peer.id
      });
    } catch (err) {
      state.workerErrors.push(dir + " transform: " + err);
      state.sealFault = "this browser refused the frame transform, so no media is sent";
      say(state.sealFault);
      return false;
    }
    return true;
  }
  function preparePeer(peer) {
    if (peer.tx) return;
    peer.tx = {};
    peer.sealed = true;
    const used = /* @__PURE__ */ new Set();
    for (const kind of ["audio", "video", "screen"]) {
      const media = kind === "screen" ? "video" : kind;
      let tr = peer.pc.getTransceivers().find((t) => !t.stopped && !used.has(t) && t.receiver.track.kind === media);
      if (!tr) tr = peer.pc.addTransceiver(media, { direction: "sendrecv" });
      used.add(tr);
      tr.direction = "sendrecv";
      peer.tx[kind] = tr;
      const send2 = sealOne(peer, tr.sender, "send", kind);
      const recv = sealOne(peer, tr.receiver, "recv", kind);
      if (!send2 || !recv) {
        peer.sealed = false;
        continue;
      }
      const track = kind === "screen" ? state.screen && state.screen.getVideoTracks()[0] : state.outStream && state.outStream.getTracks().find((t) => t.kind === kind);
      if (!track) continue;
      if (peer.waiting) continue;
      tr.sender.replaceTrack(track).catch(() => {
      });
      if (kind === "video") capVideoSender(tr.sender);
    }
  }
  function attachTrack(peer, track) {
    if (peer.sealed === false || peer.waiting) return;
    const tr = peer.tx && peer.tx[track.kind];
    if (!tr) return;
    tr.sender.replaceTrack(track).catch(() => {
    });
    if (track.kind === "video") capVideoSender(tr.sender);
  }
  function attachScreen(peer) {
    if (peer.sealed === false || peer.waiting) return;
    const tr = peer.tx && peer.tx.screen;
    const track = state.screen && state.screen.getVideoTracks()[0];
    if (tr && track) tr.sender.replaceTrack(track).catch(() => {
    });
  }
  function publishTrack(track) {
    if (!track) return;
    for (const peer of state.peers.values()) {
      if (peer.pc) attachTrack(peer, track);
    }
  }
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
        disconnectQuietly(state.micSource);
        if (state.micAnalyser) {
          disconnectQuietly(state.micAnalyser);
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
    if (prev && prev !== track) stopQuietly(prev);
  }
  function setVideoTrack(video, track) {
    const stream = video.srcObject;
    if (!stream || typeof stream.getVideoTracks !== "function" || stream.getVideoTracks()[0] !== track) {
      video.srcObject = new MediaStream([track]);
    }
  }
  function camSource() {
    if (state.freeze && state.freezeTrack && state.freezeTrack.readyState === "live")
      return state.freezeTrack;
    return lookTrack() || state.camTrack;
  }
  function paintSelfCam(on) {
    const self2 = ownTile();
    if (!self2) return;
    const video = self2.querySelector("video");
    const track = camSource();
    if (on && track) {
      setVideoTrack(video, track);
      self2.classList.add("playing");
      video.play().catch(() => {
      });
    } else {
      self2.classList.remove("playing");
      detachMedia(video);
    }
    layoutStage();
  }
  function paintPeerVideo(peer) {
    const video = peer.tile && peer.tile.querySelector("video");
    if (!video) return;
    const track = peer.videoTrack;
    const live = track && track.readyState === "live" && !track.muted && peer.cam !== false;
    if (!state.deaf && live) {
      setVideoTrack(video, track);
      peer.tile.classList.add("playing");
      video.play().catch(() => {
      });
    } else {
      dropPeerCamera(peer);
    }
    layoutStage();
  }
  function dropPeerCamera(peer) {
    const video = peer.tile && peer.tile.querySelector("video");
    if (!video) return;
    peer.tile.classList.remove("playing");
    detachMedia(video);
  }
  function paintRemoteVideo() {
    for (const peer of state.peers.values()) {
      paintPeerVideo(peer);
      paintPeerScreen(peer);
    }
  }
  function makeScreenTile(peer) {
    if (peer.screenTile) return peer.screenTile;
    peer.screenTile = makeTile(peer.id, `${peer.name}, screen`, false, true);
    peer.screenTile.dataset.peer = peer.id;
    peer.screenTile.querySelector("video").addEventListener("resize", () => layoutStage());
    applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
    return peer.screenTile;
  }
  function paintPeerScreen(peer) {
    const track = peer.screenTrack;
    if (!track) return;
    if (!state.deaf && peer.screenShared !== false && track.readyState === "live" && !track.muted) {
      const tile = makeScreenTile(peer);
      const video = tile.querySelector("video");
      setVideoTrack(video, track);
      tile.classList.add("playing");
      video.play().catch(() => {
      });
    } else if (peer.screenTile) {
      const video = peer.screenTile.querySelector("video");
      peer.screenTile.classList.remove("playing");
      detachMedia(video);
    }
    layoutStage();
  }
  function dropPeerScreen(peer) {
    if (!peer.screenTile) return;
    const video = peer.screenTile.querySelector("video");
    peer.screenTile.classList.remove("playing");
    detachMedia(video);
    peer.screenTile.remove();
    peer.screenTile = null;
    layoutStage();
  }
  function clearFreeze() {
    if (!state.freeze) return;
    if (state.freezeTrack) stopQuietly(state.freezeTrack);
    state.freeze = false;
    state.freezeTrack = null;
    state.freezeCanvas = null;
    const box = $("freeze");
    if (box) box.checked = false;
  }
  async function adoptCam(track) {
    if (!track) return;
    const prev = state.camTrack;
    state.camTrack = track;
    clearFreeze();
    track.contentHint = "motion";
    track.enabled = true;
    paintSelfCam(true);
    if (state.outStream) {
      for (const old of state.outStream.getVideoTracks()) {
        if (old !== track) state.outStream.removeTrack(old);
      }
      if (!state.outStream.getVideoTracks().includes(track)) state.outStream.addTrack(track);
      publishTrack(track);
      await lookRestart();
    }
    if (prev && prev !== track) stopQuietly(prev);
    applyMirror();
  }
  async function openInput(kind) {
    const got = await askKind(kind, kind === "video" ? state.camId : state.micId);
    const track = got.stream ? got.stream.getTracks()[0] : null;
    if (!track) {
      say(
        got.err && got.err.name === "NotAllowedError" ? `the ${DEVICE_NOUN[kind]} was refused` : `the ${DEVICE_NOUN[kind]} is not available`
      );
      return false;
    }
    await (kind === "video" ? adoptCam(track) : adoptMic(track));
    refreshDevices();
    return true;
  }
  async function enableMic() {
    if (!sealingAvailable()) {
      say("this browser cannot seal media frames, so the microphone stays off");
      return;
    }
    if (!state.micTrack && !await openInput("audio")) return;
    state.mic = true;
    store("mic", 1);
    playSfx("timp");
    if (state.micGain) state.micGain.gain.value = 1;
    if (state.micTrack) state.micTrack.enabled = true;
    updateButtons();
    sendState();
  }
  function disableMic(persist = true) {
    playSfx("hammer");
    state.mic = false;
    if (persist) store("mic", 0);
    if (state.micGain) state.micGain.gain.value = 0;
    updateButtons();
    sendState();
  }
  async function enableCam() {
    if (!sealingAvailable()) {
      say("this browser cannot seal media frames, so the camera stays off");
      return;
    }
    if (!state.camTrack && !await openInput("video")) return;
    state.cam = true;
    store("cam", 1);
    if (state.camTrack) state.camTrack.enabled = true;
    paintSelfCam(true);
    updateButtons();
    sendState();
  }
  function disableCam(persist = true) {
    state.cam = false;
    if (persist) store("cam", 0);
    const track = state.camTrack;
    state.camTrack = null;
    clearFreeze();
    lookStop();
    if (track) stopQuietly(track);
    paintSelfCam(false);
    updateButtons();
    sendState();
  }
  async function buildAudio() {
    state.audioCtx = newAudioCtx({ sampleRate: 48e3, latencyHint: "interactive" });
    if (!state.audioCtx) return;
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
  function startMeter() {
    if (!state.audioCtx || !state.micSource || state.micAnalyser) return;
    state.micAnalyser = state.audioCtx.createAnalyser();
    state.micAnalyser.fftSize = 1024;
    state.micSource.connect(state.micAnalyser);
  }

  // src/audio.ts
  var SPEAK_MS = 100;
  var SPEAK_ON = 0.03;
  var SPEAK_HOLD_MS = 400;
  var speakBufs = /* @__PURE__ */ new WeakMap();
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
  function paintSpeaking(tile, level, hold) {
    if (!tile) return;
    const now = performance.now();
    if (level >= SPEAK_ON) hold.last = now;
    const on = now - (hold.last || 0) < SPEAK_HOLD_MS;
    tile.classList.toggle("speaking", on);
    const row = rowOf.get(tile);
    if (row) row.classList.toggle("speaking", on);
  }
  function speakTick() {
    const own = ownTile();
    const level = analyserLevel(state.micAnalyser);
    state.meterPeak = Math.max(level, state.meterPeak * 0.9);
    if (own && state.ownSpoke) {
      paintSpeaking(own, state.mic ? level : 0, state.ownSpoke);
    }
    for (const peer of state.peers.values()) {
      const level2 = analyserLevel(peer.meter);
      peer.meterPeak = Math.max(level2, (peer.meterPeak || 0) * 0.9);
      if (!peer.tile) continue;
      if (!peer.spoke) peer.spoke = { last: 0 };
      paintSpeaking(peer.tile, peer.mic ? level2 : 0, peer.spoke);
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
  function micLevelCells(peak) {
    const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
    if (!(db > -60)) return { db: "0 dB", pct: "0 %", state: "silent" };
    return {
      db: `${Math.round(db)} dB`,
      pct: `${Math.round((db + 60) / 60 * 100)} %`,
      state: "transmitting"
    };
  }
  function noiseWasm() {
    if (!state.noiseWasm) {
      state.noiseWasm = fetch("/gtcrn.wasm").then((res) => {
        if (!res.ok) throw new Error("gtcrn.wasm " + res.status);
        return res.arrayBuffer();
      });
    }
    return state.noiseWasm;
  }
  async function makeDenoiseNode(ctx) {
    const [binary] = await Promise.all([
      noiseWasm(),
      ctx.audioWorklet.addModule(scriptURL("/gtcrn-node.js"))
    ]);
    return new AudioWorkletNode(ctx, "gtcrn", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { wasm: new Uint8Array(binary) }
    });
  }
  function prefetchNoise() {
    const warm = (url) => fetch(url).then((res) => res.ok ? res.arrayBuffer() : null).catch(() => {
    });
    void warm("/fe.wasm");
    void warm("/fe.q8");
  }
  function feWorker() {
    if (!state.feWorker) {
      state.feWorker = new Worker(scriptURL("/fastenhancer-worker.js"));
      state.feWorker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.ev === "error") say("the noise filter stopped: " + String(msg.text || "unknown"));
      };
      state.feWorker.postMessage({ ev: "warm" });
    }
    return state.feWorker;
  }
  async function makeFastEnhancerNode(ctx) {
    await ctx.audioWorklet.addModule(scriptURL("/fastenhancer-worklet.js"));
    const node = new AudioWorkletNode(ctx, "fastenhancer", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit"
    });
    const id = ++state.feSeq;
    feWorker().postMessage({ ev: "attach", id, port: node.port }, [node.port]);
    return { node, id };
  }
  async function setNoise(on) {
    if (!state.micSource || !state.audioCtx) {
      state.denoiseOn = false;
      return false;
    }
    if (on && !state.denoise) {
      try {
        const { node, id } = await makeFastEnhancerNode(state.audioCtx);
        state.denoise = node;
        state.denoiseFeId = id;
        state.denoise.connect(state.micGain);
      } catch (err) {
        console.warn("fastenhancer on the microphone unavailable", err);
        try {
          state.denoise = await makeDenoiseNode(state.audioCtx);
          state.denoise.connect(state.micGain);
        } catch (err2) {
          console.warn("noise suppression unavailable", err2);
          state.denoise = null;
          state.denoiseOn = false;
          return false;
        }
      }
    }
    disconnectQuietly(state.micSource);
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
    if (state.audioCtx && state.audioCtx.state === "suspended") {
      state.audioCtx.resume().catch(() => {
        document.addEventListener(
          "click",
          () => state.audioCtx && state.audioCtx.resume().catch(() => {
          }),
          {
            once: true
          }
        );
      });
    }
  }
  function newAudioCtx(opts) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      return new Ctx(opts);
    } catch {
      return null;
    }
  }
  function ensurePlayback() {
    if (state.playCtx) {
      resumePlayback();
      return state.playCtx;
    }
    state.playCtx = newAudioCtx({ latencyHint: "interactive" });
    if (!state.playCtx) return null;
    resumePlayback();
    return state.playCtx;
  }
  function resumePlayback() {
    const ctx = state.playCtx;
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().catch(() => {
      document.addEventListener("click", () => ctx.resume().catch(() => {
      }), { once: true });
    });
  }
  function routeAudio(peer, track) {
    const ctx = ensurePlayback();
    if (!ctx) {
      const el2 = peer.audioEl || new Audio();
      el2.autoplay = true;
      el2.srcObject = new MediaStream([track]);
      el2.volume = state.deaf ? 0 : Math.min(volGain(peer.vol), 1);
      el2.play().catch(() => {
      });
      peer.audioEl = el2;
      return;
    }
    dropAudio(peer);
    const pump = new Audio();
    pump.muted = true;
    pump.volume = 0;
    pump.autoplay = true;
    pump.srcObject = new MediaStream([track]);
    pump.play().catch(() => {
    });
    peer.pump = pump;
    peer.gain = ctx.createGain();
    peer.gain.gain.value = state.deaf ? 0 : volGain(peer.vol);
    peer.audioSrc = ctx.createMediaStreamSource(new MediaStream([track]));
    peer.audioSrc.connect(peer.gain);
    peer.gain.connect(ctx.destination);
    peer.meter = ctx.createAnalyser();
    peer.meter.fftSize = 1024;
    peer.audioSrc.connect(peer.meter);
    if (peer.inNoise) void setPeerNoise(peer, true, peer.inEngine || "fastenhancer");
    resumePlayback();
    if (ctx.state === "suspended")
      say("the browser holds the audio output; tap the page once to hear the room");
  }
  function dropAudio(peer) {
    if (!peer) return;
    if (peer.inDenoise) {
      disconnectQuietly(peer.inDenoise);
      peer.inDenoise = null;
    }
    if (peer.feId) {
      feWorker().postMessage({ ev: "detach", id: peer.feId });
      peer.feId = 0;
    }
    if (peer.audioSrc) {
      disconnectQuietly(peer.audioSrc);
      peer.audioSrc = null;
    }
    if (peer.meter) {
      disconnectQuietly(peer.meter);
      peer.meter = null;
    }
    if (peer.gain) {
      disconnectQuietly(peer.gain);
      peer.gain = null;
    }
    if (peer.pump) {
      detachMedia(peer.pump);
      peer.pump = null;
    }
    if (peer.audioEl) {
      detachMedia(peer.audioEl);
      peer.audioEl = null;
    }
  }
  function wirePlayNoise(peer) {
    if (!peer.audioSrc || !peer.gain) return;
    disconnectQuietly(peer.audioSrc);
    if (peer.inDenoise) {
      disconnectQuietly(peer.inDenoise);
    }
    if (peer.inNoise && peer.inDenoise) {
      peer.audioSrc.connect(peer.inDenoise);
      peer.inDenoise.connect(peer.gain);
    } else {
      peer.audioSrc.connect(peer.gain);
    }
    if (peer.meter) peer.audioSrc.connect(peer.meter);
  }
  async function setPeerNoise(peer, on, engine = "fastenhancer") {
    if (!peer) return;
    const want = on ? engine : "off";
    if (want === "off") {
      if (!peer.inNoise && !peer.inDenoise) return;
    } else if (peer.inNoise && peer.inEngine === want && peer.inDenoise) {
      return;
    }
    const ctx = state.playCtx || ensurePlayback();
    if (want !== "off" && !ctx) {
      say("this browser can not cancel noise without Web Audio");
      return;
    }
    if (peer.inDenoise) {
      disconnectQuietly(peer.inDenoise);
      peer.inDenoise = null;
    }
    if (peer.feId) {
      feWorker().postMessage({ ev: "detach", id: peer.feId });
      peer.feId = 0;
    }
    if (want === "off") {
      peer.inNoise = false;
      peer.inEngine = "off";
      wirePlayNoise(peer);
      return;
    }
    try {
      if (want === "gtcrn") {
        peer.inDenoise = await makeDenoiseNode(ctx);
      } else {
        const made = await makeFastEnhancerNode(ctx);
        peer.inDenoise = made.node;
        peer.feId = made.id;
      }
    } catch (err) {
      console.warn("noise cancel unavailable", err);
      peer.inNoise = false;
      peer.inEngine = "off";
      wirePlayNoise(peer);
      say("the noise cancel is not available in this browser");
      return;
    }
    peer.inNoise = true;
    peer.inEngine = want;
    wirePlayNoise(peer);
  }
  function stateFrame() {
    return {
      k: "state",
      mic: state.mic,
      cam: state.cam,
      deaf: state.deaf,
      screen: !!state.screen,
      hand: state.hand,
      ts: state.handTs,
      // This build reads padded frames, so a peer may round its frame sizes up.
      pad: 1
    };
  }
  function sendState() {
    refreshSelf();
    if (!state.self || state.leaving) return;
    toSealed(stateFrame());
  }
  function sealedSendState(peer) {
    if (!peer.keys || peer.waiting) return;
    sealedSend(peer, stateFrame());
  }
  function setHand(on) {
    if (state.waiting || state.hand === on) return;
    state.hand = on;
    state.handTs = on ? Date.now() : 0;
    const self2 = ownTile();
    if (self2) applyFlags(self2, state.mic, state.cam, isAdmin(state.self));
    updateButtons();
    sendState();
    paintHandQueue();
  }
  function handRows() {
    const rows = [];
    for (const peer of state.peers.values()) {
      if (peer.hand)
        rows.push({ id: String(peer.id), ts: peer.handTs || 0, name: peer.name, self: false });
    }
    if (state.hand)
      rows.push({
        id: String(state.self),
        ts: state.handTs || 0,
        name: state.name || "you",
        self: true
      });
    rows.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }
  function handPlace(id) {
    const at = handRows().findIndex((row) => row.id === String(id));
    return at < 0 ? 0 : at + 1;
  }
  function paintHandQueue() {
    const panel = document.getElementById("hand-queue");
    const list = document.getElementById("hand-queue-list");
    if (!panel || !list) return;
    const rows = handRows();
    panel.hidden = rows.length === 0;
    list.replaceChildren();
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "hq-row";
      const name = document.createElement("span");
      name.className = "hq-name";
      name.textContent = row.self ? `${row.name} (you)` : row.name;
      li.appendChild(name);
      if (isAdmin(state.self) && !row.self) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "hq-lower";
        b.textContent = "lower";
        b.setAttribute("aria-label", `take the hand of ${row.name} down`);
        b.addEventListener("click", () => askLower(row.id));
        li.appendChild(b);
      }
      list.appendChild(li);
    }
  }
  function askLower(id) {
    const peer = state.peers.get(id);
    if (peer) sealedSend(peer, { k: "lower" });
  }
  function setCtrl(id, text, on) {
    const btn = $(id);
    const label = btn.querySelector("span");
    if (label) label.textContent = text;
    else btn.textContent = text;
    btn.setAttribute("aria-pressed", String(!!on));
  }
  function updateButtons() {
    setCtrl("mic-btn", state.mic ? "mic on" : "mic off", state.mic);
    setCtrl("cam-btn", state.cam ? "camera on" : "camera off", state.cam);
    setCtrl("deaf-btn", state.deaf ? "undeafen" : "deafen", state.deaf);
    setCtrl("share-btn", state.screen ? "stop share" : "share screen", !!state.screen);
    setCtrl("hand-btn", state.hand ? "lower hand" : "raise hand", state.hand);
    $("mirror").checked = state.mirror;
    $("pip").checked = state.selfPip;
    $("voice-tiles").checked = !state.voiceTiles;
    $("noise-live").checked = state.micSource ? state.denoiseOn : state.noiseWanted;
  }
  function applyMirror() {
    const tile = ownTile();
    if (!tile) return;
    tile.classList.toggle("mirrored", state.mirror);
    layoutStage();
  }

  // src/volume.ts
  var volCall = /* @__PURE__ */ new Map();
  function purgeNamedVolume() {
    if (!window.localStorage) return;
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("rooms.vol.") && !key.startsWith("rooms.vol.fp."))
          localStorage.removeItem(key);
      }
    } catch {
    }
  }
  var VOL_MAX = 200;
  var VOL_EXP = 5 / 3;
  function volGain(pos) {
    const n = Number(pos);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.pow(Math.min(n, VOL_MAX) / 100, VOL_EXP);
  }
  function storedVolume(peer) {
    const raw = peer && peer.fp ? load(`vol.fp.${peer.fp}`) : "";
    const n = parseInt(raw || (peer ? volCall.get(peer.id) : ""), 10);
    if (!Number.isFinite(n)) return 100;
    return clamp(n, 0, 200);
  }
  function saveVolume(peer) {
    if (!peer) return;
    volCall.set(peer.id, peer.vol);
    if (peer.fp) store(`vol.fp.${peer.fp}`, peer.vol);
  }
  function volumePairs(peer) {
    const out = [];
    for (const host of [peer.tile, rowOf.get(peer.tile)]) {
      const range = host ? host.querySelector(".vol-range") : null;
      const num = host ? host.querySelector(".vol-num") : null;
      if (range && num) out.push({ range, num });
    }
    return out;
  }
  function paintVolume(peer) {
    for (const { range, num } of volumePairs(peer)) {
      num.textContent = `${peer.vol}%`;
      range.value = String(peer.vol);
    }
    const g = state.deaf ? 0 : volGain(peer.vol);
    if (peer.gain) peer.gain.gain.value = g;
    if (peer.audioEl) peer.audioEl.volume = Math.min(g, 1);
  }
  function wireVolume(peer) {
    for (const { range } of volumePairs(peer)) {
      range.addEventListener("input", () => {
        const n = parseInt(range.value, 10);
        peer.vol = Number.isFinite(n) ? clamp(n, 0, 200) : 100;
        paintVolume(peer);
        saveVolume(peer);
      });
    }
    paintVolume(peer);
  }
  function applyFlags(tile, mic, cam, admin) {
    if (!tile) return;
    tile.classList.toggle("camoff", cam === false);
    tile.dataset.mic = mic === false ? "off" : "on";
    const row = rowOf.get(tile);
    if (row) {
      row.dataset.mic = mic === false ? "off" : "on";
      row.classList.toggle("camoff", cam === false);
    }
    const who = tile.dataset.peer ? state.peers.get(tile.dataset.peer) : null;
    const waiting = who ? !!(who.waiting && state.waitingRoom) : !!(tile.dataset.local && state.waiting);
    tile.dataset.waiting = waiting ? "yes" : "";
    if (row) row.dataset.waiting = waiting ? "yes" : "";
    const box = tile.querySelector(".flags");
    const handOn = who ? !!who.hand : !!(tile.dataset.local && state.hand);
    const place = handOn ? handPlace(who ? who.id : state.self) : 0;
    paintRowHand(row, handOn);
    if (!box) return;
    const out = [];
    if (waiting) out.push("waiting");
    if (admin) out.push("host");
    if (mic === false) out.push("muted");
    if (cam === false) out.push("no cam");
    if (handOn) out.push(place ? `hand #${place}` : "hand");
    box.replaceChildren();
    for (const text of out) {
      const chip = document.createElement("span");
      chip.textContent = text;
      box.appendChild(chip);
    }
    layoutStage();
  }

  // src/host.ts
  var rowMenuEl = null;
  function hostMenu(host) {
    if (!host) return null;
    if (!host.classList.contains("plist-row")) return host.querySelector(".menu");
    if (!rowMenuEl) {
      rowMenuEl = document.createElement("div");
      rowMenuEl.className = "menu row-menu";
      rowMenuEl.hidden = true;
      document.body.appendChild(rowMenuEl);
    }
    return rowMenuEl;
  }
  function wireDots(host) {
    const dots = host.querySelector(".dots");
    const menu = hostMenu(host);
    if (!dots || !menu) return;
    dots.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = document.querySelectorAll(".menu:not([hidden])");
      for (const other of open) {
        if (other !== menu) other.hidden = true;
      }
      if (!menu.hidden) {
        menu.hidden = true;
        return;
      }
      menu.replaceChildren();
      menu.dataset.peer = host.dataset.peer || "";
      const peer = state.peers.get(host.dataset.peer);
      const add = (label, run) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          menu.hidden = true;
          run();
        });
        menu.appendChild(b);
      };
      if (isAdmin(state.self)) {
        add("give admin", () => {
          const id = host.dataset.peer;
          if (!id || isAdmin(id)) return;
          void issueClaim(state.auth.n + 1, [...state.auth.admins, id]);
        });
        add("mute", () => {
          const peer2 = state.peers.get(host.dataset.peer);
          if (peer2) sealedMute(peer2);
        });
        add("remove from room", () => sealedKick(host.dataset.peer));
      }
      const noiseOn = !!(peer && peer.inNoise);
      const noiseEngine = peer ? peer.inEngine : "";
      const here = (name) => noiseOn && noiseEngine === name ? " (on)" : "";
      add("noise cancel: FastEnhancer" + here("fastenhancer"), () => {
        void setPeerNoise(peer, true, "fastenhancer");
      });
      add("noise cancel: GTCRN" + here("gtcrn"), () => {
        void setPeerNoise(peer, true, "gtcrn");
      });
      add("noise cancel: off" + (noiseOn ? "" : " (on)"), () => {
        void setPeerNoise(peer, false);
      });
      if (peer && peer.sas) {
        const card = document.createElement("div");
        card.className = "sas";
        card.append(...sealedCodePanel(peer));
        menu.appendChild(card);
      }
      if (menu.classList.contains("row-menu")) {
        const r = dots.getBoundingClientRect();
        const width = Math.min(300, window.innerWidth - 16);
        menu.style.left = Math.round(Math.max(4, Math.min(r.left, window.innerWidth - width - 4))) + "px";
        const below = r.bottom + 2;
        const height = menu.offsetHeight;
        const top = below + height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - 4 - height) : below;
        menu.style.top = Math.round(top) + "px";
      }
      menu.hidden = false;
    });
  }
  function wireAdmit(host) {
    const button = host.querySelector(".admit");
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.waiting || !host.dataset.peer) return;
      const peer = state.peers.get(host.dataset.peer);
      if (peer) sealedAdmit(peer);
    });
  }
  function waitingText() {
    const both = state.mic && state.cam;
    const lead = "You are in the waiting room. ";
    const mid = both ? "Your camera and your microphone are on, and every member of the meeting can see and hear you right now, before you are let in. " : `Your camera is ${state.cam ? "on" : "off"} and your microphone is ${state.mic ? "on" : "off"}. Every member of the meeting can see and hear whatever is on, before you are let in. `;
    return `${lead}${mid}Use the buttons below to turn them off if you do not want that. You can not see or hear the meeting, or chat, until a member lets you in.`;
  }
  function paintWaiting() {
    document.body.classList.toggle("self-waiting", state.waiting);
    const banner = $("waiting-banner");
    if (banner) {
      banner.hidden = !state.waiting;
      if (state.waiting) banner.textContent = waitingText();
    }
    const sw = $("waiting-room");
    if (sw) sw.checked = state.waitingRoom;
    $("chat-text").disabled = state.waiting;
    $("file-btn").disabled = state.waiting;
    $("chat-text").placeholder = state.waiting ? "chat opens when you are let in" : "say something";
    for (const peer of state.peers.values()) {
      if (peer.tile) applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
      if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
    }
    const self2 = ownTile();
    if (self2) applyFlags(self2, state.mic, state.cam, isAdmin(state.self));
    updateCount();
    paintHandQueue();
  }
  function admitPeer(id) {
    if (id === state.self) {
      const wasWaiting = state.waiting;
      state.waiting = false;
      if (wasWaiting) toSealed({ k: "in" });
      if (!state.waitingRoom) admitAllHeld();
      if (state.outStream) {
        for (const peer2 of state.peers.values()) {
          for (const track of state.outStream.getTracks()) attachTrack(peer2, track);
          attachScreen(peer2);
        }
      }
      sendState();
      paintWaiting();
      playSfx("pop");
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
  function closeMenus() {
    for (const menu of document.querySelectorAll(".menu:not([hidden])")) {
      menu.hidden = true;
    }
  }
  function markAdmins() {
    const mine = isAdmin(state.self);
    document.body.classList.toggle("is-admin", mine);
    for (const peer of state.peers.values()) {
      applyFlags(peer.tile, peer.mic, peer.cam, isAdmin(peer.id));
      if (peer.screenTile) applyFlags(peer.screenTile, peer.mic, true, isAdmin(peer.id));
    }
    const self2 = ownTile();
    applyFlags(self2, state.mic, state.cam, mine);
    paintHandQueue();
  }
  function updateCount() {
    const total = state.peers.size + 1;
    const live = [...state.peers.values()].filter((p) => p.state === "connected").length + 1;
    const held = [...state.peers.values()].filter((p) => p.waiting).length;
    $("peer-count").textContent = (total === 1 ? "1 peer" : `${live}/${total} peers`) + (held && !state.waiting ? `, ${held} waiting` : "");
    updatePinCount();
  }

  // src/tiles.ts
  var rowOf = /* @__PURE__ */ new WeakMap();
  function paintName(tile, name, local) {
    tile.querySelector(".name").textContent = local ? `${name} (you)` : name;
    tile.querySelector(".avatar").textContent = name || "?";
    tile.setAttribute("aria-label", local ? `${name}, you` : name);
    paintRowName(rowOf.get(tile), name, local);
  }
  function paintRowName(row, name, local) {
    if (!row) return;
    row.querySelector(".row-name").textContent = local ? `${name} (you)` : name;
    row.setAttribute("aria-label", local ? `${name}, you` : name);
  }
  function paintRowDeaf(row, deaf) {
    if (!row) return;
    const mark = row.querySelector(".row-deaf");
    if (mark) mark.hidden = !deaf;
  }
  function paintRowHand(row, hand) {
    if (!row) return;
    const mark = row.querySelector(".row-hand");
    if (mark) mark.hidden = !hand;
  }
  function tileId(tile) {
    const id = tile.dataset.peer || (tile.dataset.local ? "self" : "");
    return id && tile.dataset.screen ? id + ":screen" : id;
  }
  function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === void 0) continue;
      node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const kid of kids) node.append(kid);
    return node;
  }
  function volRange() {
    return el("input", {
      class: "vol-range",
      type: "range",
      min: 0,
      max: 200,
      step: 5,
      value: 100,
      "aria-label": "volume of this participant"
    });
  }
  function lineButton() {
    return [
      el(
        "button",
        { class: "admit", type: "button", title: "let this guest into the room" },
        "let in"
      ),
      el("button", { class: "dots", type: "button", "aria-label": "member actions" }, "\u22EF")
    ];
  }
  function makeTile(id, name, local = false, screen = false) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.state = "new";
    if (local && !screen) tile.dataset.local = "yes";
    if (local && screen) tile.dataset.local = "screen";
    if (screen) {
      tile.dataset.screen = "yes";
      tile.classList.add("screenshare");
    }
    const plain = local || screen;
    tile.tabIndex = 0;
    tile.setAttribute("role", "group");
    tile.append(
      el(
        "video",
        local ? { autoplay: true, playsinline: true, muted: true } : { autoplay: true, playsinline: true }
      ),
      el("div", { class: "avatar" }),
      el("span", { class: "ring", "aria-hidden": "true" })
    );
    if (!plain) {
      tile.append(
        el(
          "div",
          { class: "vol" },
          el("img", { class: "vol-ico", src: "/openmoji/1F50A.svg", alt: "", width: 16, height: 16 }),
          volRange(),
          el("span", { class: "vol-num" }, "100%")
        )
      );
    }
    tile.append(
      el("button", {
        class: "zoom",
        type: "button",
        "aria-pressed": "false",
        "aria-label": "enlarge this picture",
        title: "enlarge"
      }),
      el(
        "div",
        { class: "tag" },
        el("span", { class: "name" }),
        el("span", { class: "flags" }),
        el("span", { class: "state" }),
        ...plain ? [] : [
          el(
            "span",
            { class: "route", title: "the media goes through the relay server" },
            "relay"
          ),
          el("span", { class: "pin", hidden: true })
        ]
      )
    );
    if (!plain) {
      tile.append(...lineButton());
      tile.append(el("div", { class: "menu", hidden: true }));
    }
    paintName(tile, name, local && !screen);
    if (!local) tile.querySelector("video").muted = true;
    if (!plain) wireDots(tile);
    if (!plain) wireAdmit(tile);
    tile.addEventListener("keydown", (event) => {
      if (event.target !== tile || event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const id2 = tileId(tile);
      if (id2) setSpotlight(id2);
    });
    $("stage-main").appendChild(tile);
    if (!screen) rowOf.set(tile, makeRow(id, name, local));
    return tile;
  }
  function makeRow(id, name, local = false) {
    const row = document.createElement("div");
    row.className = "plist-row";
    if (local) row.dataset.local = "yes";
    else row.dataset.peer = id;
    row.dataset.state = "new";
    row.dataset.mic = "on";
    row.tabIndex = 0;
    row.setAttribute("role", "group");
    row.append(
      el("span", { class: "row-name" }),
      el(
        "span",
        { class: "row-deaf", hidden: true },
        el("img", {
          src: "/openmoji/1F507.svg",
          alt: "deafened",
          title: "deafened",
          width: 16,
          height: 16
        })
      ),
      el("span", { class: "row-hand", hidden: true }, "hand")
    );
    if (local) {
      row.append(el("span", { class: "row-you" }, "you"));
    } else {
      row.append(volRange(), el("span", { class: "vol-num" }, "100%"), ...lineButton());
    }
    paintRowName(row, name, local);
    if (!local) {
      wireDots(row);
      wireAdmit(row);
    }
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const id2 = tileId(row);
      if (id2) setSpotlight(id2);
    });
    $("stage-rail").appendChild(row);
    return row;
  }
  var localTile = null;
  function setLocalTile(tile) {
    localTile = tile;
  }
  function ownTile() {
    return localTile && localTile.isConnected ? localTile : null;
  }
  function stageTiles() {
    const out = [];
    const self2 = ownTile();
    if (self2) out.push(self2);
    if (state.screenTile) out.push(state.screenTile);
    for (const peer of state.peers.values()) {
      if (peer.tile) out.push(peer.tile);
      if (peer.screenTile) out.push(peer.screenTile);
    }
    return out;
  }
  function tileHasPicture(tile) {
    if (!tile || tile.classList.contains("camoff")) return false;
    const video = tile.querySelector("video");
    const stream = video && video.srcObject;
    if (!stream || typeof stream.getVideoTracks !== "function") return false;
    const live = stream.getVideoTracks().some((track) => track.readyState === "live" && !track.muted);
    return live && (!tile.dataset.screen || video.videoWidth > 0);
  }
  function spotlightTile() {
    if (!state.spotlight) return null;
    if (state.spotlight === "self") return ownTile();
    const screen = state.spotlight.endsWith(":screen");
    const id = screen ? state.spotlight.slice(0, -7) : state.spotlight;
    if (id === "self") return document.querySelector('.tile[data-local="screen"]');
    for (const peer of state.peers.values()) {
      if (peer.id !== id) continue;
      return screen ? peer.screenTile : peer.tile;
    }
    return null;
  }
  var CORNERS = ["tl", "tr", "bl", "br"];
  var cornerDropAt = 0;
  function storedSelfCorner() {
    const raw = load("selfcorner");
    return CORNERS.includes(raw) ? raw : "br";
  }
  function saveSelfCorner(corner) {
    if (!CORNERS.includes(corner)) return;
    store("selfcorner", corner);
  }
  function pairStage() {
    if (state.spotlight) return false;
    const self2 = ownTile();
    if (!self2 || !tileHasPicture(self2)) return false;
    const guests = stageTiles().filter((t) => t !== self2 && !t.dataset.screen && tileHasPicture(t));
    return guests.length === 1;
  }
  function layoutStage() {
    const main = $("stage-main");
    const rail = $("stage-rail");
    const pipBox = $("self-pip");
    if (!main || !rail) return;
    const spot = spotlightTile();
    if (state.spotlight && !spot) state.spotlight = "";
    const self2 = ownTile();
    const pip = !!(self2 && pipBox && state.selfPip);
    if (pipBox) {
      pipBox.hidden = !pip;
      if (pip) pipBox.dataset.corner = storedSelfCorner();
    }
    if (self2 && pip && self2.parentElement !== pipBox) pipBox.appendChild(self2);
    if (self2 && !pip && self2.parentElement !== main) main.appendChild(self2);
    const bigs = [];
    for (const tile of stageTiles()) {
      const inPip = pip && tile === self2;
      const voice = state.voiceTiles && !tile.dataset.waiting && !tile.dataset.screen;
      const big = !inPip && (spot ? tile === spot : tileHasPicture(tile) || voice);
      if (big) bigs.push(tile);
      tile.hidden = inPip ? false : !big;
      const on = big && !!spot;
      tile.classList.toggle("spot", on);
      const row = rowOf.get(tile);
      if (row) row.classList.toggle("spot", on);
      const zoom = tile.querySelector(".zoom");
      if (zoom) {
        zoom.setAttribute("aria-pressed", String(on));
        zoom.setAttribute("aria-label", on ? "back to the grid" : "enlarge this picture");
        zoom.title = on ? "back to the grid" : "enlarge";
      }
    }
    const alone = bigs.length === 1 ? "yes" : "no";
    if (main.dataset.alone !== alone) main.dataset.alone = alone;
    main.hidden = bigs.length === 0;
  }
  function wirePipDrag() {
    const box = $("self-pip");
    const grid = $("grid");
    if (!box || !grid) return;
    let drag = null;
    box.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target;
      if (target.closest(".vol, .vol-range, .vol-num, .dots, .menu, .sas, .pin, .admit, .zoom"))
        return;
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
        moved: false
      };
      try {
        box.setPointerCapture(event.pointerId);
      } catch {
      }
    });
    box.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < 4 && Math.abs(event.clientY - drag.startY) < 4)
          return;
        drag.moved = true;
        box.classList.add("dragging");
        box.style.width = `${drag.w}px`;
        box.style.height = `${drag.h}px`;
        box.style.right = "auto";
        box.style.bottom = "auto";
      }
      const frame = drag.frame;
      const x = Math.min(
        Math.max(event.clientX - drag.grabX - frame.left, 0),
        Math.max(0, frame.width - drag.w)
      );
      const y = Math.min(
        Math.max(event.clientY - drag.grabY - frame.top, 0),
        Math.max(0, frame.height - drag.h)
      );
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
    });
    const end = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      const frame = drag.frame;
      const rect = box.getBoundingClientRect();
      drag = null;
      try {
        box.releasePointerCapture(event.pointerId);
      } catch {
      }
      box.classList.remove("dragging");
      box.style.width = "";
      box.style.height = "";
      box.style.left = "";
      box.style.top = "";
      box.style.right = "";
      box.style.bottom = "";
      if (!moved) return;
      const right = rect.left + rect.width / 2 > frame.left + frame.width / 2;
      const bottom = rect.top + rect.height / 2 > frame.top + frame.height / 2;
      const corner = `${bottom ? "b" : "t"}${right ? "r" : "l"}`;
      saveSelfCorner(corner);
      box.dataset.corner = corner;
      cornerDropAt = Date.now();
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
  }
  function setSpotlight(id) {
    if (id === "self" && state.selfPip) {
      state.selfPip = false;
      store("selfpip", 0);
      updateButtons();
      state.spotlight = "";
      layoutStage();
      return;
    }
    state.spotlight = id && state.spotlight !== id ? id : "";
    for (const open of document.querySelectorAll(".tile.ctl")) open.classList.remove("ctl");
    layoutStage();
  }

  // src/lobby.ts
  var LOBBY_STEP = 16;
  function lobbyPlace(win2, x, y) {
    const w = win2.offsetWidth;
    const h = win2.offsetHeight;
    const maxX = Math.max(0, document.documentElement.clientWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    const cx = clamp(Math.round(x), 0, maxX);
    const cy = clamp(Math.round(y), 0, maxY);
    win2.classList.add("moved");
    win2.style.left = `${cx}px`;
    win2.style.top = `${cy}px`;
    return { x: cx, y: cy };
  }
  function initLobbyWindow() {
    const win2 = $("lobby");
    const bar = win2 && win2.querySelector(".titlebar");
    if (!win2 || !bar || getComputedStyle(bar).display === "none") return;
    const keep = (pos) => store("lobbypos", JSON.stringify(pos));
    const at = () => {
      const r = win2.getBoundingClientRect();
      return { x: r.left, y: r.top };
    };
    try {
      const kept = JSON.parse(load("lobbypos") || "null");
      if (kept && Number.isFinite(kept.x) && Number.isFinite(kept.y)) lobbyPlace(win2, kept.x, kept.y);
    } catch {
    }
    let grab = null;
    bar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const here = at();
      grab = { id: event.pointerId, dx: event.clientX - here.x, dy: event.clientY - here.y };
      lobbyPlace(win2, here.x, here.y);
      win2.classList.add("dragging");
      bar.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    bar.addEventListener("pointermove", (event) => {
      if (!grab || event.pointerId !== grab.id) return;
      lobbyPlace(win2, event.clientX - grab.dx, event.clientY - grab.dy);
    });
    const drop = (event) => {
      if (!grab || event.pointerId !== grab.id) return;
      grab = null;
      win2.classList.remove("dragging");
      keep(at());
    };
    bar.addEventListener("pointerup", drop);
    bar.addEventListener("pointercancel", drop);
    bar.tabIndex = 0;
    bar.setAttribute("aria-label", "stanze window, move it with the arrow keys");
    bar.addEventListener("keydown", (event) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!d) return;
      event.preventDefault();
      const here = at();
      keep(lobbyPlace(win2, here.x + d[0] * LOBBY_STEP, here.y + d[1] * LOBBY_STEP));
    });
    window.addEventListener("resize", () => {
      if (!win2.classList.contains("moved") || win2.hidden) return;
      const here = at();
      lobbyPlace(win2, here.x, here.y);
    });
  }

  // src/lab.ts
  async function runLab() {
    const worker = new Worker(scriptURL("/e2e-transform.js"));
    const messages = [];
    worker.onmessage = (event) => messages.push(event.data);
    const key = b64e(crypto.getRandomValues(new Uint8Array(32)));
    const wrong = b64e(crypto.getRandomValues(new Uint8Array(32)));
    worker.postMessage({ type: "keys", pair: "lab", peer: "lab", enc: key, dec: wrong });
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const paint = canvas.getContext("2d");
    let tick = 0;
    const draw = () => {
      tick++;
      paint.fillStyle = "hsl(" + tick * 7 % 360 + " 70% 40%)";
      paint.fillRect(0, 0, 320, 180);
      paint.fillStyle = "#fff";
      paint.font = "20px monospace";
      paint.fillText("pq frame " + tick, 16, 40);
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
    const stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);
    const pc1 = new RTCPeerConnection({ iceServers: [] });
    const pc2 = new RTCPeerConnection({ iceServers: [] });
    const sink = new MediaStream();
    pc2.ontrack = (event) => sink.addTrack(event.track);
    const labVideo = document.createElement("video");
    labVideo.muted = true;
    labVideo.autoplay = true;
    labVideo.playsInline = true;
    labVideo.className = "offstage";
    labVideo.srcObject = sink;
    document.body.appendChild(labVideo);
    labVideo.play().catch(() => {
    });
    const gathered = (pc) => new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve(null);
        return;
      }
      const done = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", done);
          resolve(null);
        }
      };
      pc.addEventListener("icegatheringstatechange", done);
      setTimeout(() => resolve(null), 4e3);
    });
    for (const track of stream.getTracks()) {
      const sender = pc1.addTrack(track, stream);
      sender.transform = new RTCRtpScriptTransform(worker, {
        pair: "lab",
        peer: "lab",
        dir: "send",
        kind: track.kind,
        from: "lab"
      });
    }
    await pc1.setLocalDescription();
    await gathered(pc1);
    await pc2.setRemoteDescription(pc1.localDescription);
    for (const receiver of pc2.getReceivers()) {
      receiver.transform = new RTCRtpScriptTransform(worker, {
        pair: "lab",
        peer: "lab",
        dir: "recv",
        kind: receiver.track.kind,
        from: "lab"
      });
    }
    await pc2.setLocalDescription();
    await gathered(pc2);
    await pc1.setRemoteDescription(pc2.localDescription);
    const read = async () => {
      const out = { videoDecoded: 0, audioDecoded: 0, packets: 0, bytes: 0 };
      const report = await pc2.getStats();
      report.forEach((r) => {
        if (r.type !== "inbound-rtp") return;
        out.packets += r.packetsReceived || 0;
        out.bytes += r.bytesReceived || 0;
        if (r.kind === "video") out.videoDecoded += r.framesDecoded || 0;
        if (r.kind === "audio") out.audioDecoded += r.framesDecoded || 0;
      });
      return out;
    };
    await new Promise((resolve) => setTimeout(resolve, 3e3));
    const before = await read();
    const early = messages.filter((m) => m.type === "stats");
    worker.postMessage({ type: "keys", pair: "lab", peer: "lab", dec: key });
    for (const receiver of pc2.getReceivers()) {
      const ask2 = receiver;
      if (ask2.requestKeyFrame) ask2.requestKeyFrame();
    }
    await new Promise((resolve) => setTimeout(resolve, 4e3));
    const after = await read();
    const late = messages.filter((m) => m.type === "stats");
    clearInterval(timer);
    osc.stop();
    audioCtx.close().catch(() => {
    });
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
      openedFrames: sum(late, "recv"),
      samples: messages.filter((m) => m.type === "sample").slice(0, 6),
      workerErrors: messages.filter((m) => m.type === "error")
    };
  }

  // src/boot.ts
  win().e2eApp = {
    get state() {
      return state;
    },
    get asrStats() {
      return {
        engine: asrStats.engine,
        ready: asrStats.ready,
        initMs: asrStats.initMs,
        segments: asrStats.segments.slice()
      };
    },
    peers: () => [...state.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      sas: p.sas || "",
      fp: p.fp || "",
      pin: pinState(p),
      proven: !!p.proven,
      confirmed: !!p.confirmed,
      ready: p.tile ? p.tile.dataset.e2e || p.ready : p.ready,
      pc: p.pc ? p.pc.connectionState : "none",
      dc: p.dc ? p.dc.readyState : "none",
      videoW: p.video ? p.video.videoWidth : 0,
      videoT: p.video ? p.video.currentTime : 0,
      video: p.video
    })),
    identity: () => state.idKey ? {
      kind: state.idKey.kind,
      fp: state.idKey.fp,
      device: state.device,
      note: deviceNote(),
      sid: state.sid
    } : null,
    pins: () => [...state.pins.values()].map((r) => ({ label: r.label, fp: r.fp })),
    revoked: () => [...state.revoked.values()].map((r) => ({ label: r.label, fp: r.fp })),
    pin: (peerId, label) => {
      const peer = state.peers.get(peerId);
      return peer ? pinPeer(peer, label) : "no peer";
    },
    resetDevice: (peerId, label) => {
      const peer = state.peers.get(peerId);
      return peer ? resetDevice(peer, label) : "no peer";
    },
    rename: (peerId, label) => {
      const peer = state.peers.get(peerId);
      return peer ? renamePin(peer, label) : "no peer";
    },
    storageAudit,
    pinCount: () => ({ verified: verifiedPeers(), total: state.peers.size }),
    pinState: (peerId) => {
      const peer = state.peers.get(peerId);
      return peer ? pinState(peer) : "no peer";
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
      samples: state.samples
    }),
    selfTest: pqSelfTest,
    lab: runLab,
    // The drawn camera is reported by the track each camera sender carries, so a
    // test can see the swap a hidden tab makes without reading a picture.
    effects: () => ({
      look: state.look,
      masks: state.masks.slice(),
      mask: state.masks.join("+") || "none",
      on: lookOn(),
      drawn: !!lookTrack(),
      parked: !!state.lookParked,
      loop: !!(state.lookPipe && state.lookPipe.clock),
      swaps: state.lookSwaps,
      cam: state.camTrack ? state.camTrack.readyState : "none",
      senders: [...state.peers.values()].map((peer) => {
        const tr = peer.tx && peer.tx.video;
        const track = tr && tr.sender ? tr.sender.track : null;
        if (!track) return "none";
        if (track === state.camTrack) return "camera";
        if (track === state.lookOut) return "drawn";
        return "other";
      })
    }),
    setLook: (name) => {
      state.look = Object.prototype.hasOwnProperty.call(LOOKS, name) ? name : "none";
      store("look", state.look);
      const pick = $("look-filter");
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
      store("mask", state.masks.join("+"));
      for (const box of maskBoxes()) box.checked = state.masks.includes(box.dataset.mask);
      return lookRestart();
    }
  };
  function restorePrefs() {
    purgeNamedVolume();
    const fromHash = roomFromHash();
    const last = load("room");
    if (fromHash) {
      $("room").value = fromHash;
    } else if (last && ROOM_RE.test(last)) {
      $("room").value = last;
    } else {
      suggestRoom();
    }
    const lastName = load("name");
    if (lastName) $("name").value = lastName;
    state.mic = load("mic") !== "0";
    state.cam = load("cam") !== "0";
    state.camId = load("camId").slice(0, 256);
    state.micId = load("micId").slice(0, 256);
    const storedPath = load("path");
    if (["auto", "p2p", "relay"].includes(storedPath)) {
      state.path = storedPath;
      $("path").value = storedPath;
    }
    const storedQuality = load("quality");
    if (Object.hasOwn(QUALITY, storedQuality)) state.quality = storedQuality;
    const storedShare = load("sharequality");
    if (Object.hasOwn(QUALITY, storedShare)) state.shareQuality = storedShare;
    paintDeviceMenu();
    const storedPerf = parseInt(load("perf"), 10);
    state.perf = storedPerf >= 0 && storedPerf < PERF.length ? storedPerf : 0;
    paintPerf();
    state.noiseWanted = load("noise") !== "0";
    $("noise").checked = state.noiseWanted;
    $("noise-live").checked = state.noiseWanted;
    state.selfPip = load("selfpip") === "1";
    $("pip").checked = state.selfPip;
    state.voiceTiles = load("hidevoicetiles") !== "1";
    $("voice-tiles").checked = !state.voiceTiles;
    localStorage.removeItem("rooms.voicetiles");
    preloadSealed();
  }
  function wireJoinCard() {
    $("newid-btn").addEventListener("click", (event) => {
      event.preventDefault();
      suggestRoom();
    });
    $("join-form").addEventListener("submit", (event) => {
      event.preventDefault();
      ensurePlayback();
      const box = $("room");
      const room = normalizeRoom(box.value) || newRoomID();
      if (!ROOM_RE.test(room)) {
        say("room names use a-z 0-9 . _ - (1 to 64 characters)");
        return;
      }
      box.value = room;
      enterRoom(room, $("pass").value || "");
    });
    $("chat-form").addEventListener("submit", (event) => {
      event.preventDefault();
      sendSealedChat();
    });
    const input = $("file-input");
    $("file-btn").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const list = Array.from(input.files || []);
      input.value = "";
      for (const file of list) fileOffer(file);
    });
    const panel = $("chat-panel");
    panel.addEventListener("dragover", (event) => {
      event.preventDefault();
      panel.classList.add("drop");
    });
    panel.addEventListener("dragleave", () => panel.classList.remove("drop"));
    panel.addEventListener("drop", (event) => {
      const drop = event;
      drop.preventDefault();
      panel.classList.remove("drop");
      for (const file of drop.dataTransfer?.files || []) fileOffer(file);
    });
  }
  function wireSwitches() {
    const noise = $("noise-live");
    noise.addEventListener("change", async () => {
      const on = noise.checked;
      state.noiseWanted = on;
      store("noise", on ? 1 : 0);
      $("noise").checked = on;
      const applied = await setNoise(on);
      if (applied !== on) say("noise suppression is not available");
      updateButtons();
    });
    const mirror = $("mirror");
    mirror.addEventListener("change", () => {
      state.mirror = mirror.checked;
      applyMirror();
    });
    const freeze = $("freeze");
    freeze.addEventListener("change", async () => {
      const ok = await setFreeze(freeze.checked);
      if (!ok) freeze.checked = !!state.freeze;
    });
    const pip = $("pip");
    pip.addEventListener("change", () => {
      state.selfPip = pip.checked;
      store("selfpip", state.selfPip ? 1 : 0);
      layoutStage();
    });
    const voice = $("voice-tiles");
    voice.addEventListener("change", () => {
      const hide = voice.checked;
      state.voiceTiles = !hide;
      store("hidevoicetiles", hide ? 1 : 0);
      layoutStage();
    });
  }
  function wirePanels() {
    initLobbyWindow();
    initAsr();
    lookInit();
    for (const id of ["perf", "perf-live"]) {
      const el2 = document.getElementById(id);
      if (!el2) continue;
      el2.addEventListener("input", async () => {
        const n = parseInt(el2.value, 10);
        state.perf = n >= 0 && n < PERF.length ? PERF.length - 1 - n : 0;
        store("perf", state.perf);
        paintPerf();
        await applyQuality();
      });
    }
    $("path").addEventListener("change", () => {
      state.path = $("path").value;
      store("path", state.path);
    });
    for (const kind of ["video", "audio"]) {
      for (const select of devicePickers(kind)) {
        if (!select) continue;
        select.addEventListener("change", () => onDevicePicked(kind, select.value));
      }
    }
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    }
    setSounds(load("sounds") !== "0");
    const soundBox = $("sounds");
    if (soundBox) {
      soundBox.addEventListener("change", () => {
        const on = soundBox.checked;
        store("sounds", on ? 1 : 0);
        setSounds(on);
      });
    }
    state.statsBytes = load("statsbytes") === "1";
    const bytesBox = $("stats-bytes");
    if (bytesBox) {
      bytesBox.checked = state.statsBytes;
      bytesBox.addEventListener("change", () => {
        state.statsBytes = bytesBox.checked;
        store("statsbytes", state.statsBytes ? 1 : 0);
        if (statsOpen()) updateStats();
      });
    }
    const waitBox = $("waiting-room");
    if (waitBox) {
      waitBox.addEventListener("change", () => {
        setWaitingRoom(waitBox.checked);
      });
    }
    wireMenuBar();
    wirePipDrag();
    wireSubmenus();
    const gateBtn = document.getElementById("gate-pick");
    if (gateBtn) {
      gateBtn.addEventListener("click", () => {
        if (!isAdmin(state.self) || state.waiting) return;
        const next = window.prompt("room passphrase (leave empty for an open room)", "");
        if (next === null) return;
        setGate(next.trim().slice(0, 256));
      });
    }
    const renameBtn = document.getElementById("rename-pick");
    if (renameBtn) {
      renameBtn.addEventListener("click", () => {
        const next = window.prompt("your name in this room", state.name || "");
        if (next === null) return;
        renameSelf(next);
      });
    }
    paintGate();
    $("stats-btn").addEventListener("click", () => setStatsOpen(!statsOpen()));
    $("stats-close").addEventListener("click", () => setStatsOpen(false));
  }
  function wireStage() {
    const touch = window.matchMedia ? window.matchMedia("(hover: none)") : { matches: false };
    $("grid").addEventListener("click", (event) => {
      if (Date.now() - cornerDropAt < 300) return;
      const target = event.target;
      if (target.closest("#self-pip")) {
        state.selfPip = false;
        store("selfpip", 0);
        updateButtons();
        layoutStage();
        return;
      }
      const tile = target.closest(".tile");
      if (!tile) {
        setSpotlight("");
        return;
      }
      if (target.closest(".vol, .dots, .menu, .sas, .pin, .admit")) return;
      if (pairStage()) {
        state.selfPip = !state.selfPip;
        store("selfpip", state.selfPip ? 1 : 0);
        updateButtons();
        layoutStage();
        return;
      }
      const el2 = tile;
      const id = tileId(el2);
      if (!id) return;
      if (touch.matches && !target.closest(".zoom") && el2.parentElement === $("stage-main") && !el2.classList.contains("ctl")) {
        for (const open of document.querySelectorAll(".tile.ctl")) open.classList.remove("ctl");
        el2.classList.add("ctl");
        clearTimeout(el2.ctlTimer);
        el2.ctlTimer = setTimeout(() => el2.classList.remove("ctl"), 5e3);
        return;
      }
      setSpotlight(id);
    });
    $("stage").addEventListener("click", (event) => {
      if (Date.now() - cornerDropAt < 300) return;
      if (!$("stage").classList.contains("immersive")) return;
      const target = event.target;
      if (target.closest(".titlebar, .menubar, .statusline, .side, .stats, .chrome-handle")) return;
      setChrome(!$("stage").classList.contains("chrome"));
    });
    $("chrome-btn").addEventListener("click", () => setChrome(true));
    if (phoneQuery) phoneQuery.addEventListener("change", applyImmersive);
    const railEl = $("stage-rail");
    if (railEl) {
      railEl.addEventListener("click", (event) => {
        const target = event.target;
        if (target.closest(".vol-range, .vol-num, .dots, .menu, .sas, .admit")) return;
        const row = target.closest(".plist-row");
        if (!row) return;
        const id = tileId(row);
        if (id) setSpotlight(id);
      });
    }
    document.addEventListener("click", closeMenus);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (menuClose()) return;
      closeMenus();
      if (state.spotlight) setSpotlight("");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopStats();
        lookPark(true);
      } else {
        if (statsOpen()) startStats();
        lookPark(false);
      }
    });
  }
  function wireCallBar() {
    $("share-btn").addEventListener("click", () => {
      if (state.screen) stopShare();
      else startShare();
    });
    $("mic-btn").addEventListener("click", () => {
      if (state.mic) disableMic();
      else enableMic();
    });
    $("cam-btn").addEventListener("click", () => {
      if (state.cam) disableCam();
      else enableCam();
    });
    $("deaf-btn").addEventListener("click", () => setDeaf(!state.deaf));
    $("hand-btn").addEventListener("click", () => setHand(!state.hand));
    $("leave-btn").addEventListener("click", () => leave(""));
    $("copy-btn").addEventListener("click", async () => {
      const link = `${location.origin}/#r=${encodeURIComponent(state.room)}`;
      try {
        await navigator.clipboard.writeText(link);
        $("copy-btn").textContent = "copied";
        setTimeout(() => {
          $("copy-btn").textContent = "copy link";
        }, 1500);
      } catch {
        window.prompt("copy this link", link);
      }
    });
    refreshDevices();
  }
  function init() {
    restorePrefs();
    wireJoinCard();
    wireSwitches();
    wirePanels();
    wireStage();
    wireCallBar();
    refreshDevices();
  }
  init();
  Object.assign(globalThis, {
    state,
    disableCam,
    enableMic,
    disableMic,
    startLost,
    stopLost,
    leave
  });
})();
