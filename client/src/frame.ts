/*
 The frame transform worker and its key install.
*/

import { state } from './state.js';
import { say } from './util.js';
import { send } from './menu.js';

// ------------------------------------------------------------- frame worker
export function startSealedWorker() {
  const worker = new Worker('/e2e-transform.js');
  worker.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'stats') {
      state.frames[msg.pair + '|' + msg.dir + (msg.kind ? '|' + msg.kind : '')] = msg;
      paintFrameCounters();
    } else if (msg.type === 'keys-ok') {
      const waiting = state.keyWait.get(msg.pair);
      // An import that belongs to an older handshake must not open this gate:
      // the slot it filled may already hold newer keys.
      if (waiting && waiting.gen === msg.gen) {
        state.keyWait.delete(msg.pair);
        waiting.resolve(true);
      }
    } else if (msg.type === 'sample') {
      if (state.samples.length < 40) state.samples.push(msg);
    } else if (msg.type === 'error') {
      state.workerErrors.push(msg.msg || 'worker error');
      // A key import that failed resolves the gate false. The pair says so and
      // never builds a connection that can only drop frames.
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

export function paintFrameCounters() {
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
