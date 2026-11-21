# stanze

A tiny self-hosted replacement for a meeting server: one Go binary that serves
a static browser client and a WebSocket signaling endpoint, plus an embedded
TURN relay. Media is a full mesh of direct peer to peer WebRTC connections
between browsers. The server never sees, mixes, forwards, records or transcribes
audio or video; when two peers cannot reach each other, the embedded TURN
server relays encrypted packets without being able to read them.

- One binary, no database, no external services, no third-party JS or fonts.
- Room ids are 128 bit random ids (26 characters of base32) that live only in
  memory. The first join creates the room, and the room is forgotten the moment
  its last participant leaves.
- Optional per-room passphrase, hashed with PBKDF2-HMAC-SHA256 in memory.
- No route lists, counts or names rooms. Not even at debug level.
- Mesh audio is Opus by default (whatever the browsers agree on), video VP8/VP9
  or H.264 depending on the browsers; nothing is transcoded.

## Build

Requires Go 1.24 or newer.

```sh
./build.sh              # -> bin/rooms, bin/selftest
# or
make build
```

The client is embedded with `go:embed`, so the binary is self contained
(~15 MB with `-trimpath -ldflags "-s -w"`, because the post-quantum Wasm module is embedded too).

## Run

Minimal, loopback, no relay:

```sh
./bin/rooms -listen 127.0.0.1:8095
```

With the embedded relay on a public address (this is what you want in
production, behind a TLS proxy):

```sh
TURN_SECRET=$(head -c 32 /dev/urandom | base64) \
TURN_PUBLIC_IP=203.0.113.10 \
./bin/rooms -listen 127.0.0.1:8095 -turn-port 3478
```

Then open `https://rooms.example.com/` (or `http://localhost:8095/` for local
testing), type a name, and press **enter**. A pasted room id joins that room, and
the first join creates it if it does not exist yet. An empty room field makes a
new room: the id is built in the browser and the join creates it. The passphrase
typed in the same form becomes the room passphrase when the room is created. The
room id is placed in the URL fragment (`#r=...`), so it never travels in an HTTP
request, a proxy log or a `Referer` header.

A room that nobody is in does not exist. The last peer to leave takes the room
with it, so the same id joined later is a new room: the guest types the
passphrase again and starts a fresh call with nothing carried over. A link from
the lobby is just an id, and the first join makes the room, so there is no
create route and no room can ever wait with nobody in it.

Pressing enter asks for the camera and the microphone and starts the call with
both on. A refusal or a missing device still joins, with the devices that did not
open off, and a short status line says which ones. The browser remembers the
microphone and camera choice, the media path and the denoise switch, and a stored
camera off joins without asking for the camera again. The noise filter is GTCRN:
an MIT streaming model of 192 KiB in WebAssembly, with the model, the STFT and
the inverse inside the one file, run from an `AudioWorkletNode` at the 48 kHz
rate the microphone graph asks for. Every remote tile carries a
volume slider from 0 to 200 percent (100 is normal, above 100 is a real boost),
kept per participant name, and the stats button shows per participant audio and
video bitrates, the round trip time and whether the path is direct or relayed.

The client keeps the camera and the microphone open and reconnects on its own
with a capped backoff if the signaling socket drops in the middle of a call.

## End-to-end encryption

Every room is sealed. The name, the chat and every media frame are encrypted in
the browser, and the server sees only `enc` blobs: it never receives a name,
never sends a `chat` message and keeps no room history. Names and chat lines
travel as sealed `app` payloads, media frames are sealed by
`RTCRtpScriptTransform` with a worker (`e2e-transform.js`), and the key exchange
runs in a WebAssembly module (`pq.wasm`) built from `internal/pq`. Both sides
show the same 13 character short code and six emoji on each tile, for comparison
over the call.

There is no fallback to a clear room. The link is `#r=<room>`, and a browser
that cannot install a media transform joins without a microphone and a camera
and says why instead of sending clear frames. The post-quantum module is
fetched when the lobby opens, so the join itself is only a device prompt.

The relay needs no flag for this: it forwards `enc` frames without reading
them, and there is no other chat or name path to switch off.

`getUserMedia` requires a secure context: use `http://localhost` for local
tests or TLS in front of the server. WebSocket upgrades also need a proxy that
supports them; see below.

## Flags

Every flag has an environment variable equivalent. Flags win.

