/*
 The drawn camera: the face mesh, the masks and the custom effect.
*/

import { LOOKS, LOOK_MAX, MASKS, MESH_DIR, MESH_HZ_MAX, MESH_HZ_MIN, MESH_W } from './config.js';
import { $ } from './dom.js';
import { CUST_DEFAULTS, state } from './state.js';
import { clamp, detachMedia, say, stopQuietly, stopTracks } from './util.js';
import { load, store } from './prefs.js';
import { paintSelfCam } from './devices.js';
import { scriptURL } from './trust.js';
import { drawFawkes } from './fawkes.js';

// ---------------------------------------------------------------- camera look
// lookOn is true when a drawn step is wanted. The camera itself is not touched.
export function lookOn() {
  return (state.look && state.look !== 'none') || state.masks.length > 0;
}

// maskSet reads a stored or a remote mask choice into the drawn list, in MASKS
// order; a name this page does not know is dropped.
export function maskSet(value) {
  const names = Array.isArray(value) ? value : String(value || '').split(/[+,\s]+/);
  return MASKS.filter((m) => m !== 'none' && names.includes(m));
}

// lookTrack is the drawn track while it is live and the tab draws, else null:
// a parked pipeline hands the camera back to the senders.
export function lookTrack() {
  if (state.lookParked) return null;
  return state.lookOut && state.lookOut.readyState === 'live' ? state.lookOut : null;
}

// The frame clock is a worker timer, not an animation frame loop: a tab that is
// not in front is handed no animation frames, and the peers would keep the last
// picture for ever. One tick is one camera frame and one mesh detection.
/** @type {Map<number, string>} */

const drawClockURLs = new Map();

function drawClockURL(fps) {
  const hz = clamp(Math.round(fps) || 30, MESH_HZ_MIN, MESH_HZ_MAX);
  if (!drawClockURLs.has(hz)) {
    drawClockURLs.set(
      hz,
      URL.createObjectURL(
        new Blob([`setInterval(() => postMessage(1), ${Math.round(1000 / hz)});`], {
          type: 'text/javascript',
        }),
      ),
    );
  }
  return drawClockURLs.get(hz);
}

// The mesh points every mask reads, by canonical FaceMesh number. L and R name
// the side of the drawn frame, the unmirrored camera frame: the guest's mirror
// is a css flip, so a landmark x stays a plain fraction.
const LM = {
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
  earR: 323,
};

// The hairline, temple to temple across the head, so a fringe follows a turn.
const HAIRLINE = [127, 162, 21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 389, 356];

// meshOpenTask is the one landmarker of the page; it outlives a pipeline, so a
// mask or camera switch does not load the wasm again. A failure is remembered
// as null and the skin patch stays in charge.
/** @type {Promise<any> | null} */

let meshOpenTask = null;

// meshOpen loads the landmarker in the background and never throws into a call:
// a browser without wasm or memory gives null, and the colour test places the
// mask.
function meshOpen() {
  if (!meshOpenTask) {
    meshOpenTask = (async () => {
      // The bundle is local, so the specifier stays a constant string.
      // eslint-disable-next-line no-unsanitized/method
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
// track becomes what peers receive. A shared screen has its own sender and is
// never touched.
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
  video.className = 'offstage';
  document.body.appendChild(video);
  try {
    await video.play();
  } catch {
    /* the first frame comes later */
  }
  const settings = src.getSettings ? src.getSettings() : {};
  // The picture and the mesh both run at the camera rate: the camera states
  // its own frame rate, and a step without one is a camera at thirty.
  const fps = clamp(Math.round(settings.frameRate) || 30, MESH_HZ_MIN, MESH_HZ_MAX);
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
  // A 64 x 48 sample for the skin patch of a mask, read in this tab only.
  const sample = document.createElement('canvas');
  sample.width = 64;
  sample.height = 48;
  const sctx = sample.getContext('2d', { alpha: false, willReadFrequently: true });
  // A second, bigger sample for the landmarker, at the shape of the camera, so
  // a landmark x is a fraction of the frame the mask is drawn on.
  const meshCanvas = document.createElement('canvas');
  meshCanvas.width = MESH_W;
  meshCanvas.height = Math.min(
    320,
    Math.max(
      128,
      2 * Math.round((MESH_W * (settings.height || 720)) / (settings.width || 1280) / 2),
    ),
  );
  const meshCtx = meshCanvas.getContext('2d', { alpha: false });
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
    wake: null as (() => void) | null,
    armApply: false,
  };
  state.lookPipe = pipe;
  state.lookSrc = src;
  // A hidden tab can leave the source element paused, and the clock draws from
  // it, so it is asked to play on every move of the tab.
  pipe.wake = () => {
    const playing = video.play();
    if (playing && playing.catch) playing.catch(() => {});
  };
  document.addEventListener('visibilitychange', () => pipe.wake && pipe.wake());
  state.lookOut = track;
  // A hidden tab paints nothing, so a pipeline that starts while the tab is
  // away leaves the camera on the senders; the drawn track comes back with the
  // first frame after the tab returns.
  state.lookParked = !!document.hidden;
  pipe.armApply = false;
  if (!state.lookParked) {
    // One frame before the swap: a canvas that was never painted is black, and
    // a browser that captures it early sends black until the first paint. With
    // no camera frame yet, the first painted frame does the swap instead.
    if (video.readyState >= 2 && video.videoWidth) lookDraw(pipe);
    else pipe.armApply = true;
  }
  await lookPublish(state.lookParked || pipe.armApply ? src : track);
  if (!state.lookParked) pipe.clock = lookClock(pipe);
}

// lookClock starts the frame clock of a pipeline. It stops with a parked tab,
// which draws nothing.
function lookClock(p) {
  const clock = new Worker(scriptURL(p.clockURL || drawClockURL(p.fps)));
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
  if (!state.masks.length || !p.sctx) {
    armPublish(p);
    return;
  }
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
    else if (which === 'potion') lookPotion(p, a);
    else if (which === 'custom') lookCustom(p, a);
    else drawMask(p.ctx, p.canvas.width, p.canvas.height, which, a);
  }
  armPublish(p);
}

// armPublish hands the drawn track to the senders on the first frame the canvas
// really carries: a browser that captures a fresh canvas before the first paint
// sends black, which reads as a dark box around the mask.
function armPublish(p) {
  if (!p.armApply) return;
  p.armApply = false;
  lookPublish(p.track);
}

// A frame mark older than this many milliseconds is stale: its callback
// stopped, so every frame is detected again.
const FRAME_MARK_FRESH_MS = 300;

// The identity of the newest decoded camera frame: the count of frames the
// element presented, from requestVideoFrameCallback where the browser has it,
// else the decoded frame count. Media time can repeat on a live stream, so the
// count, not the time, marks a frame; undefined marks nothing, and no frame is
// skipped then.
function frameMark(p) {
  const v = p.video;
  if (v.requestVideoFrameCallback) {
    if (!p.meshRVFC) {
      p.meshRVFC = true;
      const wait = () =>
        v.requestVideoFrameCallback(() => {
          p.meshFrames = (p.meshFrames || 0) + 1;
          p.meshFrameAt = performance.now();
          if (p.meshRVFC && state.lookPipe === p) wait();
          else p.meshRVFC = false;
        });
      wait();
    }
    if (!p.meshFrameAt || performance.now() - p.meshFrameAt > FRAME_MARK_FRESH_MS) return undefined;
    return p.meshFrames;
  }
  const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
  return q ? q.totalVideoFrames : undefined;
}

// lookMesh runs the landmarker on the small copy of the frame at the camera
// rate. One detection at a time and no queue, so a slow machine drops frames
// instead of piling them up.
function lookMesh(p) {
  if (!p.meshTried) {
    p.meshTried = true;
    meshOpen().then((fm) => {
      p.mesh = fm;
    });
  }
  if (!p.mesh || p.meshBusy || !p.meshCtx || document.hidden) return;
  // A clock faster than the camera repeats the frame it has, and a repeat is
  // skipped. A mark older than FRAME_MARK_FRESH_MS gets a detect anyway: a
  // browser that holds the frame or reports one identity for all of them must
  // not leave the mask frozen.
  const mark = frameMark(p);
  const quiet = !p.meshAt || performance.now() - p.meshAt > FRAME_MARK_FRESH_MS;
  if (mark !== undefined && mark === p.meshMark && !quiet) return;
  p.meshMark = mark;
  // A detection that takes most of a frame period is dropped to every second or
  // third new frame, so the detector cannot eat the clock of the picture. A
  // quiet mask skips nothing until a detect lands.
  const period = 1000 / (p.fps || 30);
  const stride = quiet ? 1 : p.meshStride || 1;
  p.meshTick = (p.meshTick || 0) + 1;
  if ((p.meshTick - 1) % stride !== 0) return;
  meshSize(p);
  p.meshBusy = true;
  const t0 = performance.now();
  p.meshAt = t0;
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
    const cost = performance.now() - t0;
    p.meshCost = p.meshCost ? p.meshCost * 0.75 + cost * 0.25 : cost;
    p.meshStride = p.meshCost > period * 0.9 ? 3 : p.meshCost > period * 0.55 ? 2 : 1;
  }
}

