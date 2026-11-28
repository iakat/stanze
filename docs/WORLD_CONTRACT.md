# WORLD_CONTRACT

Frozen interface between three parallel efforts (assets, code reading, implementer).
Anything not here is free. Anything here is settled: change it by editing this file
and saying so on IRC, not by shipping a different shape.

Every number below was read from the tree on 2026-11-26, not assumed. Where trix's
review contradicts researchD, trix wins and this file says why.

---

## 0. Hard decisions (non-negotiable, from trix's review)

| Decision | Value | Why |
|---|---|---|
| Position transport | `files` DataChannel, `t:"pos"` frames | `sealedSend` is `app`, a **strict** counter: one missing seq calls `sealedGapReset` and restarts the pair (`handshake.ts:695-708`). The relay drops frames on a slow queue on purpose. Positions are lossy-shaped data; they must not be able to kill audio. |
| Position rate | **follows the walker**: `MOVING_DELAY = 33` ms (30 Hz) while moving, `IDLE_DELAY = 1000` ms while still, and an immediate frame on a stop or a turn. Amended 2026-11-28 (trix): the flat 5 Hz clock read as choppy, 15 Hz still read as choppy live, and a still guest wastes nothing at 1 Hz. | trix 2026-11-28 |
| Interpolation | lerp from the previous sample to the last one over the **measured gap** between them, clamped to 16..150 ms, never extrapolating past the last frame. | trix 2026-11-28 |
| Office peer cap | **6**, refused with the existing `unavailable`, and `config.go` cap knob | researchD §0 |
| Per-frame server relay | **none**. `x,y` never appear in a Go struct, a clear frame, or `state.wireLeaks` | researchA P1, researchD §1 |
| Room budget | **600** frames/s, **1200** burst. Positions never reach it: they are pair-to-pair on the data channel, so this is signalling, chat and media state only | researchD §1; corrected 2026-11-28 |
| Per-connection limiter | `newTokenBucket(120,60)`, unchanged: it gates the socket, and position frames do not cross the socket | corrected 2026-11-28 |
| Map bytes | never over `enc`. Public HTTP GET only. | researchD §3, `encMax` 96 KiB |
| Tile spritesheet | **one PNG per tileset**, never one image per tile | trix §6 |

### The `files` frame envelope (measured, not estimated)

`fileOnChunk` (`files.ts:438`) currently accepts only `{x,q,b}`: a transfer id, a
chunk counter and a sealed blob. Position frames share the channel, so the envelope
grows one optional discriminator and everything else stays as it is:

```jsonc
// position, at most POS_MAX_JSON = 200 bytes of plaintext
{ "t": "pos", "s": "<base64 sealed blob>" }

// file chunk, unchanged and with no "t"
{ "x": "<xferId>", "q": 12, "b": "<base64 sealed blob>" }
```

- `t` absent => file chunk. A receiver that predates this file keeps working.
- `t` present and not `"pos"` => drop. Unknown kinds are ignored, never an error.
- The sealed blob inside is `{k:'pos', ...}` (section 1), sealed with the pair's
  **chat key** and **`fileAAD(peer.id, state.self, 'pos', seq, ...)`** — the transfer
  field carries the literal `'pos'`, `seq` is a per-pair counter that starts at 0 and
  rises by one. That reuses `fileAAD` verbatim, so no new AAD helper is needed.
- **Wire cost, measured** (python, this box): plaintext 107 B, `padPayload` 512,
  AES-GCM + base64 704 B, envelope 750 B. At the walking rate of 30 Hz: **22.5 KB/s
  per pair, 110 KiB/s across five pairs**; at 1 Hz standing it is under 1 KB/s. That
  is the number to put in any further document; the "~700 B" in researchD is the
  sealed blob, the "~1 KB" in trix is the envelope. The cost is paid on the pair's
  own data channel, so it never touches the websocket bucket or the room budget.
- Position frames are **not** counted against the `app` seq counter. They never
  touch `sealedSend`.

---

