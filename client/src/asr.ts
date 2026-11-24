/*
 Local transcription, one language and many.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { load, store } from './prefs.js';
import { addChatLine } from './chat.js';
import { shortPeer } from './sealed.js';
import { disconnectQuietly } from './util.js';
import { sealedSend, toSealed } from './gate.js';
import { scriptURL } from './trust.js';

// ------------------------------------------------------------- transcription
// Optional, off by default, two engines in this tab. Vosk holds one model per
// language, the multilingual engine one model for every language and no picker.
// Nothing loads until the guest asks; the model is downloaded once, kept in a
// browser cache, and the text goes out as sealed chat under the name of the
// guest who transcribes. A failed download leaves the call as it was.
const ASR_MODELS = '/vosk/models';

const ASR_LIB = '/vosk/vosk.js';

const ASR_CACHE = 'stanze-vosk';

const ASR_LINE_MAX = 400;

// The multilingual engine is the sherpa-onnx OfflineRecognizer wasm build with
// one Omnilingual model for every language. /omni/models lists the four files it
// needs, with sizes and hashes, and answers only when the operator set the
// directory; without it the engine is not offered.
const OMNI_MODELS = '/omni/models';

const OMNI_DIR = '/omni/';

const OMNI_CACHE = 'stanze-omni';

const OMNI_MODEL = 'model.int8.onnx';

const OMNI_TOKENS = 'tokens.txt';

const OMNI_API = 'sherpa-onnx-asr.js';

const OMNI_GLUE = 'sherpa-onnx-wasm-main-vad-asr.js';

export const asr = {
  probed: false,
  models: [], // [{ lang, file, size, modified }] as the server lists them
  lang: '', // the label the guest picked, empty until a pick
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

const omni = {
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

// asrStats is what the engine last said about itself: start time, the last few
// decoded phrases with their cost, and what the tap saw. Only window.e2eApp
// reads it.
export const asrStats = {
  engine: '',
  ready: false,
  initMs: null,
  segments: [],
  blocks: 0,
  peak: 0,
  decoded: 0,
};

const mb = (n) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;

function asrNote(text) {
  const el = $('asr-note');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// asrPaintOthers names the other guests who transcribe, or the cost of the chosen
// engine.
function asrPaintOthers() {
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

// asrProbe asks the server once which vosk models it offers; an empty list keeps
// that engine out of the menu.
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

// omniProbe asks the server once whether the multilingual engine is on offer; a
// 404, a partial list or a blocked request leaves it out of the menu.
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

// asrOffers reveals the transcribe entry and settles the engine on one the server
// serves; only a guest's own pick is stored.
function asrOffers() {
  if (!asr.models.length && !omni.model) return;
  asrSetEngine(asrEngine(), false);
  const entry = document.getElementById('menu-asr-btn');
  if (entry) entry.hidden = false;
}

// asrEngine is the engine the guest picked, else the one kept in prefs, and never
// one the server does not offer. Vosk wins when both are on offer.
function asrEngine() {
  const kept = asr.engine || load('asr.engine');
  if (kept === 'omni' && omni.model) return 'omni';
  if (kept === 'vosk' && asr.models.length) return 'vosk';
  if (asr.models.length) return 'vosk';
  if (omni.model) return 'omni';
  return '';
}

// asrSetEngine keeps the choice and paints the picker and the menu entry.
function asrSetEngine(name, keep?) {
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

// asrChoices is everything the picker offers: each vosk language, then the
// multilingual model, each with the size of its download.
function asrChoices() {
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
function asrChoice() {
  if (asrEngine() === 'omni') return 'omni';
  const model = asrModel();
  return model ? `vosk:${model.lang}` : '';
}

// asrChoose takes one picker value: a vosk language or the multilingual model.
function asrChoose(value) {
  if (value === 'omni') {
    asrSetEngine('omni');
    return;
  }
  if (value.startsWith('vosk:')) {
    asrSetEngine('vosk');
    asrPick(value.slice('vosk:'.length));
  }
}

// asrPaintLangRow fills the picker from asrChoices and hides it, with its row,
// while there is no second thing to pick.
function asrPaintLangRow() {
  const select = $('asr-lang');
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

// asrPaintEntry puts the engine and its size on the menu entry.
function asrPaintEntry() {
  const btn = $('menu-asr-btn');
  if (!btn) return;
  if (asrEngine() === 'omni') {
    btn.title = `transcription, every language, ${omni.size ? mb(omni.size) : 'one model'}`;
    return;
  }
  const model = asrModel();
  if (model) btn.title = `transcription, language ${model.lang}, ${mb(model.size)}`;
}

// asrDefaultLang is the kept choice, else the browser language, else the first
// model the server lists.
function asrDefaultLang() {
  const have = asr.models.map((m) => m.lang);
  const kept = load('asr.lang');
  if (kept && have.includes(kept)) return kept;
  const want = String(navigator.language || '')
    .toLowerCase()
    .slice(0, 2);
  if (want && have.includes(want)) return want;
  return have[0];
}

// asrModel is the entry the guest picked, or the first one while a model is on
// offer.
function asrModel() {
  return asr.models.find((m) => m.lang === asr.lang) || asr.models[0] || null;
}

// asrPick keeps one language and paints the picker and the menu entry.
function asrPick(lang) {
  const model = asr.models.find((m) => m.lang === lang) || asr.models[0];
  if (!model) return;
  asr.lang = model.lang;
  store('asr.lang', model.lang);
  asrPaintLangRow();
  const btn = $('menu-asr-btn');
  if (btn) asrPaintEntry();
}

// asrCacheKey is a request that is only ever used as a key: file name and stamp,
// so a new model never matches the stored entry.
function asrCacheKey() {
  const model = asrModel();
  const file = model ? model.file : '';
  const stamp = model ? `${model.size}-${model.modified}` : '';
  return new Request(`${location.origin}/vosk/${file}?m=${encodeURIComponent(stamp)}`);
}

async function asrCached() {
  try {
    if (!window.caches) return null;
    const cache = await caches.open(ASR_CACHE);
    const hit = await cache.match(asrCacheKey());
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

// asrFetchModel downloads the model with a progress line, replaces the cache
// entry and returns the blob.
async function asrFetchModel(signal) {
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
      // The cache holds one model only.
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

function asrLoadLib() {
  if (asr.lib) return asr.lib;
  asr.lib = new Promise((resolve, reject) => {
    const have = (window as any).Vosk;
    if (have) return resolve(have);
    const el = document.createElement('script');
    el.src = scriptURL(ASR_LIB);
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
function asrSay(obj) {
  toSealed({ k: 'asr', ...obj });
}

// asrAnnounce tells a guest who joined later that this tab transcribes; the
// message is the same for either engine.
export function asrAnnounce(peer) {
  if ((!asr.on && !omni.on) || !peer.keys || peer.waiting) return;
  sealedSend(peer, { k: 'asr', s: 'on' });
}

// tapVoice wires one incoming voice, at the source before the gain, through a
// processor of its own; the callback takes each block the tap sees. Both engines
// use it and each keeps what it needs for the voice it hooked.
function tapVoice(peer, onBlock) {
  const ctx = state.playCtx;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (event) => onBlock(event.inputBuffer.getChannelData(0));
  // The processor only runs when it is wired to an output; the gain of zero
  // keeps it silent.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  peer.audioSrc.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  return { proc, src: peer.audioSrc, sink };
}

// untapVoice unhooks one voice and answers the handle it removed, so the engine
// can let go of what it kept for it.
function untapVoice(recs, id) {
  const h = recs.get(id);
  if (!h) return null;
  recs.delete(id);
  try {
    h.src.disconnect(h.proc);
  } catch {
    /* source already gone */
  }
  disconnectQuietly(h.proc);
  disconnectQuietly(h.sink);
  h.proc.onaudioprocess = null;
  return h;
}

