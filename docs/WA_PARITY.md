# WorkAdventure parity, on worky

The goal, set on IRC 2026-11-27 13:07: **feature parity with WorkAdventure on worky,
release and push often.** This file is the ledger. One row per WA behaviour, what
this tree does about it, and where. A row moves to `done` with a commit, in this
file, in the same commit that lands the work.

`docs/WA_PORT_NOTES.md` is the source of the numbers: it quotes WA's own constants
and line numbers. This file never repeats a number it can point at.

Status words:

* **done**: worky behaves like WA, within the numbers this tree chose on purpose.
* **partial**: the behaviour is there and typed, some of WA's cases fall through.
* **missing**: WA does it, worky does not.
* **not ported**: a decision, not a gap. The reason is in the row.

---

## 1. Movement and the position wire

| # | WA behaviour | status | where / why |
|---|---|---|---|
| 1 | Position sent at most 5 Hz, at once on stop and on each turn | done | `positions.ts` `posFrame`, `posSend`; `roomworld.ts` one send per tick |
| 2 | Position interpolated over the 200 ms in flight, 100 ms of extrapolation | done | `positions.ts` `posAt` |
| 3 | Avatar speed walking and running, 2.5x run | **missing** | `world.ts` `WALK_SPEED` only; no run key, no shift |
| 4 | Body 16x16 at the feet, world bounds, tile collision | done | `world.ts` `BODY_*`, `bodyBlocked` |
| 5 | Four facings, walk cycle, idle frame, direction kept on stop | done | `world.ts` `SHEET_ROW`, `WALK_ORDER`, `IDLE_FRAME` |
| 6 | Direction pick from the input vector, diagonal not normalised | partial | `world.ts` walker picks a facing; a diagonal moves at the same speed as a straight line (normalised), WA does not normalise |
| 7 | Click (or tap) to walk to a point, keyboard takes over | **missing** | WA walks along a path to the click |
| 8 | Path following: A* 8 directions, no corner cutting, tile costs | **missing** | needed by 7 and by follow |
| 9 | Stop once close enough to the click target | missing | follows from 7 |
| 10 | Follow another guest | **missing** | WA `follow` on a user list row |

## 2. Map

| # | WA behaviour | status | where / why |
|---|---|---|---|
| 11 | Tiled JSON map, tileset image per tileset, animated tiles | partial | `world.ts` loader; animation frames of a tile are not read |
| 12 | Layers in map order, `floorLayer` object layer splits behind and above | partial | `world.ts` `isOverhead`: a layer or group named above/overhead, or `above: true`; the `floorLayer` split is not read |
| 13 | Layer `opacity`, `visible`, parallax | partial | `opacity` and `visible` read; `parallaxx/y` not |
| 14 | Collision from the `collides` tile property | done | `world.ts` loader, class/property both spellings |
| 15 | Hidden layers still collide | done | `world.ts` loader |
| 16 | Spawn ladder: init, area, layer, tile, start, map start | done | `world.ts` `startRect`/`spawn`: a zone marked start, the spawn point object, the start layer, the .wam start area, then the centre |
| 17 | One map per world, map served as bytes, never in a sealed frame | done | `world.ts` `mapPath`, HTTP GET |
| 18 | WorkAdventure `.wam` world file names its map | done | `world.ts` `loadWam`, `tools/wam-e2e.js` |

## 3. Areas

| # | WA behaviour | status | where / why |
|---|---|---|---|
| 19 | Zone is a Tiled object `class: zone`/`area`, needs width and height | done | `zones.ts` `zoneFromObject` |
| 20 | Rectangle, polygon and ellipse objects as one runtime shape | partial | `world.ts` `polygonRects` turns a polygon into rows of rects; an ellipse still reads as its bounding box |
| 21 | `name`, `maxUsers`, `proximity` properties | done | `zones.ts` |
| 22 | Meeting area: talk at any distance inside it | done | `proximity.ts` `judge` |
| 23 | Silent area: no talk inside it | done | `proximity.ts` `judge` |
| 24 | Capacity: an area over `maxUsers` holds nobody new | done | `roomworld.ts` `guestOf`, `load` |
| 25 | Blocking pre-check within `proximityThreshold` before entering | partial | capacity judged against the loaded map only, not one tile ahead |
| 26 | Area body one pixel taller, feet cannot rest on the edge | done | `proximity.ts` inside test is half open on the rect |
| 27 | Enter/leave per zone, once per change | done | `zones.ts` `ZoneWatch` |
| 28 | Zone properties read on enter, never while inside | n/a | no property action in this tree yet (see 40-42) |

## 4. Talk

| # | WA behaviour | status | where / why |
|---|---|---|---|
| 29 | Conversation bubble at 96 px, 1.3x to leave | done | `proximity.ts` `BUBBLE` |
| 30 | Bubble drawn on the map, deformable ring | partial | `world.ts` view draws a ring; WA's spline is not copied (PORT_NOTES §9) |
| 31 | Group of 100 in one bubble, locked when full | not ported | a 6 peer room makes it dead code |
| 32 | Megaphone: talk to the whole room | **missing** | - |
| 33 | Podium and audience areas | **missing** | - |
| 34 | DND, back soon, silent flags on a guest | partial | frame carries a status bitfield; only the local mic state sets a bit |
| 35 | Hand raise, queue ordered by raise time, host lower to the guest | partial | WA queues them; worky raises a hand with no order |

## 5. Rooms and joining

| # | WA behaviour | status | where / why |
|---|---|---|---|
| 36 | Link to a room opens the room | done | `/?room=`/`#r=`; 128 bit id |
| 37 | Room passphrase, refused guest told why | done | `gate.ts`, sealed SPAKE2 |
| 38 | Waiting room with a `let in` button | done | `host.ts`, `presence.ts` |
| 39 | Member list with roles, mute, remove | done | `host.ts` |
| 40 | Door / exit zones that carry a guest to another room | done | `roomworld.ts` `door`, `roomOfExit`; `room.ts` `leaveFor`; office and conference carry each other's door |
| 41 | Jitsi or a meeting link on an area | **missing** | stanze is the call; an area that names a call is not read |
| 42 | Opening a web page in a side panel on an area | **missing** | - |

## 6. The person

| # | WA behaviour | status | where / why |
|---|---|---|---|
| 43 | Avatar sheet choice per guest, kept in the browser | done | `world.ts` `AVATAR`, `sheetFor` |
| 44 | Custom name, changed mid call | done | `host.ts` `change name` |
| 45 | Camera on and off, freeze frame | done | `media.ts`, `freeze-late-e2e.js` |
| 46 | Screen share | done | `screen.ts` |

## 7. Places WA is not the answer

| WA behaviour | why this tree does not copy it |
|---|---|
| `POSITION_DELAY` as a timer | the cadence follows the rules of #1, not a clock |
| protobuf over the game socket | stanze's server never learns a position (`docs/WORLD_CONTRACT.md` §0) |
| Phaser, easystarjs | canvas 2D and a small search of our own |
| server groups as the only source of talk | the mesh judges every pair locally, same rule on every page |
| viewport culling | a handful of guests per room |

---

## The count, as it stands

`done` 13, `partial` 11, `missing` 18, `not ported` 1, n/a 1, out of 46 rows.
Taken so far: #40 (doors, the office map already shipped one), #16 (the start
area the ladder lacked), and half of #20 (polygon areas).