// meshSize keeps the small copy at the shape of the camera, longest side MESH_W,
// so a portrait phone frame is not squashed and a landmark x stays a fraction
// of the drawn frame.
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

// The landmark smoothing is the One Euro filter of Casiez, Roussel and Vogel
// (CHI 2012), one state per point list: a slow move is smoothed hard and a fast
// one is let through.
const ONEEURO_MIN_HZ = 1.0;

const ONEEURO_BETA = 30.0;

const ONEEURO_D_HZ = 1.0;

// oneEuroState holds the last filtered value and the last filtered rate of a
// list of coordinates, and the time of the last frame.
function oneEuroState() {
  return { x: new Float64Array(0), dx: new Float64Array(0), t: 0, on: false };
}

// oneEuroAlpha is the share of the way to the sample that one step takes at a
// cutoff, for a frame that is dt seconds after the last one.
function oneEuroAlpha(hz, dt) {
  const tau = 1 / (2 * Math.PI * hz);
  return 1 / (1 + tau / dt);
}

// oneEuroRun filters one frame and returns the filtered list. A gap longer than
// half a second, as a returning tab leaves, is clamped, so a face does not sweep
// in from where it was.
function oneEuroRun(s, src, t) {
  const n = src.length;
  if (!s.on || s.x.length !== n) {
    s.x = Float64Array.from(src);
    s.dx = new Float64Array(n);
    s.t = t;
    s.on = true;
    return s.x;
  }
  let dt = (t - s.t) / 1000;
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

// lookMeshAnchor turns the first face into the anchor the colour test makes,
// plus every mesh point, and smooths both. A face that leaves the frame leaves
// the last anchor in place, so the mask does not flick to a corner.
function lookMeshAnchor(p, lm) {
  const pts = new Float32Array(lm.length * 2);
  let x0 = 1,
    y0 = 1,
    x1 = 0,
    y1 = 0;
  for (let i = 0; i < lm.length; i++) {
    const x = lm[i].x,
      y = lm[i].y;
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
    smile: 0,
  };
  // How far the lips are apart, as a share of the mouth width: the dog tongue
  // reads it, and it falls off over about a second when the mouth closes.
  const faceH =
    Math.hypot(
      pts[LM.chin * 2] - pts[LM.hairline * 2],
      pts[LM.chin * 2 + 1] - pts[LM.hairline * 2 + 1],
    ) || 1;
  const lipGap = Math.hypot(
    pts[LM.lipLow * 2] - pts[LM.lip * 2],
    pts[LM.lipLow * 2 + 1] - pts[LM.lip * 2 + 1],
  );
  const mouthW =
    Math.hypot(
      pts[LM.mouthR * 2] - pts[LM.mouthL * 2],
      pts[LM.mouthR * 2 + 1] - pts[LM.mouthL * 2 + 1],
    ) || faceH * 0.35;
  // A share of the mouth width does not change with the distance to the camera,
  // so the tongue grows with the mouth instead of snapping out at a fixed gap.
  next.tongue = clamp((lipGap / mouthW - 0.06) / 0.34, 0, 1);
  // Where the real eyes look: the iris centre against the middle of its eye,
  // in shares of the eye width, so the drawn iris turns with the gaze at any
  // distance. The two iris centres are matched to the nearer eye, which keeps
  // the pairing right whatever the mesh calls left and right. The mouth smile
  // is the corner line against the middle of the lips, in shares of the mouth
  // width, so a smile lifts the drawn corners and a frown drops them.
  // The lid gap over the eye width is the blink: a share of the face, so it
  // holds near the camera and far from it. The smaller eye wins, because a
  // blink on one eye is a wink and the drawn face keeps both eyes together.
  const lidL = Math.hypot(
    pts[LM.lidLoL * 2] - pts[LM.lidUpL * 2],
    pts[LM.lidLoL * 2 + 1] - pts[LM.lidUpL * 2 + 1],
  );
  const lidR = Math.hypot(
    pts[LM.lidLoR * 2] - pts[LM.lidUpR * 2],
    pts[LM.lidLoR * 2 + 1] - pts[LM.lidUpR * 2 + 1],
  );
  const eyeWL =
    Math.hypot(
      pts[LM.eyeOuterL * 2] - pts[LM.eyeInnerL * 2],
      pts[LM.eyeOuterL * 2 + 1] - pts[LM.eyeInnerL * 2 + 1],
    ) || faceH * 0.18;
  const eyeWR =
    Math.hypot(
      pts[LM.eyeOuterR * 2] - pts[LM.eyeInnerR * 2],
      pts[LM.eyeOuterR * 2 + 1] - pts[LM.eyeInnerR * 2 + 1],
    ) || faceH * 0.18;
  const openL = clamp((lidL / eyeWL - 0.05) / 0.2, 0, 1);
  const openR = clamp((lidR / eyeWR - 0.05) / 0.2, 0, 1);
  next.lid = Math.min(openL, openR);
  const gaze = [0, 0, 0, 0];
  if (pts.length >= 478 * 2) {
    const cL = [
      (pts[LM.eyeOuterL * 2] + pts[LM.eyeInnerL * 2]) / 2,
      (pts[LM.eyeOuterL * 2 + 1] + pts[LM.eyeInnerL * 2 + 1]) / 2,
    ];
    const cR = [
      (pts[LM.eyeOuterR * 2] + pts[LM.eyeInnerR * 2]) / 2,
      (pts[LM.eyeOuterR * 2 + 1] + pts[LM.eyeInnerR * 2 + 1]) / 2,
    ];
    const i0 = [pts[468 * 2], pts[468 * 2 + 1]];
    const i1 = [pts[473 * 2], pts[473 * 2 + 1]];
    const d0 = Math.hypot(i0[0] - cL[0], i0[1] - cL[1]) + Math.hypot(i1[0] - cR[0], i1[1] - cR[1]);
    const d1 = Math.hypot(i0[0] - cR[0], i0[1] - cR[1]) + Math.hypot(i1[0] - cL[0], i1[1] - cL[1]);
    const [li, ri, cLi, cRi, wLi, wRi] =
      d0 <= d1 ? [i0, i1, cL, cR, eyeWL, eyeWR] : [i1, i0, cR, cL, eyeWR, eyeWL];
    gaze[0] = clamp((li[0] - cLi[0]) / (wLi || faceH * 0.18), -0.4, 0.4);
    gaze[1] = clamp((li[1] - cLi[1]) / (wLi || faceH * 0.18), -0.35, 0.35);
    gaze[2] = clamp((ri[0] - cRi[0]) / (wRi || faceH * 0.18), -0.4, 0.4);
    gaze[3] = clamp((ri[1] - cRi[1]) / (wRi || faceH * 0.18), -0.35, 0.35);
  }
  next.gaze = gaze;
  next.smile = clamp(
    ((pts[LM.lip * 2 + 1] - (pts[LM.mouthL * 2 + 1] + pts[LM.mouthR * 2 + 1]) / 2) / mouthW) * 1.6,
    -0.7,
    0.7,
  );
  const a = p.anchor;
  const t = performance.now();
  const sl = oneEuroRun(p.meshLm || (p.meshLm = oneEuroState()), pts, t);
  const box = oneEuroRun(
    p.meshBox || (p.meshBox = oneEuroState()),
    [next.x, next.y, next.w, next.h],
    t,
  );
  // A first face, or one from the colour test, is taken whole: the points carry
  // the shape, and a blend with a box would only blur the first mask.
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
  // A blink is a fast close and a slower open: the lid follows a close at once
  // and a wide open eye eases out, so a normal blink is not missed between two
  // frames and a landmark wobble does not make the eye flicker.
  const lid = next.lid;
  if (a.lid == null) a.lid = lid;
  else a.lid += (lid - a.lid) * (lid < a.lid ? 0.6 : 0.3);
  // A gaze is small and the iris is read from a few pixels, so it follows at a
  // steady pace and never jumps; the smile follows the same way.
  if (!a.gaze) a.gaze = next.gaze.slice();
  else for (let i = 0; i < 4; i++) a.gaze[i] += (next.gaze[i] - a.gaze[i]) * 0.4;
  if (a.smile == null) a.smile = next.smile;
  else a.smile += (next.smile - a.smile) * 0.35;
  for (let i = 0; i < pts.length; i++) a.lm[i] = sl[i];
}

// lookAnchor finds the face patch with the classic skin tone test on the small
// sample, and moves the last place towards it, so a mask does not jump.
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
  let n = 0,
    sx = 0,
    sy = 0,
    x0 = 64,
    y0 = 48,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
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
  // Too few skin pixels: no face in this frame, so the last place stays.
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
    h: p.anchor.h + (next.h - p.anchor.h) * k,
  };
}

