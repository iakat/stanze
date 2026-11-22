/* Headless Chromium check for a sealed room with three guests.
 *
 * A mesh has one code per pair, so three guests mean three codes, and each code
 * stays on its own tile. The chip at the far end of the status line counts the
 * guests this browser pinned and turns green only when all of them are pinned.
 * A failed key confirmation is the only alarm, and it stays on that pair.
 *
 * env: PW (playwright-core directory), ROOMSBASE, OUTDIR
 */
'use strict';

const fs = require('fs');
const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8095';
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
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + (label || 'condition') + ' (last=' + JSON.stringify(last) + ')');
}

function attach(page, errors) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
}

async function joinPage(context, name, room) {
  const page = await context.newPage();
  const errors = [];
  attach(page, errors);
  // The camera is not the subject here, so the stored choice keeps it off and
  // three pages stay light enough for one job.
  await page.addInitScript(() => {
    try { localStorage.setItem('rooms.cam', '0'); } catch (e) { /* private mode */ }
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
      // The camera is not the subject here, so the stored choice keeps it off
      // and three pages stay light enough for one job.
      return { page, errors, app };    } catch (err) {
      console.log('RETRY ' + name + ' attempt ' + (attempt + 1) + ': ' + err);
      await sleep(500);
    }
  }
  throw new Error(name + ' could not join after retries');
}

function meshState(page) {
  return page.evaluate(() => {
    const s = window.e2eApp.state;
    const peers = [...s.peers.values()].map((p) => ({
      id: p.id, name: p.name, ready: p.ready, confirmed: p.confirmed, sas: p.sas,
      tileSas: p.tile ? p.tile.dataset.sas || '' : '',
      fp: p.fp || '', proven: !!p.proven,
    }));
    const chip = document.getElementById('pin-count');
    const stats = document.getElementById('stats-body') ? document.getElementById('stats-body').textContent : '';
    return {
      self: s.self, room: s.room, peers,
      chip: { text: chip.textContent, title: chip.title, hidden: chip.hidden, verified: chip.dataset.verified || '' },
      stats,
      confirmFailures: window.e2eApp.counters().confirmFailures,
      workerErrors: window.e2eApp.counters().workerErrors.length,
      workerErrorList: window.e2eApp.counters().workerErrors.slice(0, 4),
    };
  });
}

async function openStats(page) {
  const open = await page.evaluate(() => !document.getElementById('stats-panel').hidden);
  if (!open) await page.click('#stats-btn');
  await sleep(2500);
}

async function dump(page, label, errors) {
  let state = null;
  try {
    state = await meshState(page);
  } catch (e) {
    state = 'evaluate failed: ' + e;
  }
  console.log('DUMP  ' + label + '  ' + JSON.stringify(state));
  if (errors && errors.length) console.log('ERRS  ' + label + '  ' + JSON.stringify(errors.slice(-10)));
}

