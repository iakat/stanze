'use strict';

// Encoded-frame transform for the post-quantum client.
//
// One worker serves every RTCRtpScriptTransform of the page. Each transform
// names a peer pair and a direction in its options. Keys arrive as raw bytes
// from the page, are imported as non-extractable AES-GCM keys here, and never
// leave this worker again.
//
// Frame layout on the wire:
//   [1 byte version=1][12 byte random IV][ciphertext][16 byte GCM tag]
// The GCM associated data binds the frame to the peer pair. A frame from
// another pair, or one modified in flight, fails authentication.

const VERSION = 0x80;       // upper bits tag a pq-e2e v1 frame
const VERSION_MASK = 0xfe;  // bit 0 is free: it carries the codec key bit
const IV_BYTES = 12;
const TAG_BYTES = 16;
const text = new TextEncoder();

const KEYS = new Map(); // pair -> { enc?: CryptoKey, dec?: CryptoKey }
const STATS = new Map(); // pair|dir -> counters
const FLUSH_EVERY = 30;

// One entry per live transform. A pair has one per direction and kind, so the
// key includes both: a video receiver and an audio receiver share pair and dir.
const TRANSFORMS = new Map(); // pair|dir|kind -> { transformer, kind }

function b64d(s) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function aad(pair) {
  return text.encode('pq-e2e v1 media ' + pair);
}

function counters(pair, dir, kind) {
  const key = pair + '|' + dir + (kind ? '|' + kind : '');
  let st = STATS.get(key);
  if (!st) {
    st = { ok: 0, fail: 0, drop: 0, plain: 0, cipher: 0, sent: 0 };
    STATS.set(key, st);
  }
  return st;
}

function report(pair, dir, kind, st, force) {
  st.sent++;
  if (!force && st.sent % FLUSH_EVERY !== 0) return;
  self.postMessage({
    type: 'stats', pair, dir, kind,
    ok: st.ok, fail: st.fail, drop: st.drop,
    plain: st.plain, cipher: st.cipher,
  });
}

// keyFrame asks an encoder for a fresh key frame through the standard encoded
// transform call. A receiving transformer sends the request over the media
// path; a sending one has its own encoder emit the frame. Only video has key
// frames, so an audio transform is skipped.
function keyFrame(msg) {
  let asked = 0;
  for (const [key, entry] of TRANSFORMS) {
    const parts = key.split('|');
    if (parts[0] !== msg.pair) continue;
    if (msg.dir && parts[1] !== msg.dir) continue;
    if (entry.kind && entry.kind !== 'video') continue;
    try {
      if (typeof entry.transformer.generateKeyFrame === 'function') {
        entry.transformer.generateKeyFrame();
        asked++;
      }
    } catch (_err) {
      /* this transformer can not nudge the encoder */
    }
  }
  self.postMessage({ type: 'keyframe', pair: msg.pair, peer: msg.peer, dir: msg.dir || '', ok: asked > 0 });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'keyframe') {
    keyFrame(msg);
    return;
  }
  if (msg.type !== 'keys') return;
  let slot = KEYS.get(msg.pair);
  if (!slot) {
    slot = {};
    KEYS.set(msg.pair, slot);
  }
  try {
    if (msg.enc) {
      slot.enc = await crypto.subtle.importKey('raw', b64d(msg.enc), { name: 'AES-GCM' }, false, ['encrypt']);
    }
    if (msg.dec) {
      slot.dec = await crypto.subtle.importKey('raw', b64d(msg.dec), { name: 'AES-GCM' }, false, ['decrypt']);
    }
    self.postMessage({ type: 'keys-ok', pair: msg.pair, peer: msg.peer, enc: !!slot.enc, dec: !!slot.dec });
  } catch (err) {
    self.postMessage({ type: 'error', where: 'keys', pair: msg.pair, msg: String(err) });
  }
};

