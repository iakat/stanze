// The FastEnhancer node. It cuts the audio of one stream into 512 sample
// frames and sends each frame to the worker that holds the model; the answers
// return on the same port and leave through the output.
//
// Every stream owns one node, so every stream keeps its own model state. The
// node starts after a small prebuffer, and it outputs silence until then. That
// keeps the start clean and lets a slow frame pass without a click.
const FRAME = 512;

class FastEnhancerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    this.pre = Math.max(2, Number(opt.prebuffer) || 6);
    this.inFrame = new Float32Array(FRAME);
    this.inFill = 0;
    this.queue = [];
    this.playBuf = null;
    this.playFill = 0;
    this.started = false;
    this.underruns = 0;
    this.frames = 0;
    this.port.onmessage = (event) => this.take(event.data);
    this.port.postMessage({ ev: 'hello', frame: FRAME, prebuffer: this.pre });
  }

  take(msg) {
    if (!msg || msg.ev !== 'frame') return;
    const pcm = msg.pcm;
    if (!pcm || pcm.length !== FRAME) return;
    // A worker that falls behind must not grow a queue without a bound.
    if (this.queue.length >= this.pre * 4) this.queue.shift();
    this.queue.push(pcm);
  }

  // nextFrame loads the oldest processed frame, and says whether one is ready.
  nextFrame() {
    if (this.playFill > 0) return true;
    const pcm = this.queue.shift();
    if (!pcm) return false;
    this.playBuf = pcm;
    this.playFill = FRAME;
    this.frames++;
    return true;
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.inFrame[this.inFill++] = input[i];
        if (this.inFill < FRAME) continue;
        const block = this.inFrame;
        this.inFrame = new Float32Array(FRAME);
        this.inFill = 0;
        this.port.postMessage({ ev: 'frame', pcm: block }, [block.buffer]);
      }
    } else {
      this.inFill = 0;
    }
    if (!out) return true;
    if (!this.started) {
      // Wait for the prebuffer before the first sample leaves this node.
      if (this.queue.length >= this.pre) this.started = true;
      out.fill(0);
      return true;
    }
    let at = 0;
    while (at < out.length) {
      if (!this.nextFrame()) {
        this.underruns++;
        break;
      }
      const off = FRAME - this.playFill;
      const n = Math.min(out.length - at, this.playFill);
      out.set(this.playBuf.subarray(off, off + n), at);
      this.playFill -= n;
      at += n;
    }
    if (at < out.length) out.fill(0, at);
    return true;
  }
}

registerProcessor('fastenhancer', FastEnhancerProcessor);
