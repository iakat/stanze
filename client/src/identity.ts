/*
 The pinned identity of a peer and its fingerprint rows.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { say } from './util.js';
import { load, store } from './prefs.js';
import { rowOf } from './tiles.js';
import { b64d, b64e, pqCall, pqModule, sealUtf8, sealedFailedPairs, sealedPairNames, shortPeer } from './sealed.js';
import { sealedRestart } from './handshake.js';
import { paintState, refreshCodeCard } from './gate.js';

// ------------------------------------------------------------- identity and pins
//
// The long-term identity is Ed25519 and signing only: it signs the handshake
// transcript and is never a KDF input, never does static ECDH and never takes a
// KEM encapsulation, so a stolen copy can impersonate a pinned peer and can
// decrypt nothing. It lives in IndexedDB, non-extractable where the browser can
// hold such a key, and never in localStorage, a cookie or the server. A browser
// that can not keep a key gets a fresh one per page load and says so.
export const ID_DB = 'stanze-identity';

export const ID_CHALLENGE = 'stanze identity';

export const ID_NOTE = {
  kept: 'the identity is kept in this browser',
  fresh: 'the stored identity could not be reopened: a new key for this page',
  session: 'this browser keeps no identity: a new key each load, the device stays unverified',
};

export let idDb = null;

// idStore opens the one local database: the identity, the pins this guest made
// and the fingerprints a pin replaced. No session material is ever written.
export function idStore() {
  if (idDb) return idDb;
  idDb = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('no indexeddb'));
      return;
    }
    const req = indexedDB.open(ID_DB, 1);
    req.onupgradeneeded = () => {
      for (const name of ['id', 'pins', 'revoked']) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb refused'));
  });
  // A failed open is not remembered, so a later attempt can still work.
  idDb.catch(() => { idDb = null; });
  return idDb;
}

export function idbRequest(store, mode, fn) {
  return idStore().then((db) => new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function idbGet(store, key) { return idbRequest(store, 'readonly', (s) => s.get(key)); }

export function idbAll(store) { return idbRequest(store, 'readonly', (s) => s.getAll()); }

export function idbPut(store, key, value) { return idbRequest(store, 'readwrite', (s) => s.put(value, key)); }

export function idbDelete(store, key) { return idbRequest(store, 'readwrite', (s) => s.delete(key)); }

export function fingerprint(pub) {
  const out = pqCall((json) => pqModule().idfp(json), { id: pub });
  return out && out.fp ? out.fp : '';
}

// provesKey checks that a stored record still signs for its own public key. A
// browser that kept a CryptoKey it can not use (Safari has done that) fails here
// rather than in the first handshake.
export async function provesKey(pub, sign) {
  if (!pub || typeof sign !== 'function') return false;
  const msg = b64e(sealUtf8.encode(ID_CHALLENGE));
  let sig = '';
  try { sig = await sign(msg); } catch { /* an unusable key */ }
  const res = pqCall((json) => pqModule().idverify(json), { id: pub, msg, sig });
  return !!(res && res.ok);
}

// subtleIdentity is the preferred shape: WebCrypto holds a non-extractable
// Ed25519 key and no script can export it, not even this origin.
export function subtleIdentity(key, pub) {
  return {
    kind: 'webcrypto', pub, fp: fingerprint(pub),
    sign: (msg) => crypto.subtle.sign({ name: 'Ed25519' }, key, b64d(msg)).then(b64e),
    store: () => ({ kind: 'webcrypto', key, pub }),
  };
}

// seedIdentity is the fallback: the wasm module signs with a 32 byte seed, and
// the record on disk keeps that seed sealed under a non-extractable AES-GCM key,
// so an offline copy of the database is useless without this profile.
export function seedIdentity(seed, pub, kind) {
  return {
    kind, pub, fp: fingerprint(pub), seed,
    sign: async (msg) => {
      const out = pqCall((json) => pqModule().idsign(json), { seed: b64e(seed), msg });
      return out && out.sig ? out.sig : '';
    },
    store: async () => {
      const wrap = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrap, seed));
      return { kind: 'sealed', wrap, iv, ct, pub };
    },
  };
}

export function createIdentity() {
  return Promise.resolve()
    .then(() => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']))
    .then(async (pair) => subtleIdentity(pair.privateKey, b64e(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))))
    .catch(() => {
      // No WebCrypto Ed25519 (Chromium before 137, older Safari): the module
      // draws the identity and keeps the seed for as long as this page lives.
      const made = pqCall((json) => pqModule().idgen(json), {});
      return made && made.pub && made.seed ? seedIdentity(b64d(made.seed), made.pub, 'sealed') : null;
    });
}

