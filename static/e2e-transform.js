'use strict';

// Encoded-frame transform for the post-quantum client.
//
// One worker serves every RTCRtpScriptTransform of the page. Each transform
// names a peer pair and a direction in its options. Keys arrive as raw bytes
// from the page, are imported as non-extractable AES-GCM keys here, and never
// leave this worker again.
//
// Frame layout on the wire:
//   [1 byte version][12 byte random IV][ciphertext][16 byte GCM tag]
// Version 0x82 (bit 1 set) says the plaintext is [4 byte length][payload]
// padded with zeros to a rung of a size ladder, so the wire size stops naming
// what was sent; 0x80 is the plain layout. Bit 0 of the same byte carries the
// codec keyframe bit.
// The GCM associated data binds the frame to the peer pair, to the sender and
// to the track it belongs to. A frame from another pair, a frame moved to
// another track, a frame reflected to its sender, or one modified in flight,
// fails authentication.

const VERSION = 0x80;       // upper bits tag a pq-e2e v2 frame
const VERSION_MASK = 0xfe;  // bit 0 is free: it carries the codec key bit
const PADDED = 0x82;        // v3: the plaintext is length prefixed and padded
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Padding ladders, in plaintext bytes. A sealed frame is rounded up to the
// next rung, so its size stops being a fingerprint of what was sent; an audio
// rung is small, because a frame every twenty milliseconds pays for it, and a
// video rung starts at one packet and doubles to a whole frame.
const LADDER = {
  audio: [128, 192, 256, 384, 512, 768, 1024, 1536],
  video: [512, 1024, 2048, 4096, 8192],
};
const LEN_BYTES = 4;        // payload length in front of a padded plaintext
const text = new TextEncoder();

const KEYS = new Map(); // pair -> { enc?: CryptoKey, dec?: CryptoKey }
const STATS = new Map(); // pair|dir -> counters
const SEND = new Map(); // pair|kind -> send transformer, for the key frame ask
const PAD = new Set();  // pair|kind that pad, once the peer has said it reads them
const FLUSH_EVERY = 30;

// bucketFor returns the smallest rung of one ladder that holds n bytes, or a
// whole multiple of the top rung when n is larger than the ladder.
function bucketFor(n, ladder) {
  for (const rung of ladder) if (n <= rung) return rung;
  return Math.ceil(n / ladder[ladder.length - 1]) * ladder[ladder.length - 1];
}

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

function aad(pair, from, kind) {
  // Both ends must build the same bytes, so this names the sender, not the
  // local direction: the sender knows itself, the receiver knows its peer.
  return text.encode('pq-e2e v2 media ' + pair + ' from ' + (from || '?') + ' ' + (kind || 'any'));
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

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'keyframe') {
    // Only video carries key frames; the sender builds the frame. Gecko rejects
    // the returned promise with InvalidStateError 'Not sending video' when the
    // sender carries no live video, and a rejected promise is not a throw: the
    // rejection is caught here, and the page asks only when it has a track.
    const tx = SEND.get(msg.pair + '|video');
    if (!tx) return;
    try {
      Promise.resolve(tx.generateKeyFrame()).catch(() => {});
    } catch (_err) {
      /* no encoder yet */
    }
    return;
  }
  if (msg.type === 'pad') {
    // A peer told this page that it reads padded frames, so this pair may pad.
    const key = msg.pair + '|' + (msg.kind || '');
    if (msg.on) PAD.add(key);
    else PAD.delete(key);
    return;
  }
  if (msg.type !== 'keys') return;
  let slot = KEYS.get(msg.pair);
  if (!slot) {
    slot = { gen: 0 };
    KEYS.set(msg.pair, slot);
  }
  // Imports for one pair run one after the other, and an older generation that
  // lands late never overwrites a newer one. Rejoins race here otherwise: the
  // two ends can end up holding keys from different handshakes.
  const gen = Number(msg.gen) || 0;
  slot.chain = (slot.chain || Promise.resolve()).then(async () => {
    if (gen < slot.gen) return;
    slot.gen = gen;
    try {
      if (msg.enc) {
        slot.enc = await crypto.subtle.importKey('raw', b64d(msg.enc), { name: 'AES-GCM' }, false, ['encrypt']);
      }
      if (msg.dec) {
        slot.dec = await crypto.subtle.importKey('raw', b64d(msg.dec), { name: 'AES-GCM' }, false, ['decrypt']);
      }
      self.postMessage({
        type: 'keys-ok', pair: msg.pair, peer: msg.peer, gen,
        enc: !!slot.enc, dec: !!slot.dec,
      });
    } catch (err) {
      self.postMessage({ type: 'error', where: 'keys', pair: msg.pair, gen, msg: String(err) });
    }
  });
};

