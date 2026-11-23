/*
 The wire audit.
*/

import { state } from './state.js';

// ------------------------------------------------------------- wire audit
// The audit watches every signaling frame in both directions for the strings
// that must never leave the sealed channel (the name and the chat lines). It is
// the client half of the server log check.
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
  // A key or a line that belongs to a description, or to a candidate. The
  // markers are JSON keys and SDP lines, which a base64 blob can not contain.
  if (/"sdp"|"candidate"|v=0|a=fingerprint/.test(text)) state.clearSignaling++;
}
