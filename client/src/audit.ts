/*
 The wire audit.
*/

import { state } from './state.js';

// ------------------------------------------------------------- wire audit
// Checks every signaling frame in both directions for the passphrase, names,
// chat lines and file names, which must never leave the sealed channel. Client
// half of the server log check.
export function canary(value) {
  const s = String(value || '');
  if (s.length >= 4) state.canaries.add(s);
}

export function auditWire(where, raw) {
  const text = typeof raw === 'string' ? raw : String(raw);
  state.wireFrames++;
  for (const c of state.canaries) {
    if (text.includes(c) && state.wireLeaks.length < 20) {
      state.wireLeaks.push({ where, canary: c });
    }
  }
  // Clear sdp or candidate markers; a base64 blob never contains them.
  if (/"sdp"|"candidate"|v=0|a=fingerprint/.test(text)) state.clearSignaling++;
}
