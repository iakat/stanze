# Queue

One line per work item. The top item is the most important.

## Open

- Incoming noise cancel with a strength step (katia 01:05): off, normal (the GTCRN pass that is there), strong (GTCRN plus a high-pass, a downward expander and a soft limiter in the same worklet). DeepFilterNet2 in wasm stays the heavy option if strong is not enough.
- Refactor round, the not-easy wins (coderobe 01:38): smaller code, same behaviour, no breakage. One commit per target, each with its diff line. Three targets are closed: the clamp idiom is one helper (a935741e), boot.ts init is the wire functions that 6004ae42 split out, and asrSync and omniSync are three-line wrappers over one syncTaps. The fourth stays open on purpose: asr.ts omniWorker is one 362 line function because omniWorkerSource stringifies it into the worker, so a split needs cfg and G as explicit parameters and a 348 MB model run to prove it; its download, cache and gate helpers are already named. The check of the other files found no repeated five-line block and no defined name without a reader. Largest functions now: lookSmall 98, lookStart 96, wireStage 88, wirePanels 88.
