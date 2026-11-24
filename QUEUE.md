# Queue

One line per work item. The top item is the most important.

## Open

- Incoming noise cancel with a strength step (katia 01:05): off, normal (the GTCRN pass that is there), strong (GTCRN plus a high-pass, a downward expander and a soft limiter in the same worklet). DeepFilterNet2 in wasm stays the heavy option if strong is not enough.
- Refactor round, the not-easy wins (coderobe 01:38): smaller code, same behaviour, no breakage. One commit per target, each with its diff line. Four targets are open: boot.ts init is 367 lines, asr.ts omniWorker is 342, asrSync and omniSync are twins, and the clamp idiom repeats at eight sites. Check every other TypeScript file in client/src as well.
