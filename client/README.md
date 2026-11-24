# The stanze client

The page loads one script. `../static/index.html` carries a single
`<script src="/app.js">`, and that bundle is built from this directory by
`build.mjs` with esbuild. There is no framework and no runtime dependency: the
source is TypeScript, the output is one IIFE, and nothing here is imported by
the Go server.

The entry point is [src/boot.ts](src/boot.ts). It reads the preferences, wires
the markup and runs the lobby and the call. Every other module exports
functions that the entry, the room layer or another module calls; the state they
share is the one object in [src/state.ts](src/state.ts).

The line counts below are kept true by [tools/overview.mjs](tools/overview.mjs):
`make readme` rewrites them, and `make check` fails when one is stale or when a
module in `src` has no row yet.

## Entry, state and shared helpers

| File | Lines | What it does |
| --- | ---: | --- |
| [src/boot.ts](src/boot.ts) | 601 | The one entry function: wires the page, restores preferences, drives the lobby and the call. |
| [src/state.ts](src/state.ts) | 181 | The client state, one object per page. |
| [src/config.ts](src/config.ts) | 76 | Constant tables: quality and performance steps, camera looks, mask names, the face mesh rate, the room id alphabet. |
| [src/prefs.ts](src/prefs.ts) | 25 | What the browser keeps between loads, under a `rooms.` prefix. |
| [src/util.ts](src/util.ts) | 101 | Small helpers that touch nothing but their arguments and storage. |
| [src/dom.ts](src/dom.ts) | 95 | The typed element lookup; `Elements` mirrors the markup ids, so an unlisted id is a typo. |
| [src/globals.d.ts](src/globals.d.ts) | 20 | Optional globals the loader sets at run time: the wasm glue, the transcriber, the test hook. |

## Room, signalling and panels

| File | Lines | What it does |
| --- | ---: | --- |
| [src/room.ts](src/room.ts) | 267 | Create, join, wait, leave, and the lobby that drives them. |
| [src/signaling.ts](src/signaling.ts) | 186 | The websocket frames, both directions. |
| [src/peers.ts](src/peers.ts) | 331 | The mesh: one `RTCPeerConnection` per peer and what flows on it. |
| [src/gate.ts](src/gate.ts) | 594 | The room gate: the passphrase, the member list and the sealed claims. |
| [src/host.ts](src/host.ts) | 227 | The host controls in the call panel: waiting room, let in, member menus. |
| [src/lobby.ts](src/lobby.ts) | 91 | The lobby window on a desktop: dragged by its title bar, placed and remembered. |
| [src/menu.ts](src/menu.ts) | 207 | The drop-down menu bar. |
| [src/phone.ts](src/phone.ts) | 37 | The phone frame: the stylesheet folds the app frame away and a tap brings it back. |

## Media

| File | Lines | What it does |
| --- | ---: | --- |
| [src/media.ts](src/media.ts) | 164 | Camera and screen requests, the performance step, the sender bitrate and frame ceilings. |
| [src/audio.ts](src/audio.ts) | 460 | The talking light, the remote audio graph and the noise suppression worklet. |
| [src/screen.ts](src/screen.ts) | 89 | Screen share: points the screen sender at the display track, never the camera sender. |
| [src/volume.ts](src/volume.ts) | 149 | Per peer volume, remembered by identity when one is pinned. |
| [src/sfx.ts](src/sfx.ts) | 178 | The page's own sound effects, decoded once and cached. |
| [src/clock.ts](src/clock.ts) | 36 | The call clock. |
| [src/badge.ts](src/badge.ts) | 43 | The relay badge, read from the transport stats. |

## The sealed channel

| File | Lines | What it does |
| --- | ---: | --- |
| [src/handshake.ts](src/handshake.ts) | 735 | The post-quantum handshake of a pair. |
| [src/sealed.ts](src/sealed.ts) | 220 | Opaque payloads, the base64 and AAD helpers, and the sealed channel of a pair. |
| [src/frame.ts](src/frame.ts) | 50 | The frame transform worker and its key install. |
| [src/identity.ts](src/identity.ts) | 415 | The pinned identity of a peer and its fingerprint rows. |
| [src/wasm.ts](src/wasm.ts) | 246 | Loading the post-quantum module, and its self test. |
| [src/audit.ts](src/audit.ts) | 26 | The wire audit: no passphrase, name, chat line or file name leaves in the clear. |
| [src/lab.ts](src/lab.ts) | 151 | The in-page proof of the cipher, driven by the browser test. |

## Stage, transcript and effects

| File | Lines | What it does |
| --- | ---: | --- |
| [src/tiles.ts](src/tiles.ts) | 489 | The stage: one tile per peer, the row list, the corner layout, the spotlight and the volume slider. |
| [src/chat.ts](src/chat.ts) | 99 | The room log and its links. |
| [src/stats.ts](src/stats.ts) | 955 | The stats panel: media metrics per guest and the wire and crypto counters. |
| [src/asr.ts](src/asr.ts) | 1272 | Local transcription, one language and many. |
| [src/look.ts](src/look.ts) | 1930 | The drawn camera: the face mesh, the masks and the custom effect. |
| [src/devices.ts](src/devices.ts) | 808 | The device pickers of the join card and the toolbar. |
| [src/files.ts](src/files.ts) | 880 | File offers and the data channel that carries the bytes. |

## The rest of the directory

| File | What it does |
| --- | --- |
| [build.mjs](build.mjs) | Bundles `src/boot.ts` into `../static/app.js` with esbuild; `--watch` rebuilds on change. |
| [tsconfig.json](tsconfig.json) | The checker settings: ES2022, bundler resolution, no emit. |
| [eslint.config.mjs](eslint.config.mjs) | The lint rules: the recommended sets, and the security and HTML sink plugins. |
| [package.json](package.json) | The dev dependencies, all pinned to exact versions, and the build, check, lint, format and outdated scripts. |
| [.npmrc](.npmrc) | `save-exact`, so the next installed version is written as a pin. |
| [tools/overview.mjs](tools/overview.mjs) | Rewrites the counts in this file and names a module that has no row yet. |

## Checks

```sh
npm --prefix client install   # once
make client                   # bundle only
make typecheck                # tsc over src
make lint                     # eslint over the tree
make format                   # prettier
make readme                   # refresh the line counts above
make deps                     # dev dependencies behind the registry
```

`make check` runs the type check, the lint, `readme-check` and the one-browser
smoke test. `readme-check` fails on a stale count and on a module in `src` that
has no row here, so a new file cannot slip in unnamed.
