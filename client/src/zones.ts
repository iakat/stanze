/*
 Zones: the named rectangles of a map, which of them hold a point, and whether
 one of them is full.

 WorkAdventure has two area classes, "zone" and "area", and both are a rectangle
 with a name, an occupancy cap and a bubble radius. A zone here is that, and it
 is where guests talk; a zone that names an exitUrl carries a guest to the room
 the map names, and a zone marked start is where that room lands one. stanze has
 no megaphone, so there is no podium. An author property this file does not name
 is ignored, never guessed at.
*/

// ZONE_CLASS is the one class a map object may carry to become a zone.
export const ZONE_CLASS = 'zone';

// The zone kinds WorkAdventure names, and which of them are a conversation
// room rather than a way through. A meeting room is talk at any distance and a
// silent zone is no talk at all. A start or an exit is not a kind: it is the
// start and exit fields of a zone, so it works with any kind. A kind the table
// does not know is a plain area.
export const ZONE_KINDS = ['meeting', 'silent'] as const;

// DEFAULT_PROXIMITY is the bubble of a zone that names none: WorkAdventure's
// own conversation bubble.
export const DEFAULT_PROXIMITY = 96;

// A rect is axis aligned map pixels. A zone holds a flat list of them, so a
// polygon or an L shape is several rects and nothing downstream sees a polygon.
export type Rect = { x: number; y: number; w: number; h: number };

export type Zone = {
  id: string;
  name: string;
  // The zone kind, or an empty word for a plain area.
  kind: string;
  capacity: number;
  proximity: number;
  rects: Rect[];
  // exit names a room the zone carries a guest to, and start names the zone
  // that room lands a guest on: WorkAdventure's exitUrl and start properties.
  // Both are placed by the map loader and never by the wire.
  exit?: string;
  start?: boolean;
};

// ZONE_ID is the shape of a zone id: it names a hash fragment, so it is checked
// before a map's ids are believed.
const ZONE_ID = /^[a-z0-9-]{1,32}$/;

// zoneCleanId makes a legal id out of whatever an author typed.
export function zoneCleanId(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

// zoneCleanName keeps the display name printable and short.
export function zoneCleanName(raw: string): string {
  return String(raw || '')
    .replace(/[^\p{L}\p{N}\p{P}\p{Zs}]+/gu, ' ')
    .trim()
    .slice(0, 64);
}

function rectOf(raw: any): Rect | null {
  if (!raw) return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// zoneFromObject accepts one entry of a zone list: the runtime form the
// sidecar carries and the form a Tiled object is converted to at load. It
// answers null for anything it cannot use, so one bad object never empties a
// map.
export function zoneFromObject(raw: any, index: number): Zone | null {
  if (!raw || typeof raw !== 'object') return null;
  const fromName = zoneCleanId(raw.name);
  const id = zoneCleanId(raw.id) || fromName || 'zone-' + index;
  if (!ZONE_ID.test(id)) return null;
  const name = zoneCleanName(raw.name) || id;
  const capacity = Number(raw.capacity);
  const proximity = Number(raw.proximity);
  const kind = String(raw.kind || '');
  // A kind the runtime names survives; any other word is a plain area. The
  // check reads the list directly, never through a lookup by a word, because
  // a word of the code is also a property name an author may choose.
  const call = Array.isArray(raw.rects) ? raw.rects : [raw];
  const rects: Rect[] = [];
  for (const one of call) {
    const rect = rectOf(one);
    if (rect) rects.push(rect);
  }
  if (!rects.length) return null;
  const exit = typeof raw.exit === 'string' ? raw.exit.trim().slice(0, 128) : '';
  return {
    id,
    name,
    kind: ZONE_KINDS.indexOf(kind as (typeof ZONE_KINDS)[number]) >= 0 ? kind : '',
    capacity: Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0,
    proximity: Number.isFinite(proximity) && proximity > 0 ? Math.round(proximity) : DEFAULT_PROXIMITY,
    rects,
    ...(exit ? { exit } : {}),
    ...(raw.start === true ? { start: true } : {}),
  };
}

// zoneList builds the flat list from a sidecar body or an object layer. Two
// zones with one id is a load error: entering that id would name two places.
export function zoneList(raw: any[]): Zone[] {
  const out: Zone[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const zone = zoneFromObject(raw[i], i);
    if (!zone) continue;
    if (seen.has(zone.id)) throw new Error('duplicate zone id: ' + zone.id);
    seen.add(zone.id);
    out.push(zone);
  }
  return out;
}

// inside answers whether a point is in one rect of a zone, the way the area
// body of WorkAdventure is a rectangle around its object.
export function inside(zone: Zone, x: number, y: number): boolean {
  for (const rect of zone.rects) {
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return true;
  }
  return false;
}

// ZoneGrid is the loader's flat list with the one check that costs anything: a
// point is tested against every zone only when its map cell changed. At a few
// dozen rects an index is more code than it saves.
export class ZoneGrid {
  readonly zones: Zone[];
  private key = Number.NaN;
  private here: Zone[] = [];

  constructor(zones: Zone[]) {
    this.zones = zones;
  }

  // at answers every zone holding the point. The cached answer is only reused
  // for the same map cell, so a zone edge inside one 32 px cell still updates
  // at walking speed.
  at(x: number, y: number, cell = 32): Zone[] {
    const key = Math.floor(x / cell) * 65536 + Math.floor(y / cell);
    if (key === this.key) return this.here;
    this.key = key;
    const found: Zone[] = [];
    for (const zone of this.zones) if (inside(zone, x, y)) found.push(zone);
    this.here = found;
    return found;
  }

  byId(id: string): Zone | null {
    for (const zone of this.zones) if (zone.id === id) return zone;
    return null;
  }
}

// ZoneWatch turns the cached hit test into enter and leave events: it keeps the
// ids of the last call, so walking over a boundary says which zones were left
// and which were entered once per change, never once per frame.
export class ZoneWatch {
  private inside = new Set<string>();
  private grid: ZoneGrid;

  constructor(grid: ZoneGrid) {
    this.grid = grid;
  }

  // update returns the zones entered and left since the last call.
  update(x: number, y: number, cell = 32): { enter: Zone[]; leave: Zone[] } {
    const now = this.grid.at(x, y, cell);
    const next = new Set<string>();
    for (const zone of now) next.add(zone.id);
    const enter: Zone[] = [];
    const leave: Zone[] = [];
    for (const zone of now) if (!this.inside.has(zone.id)) enter.push(zone);
    for (const id of this.inside) {
      if (next.has(id)) continue;
      const zone = this.grid.byId(id);
      if (zone) leave.push(zone);
    }
    this.inside = next;
    return { enter, leave };
  }

  ids(): string[] {
    return [...this.inside];
  }

  reset() {
    this.inside = new Set();
  }
}
