/*
 Constant tables: the quality steps, the camera looks, the mask
 names, the face mesh rate and the room id alphabet.
*/

import { $ } from './dom.js';
import { bitrate } from './stats.js';

export const ROOM_RE = /^[a-z0-9._-]{1,64}$/;

export const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

// The performance slider trades the picture against bandwidth and compute in
// four steps. It works on top of the quality step above: step 0 is that step
// unchanged, the full quality path, and every later step sends fewer pixels
// from the camera itself, fewer frames and a lower bitrate ceiling. Sound is
// never touched, so a weak link or a weak machine thins the picture first.
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

// The look of the own camera. A colour step is a canvas filter, and a mask is
// drawn on the face patch that a small skin tone search finds. Both run in this
// tab before the frame is sealed: the other side needs nothing, and the camera
// keeps working, so its light stays on. One choice per guest, off by default.
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

export const MASKS = ['none', 'big', 'wide', 'small', 'glasses', 'moustache', 'cat', 'dog', 'halo', 'shades', 'miku', 'potion', 'custom'];

// The landmarker is three files of this origin: the module, the wasm and the
// model. Nothing of a face leaves the tab, and no byte comes from outside.
export const MESH_DIR = '/facemesh/';

// Its input is a small copy of the frame, wide enough for a mesh and small
// enough to run on a laptop without dropping the sent picture.
export const MESH_W = 256;

// The mesh runs on every painted frame, so its rate is the camera rate, and
// the clock below ticks at that rate as well. A machine that cannot hold it
// drops a frame instead of queueing one.
export const MESH_HZ_MIN = 5;

export const MESH_HZ_MAX = 60;

// The long side of the canvas. A camera step above this is scaled down before
// the look runs, so a filter never costs more pixels than it has to.
export const LOOK_MAX = 1280;
