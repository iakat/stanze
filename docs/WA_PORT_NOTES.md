# WorkAdventure → stanze: constants and behaviour to reproduce

Source read: `github.com/workadventure/workadventure`, branch `master`, fetched 2026-11-26 over
raw.githubusercontent.com. Line numbers are that revision. Nothing else in this tree touches WA code.

Purpose: for every WA behaviour the 2D office needs, the number it must match and where the number lives.
Prose is kept out on purpose; if a row is not a constant or a formula it does not belong here.

---

## 0. Constants table (the whole set)

| # | Name | Value | Upstream |
|---|------|-------|----------|
| 1 | `POSITION_DELAY` (send gate) | `200` ms | `play/src/front/Enum/EnvironmentVariable.ts:43` |
| 2 | `MAX_EXTRAPOLATION_TIME` | `100` ms | `play/src/front/Enum/EnvironmentVariable.ts:44` (comment says 250, code uses 100) |
| 3 | receive interpolation window | `POSITION_DELAY` (200 ms), literally reused | `GameScene.ts:4621` — `this.currentTick + POSITION_DELAY` |
| 4 | `WOKA_SPEED` | base 1, `speed * 20` px per tick (vel = `20` px/1/50 s unit ⇒ `1000 * speed`, `1200` at 60 fps), run `2.5 * WOKA_SPEED` | `Player.ts:140` `const moveAmount = speed * 20;`, `Player.ts:120` `2.5 * WOKA_SPEED` |
| 5 | path-follow speed formula | `getPathWalkingSpeed() * delta * 20 / 1000` px | `Character.ts:490` |
| 6 | avatar hitbox | `16 × 16`, foot offset `x 0 / y 8` | `Character.ts:35-38` `CHARACTER_BODY_WIDTH/HEIGHT/OFFSET_X/OFFSET_Y` |
| 7 | avatar depth (y-sort) | `y + 16` | `Character.ts:87,229,417` `this.setDepthIfNeeded(this.y + 16)` |
| 8 | name label depth offset | `y - 18` | `Character.ts:34` `const playerNameY = -18;` |
| 9 | clickable radius | `25` px | `Character.ts:36` `const interactiveRadius = 25;` |
| 10 | walk animation | 4 frames `[0,1,2,1]` down / `[3,4,5,4]` left / `[6,7,8,7]` right / `[9,10,11,10]` up, `frameRate: 10`, `repeat: -1` | `Phaser/Player/Animation.ts:17-45` |
| 11 | idle animation | single frame `down 1 / left 4 / right 7 / up 10`, `frameRate: 10`, `repeat: 1`, fresh start on each direction change | same file |
| 12 | sprite sheet layout | WA's own sheets: 4 rows down / left / right / up, 3 walk frames per row, indices `row*3 + {0,1,2}`. Any other sheet (Pipoya etc.) needs its own `frames: [..]` table, the logic does not assume 3 | implied by #10, researchB §3 |
| 13 | direction enum order | `UP=0, RIGHT=1, DOWN=2, LEFT=3` (from `PositionMessage_Direction`; `rotate()` scans `_lastDirection + 1` up to `LEFT`) | `Player.ts:74` |
| 14 | direction pick (keyboard) | `|vx| > |vy|` wins, else vertical; ties go vertical | `Player.ts:148-155`, `Player.ts:216-228` |
| 15 | direction pick (path follow) | horizontal only if `|dx| > |dy| * 1.5` | `Character.ts:531` |
| 16 | bubble resting radius `R0` | `MINIMUM_DISTANCE` = **64** px | `Phaser/Entity/ConversationBubble.ts:24`, `.env.template:233` (template sets `MINIMUM_DISTANCE=64`; the value the pusher actually joins a group at is not in the client) |
| 17 | bubble fall-off `lambda` | `40` px | `ConversationBubble.ts:25` |
| 18 | bubble deform amplitude `amp` | `20` px | `ConversationBubble.ts:28` |
| 19 | bubble angular sharpness | inside `kInside = 2`, outside `kOutside = 20` | `ConversationBubble.ts:26-27` |
| 20 | bubble samples / lerp | `segments = 64`, `speed = 0.1`, `stopAnimationThreshold = 0.1` | `ConversationBubble.ts:29-31` |
| 21 | bubble influence radius | `R0 + lambda * 2` = **144** px | `ConversationBubble.ts:32` |
| 22 | bubble radius target | `targetR = R0 + Σ (A * exp(-|dist - R0| / lambda) * max(0,cos θ)^k) * 2 / n`, `A = ±amp` | `ConversationBubble.ts:123-141` |
| 23 | bubble recentre | centroid of the avatars inside the bubble | `ConversationBubble.ts:167-188` |
| 24 | `MAX_PER_GROUP` | `100` (0 disables grouping) | `.env.template:39`, `GameScene.ts:4653,4663` `groupSize === MAX_PER_GROUP` ⇒ locked |
| 25 | `GROUP_RADIUS` | `48` (server-side, pusher) | `.env.template:234`, `docker-compose.yaml:242` |
| 26 | avatar activation radius | `76` (RW default) | `Phaser/Entity/RemotePlayer.ts:69` `activationRadius ?? 76` |
| 27 | map tile size | `map.tilewidth`/`tileheight`, fallback `32` | `GameMapFrontWrapper.ts:532-533,662-663` |
| 28 | cell key for zone/property cache | `xMap + yMap * map.width`, `xMap = floor(x / tilewidth)` | `GameMapFrontWrapper.ts:759-767` |
| 29 | layer depth start / y-sort split | `depth = -2`; after the object layer named `floorLayer`, `depth = DEPTH_OVERLAY_INDEX` = `1_000_000` | `GameMapFrontWrapper.ts:172,186-189`, `DepthIndexes.ts:5` |
| 30 | depth stack | tiles `0`, overlay `1_000_000`, contact bubble `1_050_000`, in-game text `1_100_000`, editor `1_150_000`, UI `1_200_000`, chat sprite `9_999_999`, mask `10_000_000` | `DepthIndexes.ts:3-12` |
| 31 | collision tile flag | tile property `collides: true`, `setCollisionByProperty` | `GameMapFrontWrapper.ts:229,238,479` (layer `data` may be a base64 string; WA drops the GPU path then, `TilemapGpuLayerEligibility.ts:35-37`) |
| 32 | area object classes | `class` ∈ `{ "zone", "area" }`, must have `width` and `height` | `GameMapFrontWrapper.ts:195,202-205` |
| 33 | area rect phantom | area body is drawn `height + 1` high, centred `y + h/2 - 1` (one row of pixels so feet do not sit on the edge) | `Phaser/Entity/Area.ts:33-38` |
| 34 | area collision cooldown | blocked warning re-armed after `3000` ms, highlight for `1000` ms, blocked flash `duration = 800` ms `delay 400` | `Area.ts:249,126,160` |
| 35 | `maxUsers` proximity margin | area scanned for fullness within `proximityThreshold` px | `GameMapFrontWrapper.ts:453-456` |
| 36 | pathfinding | A* 8 directions, diagonals enabled, corner cutting disabled, `setIterationsPerCalculation(1000)`, `maxCalculations = 50`, `maxTimeMs = 3000`, `10` ms between passes | `Utils/PathfindingManager.ts:21-28,236-260` |
| 37 | tile path costs | walkable `0`, collider `1`, exit `2` (cost `100`), start `3`, meeting `4` (cost `50`), desk `5` (cost `50`) | `PathfindingManager.ts:5-12,23-26` |
| 38 | path end point | body fitted inside the target tile with margin `CHARACTER_BODY_HEIGHT / 2 + CHARACTER_BODY_OFFSET_Y` = 16 | `PathfindingManager.ts:67-95` |
| 39 | spawn ladder draws | `MAX_DRAWS_PER_CANDIDATE = 10` random draws per candidate | `StartPositionCalculator.ts:12` |
| 40 | spawn point on a tile | `x = tileX * tilewidth + tilewidth / 2`, same for y | `StartPositionCalculator.ts:190-191,215-216,260-261` |
| 41 | spawn margin inside a rect | `16` px | `StartPositionCalculator.ts:118,135` |
| 42 | server viewport throttle | `throttle(200, ...)`, margin `300` px, sent only when the rect changed | `GameScene.ts:745,1717,1788-1793` |
| 43 | camera render | `min/target: 60` fps, `deltaHistory: 120`, `smoothStep: false`, `pixelArt: false`, `roundPixels: false`, `antialias: false`, `antialiasGL: false`, `powerPreference: "low-power"` | `Components/App.svelte:95-115,179-201` |
| 44 | DPI zoom | `HdpiManager(640*480, 196*196)`; `zoom = sqrt(realPixels / 307200)`, snap to `1.5` in `[1.5,2)`, else `floor` | `App.svelte:145`, `HdpiManager.ts:110-117` |
| 45 | GPU tile layer pick | fill ratio ≥ `0.35` **and** ≥ `256` filled cells | `GameMap/TilemapGpuLayerEligibility.ts:11,18` |
| 46 | follow stop distance | squared distance `< 2000` ⇒ stop (≈ 44.7 px) | `Player.ts:191` |
| 47 | `lastMoveEventSent` dedupe | identical event object ⇒ no send; moving ⇒ send on direction change or `>= 200` ms; stopped ⇒ send at once | `GameScene.ts:4376-4400` |
| 48 | interpolation guard | `endPosition.moving === false && tick > endTick` ⇒ outdated; `tick > endTick + 100` ⇒ outdated | `PlayerMovement.ts:13-20` |

