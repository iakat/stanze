/*
 The world of a room: join it after the mesh is up, walk it, send positions on
 the files channel, and hand the conversation set to the presence layer.

 One map is one room. A map never switches rooms, so there is nothing here that
 could move a guest to another one.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { load, store } from './prefs.js';
import { CharSheet, loadSheets, loadWorld, sheetFor, Walker, WorldView } from './world.js';
import { Guest, Proximity } from './proximity.js';
import { ZoneGrid, ZoneWatch } from './zones.js';
import {
  posAt,
  posFrame,
  posForget,
  posReset,
  posSend,
  POSITION_DELAY,
  remoteDir,
  remoteMoving,
  remotePoints,
} from './positions.js';
import { layoutStage } from './tiles.js';
import { updateCount } from './host.js';
import { isRouted, paintPresence, proxNote, setRouted, stageLayoutSoon } from './presence.js';
import { sealedSend } from './gate.js';
import { peerName } from './sealed.js';

// The nodes of the world, built on demand and kept across a call: a view that
// is torn down and rebuilt on every join would leave listeners behind.
let view: WorldView | null = null;
let walker: Walker | null = null;
let proximity: Proximity | null = null;
let zones: ZoneGrid | null = null;
let watch: ZoneWatch | null = null;
let sheets: CharSheet[] = [];
let raf = 0;
// lastPosAt is the time of the last position tick. The tick length itself is
// POSITION_DELAY, imported from the position frames.
let lastPosAt = 0;
let generation = 0;
// The conversation set as the last tick judged it, for the test hook and for
// the change detection that keeps a still room from repainting.
let near: string[] = [];
// worldStats counts the maps that loaded and the frames that went and came, so
// a browser test can prove the world drew before it walks.
export const worldStats = {
  loaded: 0,
  sent: 0,
  recv: 0,
  frames: 0,
  near: 0,
  zones: [] as string[],
};

// worldAvatar is the pick of the own avatar: the boot raises it when the menu
// changes, and the view redraws with the new sheet.
export function worldAvatar() {
  if (!view || !sheets.length) return;
  const self = view.avatars.get('self') as any;
  if (self) self.sheet = sheetFor('self', sheets, true);
  view.mark();
}

// isWorld answers whether the world view is the one in front of the visitor.
// The world is the default: no stored value means on, and a stored off is what
// the visitor asked for last time.
export function isWorld(): boolean {
  return load('world') !== '0';
}

// worldPainted tells the page that the view in front has changed, so the
// button that names it is painted from the state and not from the click.
function worldPainted() {
  document.dispatchEvent(new CustomEvent('worldview'));
}

// worldNode is the one node that holds the canvas and its status line.
function worldNode(): { box: HTMLElement; canvas: HTMLCanvasElement; note: HTMLElement } {
  const box = document.getElementById('world-view') as HTMLElement;
  const canvas = document.getElementById('world-canvas') as HTMLCanvasElement;
  const note = document.getElementById('world-note') as HTMLElement;
  return { box, canvas, note };
}

// loadRoom loads the map of the room this page is in and starts the view. A
// missing map is a word on the status line and the call grid, never a failed
// join: a room of a call is still a room.
export async function worldEnter(room: string) {
  const gen = ++generation;
  if (!isWorld()) {
    worldSet(false);
    return;
  }
  const { box, canvas, note } = worldNode();
  box.hidden = false;
  note.hidden = true;
  try {
    // The map is public content over HTTP and never a sealed frame; /world/ is
    // its own folder in the archive.
    const world = await loadWorld(room);
    if (gen !== generation || state.leaving) return;
    sheets = await loadSheets();
    if (gen !== generation || state.leaving) return;
    if (view) view.destroy();
    view = new WorldView(canvas, world);
    walker = new Walker(world, world.startPoint());
    proximity = new Proximity();
    zones = new ZoneGrid(world.zones);
    watch = new ZoneWatch(zones);
    view.avatars.set('self', {
      id: 'self',
      name: state.name || 'you',
      x: walker.x,
      y: walker.y,
      dir: walker.dir,
      moving: false,
      sheet: sheetFor('self', sheets, true),
      local: true,
      walker,
    } as any);
    worldStats.loaded++;
    worldStats.frames = 0;
    lastPosAt = 0;
    // A map that arrived after the visitor asked for the grid again never
    // takes the frame back: the stored choice is read once more.
    const on = isWorld();
    if (on) {
      worldSet(true);
      note.textContent = 'walk with the arrow keys or w a s d; the room is on the presence line';
    }
    note.hidden = !on;
    // The own tile exists by now in a room with others, and the world took
    // the frame: one layout puts the pictures where they belong.
    layoutStage();
    startLoop();
  } catch (err) {
    if (gen !== generation) return;
    // A room with no map is a call, not a broken page: the grid stays and the
    // note says where the map should have been.
    worldSet(false);
    const why = err && (err as Error).message ? (err as Error).message : String(err);
    note.hidden = false;
    note.textContent = 'no world for this room (' + why + '), the call grid is shown instead';
    try {
      (window as any).__worldError = String(err && (err as any).stack ? (err as any).stack : err);
    } catch {
      /* the probe is a debug aid */
    }
  }
}

