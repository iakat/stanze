/*
 The wasm loader shared by the mesh and the transcriber.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { BUILD_Q, b64d, b64e, pqModule, sealUtf8, win } from './sealed.js';
import { deviceNote, ensureIdentity } from './identity.js';
import { padRoundTripOk } from './gate.js';
import { scriptURL } from './trust.js';

// ------------------------------------------------------------- wasm loading
// loadScriptOnce inserts wasm_exec.js once; an existing window.Go skips the fetch.
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (win().Go) return resolve(null);
    const el = document.createElement('script');
    el.src = scriptURL(src);
    el.onload = () => resolve(null);
    el.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(el);
  });
}

function loadWasmModule() {
  return new Promise((resolve, reject) => {
    const Go = win().Go;
    if (!window.WebAssembly || typeof Go !== 'function')
      return reject(new Error('webassembly unavailable'));
    const go = new Go();
    fetch('/pq.wasm' + BUILD_Q)
      .then((res) => {
        if (!res.ok) throw new Error('wasm ' + res.status);
        return WebAssembly.instantiateStreaming(res, go.importObject);
      })
      .catch(async () => {
        const res = await fetch('/pq.wasm' + BUILD_Q);
        if (!res.ok) throw new Error('wasm ' + res.status);
        const buf = await res.arrayBuffer();
        return WebAssembly.instantiate(buf, go.importObject);
      })
      .then((res) => {
        go.run(res.instance); // the Go runtime does not return
        const started = Date.now();
        const timer = setInterval(() => {
          if (pqModule()) {
            clearInterval(timer);
            resolve(null);
          } else if (Date.now() - started > 30000) {
            clearInterval(timer);
            reject(new Error('wasm module did not start'));
          }
        }, 20);
      })
      .catch(reject);
  });
}

// fpShape is a fingerprint: five groups of four base32 letters, joined by dashes.
function fpShape(fp) {
  const parts = String(fp || '').split('-');
  if (parts.length !== 5) return false;
  return parts.every((part) => part.length === 4 && /^[a-z2-7]+$/.test(part));
}

// pqSelfTest runs both sides of the handshake in the module and checks that they
// agree. It runs once per page; the stats panel shows the result.
export function pqSelfTest() {
  const pq = pqModule();
  const a = JSON.parse(pq.gen());
  const b = JSON.parse(pq.gen());
  const k1 = JSON.parse(pq.idgen());
  const k2 = JSON.parse(pq.idgen());
  const sidA = b64e(crypto.getRandomValues(new Uint8Array(16)));
  const sidB = b64e(crypto.getRandomValues(new Uint8Array(16)));
  const off = JSON.parse(
    pq.initiate(
      JSON.stringify({
        self: 'a',
        peer: 'b',
        selfX: a.xpub,
        selfK: a.ek,
        selfID: k1.pub,
        selfSID: sidA,
        peerX: b.xpub,
        peerK: b.ek,
        peerID: k2.pub,
        peerSID: sidB,
      }),
    ),
  );
  const helloSig = JSON.parse(pq.idsign(JSON.stringify({ seed: k1.seed, msg: off.transcript })));
  // respond answers the hello twice, once with its identity signature and once
  // without it, which is the downgrade path.
  const respond = (sig) =>
    JSON.parse(
      pq.respond(
        JSON.stringify({
          self: 'b',
          peer: 'a',
          selfX: b.xpub,
          selfSK: b.xsk,
          selfK: b.ek,
          selfDK: b.dk,
          selfID: k2.pub,
          selfSID: sidB,
          peerX: a.xpub,
          peerK: a.ek,
          peerID: k1.pub,
          peerSID: sidA,
          epk: off.epk,
          ct: off.ct,
          ...(sig ? { sig } : {}),
        }),
      ),
    );
  const acc = respond(helloSig.sig);
  const okSig = JSON.parse(pq.idsign(JSON.stringify({ seed: k2.seed, msg: acc.transcript })));
  // Both sides pass the same gate: the peer's identity signature and its
  // confirmation tag. A missing signature on either side is refused.
  const proved = (key, tag, id, sig) =>
    JSON.parse(pq.proved(JSON.stringify({ key, transcript: off.transcript, tag, id, sig })));
  const verifyA = proved(off.keys.recvMedia, acc.confirm, k2.pub, okSig.sig);
  const verifyB = proved(acc.keys.recvMedia, off.confirm, k1.pub, helloSig.sig);
  const verifyNoSig = proved(off.keys.recvMedia, acc.confirm, k2.pub, '');
  const pt = b64e(sealUtf8.encode('sealed hello'));
  const aad = b64e(sealUtf8.encode('pq-e2e v2 chat a|b 1'));
  const sealed = JSON.parse(pq.seal(JSON.stringify({ key: off.keys.sendChat, aad, pt })));
  const openWith = (key) => JSON.parse(pq.open(JSON.stringify({ key, aad, b: sealed.b })));
  const opened = openWith(acc.keys.recvChat);
  const wrong = openWith(b64e(crypto.getRandomValues(new Uint8Array(32))));
  // The identity half: the right key verifies the transcript, another key and a
  // tampered message do not.
  const idV = (id, msg, sig) => JSON.parse(pq.idverify(JSON.stringify({ id, msg, sig })));
  const idOk = idV(k1.pub, off.transcript, helloSig.sig);
  const idOther = idV(k2.pub, off.transcript, helloSig.sig);
  const idOk2 = idV(k2.pub, acc.transcript, okSig.sig);
  const idTampered = idV(k1.pub, b64e(sealUtf8.encode('another transcript')), helloSig.sig);
  const idFp = JSON.parse(pq.idfp(JSON.stringify({ id: k1.pub })));
  // The passphrase proof: one passphrase agrees on a key and passes both
  // confirmations, a different one agrees on nothing.
  const w1 = JSON.parse(pq.spakew(JSON.stringify({ pass: 'a', salt: 'room' }))).w;
  const wBad = (() => {
    const raw = b64d(w1);
    raw[raw.length - 1] ^= 1;
    return b64e(raw);
  })();
  const passRun = (wa, wb) => {
    const start = (w, role) =>
      JSON.parse(
        pq.spakestart(
          JSON.stringify({
            w,
            role,
            a: b64e(sealUtf8.encode('a')),
            b: b64e(sealUtf8.encode('b')),
          }),
        ),
      );
    const one = start(wa, 'A');
    const two = start(wb, 'B');
    if (!one.id || !two.id) return { error: true };
    const finA = JSON.parse(pq.spakefinish(JSON.stringify({ id: one.id, msg: two.msg })));
    const finB = JSON.parse(pq.spakefinish(JSON.stringify({ id: two.id, msg: one.msg })));
    const okA = JSON.parse(pq.spakeverify(JSON.stringify({ id: one.id, tag: finB.conf })));
    const okB = JSON.parse(pq.spakeverify(JSON.stringify({ id: two.id, tag: finA.conf })));
    return {
      match: !!finA.ke && finA.ke === finB.ke,
      ok: !!(okA.ok && okB.ok),
    };
  };
  const passGood = passRun(w1, w1);
  const passBad = passRun(w1, wBad);
  // A hello without a signature is refused, which is the downgrade path.
  const noSig = respond('');
  return {
    sas: off.keys.sas,
    sasMatch: off.keys.sas === acc.keys.sas,
    pad: padRoundTripOk(),
    confirm: !!(verifyA.ok && verifyB.ok && !verifyNoSig.ok),
    open: opened.pt === pt,
    wrongKeyRefused: !!wrong.error,
    idSign:
      idOk.ok === true && idOther.ok === false && idOk2.ok === true && idTampered.ok === false,
    idUnsigned: !!noSig.error,
    idFp: fpShape(idFp.fp),
    passGood: !!(passGood.match && passGood.ok),
    passBad: !!(passBad.match === false && passBad.ok === false),
  };
}

// ensureWasm loads the script, the module and the self test once. A failed
// attempt is cleared, so the next call can try again.
let wasmLoad = null;

function ensureWasm() {
  if (state.wasmOk) return Promise.resolve();
  if (wasmLoad) return wasmLoad;
  wasmLoad = loadScriptOnce('/wasm_exec.js' + BUILD_Q)
    .then(loadWasmModule)
    .then(() => {
      const test = pqSelfTest();
      state.wasmTest = test;
      if (
        !test.sasMatch ||
        !test.confirm ||
        !test.open ||
        !test.wrongKeyRefused ||
        !test.idSign ||
        !test.idUnsigned ||
        !test.idFp ||
        !test.passGood ||
        !test.passBad
      ) {
        throw new Error('crypto self test failed');
      }
      state.wasmOk = true;
    })
    .catch((err) => {
      wasmLoad = null;
      throw err;
    });
  return wasmLoad;
}

// preloadSealed warms the module as soon as the lobby opens, so the join itself
// is only a microphone prompt and a failure stays in the note.
export function preloadSealed() {
  $('sealed-note').hidden = false;
  $('sealed-note').textContent = 'loading the post-quantum module';
  ensureReady()
    .then(() => {
      if (!$('lobby').hidden) $('sealed-note').textContent = 'pq-e2e ready, ' + deviceNote();
    })
    .catch((err) => {
      if (!$('lobby').hidden) {
        $('sealed-note').textContent =
          'the sealed client did not start: ' + (err && err.message ? err.message : err);
      }
    });
}

// ensureReady is everything a sealed join needs before it draws the stage: the
// module, the long-term identity and the pins.
export function ensureReady() {
  return ensureWasm().then(ensureIdentity);
}
