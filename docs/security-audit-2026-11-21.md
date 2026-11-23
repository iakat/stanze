# Security audit: crypto primitives and the room passphrase

> Point in time: 2026-11-21. Since then, phase 3 of
> `docs/metadata-2026-11-23.md` removed the server side of the passphrase, so
> F3 (PBKDF2 as a CPU amplifier), F4 (the hand-written PBKDF2) and F9 (the
> passphrase as a room property) no longer have a code path and the rest of
> the findings stand as written.

## Scope

Repository: the Go/JS WebRTC room server in this tree. Read at commit
`59b4a853cdef6c1385c190bb161985162d2ff062` ("queue: clickable links and a p2p
file offer in the chat").

Size at that commit: 12,980 lines of tracked text (wasm, fonts, audio and SVG
excluded). The files that touch key material or its transport are 6,191 lines:
`internal/pq/pq.go` 324, `internal/pq/pq_test.go` 183, `cmd/pqwasm/main.go` 265,
`hub.go` 370, `ice.go` 128, `signaling.go` 307, `peer.go` 226,
`static/app.js` 3,534, `static/e2e-transform.js` 220, `static/wasm_exec.js` 575
(vendored from the Go distribution), `deploy/deployment.json` 59. Every other
file was read for call sites.

Uncommitted work in the tree while this was written: a v2 handshake that adds an
Ed25519 identity (`internal/pq/pq.go` 431 lines, sha256
`a5842a246e6529b36380e7a0c5d03eae68a244d575b1b4eee30143ab6a458bdb`;
`static/app.js` 4,080 lines, sha256
`f649265c0a25ab853298894c34611b6ecb1e02d5b8041bf8d72a315832000fe7`;
`cmd/pqwasm/main.go` 377; `static/pq.wasm` 5,359,393 bytes; the media AAD tag
renamed to `pq-e2e v2`). It was treated as read only: not edited, not staged,
not reverted. It is not a working state: `static/app.js` never signs or sends a
hello signature, so a v2 pair cannot complete a handshake as the tree stood. The
v2 notes below are a design review of that in-flight work, marked as such.

Method: every call site read; the HEAD test suite run (`go test ./...` passes);
the committed wasm rebuilt from the committed source; two throwaway Go tests
written outside the tree (a relay-in-the-middle against v1, an asymmetry check
against v2); PBKDF2 and Argon2id measured in Go on this 8 vCPU host; joins timed
against a locally built HEAD server on loopback.

Not covered: WebRTC/DTLS internals, the pion TURN server internals, browser
sandbox behaviour, and the production network policy.

## Primitives in scope

| primitive | source | used for | parameters | wrong caller consequence |
| --- | --- | --- | --- | --- |
| X25519 | `crypto/ecdh` | per-call DH half | fresh pair per join; `ECDH` rejects the all-zero secret | a caller that reuses a static key across calls loses forward secrecy; `NewPublicKey` accepts any 32 bytes, low-order points fail inside `ECDH` |
| ML-KEM-768 | `crypto/mlkem` (FIPS 203, stdlib) | KEM half | 1184 B encapsulation key, 1088 B ciphertext, 64 B seed as decapsulation key | implicit rejection turns a bad ciphertext into a wrong secret, so the confirmation tag is mandatory |
| HKDF-SHA256 | `crypto/hkdf` | key derivation | salt is the transcript, info `pq-e2e v1 keys`, 136 B output | a caller that passes a different transcript derives keys the peer cannot use; the two shared secrets have fixed 32 B lengths, so concatenation is unambiguous |
| HMAC-SHA256 | `crypto/hmac` | key confirmation | 16 B tag over `Protocol || " confirm" || transcript`; compared with `hmac.Equal` | a caller that compares tags with `==` gives a byte-wise oracle; there is none |
| AES-256-GCM | `crypto/aes` + `crypto/cipher`, and WebCrypto in the worker | chat (`pq.Seal`) and every media frame | random 96 bit IV per message, 16 B tag, AAD `protocol + pair` | random IVs are safe far below 2^32 messages per key; the AAD does not bind direction, kind or order |
| Ed25519 | `crypto/ed25519`, WebCrypto | long-term identity (v2, uncommitted only) | sign and verify only, never a KDF input | a verified signature proves continuity, not a name; the caller still has to pin or compare |
| PBKDF2-HMAC-SHA256 | hand-written in `hub.go` | room passphrase digest | 150,000 rounds, random 16 B salt, 32 B output | the only hand-rolled primitive, and it is wrong for any output length other than 32 (F4) |
| randomness | `crypto/rand`, `crypto.getRandomValues` | room id 128 bit, peer id 48 bit, salt 16 B, IV 96 bit, session id 16 B | CSPRNG only, no `Math.random` | 48 bit peer ids collide only by birthday at ~16 million peers, far above the 32 peer cap |
| TURN credentials | `pion/turn` REST helper | relay access | `HMAC-SHA1(secret, timestamp:tag)`, 1 h TTL, 8 allocations per credential | a predictable username on entropy failure (F10) |

`crypto/subtle.ConstantTimeCompare` guards the passphrase digest
(`hub.go:83`); no other secret is compared with a non-constant-time compare.

## Findings

| id | severity | one line | needs code |
| --- | --- | --- | --- |
| F1 | high | the shipped handshake authenticates nothing, so a malicious relay reads and rewrites every pair's media, chat and names | yes |
| F2 | high | the uncommitted v2 identity signs only the initiator's hello, so the responder is still unauthenticated to the initiator | yes, before it lands |
| F3 | medium | unauthenticated joins each cost 28 ms of server PBKDF2, with four hash slots and per-IP limits that are cheap to bypass | yes |
| F4 | medium | the hand-rolled PBKDF2 silently returns one round for output lengths below 32 and panics above 32 | yes |
| F5 | medium | the committed `pq.wasm` cannot be rebuilt from the committed source, and no build recipe or hash check exists | yes, build |
| F6 | low | per-call secret halves cross into JavaScript as base64 and cannot be wiped; the wasm keeps copies | yes, plus docs |
| F7 | low | sealed chat, name and media payloads carry no sequence number in the AAD, so a relay can replay them | yes |
| F8 | low | the media AAD binds the pair but not the direction or the track, so a frame moved between audio and video still authenticates | yes |
| F9 | low | the passphrase is not a room property: it is sent in clear, and an empty room forgets it, so the first joiner can set a new one | docs |
| F10 | info | CSP allows WebSocket connections to any host, and the TURN username falls back to a predictable value on entropy failure | yes |

### F1: the shipped handshake has no authentication

**What.** v1 derives keys from an X25519 and an ML-KEM-768 exchange and proves
only that both sides computed the same secret. Nothing is signed. The bundles,
the peer ids and the session are all supplied by the relay.

**Why it matters.** `E2E.md:14-16` says the server and the signalling channel are
untrusted and cannot recover media, chat or names. That is false for v1: the
server is the natural place to mount the attack, needs no exploit, and the users
see no prompt. Each side is shown a short code, but nothing requires a
comparison, and the badge reads "ready" once the confirmation tag matches, which
only proves agreement with whoever is on the wire.

**Evidence.** `internal/pq/pq.go:121` `Initiate` takes only public bundles;
`internal/pq/pq.go:166` `Accept` has no signature parameter; the transcript
(`internal/pq/pq.go:226`) hashes ids and keys but is never signed;
`static/app.js:2754` broadcasts only `x` and `m`; `static/app.js:2795` and
`static/app.js:2819` complete the handshake with no identity check. A throwaway
test against the HEAD package, outside the tree, played the relay: Alice and Bob
each ran a handshake with the relay, the relay opened Alice's sealed chat line
and re-sealed it to Bob, and Bob accepted it. Alice's short code was
`qhn5v44uxlvxc`, Bob's was `eu4chakf7ubk6`, and neither was ever compared.

**Fix.** Finish the v2 identity properly (F2), then require a verified pin or an
explicit short-code confirmation before the link is called ready. Until then,
the badge must say unverified, not ready.

**Cost.** 1 to 2 days for mutual signatures plus pin enforcement; the UI gate
alone is half a day.

### F2: v2 authenticates the responder only

**What.** In the uncommitted v2, the initiator signs the transcript and the
responder verifies it before decapsulating. The responder signs nothing.

**Why it matters.** The lower peer id is always the initiator, so the relay can
always answer as the responder: it hands Alice its own bundle, Alice signs a
transcript that contains the relay's identity key, the relay completes the
handshake and Alice's traffic is readable. Bob is protected, because he checks a
signature only Alice can make. A half-fixed protocol is worse than an unfixed
one if the badge then says verified. Pinning helps only if the user notices a new
fingerprint on that tile.

**Evidence.** In the working tree, `Accept` in `internal/pq/pq.go` checks
`VerifySignature` on the initiator's transcript before any secret is used;
`AcceptResult` has no signature field; `static/app.js` sends no `sig` in the
hello. Two throwaway tests against the uncommitted package showed both halves:
the relay as responder was accepted and opened Alice's chat, and the relay
initiating to Bob was rejected with "authentication failed: the hello does not
carry a valid identity signature".

**Fix.** Have the responder sign the same transcript (or the initiator's
signature and transcript, with a role byte for domain separation) and have the
initiator verify it before installing keys. Then bind the result to a pin:
accept only a fingerprint this browser already knows, or one the user confirmed
out of band. Also send the session id the transcript expects; the tree as it
stood did not, so v2 could not complete at all.

**Cost.** About 120 lines of Go (a responder signature in `AcceptResult`, a
`VerifySig` step in `Initiate`, three transcript fields), 150 in the client, and
tests for both directions. 1 to 2 days.

### F3: passphrase hashing is an unauthenticated CPU amplifier

**What.** Every join that reaches an existing room with a passphrase runs
150,000 PBKDF2 rounds before the passphrase is checked, and 28.1 ms of one core
was measured per attempt. Four hashes run at once and the rest queue without a
bound.

**Why it matters.** An attacker does not need the passphrase to spend server
CPU: one wrong guess costs 28 ms. The per-address limiter allows 60 joins per
minute (`signaling.go:35`), so four addresses at one attempt per second keep all
four hash slots busy and saturate roughly four cores, against a container limit
of 0.5 CPU (`deploy/deployment.json:37`). IPv6 gives an attacker a /64 for free,
and with `-behind-proxy` (`deploy/deployment.json:26`) the limiter key is
`X-Forwarded-For` (`signaling.go:62-76`), which is attacker-chosen if port 8095
is reachable without the proxy. The container runs with host networking
(`deploy/deployment.json:16`), so that port may be exposed.

**Evidence.** `hub.go:169-183` hashes before checking; `hub.go:134-137` and
`hub.go:145` cap concurrency at four with an unbounded wait queue;
`signaling.go:35` sets 60 joins per minute per address; measured 28.1 ms per
PBKDF2 and 29 ms per wrong-pass join over loopback.

**Fix.** A global join token bucket and a per-IPv6-/64 bucket, an upper bound on
waiters (refuse instead of queueing), and a cheap first-stage check (for example
a per-room HMAC of the passphrase under a random in-memory key) before the real
KDF. Do not trust `X-Forwarded-For` unless the proxy strips it from outside.

**Cost.** Half a day, about 60 lines plus tests.

### F4: the hand-rolled PBKDF2 is wrong outside its one call site

**What.** `pbkdf2SHA256` returns `out[:keyLen]` inside the loop when
`keyLen < len(out)`, which is after one iteration, not after `iter` iterations.
For `keyLen > 32` it slices beyond the 32-byte buffer and panics. The function
also handles only the first block, so it cannot produce more than 32 bytes.

**Why it matters.** The only caller asks for 32 bytes (`hub.go:78`,
`hub.go:82`), where it matches `x/crypto/pbkdf2` bit for bit, so there is no live
break. It is a trap for the next caller, and it is the one place where the
project reimplements a standard primitive.

**Evidence.** `hub.go:86-107`; measured against `golang.org/x/crypto/pbkdf2`:
iterations 1 and 2 agree for 16 bytes, iteration 3 onward does not, and a
64-byte request panics with "slice bounds out of range [:64] with capacity 32".
The 32-byte path agrees for 1, 2, 3 and 1000 iterations.

**Fix.** Delete the function and call `pbkdf2.Key(pass, salt, iter, 32,
sha256.New)`. Keep a known-answer test.

**Cost.** Five minutes, 22 lines deleted, 1 added; `x/crypto` is already in
`go.sum`.

### F5: the committed wasm is not reproducible and has no recipe

**What.** `static/pq.wasm` is the crypto boundary in the browser. No script,
Makefile target or README line records how it is built. A rebuild from an
exported HEAD tree with the installed toolchain (go1.27.4, `-trimpath`,
`-ldflags "-s -w"`) produced 5,163,979 bytes, sha256 `a7ae3f8e...`, against the
committed 5,163,819 bytes, sha256 `b837d258...`, with a different embedded Go
content build id; a rebuild inside a clean worktree, which adds the VCS stamp,
gave 5,164,002 bytes and a third hash. The toolchain version embedded in the
committed binary is go1.27.4, the same as the one used.

**Why it matters.** A reviewer cannot confirm that the wasm that runs in
browsers corresponds to the Go source that was reviewed. The repository has one
commit that touched the artefact (`cf4adc0`), and no CI check compares it with a
fresh build.

**Evidence.** Rebuild above; `static/wasm_exec.js` does match the installed
toolchain exactly (sha256 `0c949f49...`), so the loader is not the problem.

**Fix.** Add `tools/build-wasm.sh` with the exact `GOOS=js GOARCH=wasm` command,
rebuild once, and fail the selftest or CI when the committed file differs from a
fresh build. Document that a source change requires a wasm rebuild.

**Cost.** 30 minutes; about 10 lines of shell plus one check in `cmd/selftest`.

### F6: per-call secrets cross into JavaScript and cannot be erased

**What.** `gen()` returns `xsk` and `dk` as base64 strings over a JSON bridge,
and every `initiate` or `respond` call sends them back in. The page stores them
as strings at HEAD and as `Uint8Array`s in the uncommitted version. Base64
strings cannot be zeroed; the Go heap inside the wasm keeps copies; the JSON
encode and decode allocate more.

**Why it matters.** The comment that keys are "wiped in leave" is not true at the
memory level, and neither is the impression that the wasm protects the secret
halves: any script running in the origin, or an extension with page access, can
read the keys while they exist. CSP (`script-src 'self'`) removes the obvious
injection path, so this is a defence-in-depth statement, not a live hole. No size
or timing leak was found: every secret has a fixed length, base64 decoding is
data independent, and the only variable-length field in a sealed payload is the
plaintext itself, which the media layer already reveals through frame sizes.

**Evidence.** `cmd/pqwasm/main.go:56-67` returns the secrets as base64;
`static/app.js:1895` (HEAD) stores the whole bundle in `state.identity` and
`static/app.js:2825-2827` passes the secret halves back on every handshake;
`internal/pq/pq.go:283-321` copies keys into fresh buffers.

**Fix.** Keep key material inside the wasm and export handles, so the page never
sees `xsk` or `dk`; failing that, correct the comment and the claim in `E2E.md`.
`static/app.js` already zeroes its `Uint8Array` copies in the uncommitted
version, which is worth keeping.

**Cost.** A handle table in `cmd/pqwasm` is about 100 lines and changes every
call signature in `app.js`; the wording fix is 10 minutes.

### F7: no replay defence on sealed payloads

**What.** Chat, name and application payloads are sealed with a random IV and an
AAD of `protocol + pair`. There is no sequence number and no timestamp in the
AAD, and the receiver does not track anything it has seen. The chat payload does
carry a `ts` field in the uncommitted version, but the receiver ignores it and
uses its own clock.

**Why it matters.** A relay that records a sealed chat line can replay it later
in the same call; the tag verifies and the line is displayed again. The same
applies to a name message, and to media frames, which have no order binding at
all. The attacker cannot forge new text, but can duplicate old text and can
replay media to disturb the call.

**Evidence.** `static/e2e-transform.js:39-41` AAD is the pair only; in the
working tree, `sealedOnApp` in `static/app.js` decrypts and appends without any
counter, while `sealedSend` puts `ts: Date.now()` in the chat payload and nothing
checks it.

**Fix.** A per-pair, per-direction 64-bit counter in the AAD, sent in front of
each sealed application payload and on every frame header, with a window check.
Include the direction and the kind in the media AAD at the same time (F8).

**Cost.** Half a day across `pq.go`, `e2e-transform.js` and `app.js`, plus tests
for reuse and reorder; note that reconnects need an explicit counter reset.

### F8: the media AAD does not bind direction or track

**What.** One `sendMedia` key per pair is used for audio and video, and the AAD
is `pq-e2e v1 media <pair>` in both directions at HEAD (`pq-e2e v2` in the
working tree).

**Why it matters.** Reflection is already blocked because the keys are
directional, and a frame from another pair fails, so this is not a decryption
issue. But an authentic frame is not bound to the track it was sent on: a relay
can move a sealed audio frame into the video track (or the reverse), it
authenticates and is handed to the wrong decoder. It is free to fix.

**Evidence.** `static/e2e-transform.js:97-117` seals both tracks with
`slot.enc`; `static/e2e-transform.js:39-41` AAD.

**Fix.** Add `pair + dir + kind` to the AAD. A counter from F7 covers the rest.

**Cost.** 10 lines, no protocol negotiation needed if both ends ship together.

### F9: the passphrase is a join gate, not a room property

**What.** The passphrase is sent in clear in the `join` frame, the digest exists
only in memory, and the room and its digest are dropped with the last peer
(`hub.go:239-246`). There is no ownership record, and the first joiner of an
empty room sets the passphrase.

**Why it matters.** Anyone who can read the server's memory or the TLS
terminator has the passphrase itself, not a hard digest, which is the core of
answer 2. Separately, a named room can be taken over while empty: the first
joiner sets a new passphrase and becomes admin, locking the usual peers out.
That is a denial of service against custom names, not a confidentiality break.

**Evidence.** `static/app.js:1721` sends `pass`; `signaling.go:261` passes it to
`hub.join`; `hub.go:175-181` sets the digest only when the room is created;
`hub.go:239-246` deletes the room with its last peer.

**Fix.** Document the semantics where the passphrase is chosen. If named rooms
need protection while empty, store a digest, which is a product decision with its
own offline-attack consequences, and do not do it before deciding the squatting
rules.

**Cost.** Documentation only, 10 minutes.

### F10: minor hardening

**What.** The CSP uses `connect-src 'self' ws: wss:` (`main.go:343`), which
allows a WebSocket to any host. `randomUserTag` falls back to
`time.Now().UnixNano()` when `crypto/rand` fails (`ice.go:47-53`) and continues.

**Why it matters.** With `script-src 'self'` there is no injection path today, so
the broad `connect-src` is a second line that costs nothing to tighten. The TURN
fallback turns entropy failure into predictable usernames instead of an error.

**Evidence.** `main.go:343`, `ice.go:47-53`.

**Fix.** `connect-src 'self'`; return an error from `iceServersFor` when
`rand.Read` fails.

**Cost.** 15 minutes.

## Answer 1: does any part of this project roll its own crypto?

Yes, in exactly one place: `pbkdf2SHA256` in `hub.go` is a hand-written
PBKDF2-HMAC-SHA256, and it is subtly wrong for output lengths other than 32,
although the 32-byte call site is correct and matches `x/crypto/pbkdf2` byte for
byte. Every other primitive is stdlib or WebCrypto, namely X25519 and
ML-KEM-768 from `crypto/ecdh` and `crypto/mlkem`, HKDF from `crypto/hkdf`,
HMAC-SHA256, AES-256-GCM from `crypto/aes` and `crypto/cipher`, Ed25519 from
`crypto/ed25519`, the browser's non-extractable AES-GCM keys, with randomness
from `crypto/rand` and `crypto.getRandomValues`; what is bespoke is the
construction rather than the primitives, and that is where the real risk is,
because the transcript, the hybrid KDF input, the key split, the 64-bit short
code and the frame format are ours, and the shipped v1 handshake signs none of
them.

## Answer 2: why PBKDF2-HMAC-SHA256 with 150000 rounds and not Argon2id?

Because the digest is never stored and the passphrase is not hidden from the
server: it arrives in clear in the `join` frame (`static/app.js:1721`,
`signaling.go:261`), the digest lives only in RAM inside a room that dies with
its last peer (`hub.go:239-246`), so anyone who can dump the digest can dump the
passphrase too, and the only attack the work factor slows is online guessing on
`/ws`, which is already capped at 60 joins per minute per address and four
concurrent hashes; measured here, 150,000 rounds cost 28.1 ms per attempt with
zero memory hardness (32 bytes of HMAC state), against 191 ms and 64 MiB per
concurrent guess for Argon2id at 64 MiB, t=3, p=1 (99 ms at p=4), which bounds an
attacker with 100 GB/s of memory bandwidth to about 500 guesses per second by
memory traffic alone where PBKDF2 is bounded only by SHA-256 throughput. Argon2id
is not worth it for this design: it buys roughly one order of magnitude against
an attacker who already has the passphrase, 64 MiB at four hash slots would
exceed the deployment's 256 MiB memory limit (`deploy/deployment.json:37`), and
the cheap version, Argon2id 19 MiB t=2 p=1 at 28.8 ms and 19 MiB per guess, is
about 25 lines in `hub.go` with `x/crypto/argon2` already in `go.sum`, pure Go,
CGO free, no wasm and no client change, so take that only if you want memory
hardness at today's cost, and otherwise spend the effort on rate limiting.

## Recommendations, cheapest first

1. Replace the hand-rolled PBKDF2 with `x/crypto/pbkdf2` and add a
   known-answer test. 5 minutes, no behaviour change.
2. Add `tools/build-wasm.sh` with the exact command and a hash check in the
   selftest; rebuild the committed wasm from source. 30 minutes.
3. Bound joins and hashes globally and per IPv6 /64, cap the hash wait queue,
   and stop trusting `X-Forwarded-For` unless the proxy strips it. Half a day.
4. Make the short code or the pinned fingerprint a gate in the UI: unverified
   until a click, never "ready" on the confirmation tag alone. Half a day,
   client only.
5. Finish v2 with a responder signature and pin enforcement, then remove v1.
   1 to 2 days.
6. Add a per-pair, per-direction counter to the chat and media AAD, and put the
   direction and track kind in the media AAD. Half a day.
7. Correct the threat model and the key-wiping claims in `E2E.md` and the code
   comments. 1 hour.
8. Optional: Argon2id 19 MiB t=2 p=1, if memory hardness is wanted at today's
   per-attempt cost. 2 hours.

## Do not do

- Do not ship v2 as the fix for F1 while only the initiator signs.
- Do not raise PBKDF2 to 600,000 rounds: 112 ms per attempt is a cost you pay on
  every join, and the passphrase is already visible to the server.
- Do not use Argon2id at 64 MiB with four hash slots under a 256 MiB limit.
- Do not move passphrase hashing to the browser to keep the server from seeing
  the passphrase: the digest becomes a bearer token and the rate limit still has
  to exist.
- Do not persist room digests to survive an empty room before deciding the
  squatting rules.
- Do not add a third-party crypto library to the client or a second wasm build;
  the stdlib-only property is the strongest part of this design.

## Not verified

- Which flags produced the committed `pq.wasm`; the toolchain matches, the
  content build id does not, and the cause is not recorded anywhere.
- GPU, phone and low-power attack rates. The numbers above are measured on this
  host plus arithmetic bounds from memory traffic, not hardware benchmarks.
- Whether port 8095 is reachable without the proxy in production. The deployment
  uses host networking, the firewall is outside this repository.
- The uncommitted v2 client path end to end: it does not send the hello
  signature, so it cannot complete at the state that was read.
- WebCrypto Ed25519 support in the specific browser versions the client targets;
  only the code paths were read.
- Constant-time behaviour of the ML-KEM-768 decapsulation in the wasm build. The
  claim comes from the stdlib implementation, and it was not measured here.
