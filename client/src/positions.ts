/*
 Position frames over the sealed files channel, and the drawing that turns them
 back into somebody walking: thirty a second while the guest walks, one a second
 while it stands still, and one at once when it stops or turns.

 One pair, one direction: every guest holds a pair to every other guest and
 sends its place over that pair, at the cadence WorkAdventure sends at, so the
 server relays a frame per guest and never a broadcast. Nothing here decides who
 hears whom; that is the zone test of the receiver.
*/

import { state } from './state.js';
import { b64d, b64e, fileAAD, pqCall, pqModule } from './sealed.js';
import type { Point } from './proximity.js';

// The cadence follows the walker instead of a fixed clock. A guest on the move
// sends thirty times a second, so a walk reads as a walk; a guest standing
// still sends IDLE_DELAY once a second, which is all a late joiner needs to
// learn where everybody is. A stop and a turn go out at once.
//
// A send can only happen on an animation frame, and two frames of a 60 Hz
// screen are 33.4 ms together but not always: a pair that lands early sums
// under that and the clock would take a third frame, which is 20 Hz and reads
// as a stutter. The threshold therefore sits under the pair, so any two frames
// count and 30 Hz holds at 60, 90 and 120 Hz alike.
export const MOVING_DELAY = 30;
export const IDLE_DELAY = 1000;

// ------------------------------------------------------------ the 1 euro filter
// A remote avatar is drawn from a filter, not from a slide between two frames.
// The 1 euro filter (Casiez, Roussel, Vogel: "1e Filter", CHI 2012) is one
// exponential low pass per axis whose cutoff rises with the speed of the
// motion: slow motion is smoothed hard, so a standing guest does not jitter,
// and fast motion is followed closely, so a walking guest does not lag its own
// position. It takes a timestamp for every step, so an irregular arrival rate
// (30 Hz walking, 1 Hz standing, a burst after a stall) needs no guess about
// the gap and no second mechanism to hide one.
//
// The three constants are the paper's, tuned for a map in pixels at the tree's
// WALK_SPEED of 160 px/s: a still guest sits at MIN_CUTOFF, and a walk puts the
// cutoff near 4 Hz, which is about 40 ms of lag and no visible ripple.
export const MIN_CUTOFF = 1.2;
export const BETA = 0.02;
export const D_CUTOFF = 1.0;

// OneEuro is the filter of one axis: the filtered place and the filtered speed,
// stepped forward in time by the drawing frame. It is never stepped backwards,
// so a clock that jumps back (a tab restored from bfcache) is clamped and not
// folded into the estimate.
class OneEuro {
  hat: number;
  dhat: number;
  at: number;

  constructor(v: number, now: number) {
    this.hat = v;
    this.dhat = 0;
    this.at = now;
  }

  // snap puts the filter on a place with no history. It is what a stop, a guest
  // out of the conversation and a first frame all need: the picture goes where
  // the sender says and the next walk starts from there, not from a stale
  // history that would drag it back.
  snap(v: number, now: number) {
    this.hat = v;
    this.dhat = 0;
    this.at = now;
  }

  step(target: number, now: number): number {
    // The step is clamped both ways: two draws in one millisecond are not a
    // divide by zero, and a tab hidden for a second is not a crawl the cutoff
    // should follow.
    const dt = Math.max(0.001, Math.min(0.25, (now - this.at) / 1000));
    this.at = now;
    const rate = 1 / dt;
    const dx = (target - this.hat) * rate;
    const aD = 1 / (1 + rate / (2 * Math.PI * D_CUTOFF));
    this.dhat = aD * dx + (1 - aD) * this.dhat;
    const cutoff = MIN_CUTOFF + BETA * Math.abs(this.dhat);
    const a = 1 / (1 + rate / (2 * Math.PI * cutoff));
    this.hat = a * target + (1 - a) * this.hat;
    return this.hat;
  }
}

// POS_MAX_JSON bounds the plaintext of one frame, so a broken page cannot grow
// the channel.
const POS_MAX_JSON = 200;
const POS_MAX_POINT = 65535;
// A sheet index comes from the sender: bounded here, clamped by the receiver.
const POS_MAX_SHEET = 63;
// The transfer field of the associated data. A literal, so a position frame
// can not be lifted onto a file of the same pair, and the reverse.
const POS_XFER = 'pos';

export type PosFrame = {
  x: number;
  y: number;
  d: number;
  a: number; // the sheet this page picked: the avatar is the sender's
  n: number;
};