| flag | env | default | meaning |
| --- | --- | --- | --- |
| `-listen` | `LISTEN` | `:8095` | HTTP listen address (put TLS in front) |
| `-stun` | `STUN_URLS` | `stun:stun.l.google.com:19302` | STUN URLs handed to browsers, repeatable or comma separated |
| `-turn-public-ip` | `TURN_PUBLIC_IP` | empty | public IP advertised for relay candidates; empty disables TURN |
| `-turn-port` | `TURN_PORT` | `3478` | UDP port of the embedded TURN server |
| `-turn-tcp-port` | `TURN_TCP_PORT` | `0` | optional TCP listener for TURN (useful when UDP is blocked) |
| `-turn-secret` | `TURN_SECRET` | empty | shared secret for ephemeral TURN credentials |
| `-turn-ttl` | `TURN_TTL` | `1h` | lifetime of issued relay credentials |
| `-turn-realm` | `TURN_REALM` | `rooms` | TURN realm |
| `-turn-url` | `TURN_URLS` | empty | extra advertised TURN URL, e.g. `turns:rooms.example.com:5349?transport=tcp` |
| `-turn-min-port` / `-turn-max-port` | `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49200` / `49300` | relay port range to open in the firewall |
| `-max-peers` | `MAX_PEERS` | `8` | peers per room (2..32) |
| `-max-rooms` | `MAX_ROOMS` | `200` | rooms alive at the same time |
| `-max-msg-bytes` | `MAX_MSG_BYTES` | `262144` | largest accepted WebSocket message (SDP + ICE) |
| `-behind-proxy` | `BEHIND_PROXY` | off | trust `X-Forwarded-For` for per-IP limits |
| `-allowed-origin` | `ALLOWED_ORIGIN` | empty | extra allowed WebSocket `Origin` (default: same host) |
| `-static-dir` | `STATIC_DIR` | empty | serve the client from disk while developing |
| `-debug` | `DEBUG` | off | verbose logs (room ids are still only logged as a 8 hex character hash) |

Room creation and join attempts are limited per client IP. Behind a reverse
proxy set `-behind-proxy` so limits apply to the real client address; only do
that when the proxy is the only way in, otherwise the header is spoofable.

## TLS offload

The server speaks plain HTTP/1.1 and expects a TLS terminator in front, e.g.:

```nginx
server {
    listen 443 ssl http2;
    server_name rooms.example.com;
    # certificate config omitted
    location / {
        proxy_pass http://127.0.0.1:8095;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1h;
    }
}
```

Set `-behind-proxy` when you add `X-Forwarded-For`. Keep the access log
without query strings: no room id is ever in a URL path or query, so a default
`$request` log line is already safe.

Firewall: TCP `8095` (only from the proxy) and, when TURN is enabled, UDP
`3478` plus the relay range `49200-49300` (and TCP `-turn-tcp-port` if used).
If you advertise `turns:` URLs, terminate TLS on the TURN port in the proxy as
well.

## Rooms and privacy

- A room id is 16 random bytes from `crypto/rand`, rendered as lowercase
  base32 (26 characters). Guessing one is not feasible.
- Rooms exist only in memory. A room is dropped in the same step that removes
  its last peer, and the passphrase digest goes with it: a later join of the
  same id starts a new room with nothing carried over. A room that nobody joined
  never exists, so nothing waits and nothing expires. Nothing is ever written to
  disk.
- There is no route that lists, counts or describes rooms. The only endpoints
  are `GET /`, the client files, `GET /ws`, `GET /QUEUE.md` and `GET /DONE.md`.
  Anything else returns `404`.
- A join to a missing room, with a wrong passphrase, or into a full room is
  answered with the same `{"t":"error","code":"unavailable"}` and the
  connection is closed. The passphrase check runs PBKDF2 against a dummy salt
  when the room does not exist, so the timing matches too.
- SDP and ICE are relayed verbatim inside one room and are never stored. A peer
  id from another room is simply unknown, so cross-room relaying is impossible.
- Logs: info level has listen addresses and counts only. Room ids appear at
  debug level as a truncated SHA-256 fingerprint, never in clear.

## Signaling protocol

One JSON object per WebSocket text frame. Client to server:

| message | fields |
| --- | --- |
| `join` | `room`, `pass` |
| `offer` / `answer` | `to`, `sdp` |
| `ice` | `to`, `candidate` |
| `enc` | `to` (empty or `*` for the room), `b` (base64 sealed blob) |
| `state` | `mic`, `cam` |
| `mod` | `to`, `action` (`kick`, `mute`, `admin`) |
| `leave` | – |
| `ping` | – |

Server to client:

| message | fields |
| --- | --- |
| `joined` | `self`, `peers[{id,mic,cam,admin}]`, `admins`, `ice[{urls,username,credential}]` |
| `peer-joined` | `peer{id,mic,cam,admin}` |
| `peer-left` | `from` |
| `offer` / `answer` | `from`, `sdp` |
| `ice` | `from`, `candidate` |
| `enc` | `from`, `b` (forwarded verbatim, never decoded) |
| `state` | `from`, `mic`, `cam` |
| `admin` | `admins` |
| `mod` | `from`, `action` |
| `kicked` | `from` |
| `error` | `code` (`unavailable`, `bad-message`) |
| `pong` | – |

