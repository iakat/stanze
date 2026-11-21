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
- QUEUE.md and DONE.md are served by the server from the binary, and a copy is published at https://ocbot-files.ch-test.katia.sh/stanze/.
