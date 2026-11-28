/* Sealed file transfer end to end test.
 *
 * Three browser contexts join one sealed room. The test drops files into the
 * chat, has a guest accept and save them, and compares the saved bytes with the
 * bytes that went in by SHA-256. It covers a few KB, a file over the chunk path,
 * a zero byte file, a refusal, a cancel from each side, and a guest who leaves
 * before accepting. It also asserts that no file name and no chunk went over
 * the signaling socket: a WebSocket hook sums every frame and the data channel
 * counters must carry the bytes.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require(process.env.PW);
const { expectedMiss } = require('./expected-404');

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8096';
const OUT = process.env.OUTDIR || 'shots';

const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
  return !!ok;
}
function info(name, detail) {
  console.log('INFO  ' + name + (detail ? '  [' + detail + ']' : ''));
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
    await sleep(150);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !expectedMiss(m)) errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  // The hook keeps every signaling frame in the page, so the test can prove
  // that no file name and no chunk of a file went over it.
  await page.addInitScript(() => {
    if (window.__wsSent) return;
    // The save picker is a native dialog this suite cannot answer, so the
    // file path here is the in-memory one and its save link. The disk path
    // has its own probe with a stubbed handle.
    window.e2eNoPicker = true;
    window.__wsSent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (raw) {
      try {
        if (typeof raw === 'string') window.__wsSent.push(raw);
      } catch (_err) { /* a frame of another kind */ }
      return send.apply(this, arguments);
    };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(BASE + '/' + (room ? '#r=' + room : ''), { waitUntil: 'load', timeout: 60000 });
    await until(page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'wasm self test');
    const app = await page.evaluate(() => ({
      test: window.e2eApp && window.e2eApp.state.wasmTest,
      room: document.getElementById('room').value,
    }));
    await page.fill('#name', name);
    if (room) await page.fill('#room', room);
    await page.click('#enter-btn', { timeout: 20000 });
    try {
      await until(page, () => window.e2eApp && window.e2eApp.state.self && !document.getElementById('stage').hidden,
        null, 20000, name + ' joined');
      return { page, errors, app };
    } catch (err) {
      info(name + ' join attempt ' + (attempt + 1) + ' failed', String(err));
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join after retries');
}

// wireReady waits for both peers of a page, a live link and an open file
// channel on every pair.
function wireReady(page, count) {
  return until(page, (n) => {
    const s = window.e2eApp.state;
    const peers = [...s.peers.values()];
    return peers.length === n && peers.every((p) => p.confirmed && p.pc && p.pc.connectionState === 'connected'
      && p.dc && p.dc.readyState === 'open');
  }, count, 45000, 'sealed pairs and file channels');
}

async function rowText(page, name) {
  return page.evaluate((n) => {
    const rows = [...document.querySelectorAll('#chat-log li.chat-file')];
    const row = rows.reverse().find((li) => li.textContent.includes(n));
    return row ? row.textContent : '';
  }, name);
}

async function clickRow(page, name, label) {
  return page.evaluate((arg) => {
    const rows = [...document.querySelectorAll('#chat-log li.chat-file')];
    const row = rows.reverse().find((li) => li.textContent.includes(arg.name));
    if (!row) return 'no row';
    const button = [...row.querySelectorAll('button')].find((b) => b.textContent === arg.label);
    if (!button) return 'no button';
    button.click();
    return 'clicked';
  }, { name, label });
}

// waitSave waits until the row of one file carries the save link. The page
// function is self contained, because it runs inside the page.
function waitSave(page, name, timeout, label) {
  return until(page, (n) => {
    const rows = [...document.querySelectorAll('#chat-log li.chat-file')];
    const row = rows.reverse().find((li) => li.textContent.includes(n));
    return !!(row && row.querySelector('a.file-save'));
  }, name, timeout, label);
}

