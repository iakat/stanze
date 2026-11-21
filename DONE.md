# Done

One line per work item, newest last.

- Mesh WebRTC signaling with an embedded TURN relay; the server never mixes or records media.
- 128 bit base32 room ids that live in memory only, with no route that lists rooms.
- PBKDF2 room passphrase and one generic error for every failed join.
- Per-room and per-IP limits, 256 KiB message cap, slow consumers dropped.
- Selftest with 30 checks, including pion peers direct and forced through the relay.
- Deployment `stanze` in namespace ocbot2: hostNetwork, TURN 3478, relay 49200-49300, wss through istio.
- A join now creates a missing room, and the passphrase of the first join becomes the room passphrase.
- Lobby with one enter button; an empty room field makes a new room in the browser.
- Client reconnects on its own with a capped backoff and keeps the camera and microphone open.
- Browser end-to-end run 31 of 31 checks.
- CSS: the `hidden` attribute is honoured and the lobby page no longer scrolls.
- `go.mod` on Go 1.27, built with the 1.27.4 toolchain.