A peer has no name field on the wire. The name is sealed with the chat and
arrives as an `enc` payload once the pair keys exist.

The `ice` list is per connection and carries a fresh, time limited TURN
credential (TURN REST style: `timestamp:tag` username, HMAC-SHA1 with the
shared secret). Nothing else is handed out.

Client behavior: on `joined` the new peer creates an offer towards every peer
already in the room; existing peers answer. Renegotiation uses the "perfect
negotiation" pattern (polite/impolite by peer id), so the two sides can also
start at the same time without glare. Mute and camera toggles only flip
`MediaStreamTrack.enabled`, they never renegotiate.

## Tests

`cmd/selftest` is an end to end test against a running server. It uses real
`pion/webrtc` peers, so it proves the relay and the media path, not just JSON.

```sh
./bin/rooms -listen 127.0.0.1:8095 -turn-public-ip 127.0.0.1 -turn-secret test -turn-port 3478 &
./bin/selftest -addr http://127.0.0.1:8095
```

It checks: the embedded client is served, every obvious room-listing path
(`/rooms`, `/api/rooms`, `/metrics`, `/debug`, ...) is a 404, a room id never
appears in any GET response, unknown rooms and wrong passphrases get byte
identical errors, offer/answer/ICE are relayed verbatim, `peer-left` works, a
room id is joinable again as a new room the moment its last peer leaves, the
room cap is enforced, cross-room relaying is dropped, oversized messages close
the connection, and two pion peers establish a data channel plus an Opus audio
track both directly and forced through the embedded TURN relay with the
ephemeral credentials handed out by the server.

`tools/wsjoin.py` is a dependency-free WebSocket client for a one-shot
handshake check:

```sh
python3 tools/wsjoin.py http://127.0.0.1:8095 <room-id>
```

`tools/browser-e2e.js` is the full browser test. It opens two Chromium contexts
(separate users, fake camera and microphone), has one create a room and the
other join it through the shared link, and then asserts what a user would see:
two tiles on both sides, both joined with camera and microphone on, the sealed
name on the remote tile, `connected`, a remote video with decoded frames whose
playhead keeps advancing, audio and video RTP packets arriving on both peer
connections, working mute and camera toggles, a 0 and 175 percent volume on the
remote gain, a 1 Hz stats panel with milliseconds, path, bitrates and the sealed
counters, a seamless lost connection loop, a camera off reload that asks for the
microphone only, a relay only join, no console or CSP errors, and that `/rooms`,
`/api/rooms`, `/metrics` and friends answer 404 from inside the page without
ever containing the room id. It writes one screenshot per user.

```sh
npm install --prefix /tmp/pw playwright-core@1.47.0   # or use a Playwright image
PW=/tmp/pw/node_modules/playwright-core \
ROOMSBASE=http://127.0.0.1:8095 OUTDIR=/tmp/shots \
  node tools/browser-e2e.js
```

Launch Chromium with `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream` (already set in the script) so it runs headless
without a camera. Note that a strict `script-src 'self'` CSP blocks Playwright's
`page.waitForFunction`, which evaluates inside the page; the script polls with
`page.evaluate` instead.

`tools/pq-browser-e2e.js` is the sealed suite. It joins two contexts on the one
join form and asserts the handshake, matching short codes, media through the
frame transform, sealed chat both ways, that no name or chat text appears in a
signaling frame, and that a wrong key decodes nothing. Run it the same way:

```sh
PW=/tmp/pw/node_modules/playwright-core \
ROOMSBASE=http://127.0.0.1:8095 OUTDIR=/tmp/shots \
  node tools/pq-browser-e2e.js
```

`tools/smoke.js` is the quick client check. It is small on purpose: a fresh
page joins a new room with fake devices, and the test fails on the first
uncaught exception or console error, with the stack. That catches the faults a
missing element check never sees, where the join throws and the page just sits
there. It also sends one chat line, toggles the microphone and the camera, opens
the stats panel, joins a second peer and moves one volume slider, then leaves.
`jsconfig.json` type checks the client with `tsc --checkJs`; a new error fails
the check.

```sh
make typecheck     # tsc -p . over static/app.js, no emit
make smoke         # needs a server on ROOMSBASE and PW=playwright-core
make check         # typecheck, then smoke
```

## Limits and deliberate omissions

- Mesh topology: upload bandwidth grows with the number of peers, which is why
  the default room cap is 8. There is no SFU by design.
- No recording, transcription, server side mixing or moderation beyond the room
  password. Screen share and a text chat live in the client.
- No TLS in the binary; terminate it in a proxy.