// saveAndHash clicks the save link of one row and hashes the file the browser
// hands over. The click is the one a guest makes; nothing is saved before it.
async function saveAndHash(page, name) {
  const clicked = await page.evaluate((n) => {
    const rows = [...document.querySelectorAll('#chat-log li.chat-file')];
    const row = rows.reverse().find((li) => li.textContent.includes(n));
    const link = row && row.querySelector('a.file-save');
    if (!link) return false;
    link.click();
    return true;
  }, name);
  if (!clicked) throw new Error('no save link for ' + name);
  const download = await page.waitForEvent('download', { timeout: 20000 });
  const path = await download.path();
  const buf = fs.readFileSync(path);
  const out = {
    hex: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    filename: download.suggestedFilename(),
  };
  await download.delete();
  return out;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

async function wireStats(page, names) {
  return page.evaluate((list) => {
    const frames = window.__wsSent || [];
    let bytes = 0;
    let max = 0;
    const leaks = new Set();
    for (const frame of frames) {
      bytes += frame.length;
      if (frame.length > max) max = frame.length;
      for (const name of list) if (frame.includes(name)) leaks.add(name);
    }
    const peers = [...window.e2eApp.state.peers.values()];
    return {
      frames: frames.length,
      bytes,
      max,
      leaks: [...leaks],
      canaries: window.e2eApp.counters().wireLeaks,
      dcPeers: peers.length,
    };
  }, names);
}

// channelBytes sums the data channel counters of one page. It is the proof that
// the file used the channel and not the signaling socket.
function channelBytes(page) {
  return page.evaluate(async () => {
    const out = { sent: 0, recv: 0, messages: 0 };
    for (const peer of window.e2eApp.state.peers.values()) {
      if (!peer.pc) continue;
      const stats = await peer.pc.getStats();
      stats.forEach((r) => {
        if (r.type !== 'data-channel') return;
        out.sent += r.bytesSent || 0;
        out.recv += r.bytesReceived || 0;
        out.messages += (r.messagesSent || 0) + (r.messagesReceived || 0);
      });
    }
    return out;
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=RTCRtpScriptTransform',
    ],
  });

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'], acceptDownloads: true });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'], acceptDownloads: true });
  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['camera', 'microphone'], acceptDownloads: true });

  const run = Date.now().toString(36);
  const smallName = 'probe-small-' + run + '.bin';
  const bigName = 'probe-big-' + run + '.bin';
  const emptyName = 'probe-empty-' + run + '.bin';
  const refuseName = 'probe-refuse-' + run + '.bin';
  const cancelName = 'probe-cancel-' + run + '.bin';
  const leaveName = 'probe-leave-' + run + '.bin';

  const smallBuf = crypto.randomBytes(5000);
  const bigBuf = crypto.randomBytes(400 * 1024);
  const emptyBuf = Buffer.alloc(0);
  const refuseBuf = crypto.randomBytes(1200);
  const cancelBuf = crypto.randomBytes(2 * 1024 * 1024);
  const leaveBuf = crypto.randomBytes(9000);

  let a = null;
  let b = null;
  let c = null;
  try {
    a = await joinPage(ctxA, 'alice', '');
    const room = await a.page.evaluate(() => document.getElementById('room').value);
    b = await joinPage(ctxB, 'bob', room);
    c = await joinPage(ctxC, 'carol', room);
    check('three guests joined one sealed room', /^[a-z2-7]{26}$/.test(room), room);

    await wireReady(a.page, 2);
    await wireReady(b.page, 2);
    await wireReady(c.page, 2);
    check('every pair has an open file channel', true, 'three pairs');

    // ---- a small file, accepted and saved by one guest
    await a.page.setInputFiles('#file-input', { name: smallName, mimeType: 'application/octet-stream', buffer: smallBuf });
    await until(b.page, (n) => [...document.querySelectorAll('#chat-log li.chat-file')].some((li) => li.textContent.includes(n)),
      smallName, 20000, 'bob sees the offer');
    const smallRowB = await rowText(b.page, smallName);
    const smallRowC = await rowText(c.page, smallName);
    check('the offer is inline in the chat with the name', smallRowB.includes(smallName), smallRowB);
    check('the offer carries the size', smallRowB.includes(fileBytes(smallBuf.length)), smallRowB);
    check('every participant gets the offer', smallRowC.includes(smallBuf.length ? fileBytes(smallBuf.length) : '0 B'), smallRowC);
    check('an offer has accept and refuse', await b.page.evaluate((n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      const labels = row ? [...row.querySelectorAll('button')].map((x) => x.textContent) : [];
      return labels.includes('accept') && labels.includes('refuse');
    }, smallName), 'accept, refuse');

    await clickRow(b.page, smallName, 'accept');
    await waitSave(b.page, smallName, 30000, 'bob save link');
    const smallGot = await saveAndHash(b.page, smallName);
    check('the small file bytes match by SHA-256', smallGot.hex === sha(smallBuf), smallGot.hex);
    check('the saved file keeps the offered name', smallGot.filename === smallName, smallGot.filename);
    await until(a.page, (n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!(row && /accepted 1 of 2/.test(row.textContent) && /bob done/.test(row.textContent));
    }, smallName, 20000, 'alice sees bob done');
    check('the sender sees who accepted', true, 'accepted 1 of 2 | bob done');

    // ---- a file over the chunk path
    const beforeBig = await b.page.evaluate(() => window.e2eApp.counters().fileChunksRecv);
    await a.page.setInputFiles('#file-input', { name: bigName, mimeType: 'application/octet-stream', buffer: bigBuf });
    await until(b.page, (n) => [...document.querySelectorAll('#chat-log li.chat-file')].some((li) => li.textContent.includes(n)),
      bigName, 20000, 'bob sees the big offer');
    await clickRow(b.page, bigName, 'accept');
    await waitSave(b.page, bigName, 60000, 'bob save link for the big file');
    const bigGot = await saveAndHash(b.page, bigName);
    check('the chunked file bytes match by SHA-256', bigGot.hex === sha(bigBuf), bigGot.hex);
    check('the chunked file size matches', bigGot.size === bigBuf.length, bigGot.size + ' of ' + bigBuf.length);
    const chunksExpected = Math.ceil(bigBuf.length / (16 * 1024));
    const countersAfterBig = await b.page.evaluate(() => window.e2eApp.counters());
    const bigChunks = countersAfterBig.fileChunksRecv - beforeBig;
    check('the big file used the chunk path', bigChunks === chunksExpected,
      bigChunks + ' chunks, expected ' + chunksExpected);

    // ---- a zero byte file
    await a.page.setInputFiles('#file-input', { name: emptyName, mimeType: 'application/octet-stream', buffer: emptyBuf });
    await until(b.page, (n) => [...document.querySelectorAll('#chat-log li.chat-file')].some((li) => li.textContent.includes(n)),
      emptyName, 20000, 'bob sees the empty offer');
    const emptyRow = await rowText(b.page, emptyName);
    check('an empty file shows 0 B', emptyRow.includes('0 B'), emptyRow);
    await clickRow(b.page, emptyName, 'accept');
    await waitSave(b.page, emptyName, 20000, 'bob save link for the empty file');
    const emptyGot = await saveAndHash(b.page, emptyName);
    check('the empty file ends cleanly at 0 bytes', emptyGot.size === 0 && emptyGot.hex === sha(emptyBuf), emptyGot.hex);

    // ---- a refusal
    await a.page.setInputFiles('#file-input', { name: refuseName, mimeType: 'application/octet-stream', buffer: refuseBuf });
    await until(b.page, (n) => [...document.querySelectorAll('#chat-log li.chat-file')].some((li) => li.textContent.includes(n)),
      refuseName, 20000, 'bob sees the refused offer');
    await clickRow(b.page, refuseName, 'refuse');
    await until(a.page, (n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!(row && /refused bob/.test(row.textContent));
    }, refuseName, 20000, 'alice sees the refusal');
    check('a refusal reaches the sender', true, await rowText(a.page, refuseName));
    check('a refused offer leaves no save link and no button', await b.page.evaluate((n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!row && !row.querySelector('a.file-save') && !row.querySelector('button');
    }, refuseName), 'clean');

    // ---- the sender cancels an offer that nobody took
    await a.page.setInputFiles('#file-input', { name: cancelName, mimeType: 'application/octet-stream', buffer: cancelBuf });
    await until(b.page, (n) => [...document.querySelectorAll('#chat-log li.chat-file')].some((li) => li.textContent.includes(n)),
      cancelName, 20000, 'bob sees the cancelled offer');
    check('the sender can cancel an offer', (await clickRow(a.page, cancelName, 'cancel')) === 'clicked', 'cancel');
    await until(b.page, (n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!(row && /cancelled/.test(row.textContent) && !row.querySelector('button') && !row.querySelector('a.file-save'));
    }, cancelName, 20000, 'bob sees the cancel');
    check('a cancel clears the offer on both sides', true, 'cancelled');

    // ---- the receiver cancels while the bytes run
    const cancelBefore = await a.page.evaluate(() => window.e2eApp.counters().fileCancelled);
    const cancelName2 = 'probe-cancel2-' + run + '.bin';
    await a.page.setInputFiles('#file-input', { name: cancelName2, mimeType: 'application/octet-stream', buffer: cancelBuf });
    await until(b.page, (n) => [...document.querySelectorAll('#chat-log li.chat-file')].some((li) => li.textContent.includes(n)),
      cancelName2, 20000, 'bob sees the running offer');
    // Accept and then cancel as soon as the row carries the cancel button. The
    // accept handler opens the save target first, so the button comes one turn
    // later and a click in the same call would find no button.
    await b.page.evaluate((n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      [...row.querySelectorAll('button')].find((x) => x.textContent === 'accept').click();
    }, cancelName2);
    await until(b.page, (n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!(row && [...row.querySelectorAll('button')].some((x) => x.textContent === 'cancel'));
    }, cancelName2, 5000, 'bob has the cancel button');
    await clickRow(b.page, cancelName2, 'cancel');
    await until(b.page, (n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!(row && /cancelled/.test(row.textContent) && !row.querySelector('a.file-save'));
    }, cancelName2, 20000, 'bob sees his own cancel');
    await until(a.page, (n) => window.e2eApp.counters().fileCancelled > n, cancelBefore, 20000, 'alice counts the cancel');
    const cancelCounters = await a.page.evaluate(() => window.e2eApp.counters());
    check('a receiver cancel stops the sender', cancelCounters.fileCancelled > cancelBefore, String(cancelCounters.fileCancelled));
    check('a cancelled transfer leaves no save link', await b.page.evaluate((n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!row && !row.querySelector('a.file-save');
    }, cancelName2), 'no link');

    // ---- a guest leaves before accepting, another still takes the file
    await a.page.setInputFiles('#file-input', { name: leaveName, mimeType: 'application/octet-stream', buffer: leaveBuf });
    await until(c.page, (n) => [...document.querySelectorAll('#chat-log li.chat-file')].some((li) => li.textContent.includes(n)),
      leaveName, 20000, 'carol sees the offer');
    await ctxC.close();
    c = null;
    await until(a.page, (n) => {
      const row = [...document.querySelectorAll('#chat-log li.chat-file')].find((li) => li.textContent.includes(n));
      return !!(row && /left carol/.test(row.textContent));
    }, leaveName, 20000, 'alice notes that carol left');
    check('a peer who leaves ends its offer cleanly', true, 'left carol');
    await clickRow(b.page, leaveName, 'accept');
    await waitSave(b.page, leaveName, 30000, 'bob save link after carol left');
    const leaveGot = await saveAndHash(b.page, leaveName);
    check('the remaining guest still gets the file', leaveGot.hex === sha(leaveBuf), leaveGot.hex);

    // ---- the server never saw a name, a size or a chunk
    const names = [smallName, bigName, emptyName, refuseName, cancelName, cancelName2, leaveName];
    const wireA = await wireStats(a.page, names);
    const wireB = await wireStats(b.page, names);
    const chA = await channelBytes(a.page);
    const chB = await channelBytes(b.page);
    info('signaling bytes', 'A ' + wireA.bytes + ' in ' + wireA.frames + ' frames, B ' + wireB.bytes);
    info('data channel bytes', 'A sent ' + chA.sent + ', B recv ' + chB.recv);
    check('no file name appears in any signaling frame', wireA.leaks.length === 0 && wireB.leaks.length === 0,
      JSON.stringify(wireA.leaks.concat(wireB.leaks)));
    check('the signaling socket carries less than 128 KiB', wireA.bytes < 128 * 1024 && wireB.bytes < 128 * 1024,
      wireA.bytes + ' and ' + wireB.bytes);
    check('the data channel carries the file bytes', chA.sent >= bigBuf.length && chB.recv >= bigBuf.length,
      chA.sent + ' sent, ' + chB.recv + ' received');
    check('the in-page wire audit finds no leak', wireA.canaries.length === 0 && wireB.canaries.length === 0,
      JSON.stringify(wireA.canaries.concat(wireB.canaries)));
    const countersA = await a.page.evaluate(() => window.e2eApp.counters());
    const countersB = await b.page.evaluate(() => window.e2eApp.counters());
    check('both sides count sealed chunks', countersA.fileChunksSent > 0 && countersB.fileChunksRecv > 0,
      countersA.fileChunksSent + ' out, ' + countersB.fileChunksRecv + ' in');

    check('no console error or page error on A', a.errors.length === 0, a.errors.join(' | '));
    check('no console error or page error on B', b.errors.length === 0, b.errors.join(' | '));
    await a.page.screenshot({ path: OUT + '/file-a.png' });
    await b.page.screenshot({ path: OUT + '/file-b.png' });
  } finally {
    if (a && a.page) await a.page.close().catch(() => {});
    if (b && b.page) await b.page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.length + ' of ' + results.length : 'PASS ' + results.length + ' checks'));
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.log('FAIL  the suite stopped: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