// sayLine puts one decoded phrase on the chat and sends it, in the shape both
// engines use; each caller keeps its own liveness check.
function sayLine(who, text) {
  const line = text.slice(0, ASR_LINE_MAX);
  if (!line) return;
  addChatLine(`transcript by ${state.name || 'you'}`, `${who}: ${line}`, Date.now());
  asrSay({ w: who.slice(0, 64), x: line, ts: Date.now() });
}

// tapReady answers false when this voice is already hooked to the same source;
// a handle for another source goes first. Both engines hook this way.
function tapReady(recs, peer, untap) {
  const have = recs.get(peer.id);
  if (have && have.src === peer.audioSrc) return false;
  if (have) untap(peer.id);
  return true;
}

// asrTap hooks one incoming voice to a recognizer of its own, at the source
// before the gain, so a guest turned down is still transcribed.
function asrTap(peer) {
  const ctx = state.playCtx;
  if (!asr.on || !asr.model || !ctx || !peer.audioSrc) return;
  if (!tapReady(asr.recs, peer, asrUntap)) return;
  const rec = new asr.model.KaldiRecognizer(ctx.sampleRate);
  const speaker = () => peer.name || shortPeer(peer.id);
  rec.on('result', (message) => {
    const text = String((message.result && message.result.text) || '').trim();
    if (!text || !asr.on) return;
    sayLine(speaker(), text);
  });
  const tap = tapVoice(peer, (block) => {
    // A copy, because the engine takes the buffer to its worker.
    try {
      rec.acceptWaveformFloat(new Float32Array(block), ctx.sampleRate);
    } catch {
      /* recognizer gone */
    }
  });
  asr.recs.set(peer.id, { rec, proc: tap.proc, src: tap.src, sink: tap.sink });
}

