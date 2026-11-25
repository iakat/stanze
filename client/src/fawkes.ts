// The Guy Fawkes mask: one rigid white shell with a painted black face, built
// once in model units, across and up the face in face widths, so a turn or a
// lean keeps its proportions. The fit puts the eye holes on the eyes, the mouth
// line on the mouth and the chin on the chin, and the head carries the shell.

type P2 = [number, number];
type P3 = [number, number, number];

// Model anchors. The eye centres are the fit; the rest is the drawing.
const EYE_X = 0.152;
const EYE_Y = 0.045;
// The fit measures the chin; the shell runs past it, under the jaw and above
// the hairline, at the crown. The real mask is wide for its height: the rim is
// one width across the cheekbones and 1.28 widths from the chin to the crown.
const CHIN_Y = -0.8;
const CROWN_Y = 0.56;
const FIT_CHIN_Y = -0.66;
const NOSE_Y = -0.02;

// Eye hole: half width, upper and lower half height, and the angry tilt.
const HOLE_A = 0.105;
const HOLE_BU = 0.05;
const HOLE_BL = 0.06;
const HOLE_TILT = 0.15;

// A light from the upper left of the frame, in front of the mask: the usual
// window light a webcam sees. The eye is on the camera axis.
const LX = -0.56,
  LY = 0.44,
  LZ = 0.7;
const HN = Math.hypot(LX, LY, LZ + 1);
const HX = LX / HN,
  HY = LY / HN,
  HZ = (LZ + 1) / HN;

