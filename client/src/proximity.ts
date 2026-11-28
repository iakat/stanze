/*
 Proximity talk: who this page is in a conversation with.

 The rule is WorkAdventure's: a named area decides first. Two guests in the same
 meeting room talk at any distance, a guest over the capacity of an area has no
 company in it, and a silent area is no talk at all. Without a shared area it is
 the conversation bubble around the guest. Nothing else connects anybody:
 there is no room wide stream and no hidden subscription.
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