// roundPath draws a rounded rectangle path.
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
export function gap(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

// unit is a direction of length one, so a face axis can be used as a ruler.
export function unit(x, y) {
  const m = Math.hypot(x, y) || 1;
  return [x / m, y / m];
}

// roll is the angle of the eye line, the tilt a head has when it leans.
function roll(g) {
  return Math.atan2(g.eyeR[1][1] - g.eyeL[0][1], g.eyeR[1][0] - g.eyeL[0][0]);
}

// maskGeo reads an anchor into pixels. A mesh anchor carries every face point; a
// skin anchor only a box, so the points are stood in the box and one drawing
// serves both.
function maskGeo(a, W, H) {
  const cx = a.x * W;
  const cy = a.y * H;
  const bw = Math.max(a.w * W, W * 0.22);
  const bh = Math.max(a.h * H, H * 0.26);
  const lm = a.lm && a.lm.length >= 468 * 2 ? a.lm : null;
  // A face point, or the same place in the box when there is no mesh.
  const at = (i, fx, fy) =>
    lm ? [lm[i * 2] * W, lm[i * 2 + 1] * H] : [cx + bw * fx, cy + bh * fy];
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
  const spot = (o, s, t) => [
    o[0] + ax[0] * s * fw + ay[0] * t * fh,
    o[1] + ax[1] * s * fw + ay[1] * t * fh,
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
    hair: HAIRLINE.map((i, k) =>
      at(
        i,
        -0.44 + (0.88 * k) / (HAIRLINE.length - 1),
        -0.4 - 0.1 * Math.cos((k / (HAIRLINE.length - 1) - 0.5) * Math.PI),
      ),
    ),
    tongue: a.tongue || 0,
    gaze: a.gaze || [0, 0, 0, 0],
    smile: a.smile || 0,
  };
}

// The big effect is a warp, not a drawing: a patch of the camera picture is
// scaled about the middle of an eye or the mouth and laid back on the face.
// Every patch is read from the video element, so a frame is never read back,
// and its own edge is feathered.
function lookWarp(p, a, filter) {
  const W = p.canvas.width,
    H = p.canvas.height;
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

// The wide effect stretches the whole head sideways: one box from above the
// crown to below the chin, widened and left at its own height, so the eyes, the
// nose and the mouth move out together. The patch is measured on the face, so a
// head that turns or leans keeps it.
function lookWide(p, a, filter) {
  const W = p.canvas.width,
    H = p.canvas.height;
  const g = maskGeo(a, W, H);
  // The middle of the face from the two outer eye corners, and the box from
  // above the crown to below the chin.
  const cx = (g.eyeL[0][0] + g.eyeR[1][0]) / 2;
  // The box takes the hair as well as the face: a box on the face alone leaves
  // the hair outside it and a cut shows. Its top sits 0.78 face heights above
  // the hairline, on empty frame above most heads, so the fade never lands on
  // hair.
  const top = g.top[1] - g.fh * 0.78;
  const bottom = g.chin[1] + g.fh * 0.08;
  const rx = Math.max(g.fw * 0.78, 8);
  const ry = Math.max((bottom - top) / 2, 8);
  warpWide(p, cx, (top + bottom) / 2, rx, ry, 1.8, roll(g), filter);
}

// warpWide draws one box of the video, stretched by kx across and kept at its
// own height, along the axes of the face: a lean does not cut it. A short fade
// on each edge meets the untouched frame and the box stays solid inside, so the
// hair and the forehead widen with the rest of the head.
function warpWide(p, cx, cy, rx, ry, kx, rollAngle, filter) {
  const W = p.canvas.width,
    H = p.canvas.height;
  const vw = p.video.videoWidth,
    vh = p.video.videoHeight;
  const dw = 2 * rx * kx,
    dh = 2 * ry;
  const iw = Math.ceil(dw),
    ih = Math.ceil(dh);
  if (iw < 8 || ih < 8 || !vw || !vh) return;
  if (!p.wideCanvas) {
    p.wideCanvas = document.createElement('canvas');
    p.wideCtx = p.wideCanvas.getContext('2d');
  }
  const c = p.wideCanvas,
    cc = p.wideCtx;
  if (c.width < iw) c.width = iw;
  if (c.height < ih) c.height = ih;
  // The canvas is laid along the face axes and the video goes in through one
  // transform; only the turning bounding box is read, so a lean does not read
  // the whole frame.
  const cos = Math.abs(Math.cos(rollAngle)),
    sin = Math.abs(Math.sin(rollAngle));
  const ex = rx * cos + ry * sin,
    ey = rx * sin + ry * cos;
  const x0 = Math.max(0, ((cx - ex) * vw) / W),
    x1 = Math.min(vw, ((cx + ex) * vw) / W);
  const y0 = Math.max(0, ((cy - ey) * vh) / H),
    y1 = Math.min(vh, ((cy + ey) * vh) / H);
  const bx = x0,
    by = y0,
    bw = x1 - x0,
    bh = y1 - y0;
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

// The small effect shrinks the middle of the face and pads it out: skin from
// the forehead above the brows is stretched over a box as a pad, and the eyes,
// nose and mouth are drawn small in the middle of it. Both layers come from the
// camera element, and the pad fades at its edge onto the cheeks.
function lookSmall(p, a, filter) {
  const W = p.canvas.width,
    H = p.canvas.height;
  const g = maskGeo(a, W, H);
  const vw = p.video.videoWidth,
    vh = p.video.videoHeight;
  const cx = (g.eyeL[0][0] + g.eyeR[1][0]) / 2;
  const browY = Math.min(g.browL[1], g.browR[1]);
  const lipY = g.lipLow[1];
  const fcy = (browY + lipY) / 2;
  // The block of skin that is drawn small takes a margin around the features
  // and not the features alone: the soft edge of the block cuts the outer
  // tenth, and a mouth on that edge would fade away with it.
  const frx = Math.max((g.eyeR[1][0] - g.eyeL[0][0]) / 2, g.fw * 0.3) * 1.25;
  const fry = Math.max((lipY - browY) / 2, g.fh * 0.12) * 1.55;
  // The pad takes the whole face, the cheeks left and right, the hairline above
  // and the chin below, so every feature sits well inside it.
  const pcx = cx;
  const pcy = (g.top[1] + g.chin[1]) / 2;
  const prx = Math.max(g.fw * 0.52, 8),
    pry = Math.max(g.fh * 0.54, 8);
  const iw = Math.ceil(2 * prx),
    ih = Math.ceil(2 * pry);
  if (iw < 8 || ih < 8 || !vw || !vh) return;
  const vx = (x) => (x * vw) / W,
    vy = (y) => (y * vh) / H;
  if (!p.smallCanvas) {
    p.smallCanvas = document.createElement('canvas');
    p.smallCtx = p.smallCanvas.getContext('2d');
    p.smallFeat = document.createElement('canvas');
    p.smallFeatCtx = p.smallFeat.getContext('2d');
  }
  const c = p.smallCanvas,
    cc = p.smallCtx;
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
  const fw = Math.ceil(2 * frx * k),
    fh = Math.ceil(2 * fry * k);
  const f = p.smallFeat,
    fc = p.smallFeatCtx;
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
  cc.drawImage(
    f,
    0,
    0,
    fw,
    fh,
    iw / 2 - fw / 2,
    ih / 2 + ((fcy - pcy) / (2 * pry)) * ih - fh / 2,
    fw,
    fh,
  );
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

// warpEllipse warps one ellipse of the finished picture, for the potion seller
// and the pinch and width knobs. The ellipse is cut into rings from the rim in;
// each ring is drawn from a copy of the frame at the scale its radius asks for.
// The scale is one at the rim, so no seam shows, and reaches kx across and ky up
// at the middle: k above one pinches, k below one bulges. ang turns the ellipse
// with a leaning head.
const WARP_RINGS = 36;

function warpEllipse(p, cx, cy, rx, ry, ang, kx, ky) {
  const W = p.canvas.width,
    H = p.canvas.height;
  if (rx < 8 || ry < 8) return;
  if (Math.abs(kx - 1) < 0.02 && Math.abs(ky - 1) < 0.02) return;
  // The copy is the square that holds the ellipse, turned or not. A ring never
  // reads further out than its own rim, so nothing outside it is needed.
  const E = Math.ceil(Math.max(rx, ry)) + 2;
  const bx = Math.max(0, Math.floor(cx - E)),
    by = Math.max(0, Math.floor(cy - E));
  const bw = Math.min(W, Math.ceil(cx + E)) - bx,
    bh = Math.min(H, Math.ceil(cy + E)) - by;
  if (bw < 8 || bh < 8) return;
  if (!p.ringCanvas) {
    p.ringCanvas = document.createElement('canvas');
    p.ringCtx = p.ringCanvas.getContext('2d');
  }
  const c = p.ringCanvas,
    cc = p.ringCtx;
  if (c.width < bw) c.width = bw;
  if (c.height < bh) c.height = bh;
  cc.clearRect(0, 0, c.width, c.height);
  cc.drawImage(p.canvas, bx, by, bw, bh, 0, 0, bw, bh);
  const ctx = p.ctx;
  const cos = Math.cos(ang),
    sin = Math.sin(ang);
  // One ellipse as a closed sub-path; the move keeps the two rims of a ring
  // from being joined by a line.
  const rim = (t) => {
    ctx.moveTo(cx + rx * t * cos, cy + rx * t * sin);
    ctx.ellipse(cx, cy, rx * t, ry * t, ang, 0, 2 * Math.PI);
  };
  // A ring reaches a pixel and a half under the ring inside it, which paints
  // over the overlap, so the soft edge of a clip leaves no hairline between rings.
  const overlap = 1.5 / Math.min(rx, ry);
  for (let j = 0; j < WARP_RINGS; j++) {
    const t1 = 1 - j / WARP_RINGS,
      t0 = 1 - (j + 1) / WARP_RINGS;
    const mid = (t0 + t1) / 2;
    const f = (1 - mid) * (1 - mid);
    const mx = 1 + (kx - 1) * f,
      my = 1 + (ky - 1) * f;
    // The rings at the rim change nothing that can be seen.
    if (Math.abs(mx - 1) < 0.004 && Math.abs(my - 1) < 0.004) continue;
    ctx.save();
    ctx.beginPath();
    rim(t1);
    if (j < WARP_RINGS - 1) rim(Math.max(0, t0 - overlap));
    ctx.clip('evenodd');
    // A pixel of the ring shows the frame at m times its distance from the
    // middle, along the axes of the ellipse.
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.scale(1 / mx, 1 / my);
    ctx.rotate(-ang);
    ctx.translate(-cx, -cy);
    ctx.drawImage(c, 0, 0, bw, bh, bx, by, bw, bh);
    ctx.restore();
  }
}

// pinchFace squeezes the middle of the face towards one point (k above one) or
// blows it up (k below one). The point sits between the eye line and the tip of
// the nose, so the eyes, the nose and the mouth all close in on it, and the ring
// of the warp reaches past the cheeks and the hairline, so the cheeks swell out
// into the frame as the features go in.
function pinchFace(p, g, k) {
  const eyeX = (g.eyeL[0][0] + g.eyeR[1][0]) / 2,
    eyeY = (g.eyeL[0][1] + g.eyeR[1][1]) / 2;
  const cx = eyeX * 0.5 + g.nose[0] * 0.5,
    cy = eyeY * 0.5 + g.nose[1] * 0.5;
  warpEllipse(p, cx, cy, g.fw * 0.95, g.fh * 0.9, roll(g), k, k);
}

// POTION_PINCH is the pinch of the potion seller: the middle of the face goes
// small by this, the cheeks and the hair swell out round it.
const POTION_PINCH = 2.6;

// lookPotion is the potion seller: eyes, nose and mouth pinched into a knot in
// the middle of the face.
function lookPotion(p, a) {
  const g = maskGeo(a, p.canvas.width, p.canvas.height);
  pinchFace(p, g, POTION_PINCH);
}

// custom reads the knobs of the custom effect from the state.
function custom() {
  return state.cust;
}

// ------------------------------------------------------------ custom effect
//
// The custom effect is one set of knobs for the whole face: the height and the
// width of the head, the size, spread and height of the eyes, the size of the
// nose, the size and height of the mouth, a pinch or bulge of the middle of the
// face, and a swap that puts the eyes where the mouth is and the mouth between
// the eyes. Each knob is a percent, so the numbers hold near and far from the
// camera. 100 is neutral for a size and 0 for a shift or the pinch.

// bandPut maps a share of the head band to its place after a stretch of k. It
// is the identity at both ends, so the band joins the picture without a step,
// and it is steepest in the middle, so the face takes the change, not the edges.
function bandPut(s, k) {
  return 0.5 + (s - 0.5) * (1 + (k - 1) * Math.sin(Math.PI * s) ** 2);
}

// headBand stretches the band of the head about its middle by k: full width of
// the frame, the map the same at both edges, rows moving only up and down, so no
// seam can show. The band runs from above the hairline to below the chin.
function headBand(p, a, k) {
  const W = p.canvas.width,
    H = p.canvas.height;
  const y0 = Math.max(0, Math.round((a.y - a.h * 1.2) * H));
  const ih = Math.min(H, Math.round((a.y + a.h * 1.25) * H)) - y0;
  if (ih < 32 || W < 32) return;
  if (!p.bandCanvas) {
    p.bandCanvas = document.createElement('canvas');
    p.bandCtx = p.bandCanvas.getContext('2d');
  }
  const c = p.bandCanvas,
    cc = p.bandCtx;
  if (c.width !== W || c.height !== ih) {
    c.width = W;
    c.height = ih;
  }
  cc.clearRect(0, 0, W, ih);
  cc.drawImage(p.canvas, 0, y0, W, ih, 0, 0, W, ih);
  const N = 28;
  for (let i = 0; i < N; i++) {
    const s0 = i / N,
      s1 = (i + 1) / N;
    const sy = s0 * ih,
      sh = (s1 - s0) * ih;
    const dy = bandPut(s0, k) * ih,
      dh = (bandPut(s1, k) - bandPut(s0, k)) * ih;
    if (dh <= 0) continue;
    // One extra pixel of height hides the seam between two strips.
    p.ctx.drawImage(c, 0, sy, W, sh, 0, y0 + dy, W, dh + 1);
  }
}

// featureCopy cuts one rectangle of the picture into a scratch canvas and
// gives back its size, so a swap can hold both features before either is
// painted. The edge is a soft oval: a moved eye or mouth then sits on the skin
// and not on it as a pasted block.
function featureCopy(p, slot, src) {
  const W = p.canvas.width,
    H = p.canvas.height;
  const sx = Math.max(0, Math.round(src.x)),
    sy = Math.max(0, Math.round(src.y));
  const sw = Math.min(W - sx, Math.round(src.w)),
    sh = Math.min(H - sy, Math.round(src.h));
  if (sw < 6 || sh < 6) return null;
  const key = 'feat' + slot;
  let c = p[key];
  if (!c) {
    c = document.createElement('canvas');
    p[key] = c;
    p[key + 'Ctx'] = c.getContext('2d');
  }
  const cc = p[key + 'Ctx'];
  if (c.width < sw) c.width = sw;
  if (c.height < sh) c.height = sh;
  cc.clearRect(0, 0, c.width, c.height);
  cc.drawImage(p.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  cc.globalCompositeOperation = 'destination-in';
  cc.save();
  cc.translate(sw / 2, sh / 2);
  cc.scale(1, sh / sw);
  const grad = cc.createRadialGradient(0, 0, 0, 0, 0, sw / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.62, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  cc.fillStyle = grad;
  cc.fillRect(-sw / 2, -sw / 2, sw, sw);
  cc.restore();
  cc.globalCompositeOperation = 'source-over';
  return { w: sw, h: sh };
}

// featurePaste puts one held feature at another place, at another size.
function featurePaste(p, slot, size, dst) {
  if (!size) return;
  const c = p['feat' + slot];
  if (!c) return;
  const dw = Math.max(6, Math.round(dst.w)),
    dh = Math.max(6, Math.round(dst.h));
  p.ctx.drawImage(c, 0, 0, size.w, size.h, Math.round(dst.x), Math.round(dst.y), dw, dh);
}

// featureMoves moves a set of features at once: every feature and the skin that
// covers its old place is held first, then the skins are painted, then the
// features. A move is { slot, src, dst, skin }; skin is the cover offset as a
// share of the feature size, just below it when left out.
function featureMoves(p, moves) {
  const held = [];
  for (const m of moves) {
    const size = featureCopy(p, m.slot, m.src);
    const off = m.skin || [0, 0.62];
    const under = featureCopy(p, m.slot + 'skin', {
      x: m.src.x + off[0] * m.src.w,
      y: m.src.y + off[1] * m.src.h,
      w: m.src.w,
      h: m.src.h,
    });
    held.push({ m, size, under });
  }
  for (const h of held) featurePaste(p, h.m.slot + 'skin', h.under, h.m.src);
  for (const h of held) featurePaste(p, h.m.slot, h.size, h.m.dst);
}

// lookCustom applies the knobs of the custom effect to one face. First the
// features move on the picture as the camera gave it, where the mesh points are
// exact, or the eyes and the mouth swap. Then the whole face is warped as it
// stands: the pinch or bulge, the head width, the head height. A knob at its
// neutral value does nothing at all.
function lookCustom(p, a) {
  const cfg = custom();
  const W = p.canvas.width,
    H = p.canvas.height;
  const es = cfg.eyes / 100,
    sp = cfg.spread / 100,
    lift = cfg.eyey / 100,
    ns = cfg.nose / 100,
    ms = cfg.mouth / 100,
    mshift = cfg.mshift / 100,
    hk = cfg.head / 100,
    wk = cfg.width / 100,
    pk = cfg.pinch / 100;
  const g = maskGeo(a, W, H);
  const fL = eyeFrame(g.eyeL),
    fR = eyeFrame(g.eyeR);
  const cxe = (fL.x + fR.x) / 2,
    cye = (fL.y + fR.y) / 2;
  const gapE = Math.max(8, Math.hypot(fR.x - fL.x, fR.y - fL.y));
  const eyeW = Math.max(g.fw * 0.2, gapE * 0.34);
  const ew = eyeW * 2.0,
    eh = eyeW * 1.15;
  const mcx = (g.mouthL[0] + g.mouthR[0]) / 2,
    mcy = (g.mouthL[1] + g.mouthR[1]) / 2;
  const mw = Math.max(g.fw * 0.34, gap(g.mouthL, g.mouthR) * 1.7);
  const mh = Math.max(mw * 0.62, g.fh * 0.16);
  const box = (cx, cy, w, h) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
  // The mouth goes down the face by the knob, along the face axis, so a head
  // that leans carries the shift with it.
  const mouthAt = g.spot([mcx, mcy], 0, -mshift);
  const moves = [];
  if (cfg.swap) {
    // The pair of eyes goes to the mouth, and the mouth goes between the eyes.
    const eyesBox = box(cxe, cye, gapE * 1.35 + ew * 0.5, eh * 1.7);
    const mouthBox = box(mcx, mcy, mw, mh);
    moves.push({
      slot: 'A',
      src: eyesBox,
      dst: box(mouthAt[0], mouthAt[1], mw * 1.05, mw * 1.05 * (eyesBox.h / eyesBox.w)),
      skin: [0, 0.7],
    });
    moves.push({
      slot: 'B',
      src: mouthBox,
      dst: box(cxe, cye, gapE * 1.15, gapE * 1.15 * (mouthBox.h / mouthBox.w)),
      skin: [0, 0.7],
    });
  } else {
    if (es !== 1 || sp !== 1 || lift !== 0) {
      // Both eyes are moved about the middle of the eye line, so the spread
      // follows a head that leans, and the lift is up the face axis.
      const eyes: Array<[{ x: number; y: number; w: number; ang: number }, number]> = [
        [fL, fL.x < cxe ? -1 : 1],
        [fR, fR.x > cxe ? 1 : -1],
      ];
      eyes.forEach(([f, side], i) => {
        const to = g.spot([cxe + (f.x - cxe) * sp, cye + (f.y - cye) * sp], 0, lift);
        moves.push({
          slot: 'E' + i,
          src: box(f.x, f.y, ew, eh),
          dst: box(to[0], to[1], ew * es, eh * es),
          skin: [side * 0.06, 0.62],
        });
      });
    }
    if (ns !== 1) {
      // The nose is a soft oval a little above its tip. The skin that covers
      // the old nose comes from the cheek beside it and not from the lip below.
      const n = g.spot(g.nose, 0, 0.03);
      const nw = g.fw * 0.34,
        nh = g.fh * 0.26;
      moves.push({
        slot: 'N',
        src: box(n[0], n[1], nw, nh),
        dst: box(n[0], n[1], nw * ns, nh * ns),
        skin: [-0.95, 0.05],
      });
    }
    if (ms !== 1 || mshift !== 0) {
      moves.push({
        slot: 'M',
        src: box(mcx, mcy, mw, mh),
        dst: box(mouthAt[0], mouthAt[1], mw * ms, mh * ms),
      });
    }
  }
  if (moves.length) featureMoves(p, moves);
  // The warps use the mesh of the camera frame, and the face has not moved far
  // from it: the pinch goes first, about the middle of the face, then the width,
  // about the middle of the head, then the height of the whole band.
  if (pk !== 0) pinchFace(p, g, pk > 0 ? 1 + 1.8 * pk : 1 + 0.5 * pk);
  if (Math.abs(wk - 1) > 0.02) {
    const mx = (g.top[0] + g.chin[0]) / 2,
      my = (g.top[1] + g.chin[1]) / 2;
    // The ring has to hold the widened head, so it grows with the knob.
    warpEllipse(p, mx, my, g.fw * (0.8 + 0.4 * Math.max(wk, 1)), g.fh * 1.15, roll(g), 1 / wk, 1);
  }
  if (Math.abs(hk - 1) > 0.02) headBand(p, a, hk);
}

// warpPatch draws one ellipse of the video, widened by kx and heightened by ky
// about its centre. The patch is prepared on a small reused canvas; a frame
// pays three of them, and the colour step of the look is applied again so the
// patch matches the picture around it.
function warpPatch(p, cx, cy, rx, ry, kx, ky, filter) {
  const W = p.canvas.width,
    H = p.canvas.height;
  const dw = 2 * rx * kx,
    dh = 2 * ry * ky;
  const iw = Math.ceil(dw),
    ih = Math.ceil(dh);
  const vw = p.video.videoWidth,
    vh = p.video.videoHeight;
  if (iw < 8 || ih < 8 || !vw || !vh) return;
  if (!p.warpCanvas) {
    p.warpCanvas = document.createElement('canvas');
    p.warpCtx = p.warpCanvas.getContext('2d');
  }
  const c = p.warpCanvas,
    cc = p.warpCtx;
  if (c.width < iw) c.width = iw;
  if (c.height < ih) c.height = ih;
  // The same ellipse in the frame, in video pixels, as the source.
  const sx = ((cx - rx) * vw) / W,
    sy = ((cy - ry) * vh) / H;
  cc.clearRect(0, 0, iw, ih);
  cc.globalCompositeOperation = 'source-over';
  cc.drawImage(p.video, sx, sy, (2 * rx * vw) / W, (2 * ry * vh) / H, 0, 0, iw, ih);
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
  else if (which === 'fawkes') drawFawkes(ctx, W, H, g);
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
  ctx.bezierCurveTo(
    l[0] + half * 0.5,
    ty - room * 0.2,
    mx - half * 0.5,
    ty - room * 0.3,
    mx,
    ty + room * 0.12,
  );
  ctx.bezierCurveTo(
    mx + half * 0.5,
    ty - room * 0.3,
    r[0] - half * 0.5,
    ty - room * 0.2,
    r[0],
    r[1],
  );
  // Back under the lip, with a droop at each corner.
  ctx.bezierCurveTo(r[0] - half * 0.3, by + room * 0.35, mx + half * 0.4, by + room * 0.4, mx, by);
  ctx.bezierCurveTo(
    mx - half * 0.4,
    by + room * 0.4,
    l[0] + half * 0.3,
    by + room * 0.35,
    l[0],
    l[1],
  );
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
  // so a talking mouth does not make the tongue flicker. Openness is a share of
  // the mouth width, so the tongue starts small and grows with the jaw.
  const open = clamp(g.tongue, 0, 1);
  if (open > 0.02) {
    const mx = (g.mouthL[0] + g.mouthR[0]) / 2;
    const my = (g.lip[1] + g.lipLow[1]) / 2;
    const half = gap(g.mouthL, g.mouthR) * 0.42 || g.fw * 0.08;
    const tip = g.spot(g.lip, 0, -(0.02 + 0.17 * open));
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
// licence). The cut-out goes on the face and the camera shows through it.
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
// frame and never twice. The drawing is the mask: there is one version of it.
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

// The colours of the drawn face: one flat skin, one jaw shade, the teal of the
// hair, a blue green iris and the pink of the cheeks.
const MIKU = {
  skin: '#f8dfd3',
  shade: 'rgba(196, 142, 126, 0.35)',
  lash: '#123943',
  iris: ['#7ff0e6', '#0d6a82'],
  blush: 'rgba(243, 154, 166, 0.5)',
  mouth: '#93404f',
  tongue: '#e37a83',
  inside: '#45161d',
  teeth: '#fbf3ef',
};

// drawMikuEye draws one drawn eye at x, y with a full width w and a full open
// height h. open is the lid share the mesh reads, 0 shut and 1 wide: the eye
// closes with the lid and keeps the same lash line, so a blink reads as a blink
// and not as a hole in the face. gx and gy are the gaze the mesh reads, in
// shares of an eye: the iris and its highlights move that way inside the white,
// so the drawn eye looks where the person looks.
function drawMikuEye(ctx, x, y, w, h, open, gx = 0, gy = 0) {
  const o = clamp(open, 0, 1);
  const rw = w / 2;
  const rh = Math.max((h / 2) * (0.16 + 0.84 * o), 0.8);
  ctx.lineCap = 'round';
  if (o < 0.14) {
    // A shut eye is the lid line alone, drawn at the weight of an open lash.
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
  // The white of the eye, then the iris: a tall oval, a dark pupil and two
  // highlights, the usual cel eye.
  ctx.fillStyle = '#fdfbf8';
  ctx.fillRect(x - rw, y - rh, w, rh * 2);
  const ir = Math.min(rw * 0.82, rh * 0.95);
  // The iris stays inside the white: the gaze share is capped at the room left
  // beside it, and the eye clip cuts anything that still reaches the rim.
  const ix = x + clamp(gx, -1, 1) * Math.max(rw - ir * 0.9, 0) * 0.95;
  const iy = y + rh * 0.08 + clamp(gy, -1, 1) * Math.max(rh - ir, 0) * 0.9;
  const ig = ctx.createLinearGradient(x, iy - ir, x, iy + ir);
  ig.addColorStop(0, MIKU.iris[0]);
  ig.addColorStop(1, MIKU.iris[1]);
  ctx.fillStyle = ig;
  ctx.beginPath();
  ctx.ellipse(ix, iy, ir * 0.9, ir, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#082026';
  ctx.beginPath();
  ctx.ellipse(ix, iy + ir * 0.05, ir * 0.38, ir * 0.52, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.ellipse(ix - ir * 0.3, iy - ir * 0.42, ir * 0.24, ir * 0.3, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(ix + ir * 0.3, iy + ir * 0.32, ir * 0.12, ir * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // The lash line sits on the top of the eye and is the heaviest mark on the
  // face, so the eye keeps its shape while the lid comes down.
  ctx.strokeStyle = MIKU.lash;
  ctx.lineWidth = Math.max(1.8, h * 0.16);
  ctx.beginPath();
  ctx.ellipse(x, y, rw * 0.99, rh * 0.99, 0, Math.PI * 1.04, Math.PI * 1.96);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(18, 57, 67, 0.55)';
  ctx.lineWidth = Math.max(1, h * 0.07);
  ctx.beginPath();
  ctx.ellipse(x, y, rw * 0.96, rh * 0.96, 0, Math.PI * 0.06, Math.PI * 0.94);
  ctx.stroke();
}

// drawMikuSkin lays the face oval, the jaw shade and the two cheeks. The oval
// runs from above the hairline to below the chin and past each cheek, so no
// camera pixel under the mask is left open, and the wig covers its rim.
function drawMikuSkin(ctx, g, cx, cy) {
  const rx = Math.max(g.fw * 0.54, 1);
  const ry = Math.max(g.fh * 0.6, 1);
  ctx.beginPath();
  ctx.ellipse(cx, cy + g.fh * 0.03, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = MIKU.skin;
  ctx.fill();
  const shade = ctx.createRadialGradient(cx, cy + g.fh * 0.05, rx * 0.2, cx, cy + g.fh * 0.05, rx);
  shade.addColorStop(0, 'rgba(255, 255, 255, 0)');
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
    bg.addColorStop(1, 'rgba(243, 154, 166, 0)');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.ellipse(bx, by, g.fw * 0.1, g.fw * 0.055, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// drawMiku wears the wig and a drawn face under it, the way a vtuber avatar
// works: the whole face is covered and the drawn eyes, brows and mouth follow
// the live face. The eyes blink with the lid the mesh reads, the mouth opens
// with the jaw, and every feature is placed on its own landmark, so a head that
// turns, leans or moves takes the face with it. The cut-out of the drawing is
// the anchor: it is the width of the face and it runs from a little under the
// hairline to the chin, so the crown sits on the head and a tail falls past
// each ear.
function drawMiku(ctx, g) {
  wigLoad();
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
  // the other, so a head that turns or leans carries the whole head with it.
  const ax = g.ax,
    ay = g.ay;
  // home reads a frame point in the pixels of the drawing, so a feature sits on
  // the landmark it mimics.
  const home = (pt) => {
    const dx = pt[0] - mid[0],
      dy = pt[1] - mid[1];
    return [cx + dx * ax[0] + dy * ax[1], cy - (dx * ay[0] + dy * ay[1])];
  };
  const at = (p, q) => home([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.transform(
    ax[0],
    ax[1],
    -ay[0],
    -ay[1],
    mid[0] - ax[0] * cx + ay[0] * cy,
    mid[1] - ax[1] * cx + ay[1] * cy,
  );
  drawMikuSkin(ctx, g, cx, cy);
  // The nose: one small shade, no more, the way a cel face draws it.
  const [nx, ny] = home(g.nose);
  ctx.fillStyle = 'rgba(190, 130, 118, 0.5)';
  ctx.beginPath();
  ctx.ellipse(nx, ny + g.fh * 0.02, g.fw * 0.018, g.fw * 0.01, 0, 0, Math.PI * 2);
  ctx.fill();
  // The mouth is drawn on the real corners, so a smile lifts the drawn corners
  // and a wide mouth widens it. A shut mouth is a seam with a soft lower lip
  // under it; an open one is a rounded mouth with a teeth line and a tongue,
  // and the jaw drop sets how far it opens.
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
    // The seam, a soft lower lip and one highlight: a shut mouth is no hole.
    ctx.strokeStyle = MIKU.mouth;
    ctx.lineWidth = lipW;
    ctx.beginPath();
    ctx.moveTo(mcx - halfW, cornerY);
    ctx.quadraticCurveTo(mcx, mcy + halfW * 0.16, mcx + halfW, cornerY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(206, 108, 122, 0.35)';
    ctx.beginPath();
    ctx.ellipse(mcx, mcy + halfW * 0.17, halfW * 0.72, halfW * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 235, 235, 0.5)';
    ctx.beginPath();
    ctx.ellipse(
      mcx - halfW * 0.18,
      mcy + halfW * 0.12,
      halfW * 0.2,
      halfW * 0.05,
      -0.1,
      0,
      Math.PI * 2,
    );
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
      cornerY - mh * 0.06,
    );
    ctx.bezierCurveTo(
      mcx + halfW * 0.2,
      cornerY - mh * 0.1,
      mcx + halfW * 0.62,
      cornerY - mh * 0.12,
      mcx + halfW,
      cornerY,
    );
    ctx.bezierCurveTo(
      mcx + halfW * 0.86,
      bottom - mh * 0.06,
      mcx + halfW * 0.44,
      bottom + mh * 0.06,
      mcx,
      bottom + mh * 0.06,
    );
    ctx.bezierCurveTo(
      mcx + halfW * 0.44,
      bottom + mh * 0.06,
      mcx - halfW * 0.86,
      bottom - mh * 0.06,
      mcx - halfW,
      cornerY,
    );
    ctx.closePath();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = MIKU.inside;
    ctx.fillRect(mcx - halfW, cornerY - mh, halfW * 2, mh * 3);
    // The teeth stay on the top lip, shorter as the mouth opens wide, and the
    // tongue sits on the floor of the mouth, so the mouth reads as a mouth and
    // not as a pink oval.
    if (open > 0.22) {
      ctx.fillStyle = MIKU.teeth;
      ctx.beginPath();
      ctx.ellipse(
        mcx,
        cornerY - mh * 0.03,
        halfW * 0.88,
        mh * (0.16 + 0.08 * (1 - open)),
        0,
        0,
        Math.PI,
      );
      ctx.fill();
    }
    if (open > 0.4) {
      ctx.fillStyle = MIKU.tongue;
      ctx.beginPath();
      ctx.ellipse(
        mcx,
        bottom + mh * 0.06,
        halfW * 0.5,
        mh * (0.1 + 0.16 * open),
        0,
        0,
        Math.PI * 2,
      );
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
      bottom + mh * 0.08,
    );
    ctx.bezierCurveTo(
      mcx + halfW * 0.4,
      bottom + mh * 0.08,
      mcx + halfW * 0.9,
      bottom - mh * 0.04,
      mcx + halfW,
      cornerY,
    );
    ctx.stroke();
  }
  // The wig goes over the rim of the face oval, so the hairline and the tails
  // are the drawing and the drawn face fills its cut-out.
  if (wigArt) ctx.drawImage(wigArt, 0, 0, artW, artH);
  // The eyes and the brows come after the wig: a fringe hangs over the face
  // and would hide them, and a drawn eye that nobody can see cannot follow a
  // real one. They stay on the face oval, so no lash line runs onto the hair
  // outside it.
  // The eyes: drawn over the real ones, a little larger, at the size the mesh
  // gives and with the lid share it reads. A face on the box anchor has no
  // mesh, so the eyes stay open and the box sizes them.
  const eyeLW = Math.max(gap(g.eyeL[0], g.eyeL[1]) * 1.4, g.fw * 0.19);
  const eyeRW = Math.max(gap(g.eyeR[0], g.eyeR[1]) * 1.4, g.fw * 0.19);
  const eyeH = Math.max(eyeLW, eyeRW) * 0.74;
  const lid = g.lid == null ? 1 : g.lid;
  const [elx, ely] = at(g.eyeL[0], g.eyeL[1]);
  const [erx, ery] = at(g.eyeR[0], g.eyeR[1]);
  // A soft skin patch under each eye keeps a fringe strand from cutting the
  // drawn eye in two: the face reads in front of the hair at the eye, and the
  // patch fades out, so it leaves no edge of its own.
  for (const [ex, ey, ew, eh] of [
    [elx, ely, eyeLW, eyeH],
    [erx, ery, eyeRW, eyeH],
  ]) {
    const skin = ctx.createRadialGradient(
      ex,
      ey,
      Math.min(ew, eh) * 0.18,
      ex,
      ey,
      Math.max(ew, eh) * 0.72,
    );
    skin.addColorStop(0, 'rgba(248, 223, 211, 1)');
    skin.addColorStop(0.72, 'rgba(248, 223, 211, 0.96)');
    skin.addColorStop(1, 'rgba(248, 223, 211, 0)');
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(ex, ey, ew * 0.72, eh * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const gaze = g.gaze || [0, 0, 0, 0];
  drawMikuEye(ctx, elx, ely, eyeLW, eyeH, lid, gaze[0], gaze[1]);
  drawMikuEye(ctx, erx, ery, eyeRW, eyeH, lid, gaze[2], gaze[3]);
  // The brows: thin teal arcs over the eyes, lifted by their own landmark, so a
  // raised brow reads as a raised brow.
  for (const [brow, eye, w] of [
    [g.browL, ely, eyeLW],
    [g.browR, ery, eyeRW],
  ]) {
    const [bx, by] = home(brow);
    const lift = Math.min(by, eye - eyeH * 0.95);
    ctx.strokeStyle = 'rgba(23, 92, 90, 0.95)';
    ctx.lineWidth = Math.max(1.4, eyeH * 0.09);
    ctx.beginPath();
    ctx.moveTo(bx - w * 0.5, lift + eyeH * 0.1);
    ctx.quadraticCurveTo(bx, lift - eyeH * 0.16, bx + w * 0.5, lift + eyeH * 0.1);
    ctx.stroke();
  }
  ctx.restore();
}

// lookPublish swaps the drawn track into every camera sender and the own
// preview; the screen sender is left alone, so a look never reaches the share.
export async function lookPublish(track) {
  if (!state.outStream) return;
  // A frozen picture stays on the senders: only the freeze itself swaps it.
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
      await peer.tx.video.sender.replaceTrack(track).catch(() => {});
    }),
  );
  paintSelfCam(true);
}

// freezeShot takes one picture of what the peers see now and returns a track
// that carries only that frame: the drawn canvas while a look or a mask draws,
// else one frame of the camera itself, which needs a throwaway element.
async function freezeShot() {
  let src;
  const p = state.lookPipe;
  if (lookOn() && p && p.canvas && p.canvas.width > 1) {
    src = p.canvas;
  } else {
    if (!state.freezeVideo) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.className = 'offstage';
      document.body.appendChild(v);
      state.freezeVideo = v;
    }
    const v = state.freezeVideo;
    const now = v.srcObject && v.srcObject.getVideoTracks()[0];
    if (now !== state.camTrack) v.srcObject = new MediaStream([state.camTrack]);
    try {
      await v.play();
    } catch {
      /* a frame may already be there */
    }
    for (let i = 0; i < 20 && !v.videoWidth; i += 1) await new Promise((r) => setTimeout(r, 25));
    src = v;
  }
  const w = src.width || src.videoWidth || 0;
  const h = src.height || src.videoHeight || 0;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, w, h);
  // A second canvas holds the same picture. The live stream draws from it below,
  // because a captured canvas sends a frame only when something is drawn into it.
  const held = document.createElement('canvas');
  held.width = w;
  held.height = h;
  const hg = held.getContext('2d');
  if (hg) hg.drawImage(canvas, 0, 0);
  state.freezeSource = held;
  // Zero frames per second: the stream sends a frame only when one is asked
  // for, and the pulse below asks twice a second.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  track.contentHint = 'detail';
  if ((track as any).requestFrame) (track as any).requestFrame();
  state.freezeCanvas = canvas;
  return track;
}

// freezePulse draws the held picture into the frozen canvas and asks for a
// frame, twice a second. A captured canvas sends a frame only when it is asked
// for, and a frame asked for before a sender exists is dropped with the sender,
// so a still that is never touched reaches the peers that were connected when
// it was taken and nobody else. Drawing the same picture again costs nothing
// and gives every late peer a frame within half a second.
function freezePulse() {
  if (state.freezeTimer) clearInterval(state.freezeTimer);
  state.freezeTimer = setInterval(() => {
    if (!state.freeze || !state.freezeCanvas || !state.freezeSource) {
      clearInterval(state.freezeTimer);
      state.freezeTimer = null;
      return;
    }
    const g = state.freezeCanvas.getContext('2d');
    if (g) g.drawImage(state.freezeSource, 0, 0);
    const t = state.freezeTrack as any;
    if (t && t.requestFrame) t.requestFrame();
  }, 500);
}

// setFreeze locks the outgoing camera picture to one frame, and puts the live
// picture back when it goes off. The camera keeps running, so its light stays
// on and the preview comes back at once; only the senders carry the still.
export async function setFreeze(on) {
  on = !!on;
  if (on === !!state.freeze) return true;
  if (on) {
    if (!state.camTrack) {
      say('the camera is off, so there is nothing to freeze');
      return false;
    }
    const track = await freezeShot();
    if (!track) {
      say('the camera gave no frame to freeze');
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

// lookPark answers a hidden tab: a browser may hold the frames of the camera
// element while the tab is away, and the canvas would then carry one picture.
// The camera track keeps running, so the senders take it while the tab is
// hidden, and the drawn track comes back with the next frame. The camera is not
// stopped, so its light stays on.
export async function lookPark(hidden) {
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
  try {
    await p.video.play();
  } catch {
    /* it plays already */
  }
  lookDraw(p);
  p.clock = lookClock(p);
  await lookPublish(p.track);
}

// lookStop drops the pipeline. With restore it puts the camera track back on the
// camera senders and the preview.
export function lookStop(restore = true) {
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
      if (tr && !peer.waiting) tr.sender.replaceTrack(track || null).catch(() => {});
    }
  }
  paintSelfCam(!!track && state.cam);
}

// armLookTearDown re-arms the tear-down timer that ends the grace; it does
// nothing while an effect is on.
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

// lookRestart starts or stops the pipeline to match the choice and the live
// camera; the menu and the camera path both come here. A running pipeline is
// kept while the choice draws something and for a grace after the last effect
// goes off: every sender track swap costs a fresh keyframe and the picture
// blinks, so a menu click that only changes what is drawn must not rebuild it.
// Only a new camera track or the end of the grace does that.
export async function lookRestart() {
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
export function lookInit() {
  const saved = load('look');
  state.look = Object.prototype.hasOwnProperty.call(LOOKS, saved) ? saved : 'none';
  state.masks = maskSet(load('mask'));
  const lookPick = $('look-filter');
  if (lookPick) {
    lookPick.value = state.look;
    lookPick.addEventListener('change', () => {
      state.look = Object.prototype.hasOwnProperty.call(LOOKS, lookPick.value)
        ? lookPick.value
        : 'none';
      store('look', state.look);
      lookRestart();
    });
  }
  for (const box of maskBoxes()) {
    box.checked = state.masks.includes(box.dataset.mask);
    box.addEventListener('change', () => {
      state.masks = maskSet([...maskBoxes()].filter((b) => b.checked).map((b) => b.dataset.mask));
      store('mask', state.masks.join('+'));
      // The custom knobs are only in reach while their mask is on.
      paintCustomPanel();
      lookRestart();
    });
  }
  customInit();
  paintCustomPanel();
}

// customInit wires the knobs of the custom face effect. Each slider writes its
// own value and the next painted frame carries it, so the face changes while
// the handle moves; no restart and no new track.
function customInit() {
  customRowsAdd();
  const raw = load('cust');
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      for (const key of Object.keys(state.cust)) {
        if (saved && Object.hasOwn(saved, key) && typeof saved[key] === typeof state.cust[key]) {
          state.cust[key] = saved[key];
        }
      }
    } catch {
      // An old or half written value: the defaults stay.
    }
  }
  for (const [id, key] of CUSTOM_ROWS) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    el.addEventListener('input', () => {
      const n = Number(el.value);
      state.cust[key] = Number.isFinite(n) ? n : 0;
      paintCustomValue(key);
      store('cust', JSON.stringify(state.cust));
    });
  }
  const swap = $('cx-swap');
  if (swap) {
    swap.addEventListener('change', () => {
      state.cust.swap = swap.checked;
      store('cust', JSON.stringify(state.cust));
    });
  }
  const reset = document.getElementById('cx-reset');
  if (reset) {
    reset.addEventListener('click', () => {
      state.cust = { ...CUST_DEFAULTS };
      store('cust', JSON.stringify(state.cust));
      paintCustomValues();
    });
  }
  paintCustomValues();
}

// CUSTOM_ROWS is the knob table the paint helpers walk: slider id, state key,
// readout id.
const CUSTOM_ROWS = [
  ['cx-head', 'head', 'cx-head-v'],
  ['cx-width', 'width', 'cx-width-v'],
  ['cx-eyes', 'eyes', 'cx-eyes-v'],
  ['cx-spread', 'spread', 'cx-spread-v'],
  ['cx-eyey', 'eyey', 'cx-eyey-v'],
  ['cx-nose', 'nose', 'cx-nose-v'],
  ['cx-mouth', 'mouth', 'cx-mouth-v'],
  ['cx-mshift', 'mshift', 'cx-mshift-v'],
  ['cx-pinch', 'pinch', 'cx-pinch-v'],
] as const;

// CUSTOM_EXTRA are the knobs the panel markup does not carry: slider id, state
// key, label, lowest, highest, and the row each new row follows.
type CustomKnob = Exclude<keyof typeof CUST_DEFAULTS, 'swap'>;

const CUSTOM_EXTRA: ReadonlyArray<readonly [string, CustomKnob, string, number, number, string]> = [
  ['cx-width', 'width', 'head width', 60, 200, 'cx-head'],
  ['cx-eyey', 'eyey', 'eye height', -25, 25, 'cx-spread'],
  ['cx-nose', 'nose', 'nose size', 40, 220, 'cx-eyey'],
  ['cx-pinch', 'pinch', 'pinch / bulge', -100, 100, 'cx-mshift'],
];

// customRowsAdd gives each knob in CUSTOM_EXTRA a row in the panel. The row is a
// copy of the mouth y row, so it takes the look of the others, with its own ids,
// label and range. A page that already carries the row keeps it.
function customRowsAdd() {
  const panel = document.getElementById('cx-panel');
  const source = document.getElementById('cx-mshift')?.closest('.cx-row');
  if (!panel || !source || source.parentElement !== panel) return;
  for (const [id, key, label, lo, hi, after] of CUSTOM_EXTRA) {
    if (document.getElementById(id)) continue;
    const row = document.getElementById(after)?.closest('.cx-row');
    if (!row || row.parentElement !== panel) continue;
    const copy = source.cloneNode(true) as HTMLElement;
    const range = copy.querySelector('input');
    const name = copy.querySelector('.cx-name');
    const readout = copy.querySelector('.cx-val');
    if (!range || !name || !readout) continue;
    for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
    range.id = id;
    readout.id = id + '-v';
    range.min = String(lo);
    range.max = String(hi);
    range.value = String(state.cust[key]);
    range.setAttribute('aria-label', label);
    name.textContent = label;
    row.after(copy);
  }
}

// paintCustomValue puts one knob and its number back from the state.
function paintCustomValue(key) {
  for (const [id, name, out] of CUSTOM_ROWS) {
    if (name !== key) continue;
    const el = document.getElementById(id) as HTMLInputElement | null;
    const tag = document.getElementById(out);
    if (el) el.value = String(state.cust[key]);
    if (tag) tag.textContent = String(state.cust[key]);
  }
}

// paintCustomValues puts every knob and the swap box back from the state.
function paintCustomValues() {
  for (const [, key] of CUSTOM_ROWS) paintCustomValue(key);
  const swap = $('cx-swap');
  if (swap) swap.checked = !!state.cust.swap;
}

// paintCustomPanel shows the knobs only while the custom mask is on.
function paintCustomPanel() {
  const panel = document.getElementById('cx-panel');
  if (panel) panel.hidden = !state.masks.includes('custom');
}

// maskBoxes is the mask row of the effects menu: one box per drawing.
export function maskBoxes() {
  return document.querySelectorAll(
    '#menu-effects input[data-mask]',
  ) as NodeListOf<HTMLInputElement>;
}

// lookResize resizes the canvas to the camera step, so the picture keeps its
// shape.
export function lookResize() {
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
