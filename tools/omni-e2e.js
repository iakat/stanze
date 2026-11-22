/* Multilingual transcription end-to-end: one guest speaks a known clip into
 * the fake microphone, the other turns the omnilingual engine on, and the chat
 * has to carry the words the clip says.
 *
 * It asserts that the page is cross-origin isolated (the engine is a pthread
 * wasm build and cannot start without it), that /omni/models lists the whole
 * bundle with sha256, that the engine reaches the chat with a transcript of
 * clip00 and clip04, how long a segment takes (a real time factor when the page
 * reports one) and how much memory it holds. With VOSK_DIR it runs the vosk
 * engine on the same clip as a regression.
 *
 * The fake microphone plays one wav in a loop, with a gap between the rounds,
 * so a partial round gives a partial line and the next round gives the whole
 * one: the check keeps the best of the rounds it hears.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR, CLIPS (a directory
 * with clip00.wav, clip04.wav and truth.json; without it only the isolation and
 * the listing are checked), VOSK_DIR (the -vosk-dir the server was started with;
 * empty skips the vosk regression), CHROME (a browser to drive, default the one
 * playwright has)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
const OUT = process.env.OUTDIR || '/tmp/shots';
const CLIPS = process.env.CLIPS || '';
const VOSK_DIR = process.env.VOSK_DIR || '';

const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
  return !!ok;
}
function skip(name, why) {
  results.push({ name, ok: true, detail: 'skip: ' + why });
  console.log('SKIP  ' + name + '  [' + why + ']');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, fn, arg, timeout, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < (timeout || 45000)) {
    try {
      last = await page.evaluate(fn, arg);
    } catch (e) {
      last = 'evaluate failed: ' + e;
    }
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
}

// The sentences the clips say, from the same truth.json the other speech tests
// use: file, truth and seconds.
function truths() {
  if (!CLIPS) return [];
  const file = path.join(CLIPS, 'truth.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => (norm(s) ? norm(s).split(' ') : []);

// Word error rate: the usual edit distance over words, divided by the length of
// what was said. An empty answer is 1, never 0.
function wer(ref, hyp) {
  const a = words(ref);
  const b = words(hyp);
  if (!a.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] / a.length;
}

// transcriptLines reads the sealed transcript lines the page holds, without the
// time and without the label, so only the words that were recognised are left.
function transcriptLines(page) {
  return page.evaluate(() => [...document.querySelectorAll('#chat-log li')].map((li) => {
    const who = li.querySelector('.who');
    const when = li.querySelector('.when');
    if (!who || !/^transcript by /.test(who.textContent)) return null;
    const cut = (when ? when.textContent.length : 0) + who.textContent.length;
    return { label: who.textContent, text: li.textContent.slice(cut).replace(/^\s+/, '') };
  }).filter(Boolean));
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(BASE + '/' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
    await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
    await page.fill('#name', name);
    if (room) await page.fill('#room', room);
    await page.click('#enter-btn', { timeout: 20000 });
    try {
      await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
        null, 25000, name + ' joined');
      return { page, errors, room: await page.evaluate(() => window.e2eApp.state.room) };
    } catch (err) {
      console.log('RETRY ' + name + ' attempt ' + (attempt + 1) + ': ' + err);
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join');
}

// asrOn opens the transcribe menu, picks from the one picker and ticks the
// switch, the way a guest does. The picker lists every language with its size
// and, when the server lists it, the multilingual model; a menu with a single
// entry hides the picker, so the listing decides which engine is in force.
async function asrOn(page, engine, listed) {
  const offered = await page.evaluate(() => {
    const btn = document.getElementById('menu-asr-btn');
    return !!(btn && !btn.hidden);
  });
  if (!offered) throw new Error('the page does not offer transcription');
  await page.evaluate(() => document.getElementById('menu-asr-btn').click());
  const picked = await page.evaluate((want) => {
    const sel = document.getElementById('asr-lang');
    if (!sel || sel.hidden) return 'single';
    const o = [...sel.options].find((x) => (want === 'omni' ? x.value === 'omni' : x.value.startsWith('vosk:')));
    if (!o) return false;
    sel.value = o.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return o.value;
  }, engine);
  if (picked === false) throw new Error('the menu does not offer the ' + engine + ' engine');
  // With one entry the choice is made by what the server lists.
  if (picked === 'single' && (engine === 'omni' ? !listed.omni : !listed.vosk)) {
    throw new Error('the page offers no ' + engine + ' engine');
  }
  await page.evaluate(() => document.getElementById('asr-on').click());
}

// hear waits for a round of the loop that comes out as one whole sentence. A
// round is the group of lines that appear together: after a new line it waits a
// couple of seconds for the rest of that round, scores the joined text against
// the truth and keeps the best round until the timeout. A round that is cut in
// half by the loop scores badly, the next one scores well.
async function hear(page, truth, timeout) {
  const start = Date.now();
  let taken = (await transcriptLines(page)).length;
  let best = { text: '', wer: 1 };
  while (Date.now() - start < timeout) {
    await sleep(1000);
    const lines = await transcriptLines(page);
    if (lines.length <= taken) continue;
    await sleep(2500);
    const round = (await transcriptLines(page)).slice(taken);
    taken += round.length;
    const text = round.map((l) => l.text.replace(/^[^:]*:\s*/, '')).join(' ');
    const score = wer(truth, text);
    if (score < best.wer) best = { text, wer: score };
    if (score <= 0.05) return best;
  }
  return best;
}