## 1. Position frame (sealed payload)

```ts
type PosFrame = {
  k: 'pos';
  x: number;   // map pixels, integer, 0..map.widthPx
  y: number;   // map pixels, integer, 0..map.heightPx
  d: 0|1|2|3;  // facing: 0=down, 1=left, 2=right, 3=up  (see the note below)
  a: number;   // sheet index the SENDER picked, 0..63, clamped by the receiver
  mv: 0|1;     // moving this tick
  z: string[]; // ids of zones the SENDER believes it is inside, <= 8, each <= 32 chars
  f: number;   // status bitfield, see FLAGS
  ts: number;  // Date.now() of the sender
  n: number;   // sender's position seq, starts at 0 at pair establishment, rises by 1
};
```

**The direction enum is `0=down, 1=left, 2=right, 3=up` and it is the wire
contract.** `docs/WA_PORT_NOTES.md` records WA's own order as `UP RIGHT DOWN LEFT`.
That is WorkAdventure's internal enum, **not ours**. Do not adopt it: every peer
that sends in one order and draws in another has its avatars facing backwards,
and nothing errors. The shipping code agrees with this table
(`world.ts:30 DIR = ['down','left','right','up']`,
`positions.ts:45 DIR_X=[0,-1,1,0], DIR_Y=[1,0,0,-1]`). The sprite sheet's N/E/S/W
row order is a *separate* mapping, through `SHEET_ROW` in section 3.

**Bounds the receiver enforces before using a frame** (a hostile page can send anything):

- `k === 'pos'`, `Number.isSafeInteger(x) && Number.isSafeInteger(y)`, and
  `0 <= x <= 65535`, `0 <= y <= 65535`. Outside => drop.
- `d`, `mv` coerced to the nearest legal value, not dropped.
- `a` clamped to `0..63` and then to the receiver's own sheet list: a page that
  names a sheet this tree does not ship gets the nearest one, never a hole. The
  character is the sender's choice (rolled on join, overridable from the menu)
  and travels here so every window draws the same guest; the receiver's hash of
  the peer id is only the fallback before the first frame lands.
- `z` filtered to `string[]` of <= 32 chars, max 8 entries. Never trusted as geometry:
  every receiver re-tests zones itself (researchD §1).
- `n` is advisory ordering only. A frame with `n <= lastN` is dropped (stale reordering
  on an ordered channel cannot happen, so a repeat is a bug or a replay).
- `ts` is advisory; the receiver uses **its own** clock for the lerp window.

**Flags** (do not renumber; bits are stable):

```
0x01 dnd            0x02 back-soon        0x04 silent(local mic gated)
0x08 in-meeting     0x10 hand            0x20 megaphone-on-air
0x40 locked-bubble  0x80 blocked(local, never sent)
```

---

## 2. Zone object schema (Tiled object layer -> runtime)

A zone is a Tiled object **or** a polygon. The loader converts both to the same
runtime shape at load time; nothing downstream sees a polygon.

```ts
type Zone = {
  id: string;                       // runtime id, [a-z0-9-]{1,32}
  kind: 'meeting'|'silent'|'lockable'|'podium'|'audience'|'exit'|'start';
  name: string;                     // display name, <= 64 chars
  capacity: number;                 // 0 = unlimited
  radius?: number;                  // per-zone bubble radius, 0/absent = default 96
  rects: Array<{x:number;y:number;w:number;h:number}>; // map pixels, axis-aligned
  exit?: { room: string; start: string }; // required when kind === 'exit'
  stage?: string;                   // podium/audience only, links the pair
};
```

**Authoring names -> runtime names.** The shipped `map.json` objects use the
property bag `{kind, label, color, proximity, maxUsers}`, and `zones.ts` reads
`{id, kind, name, capacity}`. The adapter is fixed:

| Tiled object | property | runtime field |
|---|---|---|
| `name` | (object name) | `id` |
| — | `kind` | `kind` |
| — | `label` | `name` |
| — | `maxUsers` | `capacity` |
| — | `proximity` | `radius` |
| — | `color` | ignored by runtime, drawn by the client |

