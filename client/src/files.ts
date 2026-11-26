/*
 File offers and the data channel that carries the bytes.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { clamp, say } from './util.js';
import { CHAT_MAX, addChatLine, chatTime } from './chat.js';
import { b64d, b64e, fileAAD, pqCall, pqModule, shortPeer } from './sealed.js';
import { canary } from './audit.js';
import { sealedSend } from './gate.js';
import { posOnMessage } from './positions.js';
import { worldOnPos } from './roomworld.js';

// ------------------------------------------------------------ chat files
//
// An offer is a chat line: name, size and type go as a sealed `app` frame on the
// chat key, so the server never reads them. Bytes use one ordered data channel
// per pair, one sealed frame per chunk, and a Blob behind a link, never disk.
export const FILE_LABEL = 'files';

// 16 KiB of plaintext seals to about 22 KiB with the 16 byte tag and base64.
// Every stack must accept 64 KiB in one SCTP message, so a chunk stays under it.
const FILE_CHUNK = 16 * 1024;

// The sender pauses when the channel holds this much and resumes on the low mark,
// so a large file never fills the send buffer of the call.
const FILE_BUFFER = 256 * 1024;

const FILE_LOW = 64 * 1024;

const FILE_OPEN_WAIT = 15000;

// A transfer in one of these states has ended, so a peer that leaves can not
// change it again.
const FILE_DONE = new Set(['done', 'refused', 'cancelled', 'gone']);

// A file name is shown in the chat only, but it comes from another page, so it is
// cleaned like a sealed guest name.
function cleanFileName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 64);
}

function fileID() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fileBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  const units = ['kB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[i];
}

// fileRateText is the speed shown beside a transfer, in 1024 based kB/s, whole
// above ten so the line keeps its width.
function fileRateText(kbs) {
  if (!kbs || !isFinite(kbs) || kbs <= 0) return '';
  return (kbs >= 10 ? Math.round(kbs) : kbs.toFixed(1)) + ' kB/s';
}

// fileMarkRate keeps a 500 ms window per transfer, so the number is the rate now
// and not the average. The first chunk shows the average so far.
function fileMarkRate(o, bytes, now) {
  if (!o.rateT) {
    o.rateT = now;
    o.rateB = bytes;
    const secs = (now - (o.rateAt || now)) / 1000;
    o.rate = secs > 0.05 ? bytes / 1024 / secs : 0;
    return;
  }
  const dt = now - o.rateT;
  if (dt < 500) return;
  o.rate = (bytes - o.rateB) / 1024 / (dt / 1000);
  o.rateT = now;
  o.rateB = bytes;
}

// fileAverageRate is the one number kept after the end: the whole file over the
// whole time it took.
function fileAverageRate(bytes, start, now) {
  if (!start || !bytes) return '';
  const secs = (now - start) / 1000;
  if (secs < 0.2) return '';
  return fileRateText(bytes / 1024 / secs);
}

function fileButton(label, fn) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => {
    button.disabled = true;
    fn(button);
  });
  return button;
}

// addFileRow draws one offer in the room log with the time and speaker spans of a
// chat line. The bar is a span, not a native meter, so the row styles it.
function addFileRow(who, name, size) {
  const log = $('chat-log');
  if (!log) return null;
  const li = document.createElement('li');
  li.className = 'chat-file';
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = chatTime();
  const speaker = document.createElement('span');
  speaker.className = 'who';
  speaker.textContent = (who || 'guest') + ':';
  const head = document.createElement('span');
  head.className = 'file-head';
  const label = document.createElement('span');
  label.className = 'file-name';
  label.textContent = name;
  label.title = name;
  const labelSize = document.createElement('span');
  labelSize.className = 'file-size';
  labelSize.textContent = fileBytes(size);
  head.append(label, labelSize);
  const bar = document.createElement('span');
  bar.className = 'file-bar';
  bar.hidden = true;
  const fill = document.createElement('span');
  fill.className = 'file-fill';
  bar.appendChild(fill);
  const status = document.createElement('span');
  status.className = 'file-status';
  const acts = document.createElement('span');
  acts.className = 'file-acts';
  li.append(when, speaker, head, bar, status, acts);
  log.appendChild(li);
  while (log.children.length > CHAT_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
  return { li, bar, fill, status, acts };
}

function fileSetBar(el, show, frac) {
  if (!el) return;
  el.bar.hidden = !show;
  el.fill.style.width = clamp(Math.round(frac * 100), 0, 100) + '%';
}

// fileOffer announces one file to every sealed peer; each peer keeps its own
// state, so one refusal never stops another transfer.
export function fileOffer(file) {
  if (!file || !state.self || state.leaving || state.waiting) return;
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    say('that file cannot be read');
    return;
  }
  const name = cleanFileName(file.name) || 'file';
  const type = String(file.type || '').slice(0, 64);
  const x = fileID();
  const out = { x, file, name, size, type, peers: new Map(), cancelled: false, el: null };
  for (const peer of state.peers.values()) {
    if (!peer.keys || peer.waiting) continue;
    out.peers.set(peer.id, { peer, status: 'offered', sent: 0, dead: false, wake: null });
    sealedSend(peer, { k: 'file', a: 'offer', x, n: name, z: size, m: type });
  }
  if (!out.peers.size) {
    addChatLine(state.name, 'no sealed peer for ' + name, Date.now());
    return;
  }
  canary(name);
  state.fileOffers++;
  state.files.set(x, out);
  out.el = addFileRow(state.name, name, size);
  if (out.el) out.el.acts.append(fileButton('cancel', () => fileCancelOut(out)));
  filePaintOut(out);
}

// fileOnMessage handles the sealed metadata of one offer; bytes only use the data
// channel.
export function fileOnMessage(peer, msg) {
  switch (msg.a) {
    case 'offer':
      fileOnOffer(peer, msg);
      break;
    case 'accept':
      fileOnAccept(peer, msg);
      break;
    case 'refuse':
      fileOnRefuse(peer, msg);
      break;
    case 'cancel':
      fileOnCancel(peer, msg);
      break;
    case 'done':
      fileOnDone(peer, msg);
      break;
    default:
      break;
  }
}

function fileOnOffer(peer, msg) {
  const x = String(msg.x || '').slice(0, 32);
  const name = cleanFileName(msg.n);
  const size = Number(msg.z);
  const type = String(msg.m || '').slice(0, 64);
  if (!x || !name || !Number.isSafeInteger(size) || size < 0) return;
  const key = peer.id + '|' + x;
  if (state.filesIn.has(key)) return;
  const rec = {
    key,
    x,
    peerId: peer.id,
    name,
    size,
    type,
    status: 'offered',
    chunks: [],
    got: 0,
    expect: 0,
    el: null,
    url: '',
    rateT: 0,
    rateB: 0,
    rate: 0,
    rateAt: 0,
  };
  state.filesIn.set(key, rec);
  canary(name);
  rec.el = addFileRow(peer.name || shortPeer(peer.id), name, size);
  if (rec.el) {
    rec.el.acts.append(
      fileButton('accept', (button) => fileAccept(rec, button)),
      fileButton('refuse', () => fileRefuse(rec)),
    );
  }
  filePaintIn(rec);
}

// A big file should not sit in the tab twice: with the File System Access API each
// chunk is written to the file picked at the accept click, else bytes stay in
// memory behind a save link.
function fileDiskWanted() {
  const pick = (window as any).showSaveFilePicker;
  return typeof pick === 'function' && !(window as any).e2eNoPicker;
}

// fileDiskOpen asks for the place on disk: true when a writer is ready, false when
// the bytes must stay in memory, null when the guest closed the picker.
async function fileDiskOpen(rec) {
  if (!fileDiskWanted()) return false;
  let handle;
  try {
    handle = await (window as any).showSaveFilePicker({ suggestedName: rec.name });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    return false;
  }
  try {
    rec.writer = await handle.createWritable();
    rec.disk = true;
    return true;
  } catch {
    return false;
  }
}

// fileDiskWrite queues one chunk on the writable, so a slow disk presses on the
// queue and not on the page. A failed write cancels the transfer and the file.
function fileDiskWrite(rec, bytes) {
  const writer = rec.writer;
  if (!writer) return;
  rec.writes = (rec.writes || Promise.resolve())
    .then(() => writer.write(bytes))
    .catch(() => {
      fileDiskAbort(rec);
      const peer = state.peers.get(rec.peerId);
      if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
      fileFinishIn(rec, 'cancelled');
    });
}

// fileDiskAbort drops a partial file after a cancel, behind the writes that are
// already queued, so the abort can not land in the middle of one.
function fileDiskAbort(rec) {
  const writer = rec.writer;
  rec.writer = null;
  rec.chunks = [];
  if (!writer) return;
  const pending = rec.writes || Promise.resolve();
  rec.writes = pending.then(() => writer.abort()).catch(() => {});
}

function fileAccept(rec, button) {
  const peer = state.peers.get(rec.peerId);
  if (!peer || !peer.keys) {
    fileFinishIn(rec, 'gone');
    return;
  }
  // The picker must run inside the accepting click, or the browser refuses it. A
  // closed picker sends no accept and the offer stays for a second click.
  return fileDiskOpen(rec).then((ok) => {
    if (ok === null) {
      if (button) button.disabled = false;
      return;
    }
    fileAcceptGo(rec, peer, ok);
  });
}

function fileAcceptGo(rec, peer, disk) {
  if (disk === null || !state.peers.has(peer.id) || !peer.keys) return;
  rec.status = 'receiving';
  rec.got = 0;
  rec.expect = 0;
  rec.chunks = [];
  rec.rateT = 0;
  rec.rateB = 0;
  rec.rate = 0;
  rec.rateAt = performance.now();
  fileArmIn(rec);
  if (rec.el) {
    rec.el.acts.replaceChildren(fileButton('cancel', () => fileCancelIn(rec)));
  }
  sealedSend(peer, { k: 'file', a: 'accept', x: rec.x });
  filePaintIn(rec);
}

function fileRefuse(rec) {
  const peer = state.peers.get(rec.peerId);
  if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'refuse', x: rec.x });
  fileFinishIn(rec, 'refused');
}

function fileCancelIn(rec) {
  const peer = state.peers.get(rec.peerId);
  if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
  state.fileCancelled++;
  fileFinishIn(rec, 'cancelled');
}

function fileCancelOut(out, why = '') {
  if (!out || out.cancelled) return;
  out.cancelled = true;
  state.fileCancelled++;
  for (const st of out.peers.values()) {
    if (st.status === 'done' || st.status === 'refused' || st.status === 'gone') continue;
    st.status = 'cancelled';
    fileStop(st);
    if (st.peer.keys) sealedSend(st.peer, { k: 'file', a: 'cancel', x: out.x, y: why || '' });
  }
  // The File is not needed any more, so the page can free it.
  out.file = null;
  filePaintOut(out);
  fileSettle(out);
}

function fileCancelPeer(out, st, why) {
  if (st.status === 'done' || st.status === 'refused' || st.status === 'gone') return;
  st.status = 'cancelled';
  fileStop(st);
  if (st.peer.keys) sealedSend(st.peer, { k: 'file', a: 'cancel', x: out.x, y: why || '' });
  filePaintOut(out);
  fileSettle(out);
}

function fileOnAccept(peer, msg) {
  const out = state.files.get(String(msg.x || ''));
  if (!out || out.cancelled) {
    if (peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: String(msg.x || '') });
    return;
  }
  const st = out.peers.get(peer.id);
  if (!st || st.status !== 'offered') return;
  st.status = 'sending';
  st.rateAt = performance.now();
  filePaintOut(out);
  filePump(out, st).catch(() => fileCancelPeer(out, st, 'the transfer failed'));
}

function fileOnRefuse(peer, msg) {
  const out = state.files.get(String(msg.x || ''));
  if (!out || out.cancelled) return;
  const st = out.peers.get(peer.id);
  if (!st || st.status === 'refused') return;
  st.status = 'refused';
  fileStop(st);
  state.fileRefused++;
  filePaintOut(out);
  fileSettle(out);
}

function fileOnCancel(peer, msg) {
  const x = String(msg.x || '');
  // A cancel from a receiver ends that one outgoing transfer; the other accepted
  // peers keep their own bytes. A cancel from the sender ends the incoming one.
  const out = state.files.get(x);
  if (out) {
    const st = out.peers.get(peer.id);
    if (
      st &&
      st.status !== 'done' &&
      st.status !== 'refused' &&
      st.status !== 'cancelled' &&
      st.status !== 'gone'
    ) {
      st.status = 'cancelled';
      fileStop(st);
      state.fileCancelled++;
      filePaintOut(out);
      fileSettle(out);
    }
    return;
  }
  const rec = state.filesIn.get(peer.id + '|' + x);
  if (!rec || rec.status === 'done' || rec.status === 'refused' || rec.status === 'cancelled')
    return;
  rec.status = 'cancelled';
  fileFinishIn(rec, 'cancelled');
}

function fileOnDone(peer, msg) {
  const rec = state.filesIn.get(peer.id + '|' + String(msg.x || ''));
  if (!rec || rec.status !== 'receiving') return;
  // Metadata comes over the WebSocket and bytes over the data channel, so the last
  // chunk can arrive after this frame; the byte count decides the end.
  if (rec.got !== rec.size) return;
  fileFinishIn(rec, 'done');
}

// fileOnFrame routes one message of the ordered channel of a pair. A frame
// with no kind is a file chunk, which is what the channel carried before any
// other use, so an older page still works. A position frame is opened sealed
// and never touches the file bookkeeping, and a position frame is not a
// chunk: one dropped chunk can be re-read, one dropped position is one tick.
function fileOnFrame(peer, raw) {
  if (typeof raw !== 'string') return;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (!frame || typeof frame !== 'object') return;
  if (frame.t !== undefined) {
    if (frame.t === 'pos' && posOnMessage(peer, frame)) worldOnPos(peer);
    return;
  }
  fileOnChunk(peer, frame);
}

function fileOnChunk(peer, frame) {
  if (!frame || typeof frame.b !== 'string') return;
  const rec = state.filesIn.get(peer.id + '|' + String(frame.x || ''));
  if (!rec || rec.status !== 'receiving' || !peer.keys) return;
  const q = Number(frame.q);
  // The channel is ordered, so only the next number can be current: a repeat, a
  // gap or a chunk of another transfer is dropped before it is opened.
  if (!Number.isSafeInteger(q) || q !== rec.expect) {
    state.replayDrops++;
    return;
  }
  const out = pqCall((json) => pqModule().open(json), {
    key: b64e(peer.keys.recvChat),
    aad: b64e(fileAAD(peer.id, peer.id, rec.x, q, state.idKey && state.idKey.pub, peer.pub && peer.pub.id)),
    b: frame.b,
  });
  if (!out || out.error) {
    state.replayDrops++;
    return;
  }
  const bytes = b64d(out.pt);
  if (rec.got + bytes.length > rec.size) {
    if (peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
    fileFinishIn(rec, 'cancelled');
    return;
  }
  if (rec.writer) fileDiskWrite(rec, bytes);
  else rec.chunks.push(bytes);
  rec.got += bytes.length;
  rec.expect = q + 1;
  state.fileChunksRecv++;
  fileMarkRate(rec, rec.got, performance.now());
  filePaintIn(rec);
  fileArmIn(rec);
  if (rec.got === rec.size) fileFinishIn(rec, 'done');
}

// fileArmIn ends a transfer that stops halfway. Every chunk resets it, so a slow
// link is fine and a silent peer is not waited on forever.
function fileArmIn(rec) {
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => {
    rec.timer = 0;
    if (rec.status !== 'receiving') return;
    const peer = state.peers.get(rec.peerId);
    if (peer && peer.keys) sealedSend(peer, { k: 'file', a: 'cancel', x: rec.x });
    fileFinishIn(rec, 'cancelled');
  }, 20000);
}

// filePump sends one accepted offer to one peer: read a slice, seal it with the
// chat key of the pair, wait when the channel is full. A cancel, a closed channel
// or a missing peer ends the loop at the next step.
async function filePump(out, st) {
  const peer = st.peer;
  const dc = await fileWaitOpen(peer, st);
  if (!dc || st.dead || out.cancelled || !out.file) return;
  const total = Math.ceil(out.size / FILE_CHUNK);
  for (let q = 0; q < total; q++) {
    if (st.dead || out.cancelled || !out.file) return;
    if (!state.peers.has(peer.id) || !peer.keys) {
      fileStop(st);
      return;
    }
    let buf;
    try {
      buf = new Uint8Array(
        await out.file.slice(q * FILE_CHUNK, (q + 1) * FILE_CHUNK).arrayBuffer(),
      );
    } catch {
      fileCancelPeer(out, st, 'the file could not be read');
      return;
    }
    if (st.dead || out.cancelled) return;
    const sealed = pqCall((json) => pqModule().seal(json), {
      key: b64e(peer.keys.sendChat),
      aad: b64e(fileAAD(peer.id, state.self, out.x, q, state.idKey && state.idKey.pub, peer.pub && peer.pub.id)),
      pt: b64e(buf),
    });
    if (!sealed || !sealed.b) {
      fileCancelPeer(out, st, 'a chunk could not be sealed');
      return;
    }
    const ready = await fileSpace(dc, st);
    if (!ready || st.dead || out.cancelled) return;
    try {
      dc.send(JSON.stringify({ x: out.x, q, b: sealed.b }));
    } catch {
      fileCancelPeer(out, st, 'the file channel closed');
      return;
    }
    st.sent = q + 1;
    state.fileChunksSent++;
    fileMarkRate(st, st.sent * FILE_CHUNK, performance.now());
    filePaintOut(out);
  }
  if (st.dead || out.cancelled) return;
  st.status = 'done';
  if (peer.keys) sealedSend(peer, { k: 'file', a: 'done', x: out.x });
  filePaintOut(out);
  fileSettle(out);
}

// fileWaitOpen resolves with the open channel of the pair, or null when it never
// opens, closes or the transfer stops.
function fileWaitOpen(peer, st) {
  return new Promise<RTCDataChannel | null>((resolve) => {
    let timer = 0;
    let dc: RTCDataChannel | null = null;
    const done = (value: RTCDataChannel | null) => {
      if (st.wake !== wake) return;
      st.wake = null;
      clearTimeout(timer);
      if (dc) {
        dc.removeEventListener('open', onOpen);
        dc.removeEventListener('close', onClose);
      }
      resolve(value);
    };
    const wake = () => done(null);
    const onOpen = () => done(dc);
    const onClose = () => done(null);
    const attach = (channel: RTCDataChannel | null) => {
      dc = channel;
      if (!dc) return done(null);
      if (dc.readyState === 'open') return done(dc);
      if (dc.readyState !== 'connecting') return done(null);
      dc.addEventListener('open', onOpen);
      dc.addEventListener('close', onClose);
    };
    st.wake = wake;
    if (peer.dc) attach(peer.dc);
    else if (peer.dcPromise) {
      peer.dcPromise.then((channel) => {
        if (st.wake === wake) attach(channel);
      });
    }
    timer = setTimeout(wake, FILE_OPEN_WAIT);
  });
}

// fileSpace waits while the channel holds more than FILE_BUFFER. The low mark wakes
// it and a timer rechecks, so a lost event can not stall the transfer.
function fileSpace(dc: RTCDataChannel, st) {
  if (dc.readyState !== 'open') return Promise.resolve(false);
  if (dc.bufferedAmount <= FILE_BUFFER) return Promise.resolve(true);
  dc.bufferedAmountLowThreshold = FILE_LOW;
  return new Promise((resolve) => {
    let timer = 0;
    const done = (value) => {
      if (st.wake !== wake) return;
      st.wake = null;
      clearTimeout(timer);
      dc.removeEventListener('bufferedamountlow', onLow);
      resolve(value);
    };
    const wake = () => done(false);
    const onLow = () => {
      if (dc.bufferedAmount <= FILE_BUFFER) done(true);
    };
    st.wake = wake;
    dc.addEventListener('bufferedamountlow', onLow);
    timer = setTimeout(
      () => done(dc.readyState === 'open' && dc.bufferedAmount <= FILE_BUFFER),
      2000,
    );
  });
}

export function fileBindChannel(peer, dc) {
  if (!dc || peer.dc === dc) return;
  if (peer.dc) {
    peer.dc.onmessage = null;
    peer.dc.onclose = null;
    peer.dc.onerror = null;
  }
  peer.dc = dc;
  dc.onmessage = (event) => fileOnFrame(peer, typeof event.data === 'string' ? event.data : '');
  dc.onclose = () => {
    if (peer.dc !== dc) return;
    peer.dc = null;
    fileChannelClosed(peer);
  };
  dc.onerror = () => {
    /* the close event does the bookkeeping */
  };
  if (peer.dcResolve) {
    const resolve = peer.dcResolve;
    peer.dcResolve = null;
    peer.dcPromise = Promise.resolve(dc);
    resolve(dc);
  }
}

