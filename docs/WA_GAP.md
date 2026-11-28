# WorkAdventure vs stanze: what stands, what is missing

`docs/WA_PARITY.md` counts 46 in-map behaviours (movement, zones, talk, rooms,
the person) and is the ledger for those. It does not answer the other question:
*if somebody ran a real WorkAdventure world on this tree, what would break?*
This file answers that one. Same status words.

Read against `github.com/workadventure/workadventure` `master` and
`docs.workadventu.re` on 2026-11-28, and against this tree at `025b26b`.

Three questions decide every row: **does a map authored for WA load**, **does a
guest get the same thing to do**, **does an admin get the same controls**. A row
that is `missing` is a feature, not a bug; nothing here is broken.

---

## 1. What already stands

Verified by reading the code, not by trusting the ledger.

| WA capability | stanze | where |
|---|---|---|
| Tiled JSON map, tilesets, collision, layers, opacity, overhead | done | `world.ts` loader, `isOverhead` |
| `.wam` world file naming the map | done | `world.ts` `loadWam`, `tools/wam-e2e.js` |
| Zones: `zone`/`area`, rect + polygon, `maxUsers`, `silent`, `start` | done | `zones.ts`, `world.ts` `wa` bag |
| Doors via `exitUrl` | done | `roomworld.ts` `roomOfExit` |
| Proximity talk, bubble radius, meeting/silent areas | done | `proximity.ts` `judge` |
| Position wire 5 Hz, interpolate 200 ms, extrapolate 100 ms | done | `positions.ts` |
| Four facings, walk cycle, idle frame, body box, tile collision | done | `world.ts` |
| Camera on/off, freeze frame, screen share | done | `media.ts`, `screen.ts` |
| Noise reduction | done, and better than WA's | `audio.ts` GTCRN wasm, local |
| Local transcription | **ahead of WA** | `asr.ts`, vosk + omnilingual |
| Room passphrase | done | `gate.ts` sealed SPAKE2 |
| Waiting room, member list, roles, mute, kick | done | `host.ts` |
| Chat log, file offers over a data channel | done | `chat.ts`, `files.ts` |
| Custom name, avatar sheet choice | done | `host.ts`, `world.ts` `AVATAR` |
| End-to-end sealed media frames | **ahead of WA** | `sealed.ts`, `static/e2e-transform.js` |

The tree is not a WA clone with holes. On privacy and voice quality it is
ahead; on the map-authoring surface it is behind.

---

## 2. The gap, by what a WA author would notice first

### 2.1 Map authoring: the scripting API

| WA capability | status | note |
|---|---|---|
| `script` property on the map, a JS file run in the page | **missing** | the single biggest gap. WA maps carry behaviour in a script: NPCs, FTUE popups, custom UI, item pickups. A WA map with a script loads here and is silently inert |
| `WA.chat.sendChatMessage`, `WA.chat.onChatMessage` | **missing** | needs the script host first |
| `WA.player.*` (position, moveTo, setProperty, tags) | **missing** | |
| `WA.room.*` (load, setTiles, onEnterZone/onLeaveZone) | **missing** | zone enter/leave *is* in `zones.ts` `ZoneWatch`; the script hook is what is absent |
| `WA.state` variables, shared and per-player | **missing** | a script cannot share state between guests |
| `WA.ui.*` (popup, modal, menu commands, registerMenuCommand) | **missing** | |
| `WA.nav.*`, `WA.controls.*` (disable controls, camera lock) | **missing** | |
| `WA.event` broadcast between guests | **missing** | the mesh is there; the API is not |
| iframe areas: a URL opened on a zone | **missing** | see 2.4 |
| NPCs driven by a script | **missing** | |
| Inline map editor (place objects, define areas, live) | **missing** | WA authors without Tiled have no path here |

Cost note: a script host is not one feature. It is an isolated frame, a message
bus, and a permission model. Roughly the size of `handshake.ts`. It is also the
one row that would unlock most of the others (popups, UI, NPCs, state, events
all live behind it).

### 2.2 Movement, as a guest feels it

| WA capability | status | note |
|---|---|---|
| Run with a modifier key, 2.5x | **missing** | `world.ts` has `WALK_SPEED` and one speed. WA's run is 2.5x (`PORT_NOTES` §0 row 4) |
| Click or tap to walk there, along a path | **missing** | no click-to-move, no A* |
| Path following: 8 directions, no corner cutting, tile costs | **missing** | blocks click-to-walk and follow |
| Follow another guest | **missing** | |
| Diagonal movement not normalised | partial | `world.ts` normalises: a diagonal is as fast as a straight line, WA's is faster |
| Drag the map to look around | **missing** | camera is fixed to the avatar |
| Rebindable keys | **missing** | hardcoded `WASD`/arrows in `world.ts` `KEYS` |
| Idle / away status shown on the avatar | partial | a status bitfield travels; only the local mic sets a bit (`presence.ts`) |

### 2.3 Conversation at scale

| WA capability | status | note |
|---|---|---|
| Megaphone: one guest speaks to the whole room | **missing** | a deliberate decision so far (`zones.ts` header says so). The pricing page sells it as a capability, and a speaker zone is how WA runs talks |
| Podium + audience: speaker seen and heard, audience listen-only | **missing** | row 33. Follows from megaphone |
| Raise hand, ordered queue, host gives the floor | partial | a hand bit exists; no queue order, no floor grant (`host.ts` `hand-e2e.js`) |
| Whisper / private side conversation | **missing** | not a WA feature either; noted so it is not mistaken for a gap |
| Multi-party video beyond a small room | not ported | WA's own mesh is similar; both lean on a group size. `maxPeers` 8 |
| Live streaming (RTMP out) | **missing** | Business tier only in WA |