const SHELL: P3 = [0.968, 0.958, 0.918];
// How far the middle of the shell stands out from the plane of its rim.
const SHELL_DEPTH = 0.26;

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ramp is a smooth step from a to b, and it reads backwards when b is below a.
function ramp(a: number, b: number, v: number) {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// -------------------------------------------------------------- the outline
// One closed curve: a pointed chin, wide cheekbones and a high forehead. The
// right half is drawn and mirrored, and the result is resampled to equal
// arcs, so a wheel around the middle gives an even mesh.
type Seg = [P2, P2, P2, P2];

const RIGHT: Seg[] = [
  // The chin: a narrow round bottom, not a spike, with the jaw already wide.
  [
    [0, CHIN_Y],
    [0.07, -0.795],
    [0.16, -0.735],
    [0.3, -0.62],
  ],
  // The jaw swells outward to the cheekbone, so the lower edge is convex and
  // the cheek lines bow away from the middle, not toward it.
  [
    [0.3, -0.62],
    [0.42, -0.55],
    [0.48, -0.45],
    [0.5, -0.3],
  ],
  // The widest part of the shell is high, over the cheekbones, and the side
  // holds its width up to the temple, so the shape is a shield, not a cone.
  [
    [0.5, -0.3],
    [0.505, -0.14],
    [0.51, 0.08],
    [0.5, 0.22],
  ],
  // The corner of the temple: a tight round, then the crown runs flat.
  [
    [0.5, 0.22],
    [0.49, 0.38],
    [0.45, 0.44],
    [0.38, 0.48],
  ],
  // A broad crown over the brow, domed just enough to read as a shell.
  [
    [0.38, 0.48],
    [0.28, 0.535],
    [0.15, 0.57],
    [0, 0.58],
  ],
];

function cubic(p0: P2, c1: P2, c2: P2, p1: P2, t: number): P2 {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

function outlineRaw() {
  const pts: P2[] = [];
  for (const s of RIGHT) {
    for (let i = 0; i < 14; i++) pts.push(cubic(s[0], s[1], s[2], s[3], i / 14));
  }
  for (let i = RIGHT.length - 1; i >= 0; i--) {
    const s = RIGHT[i];
    for (let k = 13; k > 0; k--) {
      const p = cubic(s[0], s[1], s[2], s[3], k / 14);
      pts.push([-p[0], p[1]]);
    }
  }
  return pts;
}

// resample walks the closed curve by length and hands back n even points.
function resample(src: P2[], n: number) {
  const acc = [0];
  let total = 0;
  for (let i = 0; i < src.length; i++) {
    const a = src[i],
      b = src[(i + 1) % src.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    acc.push(total);
  }
  const out: P2[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const want = (total * i) / n;
    while (k < acc.length - 2 && acc[k + 1] < want) k++;
    const a = src[k % src.length],
      b = src[(k + 1) % src.length];
    const seg = acc[k + 1] - acc[k] || 1;
    const t = (want - acc[k]) / seg;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

const OUTLINE = resample(outlineRaw(), 96);

// outlineAt picks the point of the rim that a wheel step of the mesh lands on:
// the rim is sampled finer than the mesh, so the mesh takes every n-th point.
function outlineAt(i: number, seg: number): P2 {
  return OUTLINE[Math.round((i * OUTLINE.length) / seg) % OUTLINE.length];
}

// ---------------------------------------------------------------- the shell
// fawkesRho is how far out a model point is, one at the rim of the shell.
function fawkesRho(x: number, y: number) {
  // The rim is nearer the middle above the eye line than below it, so the two
  // halves get their own reach and the rim of the shell reads as one.
  return Math.min(1, Math.hypot(x / 0.505, y / (y > 0 ? 0.6 : 0.8)));
}

function gauss(d: number) {
  return Math.exp(-d * d);
}

// fawkesHeight is the surface of the mask in model units: the surface of the
// face under it, then the brow ridges, the nose, the cheekbones, the hollows
// under them and the chin of the shell. The lighting reads all of it, so the
// form is a shape and not a shading trick.
function fawkesHeight(f: Fit, x: number, y: number, rho: number) {
  const face = f.face;
  // The depth of the mesh is the surface; without a mesh the old dome stands,
  // low and flat, so a colour test still gets a mask.
  // The shell is a dome of its own depth, so a turn shows its curve even
  // without a mesh, and the mesh only adds the face where it stands out.
  const dome = SHELL_DEPTH * Math.sqrt(Math.max(0, 1 - rho * rho));
  let z = dome;
  if (f.form) z = Math.max(dome, formAt(f.form, x, y));
  // The ridges hang on the landmarks: a brow that sits high on this face lifts
  // its ridge, a mouth that sits low drops its smile.
  const browY = (face.browL[1] + face.browR[1]) / 2;
  const noseY = face.nose[1];
  const mouthY = face.lip[1];

  // Brow ridges: an arc that rises off the nose and falls to the temple.
  const u = Math.abs(x);
  if (u > 0.03 && u < 0.4) {
    const yc = browY + 0.86 * (0.158 + 1.282 * u - 3.16 * u * u) - 0.86 * 0.235;
    z += 0.05 * gauss((y - yc) / 0.045) * ramp(0.03, 0.09, u) * ramp(0.41, 0.32, u);
  }
  // The nose: a ridge that widens down to the tip, with a round tip. It runs
  // from the bridge to the tip the mesh found, so a short nose gets a short
  // ridge and a long one keeps its length.
  const ny0 = noseY + 0.15;
  const ny1 = noseY - 0.11;
  if (y > ny1 && y < ny0) {
    const t = (y - ny1) / (ny0 - ny1);
    const w = 0.024 + 0.05 * t;
    z += 0.07 * gauss(x / w) * ramp(0, 0.22, t) * ramp(1, 0.86, t);
    z += 0.02 * gauss(x / 0.07) * gauss((y - noseY) / 0.05);
    // The wings of the nose, and the crease between them and the cheek.
    z += 0.02 * gauss((Math.abs(x) - 0.06) / 0.03) * gauss((y - ny1 - 0.02) / 0.035);
    z -= 0.016 * gauss((Math.abs(x) - 0.095) / 0.028) * gauss((y - ny1) / 0.04);
  }
  // Cheekbones, and the hollows under them, between the eye line and the mouth.
  const cheekY = (EYE_Y + mouthY) / 2;
  z += 0.035 * gauss((x - 0.29) / 0.17) * gauss((y - cheekY) / 0.15);
  z += 0.035 * gauss((x + 0.29) / 0.17) * gauss((y - cheekY) / 0.15);
  z -= 0.03 * gauss((x - 0.25) / 0.13) * gauss((y - cheekY + 0.22) / 0.12);
  z -= 0.03 * gauss((x + 0.25) / 0.13) * gauss((y - cheekY + 0.22) / 0.12);
  // The eye sockets are cut back, so a hole has a wall round it.
  for (const s of [-1, 1]) {
    z -= 0.075 * gauss((x - s * EYE_X) / 0.135) * gauss((y - EYE_Y) / 0.085);
  }
  // The chin is a small point under the goatee.
  const chinY = face.chin[1] + 0.1;
  z += 0.05 * gauss(x / 0.07) * gauss((y - chinY) / 0.12);
  return z * ramp(1, 0.88, rho);
}

// ------------------------------------------------------------------ the fit
// A Fit is where the model lands in the frame: an origin, the face axes and
// two scales, plus the turn and the tilt of the head.
interface Fit {
  ox: number;
  oy: number;
  ax: P2;
  ay: P2;
  sx: number;
  sy: number;
  yaw: number;
  pitch: number;
  face: Face;
  form: Form | null;
}

// A Face is where the brows, the nose and the mouth of the face under the mask
// are, in the units of the shell. The paint and the ridges hang on these
// points, so they sit on this face and not on an average one.
interface Face {
  browL: P2;
  browR: P2;
  nose: P2;
  noseBase: P2;
  lipTop: P2;
  lip: P2;
  lipLow: P2;
  mouthL: P2;
  mouthR: P2;
  chin: P2;
  eyeLo: P2;
  eyeLi: P2;
  eyeRo: P2;
  eyeRi: P2;
}

// A Form is the surface of the face under the mask, read from the depth of the
// mesh points on a coarse grid: a shell that follows the head and is not a dome
// of one shape for every face. The heights are in the units of the model.
interface Form {
  n: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  h: Float32Array;
}

const FORM_N = 28;
const FORM_X = 0.62;
const FORM_Y = 1.02;

function dot2(a: P2, b: P2) {
  return a[0] * b[0] + a[1] * b[1];
}

function mid(a: P2, b: P2): P2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function fawkesFit(g): Fit | null {
  if (!g || !g.eyeL || !g.eyeR || !g.chin || !g.top) return null;
  const ax: P2 = g.ax || [1, 0];
  const ay: P2 = g.ay || [0, -1];
  const eL = mid(g.eyeL[0], g.eyeL[1]);
  const eR = mid(g.eyeR[0], g.eyeR[1]);
  const o = mid(eL, eR);
  const fw = Math.max(g.fw || 0, 1);
  const fh = Math.max(g.fh || 0, 1);
  // The eye centres set the width, the chin sets the height, so the mask is
  // measured on the person under it and not on an average face.
  const spanX = Math.abs(dot2([eR[0] - eL[0], eR[1] - eL[1]], ax));
  const down = -dot2([g.chin[0] - o[0], g.chin[1] - o[1]], ay);
  let sx = spanX > 1 ? spanX / (2 * EYE_X) : fw * 1.06;
  let sy = down > 1 ? down / (EYE_Y - FIT_CHIN_Y) : fh * 0.75;
  sx = Math.min(Math.max(sx, fw * 0.9), fw * 1.14);
  sy = Math.min(Math.max(sy, fh * 0.66), fh * 0.88);

  // The turn of the head, from the nose off the eye middle and from the two
  // outer eye corners: a turned head shows one side shorter than the other.
  const rel: P2 = [(g.nose ? g.nose[0] : o[0]) - o[0], (g.nose ? g.nose[1] : o[1]) - o[1]];
  const nxm = dot2(rel, ax) / sx;
  const nym = dot2(rel, ay) / sy;
  const yawNose = Math.asin(Math.min(0.92, Math.max(-0.92, nxm / 0.3)));
  const oL: P2 = [g.eyeL[0][0] - o[0], g.eyeL[0][1] - o[1]];
  const oR: P2 = [g.eyeR[1][0] - o[0], g.eyeR[1][1] - o[1]];
  const oLx = dot2(oL, ax);
  const oRx = dot2(oR, ax);
  const nAx = dot2(rel, ax);
  const dl = Math.abs(nAx - oLx),
    dr = Math.abs(oRx - nAx);
  const asym = dl + dr > 1 ? (dr - dl) / (dl + dr) : 0;
  const yaw = Math.min(0.6, Math.max(-0.6, 0.55 * yawNose - 0.75 * asym));
  // The tilt, from the nose sitting lower on the face when the head looks down.
  const pitch = Math.min(0.3, Math.max(-0.3, (nym - NOSE_Y + 0.03) * 2.2));

  const f: Fit = { ox: o[0], oy: o[1], ax, ay, sx, sy, yaw, pitch, face: null, form: null };
  f.face = faceOf(f, g);
  f.form = formOf(f, g);
  return f;
}

// flatModel inverts the fit for a frame point, with the face taken as the flat
// plane of the model. It is the map the landmarks and the depth grid are read
// with, before there is a surface to lift a point onto.
function flatModel(f: Fit, px: number, py: number): P2 {
  const dx = px - f.ox,
    dy = py - f.oy;
  const x1 = (dx * f.ax[0] + dy * f.ax[1]) / f.sx;
  const y1 = (dx * f.ay[0] + dy * f.ay[1]) / f.sy;
  const cy = Math.cos(f.yaw) || 1,
    syaw = Math.sin(f.yaw);
  const cp = Math.cos(f.pitch) || 1,
    sp = Math.sin(f.pitch);
  const x = x1 / cy;
  const y = (y1 + x * syaw * sp) / cp;
  return [x, y];
}

// toModel is flatModel with the shell under the point: the depth of the surface
// is read back into the map, so a point of the paint lands where the mesh put
// it even on a turned head.
function toModel(f: Fit, px: number, py: number): P2 {
  const dx = px - f.ox,
    dy = py - f.oy;
  const x1 = (dx * f.ax[0] + dy * f.ax[1]) / f.sx;
  const y1 = (dx * f.ay[0] + dy * f.ay[1]) / f.sy;
  const cy = Math.cos(f.yaw) || 1,
    syaw = Math.sin(f.yaw);
  const cp = Math.cos(f.pitch) || 1,
    sp = Math.sin(f.pitch);
  let x = x1 / cy,
    y = y1 / cp,
    z = 0;
  for (let k = 0; k < 2; k++) {
    z = fawkesHeight(f, x, y, fawkesRho(x, y));
    const z1 = -x * syaw + z * cy;
    x = (x1 - z * syaw) / cy;
    y = (y1 + z1 * sp) / cp;
  }
  return [x, y];
}

function facePoint(p: P2 | undefined, fallback: P2): P2 {
  return p ? p : fallback;
}

// faceOf reads the landmarks of the frame into the face frame. The colour test
// gives a box and no points; then the model keeps its own proportions, which
// is what the mask did before there was a mesh.
function faceOf(f: Fit, g): Face {
  const to = (p: P2 | undefined, fx: P2) => {
    const q = facePoint(p, fx);
    return flatModel(f, q[0], q[1]);
  };
  return {
    browL: to(g.browL, [-0.2, f.oy - 0.23 * f.sy]),
    browR: to(g.browR, [0.2, f.oy - 0.23 * f.sy]),
    nose: to(g.nose, [f.ox, f.oy - NOSE_Y * f.sy]),
    noseBase: to(g.noseBase, [f.ox, f.oy + 0.1 * f.sy]),
    lipTop: to(g.lipTop, [f.ox, f.oy + 0.24 * f.sy]),
    lip: to(g.lip, [f.ox, f.oy + 0.28 * f.sy]),
    lipLow: to(g.lipLow, [f.ox, f.oy + 0.32 * f.sy]),
    mouthL: to(g.mouthL, [f.ox - 0.2 * f.sx, f.oy + 0.28 * f.sy]),
    mouthR: to(g.mouthR, [f.ox + 0.2 * f.sx, f.oy + 0.28 * f.sy]),
    chin: to(g.chin, [f.ox, f.oy - FIT_CHIN_Y * f.sy]),
    eyeLo: flatModel(f, g.eyeL[0][0], g.eyeL[0][1]),
    eyeLi: flatModel(f, g.eyeL[1][0], g.eyeL[1][1]),
    eyeRo: flatModel(f, g.eyeR[1][0], g.eyeR[1][1]),
    eyeRi: flatModel(f, g.eyeR[0][0], g.eyeR[0][1]),
  };
}

// formOf turns the depth of the mesh into the surface of the shell: every point
// lands on the grid of the model, the front of the face wins a cell, and the
// empty cells fill in from their neighbours. Only the relief of the face is
// kept: the place of the head in space is forgotten, so the shell sits on the
// skin wherever the head is.
function formOf(f: Fit, g): Form | null {
  const lm = g.lm,
    zd = g.z;
  if (!lm || !zd || lm.length < 468 * 2 || zd.length < 468) return null;
  const n = FORM_N;
  const x0 = -FORM_X,
    y0 = -FORM_Y;
  const dx = (2 * FORM_X) / n,
    dy = (2 * FORM_Y) / n;
  const h = new Float32Array((n + 1) * (n + 1)).fill(NaN);
  const sz = (f.sx + f.sy) / 2 || 1;
  let sum = 0;
  for (let i = 0; i < 468; i++) sum += zd[i];
  const z0 = sum / 468;
  for (let i = 0; i < 468; i++) {
    const p = flatModel(f, lm[i * 2], lm[i * 2 + 1]);
    if (p[0] < x0 || p[0] > -x0 || p[1] < y0 || p[1] > -y0) continue;
    const gi = Math.round((p[0] - x0) / dx),
      gj = Math.round((p[1] - y0) / dy);
    const k = gj * (n + 1) + gi;
    const v = (z0 - zd[i]) / sz;
    if (!(h[k] >= v)) h[k] = v;
  }
  // The cells with no point take the mean of the cells around them, so the
  // grid has a height everywhere the mask reaches.
  for (let pass = 0; pass < 5; pass++) {
    const src = Float32Array.from(h);
    let left = 0;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const k = j * (n + 1) + i;
        if (!Number.isNaN(src[k])) continue;
        let sum2 = 0,
          cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const jj = j + dj,
              ii = i + di;
            if (jj < 0 || jj > n || ii < 0 || ii > n) continue;
            const v = src[jj * (n + 1) + ii];
            if (Number.isNaN(v)) continue;
            sum2 += v;
            cnt++;
          }
        }
        if (cnt) h[k] = sum2 / cnt;
        else left++;
      }
    }
    if (!left) break;
  }
  for (let k = 0; k < h.length; k++) if (Number.isNaN(h[k])) h[k] = 0;
  // Two passes of a light blur take the noise of the landmarker off the depth,
  // so the shell is a surface and not a lumpy copy of the mesh.
  for (let pass = 0; pass < 1; pass++) {
    const src = Float32Array.from(h);
    for (let j = 1; j < n; j++) {
      for (let i = 1; i < n; i++) {
        const k = j * (n + 1) + i;
        h[k] =
          (4 * src[k] + src[k - 1] + src[k + 1] + src[k - n - 1] + src[k + n + 1]) / 8;
      }
    }
  }
  return { n, x0, y0, dx, dy, h };
}

// formAt reads the surface of the face at a model point; past the grid the face
// is flat, so the rim of the mask meets the skin.
function formAt(fo: Form, x: number, y: number) {
  const fx = (x - fo.x0) / fo.dx,
    fy = (y - fo.y0) / fo.dy;
  if (!(fx >= 0 && fy >= 0 && fx <= fo.n && fy <= fo.n)) return 0;
  const i = Math.min(fo.n - 1, Math.floor(fx)),
    j = Math.min(fo.n - 1, Math.floor(fy));
  const u = fx - i,
    v = fy - j;
  const k = j * (fo.n + 1) + i;
  const a = fo.h[k],
    b = fo.h[k + 1],
    c = fo.h[k + fo.n + 1],
    d = fo.h[k + fo.n + 2];
  const top = a + (b - a) * u,
    bot = c + (d - c) * u;
  const z = top + (bot - top) * v;
  return Number.isFinite(z) ? z : 0;
}

// project turns a model point into the frame: the head turns about its up
// axis, then tilts about its across axis, and a mild perspective divides by
// the depth, so the near side of a turned mask is a little larger.
const CAM = 3.2;

function project(f: Fit, x: number, y: number, z: number, out: number[]) {
  const cy = Math.cos(f.yaw),
    syaw = Math.sin(f.yaw);
  const cp = Math.cos(f.pitch),
    sp = Math.sin(f.pitch);
  const x1 = x * cy + z * syaw;
  const z1 = -x * syaw + z * cy;
  const y1 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  const k = CAM / (CAM - z2);
  out[0] = f.ox + (f.ax[0] * x1 * f.sx + f.ay[0] * y1 * f.sy) * k;
  out[1] = f.oy + (f.ax[1] * x1 * f.sx + f.ay[1] * y1 * f.sy) * k;
  out[2] = z2;
}

function turn(f: Fit, nx: number, ny: number, nz: number, out: number[]) {
  const cy = Math.cos(f.yaw),
    syaw = Math.sin(f.yaw);
  const cp = Math.cos(f.pitch),
    sp = Math.sin(f.pitch);
  const x1 = nx * cy + nz * syaw;
  const z1 = -nx * syaw + nz * cy;
  const y1 = ny * cp - z1 * sp;
  const z2 = ny * sp + z1 * cp;
  const m = Math.hypot(x1, y1, z2) || 1;
  out[0] = x1 / m;
  out[1] = y1 / m;
  out[2] = z2 / m;
}

// ----------------------------------------------------------------- the paint
// inkColour is the black paint, lit like the shell it lies on, so the paint
// keeps the form of the face and does not read as a sticker.
function inkColour(nx: number, ny: number, nz: number) {
  const ndl = nx * LX + ny * LY + nz * LZ;
  const lit = 0.55 + 0.45 * Math.max(0, ndl);
  const r = Math.round(13 * lit + 3),
    g = Math.round(14 * lit + 3),
    b = Math.round(18 * lit + 5);
  return `rgb(${r},${g},${b})`;
}

// ------------------------------------------------------------------ the draw
export function drawFawkes(ctx: CanvasRenderingContext2D, W: number, H: number, g) {
  const f = fawkesFit(g);
  if (!f) return;
  const SEG = 60,
    RING = 26;
  const xs = new Float32Array((RING + 1) * SEG);
  const ys = new Float32Array((RING + 1) * SEG);
  const vn: number[] = new Array((RING + 1) * SEG * 3);
  const ao = new Float32Array((RING + 1) * SEG);
  const p: number[] = [0, 0, 0];
  const nv: number[] = [0, 0, 0];

  // One vertex per wheel step and ring. The height is read off the field and
  // the normal off its own slope, so the light finds every ridge.
  for (let k = 0; k <= RING; k++) {
    const rho = Math.pow(k / RING, 1.15);
    for (let i = 0; i < SEG; i++) {
      const b = outlineAt(i, SEG);
      const x = b[0] * rho,
        y = b[1] * rho;
      const z = fawkesHeight(f, x, y, rho);
      const e = 0.006;
      const gx = (fawkesHeight(f, x + e, y, rho) - fawkesHeight(f, x - e, y, rho)) / (2 * e);
      const gy = (fawkesHeight(f, x, y + e, rho) - fawkesHeight(f, x, y - e, rho)) / (2 * e);
      turn(f, -gx, -gy, 1, nv);
      project(f, x, y, z, p);
      const at = k * SEG + i;
      xs[at] = p[0];
      ys[at] = p[1];
      vn[at * 3] = nv[0];
      vn[at * 3 + 1] = nv[1];
      vn[at * 3 + 2] = nv[2];
      // The corners of the eye holes and the edge of the mask hold shadow.
      let a = 1;
      for (const s of [-1, 1]) {
        const d = Math.hypot((x - s * EYE_X) / 0.15, (y - EYE_Y) / 0.1);
        a -= 0.3 * ramp(1.7, 0.95, d);
      }
      a -= 0.14 * ramp(0.9, 1, rho);
      ao[at] = Math.max(0.45, a);
    }
  }

  // The frame of the sheet, a little larger than the mask so its shadow and
  // the paint at the rim are not cut.
  let bx = Infinity,
    by = Infinity,
    bx2 = -Infinity,
    by2 = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < bx) bx = xs[i];
    if (xs[i] > bx2) bx2 = xs[i];
    if (ys[i] < by) by = ys[i];
    if (ys[i] > by2) by2 = ys[i];
  }
  const pad = Math.max(6, f.sx * 0.08);
  bx = Math.max(-pad, Math.floor(bx - pad));
  by = Math.max(-pad, Math.floor(by - pad));
  bx2 = Math.min(W + pad, Math.ceil(bx2 + pad));
  by2 = Math.min(H + pad, Math.ceil(by2 + pad));
  const sw = Math.max(2, Math.min(1400, Math.round(bx2 - bx)));
  const sh = Math.max(2, Math.min(1400, Math.round(by2 - by)));

  const sheet = sheetOf(sw, sh);
  if (!sheet) return;
  const c = sheet.c;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, sw, sh);
  const sc = sheet.sc;
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.clearRect(0, 0, sw, sh);
  sc.setTransform(1, 0, 0, 1, -bx, -by);
  sc.lineJoin = 'round';
  sc.lineCap = 'round';
  c.setTransform(1, 0, 0, 1, -bx, -by);
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // The shell, one small quad at a time. Each quad is filled with the light of
  // its own normal, and every quad is grown a hair so the fills meet without a
  // seam of background between them.
  const tri: number[] = [];
  for (let k = 0; k < RING; k++) {
    for (let i = 0; i < SEG; i++) {
      const i2 = (i + 1) % SEG;
      const a0 = k * SEG + i,
        a1 = k * SEG + i2,
        a2 = (k + 1) * SEG + i2,
        a3 = (k + 1) * SEG + i;
      let nx = 0,
        ny = 0,
        nz = 0,
        av = 0;
      for (const q of [a0, a1, a2, a3]) {
        nx += vn[q * 3];
        ny += vn[q * 3 + 1];
        nz += vn[q * 3 + 2];
        av += ao[q];
      }
      const m = Math.hypot(nx, ny, nz) || 1;
      nx /= m;
      ny /= m;
      nz /= m;
      av /= 4;
      const cx = (xs[a0] + xs[a1] + xs[a2] + xs[a3]) / 4;
      const cyy = (ys[a0] + ys[a1] + ys[a2] + ys[a3]) / 4;
      sc.fillStyle = shellColour(nx, ny, nz, av);
      sc.beginPath();
      for (const q of [a0, a1, a2, a3]) {
        const dx = xs[q] - cx,
          dy = ys[q] - cyy;
        const d = Math.hypot(dx, dy) || 1;
        tri.push(xs[q] + (dx / d) * 0.5, ys[q] + (dy / d) * 0.5);
      }
      sc.moveTo(tri[0], tri[1]);
      sc.lineTo(tri[2], tri[3]);
      sc.lineTo(tri[4], tri[5]);
      sc.lineTo(tri[6], tri[7]);
      sc.closePath();
      sc.fill();
      tri.length = 0;
    }
  }

  // The lit shell, laid down inside the rim. The blur of a hair is what turns
  // the flat quads into a smooth surface; the rim stays a hard edge because
  // the clip is the rim itself.
  c.save();
  c.beginPath();
  for (let i = 0; i < SEG; i++) {
    const at = RING * SEG + i;
    if (i === 0) c.moveTo(xs[at], ys[at]);
    else c.lineTo(xs[at], ys[at]);
  }
  c.closePath();
  c.clip();
  c.filter = `blur(${Math.max(0.6, f.sx * 0.0035)}px)`;
  c.drawImage(sc.canvas, 0, 0, sw, sh, bx, by, sw, sh);
  c.filter = 'none';
  c.restore();

  // The paint is clipped to the shell and laid on the surface: a point of the
  // ink is lifted onto the same height field, so a stroke bends with the form.
  c.save();
  c.beginPath();
  for (let i = 0; i < SEG; i++) {
    const at = RING * SEG + i;
    if (i === 0) c.moveTo(xs[at], ys[at]);
    else c.lineTo(xs[at], ys[at]);
  }
  c.closePath();
  c.clip();
  paintMask(c, f);
  c.restore();

  // The eye holes are cut out of the shell, so the person's own eyes are seen
  // through them, and the wall round each hole keeps a dark edge.
  c.globalCompositeOperation = 'destination-out';
  for (const s of [-1, 1]) {
    holePath(c, f, s);
    c.fillStyle = '#000';
    c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  for (const s of [-1, 1]) {
    c.save();
    c.strokeStyle = 'rgba(10, 11, 14, 0.55)';
    c.lineWidth = Math.max(1, f.sx * 0.008);
    holePath(c, f, s);
    c.stroke();
    c.restore();
  }

  // The mask sits a little off the face, so it throws a shadow on the skin
  // and the eye holes hold the dark of the sockets.
  ctx.save();
  for (const s of [-1, 1]) {
    const q = holeShape(f, s);
    const cx = q[0],
      cyy = q[1],
      rr = q[2];
    const grad = ctx.createRadialGradient(cx, cyy, rr * 0.25, cx, cyy, rr * 1.75);
    grad.addColorStop(0, 'rgba(4, 6, 10, 0.55)');
    grad.addColorStop(1, 'rgba(4, 6, 10, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cyy, rr * 1.75, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowColor = 'rgba(3, 5, 9, 0.5)';
  ctx.shadowBlur = Math.max(4, f.sx * 0.06);
  ctx.shadowOffsetX = f.sx * 0.02;
  ctx.shadowOffsetY = f.sy * 0.035;
  ctx.drawImage(sheet.canvas, 0, 0, sw, sh, bx, by, sw, sh);
  ctx.restore();

  // A readout for the live page: add ?fawkesdebug to the address, and the mask
  // tells the turn it has and whether the mesh gave it a surface.
  if (typeof location !== 'undefined' && /[?&]fawkesdebug/.test(location.search)) {
    const mesh = f.form ? 'mesh' : 'dome';
    ctx.save();
    ctx.font = `600 ${Math.max(11, Math.round(f.sx * 0.05))}px monospace`;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillText(
      `yaw ${(f.yaw * 57.3).toFixed(0)}  pitch ${(f.pitch * 57.3).toFixed(0)}  ${mesh}  depth ${SHELL_DEPTH.toFixed(2)}`,
      Math.max(4, Math.round(f.ox - f.sx * 1.1)),
      Math.max(14, Math.round(f.oy + f.sy * 1.15)),
    );
    ctx.restore();
  }
}

// shellColour is the light of one quad: a soft ambient, the diffuse of the
// window light, a tight gloss on the plastic and a cool rim at the silhouette.
function shellColour(nx: number, ny: number, nz: number, a: number) {
  const ndl = nx * LX + ny * LY + nz * LZ;
  const diff = Math.max(0, ndl);
  const ndh = Math.max(0, nx * HX + ny * HY + nz * HZ);
  const spec = Math.pow(ndh, 40) * 1.05;
  const rim = Math.pow(clamp01(1 - nz), 3) * 0.3;
  const lit = (0.17 + 1.0 * diff) * a;
  const r = Math.min(255, Math.round(255 * (SHELL[0] * lit + spec + rim * 0.55)));
  const g = Math.min(255, Math.round(255 * (SHELL[1] * lit + spec + rim * 0.62)));
  const b = Math.min(255, Math.round(255 * (SHELL[2] * lit + spec + rim * 0.78)));
  return `rgb(${r},${g},${b})`;
}

// --------------------------------------------------------------- the pieces
// A stroke is a list of control points and a half width at each of them: the
// brush of the mask is thin at the tip and full at the root, so a stroke is a
// ribbon and not a line.
interface Stroke {
  pts: P2[];
  w: number[];
}

// catmull samples a smooth curve through the control points.
function catmull(pts: P2[], n: number) {
  const out: P2[] = [];
  const m = pts.length;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (m - 1);
    const i0 = Math.min(m - 2, Math.floor(t));
    const u = t - i0;
    const p0 = pts[Math.max(0, i0 - 1)],
      p1 = pts[i0],
      p2 = pts[i0 + 1],
      p3 = pts[Math.min(m - 1, i0 + 2)];
    const u2 = u * u,
      u3 = u2 * u;
    out.push([
      0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * u +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3),
      0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * u +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3),
    ]);
  }
  return out;
}