async function transformFrame(frame, controller, options) {
  const pair = options.pair;
  const dir = options.dir;
  const kind = options.kind || '';
  const slot = KEYS.get(pair);
  const st = counters(pair, dir, kind);
  const data = new Uint8Array(frame.data);

  if (dir === 'send') {
    if (!slot || !slot.enc) {
      st.drop++;
      report(pair, dir, kind, st);
      return;
    }
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(pair), tagLength: 128 },
      slot.enc,
      data,
    ));
    const out = new Uint8Array(1 + IV_BYTES + sealed.length);
    // Keep the codec's keyframe bit (VP8/VP9 put it in bit 0 of the first
    // payload byte) visible on the wire: the receiving stack reads it before
    // any transform runs and otherwise marks every frame as a delta frame,
    // so the decoder never starts. Only this one bit is exposed.
    out[0] = VERSION | (data[0] & 0x01);
    out.set(iv, 1);
    out.set(sealed, 1 + IV_BYTES);
    frame.data = out.buffer;
    st.ok++;
    st.plain += data.length;
    st.cipher += out.length;
    if (st.ok === 1) {
      self.postMessage({
        type: 'sample', dir, kind, peer: options.peer, pair,
        plainLen: data.length, cipherLen: out.length, head: hex(out.slice(0, 16)),
        plainHead: hex(data.slice(0, 8)), ftype: frame.type,
      });
    }
    report(pair, dir, kind, st);
    controller.enqueue(frame);
    return;
  }

  // Receiving, or tapping: both need the ciphertext framing to be intact.
  if (data.length < 1 + IV_BYTES + TAG_BYTES || (data[0] & VERSION_MASK) !== VERSION) {
    st.fail++;
    if (st.fail === 1) self.postMessage({ type: 'sample', dir: 'recv-broken', pair, peer: options.peer, len: data.length });
    report(pair, dir, kind, st);
    return;
  }

  if (dir === 'tap') {
    // A receiver without the pair key: the best it can do is try. A wrong key
    // (or no key at all) must never produce a plaintext.
    st.drop++;
    if (slot && slot.dec) {
      try {
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: data.slice(1, 1 + IV_BYTES), additionalData: aad(pair), tagLength: 128 },
          slot.dec,
          data.slice(1 + IV_BYTES),
        );
        st.ok++;
        self.postMessage({ type: 'sample', dir: 'tap-opened', pair, peer: options.peer });
      } catch (_err) {
        st.fail++;
      }
    }
    if (st.sent === 1) {
      self.postMessage({
        type: 'sample', dir: 'tap', pair, peer: options.peer,
        cipherLen: data.length, head: hex(data.slice(0, 16)),
      });
    }
    report(pair, dir, kind, st);
    return;
  }

  if (!slot || !slot.dec) {
    st.drop++;
    report(pair, dir, kind, st);
    return;
  }

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: data.slice(1, 1 + IV_BYTES), additionalData: aad(pair), tagLength: 128 },
      slot.dec,
      data.slice(1 + IV_BYTES),
    );
    frame.data = plain;
    st.ok++;
    st.plain += plain.byteLength;
    st.cipher += data.length;
    if (st.ok === 1) {
      self.postMessage({
        type: 'sample', dir, kind, peer: options.peer, pair,
        plainLen: plain.byteLength, cipherLen: data.length, head: hex(data.slice(0, 16)),
        plainHead: hex(new Uint8Array(plain).slice(0, 8)), ftype: frame.type,
      });
    }
    report(pair, dir, kind, st);
    controller.enqueue(frame);
  } catch (_err) {
    st.fail++;
    if (st.fail === 1) {
      self.postMessage({
        type: 'sample', dir: 'recv-refused', pair, peer: options.peer,
        cipherLen: data.length, head: hex(data.slice(0, 16)),
      });
    }
    report(pair, dir, kind, st);
  }
}

self.onrtctransform = (event) => {
  const transformer = event.transformer;
  const options = transformer.options || {};
  const key = (options.pair || '') + '|' + (options.dir || '') + '|' + (options.kind || '');
  TRANSFORMS.set(key, { transformer, kind: options.kind || '' });
  const stream = new TransformStream({
    transform(frame, controller) {
      return transformFrame(frame, controller, options);
    },
  });
  transformer.readable
    .pipeThrough(stream)
    .pipeTo(transformer.writable)
    .catch((err) => self.postMessage({ type: 'error', where: 'pipe', msg: String(err) }))
    .finally(() => TRANSFORMS.delete(key));
};