### 2.4 Chat, files, presence

| WA capability | status | note |
|---|---|---|
| Direct messages / private conversation | **missing** | `chat.ts` is a room log only: `addChatLine`, `chatEmpty`, `clearChat`. WA has DMs and group chat |
| Images, videos, arbitrary files inline in chat | partial | `files.ts` sends bytes over a data channel; no inline preview, no paste-image |
| Chat persistence across a reload | **missing** | the log is in memory |
| Availability status (busy, away) on the avatar | partial | same bit as 2.2 |
| Mute on tab hidden | **missing** | WA gates the mic on a hidden tab; this tree only stops the stats poll and parks the drawn camera (`boot.ts` `visibilitychange`) |
| Virtual background: blur or replace | **missing** | `look.ts` is a drawn face mesh and masks, not a background segmenter |

### 2.5 The person

| WA capability | status | note |
|---|---|---|
| Several people sharing their screen at once | partial | one `screen` transceiver per peer; a second share replaces the first |
| Screen annotations (desktop app) | **missing** | WA 1.35 desktop app only |
| Camera background images | **missing** | same as 2.4 |
| Desktop app | not ported | out of scope: this is a page |

### 2.6 Admin, safety, operations

| WA capability | status | note |
|---|---|---|
| Bans that outlive the room | **missing** | `host.ts` kicks; no ban list, no persistence |
| Tags, roles, rights from an identity provider | partial | `trust.ts` and `host.ts` roles; no tag/rights model, no IdP |
| SSO-protected access | **missing** | passphrase only. WA has SSO, and `idm.lkl.li` exists on this box |
| Visitors list with consent and a privacy policy per world | **missing** | nothing records a visitor |
| Analytics (who came, when, how long) | **missing** | nothing is counted, on purpose so far |
| Signed webhooks, Zapier / n8n triggers | **missing** | |
| Team/Outlook/Google Calendar integration | not ported | out of scope for a self-hosted tree |

### 2.7 The map, the last few percent

| WA capability | status | note |
|---|---|---|
| Animated tiles | partial | tile animation frames are not read (`world.ts`) |
| `floorLayer` split of behind/above | partial | `isOverhead` reads names and `above`; WA's layer split is not read |
| Parallax layers | **missing** | `parallaxx/y` ignored |
| Ellipse areas as a real ellipse | partial | reads as its bounding box (`polygonRects`) |
| Jitsi room on an area | **missing** | `world.ts` recognises `jitsiRoom` and falls back to a plain meeting area. stanze *is* the call, so the only missing part is the external-link case |
| Web page in a side panel on an area | **missing** | `openWebsite` is not read |

---

## 3. What is a decision, not a gap

These are `not ported` on purpose, and the reason is in the tree:

| WA behaviour | why not |
|---|---|
| protobuf over the game socket, server knows positions | the server never learns a position (`WORLD_CONTRACT.md` §0); this is the reason the tree exists |
| Phaser, easystarjs, the WA rendering stack | canvas 2D, a small search of our own |
| server-side groups as the only source of talk | the mesh judges each pair locally, same rule on every page |
| viewport culling | a handful of guests per room |
| Teams / Outlook / Google Calendar | hosted-service integrations |
| Desktop app, screen annotations | out of scope for a page |

---

## 4. If the goal is "a WA world runs here unchanged"

Ordered by what unblocks the most, and by risk:

1. **Script host** (`script` property, isolated frame, message bus, `WA.*`
   subset: `chat`, `player`, `room`, `state`, `ui`, `event`). Unblocks NPCs,
   FTUE, custom UI, pickups, and most of 2.1 in one move. Largest single item.
2. **Click-to-walk + A\*** and **run key**. The two things every guest tries in
   the first ten seconds. `positions.ts` and `world.ts` already carry the
   constants; `PORT_NOTES` §3-4 has the numbers.
3. **Megaphone + podium/audience**, and the hand queue with an order. Needed to
   run a talk, which is half of what WA is sold for.
4. **Bans + a visitors/analytics table.** The first two operational things an
   admin asks for. Both are small and both need persistence the tree does not
   have yet.
5. **iframe / `openWebsite` areas.** Small once the script frame exists.
6. **DMs and chat persistence.** `chat.ts` is a log; the shape for a second
   channel is not there.
7. **Parallax, animated tiles, `floorLayer`, ellipse.** Map polish. Small each,
   visible only on maps that use them.
8. **Virtual backgrounds, multi-share, mute-on-hidden.** Comfort features.
9. **SSO.** `idm.lkl.li` already exists; the passphrase gate is the thing to
   put behind it.
10. **Integrations** (Teams, calendar, webhooks). Only meaningful with an admin
    surface, which the tree does not have.

Item 1 is the decision point. Everything in 2.1 and half of 2.3 through 2.6 is
"a script could do this"; without a script host each one has to be built into
the page, one at a time.

---

## 5. The count

Second file, second ledger, same words as `WA_PARITY.md`.

| status | rows |
|---|---|
| done | 12 |
| done, and ahead of WA | 3 (noise reduction, local transcription, sealed media) |
| partial | 10 |
| missing | 35 |
| not ported | 3 |

63 rows in the tables above, plus the six decisions in §3 that carry no status.
`WA_PARITY.md` (46 rows, in-map): done 13, partial 11, missing 18, n/a 1, not
ported 1. The two files do not overlap: this one starts where a map ends.

Missing, by area: scripting 11, movement 6, chat/presence 4, conversation at
scale 4, admin and safety 5, map polish 3, the person 2. The scripting block
alone is a third of the gap, and it is the one that would close the most of the
rest.
