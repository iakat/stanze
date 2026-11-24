// The FastEnhancer worker. It owns the model and the runtime, and every stream
// hands it the port of its own node. Audio frames then cross between the audio
// thread and this worker directly, so the page never touches a sample.
//
// The model is FastEnhancer Small: 512 sample frames at 48 kHz, one frame of
// output per frame of input, and five cache tensors that carry the state of the
// stream. One thread is the right setting. A frame is 10.7 ms of audio, and a
// thread pool costs more than the work at that size.
importScripts('/ort/ort.wasm.min.js');

ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

const MODEL = '/fastenhancer-s.onnx';
const FRAME = 512;
const CACHE = [[1, 512], [1, 512], [1, 48, 48], [1, 48, 48], [1, 48, 48]];
const CACHE_LEN = CACHE.map((shape) => shape.reduce((a, b) => a * b, 1));

let session = null;
let loading = null;

// load builds the session once per worker, and every lane waits on it.
function load() {
  if (session) return Promise.resolve(session);
  if (!loading) {
    loading = (async () => {
      const res = await fetch(MODEL);
      if (!res.ok) throw new Error('fastenhancer-s.onnx ' + res.status);
      const bytes = await res.arrayBuffer();
      const built = await ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
      });
      session = built;
      return built;
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

// Lane is one stream: its port, its cache state, and its own queue.
class Lane {
  constructor(id, port) {
    this.id = id;
    this.port = port;
    this.caches = CACHE_LEN.map((n) => new Float32Array(n));
    this.queue = [];
    this.busy = false;
    this.frames = 0;
    this.port.onmessage = (event) => this.push(event.data);
  }

  push(msg) {
    if (!msg || msg.ev !== 'frame' || !msg.pcm) return;
    if (this.queue.length >= 8) this.queue.shift();
    this.queue.push(msg.pcm);
    void this.drain();
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await load();
      while (this.queue.length) {
        const pcm = this.queue.shift();
        const out = await this.run(s, pcm);
        this.frames++;
        this.port.postMessage({ ev: 'frame', pcm: out }, [out.buffer]);
      }
    } catch (err) {
      this.queue.length = 0;
      const text = String((err && err.message) || err);
      this.port.postMessage({ ev: 'error', text });
      self.postMessage({ ev: 'error', id: this.id, text });
    } finally {
      this.busy = false;
    }
  }

  async run(s, pcm) {
    const feeds = { wav_in: new ort.Tensor('float32', pcm, [1, FRAME]) };
    for (const name of s.inputNames) {
      if (name === 'wav_in') continue;
      const idx = Number(name.slice('cache_in_'.length));
      feeds[name] = new ort.Tensor('float32', this.caches[idx], CACHE[idx]);
    }
    const res = await s.run(feeds);
    const y = res.wav_out.data.slice();
    for (const name of s.outputNames) {
      if (!name.startsWith('cache_out_')) continue;
      const idx = Number(name.slice('cache_out_'.length));
      this.caches[idx].set(res[name].data);
    }
    return y;
  }
}

const lanes = new Map();

onmessage = (event) => {
  const msg = event.data || {};
  if (msg.ev === 'attach' && msg.port) {
    const lane = new Lane(msg.id, msg.port);
    lanes.set(msg.id, lane);
    load().then(
      () => lane.port.postMessage({ ev: 'ready' }),
      (err) => lane.port.postMessage({ ev: 'error', text: String((err && err.message) || err) }),
    );
  } else if (msg.ev === 'detach') {
    const lane = lanes.get(msg.id);
    if (lane) {
      lane.queue.length = 0;
      lanes.delete(msg.id);
    }
  } else if (msg.ev === 'warm') {
    void load();
  }
};
