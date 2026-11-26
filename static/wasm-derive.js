'use strict';

// The room passphrase, derived off the main thread.
//
// Argon2id inside the key agreement module takes a visible moment and blocks
// whatever thread runs it, and the page runs a call on that thread: a passphrase
// change used to freeze the picture and the audio graph for the whole run. This
// worker loads its own copy of the module, derives the SPAKE2 scalar, answers
// once and is terminated by the page. The passphrase never leaves the browser
// and never outlives this message: the scalar is the only thing that returns,
// and a scalar is what the proof needs anyway.

const BUILD_Q = (self.location && self.location.search) || '';

function status(text) {
  try {
    self.postMessage({ error: text });
  } catch (_err) {
    /* the page is gone */
  }
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (typeof msg.pass !== 'string' || typeof msg.salt !== 'string') {
    status('bad request');
    return;
  }
  importScripts('/wasm_exec.js' + BUILD_Q);
  const started = Date.now();
  fetch('/pq.wasm' + BUILD_Q)
    .then((res) => {
      if (!res.ok) throw new Error('wasm ' + res.status);
      return res.arrayBuffer();
    })
    .then((buf) => {
      if (typeof self.Go !== 'function') throw new Error('webassembly unavailable');
      const go = new self.Go();
      // WebAssembly.instantiate without the streaming form answers a promise,
      // so its instance must be awaited: reading .instance off the promise is
      // undefined, and go.run(undefined) throws inside the chain where nobody
      // can see it.
      return WebAssembly.instantiate(buf, go.importObject).then((inst) => [go, inst]);
    })
    .then(([go, inst]) => {
      const run = go.run(inst.instance);
      const module = () => self.stanzePQ;
      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (module()) {
            clearInterval(timer);
            resolve(module());
          } else if (Date.now() - started > 30000) {
            clearInterval(timer);
            reject(new Error('module did not start'));
          }
        }, 10);
        Promise.resolve(run).catch(() => {
          /* the module runs until the worker ends */
        });
      });
    })
    .then((mod) => {
      const out = JSON.parse(mod.spakew(JSON.stringify({ pass: msg.pass, salt: msg.salt })));
      if (!out || typeof out.w !== 'string') throw new Error((out && out.error) || 'derive');
      self.postMessage({ w: out.w });
    })
    .catch((err) => status(String((err && err.message) || err)));
};