Frame-count sanity check for #4: Phaser's arcade `Body.velocity` is multiplied by `delta` measured in seconds,
so `speed * 20` px/tick means `1000 * speed` px/s only if the scene runs at 50 Hz. The client never forces
`fps`, so the effective speed is `20 * speed * 60` = **1200 px/s at 60 fps**, 1000 at 50. A 32 px tile is crossed in
~27 ms, i.e. WA's avatar runs across an office in well under a second. Our loop must pick a number, not inherit
one: **240 px/s walking, 600 px/s running** (ratio `2.5`, the WA multiplier), so a tile takes 133 ms and a 20 × 15
tile office about 2.7 s walking. WA's value is a fact to cite, not a value to copy.

---

## 1. Position send: cadence, not a timer

`play/src/front/Phaser/Game/GameScene.ts:4376-4408`

```ts
if (this.lastMoveEventSent === event) return;
if (event.moving === false) { this.doPushPlayerPosition(event); return; }
if (event.direction !== this.lastMoveEventSent.direction) { this.doPushPlayerPosition(event); return; }
if (this.currentTick - this.lastSentTick >= POSITION_DELAY) { this.doPushPlayerPosition(event); return; }
```

* Tick source: `this.currentTick = time` in the scene `update()` (`GameScene.ts:1381`), i.e. the render clock, not
  `Date.now()`.
