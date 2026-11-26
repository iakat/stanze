/* GTCRN AudioWorklet. The model, the STFT and the inverse run inside the wasm
 * binary; the page fetches it and hands the bytes over in processorOptions,
 * because a worklet can only build a module from bytes it already holds.
 *
 * GTCRN runs at 16 kHz, and this worklet uses its 48 kHz mode: 768 sample
 * frames, resampled inside the wasm. The microphone graph asks for a 48 kHz
 * context, so the frame size here is always 768.
 *
 * The render quantum is 128 samples, so 768 is not a whole number of quanta:
 * the processed frames go through a ring, or the tail of every frame is lost.
 */
'use strict';

const FRAME = 768;

class GtcrnWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const wasm = options && options.processorOptions && options.processorOptions.wasm;
    this.module = null;
    this.state = 0;
    this.inPtr = 0;
    this.outPtr = 0;
    this.ready = false;
    this.alive = true;
    this.primed = false;

    this.pending = new Float32Array(FRAME);
    this.pendingLen = 0;
    this.frameOut = new Float32Array(FRAME);

    this.ring = new Float32Array(8192);
    this.ringRead = 0;
    this.ringWrite = 0;
    this.ringFill = 0;

    // Safety net: loud input that comes out near silent means the filter does
    // not match this microphone. Pass the dry signal for a while, then retry.
    this.dead = 0;
    this.bypassLeft = 0;

    // Counters for the page: frames filtered, the time the model took, and the
    // output samples that came out zero because the ring ran dry. The filter
    // runs on the audio thread, so a miss is heard, not queued.
    this.statFrames = 0;
    this.statMs = 0;
    this.statStarved = 0;

    Module({ wasmBinary: new Uint8Array(wasm) })
      .then((mod) => {
        this.module = mod;
        this.state = mod._gtcrn_create();
        this.inPtr = mod._malloc(FRAME * 4);
        this.outPtr = mod._malloc(FRAME * 4);
        this.ready = true;
      })
      .catch(() => {
        this.alive = false;
      });

    this.port.onmessage = (event) => {
      if (event.data && event.data.stop) this.alive = false;
    };
  }

  renderFrame() {
    const heap = this.module.HEAPF32;
    const inBase = this.inPtr >> 2;
    const outBase = this.outPtr >> 2;
    let inEnergy = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = this.pending[i];
      heap[inBase + i] = v;
      inEnergy += v * v;
    }
    const t0 = performance.now();
    this.module._gtcrn_process_48k(this.state, this.inPtr, this.outPtr);
    this.statMs += performance.now() - t0;
    this.statFrames++;
    if ((this.statFrames & 63) === 0) this.report();
    let outEnergy = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = heap[outBase + i];
      this.frameOut[i] = v;
      outEnergy += v * v;
    }

    const inRms = Math.sqrt(inEnergy / FRAME);
    const outRms = Math.sqrt(outEnergy / FRAME);
    if (inRms > 0.006 && outRms < inRms * 0.02) this.dead++;
    else this.dead = Math.max(0, this.dead - 1);
    if (this.dead > 30) {
      // About 500 ms of audible input and no output: stop filtering.
      this.dead = 0;
      this.bypassLeft = 300;
    }
    if (this.bypassLeft > 0) {
      this.bypassLeft--;
      this.frameOut.set(this.pending);
    }
    this.push(this.frameOut);
  }

  // report hands the counters to the page. All three are totals since the node
  // started; the page keeps the latest and does the division.
  report() {
    this.port.postMessage({
      ev: 'stats',
      frames: this.statFrames,
      ms: this.statMs,
      starved: this.statStarved,
    });
  }

  push(frame) {
    for (let i = 0; i < FRAME; i++) {
      this.ring[this.ringWrite] = frame[i];
      this.ringWrite = (this.ringWrite + 1) & (this.ring.length - 1);
    }
    this.ringFill = Math.min(this.ringFill + FRAME, this.ring.length);
    this.primed = true;
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return this.alive;
    const inp = inputs[0] && inputs[0][0];
    if (!inp) {
      out.fill(0);
      return this.alive;
    }
    if (!this.ready) {
      // Dry signal until the module is up, so the first frames are not lost.
      out.set(inp);
      return this.alive;
    }
    for (let i = 0; i < inp.length; i++) {
      this.pending[this.pendingLen++] = inp[i];
      if (this.pendingLen === FRAME) {
        this.renderFrame();
        this.pendingLen = 0;
      }
    }
    for (let i = 0; i < out.length; i++) {
      if (this.ringFill > 0) {
        out[i] = this.ring[this.ringRead];
        this.ringRead = (this.ringRead + 1) & (this.ring.length - 1);
        this.ringFill--;
      } else {
        out[i] = 0;
        this.statStarved++;
      }
    }
    return this.alive;
  }
}

registerProcessor('gtcrn', GtcrnWorkletProcessor);