`label`, not `properties.name`, is the display name: `objects[].name` is already
taken by the id.

- `id` must be **globally unique inside one map**. Two zones with the same id is a
  load error (`zones.ts:106` throws, correctly).
- Both sources are legal and end at `loadWorld()`: an object layer with
  `class: "zone"`, or a sidecar `static/world/maps/<room>.zones.json` with
  `{ "zones": [...] }`. If both exist the sidecar wins (the shipped tree has none).
- Polygon support: a Tiled polygon object is rasterised into axis-aligned rects.
- Hit test: `point in rect` over `rects`, re-tested only when the tile cell
  changes (`zones.ts` `ZoneGrid`), not every frame.
- `start` zones are the spawn targets for `#start=<zone id>`; a spawn point is the
  **centre** of the first rect, and a start zone **must be at least 4 tiles wide
  and 2 tall** so two joiners do not land on the same pixel.
- **The shipped map has no `start` and no `exit` zone** (section 6). Until it
  does, `startPoint()` uses its centre-of-map fallback and the door test cannot
  run.

---

## 3. Sprite geometry

**This block has been wrong three times** because the sheet was regenerated under
it. It is now pinned to `static/world/char_player.png` as it exists on disk at
review time, and the rule is: **the bytes win over any report.**

```ts
const TILE = 32;                  // map.json tilewidth
const CHAR_W = 32, CHAR_H = 32;   // one avatar cell; char_player.png is 128x128
const SHEET_COLS = 4, SHEET_ROWS = 4;
// Row order top to bottom, as the sheet and static/world/README.md both say:
//   row 0 = N (back), row 1 = E (side), row 2 = S (front), row 3 = W (side)
// Runtime direction is 0=down,1=left,2=right,3=up, so:
const SHEET_ROW = [ 2, 3, 1, 0 ]; // d -> sheet row: down->S, left->W, right->E, up->N
// Columns left to right are walk 0, walk 1, walk 2, idle.
const IDLE_FRAME = 3;
const WALK_ORDER = [0, 1, 2, 1];  // ping-pong, not 0,1,2
const CHAR_FPS = 10;
const CHAR_ORIGIN_X = 16;         // cell centre
const CHAR_ORIGIN_Y = 32;         // cell bottom: draw at (x-16, y-32)
const WALK_SPEED = 160;           // px/s
const AVATAR_SORT_OFFSET = 16;    // depth = y + AVATAR_SORT_OFFSET
```

- **`WALK_SPEED` is a shared constant, not a rendering preference.** The client
  that draws the walk and the client that lerps the walk must use the same value.
  `positions.ts` derives its per-tick guess from it (`WALK_MS = WALK_SPEED * 0.2`,
  i.e. 32 px per 200 ms tick at 160). `WA_PORT_NOTES.md` records WA's own
  `WALK_PX_S = 240`; adopting it on one side only makes every remote avatar slide
  48 px per tick while the true position advances 32, so the avatar runs ahead of
  where its owner says it is and snaps back on each frame. Pick one number, put it
  here, and import it on both sides.

- A cell is **32x32**, exactly one tile; the avatar is one tile tall. This is the
  opposite of what the current `world.ts` hardcodes (`CHAR_W=32, CHAR_H=48,
  CHAR_ORIGIN_Y=40`), which is the 32x48 shape from researchD and does not exist
  in the shipped sheet.
- **Idle is its own 4th column**, not the centre of the walk row. Drawing idle as
  frame 1 gives a frozen mid-stride, which reads as a bug.
- Row order is N, E, S, W (top to bottom): the implementer must go through
  `SHEET_ROW`; up and down swapped looks like broken controls.
- **`/world/atlas.characters.json` wins if it exists.** A descriptor with
  `image, cellW, cellH, cols, rows[{idle, walk[]}]` overrides every constant in
  this block. The block is the fallback for a tree with no descriptor. Since the
  sheet can be regenerated, a descriptor is the only stable interface: the assets
  agent is asked to ship one (see section 6).


