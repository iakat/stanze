/* The rules of a ban, without a browser: cap, expiry and key shape.
 *
 * The page's list lives in IndexedDB, which a plain node run does not have, so
 * this test covers the part that has to be right on its own: what lapses, what
 * goes when a room or the browser is over its cap, and that two rooms never
 * share a key. The TypeScript is compiled by esbuild, which the client already
 * depends on, so the check needs nothing new.
 *
 *   node client/tools/banlist-test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'banlist.ts'), 'utf8');
const { transform } = await import('esbuild');
const js = await transform(src, { loader: 'ts', format: 'esm', target: 'es2022' });
// A data URL keeps the module out of the tree and out of the bundle.
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(js.code, 'utf8').toString('base64')
);
const { BAN_TTL_MS, BAN_ROOM_CAP, BAN_ALL_CAP, banKey, banHeld, freshBan, pruneBans } = mod;

const NOW = 1_800_000_000_000;
const rec = (room, fp, at, until = at + BAN_TTL_MS) => ({
  fp,
  room,
  at,
  until,
  by: 'issuer000000',
  label: 'a guest',
});

test('a key names one room and one fingerprint, never a nick', () => {
  assert.equal(banKey('ab', 'cdef'), '2:abcdef');
  assert.notEqual(banKey('ab', 'cdef'), banKey('abc', 'def'));
  assert.notEqual(banKey('ab', 'cdef'), banKey('ab', 'cdeg'));
});

test('a record lapses on its own clock', () => {
  const r = rec('room-1', 'fp-a', NOW);
  assert.equal(freshBan(r, NOW), true);
  assert.equal(freshBan(r, NOW + BAN_TTL_MS), false);
  assert.equal(freshBan(r, NOW + BAN_TTL_MS - 1), true);
});

test('a ban is read for its own room only', () => {
  const list = [rec('room-1', 'fp-a', NOW)];
  assert.equal(banHeld(list, 'room-1', 'fp-a', NOW), true);
  assert.equal(banHeld(list, 'room-2', 'fp-a', NOW), false);
  assert.equal(banHeld(list, 'room-1', 'fp-b', NOW), false);
  assert.equal(banHeld(list, 'room-1', 'fp-a', NOW + BAN_TTL_MS), false);
  assert.equal(banHeld(list, '', 'fp-a', NOW), false);
  assert.equal(banHeld(list, 'room-1', '', NOW), false);
});

test('a room over its cap drops its oldest entries first', () => {
  const list = [];
  for (let i = 0; i < BAN_ROOM_CAP + 5; i++) list.push(rec('room-1', 'fp-' + i, NOW + i));
  const { kept, removed } = pruneBans(list, NOW + 10_000);
  assert.equal(kept.length, BAN_ROOM_CAP);
  assert.equal(removed.length, 5);
  assert.deepEqual(
    removed.map((r) => r.fp),
    ['fp-0', 'fp-1', 'fp-2', 'fp-3', 'fp-4'],
  );
  assert.equal(kept[kept.length - 1].fp, 'fp-' + (BAN_ROOM_CAP + 4));
});

test('the whole browser over its cap drops the oldest across rooms', () => {
  const list = [];
  const rooms = 12;
  for (let r = 0; r < rooms; r++) {
    for (let i = 0; i < BAN_ROOM_CAP; i++) list.push(rec('room-' + r, 'fp-' + i, NOW + r * 100 + i));
  }
  assert.ok(rooms * BAN_ROOM_CAP > BAN_ALL_CAP);
  const { kept, removed } = pruneBans(list, NOW + 10_000);
  assert.equal(kept.length, BAN_ALL_CAP);
  assert.equal(removed.length, rooms * BAN_ROOM_CAP - BAN_ALL_CAP);
  // Nothing outside the cap is a per-room drop, so the oldest rows of the oldest
  // rooms are exactly what went.
  const newest = Math.max(...kept.map((r) => r.at));
  assert.equal(newest, NOW + (rooms - 1) * 100 + BAN_ROOM_CAP - 1);
  assert.ok(removed.every((r) => r.at < Math.min(...kept.map((k) => k.at))));
});

test('a sweep drops the lapsed rows and keeps the rest untouched', () => {
  const list = [
    rec('room-1', 'fp-old', NOW - BAN_TTL_MS - 1),
    rec('room-1', 'fp-new', NOW),
    rec('room-2', 'fp-other', NOW + 1),
  ];
  const { kept, removed } = pruneBans(list, NOW + 2);
  assert.deepEqual(removed.map((r) => r.fp), ['fp-old']);
  assert.deepEqual(kept.map((r) => r.fp).sort(), ['fp-new', 'fp-other']);
});

test('a torn record is dropped instead of enforced', () => {
  const list = [
    { fp: 'fp-a', room: 'room-1', at: 'yesterday', until: NOW + 5 },
    { fp: '', room: 'room-1', at: NOW, until: NOW + 5 },
    { room: 'room-1', at: NOW, until: NOW + 5 },
    null,
    rec('room-1', 'fp-good', NOW),
  ];
  const { kept, removed } = pruneBans(list, NOW);
  assert.deepEqual(kept.map((r) => r.fp), ['fp-good']);
  // A bare null is not a record that was written; it is nothing to delete.
  assert.equal(removed.length, 3);
  assert.equal(banHeld(list, 'room-1', 'fp-a', NOW), false);
});

test('a sweep is stable: the same list gives the same rows', () => {
  const list = [];
  for (let i = 0; i < BAN_ROOM_CAP + 3; i++) list.push(rec('room-1', 'fp-' + i, NOW));
  const a = pruneBans(list, NOW + 1).removed.map((r) => r.fp);
  const b = pruneBans(list.slice().reverse(), NOW + 1).removed.map((r) => r.fp);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});
