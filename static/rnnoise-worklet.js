/* RNNoise AudioWorklet. The wasm module is inlined in rnnoise-sync.js and
 * loaded synchronously here, which is the only way a worklet can get wasm.
 *
 * RNNoise works on 480 sample frames (10 ms at 48 kHz). The worklet buffers
 * the 128 sample render quanta into 480 sample frames and pads the output
 * with silence while the first frames are still being processed.
 */
'use strict';

const FRAME = 480;

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.module = self.createRNNWasmModuleSync();
    this.state = this.module._rnnoise_create(0);
    this.inPtr = this.module._malloc(FRAME * 4);
    this.outPtr = this.module._malloc(FRAME * 4);

    this.pending = new Float32Array(FRAME + 256);
    this.pendingLen = 0;

    // Output ring: 480 is not a multiple of the 128 sample render quantum, so
    // the processed frames go through a FIFO. Without it the tail of every
    // frame was dropped and the result sounded robotic.
    this.ring = new Float32Array(4096);
    this.ringRead = 0;
    this.ringWrite = 0;
    this.ringFill = 0;

    this.frameOut = new Float32Array(FRAME);

    this.vad = 0;
    this.alive = true;

    // Safety net: if a loud input comes out near silent, the filter is wrong
    // for this microphone. Pass the dry signal for a while, then try again.
    this.dead = 0;
    this.bypassLeft = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.stop) this.alive = false;
    };
  }

  processFrame(frame) {
    const heap = this.module.HEAPF32;
    const inBase = this.inPtr >> 2;
    const outBase = this.outPtr >> 2;
    let inEnergy = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = frame[i] * 32768;
      heap[inBase + i] = v;
      inEnergy += v * v;
    }
    this.vad = this.module._rnnoise_process_frame(this.state, this.outPtr, this.inPtr);
    let outEnergy = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = heap[outBase + i] / 32768;
      this.frameOut[i] = v;
      outEnergy += v * v;
    }

    const inRms = Math.sqrt(inEnergy / FRAME);
    const outRms = Math.sqrt(outEnergy / FRAME);
    if (inRms > 200 && outRms < inRms * 0.02) this.dead++;
    else this.dead = Math.max(0, this.dead - 1);
    if (this.dead > 30) {
      // 300 ms of audible input and no output: stop filtering.
      this.dead = 0;
      this.bypassLeft = 500;
    }
    if (this.bypassLeft > 0) {
      // About 5 s of the untouched signal, then a fresh attempt.
      this.bypassLeft--;
      this.frameOut.set(frame);
    }
    this.push(this.frameOut);
  }

  push(frame) {
    for (let i = 0; i < FRAME; i++) {
      if (this.ringFill === this.ring.length) {
        // Full: drop the oldest sample instead of overwriting the queue.
        this.ringRead = (this.ringRead + 1) % this.ring.length;
        this.ringFill--;
      }
      this.ring[this.ringWrite] = frame[i];
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
      if (this.ringFill < this.ring.length) this.ringFill++;
    }
  }

  pull(n) {
    const out = new Float32Array(n);
    const take = Math.min(n, this.ringFill);
    for (let i = 0; i < take; i++) {
      out[i] = this.ring[this.ringRead];
      this.ringRead = (this.ringRead + 1) % this.ring.length;
    }
    this.ringFill -= take;
    // Keep the latency near one frame if the two clocks drift apart.
    if (this.ringFill > FRAME * 2) {
      const drop = this.ringFill - FRAME;
      this.ringRead = (this.ringRead + drop) % this.ring.length;
      this.ringFill = FRAME;
    }
    return out;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    if (!this.alive) return false;

    const input = inputs[0];
    if (input && input.length) {
      // Average the channels: RNNoise is mono.
      const frames = input[0].length;
      if (input.length === 1) {
        this.pending.set(input[0], this.pendingLen);
        this.pendingLen += frames;
      } else {
        for (let i = 0; i < frames; i++) {
          let sum = 0;
          for (let c = 0; c < input.length; c++) sum += input[c][i];
          this.pending[this.pendingLen + i] = sum / input.length;
        }
        this.pendingLen += frames;
      }
      while (this.pendingLen >= FRAME) {
        this.processFrame(this.pending.subarray(0, FRAME));
        this.pending.copyWithin(0, FRAME, this.pendingLen);
        this.pendingLen -= FRAME;
      }
    }

    const pcm = this.pull(out.length);
    out.set(pcm);
    return true;
  }
}

registerProcessor('rnnoise', RNNoiseProcessor);