(async () => {
  let browser = null;
  const pages = [];
  try {
    fs.mkdirSync(OUT, { recursive: true });
    browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // This Chromium build keeps RTCRtpScriptTransform behind a runtime
        // flag; without it the sealed path reports that sealing is missing.
        '--enable-features=RTCRtpScriptTransform',
      ],
    });
    // One context per guest, so names and stored volume do not mix.
    const ctxA = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const a = await joinPage(ctxA, 'alice', '');
    pages.push(a);
    const room = a.app.room;
    check('the room id is a 26 character random id', /^[a-z2-7]{26}$/.test(room), room);
    const ctxB = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const b = await joinPage(ctxB, 'bob', room);
    pages.push(b);
    const ctxC = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const c = await joinPage(ctxC, 'carol', room);
    pages.push(c);

    const settled = async (page, label) => until(page, () => {
      const p = window.e2eApp.peers();
      return p.length === 2 && p.every((x) => x.ready === 'ready' && x.confirmed && x.sas.length === 13) ? p : null;
    }, null, 90000, label).catch(async (e) => {
      for (const g of [a, b, c]) await dump(g.page, g.page === page ? label : 'other', g.errors);
      throw e;
    });

    await settled(a.page, 'alice mesh');
    await settled(b.page, 'bob mesh');
    await settled(c.page, 'carol mesh');

    for (const g of [a, b, c]) {
      await openStats(g.page);
      const st = await meshState(g.page);
      const label = st.peers.map((p) => p.name).sort().join('+');
      info('guest state', JSON.stringify({ self: st.self, room: st.room, peers: st.peers.map((p) => p.name + ':' + p.sas), chip: st.chip.text }));
      const codes = st.peers.map((p) => p.sas);
      check('the two pair codes differ at one guest (' + label + ')', codes[0] !== codes[1], codes.join(' vs '));
      check('both pair codes are on the tiles (' + label + ')',
        st.peers.every((p) => p.tileSas === p.sas), JSON.stringify(st.peers.map((p) => p.tileSas)));
      check('the chip counts the guests this browser pinned (' + label + ')',
        st.chip.text === 'verified 0/2' && st.chip.hidden === false, JSON.stringify(st.chip));
      check('the chip is red while no guest is pinned (' + label + ')',
        st.chip.verified === 'part', JSON.stringify(st.chip));
      check('the chip title says each pair has its own code (' + label + ')',
        /own code/.test(st.chip.title), st.chip.title);
      check('the chip is not an alarm (' + label + ')', !/differ|mismatch/i.test(st.chip.title), st.chip.title);
      check('the stats row keeps the per pair summary (' + label + ')',
        /one code per pair/.test(st.stats) && !/KEY MISMATCH|CODES DIFFER/.test(st.stats), st.stats.slice(0, 160));
      check('no key confirmation failure (' + label + ')', st.confirmFailures === 0, st.confirmFailures);
      check('no worker error (' + label + ')', st.workerErrors === 0, JSON.stringify(st.workerErrorList));
    }

    // Identity: the long-term key is Ed25519 and signing only, so every guest
    // holds one and every peer has to prove one before a pair exists.
    const sids = {};
    const fps = {};
    for (const g of [a, b, c]) {
      const who = g === a ? 'alice' : g === b ? 'bob' : 'carol';
      const id = await g.page.evaluate(() => window.e2eApp.identity());
      sids[who] = id ? id.sid : '';
      fps[who] = id ? id.fp : '';
      check('guest holds an identity with a readable fingerprint (' + who + ')',
        !!id && /^[a-z2-7]{4}(-[a-z2-7]{4}){4}$/.test(id.fp), JSON.stringify(id && { kind: id.kind, fp: id.fp, device: id.device }));
      check('the identity note says what the browser keeps (' + who + ')',
        !!id && !!id.note, id && id.note);
      check('the identity is not a page-only key (' + who + ')',
        !!id && id.device !== 'session', id && id.device);
      const st = await meshState(g.page);
      check('every peer proved its identity (' + who + ')', st.peers.every((p) => p.proven && !!p.fp),
        JSON.stringify(st.peers.map((p) => p.proven)));
      check('the two peers have different fingerprints (' + who + ')',
        new Set(st.peers.map((p) => p.fp)).size === st.peers.length,
        st.peers.map((p) => p.fp).join(' '));
      check('no identity refusal so far (' + who + ')',
        (await g.page.evaluate(() => window.e2eApp.counters().identityFailures)) === 0);
    }
    check('the three guests hold three identities',
      new Set([sids.alice, sids.bob, sids.carol]).size === 3 && Object.values(sids).every((v) => v));

    // What the page keeps on disk: an identity and pins, no session material.
    const audit = await a.page.evaluate(() => window.e2eApp.storageAudit());
    const stores = audit.stores ? Object.keys(audit.stores).sort().join(',') : 'none';
    check('storage holds an identity and pins only', stores === 'id,pins,revoked', stores);
    const stored = JSON.stringify(audit);
    check('no session id is written to storage',
      Object.values(sids).every((sid) => !sid || !stored.includes(sid)), stored.slice(0, 200));
    const page = await a.page.evaluate(() => ({
      local: Object.keys(localStorage).sort(),
      session: Object.keys(sessionStorage),
      cookie: document.cookie,
    }));
    check('local storage carries settings only', page.local.every((k) => k.startsWith('rooms.')), page.local.join(','));
    check('session storage and cookies are empty', page.session.length === 0 && page.cookie === '',
      JSON.stringify(page.session) + ' ' + page.cookie);

    // A pin is a local click, never an automatic step, and it names a
    // fingerprint rather than trusting the name a guest chose.
    // The name arrives sealed, after the pair is proven, so wait for it before
    // the pin is attached to it.
    const bobPeer = await until(a.page, () => {
      const p = window.e2eApp.peers().find((x) => x.name === 'bob');
      return p ? { id: p.id, fp: p.fp, pin: p.pin } : null;
    }, null, 30000, 'bob has a name');
    check('an unpinned guest reads unverified', !!bobPeer && bobPeer.pin === 'new', JSON.stringify(bobPeer));
    const chipBefore = await a.page.evaluate(() => {
      const t = [...document.querySelectorAll('.tile')].find((x) => x.dataset.peer
        && x.querySelector('.pin') && !x.querySelector('.pin').hidden);
      return t ? t.querySelector('.pin').textContent : '';
    });
    check('the tile says unverified before a pin', chipBefore === 'unverified', chipBefore);
    const pinResult = await a.page.evaluate((id) => window.e2eApp.pin(id, 'bob'), bobPeer.id);
    check('a deliberate pin turns the guest known', pinResult === 'known', pinResult);
    check('the pin count reads verified 1 of 2',
      (await a.page.evaluate(() => document.getElementById('pin-count').textContent)) === 'verified 1 of 2',
      await a.page.evaluate(() => document.getElementById('pin-count').textContent));
    check('the pin chip carries the local label',
      (await a.page.evaluate((id) => {
        const t = document.querySelector('.tile[data-peer="' + id + '"] .pin');
        return t ? t.textContent : '';
      }, bobPeer.id)) === 'bob');
    check('the pin is stored with its fingerprint, not a name',
      (await a.page.evaluate(() => window.e2eApp.pins())).some((r) => r.label === 'bob' && r.fp === bobPeer.fp));
    // The words on the tile are for the doubt only: a pinned guest keeps the
    // green named chip and loses the e2e line, an unpinned one keeps it in red.
    check('a pinned guest drops the e2e words from the tile',
      (await a.page.evaluate((id) => {
        const t = document.querySelector('.tile[data-peer="' + id + '"] .state');
        return !!t && t.hidden === true && t.textContent === '';
      }, bobPeer.id)) === true);
    check('no tile calls itself e2e ready any more',
      (await a.page.evaluate(() => [...document.querySelectorAll('.tile')]
        .filter((t) => t.dataset.peer && t.querySelector('.state')
          && t.querySelector('.state').textContent === 'e2e ready').length)) === 0);
    check('an unpinned guest says e2e unverified, in the unverified colour',
      (await a.page.evaluate(() => [...document.querySelectorAll('.tile .state')]
        .filter((s) => s.textContent === 'e2e unverified' && s.dataset.e2e === 'unverified'
          && !s.hidden).length)) >= 1);
    const renamed = await a.page.evaluate((id) => window.e2eApp.rename(id, 'bob at the studio'), bobPeer.id);
    check('a click on a known pin renames it and keeps the key',
      renamed === 'known'
      && (await a.page.evaluate((id) => {
        const chip = document.querySelector('.tile[data-peer="' + id + '"] .pin');
        return chip ? chip.textContent + '|' + chip.dataset.action : '';
      }, bobPeer.id)) === 'bob at the studio|rename'
      && (await a.page.evaluate(() => window.e2eApp.pins())).some((r) => r.label === 'bob at the studio' && r.fp === bobPeer.fp)
      && !(await a.page.evaluate(() => window.e2eApp.pins())).some((r) => r.label === 'bob'));
    await a.page.evaluate((id) => window.e2eApp.rename(id, 'bob'), bobPeer.id);

    // Both survive a reload: the identity comes back from the local database,
    // and so does the pin, which is how a changed key later becomes visible.
    await a.page.reload({ waitUntil: 'load', timeout: 60000 });
    await until(a.page, () => !!(window.e2eApp && window.e2eApp.state.wasmTest), null, 45000, 'reload wasm');
    // The room id is in the fragment, so the form comes back filled and the
    // join is one click; the identity and the pins are already on disk.
    await until(a.page, () => document.getElementById('room').value &&
      !document.getElementById('enter-btn').disabled, null, 45000, 'reload lobby');
    await a.page.click('#enter-btn', { timeout: 20000 });
    await until(a.page, () => !!(window.e2eApp && window.e2eApp.state.self), null, 30000, 'reload joined');
    await until(a.page, () => {
      const p = window.e2eApp.peers();
      return p.length === 2 && p.every((x) => x.ready === 'ready' && x.fp) ? p : null;
    }, null, 90000, 'reload mesh');
    const idBack = await a.page.evaluate(() => window.e2eApp.identity());
    check('the identity survives a reload', !!idBack && idBack.fp === fps.alice, idBack && idBack.fp);
    check('the device is still reported as kept', !!idBack && idBack.device === 'kept', idBack && idBack.device);
    const pinsBack = await a.page.evaluate(() => window.e2eApp.pins());
    check('the pin survives a reload', pinsBack.some((r) => r.label === 'bob' && r.fp === bobPeer.fp), JSON.stringify(pinsBack));
    const knownAgain = await a.page.evaluate((id) => window.e2eApp.pinState(id), bobPeer.id);
    check('the pinned peer is known again after the reload', knownAgain === 'known', knownAgain);

    // A fresh key under a label that already holds one is the changed state,
    // and the old fingerprint stays as revoked only after a deliberate reset.
    const changed = await a.page.evaluate((id) => {
      const p = window.e2eApp.state.peers.get(id);
      p.fp = 'aaaa-bbbb-cccc-dddd-eeee';
      return window.e2eApp.pin(id, 'bob');
    }, bobPeer.id);
    check('a fresh key for a known peer reads changed', changed === 'changed', changed);
    check('the changed guest is not counted as verified',
      (await a.page.evaluate(() => window.e2eApp.pinCount())).verified === 0);
    check('the tile shows the changed state',
      (await a.page.evaluate((id) => {
        const t = document.querySelector('.tile[data-peer="' + id + '"] .pin');
        return t ? t.textContent + '|' + t.dataset.pin : '';
      }, bobPeer.id)) === 'identity changed|changed');
    const reset = await a.page.evaluate((id) => window.e2eApp.resetDevice(id, 'bob'), bobPeer.id);
    check('"this device was reset" replaces the pin', reset === 'known', reset);
    const revoked = await a.page.evaluate(() => window.e2eApp.revoked());
    check('the replaced fingerprint is kept as revoked', revoked.some((r) => r.fp === bobPeer.fp), JSON.stringify(revoked));
    const rollback = await a.page.evaluate((id) => {
      const p = window.e2eApp.state.peers.get(id);
      p.fp = 'zzzz-zzzz-zzzz-zzzz-zzzz';
      return window.e2eApp.pinState(id);
    }, bobPeer.id);
    check('an unseen key for that label is still unverified', rollback === 'new', rollback);
    const oldBack = await a.page.evaluate((id) => {
      const p = window.e2eApp.state.peers.get(id);
      p.fp = window.e2eApp.revoked()[0].fp;
      return window.e2eApp.pinState(id);
    }, bobPeer.id);
    check('an old key that comes back is an alarm', oldBack === 'rollback', oldBack);

    // A guest leaves: one pair remains, so the chip counts one guest and that
    // guest keeps its own code on its tile.
    await c.page.click('#leave-btn');
    for (const g of [a, b]) {
      await until(g.page, () => window.e2eApp.peers().length === 1 && window.e2eApp.peers()[0].ready === 'ready',
        null, 60000, 'one peer left').catch(() => null);
    }
    await sleep(1500);
    for (const [g, label] of [[a, 'alice'], [b, 'bob']]) {
      const st = await meshState(g.page);
      const code = st.peers.length === 1 ? st.peers[0].sas : '';
      info('after the third guest left', JSON.stringify({ label, peers: st.peers.map((p) => p.name), chip: st.chip }));
      check('the chip counts one guest again (' + label + ')',
        st.chip.text === 'verified 0/1', st.chip.text);
      check('the remaining tile keeps its pair code (' + label + ')',
        !!code && st.peers.every((p) => p.tileSas === p.sas), code);
    }

    // The F2 case, both halves. A guest that completes a handshake but does
    // not sign its answer must be refused by the initiator; a guest that signs
    // properly can be reached, but must not be called verified until its
    // fingerprint is pinned. The fake peer runs the same wasm module, so this
    // is the real protocol, not a mock.
    const handshakeFake = async (sign) => a.page.evaluate((signed) => new Promise((resolve) => {
      const enc = (o) => btoa(JSON.stringify(o));
      const dec = (b) => JSON.parse(atob(b));
      const pq = window.stanzePQ;
      const me = JSON.parse(pq.gen());
      const key = JSON.parse(pq.idgen());
      const sid = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const aliceId = window.e2eApp.state.self;
      const sign1 = (msg) => (signed ? JSON.parse(pq.idsign(JSON.stringify({ seed: key.seed, msg }))).sig : '');
      let myId = '';
      let aliceX = '';
      let aliceK = '';
      let aliceID = '';
      let aliceSID = '';
      let done = false;
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      const finish = (v) => {
        if (done) return;
        done = true;
        // The socket stays open: a closed one makes the server drop the peer,
        // and the checks below look at the pair that the refusal left behind.
        (window.__fakeSockets = window.__fakeSockets || []).push(ws);
        resolve(v);
      };
      const timer = setTimeout(() => finish({ ok: false, why: 'timeout', id: myId }), 30000);
      const send = (o) => ws.send(JSON.stringify({ t: 'enc', to: aliceId, b: enc(o) }));
      const settle = (role) => setTimeout(() => finish({
        ok: true,
        role,
        id: myId,
        fp: JSON.parse(pq.idfp(JSON.stringify({ id: key.pub }))).fp,
      }), 1200);
      // The role comes from the ids: the lower one starts.
      const start = () => {
        if (!myId || !aliceX) return;
        if (String(myId) < String(aliceId)) {
          const off = JSON.parse(pq.initiate(JSON.stringify({
            self: myId, peer: aliceId,
            selfX: me.xpub, selfK: me.ek, selfID: key.pub, selfSID: sid,
            peerX: aliceX, peerK: aliceK, peerID: aliceID, peerSID: aliceSID,
          })));
          if (off.error) {
            clearTimeout(timer);
            finish({ ok: false, why: 'initiate: ' + off.error, id: myId });
            return;
          }
          const sig = sign1(off.transcript);
          send({ k: 'hello', epk: off.epk, ct: off.ct, id: key.pub, sid, sig });
          send({ k: 'ok', c: off.confirm, id: key.pub, sid, sig });
          settle('initiator');
        }
      };
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room: window.e2eApp.state.room, pass: '' }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'joined') {
          myId = m.self;
          send({ k: 'pub', x: me.xpub, m: me.ek, id: key.pub, sid });
          start();
          return;
        }
        if (m.t !== 'enc' || m.from !== aliceId) return;
        const msg = dec(m.b);
        if (msg.k === 'pub') {
          aliceX = msg.x;
          aliceK = msg.m;
          aliceID = msg.id;
          aliceSID = msg.sid;
          start();
          return;
        }
        if (msg.k === 'hello' && String(myId) > String(aliceId) && !done) {
          const acc = JSON.parse(pq.respond(JSON.stringify({
            self: myId, peer: aliceId,
            selfX: me.xpub, selfSK: me.xsk, selfK: me.ek, selfDK: me.dk,
            selfID: key.pub, selfSID: sid,
            peerX: aliceX, peerK: aliceK, peerID: aliceID, peerSID: aliceSID,
            epk: msg.epk, ct: msg.ct, sig: msg.sig || '',
          })));
          if (acc.error) {
            clearTimeout(timer);
            finish({ ok: false, why: 'respond: ' + acc.error, id: myId });
            return;
          }
          send({ k: 'ok', c: acc.confirm, id: key.pub, sid, sig: sign1(acc.transcript) });
          clearTimeout(timer);
          settle('responder');
        }
      };
    }), sign);

    const beforeUnsigned = await a.page.evaluate(() => window.e2eApp.counters().identityFailures);
    const unsigned = await handshakeFake(false);
    await sleep(1500);
    const unsignedSeen = await a.page.evaluate((id) => {
      const p = window.e2eApp.peers().find((x) => x.id === id) || {};
      return { ready: p.ready, proven: p.proven, failures: window.e2eApp.counters().identityFailures };
    }, unsigned.id);
    check('a guest that does not sign its answer is refused (' + (unsigned.role || '?') + ')',
      unsignedSeen.ready === 'failed' && !unsignedSeen.proven && unsignedSeen.failures === beforeUnsigned + 1,
      JSON.stringify(unsignedSeen) + ' ' + JSON.stringify(unsigned));

    const signed = await handshakeFake(true);
    const before = await a.page.evaluate(() => window.e2eApp.counters().identityFailures);
    await until(a.page, (id) => {
      const p = window.e2eApp.peers().find((x) => x.id === id);
      return p && p.proven ? p : null;
    }, signed.id, 30000, 'signed fake peer').catch(() => null);
    await sleep(800);
    const signedSeen = await a.page.evaluate((id) => {
      const p = window.e2eApp.peers().find((x) => x.id === id) || {};
      const tile = document.querySelector('.tile[data-peer="' + id + '"] .state');
      return { ready: p.ready, proven: p.proven, pin: p.pin, fp: p.fp,
        text: tile ? tile.textContent : '', failures: window.e2eApp.counters().identityFailures };
    }, signed.id);
    check('a signed guest passes the handshake (' + (signed.role || '?') + ')',
      signedSeen.ready === 'ready' && signedSeen.proven && signedSeen.fp === signed.fp,
      JSON.stringify(signedSeen));
    check('a signed guest is still unverified until it is pinned (' + (signed.role || '?') + ')',
      signedSeen.pin === 'new' && signedSeen.text === 'e2e unverified', JSON.stringify(signedSeen));
    check('the pinned guest reads ready, an unpinned one does not',
      signedSeen.failures === before && signedSeen.text !== 'e2e ready', String(signedSeen.failures));

    // A relay that strips the identity fields must not leave a working pair:
    // a guest that joins without them is refused, and refused loudly.
    const beforeFields = await a.page.evaluate(() => window.e2eApp.counters().identityFailures);
    const fake = await a.page.evaluate(async (room) => {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      const self = await new Promise((resolve, reject) => {
        ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room, pass: '' }));
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.t === 'joined') resolve(m.self);
        };
        setTimeout(() => reject(new Error('fake peer could not join')), 10000);
      });
      // The old v1 bundle: keys only, no identity and no session id.
      const legacy = { k: 'pub', x: btoa('\u0000'.repeat(32)), m: btoa('\u0000'.repeat(1184)) };
      ws.send(JSON.stringify({ t: 'enc', to: window.e2eApp.state.self, b: btoa(JSON.stringify(legacy)) }));
      return self;
    }, room);
    await sleep(1500);
    const refused = await a.page.evaluate((id) => ({
      failures: window.e2eApp.counters().identityFailures,
      ready: (window.e2eApp.peers().find((p) => p.id === id) || {}).ready,
      proven: (window.e2eApp.peers().find((p) => p.id === id) || {}).proven,
      keys: !!(window.e2eApp.peers().find((p) => p.id === id)),
    }), fake);
    check('a guest without identity fields is refused', refused.failures === beforeFields + 1, JSON.stringify(refused));
    check('the unsigned guest has no working pair', refused.keys && refused.ready === 'failed' && !refused.proven,
      JSON.stringify(refused));

    // The fake peers were only there for the refusal path.
    await a.page.evaluate(() => {
      for (const ws of window.__fakeSockets || []) {
        try { ws.close(); } catch (e) { /* already closed */ }
      }
      window.__fakeSockets = [];
    }).catch(() => {});
    await sleep(500);

    for (const g of [a, b, c]) check('page had no uncaught error (' + g.page.url().slice(-14) + ')', g.errors.length === 0,
      JSON.stringify(g.errors.slice(0, 3)));
    await a.page.screenshot({ path: OUT + '/a.png' });
    await b.page.screenshot({ path: OUT + '/b.png' });
    await c.page.screenshot({ path: OUT + '/c.png' });
  } catch (err) {
    check('test completed without exception', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    for (const [i, g] of pages.entries()) {
      await g.page.screenshot({ path: OUT + '/' + 'abc'[i] + '-fail.png' }).catch(() => {});
    }
  } finally {
    await browser && browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ checks: results.length, failed: failed.length }));
  fs.writeFileSync(OUT + '/results.json', JSON.stringify(results, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
})();
