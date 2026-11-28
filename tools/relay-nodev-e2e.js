// A room with no camera and no microphone at all must still hold every pair
// over the relay. This is the case the user called out: a machine without a
// webcam has to work like any other.
const { chromium } = require(process.env.PW);
const BASE = process.env.ROOMSBASE || 'http://127.0.0.1:8095';
const NAMES = ['uno', 'due'];
const room = 'nd' + Date.now().toString(36);
(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--enable-features=RTCRtpScriptTransform'] });
  const pages = [];
  for (const n of NAMES) {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE + '/#r=' + room, { waitUntil: 'domcontentloaded' });
    pages.push({ n, p });
  }
  for (const g of pages) {
    await g.p.evaluate(() => {
      const k = document.getElementById('path');
      if (k) { k.value = 'relay'; k.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }
  for (const g of pages) {
    await g.p.evaluate((n) => {
      const nm = document.getElementById('name');
      if (nm) { nm.value = n; nm.dispatchEvent(new Event('input', { bubbles: true })); }
      const lb = document.getElementById('lobby');
      if (lb && !lb.hidden) document.getElementById('enter-btn').click();
    }, g.n);
    await g.p.waitForTimeout(500);
  }
  await new Promise((r) => setTimeout(r, 16000));
  let bad = 0;
  for (const g of pages) {
    const st = await g.p.evaluate(async () => {
      const s = window.e2eApp.state;
      const out = { mic: s.mic, cam: s.cam, peers: s.peers.size, pairs: [] };
      for (const peer of s.peers.values()) {
        if (!peer.pc) continue;
        const row = { conn: peer.pc.connectionState };
        const st2 = await peer.pc.getStats();
        const t = [];
        st2.forEach((v) => { if (v.type === 'local-candidate' || v.type === 'remote-candidate') t.push(v.candidateType); });
        row.cands = [...new Set(t)];
        out.pairs.push(row);
      }
      return out;
    });
    const relayed = st.pairs.length > 0 && st.pairs.every((x) => x.conn === 'connected' && x.cands.includes('relay'));
    console.log((relayed ? 'PASS ' : 'FAIL ') + g.n + ' mic=' + st.mic + ' cam=' + st.cam + ' ' + JSON.stringify(st.pairs));
    if (!relayed) bad++;
  }
  await b.close();
  console.log(bad === 0 ? 'no camera, no microphone: the relay still carries every pair' : 'FAILED');
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