* Rate is therefore *at most* 5 Hz while walking, one frame on the stop, one on each direction change.
* The position lives in Phaser's player body; nothing is sent between those events: no heartbeat, no idle resend.

## 2. Position receive: interpolate the 200 ms already in flight

`GameScene.ts:4605-4624`, `PlayerMovement.ts`, `PlayersPositionInterpolator.ts`

```ts
new PlayerMovement({ x: player.x, y: player.y }, this.currentTick,
                   { ...message.position }, this.currentTick + POSITION_DELAY);
```

* `getPosition(tick)`: linear lerp from the *rendered* position at receipt time to the new position, over
  `[startTick, startTick + 200]`; `t < startTick` divides by a negative window and extrapolates backwards (never
  hit in practice).
* Stopped target: snap at `tick >= endTick`.
* Past the window: `isOutdated` at `tick > endTick + 100` (so 100 ms of frozen extrapolation), and
  `getPosition` already reports `moving: false` from `endTick + 100` on.
* `getUpdatedPositions(tick)` deletes an outdated entry only after computing from it, so a vanished peer is drawn
  once past the window and then dropped (`PlayersPositionInterpolator.ts:24-27`).
* Interpolation runs once per frame for every remote peer (`GameScene.ts:1498-1513`), and the same loop is where
  bubble invalidation is decided, from `previousPosition` and the new one.

## 3. Character animation and direction

`play/src/front/Phaser/Player/Animation.ts`, `Player.ts`

