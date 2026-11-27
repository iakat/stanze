# Queue

One line per work item. The top item is the most important.

## Open

Priority order (katia 15:53):

1. WorkAdventure on worky: the room world, the walk and the zones, shipped on its own host.
2. seriesoftubes: the tube finder, then the colo tycoon in the same vein.
3. Everything else below, in the order it is listed.

Staffing (katia 15:53): one subagent per project at all times, and each of them spawns its own subagents, so both projects move without either one waiting.

- A regression test for the halo depth band (2026-11-27 17:30): the office map check passes on the old `cover` body as well, so it does not prove commit 273f3516. Write a case where a guest whose foot lands just above a band boundary draws its halo rim into the band of a plant standing in front, and watch it fail on the old code before it passes on the new one.: a guest who joins after a camera is frozen must still see the frozen still, not a live picture and not a black tile. Find why the still does not reach the new peer and fix it. The unfreeze path and the camera-off path stay as they are.
- Incoming noise cancel with a strength step (katia 01:05): off, normal (the GTCRN pass that is there), strong (GTCRN plus a high-pass, a downward expander and a soft limiter in the same worklet). DeepFilterNet2 in wasm stays the heavy option if strong is not enough.
- Refactor round, the not-easy wins (coderobe 01:38): smaller code, same behaviour, no breakage. One commit per target, each with its diff line. Three targets are closed: the clamp idiom is one helper (a935741e), boot.ts init is the wire functions that 6004ae42 split out, and asrSync and omniSync are three-line wrappers over one syncTaps. The fourth stays open on purpose: asr.ts omniWorker is one 362 line function because omniWorkerSource stringifies it into the worker, so a split needs cfg and G as explicit parameters and a 348 MB model run to prove it; its download, cache and gate helpers are already named. The check of the other files found no repeated five-line block and no defined name without a reader. Largest functions now: lookSmall 98, lookStart 96, wireStage 88, wirePanels 88.
- Post-quantum research for stanze (katia 13:50): the state of the art for the sealed channel, the identity and the transport, as a ranked shortlist. The worker was cancelled twice by the session resets today, so the report is not written yet. Scope: the X-Wing hybrid draft, ML-KEM-768 against 1024 in wasm, the 2025 masked-Keccak and clangover side channel findings, ML-DSA and SLH-DSA for the TOFU identity, HPKE with a PQ KEM against the hand rolled transcript, the Go TLS defaults, and HQC as the backup KEM.
- A photographic texture for the `guy fawkes` mask (coderobe 14:28): the mask is drawn today, shaded to read in three dimensions, because the image tool has no credit. A real photograph of the mask, warped on the face mesh, is the next step if the drawn one does not look real enough.
