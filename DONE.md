# Done

One line per work item, newest last.

- Mesh WebRTC signaling with an embedded TURN relay; the server never mixes or records media.
- 128 bit base32 room ids that live in memory only, with no route that lists rooms.
- PBKDF2 room passphrase and one generic error for every failed join.
- Per-room and per-IP limits, 256 KiB message cap, slow consumers dropped.
- Selftest with 30 checks, including pion peers direct and forced through the relay.
- Deployment `stanze` in namespace ocbot2: hostNetwork, TURN 3478, relay 49200-49300, wss through istio.
- A join creates a missing room, and the passphrase of the first join becomes the room passphrase.
- Lobby with one enter button; an empty room field makes a new room in the browser.
- Client reconnects on its own with a capped backoff and keeps the camera and microphone open.
- CSS: the `hidden` attribute is honoured and the lobby page no longer scrolls.
- Custom room names up to 64 characters, with a random 128 bit id suggested on load and a `new id` button.
- Media path choice before the join: automatic, direct only, or relay only.
- Screen share with its own button and a resolution and frame rate picker.
- RNNoise microphone filter, on by default, with a switch in the lobby and in the call.
- Own camera preview mirrored by default, with a mirror toggle; remote tiles stay unmirrored.
- The name is stored in the browser and comes back on the next visit.
- The client has a 1990s window look: grey panels, bevelled edges, navy title bars, no rounded corners.
- `go.mod` declares Go 1.27 and the tree builds with the 1.27.4 toolchain.
- The selftest matches the room name policy: an id with characters outside the set is refused, a plain name is created.
- RNNoise works: the wasm bundle and the processor are served as one worklet module with a `self` shim, and the offline test passes audio (in rms 0.142, out 0.108).
- The client carries the name stanze: the page title and both title bars.
- Every tile carries a mute flag and a camera flag, sent over the signaling socket as a `state` message on each toggle and on join.
- The own tile is always drawn, with an avatar, the name and the flags, even when the browser gives no camera.
- Host controls from a three dot menu on a remote tile, shown on hover to the admin only: give admin, mute, remove from room.
- The first peer in a room is the admin; when the admin leaves, the role moves to the peer that has been in the room longest.
- Cartoon sound cues on join, leave, mic on and mic off, from the Hanna-Barbera sound effects library on archive.org, stored as mono Opus (27 kB for all four, mp3 kept as a fallback).
- A sound cue never waits in a line: a new one replaces the one that plays, and each cue plays in full.
- The microphone and the camera are off until their button is pressed; the first press asks for the permission, and a visitor can watch without sharing.
- The rnnoise output goes through a ring buffer, so no frame tail is dropped: 480 is not a multiple of the 128 sample render quantum.
- The rnnoise worklet has a safety net: if loud input comes out near silent for 300 ms, it passes the dry signal for 5 s and then tries again.
- QUEUE.md and DONE.md are served by the server from the binary, and a copy is published at https://ocbot-files.ch-test.katia.sh/stanze/.