// fileChannelClosed ends every transfer of a pair whose channel went away; the
// guest may stay in the room, so only the files stop.
function fileOutGone(id) {
  for (const out of state.files.values()) {
    const st = out.peers.get(id);
    if (!st || FILE_DONE.has(st.status)) continue;
    st.status = 'gone';
    fileStop(st);
    if (!out.cancelled) filePaintOut(out);
    fileSettle(out);
  }
}

// fileChannelClosed is a data channel that went away under a live peer: the
// outgoing offers are gone and a half received file is dropped.
function fileChannelClosed(peer) {
  fileOutGone(peer.id);
  for (const rec of state.filesIn.values()) {
    if (rec.peerId === peer.id && rec.status === 'receiving') fileFinishIn(rec, 'cancelled');
  }
}

// fileDropPeer clears the channel listeners and the waits of a peer that leaves.
// dropPeer and sealedRestart call it before the connection closes.
export function fileDropPeer(peer) {
  const dc = peer.dc;
  peer.dc = null;
  if (dc) {
    dc.onmessage = null;
    dc.onopen = null;
    dc.onclose = null;
    dc.onerror = null;
  }
  if (peer.dcResolve) {
    const resolve = peer.dcResolve;
    peer.dcResolve = null;
    peer.dcPromise = Promise.resolve(null);
    resolve(null);
  }
  filePeerGone(peer.id);
}