```ts
{ key: `${name}-down-walk`,  frames: [0, 1, 2, 1],  frameRate: 10, repeat: -1 }
{ key: `${name}-down-idle`,  frames: [1],           frameRate: 10, repeat: 1 }
```

* Four directions, three walk frames each, the fourth frame is the second one again (a 4-step stride).
* `playAnimation(direction, moving)` is called on every movement, so the walk cycle restarts at frame 0 on each
  direction change and each stop-to-walk transition.
* Direction on stop is kept (`_lastDirection`), never reset to down.
* Path following biases y: `Math.abs(x - oldX) > Math.abs((y - oldY) * 1.5)` before choosing horizontal
  (`Character.ts:531`), which stops the flicker on diagonals.

## 4. Collision and movement

* Avatar body `16 × 16` offset `(0, 8)` from the sprite origin, bodies are created immovable (`Character.ts:222`), and only the local
  player clears it (`Player.ts:44`).
* `setCollideWorldBounds(true)` (`Character.ts:224`).
* Keyboard move sets a velocity of `speed * 20` on both axes at once, so a diagonal is
  `20 * sqrt(2)` ≈ 28.3 px per tick; no diagonal normalisation (`Player.ts:140-142`).
* Tile collision comes from the tile property `collides`, per tile layer, on blank layers
  (`__entitiesCollisionLayer`, `__areasCollisionLayer`) that are filled in code.
* Area collision is a static Phaser body per area rect, applied only when `shouldAreaCollide()`: locked and the
  player is outside, or `maxUsersReached` and the player is outside, or no access. A player already inside is
  never collided, so a lock never traps anyone (`AreasManager.ts:318-352`).
* The area body is one pixel taller than the rect, so the avatar's feet cannot rest on the boundary
  (`Area.ts:33-38`).

## 5. Zones: how WA tests a position

`GameMap/GameMapFrontWrapper.ts`, `GameMap/AreasManager.ts`, `Entity/Area.ts`

* Zones are Tiled objects in any object layer with `class: "zone"` or `"area"`; a zone without `width`/`height`
  is skipped with a warning; a duplicate name is renamed (`GameMapFrontWrapper.ts:194-220`).
* Object x/y in Tiled are **top-left**, unlike most Tiled object placement; `Area.ts` centres the body with
  `x + width * 0.5`.
* Container semantics are half-open: membership is `x >= left && x < right` (`getAreasOnPosition` is implemented
  through the static bodies, same effect); our `zoneGrid.at` writes it as `x >= rect.x && x < rect.x + rect.w`.
* The expensive pass runs only when the **tile cell** changed:
  `xMap = floor(x / tilewidth)`, `key = xMap + yMap * map.width`, early return when the key is unchanged
  (`GameMapFrontWrapper.ts:759-767`).
* Enter events come from two rectangle *collections* (`oldPosition` vs `position`) and are emitted per zone id, so
  a diagonal step triggers them on both zones at once (`GameMapFrontWrapper.ts:1655-1685`).
* Property bag behind a zone is read when the zone is entered, not re-read while inside
  (`triggerAllProperties` at `:733,769`).
* Blocking also needs a nearby scan for `maxUsers` zones (`GameMapFrontWrapper.ts:435-460`), margin
  `proximityThreshold`, because a full room must refuse entry *before* the player is in it.

## 6. Proximity grouping: the conversation bubble

`play/src/front/Phaser/Entity/ConversationBubble.ts`, plus the server's group creation

* Geometry: resting radius `R0 = MINIMUM_DISTANCE = 64`, influence radius `R0 + 2λ = 144`, deform amplitude
  `amp = 20`, fall-off length `λ = 40`, angular exponents `2` inside / `20` outside, 64 samples, lerp `0.1`.
* Radius at angle `θ`: `R0 + (2 / n) * Σ A_i * exp(-|d_i - R0| / λ) * max(0, cos(θ - φ_i))^k_i`.
* Avatars inside pull the boundary out (`A = +amp`), avatars within `influence` but outside push it in
  (`A = -amp`); the centre is the centroid of the inside set.
* Membership itself is **not** in the bubble class: the client asks the server for a group
  (`groupUpdateMessageStream`, `GameScene.ts:2241-2245`, lock flag at `4653`) and only draws what the server sends. The only numbers
  the client owns are `MAX_PER_GROUP = 100` (lock when the group is full) and the geometry above.
