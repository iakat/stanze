/*
 Position frames over the sealed files channel, and the drawing that turns them
 back into somebody walking: twenty five a second while the guest walks, one a
 second while it stands still, and one at once when it stops or turns.

 One pair, one direction: every guest holds a pair to every other guest and
 sends its place over that pair, at the cadence WorkAdventure sends at, so the
 server relays a frame per guest and never a broadcast. Nothing here decides who
 hears whom; that is the zone test of the receiver.
*/

import { state } from './state.js';
import { b64d, b64e, fileAAD, pqCall, pqModule } from './sealed.js';
import type { Point } from './proximity.js';

// The cadence follows the walker instead of a fixed clock. A guest on the move
// sends MOVING_DELAY twenty five times a second, so a walk reads as a walk;
// a guest standing still sends IDLE_DELAY once a second, which is all a late
// joiner needs to learn where everybody is. A stop and a turn go out at once.
export const MOVING_DELAY = 40;
export const IDLE_DELAY = 1000;

// A measured gap is clamped to this window: below it a burst is not a reason to
// snap, above it a stall is not a reason to slide for a second. A first frame
// takes the ceiling, so it is drawn where it says it is.
const MIN_GAP = 16;
const MAX_GAP = 150;
// POS_MAX_JSON bounds the plaintext of one frame, so a broken page cannot grow
// the channel.
const POS_MAX_JSON = 200;
const POS_MAX_POINT = 65535;
// A sheet index comes from the sender, so it is bounded here and clamped again
// against the receiver's own list: a hostile page can not name a sheet away.
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

// Sample is what a receiver keeps: the frame, the place before it, the clock it
// arrived on, how long it took to arrive, and whether it moved since the one
// before. The receiver's clock, never the sender's: two tabs are two machines.
type Sample = {
  x: number;
  y: number;
  px: number;
  py: number;
  d: number;
  a: number;
  mv: boolean;
  at: number;
  gap: number;
  n: number;
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

// posAt is where a remote avatar stands now. The sender's cadence is not fixed
// (twenty a second walking, one a second standing), so the slide runs over the
// gap actually measured between the last two frames instead of assuming a tick,
// and it starts from where the avatar was drawn, not from a guess about the
// walk speed. That keeps a walk smooth at any rate and never overshoots: an
// avatar is drawn between two places its sender really reported.
export function posAt(id: string, now: number, smooth: boolean): Point {
  const sample = remotes.get(id);
  if (!sample) return { x: 0, y: 0 };
  const age = now - sample.at;
  // A still guest, a pair that is not talking, or a frame from a peer that has
  // gone quiet: the sample is drawn where the sender put it.
  if (!smooth || !sample.mv || age >= sample.gap) return { x: sample.x, y: sample.y };
  const t = Math.max(0, Math.min(1, age / sample.gap));
  return { x: sample.px + (sample.x - sample.px) * t, y: sample.py + (sample.y - sample.py) * t };
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
// about twenty five a second, which is smooth enough for a walk and still one
// frame per pair, so the cost grows with the room. A guest standing still sends
// once a second, which is all a late joiner needs to learn where everybody is.
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
  // The gap between this frame and the one before it is what the slide runs
  // over. It is clamped: a husk of a tab that reported nothing for a second is
  // not a reason to slide a walk over a second, and a burst after a stall must
  // not make the next step instant.
  const gap = before ? Math.max(MIN_GAP, Math.min(MAX_GAP, now - before.at)) : MAX_GAP;
  remotes.set(peer.id, {
    x: frame.x,
    y: frame.y,
    px: before ? before.x : frame.x,
    py: before ? before.y : frame.y,
    d: frame.d,
    a: frame.a,
    // The moving flag does not travel: a frame that changed place is a step.
    mv: before !== undefined && (before.x !== frame.x || before.y !== frame.y),
    at: now,
    gap,
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