async function launch(chrome, audio) {
  return chromium.launch({
    ...(chrome ? { executablePath: chrome } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=RTCRtpScriptTransform',
      '--use-file-for-fake-audio-capture=' + audio,
    ],
  });
}

// stats reads what the page reports about the engine: the start, the last
// segment (milliseconds, seconds of audio, real time factor) and the heap. A
// page that does not report them gives nulls, and the check says so.
function stats(page) {
  return page.evaluate(() => {
    const s = (window.e2eApp && window.e2eApp.asrStats) || null;
    const mem = performance.memory || null;
    return {
      engine: s ? s.engine || '' : '',
      ready: !!(s && s.ready),
      initMs: s && typeof s.initMs === 'number' ? s.initMs : null,
      segs: s && Array.isArray(s.segments) ? s.segments.slice(-4) : [],
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      heapLimitMB: mem ? +(mem.jsHeapSizeLimit / 1048576).toFixed(0) : null,
    };
  });
}

// runOneClip joins two guests, turns the engine on for the second and scores the
// transcript of the first. The speaker's microphone is the fake file, which the
// flag on the browser sets for every context.
async function runOneClip(browser, truth, engine) {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'] });
  let a = null;
  let b = null;
  try {
    a = await joinPage(ctxA, 'speaker', '');
    b = await joinPage(ctxB, 'listener', a.room);
    // The engine asks before a one-time download; a guest would press it, and so
    // does the test.
    b.page.on('dialog', (d) => d.accept().catch(() => {}));
    await until(b.page, () => {
      const v = [...document.querySelectorAll('.tile')].filter((t) => t.dataset.local !== 'yes').map((t) => t.querySelector('video'));
      return v.length > 0;
    }, null, 45000, 'the listener sees the speaker');

    const isolated = await b.page.evaluate(() => crossOriginIsolated);
    check('the page is cross-origin isolated, ' + engine, isolated === true, isolated);

    const listed = await b.page.evaluate(async () => {
      const res = await fetch('/omni/models', { cache: 'no-store' });
      if (!res.ok) return { status: res.status };
      const body = await res.json();
      return { status: res.status, files: body.files || [] };
    });
    const files = listed.files || [];
    const offers = { omni: files.length > 0, vosk: false };
    if (engine === 'omni') {
      const model = files.find((f) => f.name === 'model.int8.onnx') || {};
      check('the server lists the whole bundle with hashes', files.length === 5 && files.every((f) => f.sha256 && f.size > 0),
        files.map((f) => f.name + ':' + f.size).join(' '));
      check('the listed model is the 348 MB one', model.size === 365352120
        && model.sha256 === 'e7c4e54ee4c4c47829cc6667d5d00ed8ea7bef1dcfeef0fce766f77752a2726c', model.size + ' ' + model.sha256);
    } else {
      const vosk = await b.page.evaluate(async () => {
        const res = await fetch('/vosk/models', { cache: 'no-store' });
        if (!res.ok) return [];
        const body = await res.json();
        return (body && body.langs) || [];
      });
      offers.vosk = vosk.length > 0;
    }

    const before = await stats(b.page);
    check('no engine runs before the guest asks', before.ready === false, JSON.stringify(before));

    const labels = await b.page.evaluate(() => {
      const sel = document.getElementById('asr-lang');
      return sel ? [...sel.options].map((o) => o.textContent) : [];
    });
    check('every entry of the one picker carries its size',
      labels.length > 0 && labels.every((t) => /\(\d+(\.\d+)? MB\)/.test(t)), labels.join(' | '));

    const started = Date.now();
    await asrOn(b.page, engine, offers);
    // The first run downloads 348 MB and says so; a second run reads OPFS.
    const notes = [];
    const t = setInterval(async () => {
      try {
        const n = await b.page.evaluate(() => {
          const el = document.getElementById('asr-note');
          return el && !el.hidden ? el.textContent : '';
        });
        if (n && notes[notes.length - 1] !== n) notes.push(n);
      } catch { /* page busy */ }
    }, 500);
    try {
      await until(b.page, () => {
        const s = window.e2eApp && window.e2eApp.asrStats;
        if (s && s.ready) return true;
        return [...document.querySelectorAll('#chat-log li .who')].some((w) => /^transcript by /.test(w.textContent));
      }, null, 300000, 'the engine to start');
    } finally {
      clearInterval(t);
    }
    const startMs = Date.now() - started;
    check('the download shows its size and its progress', engine !== 'omni'
      || notes.some((n) => /\d+(\.\d+)? MB/.test(n) && /%/.test(n))
      || /opfs|cache|ready/i.test(notes.join(' ')), notes.slice(0, 4).join(' | '));

    const got = await hear(b.page, truth.truth, engine === 'omni' ? 120000 : 150000);
    check('the transcript of ' + truth.file.replace(/^.*\//, '') + ' is right, ' + engine,
      got.wer <= (engine === 'omni' ? 0.15 : 0.35), `wer ${got.wer.toFixed(3)}: ${got.text}`);

    const after = await stats(b.page);
    if (after.ready) {
      check('the engine reached the chat and reports its start, ' + engine,
        after.initMs !== null && after.segs.length > 0, JSON.stringify(after));
      const last = after.segs[after.segs.length - 1] || {};
      if (typeof last.ms === 'number' && last.audioSec) {
        const rtf = last.ms / 1000 / last.audioSec;
        console.log('RTF ' + engine + ' ' + rtf.toFixed(3) + ' (' + last.ms + ' ms for ' + last.audioSec.toFixed(2) + ' s)');
        check('a segment decodes faster than it plays, ' + engine, rtf < 1, rtf.toFixed(3));
      }
    } else {
      skip('the page reports its own timings, ' + engine, 'no asrStats on the page');
    }
    console.log('MEM ' + engine + ' heap ' + after.heapMB + ' MB of ' + after.heapLimitMB + ' MB, start ' + startMs + ' ms');
    check('the engine holds the model without a second copy, ' + engine,
      after.heapMB === null || after.heapMB < 1400, after.heapMB + ' MB');

    await b.page.screenshot({ path: OUT + '/omni-' + engine + '-' + path.basename(truth.file, '.wav') + '.png' });
    check('the listener logged no page errors, ' + engine, b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  } catch (err) {
    check('the ' + engine + ' run of ' + path.basename(truth.file) + ' ran to the end', false, String(err && err.stack || err));
    if (b) await b.page.screenshot({ path: OUT + '/omni-fail-' + engine + '.png' }).catch(() => {});
  } finally {
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = process.env.CHROME || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : '');
  const all = truths();
  const want = all.filter((t) => /clip00|clip04/.test(t.file));
  if (!want.length) {
    skip('the clips', 'no CLIPS directory with truth.json');
    const browser = await launch(chrome, '');
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
    check('the page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated) === true);
    await browser.close().catch(() => {});
  } else {
    for (const truth of want) {
      const browser = await launch(chrome, truth.file);
      try {
        await runOneClip(browser, truth, 'omni');
      } finally {
        await browser.close().catch(() => {});
      }
    }
    if (!VOSK_DIR) skip('the vosk engine still transcribes', 'VOSK_DIR is not set');
    else {
      const browser = await launch(chrome, want[0].file);
      try {
        await runOneClip(browser, want[0], 'vosk');
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + (results.length - failed.length) + '/' + results.length + ' pass');
  fs.writeFileSync(OUT + '/omni-e2e.json', JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