function widthAt(w: number[], t: number) {
  if (w.length === 1) return w[0];
  const x = t * (w.length - 1);
  const i = Math.min(w.length - 2, Math.floor(x));
  const u = x - i;
  return w[i] * (1 - u) + w[i + 1] * u;
}

// ribbon lays a tapered stroke on the surface: both edges of the brush are
// lifted onto the height field and projected, so it wraps and foreshortens.
function ribbon(c: CanvasRenderingContext2D, f: Fit, s: Stroke) {
  const n = Math.max(8, Math.ceil(s.pts.length * 6));
  const spine = catmull(s.pts, n);
  const left: P2[] = [],
    right: P2[] = [];
  const p: number[] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = spine[Math.max(0, i - 1)],
      b = spine[Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0],
      ty = b[1] - a[1];
    const m = Math.hypot(tx, ty) || 1;
    const nx = -ty / m,
      ny = tx / m;
    const w = widthAt(s.w, i / (n - 1));
    const x = spine[i][0],
      y = spine[i][1];
    const z = fawkesHeight(f, x, y, fawkesRho(x, y));
    project(f, x + nx * w, y + ny * w, z, p);
    left.push([p[0], p[1]]);
    project(f, x - nx * w, y - ny * w, z, p);
    right.push([p[0], p[1]]);
  }
  c.beginPath();
  c.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < n; i++) c.lineTo(left[i][0], left[i][1]);
  for (let i = n - 1; i >= 0; i--) c.lineTo(right[i][0], right[i][1]);
  c.closePath();
  c.fill();
}

