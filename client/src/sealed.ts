/*
 Opaque payloads, the base64 and AAD helpers, and the sealed channel of a pair.
*/

import { B32 } from './config.js';
import { state } from './state.js';
import { send } from './menu.js';
import { connectPeer, onCandidate, onDescription } from './peers.js';
import { sealedSetE2E } from './gate.js';

// ---------------------------------------------------------------- sealing
//
// The join carries no name, the chat avoids the server message, and every
// encoded media frame goes through an AES-GCM transform in a worker. The keys
// come from the WebAssembly build of X25519 + ML-KEM-768 (pq.wasm) through the
// JSON bridge in wasm_exec.js, so the relay only ever sees opaque blobs.
// The wasm and its shim must be the build this page is: app.js carries the build
// query, so both fetches inherit it and a cached old pair can never meet a newer
// page, which would fail every handshake without a word.
export const BUILD_Q =
  '?' + (((document.currentScript as HTMLScriptElement) || { src: '' }).src.split('?')[1] || 'v=1');

// The short code is 13 base32 characters: fine to compare on a screen, clumsy to
// read aloud. The same bits are shown as six OpenMoji drawings with a different
// shape and a different name each, so two people on a voice call can compare them
// without spelling anything and without confusing two of them. The third field
// is the file name of the drawing in static/openmoji.
const VERIFY_EMOJI = [
  ['⚓', 'anchor', '2693'],
  ['🔔', 'bell', '1F514'],
  ['🚲', 'bicycle', '1F6B2'],
  ['🌵', 'cactus', '1F335'],
  ['📷', 'camera', '1F4F7'],
  ['🕯', 'candle', '1F56F'],
  ['🥕', 'carrot', '1F955'],
  ['🕐', 'clock', '1F550'],
  ['☁️', 'cloud', '2601'],
  ['👑', 'crown', '1F451'],
  ['🐬', 'dolphin', '1F42C'],
  ['🐉', 'dragon', '1F409'],
  ['🥁', 'drum', '1F941'],
  ['🦅', 'eagle', '1F985'],
  ['🐟', 'fish', '1F41F'],
  ['👻', 'ghost', '1F47B'],
  ['🎸', 'guitar', '1F3B8'],
  ['🔨', 'hammer', '1F528'],
  ['🚁', 'helicopter', '1F681'],
  ['🔑', 'key', '1F511'],
  ['🧲', 'magnet', '1F9F2'],
  ['🍄', 'mushroom', '1F344'],
  ['🦉', 'owl', '1F989'],
  ['✏️', 'pencil', '270F'],
  ['🚀', 'rocket', '1F680'],
  ['✂️', 'scissors', '2702'],
  ['🚢', 'ship', '1F6A2'],
  ['☀️', 'sun', '2600'],
  ['☂️', 'umbrella', '2602'],
  ['🎻', 'violin', '1F3BB'],
  ['🐝', 'bee', '1F41D'],
  ['🐌', 'snail', '1F40C'],
];

export const sealUtf8 = new TextEncoder();

/** @returns {any} */

export function win() {
  return window as any;
}

/** @returns {any} */

export function pqModule() {
  return win().stanzePQ;
}

export function b64e(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if ('toBase64' in view) return (view as any).toBase64();
  let raw = '';
  for (let i = 0; i < view.length; i += 0x8000)
    raw += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  return btoa(raw);
}

export function b64d(s) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function encOpaque(obj) {
  return b64e(sealUtf8.encode(JSON.stringify(obj)));
}

export function decOpaque(s) {
  return JSON.parse(new TextDecoder().decode(b64d(s)));
}

// A sealed name never reaches the server, but it does reach a tile and a chat
// line, so control characters are dropped exactly like a plain name.
export function cleanSealedName(raw) {
  // Control characters are what this removes, so the expression carries them.
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
}

export function shortPeer(id) {
  return String(id || '').slice(0, 6);
}

export function pairLabel(peerId) {
  return [state.self, peerId].sort().join('|');
}

export function verifyEmojis(code) {
  const out = [];
  for (const ch of String(code || '').toLowerCase()) {
    const index = B32.indexOf(ch);
    if (index < 0) continue;
    out.push(VERIFY_EMOJI[index % VERIFY_EMOJI.length]);
    if (out.length === 6) break;
  }
  return out;
}

export function verifyText(code) {
  return verifyEmojis(code)
    .map((pair) => pair[0])
    .join(' ');
}

// The associated data names the protocol version, the pair and the sequence
// number of the frame, so a blob sealed for one pair can not be replayed into
// another, and one captured frame can not be shown twice.
export function chatAAD(peerId, seq) {
  return sealUtf8.encode('pq-e2e v2 chat ' + pairLabel(peerId) + ' ' + seq);
}

// A file chunk uses the chat key of the pair and the same shape of associated
// data: the version, the pair, the sender, the transfer id and the chunk
// number. The sender id is written the same way on both sides, so a chunk can
// not be moved to another pair or another transfer, and the chunk number must
// rise by one in the order the data channel delivers it.
export function fileAAD(peerId, fromId, xfer, seq) {
  return sealUtf8.encode(
    'pq-e2e v2 file ' + pairLabel(peerId) + ' from ' + String(fromId) + ' ' + xfer + ' ' + seq,
  );
}

// sealingAvailable answers the only question that matters for the media: can
// this browser put every encoded frame through the worker before it leaves? A
// browser without the transform would send the microphone and the camera in the
// clear, so the answer gates the media, not just a badge.
export function sealingAvailable() {
  return (
    typeof RTCRtpScriptTransform === 'function' &&
    typeof RTCRtpSender !== 'undefined' &&
    'transform' in RTCRtpSender.prototype &&
    typeof RTCRtpReceiver !== 'undefined' &&
    'transform' in RTCRtpReceiver.prototype
  );
}

// ------------------------------------------------------------- opaque payloads
export function sealedSendOpaque(to, obj) {
  send({ t: 'enc', to, b: encOpaque(obj) });
}

// pqCall parses one JSON answer of the module and turns any fault into null, so
// a broken bridge can never throw through an event handler.
/** @param {(json: string) => string} fn @param {any} input @returns {any} */

export function pqCall(fn, input) {
  try {
    return JSON.parse(fn(JSON.stringify(input)));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- sealed signaling
// The code of a pair is derived from the keys of that pair, never from the
// local self test: that one is ours alone and proves nothing about the other
// side. A mesh has one pair per two guests, so two different codes in one room
// are normal and only the code of one pair can be checked by voice. A pair
// whose key confirmation failed is the alarm, and it stays on that pair.
export function sealedRoomCodes() {
  const codes = new Set();
  for (const peer of state.peers.values()) if (peer.sas) codes.add(peer.sas);
  return codes;
}

export function sealedFailedPairs() {
  const out = [];
  for (const peer of state.peers.values()) if (peer.ready === 'failed') out.push(peer);
  return out;
}

export function sealedPairNames(pairs) {
  return pairs.map((peer) => peer.name || shortPeer(peer.id)).join(', ');
}

export async function sealedOnOffer(peer, sdp) {
  if (state.leaving) return;
  // The answer is made from the keys the worker holds. A first frame without
  // them stays sealed, and no retry brings it back.
  if (peer.keyPromise && !(await peer.keyPromise.catch(() => false))) {
    sealedSetE2E(peer, 'failed');
    return;
  }
  if (!state.peers.has(peer.id)) return; // the peer left while the keys installed
  const target = connectPeer(peer.id, false);
  for (const cand of target.candEarly || []) onCandidate(target, cand);
  target.candEarly = [];
  await onDescription(target, 'offer', sdp);
}
