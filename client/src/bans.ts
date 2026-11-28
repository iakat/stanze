/*
 The bans this browser holds, one record per fingerprint per room.

 A kick is a message to the pages of one call. A ban is the note that makes the
 kick stick: it is written when an admin removes a guest, kept in this browser's
 own database beside the identity and the pins, and read before a pair is given
 keys on every later knock, including after a reload and in a new call of the
 same room.

 The list is the admin's, not the room's: the relay never learns an identity, so
 it can not hold one, and a page that is not an admin can not write here (see
 banPeer). A record is keyed by the fingerprint the peer proved, never by a nick
 or a peer id, both of which are per call. The list is bounded twice and lapses
 on its own (banlist.ts), so an admin who never comes back leaves nothing behind
 that grows.

 What this is not: a lock on the room. A guest who clears this browser's data, or
 who joins from another browser, is not banned, and a page that did not hold the
 role when the removal happened produces no record. A list the whole room
 enforces has to live where the room is decided; this tree decides it in each
 page, which is why the record is per browser.
*/

import { state } from './state.js';
import { BAN_TTL_MS, banKey, banValid, freshBan, pruneBans } from './banlist.js';
import type { BanRec } from './banlist.js';
import { isAdmin } from './util.js';
import { banStoreAll, banStoreDelete, banStorePut } from './identity.js';

// banRead answers whether a fingerprint is banned in the room of this call. It
// is the one question the handshake asks, and it reads the map this page loaded
// at the join, so it never waits on the database inside a proof.
export function banRead(fp) {
  if (!fp || !state.room) return false;
  const rec = state.banned.get(banKey(state.room, fp));
  return !!rec && freshBan(rec, Date.now());
}

// banOf is the record a menu shows for one fingerprint, or null.
export function banOf(fp) {
  if (!fp || !state.room) return null;
  const rec = state.banned.get(banKey(state.room, fp));
  return rec && freshBan(rec, Date.now()) ? rec : null;
}

// sweepBans drops what lapsed and what is over a cap from the page's copy and
// from the database. It runs at the load and after every write, so a page that
// stays open for a week holds the same list a fresh load would.
function sweepBans() {
  const { kept, removed } = pruneBans([...state.banned.values()], Date.now());
  if (!removed.length) return;
  const keep = new Set(kept.map((rec) => banKey(rec.room, rec.fp)));
  for (const [key, rec] of state.banned) {
    if (keep.has(banKey(rec.room, rec.fp))) continue;
    state.banned.delete(key);
  }
  for (const rec of removed) banStoreDelete(banKey(rec.room, rec.fp)).catch(() => {});
}

// banPeer records one fingerprint in this room. Only a page that holds the role
// to remove a guest may write: the check is here as well as in the menu, so a
// page that never held the role can not leave a record behind by another path.
// It answers false when the record was refused or when there is no local
// database; the removal itself still stands for the call either way.
export function banPeer(fp, label = '') {
  if (!fp || !state.room) return Promise.resolve(false);
  if (!isAdmin(state.self)) return Promise.resolve(false);
  const now = Date.now();
  const rec: BanRec = {
    fp,
    room: state.room,
    at: now,
    until: now + BAN_TTL_MS,
    by: (state.idKey && state.idKey.fp) || '',
    // The label is for a menu only. Nothing reads it as an identity.
    label: String(label || '').slice(0, 32),
  };
  state.banned.set(banKey(rec.room, rec.fp), rec);
  sweepBans();
  // The write is fire and forget: a page with no database keeps the ban for this
  // call, which is what a removal already did before this file existed.
  return banStorePut(banKey(rec.room, rec.fp), rec)
    .then(() => true)
    .catch(() => false);
}

// unbanPeer lifts one record and forgets it on disk. It carries the same role
// check: a list only an admin can add to is a list only an admin can shrink. A
// guest whose pair was closed for the ban is not reopened here; the record is
// gone from the next knock, which is the next join.
export function unbanPeer(fp) {
  if (!fp || !state.room) return Promise.resolve(false);
  if (!isAdmin(state.self)) return Promise.resolve(false);
  const key = banKey(state.room, fp);
  if (!state.banned.delete(key)) return Promise.resolve(false);
  return banStoreDelete(key)
    .then(() => true)
    .catch(() => false);
}

// banLoad reads the stored list into the page once per join and sweeps what
// lapsed and what is over a cap while it is there. A database that will not open
// leaves this page with no bans, which is the behaviour before this file.
export async function banLoad() {
  let rows;
  try {
    rows = await banStoreAll();
  } catch {
    return 0;
  }
  state.banned.clear();
  for (const rec of rows || []) {
    if (!banValid(rec)) continue;
    if (!freshBan(rec, Date.now())) {
      banStoreDelete(banKey(rec.room, rec.fp)).catch(() => {});
      continue;
    }
    state.banned.set(banKey(rec.room, rec.fp), rec);
  }
  sweepBans();
  return state.banned.size;
}