function filePeerGone(id) {
  fileOutGone(id);
  for (const rec of state.filesIn.values()) {
    if (rec.peerId === id && !FILE_DONE.has(rec.status)) fileFinishIn(rec, 'gone');
  }
}

function fileStop(st) {
  st.dead = true;
  if (st.wake) st.wake();
}

function fileInText(rec) {
  if (rec.status === 'offered') return 'waiting for you';
  if (rec.status === 'receiving') {
    const pct = rec.size ? Math.round((rec.got / rec.size) * 100) : 0;
    const rate = fileRateText(rec.rate);
    return 'receiving ' + pct + ' percent' + (rate ? ', ' + rate : '');
  }
  if (rec.status === 'done') {
    return rec.disk
      ? 'saved to disk' + (rec.avg ? ', ' + rec.avg : '')
      : 'ready, click save' + (rec.avg ? ', ' + rec.avg : '');
  }
  if (rec.status === 'refused') return 'refused';
  if (rec.status === 'cancelled') return 'cancelled';
  if (rec.status === 'gone') return 'the sender left';
  return '';
}

function filePaintIn(rec) {
  if (!rec.el) return;
  const pct = rec.size ? rec.got / rec.size : 0;
  fileSetBar(rec.el, rec.status === 'receiving', pct);
  rec.el.status.textContent = fileInText(rec);
}

