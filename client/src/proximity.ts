/*
 Proximity talk: who this page is in a conversation with.

 The rule is WorkAdventure's: a named area decides first. Two guests in the same
 meeting room talk at any distance, a guest over the capacity of an area has no
 company in it, and a silent area is no talk at all. Without a shared area it is
 the conversation bubble around the guest. Nothing else connects anybody:
 there is no room wide stream and no hidden subscription.

 A side conversation (a whisper) is not part of this rule and must not be bent
 into it. `judge` is decided by place alone, so a page that lies in a frame can
 not make itself heard; a whisper is decided by consent, so it is a second and
 narrower thing: text only, on the sealed pair channel that already exists, to
 the guests that joined it. It never routes a frame of audio or video, so the
 answer below stays the only decider of who hears whom. `SIDE_MAX` and
 `sideSet` are the whole of what a whisper borrows from this file.
*/

export type Point = { x: number; y: number };

// BUBBLE is the radius of a conversation with no area in it: WorkAdventure's
// own conversation bubble, so two guests beside each other talk wherever they
// stand, inside a room or on open ground.
export const BUBBLE = 96;

// Who is where, in the terms the rule needs: the place, the areas the guest
// stands in with the radius each of them asks for, and the area that is full
// for it.
export type Guest = {
  at: Point;
  zones: { id: string; kind: string; proximity: number }[];
  full: string;
};

// order is one pair's answer.
export type Pair = { on: boolean; why: 'meeting' | 'near' | 'bubble' | 'silent' | 'full' | 'far' };

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// judge decides one pair from both guests as they stand now. It never reads a
// word a peer sent about its own state, only the places, so a page that lies in
// a frame can not make itself heard across the map.
export function judge(mine: Guest, them: Guest): Pair {
  for (const a of mine.zones) {
    if (a.kind === 'silent') return { on: false, why: 'silent' };
    const b = them.zones.find((one) => one.id === a.id);
    if (!b) continue;
    if (mine.full === a.id || them.full === a.id) return { on: false, why: 'full' };
    // A meeting room talks at any distance; any other shared area still has to
    // be close, the way a bubble follows the guest whatever floor it stands on.
    if (a.kind === 'meeting' || b.kind === 'meeting') return { on: true, why: 'meeting' };
    const r = Math.max(a.proximity, b.proximity);
    return dist2(mine.at, them.at) <= r * r ? { on: true, why: 'near' } : { on: false, why: 'far' };
  }
  for (const a of them.zones) {
    if (a.kind === 'silent') continue;
    if (dist2(mine.at, them.at) <= a.proximity * a.proximity) return { on: true, why: 'near' };
  }
  return dist2(mine.at, them.at) <= BUBBLE * BUBBLE
    ? { on: true, why: 'bubble' }
    : { on: false, why: 'far' };
}

// Proximity holds one page's conversation set, and the one word the presence
// line gives each pair.
export class Proximity {
  private near = new Set<string>();
  private why = new Map<string, string>();

  reset() {
    this.near.clear();
    this.why.clear();
  }

  build(selfId: string, guests: Map<string, Guest>): string[] {
    const mine = guests.get(selfId);
    const next = new Set<string>();
    this.why.clear();
    if (!mine) {
      this.near.clear();
      return [];
    }
    for (const [id, them] of guests) {
      if (id === selfId) continue;
      const pair = judge(mine, them);
      this.why.set(id, pair.why);
      if (pair.on) next.add(id);
    }
    this.near = next;
    return [...next];
  }

  isNear(id: string): boolean {
    return this.near.has(id);
  }

  nearIds(): string[] {
    return [...this.near];
  }

  reason(id: string): string {
    return this.why.get(id) || 'far';
  }
}

// ------------------------------------------------------------ side conversation
// A whisper is a guest plus the guests it invited, and nothing else. The bound
// is small on purpose: a side conversation is a few people saying a sentence
// each, not a second room, and every line costs one sealed frame per member on
// the same pair channel the room already pays for.
export const SIDE_MAX = 4;

// sideClean keeps a list of peer ids to the ones a page may hold: legal ids, no
// repeat, never more than SIDE_MAX, and never the given guest itself. It is what
// an invite list is cleaned with, on the sending side: a guest cannot invite
// itself, because it is already in the conversation by definition.
export function sideClean(selfId: string, ids: unknown): string[] {
  return sideIds(ids).filter((id) => id !== String(selfId || ''));
}

// sideIds is the same bounds without the self test. The membership a member
// holds must contain itself, so the list the owner sends is read with this one:
// the owner names every member, its own id included.
export function sideIds(ids: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(ids)) return out;
  for (const one of ids) {
    const id = String(one || '');
    if (!/^[0-9a-f]{12}$/.test(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= SIDE_MAX) break;
  }
  return out;
}

// sideSet is the membership of one whisper as every member holds it: the guest
// that opened it first, then the others, so two pages that were told the same
// thing in a different order still agree on the whole list. The guest reading
// this is one of the members and stays in the list: it is the list the owner
// sent, bounded and put in one order, not the owner's view of everybody else.
export function sideSet(selfId: string, ownerId: string, ids: unknown): string[] {
  const owner = String(ownerId || '');
  const rest = sideIds(ids).filter((id) => id !== owner);
  return [owner, ...rest].slice(0, SIDE_MAX).sort();
}

// sideAlive answers whether a whisper still has a conversation in it: the guest
// that owns it counts only while somebody else is still in it, because a
// whisper of one is the guest talking to itself.
export function sideAlive(selfId: string, members: string[], present: Set<string>): boolean {
  const self = String(selfId || '');
  let others = 0;
  for (const id of members) {
    if (id === self) continue;
    if (present.has(id)) others++;
  }
  return others > 0;
}
