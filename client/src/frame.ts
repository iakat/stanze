/*
 The frame transform worker and its key install.
*/

import { state } from './state.js';
import { say } from './util.js';
import { scriptURL } from './trust.js';

// ------------------------------------------------------------- frame worker
export function startSealedWorker() {
  const worker = new Worker(scriptURL('/e2e-transform.js'));
  worker.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'stats') {
      state.frames[msg.pair + '|' + msg.dir + (msg.kind ? '|' + msg.kind : '')] = msg;
      paintFrameCounters();
    } else if (msg.type === 'keys-ok') {
      const waiting = state.keyWait.get(msg.pair);
      // An older handshake's import must not open this gate: the slot may hold newer keys.
      if (waiting && waiting.gen === msg.gen) {
        state.keyWait.delete(msg.pair);
        waiting.resolve(true);
      }
    } else if (msg.type === 'sample') {
      if (state.samples.length < 40) state.samples.push(msg);
    } else if (msg.type === 'error') {
      state.workerErrors.push(msg.msg || 'worker error');
      // A failed import fails the gate, so the pair builds no connection that drops every frame.
      const waiting = msg.pair && state.keyWait.get(msg.pair);
      if (waiting && (msg.gen === undefined || waiting.gen === msg.gen)) {
        state.keyWait.delete(msg.pair);
        waiting.resolve(false);
        say('the frame keys did not install; the link stays without video');
      }
    }
  };
  worker.onerror = (event) => state.workerErrors.push(String(event.message || event));
  state.worker = worker;
}

function paintFrameCounters() {
  let enc = 0;
  let dec = 0;
  for (const st of Object.values(state.frames)) {
    if (!st) continue;
    if (st.dir === 'send') enc += st.ok || 0;
    else if (st.dir === 'recv') dec += st.ok || 0;
  }
  state.encryptFrames = enc;
  state.decryptFrames = dec;
}
