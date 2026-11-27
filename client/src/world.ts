/*
 The world: a Tiled map drawn on canvas, its collision grid, its zones, the
 spawn of a guest, the walking avatar of this page, and the canvas view that
 draws all of it. Every guest picks one of the sheets the
 asset folder ships, and the page draws an avatar for that sheet. The fallback
 face is drawn in the page, so a tree without a sheet still walks.
*/

import { ROOM_RE } from './config.js';
import { load, store } from './prefs.js';
import { Zone, ZoneGrid, ZONE_CLASS, zoneList } from './zones.js';

// The geometry of the shipped art, as frozen in docs/WORLD_CONTRACT.md §3: the
// sheet on disk wins over any report written about it.
export const TILE = 32;
// One avatar cell, and where its feet are drawn: the bottom of the cell.
export const CHAR_W = 32;
export const CHAR_H = 32;
export const CHAR_ORIGIN_Y = 32;
export const CHAR_LAYERS = 4;
// The sheet is 4 rows top to bottom: S (front), W (side), E (side), N (back).
// A runtime direction is 0=down, 1=left, 2=right, 3=up.
const SHEET_ROW = [0, 1, 2, 3];
// Columns left to right are walk 0, walk 1, walk 2, idle. The walk ping-pongs,
// because 0,1,2 is a hobble.
const IDLE_FRAME = 3;
const WALK_ORDER = [0, 1, 2, 1];
const CHAR_FPS = 10;
export const CHAR_MOVE_MS = 1000 / CHAR_FPS;
export const WALK_SPEED = 200;
// An avatar's depth is its foot, and two avatars are told apart by it.
export const AVATAR_SORT_OFFSET = 0;
// The hit box of an avatar: its lower half, so a head overlaps the wall behind
// it and a wall stops a footstep at the foot, not at the scalp.
const BODY_W = 20;
const BODY_H = 16;
const BODY_BASE = 2;

// The four facings, in the order a position frame carries them.
export const DIR = ['down', 'left', 'right', 'up'];

// The edge strip: a band of one avatar cell along the four edges of the window,
// holding a marker per guest the camera does not hold. A guest is thus always
// on screen and always named, however far the map carries them; the marker
// says which edge, and an arrow under it says which way that guest lies.
export const EDGE = CHAR_W;
// EDGE_INSET is how far from the rim a marker sits, in screen pixels.
const EDGE_INSET = 3;
// EDGE_GAP is the room between two markers of one edge.
const EDGE_GAP = 4;

export type World = {
  room: string;
  widthPx: number;
  heightPx: number;
  tiles: HTMLCanvasElement;
  walls: HTMLCanvasElement;
  collision(x: number, y: number): boolean;
  zones: Zone[];
  zoneAt(x: number, y: number): Zone[];
  startPoint(): { x: number; y: number };
  images: Map<string, HTMLImageElement>;
};

type TileSet = {
  firstgid: number;
  columns: number;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
  image: HTMLImageElement;
};

// One character sheet: the cell size, and per facing the column of the idle
// cell and the columns of the walk cycle, in the sheet's own row order or in
// the runtime order, depending on who filled it.
export type CharSheet = {
  image: HTMLImageElement;
  cellW: number;
  cellH: number;
  idle: Record<string, number>;
  walk: Record<string, number[]>;
  columns: number;
};

// ---------------------------------------------------------------- loading
function loadImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => (signal && signal.aborted ? reject(new Error('aborted')) : resolve(image));
    image.onerror = () => reject(new Error('image failed: ' + src));
    image.src = src;
  });
}

async function loadJSON(src: string, signal?: AbortSignal, optional = false): Promise<any> {
  let res: Response;
  try {
    res = await fetch(src, { signal, credentials: 'same-origin' });
  } catch {
    if (optional) return null;
    throw new Error('fetch failed: ' + src);
  }
  if (!res.ok) {
    if (optional && res.status === 404) return null;
    throw new Error(res.status + ': ' + src);
  }
  return res.json();
}

// gidOf is the tile id of one map cell: the flip bits live in the top three
// bits and are not part of the tileset index.
function gidOf(cell: number): number {
  return cell & 0x1fffffff;
}

// isWallLayer names the layers that both collide and stand as walls: the
// README of the assets says which one is the walls layer.
function isWallLayer(layer: any): boolean {
  return layer && layer.type === 'tilelayer' && /wall|collide|block/i.test(String(layer.name || ''));
}

function walkLayers(list: any[], tiles: any[], objects: any[]) {
  for (const layer of list || []) {
    if (!layer) continue;
    if (layer.type === 'group' && Array.isArray(layer.layers)) {
      walkLayers(layer.layers, tiles, objects);
      continue;
    }
    if (layer.type === 'tilelayer' && (Array.isArray(layer.data) || typeof layer.data === 'string')) tiles.push(layer);
    if (layer.type === 'objectgroup' && Array.isArray(layer.objects)) objects.push(layer);
  }
}