// blend draws one ink shape with the light of the surface under it.
function inkFill(c: CanvasRenderingContext2D, f: Fit, path: () => void, cx: number, cy: number) {
  const e = 0.01;
  const gx = (fawkesHeight(f, cx + e, cy, 0.3) - fawkesHeight(f, cx - e, cy, 0.3)) / (2 * e);
  const gy = (fawkesHeight(f, cx, cy + e, 0.3) - fawkesHeight(f, cx, cy - e, 0.3)) / (2 * e);
  const nv: number[] = [0, 0, 0];
  const m = Math.hypot(gx, gy, 1);
  turn(f, -gx / m, -gy / m, 1 / m, nv);
  c.fillStyle = inkColour(nv[0], nv[1], nv[2]);
  c.beginPath();
  path();
  c.fill();
}

// holeShape is one eye hole in model space: its middle, its size and the
// radius the socket shadow needs.
function holeShape(f: Fit, s: number): P3 {
  const p: number[] = [0, 0, 0];
  const z = fawkesHeight(f, s * EYE_X, EYE_Y, fawkesRho(s * EYE_X, EYE_Y));
  project(f, s * EYE_X, EYE_Y, z, p);
  return [p[0], p[1], HOLE_BL * ((f.sx + f.sy) / 2)];
}

