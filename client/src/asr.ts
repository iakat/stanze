/*
 Local transcription, one language and many.
*/

import { state } from './state.js';
import { load, store } from './prefs.js';
import { addChatLine } from './chat.js';
import { shortPeer } from './sealed.js';
import { sealedSend, toSealed } from './gate.js';

// ------------------------------------------------------------- transcription
// Optional, off by default, two engines in this tab. Vosk holds one model per
// language and the guest picks the language. The multilingual engine holds one
// model for every language, so it has no picker and is offered only when the
// server lists its files. Nothing is loaded until the guest asks. For either
// engine the page downloads what it needs once (the size is shown first), keeps
// it in a browser cache, and runs the recognition for each incoming voice. The
// text goes out as sealed chat, labelled with the name of the guest who
// transcribes, and every other guest is told that someone transcribes before
// the first line. A refused or failed download leaves the call exactly as it
// was.
export const ASR_MODELS = '/vosk/models';

export const ASR_LIB = '/vosk/vosk.js';

export const ASR_CACHE = 'stanze-vosk';

export const ASR_LINE_MAX = 400;

// The multilingual engine is the sherpa-onnx OfflineRecognizer wasm build with
// one Omnilingual model for every language. Its five files, their sizes and
// their hashes come from /omni/models, which answers only when the operator
// set the directory; without it the engine is not offered at all.
export const OMNI_MODELS = '/omni/models';

export const OMNI_DIR = '/omni/';

export const OMNI_CACHE = 'stanze-omni';

export const OMNI_MODEL = 'model.int8.onnx';

export const OMNI_TOKENS = 'tokens.txt';

export const OMNI_API = 'sherpa-onnx-asr.js';

export const OMNI_GLUE = 'sherpa-onnx-wasm-main-vad-asr.js';

export const asr = {
  probed: false,
  models: [], // [{ lang, file, size, modified }] as the server lists them
  lang: '', // the label the guest picked, en by default
  engine: '', // 'vosk' or 'omni', the kept choice, see asrEngine
  busy: false, // a download or a start is under way
  on: false,
  abort: null,
  model: null,
  ctx: null,
  timer: 0,
  recs: new Map(), // peer id -> { rec, proc, src, sink }
  lib: null,
};

export const omni = {
  probed: false,
  files: [], // [{ name, size, modified, sha256 }] as the server lists them
  model: null, // the one model entry, null when the engine is not offered
  size: 0,
  sha: '',
  stamp: '', // size, time and hash of the model, used as the cache key
  busy: false, // a download or a start is under way
  on: false,
  worker: null,
  url: '', // the worker blob, kept while the engine runs
  timer: 0,
  recs: new Map(), // peer id -> { proc, src, sink }
};

// asrStats is what the engine last said about itself: the start, the tail of
// the phrases it decoded with the time each one took, and what the tap saw. A
// browser test reads it through window.e2eApp; the page itself never does.
export const asrStats = {
  engine: '',
  ready: false,
  initMs: null,
  segments: [],
  blocks: 0,
  peak: 0,
  decoded: 0,
};

export const mb = (n) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;