// fileFinishDisk closes the writable after the last queued chunk. The bytes are on
// disk with the name the guest chose, so the row carries no save link.
function fileFinishDisk(rec) {
  const writer = rec.writer;
  rec.writer = null;
  rec.avg = fileAverageRate(rec.size, rec.rateAt, performance.now());
  if (rec.el) rec.el.status.textContent = 'saving to disk' + (rec.avg ? ', ' + rec.avg : '');
  const pending = rec.writes || Promise.resolve();
  pending
    .then(() => writer.close())
    .then(() => {
      state.fileRecv++;
      state.filesIn.delete(rec.key);
      if (rec.el) {
        rec.el.acts.replaceChildren();
        rec.el.status.textContent = fileInText(rec);
      }
    })
    .catch(() => {
      state.filesIn.delete(rec.key);
      if (rec.el) {
        rec.el.acts.replaceChildren();
        rec.el.status.textContent = 'the disk write failed';
      }
    });
}

function fileFinishIn(rec, status) {
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = 0;
  }
  if (status === 'done' && rec.got !== rec.size) status = 'cancelled';
  rec.status = status;
  if (rec.el) rec.el.bar.hidden = true;
  if (status === 'done' && rec.writer) {
    fileFinishDisk(rec);
    return;
  }
  if (status === 'done') {
    // The bytes live in this Blob only. The link hands them over on a click, so
    // nothing is written before it.
    rec.avg = fileAverageRate(rec.size, rec.rateAt, performance.now());
    const blob = new Blob(rec.chunks, { type: rec.type || 'application/octet-stream' });
    rec.chunks = [];
    if (rec.url) {
      URL.revokeObjectURL(rec.url);
      state.fileLinks.delete(rec.url);
    }
    rec.url = URL.createObjectURL(blob);
    state.fileLinks.add(rec.url);
    state.fileRecv++;
    if (rec.el) {
      const link = document.createElement('a');
      link.className = 'file-save';
      link.href = rec.url;
      link.download = rec.name;
      link.textContent = 'save ' + fileBytes(rec.size);
      rec.el.acts.replaceChildren(link);
      rec.el.status.textContent = 'ready, click save' + (rec.avg ? ', ' + rec.avg : '');
    }
    state.filesIn.delete(rec.key);
    return;
  }
  // A refused, cancelled or orphaned transfer keeps no bytes, and a half written
  // file on disk is dropped.
  fileDiskAbort(rec);
  if (rec.url) {
    URL.revokeObjectURL(rec.url);
    state.fileLinks.delete(rec.url);
    rec.url = '';
  }
  if (rec.el) {
    rec.el.acts.replaceChildren();
    rec.el.status.textContent = fileInText(rec);
  }
  state.filesIn.delete(rec.key);
}