// holePoints is the outline of one eye hole, grown about its own middle.
function holePoints(f: Fit, s: number, grow: number) {
  const pts: P2[] = [];
  const p: number[] = [0, 0, 0];
  const cs = Math.cos(s * HOLE_TILT),
    sn = Math.sin(s * HOLE_TILT);
  for (let i = 0; i < 32; i++) {
    const th = (i / 32) * Math.PI * 2;
    const a = Math.cos(th) * HOLE_A * grow;
    const b = Math.sin(th) * (Math.sin(th) > 0 ? HOLE_BU : HOLE_BL) * grow;
    const x = s * EYE_X + a * cs - b * sn;
    const y = EYE_Y + a * sn + b * cs;
    const z = fawkesHeight(f, x, y, fawkesRho(x, y));
    project(f, x, y, z, p);
    pts.push([p[0], p[1]]);
  }
  return pts;
}

function holePath(c: CanvasRenderingContext2D, f: Fit, s: number, grow = 1) {
  const pts = holePoints(f, s, grow);
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
}

// The paint of the mask reads the face under it: the brows sit on the brows,
// the moustache under the nose, the grin on the mouth and the goatee above the
// chin, so a long face and a short one both carry a mask that fits.
function mouthSize(f: Fit) {
  const half = Math.abs(f.face.mouthR[0] - f.face.mouthL[0]) / 2;
  return Math.min(Math.max(half || 0.24, 0.17), 0.34);
}