function asrUntap(id) {
  const h = untapVoice(asr.recs, id);
  if (!h) return;
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

// syncTaps follows the room for one engine: a tap for each guest inside, none
// for a guest who waits or left.
function syncTaps(engine, tap, untap) {
  if (!engine.on) return;
  for (const id of [...engine.recs.keys()]) {
    const peer = state.peers.get(id);
    if (!peer || peer.waiting) untap(id);
  }
  for (const peer of state.peers.values()) {
    if (!peer.waiting) tap(peer);
  }
}

// asrSync follows the room: a recognizer for each guest inside, none for a guest
// who waits or left.
function asrSync() {
  syncTaps(asr, asrTap, asrUntap);
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
  asrStopped(was);
}

async function asrStart() {
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

// paintAsr ticks the menu row while the chosen engine runs or its model is on the
// way; the row stays live, so a running download can be cancelled there.
function paintAsr() {
  const box = $('asr-on');
  if (!box) return;
  const engine = asrEngine();
  const busy = engine === 'omni' ? omni.busy : asr.busy;
  box.checked = busy || (engine === 'omni' ? omni.on : asr.on);
  box.disabled = false;
}

export function initAsr() {
  const box = $('asr-on');
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
  const select = $('asr-lang');
  if (select) {
    select.addEventListener('change', () => {
      // One engine runs at a time and a pick may be a large download, so a change
      // stops what runs and restarts only the engine that was running.
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
  // The label is the guest as this tab knows it, never a name taken from the
  // message.
  state.chatRecv++;
  addChatLine(`transcript by ${name}`, `${who}: ${text}`, Date.now());
}

// ------------------------------------------------- multilingual transcription
// The multilingual engine runs in one worker of its own. The model is kept in the
// browser cache in 32 MB parts, checked against the hash the server lists, and
// mounted into the wasm filesystem. A stop terminates the worker, which drops the
// model, the threads and any download, and leaves the call untouched.
async function omniStart() {
  if (omni.busy || omni.on || !omni.model) return;
  if (!window.crossOriginIsolated) {
    asrNote(
      'The multilingual engine needs a cross-origin isolated page. The call is not affected.',
    );
    paintAsr();
    return;
  }
  const size = omni.size ? mb(omni.size) : 'a large file';
  // The cache is best effort: ask for a durable store and warn about tight space
  // before the download.
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

// omniSpawn starts the engine worker from a blob built here, so the client stays
// one file; the wasm threads reuse the same url, so the blob lives as long.
function omniSpawn() {
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
  const worker = new Worker(scriptURL(url));
  omni.url = url;
  worker.onmessage = (event) => omniOnWorker(event.data || {});
  worker.onerror = (event) => omniFail(event.message || 'the engine stopped');
  return worker;
}

// omniOnWorker is every word the engine says: status, progress, ready, decoded
// phrases and faults.
function omniOnWorker(msg) {
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

function omniProgress(msg) {
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

// omniFail stops the engine only; the note says so and the call keeps working.
function omniFail(text) {
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
  asrStopped(was);
}

// asrStopped tells the page that the engine is off and repaints its row; both
// engines end the same way.
function asrStopped(was) {
  if (was) asrSay({ s: 'off' });
  paintAsr();
  asrNote('');
  asrPaintOthers();
}

// omniTap hooks one incoming voice to the engine worker at the source, before the
// gain, like the vosk tap.
function omniTap(peer) {
  const ctx = state.playCtx;
  if (!omni.on || !omni.worker || !ctx || !peer.audioSrc) return;
  if (!tapReady(omni.recs, peer, omniUntap)) return;
  const id = peer.id;
  const worker = omni.worker;
  const tap = tapVoice(peer, (block) => {
    if (!omni.on || omni.worker !== worker) return;
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
  });
  omni.recs.set(id, { proc: tap.proc, src: tap.src, sink: tap.sink });
}

function omniUntap(id) {
  untapVoice(omni.recs, id);
}

// omniSync follows the room: a tap for each guest inside, none for a guest who
// waits or left.
function omniSync() {
  syncTaps(omni, omniTap, omniUntap);
}

// omniDown brings one block to mono 16 kHz with a box filter; the engine needs
// nothing finer.
function omniDown(input, rate) {
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

// omniLine puts one decoded phrase on the chat and sends it, in the shape the
// vosk engine uses.
function omniLine(id, text) {
  if (!omni.on) return;
  const peer = state.peers.get(id);
  sayLine(peer ? peer.name || shortPeer(id) : shortPeer(id), text);
}

// omniWorkerSource turns the function below into the worker script, with no extra
// file and no build step.
function omniWorkerSource(cfg) {
  return `(${omniWorker.toString()})(${JSON.stringify(cfg)});`;
}

// omniWorker is the engine in its own thread, so the call keeps its picture and
// sound while a model loads and a phrase decodes. No voice activity model is
// served, so the phrase gate is a level gate: four quiet frames end a phrase, the
// quiet tail is cut, and three frames before the first loud one keep the first
// word.
function omniWorker(cfg) {
  const G = self as any;

  // bootWasm mounts the emscripten module, then loads the API layer and the glue
  // that starts the wasm. A wasm thread runs this same script again; the glue owns
  // its port, so nothing else may run there and the answer is false.
  function bootWasm() {
    G.Module = {
      // The wasm and its threads live under /omni/. The base is absolute, as a blob
      // worker has no useful directory of its own.
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
    return !/^em-pthread/.test(G.name || '');
  }

  if (!bootWasm()) return;

  const RATE = 16000;
  const FRAME = 1600; // 100 ms, the step of the level gate
  const THRESHOLD = 0.012; // root mean square that counts as speech
  const TAIL = 4; // quiet frames that end a phrase
  const PRE = 3; // frames kept before the first loud one
  const MAXLEN = RATE * 30; // a longer phrase is cut and decoded
  const PART = 32 * 1048576; // one browser cache entry per 32 MB

  const post = (msg, transfer = []) => G.postMessage(msg, transfer);
  const progress = (got, cached) => post({ ev: 'progress', got, total: cfg.size, cached });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // join copies float frames into one buffer of the length the caller counted.
  const join = (parts, len) => {
    const all = new Float32Array(len);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    return all;
  };

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

  // hashOk checks the bytes against the hash the server lists and drops the cache
  // when they differ, so a stale model is never mounted.
  async function hashOk(bytes) {
    if (!cfg.sha) return true;
    const sum = await hash(bytes);
    if (!sum || sum === cfg.sha) return true;
    try {
      await G.caches.delete(cfg.cache);
    } catch {
      /* not ours */
    }
    return false;
  }

  // readParts fills bytes from the cache parts; a missing or short part is no hit.
  async function readParts(cache, first, bytes) {
    const count = Math.ceil(cfg.size / PART);
    try {
      for (let i = 0; i < count; i++) {
        const hit = i === 0 ? first : await cache.match(partKey(i));
        if (!hit) return false;
        const body = new Uint8Array(await hit.arrayBuffer());
        const at = i * PART;
        if (body.length !== Math.min(PART, cfg.size - at)) return false;
        bytes.set(body, at);
      }
    } catch {
      return false;
    }
    return true;
  }

  // fromCache reads the model out of the browser cache in parts. A missing or
  // short part is no hit; a stale hash drops the cache before the wasm reads it.
  async function fromCache() {
    if (!G.caches || !cfg.size) return null;
    let cache;
    let first;
    try {
      cache = await G.caches.open(cfg.cache);
      first = await cache.match(partKey(0));
    } catch {
      return null;
    }
    if (!first) return null;
    progress(0, true);
    const bytes = new Uint8Array(cfg.size);
    if (!(await readParts(cache, first, bytes))) return null;
    if (!(await hashOk(bytes))) return null;
    progress(cfg.size, true);
    return bytes;
  }

  // putPart writes one finished part to the cache; a cache that refuses is dropped
  // for the rest of the download.
  async function putPart(cache, index, body) {
    try {
      await cache.put(partKey(index), new Response(body));
      return cache;
    } catch {
      return null;
    }
  }

  // fromNetwork downloads the model and writes every finished part to the cache.
  // The cache is best effort: without it the tab still transcribes now.
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
        progress(got, false);
      }
      // Finished parts go at once, so a stopped tab keeps what it paid for.
      while (cache && got - part * PART >= PART) {
        const at = part * PART;
        cache = await putPart(cache, part, bytes.subarray(at, at + PART));
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
      await putPart(cache, part, bytes.subarray(at, cfg.size));
    }
    progress(cfg.size, false);
    if (!(await hashOk(bytes))) throw new Error('the model did not match its hash');
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

  // loadModel answers the model bytes, from the cache when it holds them, else
  // from the network.
  async function loadModel() {
    const bytes = await fromCache();
    if (bytes) return bytes;
    post({ ev: 'status', text: 'downloading the model' });
    return fromNetwork();
  }

  async function loadTokens() {
    const res = await fetch(cfg.tokensUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`the token table answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // startRecognizer builds the recognizer over the mounted files.
  function startRecognizer() {
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
  }

  async function start() {
    const t0 = performance.now();
    post({ ev: 'status', text: 'starting the engine' });
    await waitRuntime();
    post({ ev: 'status', text: 'loading the model' });
    const bytes = await loadModel();
    const tokens = await loadTokens();
    mount(cfg.modelName, bytes);
    mount(cfg.tokensName, tokens);
    post({ ev: 'status', text: 'starting the recognizer' });
    startRecognizer();
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

  // flush hands one finished phrase to the queue; a phrase under half a second
  // carries no word.
  function flush(id, st) {
    const parts = st.samples;
    const len = st.len;
    st.samples = [];
    st.len = 0;
    st.speech = false;
    st.quiet = 0;
    if (len < RATE / 2) return;
    const all = join(parts, len);
    // The queue is short on purpose: a slow tab drops the oldest phrase.
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
    if (loud) st.quiet = 0;
    else st.quiet++;
    if (st.quiet < TAIL && st.len < MAXLEN) return;
    // The quiet tail goes, it carries no word.
    while (st.quiet > 0 && st.samples.length > 1) {
      st.len -= st.samples.pop().length;
      st.quiet--;
    }
    flush(id, st);
  }

  function pushAudio(id, samples) {
    let st = segs.get(id);
    if (!st) {
      st = begin();
      segs.set(id, st);
    }
    const all = join([st.rest, samples], st.rest.length + samples.length);
    let at = 0;
    for (; all.length - at >= FRAME; at += FRAME) frame(id, st, all.subarray(at, at + FRAME));
    st.rest = all.subarray(at);
  }

  function pump() {
    if (decoding || !rec || queue.length === 0) return;
    const job = queue.shift();
    decoding = true;
    const t0 = performance.now();
    let text;
    try {
      const stream = rec.createStream();
      stream.acceptWaveform(RATE, job.samples);
      rec.decode(stream);
      text = String((rec.getResult(stream) || {}).text || '').trim();
      stream.free();
    } catch (err) {
      post({ ev: 'error', text: short(err) });
      return;
    } finally {
      decoding = false;
    }
    // Every phrase goes to the page, empty or not, so a deaf engine differs from
    // a silent room.
    const ms = Math.round(performance.now() - t0),
      sec = job.samples.length / RATE;
    post({ ev: 'decoded', ms, sec, len: text.length });
    if (text) post({ ev: 'line', id: job.id, text, ms, sec });
    // One phrase per turn of the event loop, so queued audio is read first.
    setTimeout(pump, 0);
  }

  // listen takes the audio the page taps and hands each voice to its gate.
  function listen() {
    G.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.cmd === 'audio' && rec && msg.samples) pushAudio(String(msg.id || ''), msg.samples);
    };
  }

  listen();
  start().catch((err) => post({ ev: 'error', text: short(err) }));
}