// layerData is the gid array of one tile layer. Tiled saves a layer as a list
// of gids or, which is its default, as base64 of gzip, zlib or raw bytes; both
// forms are read, and a layer whose bytes do not open is empty rather than a
// failed join.
async function layerData(layer: any): Promise<number[]> {
  if (Array.isArray(layer.data)) return layer.data;
  const raw = typeof layer.data === 'string' ? layer.data : '';
  const enc = String(layer.encoding || 'base64');
  const comp = String(layer.compression || '');
  if (!raw || enc !== 'base64') return [];
  let plain: Uint8Array;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    plain = comp ? await inflate(bytes, comp) : bytes;
  } catch {
    return [];
  }
  const out: number[] = [];
  for (let i = 0; i + 3 < plain.length; i += 4) {
    out.push((plain[i] | (plain[i + 1] << 8) | (plain[i + 2] << 16) | (plain[i + 3] << 24)) >>> 0);
  }
  return out;
}

// inflate opens the bytes of a compressed layer with the browser's own
// decompressor. An unknown compression throws, and the layer reads empty.
async function inflate(bytes: Uint8Array, comp: string): Promise<Uint8Array> {
  if (comp !== 'gzip' && comp !== 'zlib') throw new Error('compression ' + comp);
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error('no decompressor');
  const stream = new Blob([bytes as any]).stream().pipeThrough(new DS(comp === 'gzip' ? 'gzip' : 'deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// polygonRects rasterises a Tiled polygon into axis aligned rows of one tile
// height. It runs once per load.
function polygonRects(obj: any, points: any[]): { x: number; y: number; w: number; h: number }[] {
  const xs = points.map((p) => Number(p.x)).filter(Number.isFinite);
  const ys = points.map((p) => Number(p.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return [];
  const ox = Number(obj.x) || 0;
  const oy = Number(obj.y) || 0;
  const y0 = Math.floor(Math.min(...ys) + oy);
  const y1 = Math.ceil(Math.max(...ys) + oy);
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (let y = y0; y < y1; y += TILE) {
    const h = Math.min(TILE, y1 - y);
    const mid = y + h / 2;
    const hits: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const ya = Number(a.y) + oy;
      const yb = Number(b.y) + oy;
      if (ya === yb) continue;
      if ((mid >= ya && mid < yb) || (mid >= yb && mid < ya)) {
        const xa = Number(a.x) + ox;
        const xb = Number(b.x) + ox;
        hits.push(xa + ((mid - ya) / (yb - ya)) * (xb - xa));
      }
    }
    hits.sort((p, q) => p - q);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const x = Math.round(hits[i]);
      const w = Math.round(hits[i + 1]) - x;
      if (w > 0) rects.push({ x, y, w, h });
    }
  }
  return rects;
}

// zoneObjects turns the object layers into the zone list: an object whose
// class is zone (or area, the older word) and its property bag. The shipped
// map writes label and maxUsers; the runtime reads name and capacity, so the
// author words are mapped here and nowhere else. A property with no WorkAdventure
// equivalent is ignored.
function zoneObjects(objects: any[]): any[] {
  const out: any[] = [];
  for (const layer of objects) {
    for (const obj of layer.objects) {
      if (!obj || (obj.class !== ZONE_CLASS && obj.class !== 'area')) continue;
      const props: Record<string, any> = {};
      for (const p of obj.properties || []) if (p && p.name) props[p.name] = p.value;
      let rects: { x: number; y: number; w: number; h: number }[];
      const shape = obj.polygon || obj.polyline;
      if (Array.isArray(shape) && shape.length > 1) rects = polygonRects(obj, shape);
      else rects = [{ x: Math.round(obj.x), y: Math.round(obj.y), w: Math.round(obj.width), h: Math.round(obj.height) }];
      out.push({
        id: obj.name,
        name: props.label || props.name || obj.name,
        // The property bag of a Tiled zone is {kind, proximity, maxUsers}; the
        // runtime form is {kind, proximity, capacity}, and without these lines
        // a meeting room is a plain area that carries no talk.
        kind: String(props.kind || ''),
        proximity: props.proximity,
        capacity: props.maxUsers !== undefined ? props.maxUsers : props.capacity,
        rects,
      });
    }
  }
  return out;
}

// spawn is the WorkAdventure ladder: the start object of the map, with ten
// random draws inside its rect that avoid the walls; then the centre of the
// map, then tile (1,1).
function spawn(
  start: { x: number; y: number; w: number; h: number } | null,
  blocked: Uint8Array,
  w: number,
  h: number,
  tw: number,
  th: number,
): { x: number; y: number } {
  const free = (x: number, y: number) => !bodyBlocked(blocked, w, h, tw, th, x, y);
  if (start && start.w > 0 && start.h > 0) {
    for (let draw = 0; draw < 10; draw++) {
      const x = start.x + 8 + Math.random() * Math.max(1, start.w - 16);
      const y = start.y + 8 + Math.random() * Math.max(1, start.h - 16);
      if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  const centre = { x: Math.round(w * tw / 2), y: Math.round(h * th / 2) };
  if (free(centre.x, centre.y)) return centre;
  return { x: Math.round(tw * 1.5), y: Math.round(th * 1.5) };
}

// mapPath is the one room to one map rule of §5: a room with a map of its own
// gets it, and every other room walks the default office, the way a WorkAdventure
// deployment serves its one world to every room. A map is geometry and zones;
// it carries no guest and no position, so two rooms on one map leak nothing.
export function mapPath(room: string): string {
  return room === '' ? '/world/map.json' : '/world/maps/' + room + '.json';
}

// DEFAULT_MAP is the map of a room that ships none.
const DEFAULT_MAP = '/world/map.json';

// atlasFrames reads the shipped atlas.json: a named rectangle per tile, which
// is how a map whose gids are named cells is drawn. The file the assets ship
// keys its frames by tile name, and a Tiled export keys them by gid; both are
// read. A numeric key is its own gid. A name gets no gid at all: a map of a
// Tiled export carries numeric gids, and numbering a named atlas by position
// drew the first cell of that atlas under every gid 1, 2, 3 of the map, so the
// picture and the map disagreed and the floor came out as junk (the tiles that
// looked broken). A name is only usable by a map that names its cells, which
// is not the kind of map this tree ships, so the Tiled tileset path is the one
// that draws the export. It answers an empty map when the file is not there.
async function atlasFrames(signal?: AbortSignal): Promise<{ image: string; frames: Map<number, any> } | null> {
  const raw = await loadJSON('/world/atlas.json', signal, true);
  if (!raw || typeof raw !== 'object' || !raw.image) return null;
  const frames = new Map<number, any>();
  const list = raw.frames && typeof raw.frames === 'object' ? raw.frames : {};
  for (const [key, value] of Object.entries(list)) {
    if (!value || typeof value !== 'object') continue;
    const one: any = value;
    // Only a numeric key is a gid. A named cell has no gid this map could
    // name, and a position in the sheet is not an identity.
    const num = Number(key);
    if (key.trim() === '' || !Number.isSafeInteger(num) || num < 1) continue;
    // A cell may be given as a grid position, the way the sheet is built, or
    // as the pixel rect a Tiled export writes; the rect wins when both.
    let x = Math.floor(Number(one.x));
    let y = Math.floor(Number(one.y));
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && Number.isFinite(Number(one.col)) && Number.isFinite(Number(one.row))) {
      const g = Math.max(0, Math.floor(Number(raw.gutter)) || 0);
      x = g + Math.floor(Number(one.col)) * (TILE + g);
      y = g + Math.floor(Number(one.row)) * (TILE + g);
    }
    const w = Math.floor(Number(one.w)) || TILE;
    const h = Math.floor(Number(one.h)) || TILE;
    if (![x, y, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) continue;
    frames.set(num, { x, y, w, h });
  }
  return { image: String(raw.image), frames };
}

// loadWorld fetches the map of one room, its zone sidecar, every tileset it
// names and the atlas. The room is checked against ROOM_RE first, so a room id
// can never name a file outside /world/.
export async function loadWorld(room: string, signal?: AbortSignal): Promise<World> {
  if (!ROOM_RE.test(room)) throw new Error('bad room name');
  const base = '/world/';
  const own = mapPath(room);
  let map = await loadJSON(own, signal, own !== DEFAULT_MAP);
  if (!map && own !== DEFAULT_MAP) map = await loadJSON(DEFAULT_MAP, signal);
  if (!map || typeof map !== 'object') throw new Error('no map for ' + room);
  const width = Math.max(1, Math.floor(Number(map.width)) || 1);
  const height = Math.max(1, Math.floor(Number(map.height)) || 1);
  const tw = Math.max(1, Math.floor(Number(map.tilewidth)) || TILE);
  const th = Math.max(1, Math.floor(Number(map.tileheight)) || TILE);

  const tiles: any[] = [];
  const objects: any[] = [];
  walkLayers(Array.isArray(map.layers) ? map.layers : [], tiles, objects);

  // A Tiled map names its external tilesets relative to its own file, not to
  // the world folder: a map at /world/maps/room.json says tilesets/x.tsj and
  // means /world/maps/tilesets/x.tsj. Resolving against base 404s every
  // tileset, the layers then have no image to draw and the room comes up as a
  // black field the avatar walks on (the collision grid is built from layer
  // names, so walls still stop it). roomBase is the folder of the map file.
  const roomBase = own.slice(0, own.lastIndexOf('/') + 1);

  // The sidecar is the authored zone list; the object layer of the map is the
  // other legal source and comes second.
  const sidecar = await loadJSON(room === '' ? '' : base + 'maps/' + room + '.zones.json', signal, true);
  const fromSidecar = sidecar && Array.isArray(sidecar.zones) ? sidecar.zones : [];
  const zones = zoneList(fromSidecar.length ? fromSidecar : zoneObjects(objects));
  // The spawn is the point object named spawn, the way a Tiled map carries one.
  let startRect: { x: number; y: number; w: number; h: number } | null = null;
  for (const layer of objects) {
    for (const obj of layer.objects || []) {
      if (!obj || String(obj.name || '').toLowerCase() !== 'spawn') continue;
      startRect = {
        x: Math.round(Number(obj.x) || 0),
        y: Math.round(Number(obj.y) || 0),
        w: Math.round(Number(obj.width) || 0),
        h: Math.round(Number(obj.height) || 0),
      };
      break;
    }
    if (startRect) break;
  }

  // Every image is loaded once, keyed by its path, so two tilesets that share
  // one sheet cost one request.
  const images = new Map<string, HTMLImageElement>();
  const image = async (path: string) => {
    const src = path.startsWith('/') ? path : base + path.replace(/^\.\//, '');
    let found = images.get(src);
    if (!found) {
      found = await loadImage(src, signal);
      images.set(src, found);
    }
    return found;
  };

  // An external tileset is the normal Tiled authoring: the map names a .tsj or
  // a .tsx and the tiles live in that file. It is read here so the map draws
  // whatever an author saved, and a file that does not load leaves the map a
  // floor of nothing rather than a failed join.
  const tilesets: any[] = [];
  for (const raw of Array.isArray(map.tilesets) ? map.tilesets : []) {
    if (raw && raw.source) {
      const src = String(raw.source);
      const path = src.startsWith('/') ? src : roomBase + src.replace(/^\.\//, '');
      const body = await loadJSON(path, signal, true);
      if (body && typeof body === 'object') {
        // The image of the file is a path beside it, never beside the map.
        const here = path.slice(0, path.lastIndexOf('/') + 1);
        const pic = typeof body.image === 'string' ? body.image : '';
        const abs = !pic ? '' : pic.startsWith('/') ? pic : here + pic.replace(/^\.\//, '');
        tilesets.push({ ...body, firstgid: raw.firstgid, image: abs });
      }
      continue;
    }
    tilesets.push(raw);
  }

  const sets: TileSet[] = [];
  for (const raw of tilesets) {
    if (!raw || !raw.image) continue;
    const firstgid = Math.floor(Number(raw.firstgid));
    if (!Number.isSafeInteger(firstgid) || firstgid < 1) continue;
    sets.push({
      firstgid,
      columns: Math.max(1, Math.floor(Number(raw.columns)) || 1),
      tileWidth: Math.max(1, Math.floor(Number(raw.tilewidth)) || tw),
      tileHeight: Math.max(1, Math.floor(Number(raw.tileheight)) || th),
      margin: Math.max(0, Math.floor(Number(raw.margin)) || 0),
      spacing: Math.max(0, Math.floor(Number(raw.spacing)) || 0),
      // A tileset image is a path beside its own file, so an external file
      // keeps the folder it came from.
      image: await image(raw.image ? String(raw.image) : ''),
    });
  }

  // The named atlas is the shipped way to draw a cell: a gid is a small number
  // naming a frame, and the atlas says where that frame stands. A map without
  // a matching frame falls through to its Tiled tileset.
  const atlas = await atlasFrames(signal);
  let atlasImage: HTMLImageElement | null = null;
  if (atlas && atlas.frames.size) {
    try {
      atlasImage = await image(atlas.image);
    } catch {
      atlasImage = null;
    }
  }

  // The collides property is declared on a tileset tile, as a property or as
  // the newer class of the same name.
  const flags = new Set<number>();
  for (const set of tilesets) {
    const firstgid = Math.floor(Number(set && set.firstgid)) || 1;
    for (const tile of (set && Array.isArray(set.tiles) && set.tiles) || []) {
      if (!tile) continue;
      const props = Array.isArray(tile.properties) ? tile.properties : [];
      const hit =
        tile.class === 'collides' ||
        props.some((p) => p && p.name === 'collides' && (p.value === true || p.value === 'true'));
      if (hit) flags.add(firstgid + Math.floor(Number(tile.id) || 0));
    }
  }

  const px = width * tw;
  const py = height * th;
  const floor = document.createElement('canvas');
  floor.width = px;
  floor.height = py;
  const fctx = floor.getContext('2d');
  const wallCanvas = document.createElement('canvas');
  wallCanvas.width = px;
  wallCanvas.height = py;
  const wctx = wallCanvas.getContext('2d');
  if (!fctx || !wctx) throw new Error('no 2d context');
  fctx.imageSmoothingEnabled = false;
  wctx.imageSmoothingEnabled = false;

  // The collision grid is built once: a wall layer collides whole, and a tile
  // on any layer collides when its tileset tile says so.
  const blocked = new Uint8Array(width * height);

  const paint = (target: CanvasRenderingContext2D, layer: any, data: number[]) => {
    const opacity = layer.opacity === undefined ? 1 : Number(layer.opacity);
    const alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    const cells = Math.min(data.length, width * height);
    for (let i = 0; i < cells; i++) {
      const gid = gidOf(Number(data[i]) || 0);
      if (!gid) continue;
      const dx = (i % width) * tw;
      const dy = Math.floor(i / width) * th;
      target.globalAlpha = alpha;
      const frame = atlasImage && atlas && atlas.frames.size ? atlas.frames.get(gid) || null : null;
      if (frame) {
        target.drawImage(atlasImage as HTMLImageElement, frame.x, frame.y, frame.w, frame.h, dx, dy, tw, th);
        continue;
      }
      let set: TileSet | null = null;
      for (const one of sets) if (gid >= one.firstgid && (!set || one.firstgid > set.firstgid)) set = one;
      if (!set) continue;
      const index = gid - set.firstgid;
      const sx = set.margin + (index % set.columns) * (set.tileWidth + set.spacing);
      const sy = set.margin + Math.floor(index / set.columns) * (set.tileHeight + set.spacing);
      target.drawImage(set.image, sx, sy, set.tileWidth, set.tileHeight, dx, dy, tw, th);
    }
    target.globalAlpha = 1;
  };

  for (const layer of tiles) {
    const data = await layerData(layer);
    const wall = isWallLayer(layer);
    const cells = Math.min(data.length, width * height);
    for (let i = 0; i < cells; i++) {
      const gid = gidOf(Number(data[i]) || 0);
      if (!gid) continue;
      if (wall || flags.has(gid)) blocked[i] = 1;
    }
    // A hidden layer collides like a shown one: it is the usual way a map
    // keeps an invisible collision layer.
    if (layer.visible === false) continue;
    paint(wall ? wctx : fctx, layer, data);
  }

  const grid = new ZoneGrid(zones);
  return {
    room,
    widthPx: px,
    heightPx: py,
    tiles: floor,
    walls: wallCanvas,
    collision(x: number, y: number) {
      return bodyBlocked(blocked, width, height, tw, th, x, y);
    },
    zones,
    zoneAt(x: number, y: number) {
      return grid.at(x, y);
    },
    startPoint() {
      return spawn(startRect, blocked, width, height, tw, th);
    },
    images,
  };
}

// bodyBlocked tests the corners of an avatar's footer against the grid, so a
// wall stops a footstep and a corner of a wall is never walked into.
export function bodyBlocked(
  blocked: Uint8Array,
  width: number,
  height: number,
  tileW: number,
  tileH: number,
  x: number,
  y: number,
): boolean {
  const left = x - BODY_W / 2;
  const right = x + BODY_W / 2;
  const top = y - BODY_BASE - BODY_H;
  const bottom = y - BODY_BASE;
  const probe = (px: number, py: number) => {
    const cx = Math.floor(px / tileW);
    const cy = Math.floor(py / tileH);
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return true;
    return blocked[cy * width + cx] === 1;
  };
  return probe(left, top) || probe(right, top) || probe(left, bottom) || probe(right, bottom) || probe(x, bottom);
}

// AVATARS is the pick WorkAdventure offers before a guest walks: a small list
// of sheets, and the one the page keeps under index. The list is what the
// asset folder ships, so a tree with more sheets needs only this row.
export const AVATARS = [
  { name: 'pipoya 1', image: '/world/avatars/player-1.png' },
  { name: 'pipoya 2', image: '/world/avatars/player-2.png' },
  { name: 'pipoya 3', image: '/world/avatars/player-3.png' },
  { name: 'pipoya 4', image: '/world/avatars/player-4.png' },
] as const;

// avatarIndex is the sheet this page picked, kept between visits.
export function avatarIndex(): number {
  const raw = parseInt(load('avatar') || '0', 10);
  return Number.isInteger(raw) && raw >= 0 && raw < AVATARS.length ? raw : 0;
}

export function setAvatar(index: number) {
  const n = Math.max(0, Math.min(AVATARS.length - 1, Math.floor(Number(index) || 0)));
  store('avatar', String(n));
}

// sheetOf reads one 96 x 128 sheet: three walk cells and no idle cell, four
// rows top to bottom. The idle is the first cell of the row and the walk is the
// three in a ping pong, so the sheet needs no padded column.
function sheetOf(image: HTMLImageElement): CharSheet {
  const idle: Record<string, number> = {};
  const walk: Record<string, number[]> = {};
  for (const dir of DIR) {
    idle[dir] = 0;
    walk[dir] = [0, 1, 2, 1];
  }
  return { image, cellW: CHAR_W, cellH: CHAR_H, idle, walk, columns: 3 };
}

// loadSheets reads every sheet of the pick once. A sheet that does not load is
// left out of the pick, so a guest is never given a blank avatar.
export async function loadSheets(signal?: AbortSignal): Promise<CharSheet[]> {
  const out: CharSheet[] = [];
  for (const one of AVATARS) {
    try {
      out.push(sheetOf(await loadImage(one.image, signal)));
    } catch {
      // The next sheet of the list is the fallback.
    }
  }
  if (!out.length) out.push(defaultSheet());
  return out;
}

// sheetFor answers the sheet of one guest: this page picked one, and a remote
// is given one by the last word of its peer id, so two guests rarely match and
// the same guest always looks the same.
export function sheetFor(id: string, sheets: CharSheet[], mine: boolean): CharSheet {
  if (mine) return sheets[Math.min(avatarIndex(), sheets.length - 1)];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return sheets[Math.abs(h) % sheets.length];
}

// defaultSheet is the character of a page whose sheet did not load: it is
// drawn here, so the fallback costs no request and no file.
function defaultSheet(): CharSheet {
  const cols = 4;
  const canvas = document.createElement('canvas');
  canvas.width = CHAR_W * cols;
  canvas.height = CHAR_H * SHEET_ROW.length;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#4a6fa5';
    for (let row = 0; row < SHEET_ROW.length; row++) {
      for (let col = 0; col < cols; col++) {
        ctx.fillRect(col * CHAR_W + 8, row * CHAR_H + 6, 16, 22);
      }
    }
  }
  const idle: Record<string, number> = {};
  const walk: Record<string, number[]> = {};
  for (const dir of DIR) {
    idle[dir] = IDLE_FRAME;
    walk[dir] = [...WALK_ORDER];
  }
  return { image: canvas as unknown as HTMLImageElement, cellW: CHAR_W, cellH: CHAR_H, idle, walk, columns: cols };
}

// ---------------------------------------------------------------- walking
// Walker is the local avatar: its position, its facing, its walk frame, and
// the one rule that a wall stops a footstep.
export class Walker {
  x: number;
  y: number;
  dir = 0;
  moving = false;
  private frame = 0;
  private clock = 0;
  private world: World;

  constructor(world: World, start: { x: number; y: number }) {
    this.world = world;
    this.x = start.x;
    this.y = start.y;
  }

  // step advances the avatar by one frame of time with the keys held now. A
  // diagonal is normalised, so a corner is not walked twice as fast, and each
  // axis is tried alone, so a wall on one side still lets the other slide.
  step(dt: number, keys: Set<string>) {
    let dx = 0;
    let dy = 0;
    if (keys.has('ArrowLeft') || keys.has('a')) dx -= 1;
    if (keys.has('ArrowRight') || keys.has('d')) dx += 1;
    if (keys.has('ArrowUp') || keys.has('w')) dy -= 1;
    if (keys.has('ArrowDown') || keys.has('s')) dy += 1;
    this.moving = dx !== 0 || dy !== 0;
    if (!this.moving) {
      this.clock = 0;
      this.frame = 0;
      return;
    }
    // A single axis decides the facing; a diagonal keeps the last one, so the
    // sprite does not flicker between two rows every frame.
    if (dx !== 0 && dy === 0) this.dir = dx < 0 ? 1 : 2;
    else if (dy !== 0 && dx === 0) this.dir = dy < 0 ? 3 : 0;
    const ms = Math.min(Math.max(dt, 0), 100);
    const len = Math.hypot(dx, dy) || 1;
    const moveX = (dx / len) * WALK_SPEED * (ms / 1000);
    const moveY = (dy / len) * WALK_SPEED * (ms / 1000);
    if (moveX && !this.world.collision(this.x + moveX, this.y)) this.x += moveX;
    if (moveY && !this.world.collision(this.x, this.y + moveY)) this.y += moveY;
    this.clock += ms;
    if (this.clock >= CHAR_MOVE_MS) {
      this.clock -= CHAR_MOVE_MS;
      this.frame++;
    }
  }

  // cell is the sheet cell of the current facing and step: the row of the
  // facing, the idle column when still, the walk cycle when moving.
  cell(sheet: CharSheet): { col: number; row: number } {
    const name = DIR[this.dir] || DIR[0];
    const row = SHEET_ROW[this.dir] ?? 0;
    if (!this.moving) return { col: sheet.idle[name] ?? IDLE_FRAME, row };
    const walk = sheet.walk[name] && sheet.walk[name].length ? sheet.walk[name] : WALK_ORDER;
    return { col: walk[this.frame % walk.length], row };
  }
}

// ---------------------------------------------------------------- the view
// One drawn avatar: where it is, which way it faces, and its name. The local
// one carries its walker, so the view and the input agree on every pixel. A
// guest out of this page's conversation is drawn grey, so a look at the map
// says exactly who is being heard, and a guest whose camera is on carries the
// camera mark beside its name.
export type Avatar = {
  id: string;
  name: string;
  x: number;
  y: number;
  dir: number;
  moving: boolean;
  sheet: CharSheet;
  local?: boolean;
  heard?: boolean;
  camera?: boolean;
};

// KEYS is every key that moves the avatar. A field with focus keeps its own
// keys: typing in the chat must never walk the avatar into a wall.
const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'd', 'w', 's']);
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  return TYPING.has(target.tagName) || !!target.isContentEditable;
}

// makePad builds the touch pad over a canvas: a cross of four arrow buttons,
// shown only on a screen without a hover, each holding its key while pressed.
// A tap that starts on a button never reaches the canvas, so a tap on the map
// itself stays a tap.
function makePad(host: HTMLElement, hold: (key: string, down: boolean) => void): HTMLElement | null {
  const box = document.createElement('div');
  box.className = 'world-pad';
  box.setAttribute('aria-label', 'walk');
  const arrows: [string, string, string][] = [
    ['up', 'ArrowUp', '↑'],
    ['left', 'ArrowLeft', '←'],
    ['right', 'ArrowRight', '→'],
    ['down', 'ArrowDown', '↓'],
  ];
  for (const [name, key, face] of arrows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'world-pad-key world-pad-' + name;
    b.textContent = face;
    b.setAttribute('aria-label', 'walk ' + name);
    const press = (event: PointerEvent) => {
      event.preventDefault();
      b.setPointerCapture(event.pointerId);
      hold(key, true);
    };
    const release = () => hold(key, false);
    b.addEventListener('pointerdown', press);
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    b.addEventListener('lostpointercapture', release);
    box.appendChild(b);
  }
  const parent = host.parentElement;
  if (!parent) return null;
  parent.classList.add('has-pad');
  parent.appendChild(box);
  return box;
}

// WorldView draws the map and the avatars on one canvas: one pre-blitted floor,
// a window of it, the avatars sorted by their feet, and every pixel on a whole
// step of the map pixel. A hidden page draws no frame at all.
export class WorldView {
  readonly canvas: HTMLCanvasElement;
  readonly world: World;
  avatars = new Map<string, Avatar>();
  // frames is read by the browser test: a map that never drew is a map that
  // failed.
  frames = 0;
  // near is the bubble set of the proximity layer, drawn beside the name of a
  // guest that hears this page.
  near = new Set<string>();
  private ctx: CanvasRenderingContext2D;
  private held = new Set<string>();
  private dirty = true;
  private raf = 0;
  private scale = 1;
  private camX = 0;
  private camY = 0;
  private last = 0;
  // pad is the four arrow buttons a touch screen walks with; a mouse never
  // sees it.
  private pad: HTMLElement | null = null;
  private onKeyDown = (event: KeyboardEvent) => this.key(event, true);
  private onKeyUp = (event: KeyboardEvent) => this.key(event, false);

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    this.world = world;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'the world of this room, walk with the arrow keys or w a s d');
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.pad = makePad(canvas, (key, down) => this.touch(key, down));
    if (typeof ResizeObserver === 'function') {
      const observe = new ResizeObserver(() => {
        this.dirty = true;
      });
      observe.observe(canvas);
    }
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  // touch is one arrow button of the pad: it holds the same key a finger on a
  // keyboard would, so the walker needs no second path.
  private touch(key: string, down: boolean) {
    if (!KEYS.has(key)) return;
    if (down) {
      if (document.visibilityState === 'visible') this.held.add(key);
    } else {
      this.held.delete(key);
    }
    this.dirty = true;
  }

  // keys is the set of keys held now, for the walker of this page.
  get keys(): Set<string> {
    return this.held;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    if (this.pad && this.pad.parentNode) this.pad.parentNode.removeChild(this.pad);
    this.pad = null;
    this.avatars.clear();
    this.held.clear();
  }

  private key(event: KeyboardEvent, down: boolean) {
    if (!KEYS.has(event.key) || typing(event)) return;
    // Only the page the visitor is looking at walks: two tabs of one room
    // must not walk together.
    if (down && document.visibilityState !== 'visible') return;
    if (down) {
      this.held.add(event.key);
      event.preventDefault();
    } else {
      this.held.delete(event.key);
    }
    this.dirty = true;
  }

  // mark asks for a frame: a change from outside the loop (a peer appeared, a
  // name arrived) is neither a key press nor a walker step.
  mark() {
    this.dirty = true;
  }

  // local is the avatar of this page.
  get local(): Avatar | undefined {
    for (const one of this.avatars.values()) if (one.local) return one;
    return undefined;
  }

  // fit sizes the canvas to its box and picks the zoom. A whole number of
  // pixels per map pixel keeps pixel art crisp; a narrow window takes the
  // largest fraction that still shows two tiles of the map.
  fit() {
    const width = this.canvas.clientWidth || 0;
    const height = this.canvas.clientHeight || 0;
    if (!width || !height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const want = Math.floor(width / 320);
    this.scale = want >= 1 ? Math.min(3, want) : Math.max(0.5, width / 320);
  }

  private tick(time: number) {
    const dt = this.last ? time - this.last : 16;
    this.last = time;
    const local = this.local as (Avatar & { walker?: Walker }) | undefined;
    if (local && local.walker && document.visibilityState === 'visible') {
      const walker = local.walker;
      walker.step(dt, this.held);
      if (walker.x !== local.x || walker.y !== local.y || walker.dir !== local.dir || walker.moving !== local.moving) {
        local.x = walker.x;
        local.y = walker.y;
        local.dir = walker.dir;
        local.moving = walker.moving;
        this.dirty = true;
      }
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  // topLeft is where the window stands in map pixels, whole, because the scale
  // keeps every edge of the art on a whole pixel.
  topLeft(): { x: number; y: number } {
    return { x: this.camX / this.scale, y: this.camY / this.scale };
  }

  // size is the drawn window in map pixels.
  size(): { w: number; h: number } {
    return { w: this.canvas.width / this.scale, h: this.canvas.height / this.scale };
  }

  // ink counts the distinct colours of the frame, thinned out. A blank window is
  // one colour and a map is many: it is the cheap proof that a map was painted
  // and not a black rectangle.
  ink(): number {
    if (!this.canvas.width || !this.canvas.height) return 0;
    const pixels = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4 * 97) {
      seen.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
      if (seen.size >= 64) break;
    }
    return seen.size;
  }

  // draw paints one frame: the visible window of the floor, then every avatar
  // in the window with its feet sorted, then its name.
  draw() {
    this.fit();
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (!width || !height) return;
    const local = this.local;
    if (local) {
      // The camera has no sub pixel: half a pixel of shift would blur every
      // edge of a pixel art map.
      const wantX = local.x * this.scale - width / 2;
      const wantY = local.y * this.scale - height / 2;
      this.camX = Math.round(Math.max(0, Math.min(this.world.widthPx * this.scale - width, wantX)));
      this.camY = Math.round(Math.max(0, Math.min(this.world.heightPx * this.scale - height, wantY)));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = this.scale % 1 !== 0;
    ctx.fillStyle = '#1d1d20';
    ctx.fillRect(0, 0, width, height);
    // Only the window the camera holds is copied out of the floor, so a big
    // map costs what the window costs and not what the map costs.
    const x0 = Math.max(0, Math.floor(this.camX / this.scale));
    const y0 = Math.max(0, Math.floor(this.camY / this.scale));
    const x1 = Math.min(this.world.widthPx, Math.ceil((this.camX + width) / this.scale) + 1);
    const y1 = Math.min(this.world.heightPx, Math.ceil((this.camY + height) / this.scale) + 1);
    const view = { x0, y0, x1, y1 };
    if (x1 > x0 && y1 > y0) {
      ctx.drawImage(this.world.tiles, x0, y0, x1 - x0, y1 - y0, x0 * this.scale - this.camX, y0 * this.scale - this.camY, (x1 - x0) * this.scale, (y1 - y0) * this.scale);
    }
    ctx.setTransform(this.scale, 0, 0, this.scale, -this.camX, -this.camY);
    const list = [...this.avatars.values()]
      .filter((one) => one.x + CHAR_W >= view.x0 && one.x - CHAR_W <= view.x1 && one.y >= view.y0 && one.y - CHAR_H <= view.y1)
      .sort((a, b) => a.y + AVATAR_SORT_OFFSET - (b.y + AVATAR_SORT_OFFSET) || (a.id < b.id ? -1 : 1));
    for (const one of list) this.drawAvatar(one);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.frames++;
  }

  private drawAvatar(one: Avatar) {
    const ctx = this.ctx;
    const sheet = one.sheet;
    const name = DIR[one.dir] || DIR[0];
    const walk = sheet.walk[name] && sheet.walk[name].length ? sheet.walk[name] : WALK_ORDER;
    const col = one.moving ? walk[Math.floor(performance.now() / CHAR_MOVE_MS) % walk.length] : sheet.idle[name] ?? IDLE_FRAME;
    const row = SHEET_ROW[one.dir] ?? 0;
    const dx = Math.round(one.x - CHAR_W / 2);
    const dy = Math.round(one.y - CHAR_ORIGIN_Y);
    // A guest this page is not in a conversation with is drawn grey: the media
    // is not routed and the map says so without a word.
    const heard = one.local || this.near.has(one.id);
    if (!heard) ctx.filter = 'grayscale(1) brightness(0.72)';
    if (one.local) {
      // A soft disc under the foot: this one is you.
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(Math.round(one.x), Math.round(one.y), 10, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(sheet.image, col * sheet.cellW, row * sheet.cellH, sheet.cellW, sheet.cellH, dx, dy, sheet.cellW, sheet.cellH);
    ctx.filter = 'none';
    // The name is drawn in map pixels, so it scales with the avatar and never
    // blurs differently from it.
    const label = one.name || one.id.slice(0, 6);
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const top = dy - 2;
    const wide = Math.ceil(ctx.measureText(label).width) + 4;
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#000000';
    ctx.fillRect(Math.round(one.x - wide / 2), top - 9, wide, 9);
    ctx.globalAlpha = 1;
    ctx.fillStyle = one.local ? '#9fe3ff' : '#ffffff';
    ctx.fillText(label, Math.round(one.x), top);
    if (!one.local && this.near.has(one.id)) {
      ctx.fillStyle = '#57d957';
      ctx.beginPath();
      ctx.arc(Math.round(one.x + wide / 2) + 1, top - 5, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // The camera mark: a small lens beside the name of a guest whose own flags
    // say its camera is on.
    if (!one.local && one.camera) {
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(Math.round(one.x - wide / 2) - 6, top - 8, 4, 3);
      ctx.fillRect(Math.round(one.x - wide / 2) - 1, top - 7, 1, 1);
    }
  }

  // marks takes the camera flag of every remote, so a name tag says when a
  // guest holds a camera. It repaints only on a change.
  marks(cams: Map<string, boolean>) {
    let dirty = false;
    for (const one of this.avatars.values()) {
      if (one.local) continue;
      const cam = !!cams.get(one.id);
      if (!!one.camera !== cam) {
        one.camera = cam;
        dirty = true;
      }
    }
    if (dirty) this.dirty = true;
  }

  // paintNear takes the conversation set of this tick and repaints only on a
  // change.
  paintNear(ids: string[]) {
    const next = new Set(ids);
    if (next.size !== this.near.size || ids.some((id) => !this.near.has(id))) {
      this.near = next;
      this.dirty = true;
    }
  }
}