function paintMask(c: CanvasRenderingContext2D, f: Fit) {
  const face = f.face;
  for (const s of [-1, 1]) {
    // The black edge round the eye hole, wider at the outer end.
    inkFill(c, f, () => holePath(c, f, s, 1.26), s * EYE_X, EYE_Y);
    // The brow: full over the nose, a fine point at the temple.
    const br = s < 0 ? face.browL : face.browR;
    inkFill(c, f, () => ribbon(c, f, BROW(f, s)), br[0], br[1]);
    // The moustache: a full root and a curl that turns up at the end.
    const mu = MUS(f, s);
    inkFill(c, f, () => ribbon(c, f, mu), mu.pts[1][0], mu.pts[1][1]);
    // The nostril, a small dark mark under the nose.
    const no = NOSTRIL(f, s);
    inkFill(c, f, () => ribbon(c, f, no), no.pts[1][0], no.pts[1][1]);
  }
  // The smile runs across the whole face, so it is one stroke.
  const sm = SMILE(f);
  inkFill(c, f, () => ribbon(c, f, sm), 0, sm.pts[5][1]);
  for (const s of [-1, 1]) {
    const cl = CHINLINE(f, s);
    inkFill(c, f, () => ribbon(c, f, cl), cl.pts[1][0], cl.pts[1][1]);
  }
  // The goatee is a filled point under the mouth.
  const goat = GOATEE(f);
  inkFill(
    c,
    f,
    () => {
      const pts = catmull(goat, 40);
      const p: number[] = [0, 0, 0];
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const z = fawkesHeight(f, pts[i][0], pts[i][1], fawkesRho(pts[i][0], pts[i][1]));
        project(f, pts[i][0], pts[i][1], z, p);
        if (i === 0) c.moveTo(p[0], p[1]);
        else c.lineTo(p[0], p[1]);
      }
      c.closePath();
    },
    0,
    goat[4][1],
  );
}