// Sample is what a receiver keeps: the place the sender reported, the clock it
// arrived on, whether it moved since the frame before, and the filter that draws
// it. The receiver's clock, never the sender's: two tabs are two machines.
type Sample = {
  x: number;
  y: number;
  d: number;
  a: number;
  mv: boolean;
  at: number;
  n: number;
  fx: OneEuro | null;
  fy: OneEuro | null;
};

const remotes = new Map<string, Sample>();
const seqOut = new Map<string, number>();
const seqIn = new Map<string, number>();

export function posReset() {
  remotes.clear();
  seqOut.clear();
  seqIn.clear();
}

export function posForget(peerId: string) {
  remotes.delete(peerId);
}

// posAt is where a remote avatar is drawn now: the filtered place, stepped to
// this frame. A guest that is not moving, a pair that is not talking and a page
// with no filter yet are drawn exactly where the sender put them, so a standing
// guest never creeps and a grey avatar never drifts.
export function posAt(id: string, now: number, smooth: boolean): Point {
  const sample = remotes.get(id);
  if (!sample) return { x: 0, y: 0 };
  if (!smooth || !sample.mv) {
    if (sample.fx) sample.fx.snap(sample.x, now);
    if (sample.fy) sample.fy.snap(sample.y, now);
    return { x: sample.x, y: sample.y };
  }
  if (!sample.fx) sample.fx = new OneEuro(sample.x, now);
  if (!sample.fy) sample.fy = new OneEuro(sample.y, now);
  return { x: sample.fx.step(sample.x, now), y: sample.fy.step(sample.y, now) };
}

// remotePoints is the exact place of every remote frame, unfiltered: it is what
// the pair rule is judged on, so two pages can never disagree because one of
// them drew a step late.
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

// remoteSheet is the sheet the sender chose, or -1 before its first frame.
export function remoteSheet(id: string): number {
  return remotes.get(id)?.a ?? -1;
}

// posFrame builds the frame of one tick from the local avatar.
export function posFrame(x: number, y: number, d: number, a: number): PosFrame {
  return {
    x: Math.round(Math.max(0, Math.min(POS_MAX_POINT, x))),
    y: Math.round(Math.max(0, Math.min(POS_MAX_POINT, y))),
    d: d === 1 || d === 2 || d === 3 ? d : 0,
    a: Math.max(0, Math.min(POS_MAX_SHEET, Math.floor(Number(a) || 0))),
    n: 0,
  };
}

// posDelay is how long to wait before the next frame. A walking guest sends at
// about thirty a second, and one frame per pair, so the cost grows with the
// room. A guest standing still sends once a second, which is all a late
// joiner needs to learn where everybody is.
export function posDelay(moving: boolean): number {
  return moving ? MOVING_DELAY : IDLE_DELAY;
}

// shouldSend answers whether this animation frame is a frame of the cadence. A
// stop or a turn goes out at once, so the last step of a walk and the new
// facing are never held back by a slow clock.
export function shouldSend(now: number, lastAt: number, moving: boolean, edge: boolean): boolean {
  return edge || now - lastAt >= posDelay(moving);
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
      aad: b64e(
        fileAAD(
          peer.id,
          state.self,
          POS_XFER,
          n,
          state.idKey && state.idKey.pub,
          peer.pub && peer.pub.id,
        ),
      ),
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
    a: Number.isSafeInteger(body.a) && body.a >= 0 && body.a <= POS_MAX_SHEET ? body.a : 0,
    n,
  };
  const before = remotes.get(peer.id);
  const now = performance.now();
  // A frame that changed place is a step, and the filter that draws it is kept:
  // it is stepped to this frame by the draw, not by the arrival, so a burst of
  // two frames costs no smoothing and a stall costs no crawl.
  const moved = before !== undefined && (before.x !== frame.x || before.y !== frame.y);
  remotes.set(peer.id, {
    x: frame.x,
    y: frame.y,
    d: frame.d,
    a: frame.a,
    mv: moved,
    at: now,
    n,
    fx: before && moved ? before.fx : null,
    fy: before && moved ? before.fy : null,
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
  return (
    openWith(peer, blob, next) ||
    openWith(peer, blob, last === undefined ? -1 : last) ||
    openWith(peer, blob, 0)
  );
}

function openWith(peer: any, blob: string, seq: number): any {
  const out = pqCall((json) => pqModule().open(json), {
    key: b64e(peer.keys.recvChat),
    aad: b64e(
      fileAAD(
        peer.id,
        peer.id,
        POS_XFER,
        seq,
        state.idKey && state.idKey.pub,
        peer.pub && peer.pub.id,
      ),
    ),
    b: blob,
  });
  if (!out || out.error || typeof out.pt !== 'string') return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64d(out.pt)));
  } catch {
    return null;
  }
}
