/*
 The Guy Fawkes mask, modelled as a shell and rendered on the face.
*/

// The mask is one rigid white shell with a painted black face. It is built
// once in model units: across the face in face widths, up the face in face
// widths too, so a turn or a lean keeps its proportions. The model is fitted to
// the landmarks of the face it covers, so the eye holes sit on the eyes, the
// mouth line on the mouth and the chin on the chin, and the head carries it.

type P2 = [number, number];
type P3 = [number, number, number];

// Model anchors. The eye centres are the fit; the rest is the drawing.
const EYE_X = 0.152;
const EYE_Y = 0.045;
const CHIN_Y = -0.66;
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
  [
    [0, CHIN_Y],
    [0.075, -0.668],
    [0.235, -0.618],
    [0.35, -0.5],
  ],
  [
    [0.35, -0.5],
    [0.452, -0.385],
    [0.499, -0.16],
    [0.5, 0.03],
  ],
  [
    [0.5, 0.03],
    [0.499, 0.2],
    [0.455, 0.37],
    [0.373, 0.475],
  ],
  [
    [0.373, 0.475],
    [0.298, 0.567],
    [0.158, 0.604],
    [0, 0.6],
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
// fawkesRho is how far out a model point is, one at the rim: the mask sits on
// the face at its edge, so the shell is pushed back to nothing there.
function fawkesRho(x: number, y: number) {
  return Math.min(1, Math.hypot(x / 0.505, y / 0.665));
}

function gauss(d: number) {
  return Math.exp(-d * d);
}

// fawkesHeight is the surface of the mask in model units: a dome, the brow
// ridges, the nose, the cheekbones, the hollows under them and the chin. The
// lighting reads all of it, so the form is a shape and not a shading trick.
function fawkesHeight(x: number, y: number, rho: number) {
  const ax = x / 0.72,
    by = (y + 0.02) / 0.95;
  const r2 = ax * ax + by * by;
  let z = r2 < 1 ? 0.145 * Math.sqrt(1 - r2) : 0;

  // Brow ridges: an arc that rises off the nose and falls to the temple.
  const u = Math.abs(x);
  if (u > 0.03 && u < 0.38) {
    const yc = 0.158 + 1.282 * u - 3.16 * u * u;
    z += 0.078 * gauss((y - yc) / 0.042) * ramp(0.03, 0.09, u) * ramp(0.39, 0.3, u);
  }
  // The nose: a ridge that widens down to the tip, with a round tip.
  if (y > -0.08 && y < 0.27) {
    const w = 0.022 + 0.058 * ramp(0.27, -0.05, y);
    z += 0.175 * gauss(x / w) * ramp(0.27, 0.18, y) * ramp(-0.08, 0.0, y);
    z += 0.05 * gauss(x / 0.07) * gauss((y + 0.03) / 0.045);
    // The wings of the nose, and the crease between them and the cheek.
    z += 0.022 * gauss((Math.abs(x) - 0.058) / 0.028) * gauss((y + 0.045) / 0.03);
    z -= 0.018 * gauss((Math.abs(x) - 0.088) / 0.026) * gauss((y + 0.035) / 0.035);
  }
  // Cheekbones, and the hollows under them.
  z += 0.03 * gauss((x - 0.29) / 0.17) * gauss(y / 0.14);
  z += 0.03 * gauss((x + 0.29) / 0.17) * gauss(y / 0.14);
  z -= 0.028 * gauss((x - 0.25) / 0.13) * gauss((y + 0.21) / 0.12);
  z -= 0.028 * gauss((x + 0.25) / 0.13) * gauss((y + 0.21) / 0.12);
  // The eye sockets are cut back, so a hole has a wall round it.
  for (const s of [-1, 1]) {
    z -= 0.075 * gauss((x - s * EYE_X) / 0.135) * gauss((y - EYE_Y) / 0.085);
  }
  // The chin is a small point under the goatee.
  z += 0.05 * gauss(x / 0.07) * gauss((y + 0.5) / 0.1);
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
}

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
  let sy = down > 1 ? down / (EYE_Y - CHIN_Y) : fh * 0.75;
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

  return { ox: o[0], oy: o[1], ax, ay, sx, sy, yaw, pitch };
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
      const z = fawkesHeight(x, y, rho);
      const e = 0.006;
      const gx = (fawkesHeight(x + e, y, rho) - fawkesHeight(x - e, y, rho)) / (2 * e);
      const gy = (fawkesHeight(x, y + e, rho) - fawkesHeight(x, y - e, rho)) / (2 * e);
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
      a -= 0.14 * ramp(0.74, 1, rho);
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
    const z = fawkesHeight(x, y, fawkesRho(x, y));
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
  const gx = (fawkesHeight(cx + e, cy, 0.3) - fawkesHeight(cx - e, cy, 0.3)) / (2 * e);
  const gy = (fawkesHeight(cx, cy + e, 0.3) - fawkesHeight(cx, cy - e, 0.3)) / (2 * e);
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
  const z = fawkesHeight(s * EYE_X, EYE_Y, fawkesRho(s * EYE_X, EYE_Y));
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
    const z = fawkesHeight(x, y, fawkesRho(x, y));
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

// The painted face: the brows, the black edge of the eye holes, the moustache,
// the wide smile with a curl at each end, the goatee and the nostrils.
function paintMask(c: CanvasRenderingContext2D, f: Fit) {
  for (const s of [-1, 1]) {
    // The black edge round the eye hole, wider at the outer end.
    inkFill(c, f, () => holePath(c, f, s, 1.26), s * EYE_X, EYE_Y);
    // The brow: full over the nose, a fine point at the temple.
    inkFill(c, f, () => ribbon(c, f, BROW(s)), s * 0.19, 0.21);
    // The moustache: a full root and a curl that turns up at the end.
    inkFill(c, f, () => ribbon(c, f, MUS(s)), s * 0.12, -0.28);
    // The nostril, a small dark mark under the nose.
    inkFill(c, f, () => ribbon(c, f, NOSTRIL(s)), s * 0.035, -0.06);
  }
  // The smile runs across the whole face, so it is one stroke.
  inkFill(c, f, () => ribbon(c, f, SMILE), 0, -0.4);
  for (const s of [-1, 1]) {
    inkFill(c, f, () => ribbon(c, f, CHINLINE(s)), s * 0.085, -0.51);
  }
  // The goatee is a filled point under the mouth.
  inkFill(
    c,
    f,
    () => {
      const pts = catmull(GOATEE, 40);
      const p: number[] = [0, 0, 0];
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const z = fawkesHeight(pts[i][0], pts[i][1], fawkesRho(pts[i][0], pts[i][1]));
        project(f, pts[i][0], pts[i][1], z, p);
        if (i === 0) c.moveTo(p[0], p[1]);
        else c.lineTo(p[0], p[1]);
      }
      c.closePath();
    },
    0,
    -0.52,
  );
}