export async function reopenIdentity(rec) {
  if (!rec || !rec.pub) return null;
  let key = null;
  try {
    if (rec.kind === 'webcrypto' && rec.key) {
      key = subtleIdentity(rec.key, rec.pub);
    } else if (rec.kind === 'sealed' && rec.wrap && rec.iv && rec.ct) {
      const seed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, rec.wrap, rec.ct));
      key = seedIdentity(seed, rec.pub, 'sealed');
    }
  } catch {
    return null;
  }
  return key && await provesKey(rec.pub, key.sign) ? key : null;
}

export function loadPins() {
  return Promise.all([idbAll('pins'), idbAll('revoked')])
    .then(([pins, revoked]) => {
      for (const rec of pins || []) if (rec && rec.label && rec.fp) state.pins.set(rec.label, rec);
      for (const rec of revoked || []) if (rec && rec.fp) state.revoked.set(rec.fp, rec);
    })
    .catch(() => { /* no local database: the pins live in this page only */ });
}

export let identityLoad = null;

// ensureIdentity loads or creates the long-term key and the pins, once per page.
export function ensureIdentity() {
  if (identityLoad) return identityLoad;
  identityLoad = (async () => {
    await loadPins();
    let rec = null;
    try { rec = await idbGet('id', 'self'); } catch { /* no local database */ }
    let key = await reopenIdentity(rec);
    if (key) {
      state.device = 'kept';
    } else {
      key = await createIdentity();
      if (!key) throw new Error('no identity key');
      state.device = rec ? 'fresh' : 'kept';
      try {
        await idbPut('id', 'self', await key.store());
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
          navigator.storage.persist().catch(() => {});
        }
      } catch {
        // Private mode, or a browser that refuses the record: the key still
        // works for this page, and the device is honest about not being kept.
        key.kind = 'session';
        state.device = 'session';
      }
    }
    state.idKey = key;
    return key;
  })().catch((err) => {
    identityLoad = null;
    throw err;
  });
  return identityLoad;
}

export function deviceNote() {
  return ID_NOTE[state.device] || ID_NOTE.session;
}

// pinState says what the fingerprint a peer proved means here. A pin is stored
// by fingerprint, never by a name the peer chose, so nobody can claim a label.
// A fingerprint this browser revoked and now sees again is the alarm: a key
// that was replaced can not come back unless something replays it.
export function pinState(peer) {
  if (peer.pin === 'changed') return 'changed';
  if (!peer.fp) return 'new';
  if (state.revoked.has(peer.fp)) return 'rollback';
  for (const rec of state.pins.values()) if (rec.fp === peer.fp) return 'known';
  return 'new';
}

// pinLabelOf is the label this browser pinned under the fingerprint of a peer.
export function pinLabelOf(peer) {
  for (const rec of state.pins.values()) if (rec.fp === peer.fp) return rec.label;
  return peer.pinLabel || '';
}

// pinPeer attaches the fingerprint a guest is showing to a local label. A label
// that already holds another fingerprint is the changed state, and the guest
// decides what happens next; nothing is overwritten in silence.
export function pinPeer(peer, label) {
  if (!peer || !peer.fp) return 'new';
  const name = String(label || pinLabelOf(peer) || peer.name || shortPeer(peer.id)).slice(0, 32);
  const held = state.pins.get(name);
  if (held && held.fp !== peer.fp) {
    peer.pin = 'changed';
    peer.pinLabel = name;
    paintPin(peer);
    return 'changed';
  }
  const now = Date.now();
  const rec = { label: name, fp: peer.fp, first: held ? held.first : now, last: now };
  state.pins.set(name, rec);
  idbPut('pins', name, rec).catch(() => {});
  if (state.revoked.has(peer.fp)) {
    state.revoked.delete(peer.fp);
    idbDelete('revoked', peer.fp).catch(() => {});
  }
  peer.pin = '';
  peer.pinLabel = name;
  paintPin(peer);
  return 'known';
}

// renamePin moves a pin to a new label and keeps its fingerprint and first
// sighting. A name that already holds another key goes through pinPeer, so a
// rename can never hide a swapped device.
export function renamePin(peer, label) {
  if (!peer || pinState(peer) !== 'known') return 'new';
  const old = pinLabelOf(peer);
  const name = String(label || '').trim().slice(0, 32);
  if (!name || name === old) return 'known';
  const held = state.pins.get(name);
  if (held && held.fp !== peer.fp) return pinPeer(peer, name);
  const was = state.pins.get(old);
  state.pins.delete(old);
  idbDelete('pins', old).catch(() => {});
  const now = Date.now();
  state.pins.set(name, { label: name, fp: peer.fp, first: was ? was.first : now, last: now });
  idbPut('pins', name, state.pins.get(name)).catch(() => {});
  peer.pin = '';
  peer.pinLabel = name;
  paintPin(peer);
  return 'known';
}

