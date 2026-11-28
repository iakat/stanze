/* Focused proof of the tab-hidden microphone mute, two real pages, one room.
 *
 * The full tools/browser-e2e.js stops earlier in this sandbox (the first
 * remote video never decodes on A, on unmodified main as well), so this file
 * exercises exactly the state machine of issue #32 and the peer's view of it.
 *
 * env: PW, ROOMSBASE
 */
'use strict';

const { chromium } = require(process.env.PW);

const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8097';
const results = [];
function check(name, ok, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, ok: !!ok, detail: d });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (d ? '  [' + d + ']' : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(page, fn, arg, timeout = 30000, label = '') {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
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

// hidden flips what the page reads as the tab state and rings the one event.
const setHidden = (page, hidden) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

const readOwn = (page) =>
  page.evaluate(() => ({
    mic: state.mic,
    away: state.micAway,
    gain: state.micGain ? state.micGain.gain.value : null,
    label: document.getElementById('mic-btn').textContent.trim(),
    pressed: document.getElementById('mic-btn').getAttribute('aria-pressed'),
    title: document.getElementById('mic-btn').title,
    track: state.micTrack ? state.micTrack.readyState : 'none',
    pref: localStorage.getItem('rooms.mic'),
    peers: state.peers.size,
    deaf: state.deaf,
  }));

(async () => {
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-features=RTCRtpScriptTransform',
    ],
  });
  const ctxA = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await pageA.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
    await until(pageA, () => state.wasmOk, null, 60000, 'A pq module');
    await pageA.fill('#name', 'ana');
    await pageA.click('#enter-btn');
    await until(pageA, () => /^[a-z0-9-]{10,}$/.test(location.hash.replace('#r=', '')), null, 30000, 'room id');
    const room = await pageA.evaluate(() => location.hash.replace('#r=', ''));
    await until(pageA, () => state.micTrack && state.camTrack, null, 30000, 'A devices');

    await pageB.goto(BASE + '/#r=' + room, { waitUntil: 'load', timeout: 60000 });
    await until(pageB, () => state.wasmOk, null, 60000, 'B pq module');
    await pageB.fill('#name', 'bo');
    await pageB.click('#enter-btn');
    await until(pageB, () => state.micTrack && state.camTrack, null, 30000, 'B devices');
    await until(pageA, () => [...state.peers.values()].some((p) => p.state === 'connected'), null, 60000, 'A pair');
    await until(pageB, () => [...state.peers.values()].some((p) => p.state === 'connected'), null, 60000, 'B pair');
    await sleep(1500);

    // ---- the switch exists, starts on, and stores like the other switches
    const menu = await pageA.evaluate(() => {
      const box = document.getElementById('mute-hidden');
      const row = box ? box.closest('label.menu-item') : null;
      return {
        found: !!box,
        type: box && box.type,
        checked: box && box.checked,
        text: row ? row.textContent.trim() : '',
        stored: localStorage.getItem('rooms.mutehidden'),
      };
    });
    check('the settings menu carries the switch, checked by default',
      menu.found && menu.type === 'checkbox' && menu.checked === true && /hidden tab/.test(menu.text),
      JSON.stringify(menu));

    // ---- hidden: the gain drops, the button says off, the device stays open
    const before = await readOwn(pageA);
    check('A starts unmuted and heard', before.mic === true && before.gain === 1,
      JSON.stringify(before));

    await setHidden(pageA, true);
    const hidden = await readOwn(pageA);
    check('a hidden tab drops the microphone gain to zero',
      hidden.mic === false && hidden.gain === 0, JSON.stringify(hidden));
    check('the mic button says off, so the page never claims to be heard',
      hidden.label === 'mic off' && hidden.pressed === 'false', JSON.stringify(hidden));
    check('the button carries the reason', /hidden/.test(hidden.title), hidden.title);
    check('the device stays open, so no permission prompt comes back',
      hidden.track === 'live' && hidden.peers === 1, JSON.stringify(hidden));
    check('the tab mute writes no preference', hidden.pref === null, 'rooms.mic=' + hidden.pref);
    check('incoming audio is untouched (no deafen, no volume change)',
      hidden.deaf === false, 'deaf=' + hidden.deaf);

    // ---- the peer reads the guest as muted, not as gone
    await sleep(1200);
    const peerSees = await pageB.evaluate(() => {
      const peer = [...state.peers.values()][0];
      return { mic: peer ? peer.mic : null, state: peer ? peer.state : '', peers: state.peers.size };
    });
    check('the other guest sees a mute, not a guest who left',
      peerSees.mic === false && peerSees.state === 'connected' && peerSees.peers === 1,
      JSON.stringify(peerSees));

    // ---- back in front: exactly the prior state
    await setHidden(pageA, false);
    const back = await readOwn(pageA);
    check('the return puts the microphone back',
      back.mic === true && back.gain === 1 && back.label === 'mic on' && back.pressed === 'true',
      JSON.stringify(back));
    check('the return clears the flag and the reason',
      back.away === false && back.title === '', JSON.stringify(back));
    check('the return writes no preference', back.pref === null, 'rooms.mic=' + back.pref);
    await sleep(1200);
    const peerBack = await pageB.evaluate(() => {
      const peer = [...state.peers.values()][0];
      return { mic: peer ? peer.mic : null };
    });
    check('the other guest sees the microphone come back', peerBack.mic === true, JSON.stringify(peerBack));

    // ---- a mute the guest chose by hand is not undone by the return
    await pageA.click('#mic-btn');
    await setHidden(pageA, true);
    const handHidden = await readOwn(pageA);
    await setHidden(pageA, false);
    const handBack = await readOwn(pageA);
    check('a guest already muted by hand is not muted twice or unmuted behind their back',
      handHidden.mic === false && handHidden.away === false && handBack.mic === false &&
      handBack.gain === 0 && handBack.pref === '0',
      JSON.stringify({ handHidden, handBack }));
    await pageA.click('#mic-btn');

    // ---- the opt-out: off means a hidden tab keeps the microphone as it is
    const off = await pageA.evaluate(() => {
      const box = document.getElementById('mute-hidden');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      const stored = localStorage.getItem('rooms.mutehidden');
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      const quiet = { mic: state.mic, away: state.micAway, gain: state.micGain.gain.value };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return { stored, quiet, restored: localStorage.getItem('rooms.mutehidden') };
    });
    check('switched off, the choice is stored and a hidden tab keeps the microphone on',
      off.stored === '0' && off.quiet.mic === true && off.quiet.away === false && off.quiet.gain === 1,
      JSON.stringify(off));
    check('switched back on, the preference follows', off.restored === '1', 'rooms.mutehidden=' + off.restored);

    // ---- the stored switch comes back with the other preferences
    await pageA.evaluate(() => {
      const box = document.getElementById('mute-hidden');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pageA.reload({ waitUntil: 'load', timeout: 60000 });
    const reloaded = await pageA.evaluate(() => ({
      checked: document.getElementById('mute-hidden').checked,
      state: state.muteOnHidden,
    }));
    check('the switch comes back on the next load', reloaded.checked === false && reloaded.state === false,
      JSON.stringify(reloaded));
    await pageA.evaluate(() => {
      const box = document.getElementById('mute-hidden');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // ---- outside a call there is nothing to mute and no stale flag
    const lobby = await pageA.evaluate(() => ({ room: state.room, away: state.micAway, hidden: document.hidden }));
    check('the lobby carries no tab mute', lobby.room === '' && lobby.away === false, JSON.stringify(lobby));
  } catch (e) {
    console.log('FATAL ' + String(e));
    results.push({ name: 'fatal', ok: false, detail: String(e) });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length === 0
    ? 'RESULT: PASS (' + results.length + ' checks)'
    : 'RESULT: FAIL (' + failed.length + ' of ' + results.length + ' checks)');
  if (failed.length) process.exitCode = 1;
})();