export function asrNote(text) {
  const el = document.getElementById('asr-note');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// asrPaintOthers tells a guest who else in the room transcribes, and what the
// chosen engine costs before it runs.
export function asrPaintOthers() {
  if (asr.busy || asr.on || omni.busy || omni.on) return;
  const names = [...state.peers.values()]
    .filter((p) => p.asr)
    .map((p) => p.name || shortPeer(p.id));
  if (names.length) {
    asrNote(
      `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} transcribing this meeting. The text appears in the chat.`,
    );
    return;
  }
  if (asrEngine() === 'omni' && omni.size) {
    asrNote(
      `multilingual transcription: one model for every language, ${mb(omni.size)} on the first use.`,
    );
    return;
  }
  asrNote('');
}

// asrProbe asks the server, once, which vosk models it offers. Without any
// model that engine stays out of the menu, and there is no second name to try:
// the list is the only offer.
export async function asrProbe() {
  if (asr.probed) return;
  asr.probed = true;
  let list = [];
  try {
    const res = await fetch(ASR_MODELS, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      list = body && Array.isArray(body.langs) ? body.langs : [];
    }
  } catch {
    /* offline or blocked: not offered */
  }
  asr.models = list.filter((m) => m && typeof m.file === 'string' && m.file);
  if (asr.models.length) asrPick(asrDefaultLang());
  asrOffers();
}

// omniProbe asks the server, once, whether the multilingual engine is on
// offer. The one model covers every language, so there is no picker here. A
// 404, a partial list or a blocked request simply leaves the engine out of the
// menu.
export async function omniProbe() {
  if (omni.probed) return;
  omni.probed = true;
  let list = [];
  try {
    const res = await fetch(OMNI_MODELS, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      list = body && Array.isArray(body.files) ? body.files : [];
    }
  } catch {
    /* offline or blocked: not offered */
  }
  omni.files = list.filter((f) => f && typeof f.name === 'string' && f.name);
  const find = (name) => omni.files.find((f) => f.name === name) || null;
  omni.model = find(OMNI_MODEL);
  const tokens = find(OMNI_TOKENS);
  const api = find(OMNI_API);
  const glue = find(OMNI_GLUE);
  if (!omni.model || !tokens || !api || !glue || !(omni.model.size > 0)) {
    omni.files = [];
    omni.model = null;
    asrOffers();
    return;
  }
  omni.size = omni.model.size;
  omni.sha = String(omni.model.sha256 || '');
  omni.stamp = `${omni.size}-${Number(omni.model.modified) || 0}-${omni.sha.slice(0, 8)}`;
  asrOffers();
}

// asrOffers reveals the transcribe entry once at least one engine is on offer
// and settles the engine choice on one the server still serves. The kept choice
// is not written here: only a guest's own pick is.
export function asrOffers() {
  if (!asr.models.length && !omni.model) return;
  asrSetEngine(asrEngine(), false);
  const entry = document.getElementById('menu-asr-btn');
  if (entry) entry.hidden = false;
}

// asrEngine is the engine the guest picked, else the one this browser kept,
// and never an engine the server does not offer. Vosk wins the first visit
// when both are on offer, so an existing room behaves as it did.
export function asrEngine() {
  const kept = asr.engine || load('asr.engine');
  if (kept === 'omni' && omni.model) return 'omni';
  if (kept === 'vosk' && asr.models.length) return 'vosk';
  if (asr.models.length) return 'vosk';
  if (omni.model) return 'omni';
  return '';
}

// asrSetEngine keeps the choice and paints the picker and the menu entry.
export function asrSetEngine(name, keep?) {
  const engine =
    name === 'omni' && omni.model
      ? 'omni'
      : name === 'vosk' && asr.models.length
        ? 'vosk'
        : asrEngine();
  if (keep !== false) {
    asr.engine = engine;
    store('asr.engine', engine);
  }
  if (engine === 'vosk' && asr.models.length) asrPick(asr.lang || asrDefaultLang());
  asrPaintLangRow();
  asrPaintEntry();
  asrPaintOthers();
}

// asrChoices is everything the one picker offers: each vosk language, then the
// multilingual model, which covers every language alone. Every entry carries
// the size of what it downloads, so the price of a pick is on the pick.
export function asrChoices() {
  const list = asr.models.map((m) => ({
    value: `vosk:${m.lang}`,
    text: m.size ? `${m.lang} (${mb(m.size)})` : m.lang,
  }));
  if (omni.model) {
    list.push({
      value: 'omni',
      text: omni.size ? `omni, every language (${mb(omni.size)})` : 'omni, every language',
    });
  }
  return list;
}

// asrChoice is the picker value of the engine and language in force.
export function asrChoice() {
  if (asrEngine() === 'omni') return 'omni';
  const model = asrModel();
  return model ? `vosk:${model.lang}` : '';
}

// asrChoose takes one value of the picker: a language of the vosk engine or
// the multilingual model.
export function asrChoose(value) {
  if (value === 'omni') {
    asrSetEngine('omni');
    return;
  }
  if (value.startsWith('vosk:')) {
    asrSetEngine('vosk');
    asrPick(value.slice('vosk:'.length));
  }
}

// asrPaintLangRow fills the one picker from asrChoices and hides the row while
// there is no second thing to pick: one model that is the only offer needs no
// menu. The row and the select go together, so the picker is never drawn inside
// a row the page declares hidden.
export function asrPaintLangRow() {
  const select = document.getElementById('asr-lang') as HTMLSelectElement | null;
  if (!select) return;
  const choices = asrChoices();
  const value = asrChoice();
  select.replaceChildren(
    ...choices.map((choice) => {
      const o = document.createElement('option');
      o.value = choice.value;
      o.textContent = choice.text;
      o.selected = choice.value === value;
      return o;
    }),
  );
  select.value = value;
  select.hidden = choices.length < 2;
  const row = select.closest('.menu-item');
  if (row) (row as HTMLElement).hidden = choices.length < 2;
}

// asrPaintEntry puts the engine and its size on the menu entry, before the
// guest opens the menu.
export function asrPaintEntry() {
  const btn = document.getElementById('menu-asr-btn');
  if (!btn) return;
  if (asrEngine() === 'omni') {
    btn.title = `transcription, every language, ${omni.size ? mb(omni.size) : 'one model'}`;
    return;
  }
  const model = asrModel();
  if (model) btn.title = `transcription, language ${model.lang}, ${mb(model.size)}`;
}

// asrDefaultLang is the kept choice, else the language of the browser, else the
// first model the server lists, which is en by the server's order.
export function asrDefaultLang() {
  const have = asr.models.map((m) => m.lang);
  const kept = load('asr.lang');
  if (kept && have.includes(kept)) return kept;
  const want = String(navigator.language || '')
    .toLowerCase()
    .slice(0, 2);
  if (want && have.includes(want)) return want;
  return have[0];
}

// asrModel is the entry the guest picked, and never nothing once a model is on
// offer.
export function asrModel() {
  return asr.models.find((m) => m.lang === asr.lang) || asr.models[0] || null;
}

// asrPick sets the label and paints the picker and the size of that model.
export function asrPick(lang) {
  const model = asr.models.find((m) => m.lang === lang) || asr.models[0];
  if (!model) return;
  asr.lang = model.lang;
  store('asr.lang', model.lang);
  asrPaintLangRow();
  const btn = document.getElementById('menu-asr-btn');
  if (btn) asrPaintEntry();
}

// asrCacheKey is a request that is only ever used as a key. The file name is in
// the key, so a second language gets its own entry and the old one goes.
export function asrCacheKey() {
  const model = asrModel();
  const file = model ? model.file : '';
  const stamp = model ? `${model.size}-${model.modified}` : '';
  return new Request(`${location.origin}/vosk/${file}?m=${encodeURIComponent(stamp)}`);
}

export async function asrCached() {
  try {
    if (!window.caches) return null;
    const cache = await caches.open(ASR_CACHE);
    const hit = await cache.match(asrCacheKey());
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

// asrFetchModel downloads the model with a progress line. It reads the body to
// the end, keeps it in the cache and returns the blob.
export async function asrFetchModel(signal) {
  const model = asrModel();
  if (!model) throw new Error('no model is on offer');
  const res = await fetch(`/vosk/${model.file}`, { signal, cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
  const total = model.size || parseInt(res.headers.get('content-length') || '0', 10) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    asrNote(
      total
        ? `downloading the transcription model: ${mb(got)} of ${mb(total)} (${Math.floor((got * 100) / total)}%)`
        : `downloading the transcription model: ${mb(got)}`,
    );
  }
  const blob = new Blob(parts, { type: 'application/gzip' });
  try {
    if (window.caches) {
      // Older entries go, so the cache holds one model only.
      await caches.delete(ASR_CACHE);
      const cache = await caches.open(ASR_CACHE);
      await cache.put(
        asrCacheKey(),
        new Response(blob, { headers: { 'content-type': 'application/gzip' } }),
      );
    }
  } catch {
    /* no cache: the model is used now and fetched again next time */
  }
  return blob;
}

export function asrLoadLib() {
  if (asr.lib) return asr.lib;
  asr.lib = new Promise((resolve, reject) => {
    const have = (window as any).Vosk;
    if (have) return resolve(have);
    const el = document.createElement('script');
    el.src = ASR_LIB;
    el.onload = () => {
      const lib = (window as any).Vosk;
      return lib ? resolve(lib) : reject(new Error('the engine did not load'));
    };
    el.onerror = () => reject(new Error('the engine could not be loaded'));
    document.head.appendChild(el);
  }).catch((err) => {
    asr.lib = null;
    throw err;
  });
  return asr.lib;
}

// asrSay sends one sealed transcription message to everyone inside.
export function asrSay(obj) {
  toSealed({ k: 'asr', ...obj });
}

// asrAnnounce tells a guest who joined later that we transcribe, whichever
// engine runs: the message is the same one for both.
export function asrAnnounce(peer) {
  if ((!asr.on && !omni.on) || !peer.keys || peer.waiting) return;
  sealedSend(peer, { k: 'asr', s: 'on' });
}

// asrTap hooks one incoming voice to a recognizer of its own. It reads the
// source before the volume of that guest, so a guest turned down is still heard
// by the engine.
export function asrTap(peer) {
  const ctx = state.playCtx;
  if (!asr.on || !asr.model || !ctx || !peer.audioSrc) return;
  const have = asr.recs.get(peer.id);
  if (have && have.src === peer.audioSrc) return;
  if (have) asrUntap(peer.id);
  const rec = new asr.model.KaldiRecognizer(ctx.sampleRate);
  const speaker = () => peer.name || shortPeer(peer.id);
  rec.on('result', (message) => {
    const text = String((message.result && message.result.text) || '').trim();
    if (!text || !asr.on) return;
    const line = text.slice(0, ASR_LINE_MAX);
    const who = speaker();
    addChatLine(`transcript by ${state.name || 'you'}`, `${who}: ${line}`, Date.now());
    asrSay({ w: who.slice(0, 64), x: line, ts: Date.now() });
  });
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (event) => {
    // A copy, because the engine takes the buffer to its worker.
    try {
      rec.acceptWaveformFloat(
        new Float32Array(event.inputBuffer.getChannelData(0)),
        ctx.sampleRate,
      );
    } catch {
      /* recognizer gone */
    }
  };
  // The processor only runs when it is wired to an output; the gain of zero
  // keeps it silent.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  peer.audioSrc.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  asr.recs.set(peer.id, { rec, proc, src: peer.audioSrc, sink });
}

export function asrUntap(id) {
  const h = asr.recs.get(id);
  if (!h) return;
  asr.recs.delete(id);
  try {
    h.src.disconnect(h.proc);
  } catch {
    /* source already gone */
  }
  try {
    h.proc.disconnect();
    h.sink.disconnect();
  } catch {
    /* already gone */
  }
  h.proc.onaudioprocess = null;
  try {
    h.rec.retrieveFinalResult();
  } catch {
    /* recognizer gone */
  }
  setTimeout(() => {
    try {
      h.rec.remove();
    } catch {
      /* recognizer gone */
    }
  }, 1500);
}

// asrSync follows the room: a recognizer for each guest inside who has a voice,
// none for a guest who waits, and none for a guest who left.
export function asrSync() {
  if (!asr.on) return;
  for (const id of [...asr.recs.keys()]) {
    const peer = state.peers.get(id);
    if (!peer || peer.waiting) asrUntap(id);
  }
  for (const peer of state.peers.values()) {
    if (!peer.waiting) asrTap(peer);
  }
}

export function asrStop() {
  if (asr.abort) asr.abort.abort();
  asr.abort = null;
  const was = asr.on;
  asr.on = false;
  clearInterval(asr.timer);
  asr.timer = 0;
  for (const id of [...asr.recs.keys()]) asrUntap(id);
  if (asr.model) {
    const model = asr.model;
    // After the recognizers are gone, the worker and its memory go too.
    setTimeout(() => {
      try {
        model.terminate();
      } catch {
        /* already gone */
      }
    }, 2000);
    asr.model = null;
  }
  asr.busy = false;
  if (was) asrSay({ s: 'off' });
  paintAsr();
  asrNote('');
  asrPaintOthers();
}

export async function asrStart() {
  asr.busy = true;
  asr.abort = new AbortController();
  const signal = asr.abort.signal;
  paintAsr();
  try {
    let blob = await asrCached();
    if (!blob) {
      const model = asrModel();
      const size = model && model.size ? mb(model.size) : 'a large file';
      // The guest asked for transcription; this is the size, before any byte.
      if (
        !window.confirm(
          `Transcription runs in this tab and needs a one-time download of ${size}. The model is kept in the browser cache. Download it now?`,
        )
      ) {
        asrStop();
        return;
      }
      blob = await asrFetchModel(signal);
    }
    if (signal.aborted) return;
    asrNote('starting the transcription engine');
    const Vosk = await asrLoadLib();
    const url = URL.createObjectURL(blob);
    try {
      asr.model = await Vosk.createModel(url);
    } finally {
      // The worker has fetched the blob once the model is ready.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if (signal.aborted) {
      asr.model.terminate();
      asr.model = null;
      return;
    }
    asr.on = true;
    asr.busy = false;
    asr.abort = null;
    paintAsr();
    asrNote(
      'You transcribe this meeting. The text goes to the chat under your name, and your own voice is not transcribed.',
    );
    asrSay({ s: 'on' });
    asrSync();
    asr.timer = setInterval(asrSync, 2000);
  } catch (err) {
    if (signal.aborted) return;
    asrStop();
    asrNote(
      `Transcription could not start: ${err && err.message ? err.message : 'the download failed'}. The call is not affected.`,
    );
  }
}

// paintAsr puts the state of the chosen engine on the tick row of the menu: a
// tick while it runs, and the same tick while its model is on the way, so the
// row stays a way to cancel a download that has started. A start in progress
// therefore does not lock the row.
export function paintAsr() {
  const box = document.getElementById('asr-on') as HTMLInputElement | null;
  if (!box) return;
  const engine = asrEngine();
  const busy = engine === 'omni' ? omni.busy : asr.busy;
  box.checked = busy || (engine === 'omni' ? omni.on : asr.on);
  box.disabled = false;
}

export function initAsr() {
  const box = document.getElementById('asr-on') as HTMLInputElement | null;
  if (!box) return;
  box.addEventListener('change', () => {
    if (!box.checked) {
      asrStop();
      omniStop();
    } else if (asrEngine() === 'omni') {
      omniStart();
    } else {
      asrStart();
    }
  });
  const select = document.getElementById('asr-lang') as HTMLSelectElement | null;
  if (select) {
    select.addEventListener('change', () => {
      // One engine runs at a time and a pick may be a 348 MB download, so a
      // change stops what runs and restarts only the engine that was running:
      // the new pick is started by the guest's own tick otherwise.
      const was = asr.on || omni.on;
      asrStop();
      omniStop();
      asrChoose(select.value);
      paintAsr();
      if (!was) return;
      if (asrEngine() === 'omni') omniStart();
      else asrStart();
    });
  }
}

// asrOnMessage handles a sealed transcription message from a guest.
export function asrOnMessage(peer, obj) {
  const name = peer.name || shortPeer(peer.id);
  if (obj.s === 'on' || obj.s === 'off') {
    peer.asr = obj.s === 'on';
    if (peer.asr) addChatLine('stanze', `${name} started transcribing this meeting`, Date.now());
    asrPaintOthers();
    return;
  }
  const text = String(obj.x || '').slice(0, ASR_LINE_MAX);
  const who = String(obj.w || '').slice(0, 64);
  if (!text) return;
  // The label is the guest who sent it, as this tab knows that guest, and never
  // a name taken from the message.
  state.chatRecv++;
  addChatLine(`transcript by ${name}`, `${who}: ${text}`, Date.now());
}

// ------------------------------------------------- multilingual transcription
// The multilingual engine runs in one worker of its own. Its model is 348 MB,
// so the page keeps it in the browser cache in parts, checks it against the
// hash the server lists, and mounts it into the wasm filesystem. A stop
// terminates the worker, which drops the model, the threads and any download
// at once, and leaves the call untouched.
export async function omniStart() {
  if (omni.busy || omni.on || !omni.model) return;
  if (!window.crossOriginIsolated) {
    asrNote(
      'The multilingual engine needs a cross-origin isolated page. The call is not affected.',
    );
    paintAsr();
    return;
  }
  const size = omni.size ? mb(omni.size) : 'a large file';
  // The model is best effort in the browser cache, so ask for a durable store
  // and say when the space is not there, before the download and not after it.
  let tight = false;
  try {
    if (navigator.storage && navigator.storage.persist) {
      Promise.resolve(navigator.storage.persist()).catch(() => {});
    }
    const est =
      navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    tight = !!(est && est.quota && est.quota - est.usage < omni.size);
  } catch {
    /* no estimate */
  }
  const keep = tight
    ? 'The browser has less free storage than that, so the model cannot be kept and the next visit downloads it again.'
    : 'The model is kept in the browser cache, so this is the only download.';
  // The guest asked for transcription; this is the size, before any byte.
  if (
    !window.confirm(
      `Multilingual transcription runs in this tab and needs a one-time download of ${size}. ${keep} Download it now?`,
    )
  ) {
    paintAsr();
    return;
  }
  omni.busy = true;
  paintAsr();
  asrNote(`starting the multilingual engine: one model for every language, ${size}`);
  try {
    omni.worker = omniSpawn();
  } catch (err) {
    omniFail(
      `the engine could not start: ${err && err.message ? err.message : 'the worker was refused'}`,
    );
  }
}

// omniSpawn starts the engine worker. The script is built here, so the client
// stays one file, and its blob lives as long as the engine: the wasm build
// starts its own threads from the same url.
export function omniSpawn() {
  const cfg = {
    base: location.origin + OMNI_DIR,
    api: location.origin + OMNI_DIR + OMNI_API,
    glue: location.origin + OMNI_DIR + OMNI_GLUE,
    modelUrl: location.origin + OMNI_DIR + OMNI_MODEL,
    tokensUrl: location.origin + OMNI_DIR + OMNI_TOKENS,
    modelName: OMNI_MODEL,
    tokensName: OMNI_TOKENS,
    cache: OMNI_CACHE,
    size: omni.size,
    sha: omni.sha,
    stamp: omni.stamp,
  };
  const url = URL.createObjectURL(new Blob([omniWorkerSource(cfg)], { type: 'text/javascript' }));
  const worker = new Worker(url);
  omni.url = url;
  worker.onmessage = (event) => omniOnWorker(event.data || {});
  worker.onerror = (event) => omniFail(event.message || 'the engine stopped');
  return worker;
}

// omniOnWorker is every word the engine says: its progress, its ready, one line
// of text for each phrase, and its faults.
export function omniOnWorker(msg) {
  if (!omni.busy && !omni.on) return;
  switch (msg.ev) {
    case 'status':
      if (omni.busy) asrNote(String(msg.text || 'starting the multilingual engine'));
      return;
    case 'progress':
      omniProgress(msg);
      return;
    case 'ready':
      if (!omni.busy) return;
      omni.busy = false;
      omni.on = true;
      asrStats.engine = 'omni';
      asrStats.ready = true;
      asrStats.initMs = Number(msg.ms) || null;
      paintAsr();
      asrNote(
        'You transcribe this meeting. The text goes to the chat under your name, and your own voice is not transcribed.',
      );
      asrSay({ s: 'on' });
      omniSync();
      omni.timer = setInterval(omniSync, 2000);
      return;
    case 'decoded':
      asrStats.decoded++;
      return;
    case 'line': {
      const ms = Number(msg.ms);
      const sec = Number(msg.sec);
      if (Number.isFinite(ms) && ms > 0 && sec > 0) {
        asrStats.segments.push({ ms, audioSec: sec });
        if (asrStats.segments.length > 8) asrStats.segments.shift();
      }
      omniLine(String(msg.id || ''), String(msg.text || ''));
      return;
    }
    case 'error':
      omniFail(String(msg.text || 'the engine stopped'));
      return;
    default:
      return;
  }
}

export function omniProgress(msg) {
  if (!omni.busy) return;
  const total = Number(msg.total) || omni.size;
  const got = Number(msg.got) || 0;
  const where = msg.cached
    ? 'reading the transcription model from the browser cache'
    : 'downloading the transcription model';
  asrNote(
    total
      ? `${where}: ${mb(got)} of ${mb(total)} (${Math.floor((got * 100) / total)}%)`
      : `${where}: ${mb(got)}`,
  );
}

// omniFail fails the engine and nothing else: the note says so and the call
// keeps working.
export function omniFail(text) {
  const was = omni.on;
  omniStop();
  asrNote(
    was
      ? `Transcription stopped: ${text}. The call is not affected.`
      : `Transcription could not start: ${text}. The call is not affected.`,
  );
}

export function omniStop() {
  const was = omni.on;
  omni.on = false;
  omni.busy = false;
  asrStats.engine = '';
  asrStats.ready = false;
  clearInterval(omni.timer);
  omni.timer = 0;
  for (const id of [...omni.recs.keys()]) omniUntap(id);
  if (omni.worker) {
    try {
      omni.worker.terminate();
    } catch {
      /* already gone */
    }
    omni.worker = null;
  }
  if (omni.url) {
    try {
      URL.revokeObjectURL(omni.url);
    } catch {
      /* already gone */
    }
    omni.url = '';
  }
  if (was) asrSay({ s: 'off' });
  paintAsr();
  asrNote('');
  asrPaintOthers();
}

// omniTap hooks one incoming voice to the engine worker. It reads the source
// before the volume of that guest, like the vosk tap, so a guest turned down is
// still heard by the engine.
export function omniTap(peer) {
  const ctx = state.playCtx;
  if (!omni.on || !omni.worker || !ctx || !peer.audioSrc) return;
  const have = omni.recs.get(peer.id);
  if (have && have.src === peer.audioSrc) return;
  if (have) omniUntap(peer.id);
  const id = peer.id;
  const worker = omni.worker;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (event) => {
    if (!omni.on || omni.worker !== worker) return;
    const block = event.inputBuffer.getChannelData(0);
    // What the tap saw, so a test can tell a silent source from a deaf engine.
    asrStats.blocks++;
    let top = 0;
    for (let i = 0; i < block.length; i++) {
      const v = block[i] < 0 ? -block[i] : block[i];
      if (v > top) top = v;
    }
    if (top > asrStats.peak) asrStats.peak = top;
    const samples = omniDown(block, ctx.sampleRate);
    if (!samples.length) return;
    try {
      worker.postMessage({ cmd: 'audio', id, samples }, [samples.buffer]);
    } catch {
      /* engine gone */
    }
  };
  // The processor only runs when it is wired to an output; the gain of zero
  // keeps it silent.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  peer.audioSrc.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  omni.recs.set(id, { proc, src: peer.audioSrc, sink });
}

export function omniUntap(id) {
  const h = omni.recs.get(id);
  if (!h) return;
  omni.recs.delete(id);
  try {
    h.src.disconnect(h.proc);
  } catch {
    /* source already gone */
  }
  try {
    h.proc.disconnect();
    h.sink.disconnect();
  } catch {
    /* already gone */
  }
  h.proc.onaudioprocess = null;
}

// omniSync follows the room like the vosk one: a tap for each guest inside who
// has a voice, none for a guest who waits, and none for a guest who left.
export function omniSync() {
  if (!omni.on) return;
  for (const id of [...omni.recs.keys()]) {
    const peer = state.peers.get(id);
    if (!peer || peer.waiting) omniUntap(id);
  }
  for (const peer of state.peers.values()) {
    if (!peer.waiting) omniTap(peer);
  }
}

// omniDown mixes one block to mono at 16 kHz with a box filter. The engine
// takes 16 kHz and a speech model needs nothing finer.
export function omniDown(input, rate) {
  if (rate === 16000) return new Float32Array(input);
  const ratio = rate / 16000;
  const n = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    out[i] = to > from ? sum / (to - from) : 0;
  }
  return out;
}

// omniLine puts one decoded phrase on the chat and sends it to the others, in
// the same shape the vosk engine uses.
export function omniLine(id, text) {
  if (!omni.on) return;
  const line = text.slice(0, ASR_LINE_MAX);
  if (!line) return;
  const peer = state.peers.get(id);
  const who = peer ? peer.name || shortPeer(id) : shortPeer(id);
  addChatLine(`transcript by ${state.name || 'you'}`, `${who}: ${line}`, Date.now());
  asrSay({ w: who.slice(0, 64), x: line, ts: Date.now() });
}

// omniWorkerSource turns the function below into the worker script. The blob
// needs no extra file and no build step.
export function omniWorkerSource(cfg) {
  return `(${omniWorker.toString()})(${JSON.stringify(cfg)});`;
}

// omniWorker is the engine in its own thread: a model load takes seconds and
// one phrase most of a second, and the call must keep its picture and its sound
// meanwhile. The wasm build is the sherpa-onnx OfflineRecognizer with the
// Omnilingual model. No voice activity model is served, so the phrase gate here
// is a plain level gate: four quiet frames end a phrase, the quiet tail is cut
// and three frames before the first loud one are kept, so the first word is not
// lost.
export function omniWorker(cfg) {
  const G = self as any;
  G.Module = {
    // The wasm and its worker threads live under /omni/. The base is absolute,
    // because a blob worker has no useful directory of its own.
    locateFile: (path) => cfg.base + path,
    print: (text) => {
      if (text) console.log('[omni] ' + text);
    },
    printErr: (text) => {
      if (text) console.warn('[omni] ' + text);
    },
    onAbort: (why) => G.postMessage({ ev: 'error', text: String(why || 'the engine stopped') }),
  };
  // The API layer first, then the emscripten glue that starts the wasm.
  G.importScripts(cfg.api, cfg.glue);
  // One of the wasm build's own threads runs this same script again. The glue
  // then owns the port, so nothing below may run there.
  if (/^em-pthread/.test(G.name || '')) return;

  const RATE = 16000;
  const FRAME = 1600; // 100 ms, the step of the level gate
  const THRESHOLD = 0.012; // root mean square that counts as speech
  const TAIL = 4; // quiet frames that end a phrase
  const PRE = 3; // frames kept before the first loud one
  const MAXLEN = RATE * 30; // a longer phrase is cut and decoded
  const PART = 32 * 1048576; // one browser cache entry per 32 MB

  const post = (msg, transfer = []) => G.postMessage(msg, transfer);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const segs = new Map(); // peer id -> gate and phrase state
  const queue = []; // phrases waiting for the recognizer
  let rec = null;
  let decoding = false;
  let lastProgress = 0;

  function short(err) {
    const text = String((err && err.message) || err || 'the engine stopped');
    return text.slice(0, 200);
  }

  function hex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      const end = Math.min(i + 4096, bytes.length);
      for (let j = i; j < end; j++) out += bytes[j].toString(16).padStart(2, '0');
    }
    return out;
  }

  async function hash(bytes) {
    if (!G.crypto || !G.crypto.subtle) return '';
    const sum = await G.crypto.subtle.digest('SHA-256', bytes);
    return hex(new Uint8Array(sum));
  }

  function partKey(index) {
    return `${cfg.base}${cfg.modelName}?part=${index}&m=${encodeURIComponent(cfg.stamp)}`;
  }

  // fromCache reads the model out of the browser cache in parts. A part that is
  // missing or short means no hit at all. The hash is checked before the wasm
  // reads a byte, so a cut or stale entry goes instead of breaking the engine.
  async function fromCache() {
    if (!G.caches || !cfg.size) return null;
    const count = Math.ceil(cfg.size / PART);
    let cache = null;
    let first = null;
    try {
      cache = await G.caches.open(cfg.cache);
      first = await cache.match(partKey(0));
    } catch {
      return null;
    }
    if (!first) return null;
    post({ ev: 'progress', got: 0, total: cfg.size, cached: true });
    const bytes = new Uint8Array(cfg.size);
    try {
      for (let i = 0; i < count; i++) {
        const hit = i === 0 ? first : await cache.match(partKey(i));
        if (!hit) return null;
        const body = new Uint8Array(await hit.arrayBuffer());
        const at = i * PART;
        if (body.length !== Math.min(PART, cfg.size - at)) return null;
        bytes.set(body, at);
      }
    } catch {
      return null;
    }
    if (cfg.sha) {
      const sum = await hash(bytes);
      if (sum && sum !== cfg.sha) {
        try {
          await G.caches.delete(cfg.cache);
        } catch {
          /* not ours */
        }
        return null;
      }
    }
    post({ ev: 'progress', got: cfg.size, total: cfg.size, cached: true });
    return bytes;
  }

  // fromNetwork downloads the model once and writes every finished part to the
  // cache. The cache is best effort: a tab without cache storage still
  // transcribes now, it just pays the download again next time.
  async function fromNetwork() {
    const res = await fetch(cfg.modelUrl, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
    const bytes = new Uint8Array(cfg.size);
    let cache = null;
    try {
      if (G.caches) cache = await G.caches.open(cfg.cache);
    } catch {
      cache = null;
    }
    const reader = res.body.getReader();
    let got = 0;
    let part = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > cfg.size)
        throw new Error('the server sent more than the model size');
      bytes.set(value, got);
      got += value.length;
      if (got - lastProgress >= 2097152) {
        lastProgress = got;
        post({ ev: 'progress', got, total: cfg.size, cached: false });
      }
      // Finished parts go at once, so a stopped tab keeps what it paid for.
      while (cache && got - part * PART >= PART) {
        const at = part * PART;
        try {
          await cache.put(partKey(part), new Response(bytes.subarray(at, at + PART)));
        } catch {
          cache = null;
        }
        part++;
      }
    }
    if (got !== cfg.size) {
      throw new Error(
        `the download stopped at ${Math.round(got / 1048576)} of ${Math.round(cfg.size / 1048576)} MB`,
      );
    }
    if (cache && part * PART < cfg.size) {
      const at = part * PART;
      try {
        await cache.put(partKey(part), new Response(bytes.subarray(at, cfg.size)));
      } catch {
        /* no cache */
      }
    }
    post({ ev: 'progress', got: cfg.size, total: cfg.size, cached: false });
    if (cfg.sha) {
      const sum = await hash(bytes);
      if (sum && sum !== cfg.sha) {
        try {
          await G.caches.delete(cfg.cache);
        } catch {
          /* not ours */
        }
        throw new Error('the model did not match its hash');
      }
    }
    return bytes;
  }

  function mount(name, bytes) {
    try {
      G.Module.FS_unlink('/' + name);
    } catch {
      /* not mounted before */
    }
    G.Module.FS_createDataFile('/', name, bytes, true, true, true);
  }

  async function waitRuntime() {
    const t0 = performance.now();
    while (!G.Module.calledRun) {
      if (performance.now() - t0 > 180000) throw new Error('the engine never started');
      await sleep(50);
    }
  }

  async function start() {
    const t0 = performance.now();
    post({ ev: 'status', text: 'starting the engine' });
    await waitRuntime();
    post({ ev: 'status', text: 'loading the model' });
    let bytes = await fromCache();
    if (!bytes) {
      post({ ev: 'status', text: 'downloading the model' });
      bytes = await fromNetwork();
    }
    const res = await fetch(cfg.tokensUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`the token table answered ${res.status}`);
    const tokens = new Uint8Array(await res.arrayBuffer());
    mount(cfg.modelName, bytes);
    mount(cfg.tokensName, tokens);
    post({ ev: 'status', text: 'starting the recognizer' });
    const config = {
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        omnilingual: { model: './' + cfg.modelName },
        tokens: './' + cfg.tokensName,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        modelType: '',
      },
      decodingMethod: 'greedy_search',
    };
    // The API layer declares this class in the worker's global scope.
    // @ts-expect-error the worker declares this class in its own scope
    rec = new OfflineRecognizer(config, G.Module);
    if (!rec || !rec.handle) throw new Error('the recognizer did not start');
    post({ ev: 'ready', ms: Math.round(performance.now() - t0) });
    pump();
  }

  function rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }

  function begin() {
    return { rest: new Float32Array(0), pre: [], samples: [], len: 0, speech: false, quiet: 0 };
  }

  // flush hands one finished phrase to the queue. A phrase shorter than half a
  // second carries no word, only a door or a chair.
  function flush(id, st) {
    const parts = st.samples;
    const len = st.len;
    st.samples = [];
    st.len = 0;
    st.speech = false;
    st.quiet = 0;
    if (len < RATE / 2) return;
    const all = new Float32Array(len);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    // The queue is short on purpose: a slow tab drops the oldest phrase rather
    // than grow without end.
    queue.push({ id, samples: all });
    if (queue.length > 8) queue.shift();
    setTimeout(pump, 0);
  }

  function frame(id, st, f) {
    const loud = rms(f) >= THRESHOLD;
    if (!st.speech) {
      if (!loud) {
        st.pre.push(new Float32Array(f));
        if (st.pre.length > PRE) st.pre.shift();
        return;
      }
      st.speech = true;
      st.quiet = 0;
      st.samples = st.pre.concat([new Float32Array(f)]);
      st.len = st.samples.reduce((n, part) => n + part.length, 0);
      st.pre = [];
      return;
    }
    st.samples.push(new Float32Array(f));
    st.len += f.length;
    st.quiet = loud ? 0 : st.quiet + 1;
    if (st.quiet >= TAIL || st.len >= MAXLEN) {
      // The quiet tail goes, it carries no word.
      while (st.quiet > 0 && st.samples.length > 1) {
        st.len -= st.samples.pop().length;
        st.quiet--;
      }
      flush(id, st);
    }
  }

  function pushAudio(id, samples) {
    let st = segs.get(id);
    if (!st) {
      st = begin();
      segs.set(id, st);
    }
    const all = new Float32Array(st.rest.length + samples.length);
    all.set(st.rest);
    all.set(samples, st.rest.length);
    let at = 0;
    for (; all.length - at >= FRAME; at += FRAME) frame(id, st, all.subarray(at, at + FRAME));
    st.rest = all.subarray(at);
  }

  function pump() {
    if (decoding || !rec || queue.length === 0) return;
    const job = queue.shift();
    decoding = true;
    const t0 = performance.now();
    let text = '';
    try {
      const stream = rec.createStream();
      stream.acceptWaveform(RATE, job.samples);
      rec.decode(stream);
      const result = rec.getResult(stream);
      text = String((result && result.text) || '').trim();
      stream.free();
    } catch (err) {
      decoding = false;
      post({ ev: 'error', text: short(err) });
      return;
    }
    decoding = false;
    // Every phrase decoded goes to the page, empty or not, so its counters show
    // a deaf engine apart from a silent room.
    post({
      ev: 'decoded',
      ms: Math.round(performance.now() - t0),
      sec: job.samples.length / RATE,
      len: text.length,
    });
    if (text)
      post({
        ev: 'line',
        id: job.id,
        text,
        ms: Math.round(performance.now() - t0),
        sec: job.samples.length / RATE,
      });
    // One phrase per turn of the event loop, so queued audio is read first.
    setTimeout(pump, 0);
  }

  G.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.cmd === 'audio' && rec && msg.samples) pushAudio(String(msg.id || ''), msg.samples);
  };

  start().catch((err) => post({ ev: 'error', text: short(err) }));
}