function filePaintOut(out) {
  if (!out.el) return;
  const list = [...out.peers.values()];
  const accepted = list.filter((s) => s.status === 'sending' || s.status === 'done');
  const refused = list.filter((s) => s.status === 'refused');
  const gone = list.filter((s) => s.status === 'gone');
  const stopped = list.filter((s) => s.status === 'cancelled');
  const open = list.some((s) => s.status === 'offered' || s.status === 'sending');
  const bytes = accepted.reduce((n, s) => n + Math.min(out.size, s.sent * FILE_CHUNK), 0);
  const total = accepted.length * Math.max(1, out.size);
  const allDone = accepted.length > 0 && accepted.every((s) => s.status === 'done');
  const frac = out.size === 0 ? (allDone ? 1 : 0) : total ? bytes / total : 0;
  fileSetBar(out.el, !out.cancelled && accepted.length > 0 && !allDone, frac);
  if (out.cancelled) {
    out.el.acts.replaceChildren();
    out.el.status.textContent = 'cancelled';
    return;
  }
  const words = ['accepted ' + accepted.length + ' of ' + list.length];
  if (accepted.length) {
    words.push(
      accepted
        .map((s) => {
          const pct = out.size
            ? Math.round((Math.min(out.size, s.sent * FILE_CHUNK) / Math.max(1, out.size)) * 100)
            : s.status === 'done'
              ? 100
              : 0;
          const sent = Math.min(out.size, s.sent * FILE_CHUNK);
          const rate =
            s.status === 'done'
              ? fileAverageRate(sent, s.rateAt, performance.now())
              : fileRateText(s.rate);
          return (
            s.peer.name +
            ' ' +
            (s.status === 'done' ? 'done' : pct + ' percent') +
            (rate ? ', ' + rate : '')
          );
        })
        .join(', '),
    );
  }
  if (refused.length) words.push('refused ' + refused.map((s) => s.peer.name).join(', '));
  if (stopped.length) words.push('cancelled ' + stopped.map((s) => s.peer.name).join(', '));
  if (gone.length) words.push('left ' + gone.map((s) => s.peer.name).join(', '));
  out.el.status.textContent = words.join(' | ');
  // A settled offer keeps no button: nothing is left to cancel.
  if (!open) out.el.acts.replaceChildren();
}

// fileSettle drops the File of an offer once no peer can take it any more, so a
// long call keeps no closed transfers.
function fileSettle(out) {
  const list = [...out.peers.values()];
  if (!list.length) return;
  const open = list.some((s) => s.status === 'offered' || s.status === 'sending');
  if (open) return;
  out.file = null;
  state.files.delete(out.x);
}

export function fileClearAll() {
  for (const out of state.files.values()) {
    out.cancelled = true;
    for (const st of out.peers.values()) fileStop(st);
    out.file = null;
  }
  state.files.clear();
  for (const rec of state.filesIn.values()) {
    fileDiskAbort(rec);
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.url = '';
  }
  state.filesIn.clear();
  for (const url of state.fileLinks) URL.revokeObjectURL(url);
  state.fileLinks.clear();
  state.fileOffers = 0;
  state.fileRecv = 0;
  state.fileChunksSent = 0;
  state.fileChunksRecv = 0;
  state.fileRefused = 0;
  state.fileCancelled = 0;
}