// resetDevice is the calm path of a changed identity: the guest was told that
// the other device was reset, so the old fingerprint stays remembered as revoked
// and the new one takes the label. It is a deliberate click, never automatic.
export function resetDevice(peer, label) {
  const name = String(label || pinLabelOf(peer) || peer.name || shortPeer(peer.id)).slice(0, 32);
  const held = state.pins.get(name);
  if (held && held.fp && held.fp !== peer.fp) {
    const gone = { fp: held.fp, label: name, at: Date.now() };
    state.revoked.set(gone.fp, gone);
    idbPut('revoked', gone.fp, gone).catch(() => {});
    state.pins.delete(name);
    idbDelete('pins', name).catch(() => {});
  }
  peer.pin = '';
  const state_ = pinPeer(peer, name);
  // A pair that was closed for a changed identity gets one more handshake, now
  // that the guest has said the other device was reset.
  if (!peer.proven) sealedRestart(peer, true);
  return state_;
}

export function verifiedPeers() {
  let n = 0;
  for (const peer of state.peers.values()) if (peer.fp && pinState(peer) === 'known') n++;
  return n;
}

// updatePinCount is the room summary in the middle of the title bar: how many
// guests this browser can name by identity, out of the guests present. The bar
// is green when every guest is verified and red when one is not; a pair whose
// keys do not match keeps it red and the title names that pair.
export function updatePinCount() {
  const el = $('pin-count');
  if (!el) return;
  const total = state.peers.size;
  const known = verifiedPeers();
  const failed = sealedFailedPairs();
  const full = total > 0 && known === total && failed.length === 0;
  el.hidden = total === 0;
  el.textContent = total ? `verified ${known}/${total}` : '';
  el.dataset.verified = full ? 'all' : 'part';
  // The bar is never the plain blue one: green only when every guest present is
  // verified, red otherwise, and red while the room is empty because nothing is
  // verified yet.
  $('stage').dataset.verified = full ? 'all' : 'part';
  if (total === 0) {
    el.removeAttribute('title');
  } else if (failed.length > 0) {
    el.title = 'the keys do not match with ' + sealedPairNames(failed) + ', so do not trust this call';
  } else {
    el.title = `${known} of ${total} guests present an identity this browser pinned; each pair has its own code on its tile`;
  }
}

export function paintPin(peer) {
  updatePinCount();
  paintState(peer);
  for (const host of [peer.tile, rowOf.get(peer.tile)]) refreshCodeCard(host, peer);
  const chip = peer.tile ? peer.tile.querySelector('.pin') : null;
  if (!chip) return;
  const what = pinState(peer);
  chip.hidden = !peer.fp;
  chip.dataset.pin = what === 'rollback' ? 'changed' : what;
  chip.textContent = what === 'known' ? pinLabelOf(peer)
    : what === 'changed' ? 'identity changed'
      : what === 'rollback' ? 'old key came back'
        : 'unverified';
  chip.title = peer.fp ? 'identity ' + peer.fp : '';
  // A named device keeps its pin, so the name can change later without asking
  // for the fingerprint again. The click is the whole interface.
  const named = what === 'known';
  chip.dataset.action = named ? 'rename' : '';
  if (named) {
    chip.title = (chip.title ? chip.title + ' | ' : '') + 'click to rename';
    chip.onclick = () => renamePin(peer, prompt('new name for this device', pinLabelOf(peer)) || '');
  } else {
    chip.onclick = null;
  }
}

// storageAudit lists what this page keeps on disk, so the browser test can say
// plainly that no session secret is in it.
export async function storageAudit() {
  const out = { local: Object.keys(localStorage), stores: {}, keys: 0 };
  try {
    const db = await idStore();
    for (const name of db.objectStoreNames) {
      const rows = await idbAll(name);
      out.stores[name] = rows.map((row) => {
        const shape = {};
        for (const [k, v] of Object.entries(row || {})) {
          if (v instanceof Uint8Array) shape[k] = 'bytes:' + v.length;
          else if (v && v.type) shape[k] = 'key:' + v.type;
          else if (typeof v === 'string') shape[k] = v.length > 40 ? 'string:' + v.length : v;
          else shape[k] = typeof v;
        }
        return shape;
      });
    }
  } catch {
    out.stores = null;
  }
  return out;
}
