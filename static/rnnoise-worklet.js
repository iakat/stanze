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

    this.frameOut = new Float32Array(FRAME);
    this.outPos = FRAME;

    this.vad = 0;
    this.alive = true;
    this.port.onmessage = (event) => {
      if (event.data && event.data.stop) this.alive = false;
    };
  }

  processFrame(frame) {
    const heap = this.module.HEAPF32;
    const inBase = this.inPtr >> 2;
    const outBase = this.outPtr >> 2;
    for (let i = 0; i < FRAME; i++) heap[inBase + i] = frame[i] * 32768;
    this.vad = this.module._rnnoise_process_frame(this.state, this.outPtr, this.inPtr);
    for (let i = 0; i < FRAME; i++) this.frameOut[i] = heap[outBase + i] / 32768;
    this.outPos = 0;
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

    let done = 0;
    while (done < out.length && this.outPos < FRAME) {
      const take = Math.min(out.length - done, FRAME - this.outPos);
      out.set(this.frameOut.subarray(this.outPos, this.outPos + take), done);
      this.outPos += take;
      done += take;
    }
    return true;
  }
}

registerProcessor('rnnoise', RNNoiseProcessor);
