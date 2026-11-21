# Queue

One line per work item. The top item is the most important.

## In work, not live yet


## Open

- Bigger type and AAA+ contrast, whole page: the body text is 11 to 12 px and the muted grey (#404040) on the grey panel (#c0c0c0) is about 5.7 to 1. Raise the base size, take every text pair to AAA+ (7 to 1 or better, aim higher), and keep the 90s desktop look. It must hold with the page font as shipped, not only with a userstyle (katia 18:54, 18:55, 19:13).
- PQC audit, and an answer to two questions: does any part roll its own crypto, and why does the room passphrase use PBKDF2-HMAC-SHA256 (150000 rounds) and not Argon2id. Check each primitive, each place where our own pieces meet a primitive, and the wasm build of ML-KEM-768. Give a written answer with a recommendation and the cost of a change (katia 18:44). Note from a first read of internal/pq/pq.go: the primitives are standard library, but the handshake, transcript and key split are ours, and no signature binds a peer id to a key, so the relay that hands out public keys can sit in the middle until two people compare the code (katia 18:47).

- Volume settings store guest names: `rooms.vol.<name>` keeps a list of who a guest called on a shared machine. Key the setting with the peer key fingerprint (or the peer id) and keep no name on disk; if that is too much, keep the setting in memory for the call only (katia 18:53, coderobe 18:53).
- Let the call window move: the guest must be able to drag the stage or the lobby card around the screen instead of a fixed box (katia 18:55).
- Show the per peer volume slider and the `e2e ready` badge only while the pointer is over that tile, so a full room is a picture and not a panel. On a touch screen there is no hover, so the control must open on a tap (coderobe 17:40).
- Give the per peer volume slider a natural scale: today the gain is linear in amplitude, so the top half of the travel changes little and the bottom half jumps to silence. Map the slider position to loudness, for example a power curve, keep 100 percent at unity, and keep the stored setting in the same unit (coderobe 17:40).
- Add a sound switch: the four cues and the lost connection chime are always on, they can only be made quiet by hand.
- Extend the stats panel with jitter, packet loss and a short history graph; today it shows bitrates, round trip time and the path.
- Give the per peer volume a stable identity beyond the name: two guests with the same name share one stored setting.
- Client side mesh transcription: one volunteer peer runs ASR on the incoming streams inside the page and sends the text as sealed chat, with a label that says who transcribed. Model: vosk small, 68 MB down, one model only. Moonshine base (274 MB) is refused as too heavy (coderobe 17:23). Addendum (coderobe 17:23): the feature is off by default and nothing is preloaded. The tab fetches the 68 MB model only when the user asks for transcription, shows the download, and keeps it in the browser cache; a refused download leaves the call working, because a heavy page is bad for every guest. One engine only: vosk has its own API and quality, so moonshine would be a second integration, not a setting (coderobe 17:25).
- Add a performance slider: one control that trades picture quality against bandwidth and compute, as the jitsi version has. The slider must also set the outgoing resolution of the camera, so a weak network or a weak machine sends fewer pixels instead of dropping sound and frames. One stored value per guest, and the default must stay the full quality path (katia 18:43).