- Depth constants: tiles `0..999`, overlay `1_000_000`, UI `1_200_000`, mask `1e7`.
- A character sheet is a single PNG. `atlas.characters.json` (written by the asset
  agent) says for each sheet: `image`, `cellW`, `cellH`, and the row layout
  `rows: ["down","left","right","up"]`, each with its column indices for idle and
  walk. The loader reads that JSON; it never guesses offsets from pixel counts.
- Tilesets: `atlas.tilesets.json` gives `firstgid -> { image, tileW, tileH, columns,
  margin, spacing }`, straight Tiled semantics. One PNG per tileset.

---

## 4. Loader API (the only entry points)

`client/src/world.ts` is the door. Everything else (`zones.ts`, `proximity.ts`,
`positions.ts`, `avatar.ts`) is internal and may be reshaped freely as long as this
signature and the returned types hold.

```ts
// world.ts
export type World = {
  room: string;
  widthPx: number; heightPx: number;   // tiles * TILE
  tiles: HTMLCanvasElement;            // pre-blitted, drawn once at load
  collision(x: number, y: number): boolean; // map pixels -> blocked
  zones: Zone[];
  zoneAt(x: number, y: number): Zone[]; // every zone containing the point
  startPoint(zoneId: string | null): { x: number; y: number }; // spawn ladder
  images: Map<string, HTMLImageElement>; // tilesets + character sheets
};

export async function loadWorld(room: string, signal?: AbortSignal): Promise<World>;
```

- `loadWorld` fetches, in this order and with one AbortSignal:
  `/world/maps/${room}.json`, `/world/maps/${room}.zones.json` (404 => `zones: []`),
  then each tileset image and each character sheet named by `atlas.tilesets.json`
  and `atlas.characters.json` at `/world/atlas.*.json`.
- `room` is validated against `ROOM_RE` (`client/src/config.ts:6`) **before** the
  fetch. A room id that does not match throws, it does not get fetched.
- A missing map is a hard error that `room.ts` turns into the existing
  "room unavailable" path; a missing tileset is a hard error too (a map that draws
  nothing is worse than one that refuses).
- `collision` is built once from the `collides: true` tile property into a flat
  `Uint8Array(width*height)`. No per-frame tile queries.
- `startPoint` ladder (concept from researchC §9, re-expressed, 10 random draws per
  candidate): `#start=<zone>` zone if it exists -> first `start` zone -> centre of map
  -> tile (1,1). Random draws only within the chosen zone, and a draw that lands on
  `collision` is retried, bounded at 10.

---

## 5. Paths and filenames (frozen)

**These paths were also rewritten once**: the first draft invented
`maps/<room>.json` + `atlas.tilesets.json` + `atlas.characters.json`. The assets
agent shipped a flatter, simpler layout, and it is the simpler one that wins.
`/world/` today holds exactly:

```
static/world/atlas.png          one tileset sheet, 32px tiles, 8 cols, 1px gutter
static/world/atlas.json         named frames: {image, tile, gutter, frames:{name:{x,y,w,h}}}
static/world/map.json           Tiled JSON for the default office (24x16 tiles)
static/world/char_player.png    the avatar sheet, 3x4 of 40x40 (section 3)
static/world/PROVENANCE.md      origin + licence of every file (assets)
static/world/README.md          atlas geometry + layer/zone schema (assets)
static/world/wa-raw/            the untouched upstream pull, see the licence note
```

**Map selection.** The contract is one room = one map file. The assets shipped a
single `map.json`, so the loader resolves the room to a map with this rule and
nothing more:

```ts
// world.ts
const mapPath = (room: string) => (room === '' ? '/world/map.json' : `/world/maps/${room}.json`);
```

so `map.json` is the default office and any other room needs
`/world/maps/<room>.json` authored. A missing room map is a hard error, never a
fallback to the default: two rooms silently sharing one map is a privacy leak of
position, not a convenience.

