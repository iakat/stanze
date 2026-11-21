# Post-quantum end-to-end encryption (proof of concept)

The room server carries a sealed mode beside the classic one, and the join form asks for it with a box that is on by default. The
merge is in the client: the sealed join is a checkbox on the one join form, the
sealed room uses the same stage, tiles, chat and stats panel as a plain room,
and the old separate page is gone (`/e2e` answers a `302` to `/?sealed=1`, so an
old link lands on the form with the box on).

Live proof: <https://stanze.ch-test.katia.sh/?sealed=1> is the merged build on
the classic host, and its sealed rooms passed the two browser suite there
(29 checks, 0 failed). That host is now the only deployment; the old
`stanze-e2e` instance has stopped serving.

## Threat model

The server, the signaling channel, and any log or proxy between the two peers
are treated as untrusted. The goal is that none of them can recover media,
chat text, or peer names.

What an observer can still learn:

- which IP addresses talk to the server;
- when peers join and leave, and how many are in a room;
- packet timing, direction, and approximate sizes (each frame grows by a fixed
  29 bytes, so sizes are close to the media bitrate);
- an eight-hex fingerprint of the room, but not the room id;
- that DTLS-SRTP still runs underneath: it is not the protection used here, and
  the browser removes it before the encoded frames reach the page.

If a peer's device is compromised, or the short code is compared over a channel
the attacker also controls, the end-to-end guarantee is lost. That is out of
scope for this proof.

## Handshake

The handshake is a hybrid key agreement negotiated over the relay:

1. Each side generates an X25519 key pair and an ML-KEM-768 (FIPS 203) key pair.
   The public halves are sent to the peer inside an opaque relay message.
2. The peer with the lexicographically lower server id is the initiator. It
   encapsulates to the responder's ML-KEM key and does an X25519 exchange. The
   two shared secrets are concatenated and run through HKDF-SHA256 with a
   transcript of every handshake field.
3. Both sides derive pairwise, per-direction keys: one key for media this side
   sends, one for media it receives. They also derive a chat key per direction.
4. Each side computes an HMAC over the transcript as a key confirmation. Each
   side verifies the other's tag; a mismatch aborts the link.
5. Both sides show a 13-character base32 short code (the same on both ends) for
   an out-of-band MITM check. The key confirmation already proves both derived
   the same secret; the short code lets two people compare it by voice.

ML-KEM-768 runs from the Go standard library (`crypto/mlkem`), compiled to
WebAssembly. The wasm module is about 5.2 MB raw and about 1.5 MB gzipped, and
is served with `application/wasm` and gzip. The same Go package is unit tested
natively.

## Media

Each encoded audio and video frame is sealed on its own with AES-256-GCM, in a
dedicated worker through `RTCRtpScriptTransform`. The worker holds non
extractable `CryptoKey`s; raw key bytes never leave it.

Frame layout on the wire:

```
[1 byte version + key bit][12 byte random IV][ciphertext][16 byte GCM tag]
```

- Overhead is exactly 29 bytes per frame.
- The GCM associated data binds the frame to the sorted peer pair, so a frame
  from another pair, or a modified frame, fails authentication.
- Bit 0 of the first wire byte carries the codec keyframe bit. VP8 and VP9 put
  the keyframe flag in bit 0 of the first payload byte, and the receiving stack
  reads it *before* any transform to decide whether a frame starts a picture.
  If the byte were random, the stack would mark every frame as a delta frame and
  the decoder would never start; only that one bit is exposed. The rest of the
  header and all pixel data are encrypted.

Chat text and peer names are sealed with the same scheme as small application
messages, so they never appear in signaling in clear.

## Blind relay behaviour

The relay forwards an opaque `enc` message between peers and never parses it.
This happens in both modes: a sealed room is a choice of the client, not a flag
of the process, so one server serves plain and sealed rooms and no deployment
needs `-e2e` for sealing to work.

The `-e2e` flag is still there for a host that wants the server blind even for
plain clients:

- peer names in the peer list are forced to `guest`;
- plaintext `chat` messages are ignored, so there is no plaintext chat path;
- there is no join or leave history and no message history;
- logs carry paths, status, an eight-hex room fingerprint and peer counts, but
  no names, no room id, and no chat text.

A normal deployment runs without the flag. A sealed client works either way,
because its names, chat lines and media frames are `enc` blobs.

## Deployment

The proof first ran as its own deployment and route, next to the classic
server: host networking, HTTP on 8096, TURN on 3479, relay range 49310-49400,
public address 152.53.49.131.

The merged build needs no second deployment: the single `stanze` process serves
plain and sealed rooms from one binary, and a sealed link says
`#r=<room>&sealed=1` so the box comes up on the one join form. The separate
`stanze-e2e` deployment, service and route are retired; the classic host is the
only server, and its deployment manifest is `deploy/deployment.json`.

## Verification

- `go test ./internal/pq` — handshake, HKDF, confirmation, SAS, seal/open.
- `cmd/pqprobe -addr <url>` — relay and observer proof against a running
  server, including the live URL: names are `guest`, history is empty, plaintext
  chat has no path, the handshake agrees, and an observer with no key opens
  nothing.
- `cmd/selftest` — 41 checks, 0 failed, including the `/e2e` redirect and the
  three removed page assets.
- `tools/pq-browser-e2e.js` — two real headless browsers against the one join
  form with `?sealed=1`: video and audio play through the transform, chat and
  names decrypt, the short codes match and the badge carries the peer code, every
  sampled frame is exactly 29 bytes larger, no name or chat text appears in
  signaling, and an isolated frame lab proves that a wrong key decodes nothing
  while a correct key installed live starts decoding.

Measured on the live deployment: video plays at both peers, audio RMS is about
0.38, roughly 240 frames per direction are sealed and opened in the short run,
the wrong-key lab refuses over a thousand frames and decodes zero, and the
server logs contain none of the test names, chat text, or canaries.