// BROW follows the eye under it and the brow the mesh found: it starts over the
// inner corner, runs over the eye and falls to the temple.
function BROW(f: Fit, s: number): Stroke {
  const eye = s < 0 ? [f.face.eyeLi, f.face.eyeLo] : [f.face.eyeRi, f.face.eyeRo];
  const brow = s < 0 ? f.face.browL : f.face.browR;
  const xi = eye[0][0],
    xo = eye[1][0];
  const pts: P2[] = [];
  for (const t of [0, 0.34, 0.68, 1.02, 1.45]) {
    const x = xi + (xo - xi) * t;
    const arc = 0.012 * Math.sin(Math.PI * Math.min(t, 1));
    const y = brow[1] + 0.01 + arc - 0.05 * Math.max(0, t - 1);
    pts.push([x, y]);
  }
  return { pts, w: [0.042, 0.038, 0.028, 0.016, 0.004] };
}

// MUS sits between the base of the nose and the top lip, and the curl turns up
// at the corner of the mouth.
function MUS(f: Fit, s: number): Stroke {
  const face = f.face;
  const mh = mouthSize(f);
  const k = mh / 0.24;
  const y0 = (face.noseBase[1] + face.lipTop[1]) / 2 + 0.01;
  return {
    pts: [
      [s * 0.008, y0],
      [s * mh * 0.35, y0 - 0.045],
      [s * mh * 0.62, y0 - 0.06],
      [s * mh * 0.85, y0 - 0.05],
      [s * mh * 0.98, y0 - 0.015],
      [s * mh * 1.06, y0 + 0.025],
    ],
    w: [0.034 * k, 0.032 * k, 0.026 * k, 0.018 * k, 0.01 * k, 0.004],
  };
}