// worldLeave stops the loop and drops every remote of the old room. The map
// itself goes with the view: a second room may have a different one.
export function worldLeave() {
  generation++;
  stopLoop();
  if (view) view.destroy();
  view = null;
  walker = null;
  proximity = null;
  zones = null;
  watch = null;
  near = [];
  posReset();
  sheets = [];
  paintPresence();
  const box = document.getElementById('world-view');
  if (box) box.hidden = true;
}

// worldSet puts the world or the call grid in front of the visitor. The grid
// keeps its tiles and its listeners either way; only its place changes.
export function worldSet(on: boolean) {
  const { box } = worldNode();
  const grid = $('stage-main');
  box.hidden = !on;
  // The call grid leaves the frame while the world holds it, so the pictures
  // do not take the height of a map nobody is looking at.
  grid.hidden = on || grid.children.length === 0;
  if (view && on) view.mark();
  layoutStage();
  if (!on) updateCount();
  worldPainted();
}

// worldToggle puts the other view in front. It paints what the switch does, even
// when the map of the room is still loading underneath it.
export function worldToggle() {
  const on = !isWorld();
  store('world', on ? 1 : 0);
  worldSet(on);
  // A map that was never loaded is loaded now; it takes the frame only if the
  // choice is still the world when it arrives.
  if (on && !view) worldEnter(state.room).catch(() => {});
}