async function transformFrame(frame, controller, ctx) {
  const { pair, dir, kind, options, st, ad } = ctx;
  const slot = KEYS.get(pair);
  const data = new Uint8Array(frame.data);

  if (dir === 'send') {
    if (!slot || !slot.enc) {
      st.drop++;
      report(pair, dir, kind, st);
      return;
    }
    // A padded frame carries its own length and then zeros, so the wire size is
    // a rung of the ladder and not the size of what was said. Both ends must
    // read it, so the page turns this on only for a peer that said so.
    const pad = PAD.has(pair + '|' + kind);
    let body = data;
    if (pad) {
      const ladder = LADDER[kind] || LADDER.video;
      body = new Uint8Array(bucketFor(LEN_BYTES + data.length, ladder));
      new DataView(body.buffer).setUint32(0, data.length);
      body.set(data, LEN_BYTES);
    }
    const out = new Uint8Array(1 + IV_BYTES + body.length + TAG_BYTES);
    const iv = crypto.getRandomValues(out.subarray(1, 1 + IV_BYTES));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ad, tagLength: 128 },
      slot.enc,
      body,
    ));
    // Keep the codec's keyframe bit (VP8/VP9 put it in bit 0 of the first
    // payload byte) visible on the wire: the receiving stack reads it before
    // any transform runs and otherwise marks every frame as a delta frame,
    // so the decoder never starts. Only this one bit is exposed.
    out[0] = (pad ? PADDED : VERSION) | (data[0] & 0x01);
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

  // Receiving, or tapping: both need the ciphertext framing to be intact. A
  // frame may be plain v2 or the padded v3, since a peer that has not said it
  // reads padding still sends v2.
  const ver = data.length ? (data[0] & VERSION_MASK) : 0;
  if (data.length < 1 + IV_BYTES + TAG_BYTES || (ver !== VERSION && ver !== PADDED)) {
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
          { name: 'AES-GCM', iv: data.subarray(1, 1 + IV_BYTES), additionalData: ad, tagLength: 128 },
          slot.dec,
          data.subarray(1 + IV_BYTES),
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
      { name: 'AES-GCM', iv: data.subarray(1, 1 + IV_BYTES), additionalData: ad, tagLength: 128 },
      slot.dec,
      data.subarray(1 + IV_BYTES),
    );
    let body = plain;
    if (ver === PADDED) {
      // The first four bytes are the real length; the rest of the rung is
      // zeros and goes away before the frame meets the decoder.
      const bytes = new Uint8Array(plain);
      const len = new DataView(plain, 0, LEN_BYTES).getUint32(0);
      if (bytes.byteLength < LEN_BYTES || len > bytes.byteLength - LEN_BYTES) {
        throw new Error('padding out of range');
      }
      body = bytes.buffer.slice(bytes.byteOffset + LEN_BYTES, bytes.byteOffset + LEN_BYTES + len);
    }
    frame.data = body;
    st.ok++;
    st.plain += body.byteLength;
    st.cipher += data.length;
    if (st.ok === 1) {
      self.postMessage({
        type: 'sample', dir, kind, peer: options.peer, pair,
        plainLen: body.byteLength, cipherLen: data.length, head: hex(data.slice(0, 16)),
        plainHead: hex(new Uint8Array(body).slice(0, 8)), ftype: frame.type,
      });
    }
    report(pair, dir, kind, st);
    controller.enqueue(frame);
  } catch (err) {
    st.fail++;
    if (st.fail === 1) {
      self.postMessage({
        type: 'sample', dir: 'recv-refused', pair, peer: options.peer,
        cipherLen: data.length, head: hex(data.slice(0, 16)),
        why: String(err && err.message || err),
      });
    }
    report(pair, dir, kind, st);
  }
}

self.onrtctransform = (event) => {
  const transformer = event.transformer;
  const options = transformer.options || {};
  // The page asks for one key frame once the pair is connected, over the sealed
  // channel. This map is how the worker answers: the sender builds the frame.
  if (options.dir === 'send') SEND.set(options.pair + '|' + options.kind, transformer);
  // Everything below is fixed for the life of a transformer, so it is worked out
  // once here and not again for every audio and video frame.
  const pair = options.pair;
  const dir = options.dir;
  const kind = options.kind || '';
  const ctx = { pair, dir, kind, options, st: counters(pair, dir, kind), ad: aad(pair, options.from || '', kind) };
  const stream = new TransformStream({
    transform(frame, controller) {
      return transformFrame(frame, controller, ctx);
    },
  });
  transformer.readable
    .pipeThrough(stream)
    .pipeTo(transformer.writable)
    .catch((err) => self.postMessage({ type: 'error', where: 'pipe', msg: String(err) }));
};