* Group join condition lives in the pusher, not the client. What the client exposes as a hint: `R0 = 64` px from
  `MINIMUM_DISTANCE` and `GROUP_RADIUS = 48` from `.env.template:234` are the only radii shipped with the
  instance config.
* Bubble `influenceRadius` is also the trigger for recomputing a bubble after a move
  (`GameScene.ts:1598-1603`, `dx² + dy² <= r²`).
* Bubble is invalidated by: a user in the group moved, or the previous or current position of the local player
  lies inside the influence circle (`GameScene.ts:1548-1556`). Nothing else wakes it.

## 7. Map loading from Tiled JSON

* `this.load.tilemapTiledJSON(this.mapUrlFile, this.mapUrlFile)` (`GameScene.ts:547`), typed by
  `@workadventure/tiled-map-type-guard`; WA uses the *JSON* export, never TMX (`GameScene.ts:313` keeps the whole
  `ITiledMap` in memory for the scene's lifetime).
* Layers are flattened (`gameMap.flatLayers`), drawn in order, `setScrollFactor(layer.parallaxx ?? 1,
  layer.parallaxy ?? 1)`, `setAlpha(layer.opacity)`, `.setVisible(layer.visible)`.
* The y-sort split is an **object layer named exactly `floorLayer`**: every tile layer before it is behind the
  avatars, every tile layer after it is drawn above them at `1_000_000`.
* Tilesets: image path resolved relative to the map JSON; animated tiles refresh on the tileset's own delay,
  clamped to `>= 16` ms, fallback `100` ms (`GameMapFrontWrapper.ts:46,313-327`).
* **Tilesets must be embedded** in the map JSON: a `tileset.source` is a hard error, and a collection-of-images
  tileset is refused (`GameScene.ts:718-728`). One image per tileset, referenced by relative path.
* Collision grid is built once per layer from the `collides` property, cached per layer index
  (`GameMapFrontWrapper.ts:614-620`), and handed to the pathfinder as a numeric grid of `PathTileType`.
* Spawn order is a ladder of candidates; inside a candidate a named start zone draws a random point in the rect
  with a 16 px margin, 10 draws per candidate, ladder order
  `initPosition → named area → named tiled area → named layer → named tile → personal area → default start area →
  "start" area → "start" tile → layer name` (`StartPositionCalculator.ts:26-49`).

## 7b. The wire, as stanze must carry it (not WA's path)

WA is one protobuf WebSocket with a nonce in both directions (`Connection/WorkAdventureWebSocket.ts:69,166`,
`if (frame.nonce <= this.lastReceivedNonce)`). stanze cannot follow: the Go server must stay blind. The port
therefore keeps WA's *numbers* and drops WA's *pipe*.

Facts read from `client/src/` of this tree:

* Sealed frame: `sealedSend` (`gate.ts:664-675`) pads with `padPayload` to `PAD_BUCKETS = [512, 2048, 8192]`
  (`gate.ts:594`), AES-GCM base64, sends `{k:'app', q: seq, b}`. A minimal position JSON is ~60 B, so it lands
  in the **512 bucket**.
* On the wire per frame: ~55 B envelope `{"t":"enc","to":"<12 hex>","b":"..."}` + ~(512+16) * 4/3 ≈ **705 B** of
  base64 + the server's `from` prefix (`encFrame`, `signaling.go:487`) = **~775 B**, the envelope counted once so
  `~id` is not the target. At 5 Hz × (N-1) pairs: N=6 ⇒ 25 frames/s ≈ **19 kB/s out**, same in, ≈ **116 kB/s of
  relay** for the room.
* Per-connection limiter: `newTokenBucket(120, 60)` (`peer.go:35`) ⇒ burst 120 frames, **60 frames/s**; exceeding
  it closes the socket (`signaling.go:229`), it does not slow the sender.
* The sealed `app` counter is strict: a gap calls `sealedGapReset` (`handshake.ts:98`), which closes the
  PeerConnection and re-pairs; the fourth failure refuses the pair. So **no usage of `sealedSend` may ever
  drop a frame on purpose**.
* The `files` DataChannel already exists for every pair: `pc.createDataChannel(FILE_LABEL, { ordered: true })`
  (`peers.ts:143`, `FILE_LABEL = 'files'` at `files.ts:18`), bound by `ondatachannel` (`peers.ts:140-141`),
  content sealed per chunk with its own AAD and a per-transfer counter `q` (`files.ts:437-466`). It has **no
  counter that can reset the pair**: a repeated or skipped `q` is dropped (`files.ts:451-454`).

Conclusion for positions: the `pos` frame is a **new type on the already-mounted `files` channel**, not a new
`sealedSend` kind and not a second channel (a second `createDataChannel` fires `onnegotiationneeded`,
`peers.ts:145`, i.e. a sealed SDP round trip on the counted channel just to publish a position).

Wire budget for a position frame on `files` (`files.ts:437-466` shape, pad to 512):

* plaintext JSON `{"t":"pos","x":1234,"y":987,"d":2,"mv":1,"z":["m1"],"f":0,"ts":1699999999999}` ≈ 84 B, no pad
  needed; sealed to `84 + 16 = 100` B; base64 `ceil(100/3)*4 = 136` B; envelope
  `{"t":"pos","x":..,...,"b":"<136>"}` ≈ **230 B** on the wire, direct peer to peer, **zero bytes through the
  relay**.
* N=6 ⇒ 25 frames/s × 230 B ≈ **5.7 kB/s out** and the same in, versus ~19 kB/s and 116 kB/s of relay on the
  sealed socket path. This is the reason the channel moves, not a micro-optimisation.
* Per-connection limiter and room budget are not touched at all: a DataChannel frame never reaches `peer.go`.

## 8. Where WA's numbers do not transfer to stanze

* Send cadence is tied to the render loop, not to a timer. Under `document.hidden` a browser throttles
  `requestAnimationFrame` to ~1 Hz, so a WA tab in the background stops publishing; a stanze tab must keep the
  last target it had and let the 100 ms extrapolation run out.
* WA never sends an idle heartbeat: a peer that stops and stays still sends once. Fine on a full-duplex socket,
  fatal on a channel where the first frame after a join is the only thing that reveals the peer.
* `POSITION_DELAY` is a *minimum interval*, not a clock: two sends in the same tick are possible (direction change
  right after a timer send), so the receiver can get two 200 ms frames 0 ms apart, which is why
  `isOutdated` and the snap rule exist.

## 9. What to copy deliberately, and what to drop

Deliberately **not** copied, with the reason:

| WA behaviour | Why not |
|---|---|
| Server-side `GroupCreatedUpdatedEvent` as the only source of truth for who is near whom (`GameScene.ts:2241`) | there is no game server in the mesh; the grouper is `proximity.ts` and must run identically in every page |
| protobuf + per-direction nonce replay (`WorkAdventureWebSocket.ts:47,69,166,193`) | the socket is signalling only and the server must not read player data; the sealed `app` counter already gives exactly-once inside a pair |
| `Phaser` scene graph, arcade physics, `HdpiManager` integer zoom | 600 kB engine for one tile layer and six avatars; canvas 2D with `ctx.imageSmoothingEnabled = false` and `devicePixelRatio` scaling |
| `easystarjs` itself | MIT, but a 60-line BFS on the tile grid with the same 8-neighbour rule and tile costs (#36, #37) is smaller than the dependency; the spawn ladder (#39-#41) is kept, it is four `if`s |
| viewpoint culling / `setViewport` messages (`GameScene.ts:1782`) | six peers do not need culling, and the server has no roster to cull |
| the jelly bubble spline (64 samples, texture regenerated every step, `ConversationBubble.ts:193-260`) | a new texture per frame per bubble; our bubble is a degenerate circle of radius `R0` drawn on the same canvas, membership still by distance |
| `MAX_PER_GROUP = 100` and a server "locked" group | a 6-peer cap makes it dead code |
| `WOKA_SPEED` in px/tick | both ties speed to the render rate and yields ~1200 px/s; our constant is px/s (§8) |
| `GameScene.update()` doing culling, iframe listeners, pathfinding and path following on every frame (`GameScene.ts:1379-1540`) | one `rAF` body that does one thing per step (§10.1) |
| `ZoneGrid` cache key | pre-existing in this tree and **buggy**: `floor(x/32) * 65536 + floor(y/32)` is not injective (`y = 65536` and `x = 32` give the same key), so a zone can be missed on a big map. Fix to `floor(x/cell) + ',' + floor(y/cell)` before the world uses it. |

## 10. Modules to add under `client/src/`

Five files, no dependency between them except the types, no Phaser, no Svelte. Each is one screen of code and
imports only from `state.ts`, `util.ts`, `files.ts` and `gate.ts`. Suggested order of work follows the list.

```
client/src/
├── world.ts        loop, input, movement, collision, camera, draw order
├── zones.ts        (exists, extend) zone rects, hit test, enter/leave         ~40 lines added
├── proximity.ts    (exists) bubble grouper                                   ~0 lines, used as is
├── positions.ts    pos frames on the `files` channel, local/remote clocks
└── introspect.ts   the bot's view of the world (reads world/positions/zones)
```

### 10.1 `world.ts`

```ts
export type Vec = { x: number; y: number };
export type Dir = 0 | 1 | 2 | 3;            // UP RIGHT DOWN LEFT (WA order, #13)

export type Actor = {
  id: string;            // peer id, or 'me'
  name: string;          // sealed name, may be blank until it arrives
  x: number; y: number;  // integer map pixels, sprite centre
  d: Dir;
  mv: boolean;           // moving this frame
  anim: number;          // ms into the current walk cycle
  sheet: string;         // sprite sheet id, coloured fallback when absent
};

export const WALK_PX_S = 240;              // 8 px per 30 ms tick at 60 fps
export const RUN_PX_S = 600;              // 2.5 * WALK_PX_S, the WA multiplier (#4)
export const BODY_W = 16, BODY_H = 16, BODY_OFF_Y = 8;   // #6
export const DEPTH_Y_OFF = 16;                            // #7
export const TILE = 32;                                   // #27 fallback

export function startWorld(map: LoadedMap, canvas: HTMLCanvasElement): World;
// World owns exactly one requestAnimationFrame loop and calls, in order:
//   1. readKeys()            -> keys set, pointer target
//   2. step(dt)              -> axis-vs-axis move, tile collision, world bounds (#4, #14)
//   3. positions.tick(now)   -> send/recv, remote interpolation (§2)
//   4. zones.watch.update()  -> enter/leave callbacks (#5)
//   5. proximity.build()     -> bubble set, feeds audio gate (§6, current file)
//   6. draw()                -> layers, y-sorted actors, bubble ring
```

Shapes crossing the module boundary:

```ts
type LoadedMap = {
  width: number; height: number;              // in tiles
  tilew: number; tileh: number;               // from the JSON, fallback 32
  layers: { name: string; depth: number; canvas: HTMLCanvasElement }[];  // prerendered once
  depthSplit: number;                          // index of the `floorLayer` object layer, or layers.length
  collide: Uint8Array;                         // width*height, built from `collides: true` (#31)
  spawn: Vec;                                  // §7 ladder, reduced to tile centre
};
```

Rules that live here and nowhere else: the loop, the tick order, depth `y + DEPTH_Y_OFF`, the walk cycle
`[0,1,2,1] @ 10 fps` (#10), and the single place a remote actor's rendered position is written.

### 10.2 `positions.ts`

Owner of the `pos` frame on the `files` channel. Type added next to `fileOnChunk`/`fileOnMessage` in `files.ts`
(one `if (msg.t === 'pos') return posOnFrame(peer, msg)`, ~5 lines) so a second channel label and a second
`createDataChannel` never happen (§7b).

```ts
export const POS_HZ = 5;                 // matches WA's 200 ms gate (#1), kept as a cap, not a timer
export const LERP_MS = 200;              // (#3)
export const EXTRAP_MS = 0;              // WA uses 100 (#2); we freeze instead, see below
export const STALE_MS = 2000;            // a peer with no pos frame for 2 s is dropped

export type PosFrame = { t: 'pos'; x: number; y: number; d: Dir; mv: 0 | 1; z: string[]; f: number; ts: number };
//   x,y integer map px; d direction; mv moving; z zone ids claimed by the sender (advisory, receivers re-test);
//   f status bitfield (1 dnd, 2 back-soon, 4 silent, 8 in-meeting, 16 hand); ts sender clock, ms

export type Remote = { id: string; from: Vec; to: Vec; t0: number; t1: number; d: Dir; mv: boolean };

export function posSend(peer, fr: PosFrame): void;          // fire and forget on peer.dc
export function posOnFrame(peer, fr: unknown): void;         // validate, clamp to map, store a Remote
export function posRender(id: string, now: number): Vec;     // lerp, then freeze; no extrapolation
export function posSendGate(idle: boolean, now: number): boolean;
```

Decisions that differ from WA on purpose, each from a hard fact:

* **Send on change or 200 ms, never on a schedule**, as WA (#47), *plus* one `pos` frame per pair the first time
  the pair's channel opens, because stanze has no roster and a silent peer is invisible.
* `posRender` **freezes at `t1`** instead of extrapolating: WA's 100 ms extrapolation (#2) assumes the next frame
  lands on time; on an ordered DataChannel behind a file chunk it may not, and a frozen avatar is honest while a
  forward-guessed one walks into walls.
* `STALE_MS = 2000` vs WA's `endTick + 100`: WA deletes the movement, we delete the actor, because we have no
  server that would re-add it.
* Zone ids in `z` are the **sender's claim only** (as researchD §1). Every receiver re-tests geometry locally
  through `zones.ts`; a forged `z` moves nobody's audio.

### 10.3 `zones.ts` (extend the file that exists)

Already has `Zone`, `ZoneGrid.at`, `ZoneWatch.update`. Add:

```ts
export const ZONE_EDGE = 1;              // #33: the rect is tested one pixel tall for the feet
export type StageZone = Zone & { kind: 'stage'; tile: string };
export function zoneAt(x: number, y: number, cell = TILE): Zone[];   // unchanged semantics, half-open
export function zoneEnterLeave(prev: Vec, next: Vec): { enter: Zone[]; leave: Zone[] };  // (#5)
export function canEnter(zone: Zone, inside: boolean, locked: boolean, full: boolean): boolean;
//   WA rule (#5, AreasManager.ts:318-352): locked and not inside -> no; full and not inside -> no;
//   inside -> always yes, so a lock never traps.
```

`ZoneGrid.at`'s cache key is fixed to `x + ',' + y` cells (see the drop table in §9).

### 10.4 `proximity.ts` (unchanged, one hook)

`BUBBLE_R = 96`, `BUBBLE_LEAVE = 125`, `BUBBLE_DWELL = 300`, cell = `BUBBLE_R`, nine-bucket sweep, distinct pair
keys. WA's radii are 64 / 144 as an influence, but its own membership is a server decision, so the honest choice
is ours: 96 keeps two desks 3 tiles apart talking (researchD) and `1.3r` matches trix's hysteresis request.
Meeting zones plug in at the marked line, before the radius test.

### 10.5 `introspect.ts`

Reads only, one page of code:

```ts
export type PeerView = { id: string; name: string; bot: boolean; x: number; y: number;
                         dir: Dir; moving: boolean; zones: string[]; bubble: string[];
                         tile: string | null; game: string | null };
export function peers(): PeerView[];
export function me(): PeerView;
export function counters(): { posSent: number; posRecv: number; appSent: number; relayBytes: number; replays: number };
```

The counter names match what the bot already prints for the sealed path (`state.replayDrops`, `state.chatRecv`),
so one log line can compare the two paths.

### 10.6 Data shapes, end to end

```
keys ─▶ world.step ─▶ Actor(me) {x,y,d,mv}
                        │
                        ├─▶ zones.watch({x,y})      ─▶ enter/leave ─▶ audio gate (silent/meeting)
                        ├─▶ proximity.build(points) ─▶ bubble set   ─▶ audio gate (gain per peer)
                        └─▶ positions.posSend ─────▶ peer.dc  'files'  ▶ other pages
                                                                    │
other pages ─▶ positions.posOnFrame ─▶ Remote {from,to,t0,t1}
                                          │
                                          └─▶ world.draw: posRender(now) ─▶ depth y+16
```

Nothing in that chain touches the WebSocket, `sealedSend`, or the Go server.