// ---------------------------------------------------------------- the loop
// startLoop runs two clocks: the position tick at 5 Hz, which is also the only
// place a conversation is judged, and the view's own frame loop, which draws.
function startLoop() {
  stopLoop();
  const run = () => {
    if (!view || !walker || state.leaving) return;
    const now = performance.now();
    if (now - lastPosAt >= POSITION_DELAY) {
      lastPosAt = now;
      step();
    }
    raf = requestAnimationFrame(run);
  };
  raf = requestAnimationFrame(run);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

// guestOf is what the pair rule needs to know about one avatar: where it stands
// and which areas that place is in. Occupancy is counted here, on this page,
// from the same exact places: an area over its capacity holds nobody new.
function guestOf(x: number, y: number, load: Map<string, number>): Guest {
  const list: Guest['zones'] = [];
  let full = '';
  if (zones) {
    for (const zone of zones.at(x, y)) {
      list.push({ id: zone.id, kind: zone.kind, proximity: zone.proximity });
      const n = load.get(zone.id) || 0;
      if (zone.capacity && n >= zone.capacity) full = zone.id;
    }
  }
  return { at: { x, y }, zones: list, full };
}

// step is one position tick: walk the zones, send the frame and the one word
// about the conversation, judge the pairs, and route the media.
function step() {
  if (!view || !walker || !proximity) return;
  const local = view.local as any;
  if (local && walker) {
    local.x = walker.x;
    local.y = walker.y;
    local.dir = walker.dir;
    local.moving = walker.moving;
  }
  // The zone test runs once per tick and only reports a change, so a guest
  // standing still costs nothing and a boundary says enter once.
  if (watch) watch.update(walker.x, walker.y);
  const zoneIds = watch ? watch.ids() : [];
  if (worldStats.zones.join(',') !== zoneIds.join(',')) worldStats.zones = zoneIds;
  const peers = [...state.peers.values()];
  posSend(peers, posFrame(walker.x, walker.y, walker.dir));
  worldStats.sent++;
  // The judgement, on the exact places: this page and every remote at the
  // place its last frame named, with every area counted once.
  const points = remotePoints();
  const load = new Map<string, number>();
  if (zones) {
    for (const zone of zones.at(walker.x, walker.y)) load.set(zone.id, 1);
    for (const at of points.values()) {
      for (const zone of zones.at(at.x, at.y)) load.set(zone.id, (load.get(zone.id) || 0) + 1);
    }
  }
  const guests = new Map<string, Guest>();
  const selfId = state.self || 'self';
  guests.set(selfId, guestOf(walker.x, walker.y, load));
  for (const [id, at] of points) guests.set(id, guestOf(at.x, at.y, load));
  const next = proximity.build(selfId, guests);
  const changed = next.length !== near.length || next.some((id, i) => id !== near[i]);
  near = next;
  worldStats.near = next.length;
  route(peers, next);
  // The proximity decision as one log line, at most every 1.5 s: the own
  // place, every remote place, the area the own guest stands in, and the pairs
  // the rule routed. A guest reading "hearing: nobody" here sees the distance.
  const ownZones = zones
    ? zones
        .at(walker.x, walker.y)
        .map((z) => z.id)
        .join('+')
    : '';
  proxNote(
    'prox self ' +
      Math.round(walker.x) +
      ',' +
      Math.round(walker.y) +
      (ownZones ? ' [' + ownZones + ']' : '') +
      ' | peers ' +
      peers.length +
      ' | seen ' +
      points.size +
      ' | near ' +
      (next.length ? next.map((id) => String(id).slice(0, 6)).join(',') : 'nobody'),
  );
  // The one word of this page about its own conversation, sealed to each pair.
  const mine = next.slice(0, 16);
  for (const peer of peers) {
    if (!peer.talks || peer.talks.join(',') !== mine.join(',')) {
      peer.talks = mine.slice();
      sendTalks(peer, mine);
    }
  }
  if (changed) view.paintNear(near);
  // The remotes take the place they are drawn at this tick, so the picture and
  // the rule never disagree.
  syncPeers();
  const cams = new Map<string, boolean>();
  for (const peer of peers) cams.set(peer.id, peer.camOn !== false);
  view.marks(cams);
  view.mark();
}

// route turns the strands on and off and keeps the presence line true. A pair
// whose media is routed is a pair the line names. The whole batch asks for one
// stage layout, on the next frame, and not one per pair.
export function route(peers: any[], nearIds: string[]) {
  const on = new Set(nearIds);
  for (const peer of peers) {
    const wanted = on.has(peer.id);
    if (isRouted(peer.id) !== wanted) setRouted(peer.id, wanted);
  }
  paintPresence();
  stageLayoutSoon();
}

// worldOnPos is the one entry the files channel calls for a position frame. It
// keeps the avatar list in step with the frames that arrive.
export function worldOnPos(peer: any) {
  if (!view || !peer) return;
  worldStats.recv++;
  view.mark();
}

// syncPeers adds, moves and removes the remote avatars from the peer map and
// the frames that arrived. It runs on the tick, so a guest that leaves takes
// its avatar with it.
function syncPeers() {
  if (!view) return;
  const avatars = view.avatars;
  const now = performance.now();
  const points = remotePoints();
  for (const [id, peer] of state.peers) {
    const at = points.get(id);
    let one = avatars.get(id);
    if (!at) {
      if (one) avatars.delete(id);
      continue;
    }
    // A guest in the conversation is drawn mid step; one that is not is drawn
    // where its last frame put it, so a grey avatar never slides.
    const draw = posAt(id, now, near.includes(id));
    if (!one) {
      one = {
        id,
        name: peerName(peer),
        x: draw.x,
        y: draw.y,
        dir: remoteDir(id),
        moving: remoteMoving(id),
        sheet: sheetFor(id, sheets, false),
      };
      avatars.set(id, one);
    } else {
      one.x = draw.x;
      one.y = draw.y;
      one.dir = remoteDir(id);
      one.moving = remoteMoving(id);
      one.name = peer.name || one.name;
    }
  }
  for (const id of [...avatars.keys()]) {
    if (id === 'self') continue;
    if (!state.peers.has(id) || !points.has(id)) {
      avatars.delete(id);
      posForget(id);
    }
  }
  view.mark();
}

// worldDrop is the peer removal the mesh already does, seen by the world.
export function worldDrop(peerId: string) {
  if (view) view.avatars.delete(peerId);
  posForget(peerId);
}

// topLeft is where the visible window stands in map pixels.
export function viewTopLeft(): { x: number; y: number } {
  if (!view) return { x: 0, y: 0 };
  return view.topLeft();
}

// viewSize is the drawn size of the window in map pixels.
export function viewSize(): { w: number; h: number } {
  if (!view) return { w: 0, h: 0 };
  return view.size();
}

// worldDrawn is the one answer a browser test asks: is there a picture, and is
// it the map at all.
export function worldDrawn(): { drawn: number; ink: number } {
  if (!view) return { drawn: 0, ink: 0 };
  return { drawn: view.frames, ink: view.ink() };
}

export function worldAvatars(): {
  id: string;
  name: string;
  x: number;
  y: number;
  local: boolean;
}[] {
  if (!view) return [];
  return [...view.avatars.values()].map((one) => ({
    id: one.id,
    name: one.name,
    x: Math.round(one.x),
    y: Math.round(one.y),
    local: !!one.local,
  }));
}

// worldHook is the object the browser test drives. It never changes what the
// world does: it reads and it walks.
export function worldHook() {
  return {
    stats: () => ({ ...worldStats, frames: view ? view.frames : 0 }),
    pos: () =>
      view && view.local
        ? {
            x: Math.round(view.local.x),
            y: Math.round(view.local.y),
            dir: view.local.dir,
            moving: !!view.local.moving,
          }
        : null,
    map: () => {
      if (!view) return null;
      const world = view.world;
      return {
        room: world.room,
        widthPx: world.widthPx,
        heightPx: world.heightPx,
        zones: world.zones.length,
        avatars: view.avatars.size,
      };
    },
    // walk holds one key for a number of milliseconds, the way a person holds
    // it, so the walker takes real steps through real collision.
    walk: async (key: string, ms = 400) => {
      const held = view ? view.keys : null;
      if (!held || !walker) return null;
      held.add(key);
      view?.mark();
      await new Promise((done) => setTimeout(done, ms));
      held.delete(key);
      view?.mark();
      return view && view.local
        ? { x: Math.round(view.local.x), y: Math.round(view.local.y) }
        : null;
    },
    // goTo puts this page at a place the way a teleport would: it is for the
    // browser test to stand two pages on a known spot, never a person's move.
    goTo: (x: number, y: number) => {
      if (!walker) return null;
      walker.x = Math.max(0, Math.min(view ? view.world.widthPx : x, Number(x) || 0));
      walker.y = Math.max(0, Math.min(view ? view.world.heightPx : y, Number(y) || 0));
      view?.mark();
      return { x: Math.round(walker.x), y: Math.round(walker.y) };
    },
    near: () => (view ? [...near] : []),
    // reason names the way a pair was judged: meeting, near, bubble, silent,
    // full or far. It is the proximity word and nothing more.
    reason: (id: string) => (view && proximity ? proximity.reason(id) : ''),
    // points is the exact place of every remote frame, which is what the pair
    // rule is judged on, and the zones of each place.
    points: () => {
      const out: any[] = [];
      for (const [id, at] of remotePoints()) {
        out.push({
          id,
          x: at.x,
          y: at.y,
          zones: zones ? zones.at(at.x, at.y).map((z) => z.id + ':' + z.kind) : [],
        });
      }
      return out;
    },
    // presence is the line as a person reads it, and the facts behind it: the
    // pairs this page routes, and the pairs each of them says it talks to.
    presence: () => ({
      room: (document.getElementById('presence-room') || {}).textContent || '',
      near: (document.getElementById('presence-near') || {}).textContent || '',
      via: (document.getElementById('presence-via') || {}).textContent || '',
      routed: (view ? [...near] : []).filter((id) => isRouted(id)),
    }),
    set: (on: boolean) => {
      store('world', on ? 1 : 0);
      worldSet(on);
    },
  };
}

// talksFrame is the app frame a guest sends about its own conversation: the ids
// it talks to, sealed to the pair that receives it. It never routes media; the
// receiver's own rule decides that.
export function talksFrame(ids: string[]): { k: 'talks'; ids: string[] } {
  return { k: 'talks', ids };
}

function sendTalks(peer: any, ids: string[]) {
  if (!peer || !peer.keys || peer.waiting) return;
  sealedSend(peer, talksFrame(ids));
}