// SMILE is the wide grin: the lowest point on the mouth and the corners lifted.
function SMILE(f: Fit): Stroke {
  const mh = mouthSize(f);
  const cy = f.face.lip[1] + 0.01;
  const xc = Math.min(0.34, mh * 1.15);
  const pts: P2[] = [];
  const w: number[] = [];
  const base = [0.005, 0.011, 0.014, 0.015, 0.016, 0.016, 0.016, 0.015, 0.014, 0.011, 0.005];
  const k = mh / 0.24;
  for (let i = 0; i < 11; i++) {
    const t = (i / 10) * 2 - 1;
    const u = Math.min(1, Math.abs(t));
    pts.push([t * xc, cy + 0.085 * u * u + 0.025 * Math.max(0, u - 0.8) * 5]);
    w.push(base[i] * k);
  }
  return { pts, w };
}

function NOSTRIL(f: Fit, s: number): Stroke {
  const nb = f.face.noseBase;
  return {
    pts: [
      [s * 0.024, nb[1] + 0.03],
      [s * 0.045, nb[1] + 0.018],
      [s * 0.066, nb[1] + 0.03],
    ],
    w: [0.005, 0.01, 0.004],
  };
}

// CHINLINE is the short crease beside the goatee.
function CHINLINE(f: Fit, s: number): Stroke {
  const mh = mouthSize(f);
  const low = f.face.lipLow[1];
  return {
    pts: [
      [s * mh * 0.3, low - 0.075],
      [s * mh * 0.34, low - 0.13],
      [s * mh * 0.36, low - 0.19],
    ],
    w: [0.007, 0.008, 0.003],
  };
}

// GOATEE hangs from the lower lip to the chin, as wide as a little more than
// half the mouth.
function GOATEE(f: Fit): P2[] {
  const mh = Math.min(mouthSize(f), 0.3);
  const low = f.face.lipLow[1];
  const tip = Math.min(f.face.chin[1] + 0.12, low - 0.16);
  const top = low - 0.09;
  const h1 = top - (top - tip) * 0.2;
  const h2 = top - (top - tip) * 0.66;
  const w0 = mh * 0.24;
  const w1 = mh * 0.3;
  const w2 = mh * 0.16;
  return [
    [0, top],
    [w0, top - (top - tip) * 0.06],
    [w1, h1],
    [w2, h2],
    [0, tip],
    [-w2, h2],
    [-w1, h1],
    [-w0, top - (top - tip) * 0.06],
    [0, top],
  ];
}

// ----------------------------------------------------------------- the sheet
// One offscreen canvas is reused, so a frame does not build a surface for the
// mask every time it moves.
let sheetCanvas: HTMLCanvasElement | null = null;
let shellCanvas: HTMLCanvasElement | null = null;

function sheetOf(w: number, h: number) {
  if (!sheetCanvas || !shellCanvas) {
    sheetCanvas = sheetCanvas || document.createElement('canvas');
    shellCanvas = shellCanvas || document.createElement('canvas');
  }
  if (sheetCanvas.width < w || sheetCanvas.height < h) {
    sheetCanvas.width = Math.max(sheetCanvas.width, w);
    sheetCanvas.height = Math.max(sheetCanvas.height, h);
    shellCanvas.width = sheetCanvas.width;
    shellCanvas.height = sheetCanvas.height;
  }
  const c = sheetCanvas.getContext('2d');
  const sc = shellCanvas.getContext('2d');
  if (!c || !sc) return null;
  return { canvas: sheetCanvas, c, sc };
}

// temporary lab handle
export const __dbg = { fawkesFit, flatModel, fawkesRho, BROW, MUS, SMILE, NOSTRIL, CHINLINE, GOATEE, mouthSize, project, fawkesHeight };
