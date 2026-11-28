/*
 The rules of a ban: what one record is, which records have lapsed, and which
 ones a full list lets go.

 Nothing here touches a browser API, a key or the wire, so the same rules run on
 a page and in a test (client/tools/banlist-test.mjs). The store itself lives in
 bans.ts; the records live in the same local database as the identity and the
 pins.
*/

// A ban is one fingerprint in one room. The fingerprint is what a page proves in
// the handshake; a nick and a peer id are per call and are kept in the record as
// a label for a menu only, never as a key. `by` is the fingerprint of the page
// that issued it, `at` when, and `until` when it lapses by itself, so a list
// nobody comes back to revoke does not grow for ever.
export interface BanRec {
  fp: string;
  room: string;
  at: number;
  until: number;
  by: string;
  label: string;
}

// A ban lapses after a month. WorkAdventure keeps a ban until an admin lifts it,
// which needs a room-wide record the relay does not have: this tree's ban is a
// note in one admin's browser, so it has to end without that admin.
export const BAN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A room keeps 32 bans and a browser keeps 256 across its rooms. Over the cap the
// oldest go first: the newest removal is the one an admin still means.
export const BAN_ROOM_CAP = 32;
export const BAN_ALL_CAP = 256;

// banKey is the database key of one ban. The length prefix keeps the pair
// unambiguous whatever a typed room id holds, so two rooms can never share a key
// by concatenation ("ab"+"c" and "a"+"bc").
export function banKey(room, fp) {
  const r = String(room || '');
  return r.length + ':' + r + String(fp || '');
}

// banValid is the shape a record has to have before it is read or written: a
// number that is not a number or a record with no fingerprint is a torn write,
// not a ban.
export function banValid(rec) {
  return !!(
    rec &&
    typeof rec.fp === 'string' &&
    rec.fp.length > 0 &&
    typeof rec.room === 'string' &&
    rec.room.length > 0 &&
    Number.isFinite(rec.at) &&
    Number.isFinite(rec.until)
  );
}

// freshBan answers whether one record still means something at `now`. A record
// whose clock lapsed is dropped on the next sweep, so a ban is never enforced for
// ever by accident.
export function freshBan(rec, now) {
  return banValid(rec) && rec.until > now;
}

// banHeld answers whether `fp` is banned in `room` at `now`.
export function banHeld(list, room, fp, now) {
  if (!room || !fp) return false;
  for (const rec of list || []) {
    if (rec && rec.room === room && rec.fp === fp && freshBan(rec, now)) return true;
  }
  return false;
}

// pruneBans splits a list into the records that stay and the ones to delete:
// everything that lapsed, everything over the per-room cap (oldest first), then
// everything over the cap for the whole browser (oldest first again). It is
// order-stable by `at` and then by key, so one sweep always drops the same rows
// and a test can name them.
export function pruneBans(list, now, roomCap = BAN_ROOM_CAP, allCap = BAN_ALL_CAP) {
  const kept: BanRec[] = [];
  const removed: BanRec[] = [];
  const age = (rec) => (Number.isFinite(rec && rec.at) ? rec.at : 0);
  const byAt = (a, b) => age(a) - age(b) || (banKey(a.room, a.fp) < banKey(b.room, b.fp) ? -1 : 1);
  for (const rec of list || []) {
    if (!banValid(rec)) {
      if (rec) removed.push(rec);
      continue;
    }
    if (freshBan(rec, now)) kept.push(rec);
    else removed.push(rec);
  }
  kept.sort(byAt);
  // The per-room cap: a room's oldest entries are the ones that go.
  const perRoom = new Map<string, BanRec[]>();
  for (const rec of kept) {
    const rows = perRoom.get(rec.room);
    if (rows) rows.push(rec);
    else perRoom.set(rec.room, [rec]);
  }
  const over = new Set<BanRec>();
  for (const rows of perRoom.values()) {
    if (rows.length <= roomCap) continue;
    for (const rec of rows.slice(0, rows.length - roomCap)) over.add(rec);
  }
  // The cap for the whole browser. A per-room drop can only make this smaller,
  // so one pass over the survivors in age order is enough.
  let rest = kept.filter((rec) => !over.has(rec));
  if (rest.length > allCap) {
    const spare = rest.length - allCap;
    for (let i = 0; i < spare; i++) over.add(rest[i]);
  }
  rest = kept.filter((rec) => !over.has(rec));
  for (const rec of kept) if (over.has(rec)) removed.push(rec);
  return { kept: rest, removed };
}
