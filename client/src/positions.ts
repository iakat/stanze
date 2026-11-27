/*
 Position frames: 5 Hz over the sealed files channel, and the drawing that turns
 them back into somebody walking.

 One pair, one direction: every guest holds a pair to every other guest and
 sends its place over that pair, at the cadence WorkAdventure sends at, so the
 server relays a frame per guest and never a broadcast. Nothing here decides who
 hears whom; that is the zone test of the receiver.
*/

import { state } from './state.js';
import { b64d, b64e, fileAAD, pqCall, pqModule } from './sealed.js';
import type { Point } from './proximity.js';

// POSITION_DELAY is one tick: five frames a second.
export const POSITION_DELAY = 200;

// The walk speed, and the far a lerp travels between two frames.
const WALK_SPEED = 200;
const STEP = (WALK_SPEED * POSITION_DELAY) / 1000;
// A frame older than three ticks is a stale sample and is not slid in slowly:
// the guest is drawn where it says it is.
const STALE = POSITION_DELAY * 3;
// POS_MAX_JSON bounds the plaintext of one frame, so a broken page cannot grow
// the channel.
const POS_MAX_JSON = 200;
const POS_MAX_POINT = 65535;
// The transfer field of the associated data. A literal, so a position frame
// can not be lifted onto a file of the same pair, and the reverse.
const POS_XFER = 'pos';

export type PosFrame = {
  x: number;
  y: number;
  d: number;
  n: number;
};

// Sample is what a receiver keeps: the frame, the clock it arrived on and
// whether it moved since the one before. The receiver's clock, never the
// sender's: two tabs are two machines.
type Sample = { x: number; y: number; d: number; mv: boolean; at: number; n: number };

const remotes = new Map<string, Sample>();
const seqOut = new Map<string, number>();
const seqIn = new Map<string, number>();
const DIR_X = [0, -1, 1, 0];
const DIR_Y = [1, 0, 0, -1];

export function posReset() {
  remotes.clear();
  seqOut.clear();
  seqIn.clear();
}

export function posForget(peerId: string) {
  remotes.delete(peerId);
}

// posAt is where a remote avatar stands now: the sample is drawn where the
// sender put it, and while the pair is talking the step between two frames is
// slid over a tick so a walk looks like a walk instead of five hops a second.
export function posAt(id: string, now: number, smooth: boolean): Point {
  const sample = remotes.get(id);
  if (!sample) return { x: 0, y: 0 };
  const age = now - sample.at;
  if (!smooth || !sample.mv || age >= STALE) return { x: sample.x, y: sample.y };
  const px = sample.x - DIR_X[sample.d] * STEP;
  const py = sample.y - DIR_Y[sample.d] * STEP;
  const t = Math.min(1, age / POSITION_DELAY);
  return { x: px + (sample.x - px) * t, y: py + (sample.y - py) * t };
}

// remotePoints is the exact place of every remote frame, without the slide: it
// is what the pair rule is judged on, so two pages can never disagree because
// one of them drew a step late.
export function remotePoints(): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const [id, sample] of remotes) out.set(id, { x: sample.x, y: sample.y });
  return out;
}

export function remoteDir(id: string): number {
  const sample = remotes.get(id);
  return sample ? sample.d : 0;
}

export function remoteMoving(id: string): boolean {
  const sample = remotes.get(id);
  return !!(sample && sample.mv);
}

// posFrame builds the frame of one tick from the local avatar.
export function posFrame(x: number, y: number, d: number): PosFrame {
  return {
    x: Math.round(Math.max(0, Math.min(POS_MAX_POINT, x))),
    y: Math.round(Math.max(0, Math.min(POS_MAX_POINT, y))),
    d: d === 1 || d === 2 || d === 3 ? d : 0,
    n: 0,
  };
}

