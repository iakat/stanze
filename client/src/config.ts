/*
 Constant tables: the quality and performance steps, the camera looks, the
 mask names, the face mesh rate and the room id alphabet.
*/

export const ROOM_RE = /^[a-z0-9._-]{1,64}$/;

export const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

// The performance slider trades picture against bandwidth and compute in four
// steps, on top of the quality step: each later step sends fewer pixels from the
// camera itself, fewer frames and a lower bitrate ceiling. Sound is never touched.
export const PERF = [
  { name: 'full quality', scale: 1, fps: 0, bits: 1 },
  { name: 'balanced', scale: 0.75, fps: 24, bits: 0.6 },
  { name: 'light', scale: 0.5, fps: 20, bits: 0.35 },
  { name: 'minimum', scale: 0.35, fps: 15, bits: 0.18 },
];

export const QUALITY = {
  '640x360@30': { w: 640, h: 360, fps: 30, max: 400000 },
  '1280x720@30': { w: 1280, h: 720, fps: 30, max: 1500000 },
  '1920x1080@30': { w: 1920, h: 1080, fps: 30, max: 3000000 },
  '1920x1080@60': { w: 1920, h: 1080, fps: 60, max: 5000000 },
  '2560x1440@30': { w: 2560, h: 1440, fps: 30, max: 6000000 },
};

// A colour step is a canvas filter, a mask is drawn on the face patch that a
// small skin tone search finds. Both run in this tab before the frame is sealed:
// the other side needs nothing and the camera light stays on.
/** @type {Record<string, string>} */

export const LOOKS = {
  none: '',
  soft: 'brightness(1.05) contrast(0.97) saturate(1.03) blur(0.5px)',
  warm: 'saturate(1.15) sepia(0.18) brightness(1.04)',
  cool: 'saturate(1.06) hue-rotate(-10deg) brightness(1.02)',
  mono: 'grayscale(1) contrast(1.06)',
  sepia: 'sepia(0.85) contrast(1.04)',
  vivid: 'saturate(1.4) contrast(1.08)',
};
/** @type {string[]} */

export const MASKS = [
  'none',
  'big',
  'wide',
  'small',
  'glasses',
  'moustache',
  'cat',
  'dog',
  'halo',
  'shades',
  'miku',
  'fawkes',
  'potion',
  'custom',
];

// The landmarker: module, wasm and model from this origin, so no face leaves
// the tab and no byte comes from outside.
export const MESH_DIR = '/facemesh/';

// A small copy of the frame is the mesh input: wide enough for a mesh, cheap
// enough to keep the sent picture running on a laptop.
export const MESH_W = 256;

// The mesh runs on every painted frame, so its rate is the camera rate and the
// clock ticks at that rate too. A slow machine drops a frame instead of queueing.
export const MESH_HZ_MIN = 5;

export const MESH_HZ_MAX = 60;

// The long side of the look canvas. A larger camera step is scaled down before
// the look runs, so a filter never costs more pixels than it has to.
export const LOOK_MAX = 1280;
