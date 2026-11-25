// The FastEnhancer worker. It owns the engine and the weights; every stream
// hands it the port of its own node, and frames then cross between the audio
// thread and this worker, so no sample passes through the page.
//
// The engine is FastEnhancer Small in wasm: 512 sample frames at 48 kHz, one
// frame of output per frame of input, and its streaming state (STFT overlap,
// GRU hidden state, attention window) lives inside the module. One instance is
// one stream, so a lane builds its own from one shared module compile.
//
// The loader is in this file and not in a second script: importScripts takes a
// plain string, and the page runs under Trusted Types, which refuses one.
const MODULE = '/fe.wasm';
const WEIGHTS = '/fe.q8';

// fe.wasm is a reactor module: no _start, and fe_run takes two pointers into
// the module's memory. fe.q8 carries the weights; fe_init copies them into the
// heap and repacks them for the vector kernels, once per instance. The four
// wasi imports are wasi-libc underneath: the profiler (off) asks the clock,
// and the one line per tier on init is dropped here.
const FeWasm = (function () {
  function wasi(state) {
    return {
      clock_time_get: function (id, precision, out) {
        if (!state.ex) return 0;
        var now = Math.round((performance.now ? performance.now() : Date.now()) * 1e6);
        var dv = new DataView(state.ex.memory.buffer);
        dv.setUint32(out, now >>> 0, true);
        dv.setUint32(out + 4, Math.floor(now / 4294967296) >>> 0, true);
        return 0;
      },
      // Claim every byte offered: stdio retries a short write forever.
      fd_write: function (fd, iovs, len, written) {
        if (!state.ex) return 0;
        var dv = new DataView(state.ex.memory.buffer);
        var n = 0;
        for (var i = 0; i < len; i++) n += dv.getUint32(iovs + i * 8 + 4, true);
        dv.setUint32(written, n, true);
        return 0;
      },
      fd_close: function () { return 0; },
      fd_seek: function () { return 0; }
    };
  }

  function fetchBytes(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(url + ' ' + res.status);
      return res.arrayBuffer();
    });
  }

  // load fetches the module and the weights once per worker; create() builds
  // one instance on that copy and returns an Engine over it.
  function load(moduleUrl, weightsUrl) {
    return Promise.all([fetchBytes(moduleUrl), fetchBytes(weightsUrl)]).then(function (both) {
      return WebAssembly.compile(both[0]).then(function (module) {
        var weights = new Uint8Array(both[1]);
        return {
          create: function () {
            var state = { ex: null };
            var inst = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi(state) });
            state.ex = inst.exports;
            var ex = inst.exports;
            var ptr = ex.malloc(weights.length);
            if (!ptr) throw new Error('fe: no room for the weights');
            new Uint8Array(ex.memory.buffer, ptr, weights.length).set(weights);
            if (ex.fe_init(ptr, weights.length) !== 0) throw new Error('fe: fe_init failed');
            return new Engine(ex);
          }
        };
      });
    });
  }

  // Engine is one stream: copy a frame in, run, copy a frame out.
  function Engine(ex) {
    this.ex = ex;
    this.frame = ex.fe_web_frame();
    this.inPtr = ex.malloc(this.frame * 4);
    this.outPtr = ex.malloc(this.frame * 4);
    if (!this.inPtr || !this.outPtr) throw new Error('fe: no room for the frames');
  }

  Engine.prototype.reset = function () {
    this.ex.fe_reset();
  };

  Engine.prototype.run = function (pcm) {
    var ex = this.ex;
    var n = this.frame;
    new Float32Array(ex.memory.buffer, this.inPtr, n).set(pcm);
    ex.fe_run(this.inPtr, this.outPtr);
    return new Float32Array(ex.memory.buffer, this.outPtr, n).slice();
  };

  return { load: load };
})();

let library = null;

function loadLibrary() {
  if (!library) {
    library = FeWasm.load(MODULE, WEIGHTS);
    library.catch(() => {
      library = null;
    });
  }
  return library;
}

// Lane is one stream: its port, its engine, and a bounded queue. A worker that
// falls behind drops frames instead of growing, so the stream stays real time.
class Lane {
  constructor(id, port) {
    this.id = id;
    this.port = port;
    this.engine = null;
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
      if (!this.engine) this.engine = (await loadLibrary()).create();
      while (this.queue.length) {
        const out = this.engine.run(this.queue.shift());
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
}

const lanes = new Map();

onmessage = (event) => {
  const msg = event.data || {};
  if (msg.ev === 'attach' && msg.port) {
    const lane = new Lane(msg.id, msg.port);
    lanes.set(msg.id, lane);
    loadLibrary().then(
      () => lane.port.postMessage({ ev: 'ready' }),
      (err) => lane.port.postMessage({ ev: 'error', text: String((err && err.message) || err) }),
    );
  } else if (msg.ev === 'detach') {
    const lane = lanes.get(msg.id);
    if (lane) {
      lane.queue.length = 0;
      lane.engine = null;
      lanes.delete(msg.id);
    }
  } else if (msg.ev === 'warm') {
    void loadLibrary();
  }
};