The loader also reads a map saved as `.tmj`, and a room exported from the
WorkAdventure editor as a `.wam` world. A `.wam` carries no tiles: it names a
`mapUrl`, resolved beside the `.wam` file, and the `.tmj` it names is loaded
exactly like any other map. Its `areas[]` become zones **in addition to** the
object layers, and an area carrying a `start` property is the spawn for a map
that has none. A `.wam` that leads to no map is skipped like a missing file.
The next candidate after `<room>.json` is the `.tmj` an author saved, then a
`.wam`, then the default office. The fixture `maps/wamtest.wam` +
`maps/wamtest.tmj` proves the last one (`make wam`, room `wamtest`).

**Served under `/world/`** via the existing `folderNames()` mechanism
(`main.go:486`) plus one recursive loader, because `cmd/pack` walks all of
`static/` and the browser only sees names `folderNames()` lists. `/world/` is
files-only: `loadFolder` globs, it never `ReadDir`.

**Licence note on `wa-raw/`.** It holds upstream WorkAdventure source
(`play/src/front/...`) and the CC-BY-SA / GPL-3 tilesets. `cmd/pack` walks every
file under `static/`, so this ships in the binary unless it is excluded. It must
be either (a) untracked and git-ignored, or (b) kept with `LICENSE.txt` +
`cc-by-sa-3.0.txt` + `gpl-3.0.txt` beside it. Neither is true today: it is
currently a headless source dump inside the served tree.

---

## 6. Two interface drifts the agents must reconcile

These are **live mismatches in the tree at review time**, written here so they
are not silently resolved by whoever commits last:

1. **Zone property names.** The assets' `map.json` zones carry
   `label`, `maxUsers`, `proximity`. The runtime (`zones.ts`) reads `id`, `kind`,
   `name`, `capacity`. `label`->`name` and `maxUsers`->`capacity` must be mapped
   in `zoneObjects` (`world.ts`), or the meeting room shows as unnamed and
   unlimited. `proximity` (192) has no field in the contract type; it is the
   per-zone bubble radius and should become optional `radius?: number`.
2. **Zone vocabulary.** The map has `meeting` and `silent` only. There is **no
   `start` zone and no `exit` zone**, but tests 8 (door) and the spawn ladder need
   both. Either the assets add them to `map.json`, or acceptance test 8 cannot be
   run at all. This is the single biggest gap between "a map draws" and "a map is
   playable".


---

## 7. What each agent owns

- **assets**: `static/world/**`, `PROVENANCE.md`, `README.md`. Must write boxes that
  match §3 exactly, and must ship exactly the two `atlas.*.json` files §4 fetches.
- **reading**: `docs/WA_PORT_NOTES.md`. Must not contradict §0/§1/§3; where
  researchD was wrong (sealed transport, bytes, limiter) this file supersedes it.
- **implementer**: `client/src/world.ts`, `zones.ts`, `proximity.ts`, `positions.ts`,
  the `files.ts` `t:"pos"` branch, the Go cap/budget knob, tests.

Nobody edits another's files. Mismatches are reported, not patched across the line.

---

## 8. Three things most likely to break

1. **The `files` channel already has an owner.** `fileDropPeer` nulls `peer.dc` and
   `fileBindChannel` overwrites `peer.dc`. A `pos` sender that caches `peer.dc` will
   hold a dead channel after one renegotiation and go silent with no error. The
   sender must look up `peer.dc` at send time and skip a closed one.
2. **`peer.dcResolve` is file-only.** Its wait path ends in `fileWaitOpen`, which
   resolves `null` after 15 s. Position must not block on it: send when `dc` is
   open, drop the tick otherwise.
3. **CSP is `default-src 'none'; img-src 'self' data: blob:`.** A tileset fetched
   from a CDN or drawn from an `ArrayBuffer` without a `blob:` URL is blocked with no
   visible error except a console warning. Everything must be same-origin under
   `/world/`.