// posSend seals one frame for every proven pair and puts it on the files
// channel of that pair. A pair whose channel is closed this tick is skipped:
// the next tick in 200 ms is the retry, and a queue of stale positions is worse
// than a gap. The channel is looked up here and not kept, because the pair
// drops and rebuilds it under a live call.
export function posSend(peerList: Iterable<any>, frame: PosFrame) {
  if (!state.self || state.leaving) return;
  for (const peer of peerList) {
    const dc = peer && peer.dc;
    if (!dc || dc.readyState !== 'open' || !peer.keys) continue;
    const key = state.self + '|' + peer.id;
    const n = seqOut.get(key) || 0;
    const body = { k: 'pos', ...frame, n };
    // The counter is part of the plaintext and of the associated data, so a
    // receiver opens the frame with the number the payload names and the
    // number on the wire is only a header.
    const plain = JSON.stringify(body);
    if (plain.length > POS_MAX_JSON) continue;
    const sealed = pqCall((json) => pqModule().seal(json), {
      key: b64e(peer.keys.sendChat),
      aad: b64e(fileAAD(peer.id, state.self, POS_XFER, n, state.idKey && state.idKey.pub, peer.pub && peer.pub.id)),
      pt: b64e(new TextEncoder().encode(plain)),
    });
    if (!sealed || !sealed.b) continue;
    try {
      dc.send(JSON.stringify({ t: 'pos', s: sealed.b }));
    } catch {
      // A channel that closed between the check and the send is the next
      // tick's problem.
      continue;
    }
    seqOut.set(key, n + 1);
  }
}

// posOnMessage opens one position frame of a peer. It answers the frame for the
// avatar layer, or null for anything that is not a legal one. A hostile page
// can send anything, so every field is bounded before it is used.
export function posOnMessage(peer: any, raw: any): PosFrame | null {
  if (!raw || typeof raw.s !== 'string' || !peer || !peer.keys) return null;
  const body = openBody(peer, raw.s);
  if (!body || body.k !== 'pos') return null;
  const n = Number(body.n);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (!Number.isSafeInteger(body.x) || !Number.isSafeInteger(body.y)) return null;
  if (body.x < 0 || body.x > POS_MAX_POINT || body.y < 0 || body.y > POS_MAX_POINT) return null;
  // The channel is ordered and every frame is sealed with its own counter, so
  // a repeat is a replay or a bug and is not news.
  const seen = seqIn.get(peer.id);
  if (seen !== undefined && n <= seen) return null;
  seqIn.set(peer.id, n);
  const frame: PosFrame = {
    x: body.x,
    y: body.y,
    d: body.d === 1 || body.d === 2 || body.d === 3 ? body.d : 0,
    n,
  };
  const before = remotes.get(peer.id);
  remotes.set(peer.id, {
    x: frame.x,
    y: frame.y,
    d: frame.d,
    // The moving flag does not travel: a frame that changed place is a step.
    mv: before !== undefined && (before.x !== frame.x || before.y !== frame.y),
    at: performance.now(),
    n,
  });
  return frame;
}

// openBody opens one sealed body. The counter lives in the plaintext, so the
// only way to name it before the frame is open is to try: the next number this
// pair expects, then the last accepted one (a duplicate the counter refuses),
// then zero (a pair whose channel was rebuilt).
function openBody(peer: any, blob: string): any {
  const last = seqIn.get(peer.id);
  const next = last === undefined ? 0 : last + 1;
  return openWith(peer, blob, next) || openWith(peer, blob, last === undefined ? -1 : last) || openWith(peer, blob, 0);
}

function openWith(peer: any, blob: string, seq: number): any {
  const out = pqCall((json) => pqModule().open(json), {
    key: b64e(peer.keys.recvChat),
    aad: b64e(fileAAD(peer.id, peer.id, POS_XFER, seq, state.idKey && state.idKey.pub, peer.pub && peer.pub.id)),
    b: blob,
  });
  if (!out || out.error || typeof out.pt !== 'string') return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64d(out.pt)));
  } catch {
    return null;
  }
}