function BROW(s: number): Stroke {
  return {
    pts: [
      [s * 0.05, 0.202],
      [s * 0.135, 0.248],
      [s * 0.225, 0.256],
      [s * 0.305, 0.235],
      [s * 0.358, 0.207],
    ],
    w: [0.041, 0.039, 0.03, 0.017, 0.004],
  };
}

function MUS(s: number): Stroke {
  return {
    pts: [
      [s * 0.006, -0.212],
      [s * 0.08, -0.244],
      [s * 0.16, -0.272],
      [s * 0.228, -0.276],
      [s * 0.268, -0.252],
      [s * 0.283, -0.219],
    ],
    w: [0.034, 0.033, 0.028, 0.021, 0.012, 0.004],
  };
}

const SMILE: Stroke = {
  pts: [
    [-0.238, -0.336],
    [-0.272, -0.376],
    [-0.256, -0.424],
    [-0.196, -0.45],
    [-0.1, -0.462],
    [0, -0.464],
    [0.1, -0.462],
    [0.196, -0.45],
    [0.256, -0.424],
    [0.272, -0.376],
    [0.238, -0.336],
  ],
  w: [0.005, 0.011, 0.014, 0.015, 0.016, 0.016, 0.016, 0.015, 0.014, 0.011, 0.005],
};

function NOSTRIL(s: number): Stroke {
  return {
    pts: [
      [s * 0.022, -0.055],
      [s * 0.04, -0.062],
      [s * 0.056, -0.052],
    ],
    w: [0.005, 0.01, 0.004],
  };
}

function CHINLINE(s: number): Stroke {
  return {
    pts: [
      [s * 0.05, -0.49],
      [s * 0.076, -0.528],
      [s * 0.083, -0.572],
    ],
    w: [0.007, 0.008, 0.003],
  };
}

const GOATEE: P2[] = [
  [0, -0.478],
  [0.056, -0.5],
  [0.072, -0.538],
  [0.038, -0.578],
  [0, -0.63],
  [-0.038, -0.578],
  [-0.072, -0.538],
  [-0.056, -0.5],
  [0, -0.478],
];

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
