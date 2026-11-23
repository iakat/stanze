/*
 The stats panel and the wire audit numbers it shows.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { say } from './util.js';
import { send } from './menu.js';
import { micLevelCells } from './audio.js';
import { gap, unit } from './look.js';
import { pairLabel, sealedFailedPairs, sealedRoomCodes, sealingAvailable, shortPeer, verifyText } from './sealed.js';
import { fingerprint, pinState } from './identity.js';
import { canary } from './audit.js';

// ---------------------------------------------------------------- telemetry
// The stats panel is read at 1 Hz from getStats deltas: two byte counters give
// a bitrate, two packet counters give the loss, the inbound streams give the
// jitter, and the selected candidate pair gives the round trip time and the
// path. Polling stops when the panel is closed or the tab is hidden.
export const STATS_MS = 1000;

export const STATS_HISTORY = 60;   // one sample a second, so a minute of the call

export function statsOpen() {
  const panel = $('stats-panel');
  return !!panel && !panel.hidden;
}

export function startStats() {
  if (state.statsTimer || !statsOpen()) return;
  for (const peer of state.peers.values()) {
    peer.statLast.clear();
    peer.statLoss = undefined;
  }
  state.statHist.length = 0;
  clearStatsPanel();
  updateStats();
  state.statsTimer = setInterval(() => updateStats(), STATS_MS);
}

export function stopStats() {
  if (state.statsTimer) clearInterval(state.statsTimer);
  state.statsTimer = null;
}

// setStatsOpen is the one place that shows or hides the panel, so the toolbar
// button and the close button on the panel head cannot disagree.
export function setStatsOpen(open) {
  $('stats-panel').hidden = !open;
  $('stats-btn').setAttribute('aria-pressed', String(open));
  if (open && !document.hidden) startStats();
  else stopStats();
}

export function clearStatsPanel() {
  const body = $('stats-body');
  if (body) body.replaceChildren();
  const sum = $('stats-sum');
  if (sum) sum.replaceChildren();
}

// bitrate turns two samples of one byte counter into kilobits per second. The first sample
// of a counter yields 0, which is honest: nothing was measured yet.
export function bitrate(last, report, field) {
  const bytes = report[field] || 0;
  const ts = report.timestamp || 0;
  const key = `${report.id || report.type + ':' + report.kind}:${field}`;
  const prev = last.get(key);
  last.set(key, { bytes, ts });
  if (!prev || !(ts > prev.ts)) return 0;
  const kbit = ((bytes - prev.bytes) * 8) / (ts - prev.ts);
  return kbit > 0 ? Math.round(kbit) : 0;
}

export function isDirectType(type) {
  return type === 'host' || type === 'srflx' || type === 'prflx';
}

// counterDelta is the movement of one cumulative counter since the last tick.
// A counter that is missing or that went backwards yields null, so a restarted
// report cannot turn into a burst of invented packets.
export function counterDelta(last, report, field) {
  const value = report[field];
  if (typeof value !== 'number') return null;
  const key = `${report.id || report.type + ':' + report.kind}:${field}`;
  const prev = last.get(key);
  last.set(key, { bytes: value, ts: report.timestamp || 0 });
  return prev ? value - prev.bytes : null;
}

// peerStats reads one report of one peer. Every access is guarded: a peer that
// closed between two ticks must not throw.
export async function peerStats(peer) {
  const pc = peer.pc;
  if (!pc || typeof pc.getStats !== 'function') return null;
  if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return null;
  let report;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }
  if (!report || typeof report.forEach !== 'function') return null;
  if (!(peer.statLast instanceof Map)) peer.statLast = new Map();

  const out = {
    up: { audio: 0, video: 0 }, down: { audio: 0, video: 0 },
    rtt: null, path: '', jitter: null, loss: null, shot: '',
  };
  let jitterMax = null;   // seconds, the worse of the two inbound streams
  let lost = 0;           // packets lost in this tick, both streams
  let got = 0;            // packets received in this tick, both streams
  let pairId = null;
  const pairs = new Map();
  const cands = new Map();
  try {
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
        out.up[r.kind] += bitrate(peer.statLast, r, 'bytesSent');
      } else if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) {
        out.down[r.kind] += bitrate(peer.statLast, r, 'bytesReceived');
        // The decoder reports the picture it is handed, which is the only
        // size that matters: the sender may clamp for its own bandwidth.
        if (r.kind === 'video' && r.frameWidth && r.frameHeight) {
          out.shot = `${r.frameWidth}x${r.frameHeight}`;
        }
        // Jitter and loss belong to the side that listens: a packet lost on
        // the way here is a packet gone for this guest, so this report is the
        // only honest place to read them.
        if (typeof r.jitter === 'number') {
          jitterMax = jitterMax === null ? r.jitter : Math.max(jitterMax, r.jitter);
        }
        const dLost = counterDelta(peer.statLast, r, 'packetsLost');
        const dGot = counterDelta(peer.statLast, r, 'packetsReceived');
        if (dLost !== null && dGot !== null && dGot >= 0) {
          lost += Math.max(0, dLost);
          got += dGot;
        }
      } else if (r.type === 'transport' && r.selectedCandidatePairId) {
        pairId = r.selectedCandidatePairId;
      } else if (r.type === 'candidate-pair') {
        pairs.set(r.id, r);
      } else if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
        cands.set(r.id, r);
      }
    });
  } catch {
    // A report can change under the loop; the next tick reads a fresh one.
  }

  let pair = pairId ? pairs.get(pairId) : null;
  if (!pair) {
    for (const p of pairs.values()) {
      if (p.selected || p.nominated) { pair = p; break; }
    }
  }
  if (!pair) {
    for (const p of pairs.values()) {
      if (p.state === 'succeeded') { pair = p; break; }
    }
  }
  if (pair) {
    if (typeof pair.currentRoundTripTime === 'number') {
      out.rtt = Math.round(pair.currentRoundTripTime * 1000);
    }
    const local = cands.get(pair.localCandidateId);
    const remote = cands.get(pair.remoteCandidateId);
    const lt = local ? local.candidateType || local.type || '' : '';
    const rt = remote ? remote.candidateType || remote.type || '' : '';
    const relays = [];
    if (lt === 'relay') relays.push('you');
    if (rt === 'relay') relays.push('them');
    if (relays.length) out.path = `relay (${relays.join(' + ')})`;
    else if (isDirectType(lt) && isDirectType(rt)) out.path = 'p2p';
  }
  if (jitterMax !== null) out.jitter = jitterMax * 1000;
  if (got > 0) {
    // One tick is a short window, so the share is smoothed: a single burst
    // moves the number without pinning it for the rest of the call.
    const now = (lost / (lost + got)) * 100;
    out.loss = typeof peer.statLoss === 'number' ? peer.statLoss * 0.7 + now * 0.3 : now;
    peer.statLoss = out.loss;
  }
  return out;
}

// rateText renders a bitrate as the number and the first letter of its unit,
// because the column beside it already says what the number is. A rate of
// zero returns an empty string, so a cell with nothing to say stays empty.
export function rateText(kbit) {
  if (!(kbit > 0)) return '';
  // With the byte setting on, the same rate is read in bytes, so a guest can
  // compare it with the size of a file or a disk.
  if (state.statsBytes) {
    const bytes = kbit * 125;
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + 'm';
    return Math.round(bytes / 1024) + 'k';
  }
  if (kbit >= 1000) return (kbit / 1000).toFixed(kbit >= 10000 ? 0 : 1) + 'm';
  return Math.round(kbit) + 'k';
}

// msText renders one round trip time in milliseconds, as "12 ms". The unit is
// spelled out because the bitrate column already uses a bare "m" for megabits.
export function msText(ms) {
  return Math.round(ms) + ' ms';
}

// jitterText renders one jitter in milliseconds. The numbers are small and a
// few milliseconds decide whether a voice sounds clear, so under 10 keeps one
// decimal.
export function jitterText(ms) {
  if (typeof ms !== 'number') return '';
  return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
}

// lossText renders a packet loss share. Under a twentieth of a percent is not
// a loss that a person can hear, so it reads as none; two percent and more is
// the point where a voice starts to break, and the caller marks it red.
export function lossText(pct) {
  if (typeof pct !== 'number') return '';
  if (pct < 0.05) return 'none';
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + ' %';
}

// lossMark is the colour rule for a loss row: red from two percent, no mark
// below it.
export function lossMark(pct) {
  return pct >= 2 ? false : undefined;
}

// The drawings of the panel. Each stands where a word would and carries the
// word in its title, so a hover names it.
export const VIDEO_ICON = ['1F3A5', 'video'];

export const AUDIO_ICON = ['1F50A', 'audio'];

export const PICTURE_ICON = ['1F5BC', 'picture size'];

export const PING_ICON = ['1F3D3', 'round trip'];

export const JITTER_ICON = ['1F30A', 'jitter, how far apart the packets arrive'];

export const LOSS_ICON = ['1F4C9', 'packet loss'];

export const DIRECT_ICON = ['1F517', 'direct, the two browsers talk to each other'];

export const RELAY_ICON = ['1F4E1', 'relay, the media goes through the server'];

export const UP_ICON = ['2B06', 'out, what this browser sends'];

export const DOWN_ICON = ['2B07', 'in, what this browser receives'];

// routeCell is the value of the route row: the drawing and the word. A link
// when the two browsers talk to each other, a satellite when the media has to
// pass the server.
export function routeCell(path) {
  if (!path) return ['', '', 'not known yet'];
  const direct = path === 'direct' || path === 'p2p';
  return [...(direct ? DIRECT_ICON : RELAY_ICON), path === 'p2p' ? 'direct' : path];
}

// rateCell is one bitrate with the arrow of its direction. Both directions sit
// on the same row, so the two rates of the video row and of the audio row line
// up under each other.
export function rateCell(dir, kbit) {
  return [...(dir === 'up' ? UP_ICON : DOWN_ICON), rateText(kbit) || '-'];
}

// tripCells are the three numbers of one path: how long a packet takes, how
// far apart the packets arrive, and how many of them never arrive. A number
// that is not there yet leaves its cell empty, and the column stays.
export function tripCells(rtt, jitter, loss) {
  return [
    [...PING_ICON, typeof rtt === 'number' ? msText(rtt) : ''],
    [...JITTER_ICON, typeof jitter === 'number' ? jitterText(jitter) : ''],
    [...LOSS_ICON, typeof loss === 'number' ? lossText(loss) : '', lossMark(loss)],
  ];
}

// pathText is the word a guest reads for one route: the report says p2p for a
// direct pair, and the panel says direct.
export function pathText(path) {
  return path === 'p2p' ? 'direct' : path;
}

// callPath is the route of the whole call: one word when every pair takes the
// same route, and the list of routes when they do not.
export function callPath(live) {
  const words = new Set();
  for (const s of live) if (s.path) words.add(pathText(s.path));
  if (words.size === 0) return '';
  if (words.size === 1) return [...words][0];
  return 'mixed: ' + [...words].join(', ');
}

// callPairs is the first card and the glance of the panel: the route with the
// three numbers of the path on one row, then what the whole call sends and
// receives. A number that is not there yet leaves its cell empty, so the rows
// below it still line up.
/** @returns {(string | (string | boolean)[][])[][]} */

export function callPairs(live, total) {
  const out = [];
  const path = callPath(live);
  const worst = (key) => {
    const nums = live.map((s) => s[key]).filter((n) => typeof n === 'number');
    return nums.length ? Math.max(...nums) : null;
  };
  const rtt = worst('rtt');
  const jitter = worst('jitter');
  const loss = worst('loss');
  if (path) out.push(['route ', [routeCell(path)]]);
  if (rtt !== null || jitter !== null || loss !== null) {
    out.push(['link ', tripCells(rtt, jitter, loss), undefined, 'metrics']);
  }
  out.push([VIDEO_ICON, [['', '', ''], rateCell('up', total.up.video), rateCell('down', total.down.video)]]);
  out.push([AUDIO_ICON, [['', '', ''], rateCell('up', total.up.audio), rateCell('down', total.down.audio)]]);
  return out;
}

// levelDb is one input peak as decibels, or the word silent under -60 dB, which
// is below anything a person hears.
export function levelDb(peak) {
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  return db > -60 ? `${Math.round(db)} dB` : 'silent';
}

// levelFraction is the share of the -60 dB to 0 dB scale that one peak fills,
// from 0 to 1, for the bar of a meter row.
export function levelFraction(peak) {
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

// peerLevel is what arrives from one guest, read before the gain. It is empty
// until the audio path of that guest exists.
export function peerLevel(peer) {
  if (!peer.audioSrc || !peer.meter) return '';
  return levelDb(peer.meterPeak || 0);
}

// ownPairs is the own card: the key this browser holds, then what its own
// camera and microphone do. A live track with a silent meter points at the
// graph; a dead context points at the autoplay rule of a phone, so the sound
// state only shows when it needs a click.
/** @returns {(string | (string | boolean)[][])[][]} */

export function ownPairs(total) {
  const out = [];
  // The long-term identity of this browser: the fingerprint alone, under the
  // name of the card, because where the key lives is the panel's noise.
  if (state.idKey) out.push(['key ', state.idKey.fp, undefined, 'mono']);
  const live = !!(state.mic && state.micTrack && state.micTrack.readyState === 'live');
  const mic = live && state.micTrack && state.micTrack.getSettings ? state.micTrack.getSettings() : null;
  const cam = state.camTrack && state.camTrack.getSettings ? state.camTrack.getSettings() : null;
  const shot = cam && cam.width && cam.height ? `${cam.width}x${cam.height}` : 'off';
  out.push([VIDEO_ICON, [
    [...PICTURE_ICON, shot],
    rateCell('up', total ? total.up.video : 0),
    rateCell('down', total ? total.down.video : 0),
  ]]);
  const sample = mic && mic.sampleRate ? `${Math.round(mic.sampleRate / 1000)} kHz ${mic.channelCount || 1}ch` : '';
  out.push([AUDIO_ICON, [
    ['', '', live ? (sample || 'on') : 'off'],
    rateCell('up', total ? total.up.audio : 0),
    rateCell('down', total ? total.down.audio : 0),
  ]]);
  // The microphone has a meter of its own: a bar that fills with the level,
  // so a speaker sees at once that the voice is going out.
  const level = live && state.micAnalyser ? micLevelCells(state.meterPeak) : null;
  out.push(['mic ', [['', '', level ? (level.state === 'silent' ? 'silent' : level.db) : 'off']],
    undefined, false, level ? levelFraction(state.meterPeak) : 0]);
  const ctx = state.playCtx;
  const play = ctx ? ctx.state : 'none';
  if (play !== 'running') out.push(['sound ', `${play}, tap the page once`, false]);
  return out;
}

// peerPairs is one guest card: the identity first, then the path and the two
// media rows of that pair. A cell with no number stays empty, so the columns
// line up with the row above it, and with one guest in the room this card is
// the whole call.
/** @returns {(string | (string | boolean)[][])[][]} */

export function peerPairs(peer, s) {
  const out = [];
  const pin = pinState(peer);
  if (peer.fp && pin !== 'new') {
    // The key sits right under the name of the card, with a green tick when
    // this browser can name that guest and the state word when it cannot. A
    // key is read letter by letter, so it is monospace.
    const bad = pin === 'changed' || pin === 'rollback';
    const cells = [pin === 'known' ? ['2714', 'verified', peer.fp] : ['', '', peer.fp]];
    if (pin !== 'known') cells.push(['', '', pin]);
    out.push(['key ', cells, bad ? false : undefined, 'mono']);
  }
  if (!s) {
    out.push(['', 'connecting', undefined, true]);
  } else {
    out.push(['route ', [routeCell(s.path)]]);
    out.push(['link ', tripCells(s.rtt, s.jitter, s.loss), undefined, 'metrics']);
    out.push([VIDEO_ICON, [
      [...PICTURE_ICON, s.shot || ''],
      rateCell('up', s.up.video),
      rateCell('down', s.down.video),
    ]]);
    out.push([AUDIO_ICON, [
      ['', '', peerLevel(peer)],
      rateCell('up', s.up.audio),
      rateCell('down', s.down.audio),
    ]]);
  }
  // With one code in the room the code card below names it once, and a line
  // on every guest would say the same thing again.
  if (peer.sas && sealedRoomCodes().size > 1) out.push(['code ', verifyText(peer.sas), undefined, true]);
  if (!peer.keys) out.push(['keys ', 'none', false, true]);
  else if (peer.ready === 'ready' && !peer.confirmed) out.push(['keys ', 'not confirmed', false, true]);
  const c = sealedPairCount(peer.id);
  if (c.refused) out.push(['frames ', `${c.refused} refused`, false, true]);
  return out;
}

// statsRow is one card of the panel: a name and a short list of key/value
// lines. A line is [key, value] or [key, value, mark] with a mark of true for
// green and false for red. The fourth field is true for an indented sub row,
// or 'mono' for a value that is read letter by letter, such as a key.
// statIcon is one OpenMoji drawing with the word it stands for in its title,
// so a line can say "video" with a picture and still answer a hover.
export function statIcon(hex, title) {
  const img = document.createElement('img');
  img.className = 'sico';
  img.src = `/openmoji/${hex}.svg`;
  img.alt = title;
  img.title = title;
  return img;
}

// statCells fills one row with one cell per part. A part is text, or
// [drawing, word, text] with the word in the title, or the same with a fourth
// false to mark that cell red. An empty part keeps its column, so the numbers
// of the row below still line up with it.
export function statCells(value, metrics) {
  const span = document.createElement('span');
  span.className = 'sv';
  const parts = Array.isArray(value) ? value : [value];
  for (const raw of parts) {
    const p = Array.isArray(raw) ? raw : [raw];
    const cell = document.createElement('span');
    cell.className = 'cell' + (p[3] === true ? ' good' : p[3] === false ? ' bad' : '');
    const word = p.length > 1 ? p[2] : p[0];
    const text = document.createElement('span');
    text.textContent = word === null || word === undefined ? '' : String(word);
    if (metrics && p.length > 1 && p[1]) {
      // A metric reads as a small label over a number: the word is the first
      // part of the title of its drawing, so the two never disagree.
      const label = document.createElement('span');
      label.className = 'cl';
      label.title = String(p[1]);
      label.textContent = String(p[1]).split(',')[0];
      text.className = 'cv';
      cell.append(label, text);
    } else {
      if (p.length > 1 && p[0]) cell.appendChild(statIcon(p[0], p[1]));
      cell.appendChild(text);
    }
    span.appendChild(cell);
  }
  return span;
}

export function statLine(key, value, mark, sub, meter) {
  const line = document.createElement('div');
  const parts = Array.isArray(value) ? value : [value];
  line.className = 'sline' + (sub === 'mono' ? ' mono' : sub === 'metrics' ? ' metrics' : sub ? ' sub' : '') +
    (typeof meter === 'number' ? ' meterline' : '') +
    (mark === true ? ' good' : mark === false ? ' bad' : '');
  line.dataset.n = String(parts.length);
  const k = document.createElement('span');
  k.className = 'sk';
  // A key of two is [drawing, word]: the drawing and the first words of its
  // title, so the row reads without a hover. A key with no drawing keeps its
  // word as text.
  if (Array.isArray(key) && key[0]) {
    k.appendChild(statIcon(key[0], key[1]));
    k.appendChild(document.createTextNode(String(key[1]).split(',')[0]));
  } else k.textContent = Array.isArray(key) ? (key[1] || '') : key;
  line.appendChild(k);
  if (typeof meter === 'number') {
    const bar = document.createElement('span');
    bar.className = 'meter';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `level ${Math.round(meter * 100)} percent`);
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(meter * 100)}%`;
    bar.appendChild(fill);
    line.appendChild(bar);
  }
  line.appendChild(statCells(value, sub === 'metrics'));
  return line;
}

export function statsRow(title, pairs, mark, badge) {
  const row = document.createElement('div');
  row.className = 'srow';
  const head = document.createElement('div');
  head.className = 'sname';
  const name = document.createElement('span');
  name.className = 'stitle';
  name.textContent = title;
  head.appendChild(name);
  // The badge is the verdict of one guest: a lamp and a word, so the card says
  // how that link is before a number has to be read.
  if (badge && badge.level) {
    const chip = document.createElement('span');
    chip.className = 'sbadge';
    chip.dataset.level = badge.level;
    chip.textContent = badge.text || badge.level;
    head.appendChild(chip);
  }
  row.appendChild(head);
  for (const p of pairs) {
    row.appendChild(statLine(p[0], p[1], p.length > 2 ? p[2] : mark, p.length > 3 ? p[3] : false, p[4]));
  }
  return row;
}

// linkLevel is the verdict on one link: poor from 5 percent loss or 400 ms,
// fair from 2 percent, 200 ms or 40 ms of jitter, good otherwise. A link with
// nothing measured yet has no verdict, because a guess would be a lie.
export function linkLevel(s) {
  if (!s) return '';
  const { rtt, loss, jitter } = s;
  if (rtt === null && loss === null) return '';
  if ((loss !== null && loss >= 5) || (rtt !== null && rtt >= 400)) return 'poor';
  if ((loss !== null && loss >= 2) || (rtt !== null && rtt >= 200) || (jitter !== null && jitter >= 40)) return 'fair';
  return 'good';
}

export function worstLevel(levels) {
  for (const word of ['poor', 'fair', 'good']) if (levels.includes(word)) return word;
  return '';
}

// statsSummary is the first card: one lamp and one sentence for the whole
// call, so a healthy call needs no reading and a weak one says what to do.
export function statsSummary(live, guestCount) {
  const level = worstLevel(live.map(linkLevel));
  const box = document.createElement('div');
  box.className = 'ssum';
  box.dataset.level = level;
  const lamp = document.createElement('span');
  lamp.className = 'slamp';
  const text = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'ssum-head';
  const sub = document.createElement('div');
  sub.className = 'ssum-sub';
  if (guestCount === 0) {
    head.textContent = 'waiting for guests';
    sub.textContent = 'the numbers start when someone joins';
  } else if (!level) {
    head.textContent = 'measuring';
    sub.textContent = 'the first numbers arrive in a second';
  } else {
    head.textContent = `connection ${level}`;
    const nums = live.map((s) => s.rtt).filter((n) => typeof n === 'number');
    const loss = live.map((s) => s.loss).filter((n) => typeof n === 'number');
    const bits = [callPath(live)];
    if (nums.length) bits.push(msText(Math.max(...nums)));
    if (loss.length) bits.push(`loss ${lossText(Math.max(...loss))}`);
    sub.textContent = bits.filter(Boolean).join(' | ');
    if (level === 'poor') sub.textContent += '. Try a lower quality in the toolbar.';
  }
  text.append(head, sub);
  box.append(lamp, text);
  return box;
}

// recordStatsHistory appends one sample of the whole call: what came down,
// the worst round trip and the worst loss of that second. The graph is a
// glance, so a healthy call draws a flat floor and not a row of numbers.
export function recordStatsHistory(total, live) {
  const worst = (key) => {
    const nums = live.map((s) => s[key]).filter((n) => typeof n === 'number');
    return nums.length ? Math.max(...nums) : null;
  };
  state.statHist.push({ down: total.down.video + total.down.audio, rtt: worst('rtt'), loss: worst('loss') });
  if (state.statHist.length > STATS_HISTORY) state.statHist.shift();
}

// statsPlot draws one series on one small canvas. A filled series is an area
// that stands on the floor, a line series is a stroke that breaks where a
// sample has no value. The peak comes from the caller, so a small number still
// fills the box, and the floor under it keeps a quiet call from reading as a
// dead one.
export function statsPlot(canvas, values, peak, fill, color) {
  if (!canvas) return;
  const cssW = canvas.clientWidth || 288;
  const cssH = canvas.clientHeight || 34;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // A black screen with a dark green grid, like the performance monitor of the
  // era: the shape reads at a glance and the colours need no legend.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cssW, cssH);
  const n = values.length;
  // One step is one second of a fixed minute and the newest sample sits at the
  // right edge, so a call that has run for ten seconds fills a sixth of the
  // box and the picture scrolls left from there, instead of stretching.
  const stepX = (cssW - 2) / (STATS_HISTORY - 1);
  const px = (i) => cssW - 1 - (n - 1 - i) * stepX;
  const py = (v) => cssH - 1 - (Math.min(v, peak) / peak) * (cssH - 2);

  ctx.strokeStyle = '#0c3c0c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 1; g < 3; g++) {
    const y = Math.round((cssH * g) / 3) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
  }
  for (let g = 1; g < 6; g++) {
    const x = Math.round((cssW * g) / 6) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssH);
  }
  ctx.stroke();
  if (n < 1) return;

  if (fill) {
    ctx.beginPath();
    ctx.moveTo(px(0), cssH - 1);
    for (let i = 0; i < n; i++) ctx.lineTo(px(i), py(values[i] === null ? 0 : values[i]));
    ctx.lineTo(px(n - 1), cssH - 1);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  let drawing = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null) { drawing = false; continue; }
    if (drawing) ctx.lineTo(px(i), py(v));
    else { ctx.moveTo(px(i), py(v)); drawing = true; }
  }
  ctx.stroke();
}

// statsNote writes the text line under one drawing. The drawing is a glance,
// the line under it carries the numbers, so a guest who cannot read the shapes
// loses nothing.
export function statsNote(id, text) {
  const note = $(id);
  if (note) note.textContent = text;
}

// rateWords is a bitrate with its unit spelled out, for the line under a graph.
export function rateWords(kbit) {
  if (state.statsBytes) {
    const bytes = Math.max(0, kbit) * 125;
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + ' MiB/s';
    return Math.round(bytes / 1024) + ' KiB/s';
  }
  if (!(kbit > 0)) return '0 kbit/s';
  if (kbit >= 1000) return (kbit / 1000).toFixed(kbit >= 10000 ? 0 : 1) + ' Mbit/s';
  return Math.round(kbit) + ' kbit/s';
}

// drawStatsGraphs draws the last minute as three drawings: the downlink as a
// filled area, the round trip and the loss as lines. Each keeps its own peak,
// so one guest with a bad path shows on its own drawing and not as a small
// bump under a big one.
export function drawStatsGraphs() {
  const box = $('stats-graph-box');
  if (!box) return;
  const hist = state.statHist;
  box.hidden = hist.length < 2;
  if (hist.length < 2) return;
  const series = (key) => hist.map((p) => (typeof p[key] === 'number' ? p[key] : null));
  const values = (arr) => arr.filter((v) => v !== null);
  const peak = (arr, floor) => Math.max(floor, ...values(arr));
  const now = (arr) => {
    const kept = values(arr);
    return kept.length ? kept[kept.length - 1] : null;
  };
  const secs = `last ${hist.length} s`;

  // Downlink: the area says "steady" or "collapsing" at a glance. The floor of
  // 100 kbit/s keeps a quiet call on the floor of the box, not off it.
  const down = series('down');
  statsPlot($('stats-graph-down'), down, peak(down, 100), true, '#00e000');
  const downMax = Math.max(0, ...values(down));
  statsNote('stats-note-down', `down ${rateWords(now(down))} now, peak ${rateWords(downMax)}, ${secs}`);

  // Round trip: a line, broken where a sample has no value, so a gap is a gap.
  const rtt = series('rtt');
  statsPlot($('stats-graph-rtt'), rtt, peak(rtt, 100), false, '#f0e000');
  statsNote('stats-note-rtt', values(rtt).length
    ? `round trip ${msText(now(rtt))} now, peak ${msText(Math.max(...values(rtt)))}, ${secs}`
    : `round trip not measured, ${secs}`);

  // Loss: a line on a scale that starts at one percent, so a clean call is a
  // flat floor and any loss at all leaves the floor.
  const loss = series('loss');
  statsPlot($('stats-graph-loss'), loss, peak(loss, 1), false, '#ff5050');
  const lossMax = Math.max(0, ...values(loss));
  statsNote('stats-note-loss', lossMax > 0
    ? `loss ${lossText(now(loss))} now, peak ${lossText(lossMax)}, ${secs}`
    : `loss none, ${secs}`);
}

// updateStats draws one round: the faults and the verdict of the call, the
// graphs of the last minute, then one card per guest, the own side and the
// crypto counters.
export async function updateStats() {
  if (!statsOpen() || state.statsBusy) return;
  const body = $('stats-body');
  if (!body) return;
  state.statsBusy = true;
  try {
    const total = { up: { audio: 0, video: 0 }, down: { audio: 0, video: 0 } };
    const live = [];
    const guests = [];
    for (const peer of state.peers.values()) {
      const s = await peerStats(peer);
      if (s) {
        live.push(s);
        for (const dir of ['up', 'down']) {
          for (const kind of ['audio', 'video']) total[dir][kind] += s[dir][kind];
        }
      }
      guests.push({ peer, s });
    }
    const rows = [];
    recordStatsHistory(total, live);
    // With one guest in the room that card is the whole call, and a second
    // card of the same numbers would only be read twice.
    if (state.peers.size > 1) {
      const call = callPairs(live, total);
      if (call.length) rows.push(statsRow('call', call));
    }
    for (const { peer, s } of guests) {
      // The route can change in a call, so the tile mark follows what the
      // report says now and not only what it said when the link came up.
      if (s && s.path && peer.tile) peer.tile.dataset.relay = s.path.startsWith('relay') ? 'yes' : 'no';
      const level = linkLevel(s);
      const pairs = peerPairs(peer, s);
      if (pairs.length) {
        rows.push(statsRow(peer.name || shortPeer(peer.id), pairs, undefined, level ? { level, text: level } : null));
      }
    }
    rows.push(statsRow('you', ownPairs(total)));
    // The faults and the verdict sit in their own block above the graphs, so a
    // red line is the first thing on the panel and a healthy call needs no scroll.
    $('stats-sum').replaceChildren(...sealedAlarms(), statsSummary(live, state.peers.size));
    const legend = document.createElement('p');
    legend.className = 'slegend';
    legend.textContent = state.statsBytes
      ? 'k is KiB/s and m is MiB/s, eight bits to the byte. The up arrow is what you send, the down arrow what you receive.'
      : 'k is kbit/s and m is Mbit/s. The up arrow is what you send, the down arrow what you receive.';
    body.replaceChildren(...rows, ...sealedCards(), legend);
    drawStatsGraphs();
  } finally {
    state.statsBusy = false;
  }
}

// ------------------------------------------------------------- sealed stats
export function sealedPairCount(id) {
  const label = pairLabel(id);
  let out = 0;
  let inn = 0;
  let refused = 0;
  for (const st of Object.values(state.frames)) {
    if (!st || st.pair !== label) continue;
    if (st.dir === 'send') out += st.ok || 0;
    else if (st.dir === 'recv') {
      inn += st.ok || 0;
      refused += st.fail || 0;
    }
  }
  return { out, inn, refused };
}

// sealedAlarms are the lines that mean something is wrong now. A healthy call
// shows none of them, so the panel opens on the numbers and not on a warning
// that has to be read twice to be dismissed.
export function sealedAlarms() {
  const out = [];
  if (state.sealFault) out.push(statsRow('sealing fault', [['', state.sealFault, false]]));
  const failed = sealedFailedPairs();
  if (failed.length) {
    const tags = failed.map((peer) => `${peer.name || shortPeer(peer.id)} ${verifyText(peer.sas) || 'no code'}`);
    out.push(statsRow('room code', [
      ['', 'KEY MISMATCH ' + tags.join(', '), false],
      ['', 'do not trust this call', false],
    ]));
  }
  if (state.wireLeaks.length) {
    out.push(statsRow('leak', state.wireLeaks.map((w) => ['', `${w.where}: ${w.canary}`, false])));
  }
  if (state.workerErrors.length) {
    out.push(statsRow('worker', state.workerErrors.slice(0, 5).map((e) => ['', e, false])));
  }
  const wt = state.wasmTest;
  if (wt && !wasmTestOk(wt)) out.push(statsRow('self test', wasmTestFaults(wt)));
  return out;
}

export function wasmTestOk(wt) {
  return !!(wt.sasMatch && wt.confirm && wt.open && wt.wrongKeyRefused &&
    wt.idSign && wt.idUnsigned && wt.idFp && wt.pad && wt.passGood && wt.passBad);
}

// wasmTestFaults lists only the checks that failed.
// The whole list belongs in the test output, not on a screen a guest reads
// during a call.
/** @returns {(string | boolean)[][]} */

export function wasmTestFaults(wt) {
  const bad = [
    ['sas ', wt.sasMatch ? 'match' : 'no', !!wt.sasMatch],
    ['confirm ', wt.confirm ? 'ok' : 'no', !!wt.confirm],
    ['open ', wt.open ? 'ok' : 'no', !!wt.open],
    ['padding ', wt.pad ? 'ok' : 'BROKEN', !!wt.pad],
    ['wrong key ', wt.wrongKeyRefused ? 'refused' : 'OPENED', !!wt.wrongKeyRefused],
    ['identity ', wt.idSign ? 'signs' : 'BROKEN', !!wt.idSign],
    ['unsigned ', wt.idUnsigned ? 'refused' : 'ACCEPTED', !!wt.idUnsigned],
    ['fingerprint ', wt.idFp ? 'ok' : 'BROKEN', !!wt.idFp],
    ['room key ', wt.passGood ? 'ok' : 'BROKEN', !!wt.passGood],
    ['wrong key ', wt.passBad ? 'refused' : 'ACCEPTED', !!wt.passBad],
  ];
  const out = [['', 'FAIL', false]];
  for (const b of bad) if (!b[2]) out.push(b);
  return out;
}

// sealedCards is the crypto half of the panel, below the person cards: what
// the relay cannot see, in the few lines that answer it. A line that only
// repeats the suite or says "not run yet" is left out.
export function sealedCards() {
  const out = [];
  const available = sealingAvailable();
  const wt = state.wasmTest;
  const seal = [['media ', available ? 'sealed, every frame' : 'NO SEALING, no media is sent', available]];
  if (wt) seal.push(['self test ', wasmTestOk(wt) ? 'pass' : 'FAIL', wasmTestOk(wt)]);
  out.push(statsRow('crypto', seal));

  let refused = 0;
  for (const st of Object.values(state.frames)) {
    if (st && st.dir === 'recv') refused += st.fail || 0;
  }
  const clean = state.workerErrors.length === 0;
  const counts = [
    ['frames ', `out ${state.encryptFrames} in ${state.decryptFrames} refused ${refused}`, refused === 0 && clean],
    ['wire ', `frames ${state.wireFrames} leaks ${state.wireLeaks.length} clear ${state.clearSignaling}`,
      state.wireLeaks.length === 0 && state.clearSignaling === 0],
  ];
  const files = state.fileOffers + state.fileRecv + state.fileChunksRecv + state.fileChunksSent +
    state.fileRefused + state.fileCancelled;
  if (files) {
    counts.push(['files ', `offers ${state.fileOffers} saved ${state.fileRecv} in ${state.fileChunksRecv} out ${state.fileChunksSent} refused ${state.fileRefused} cancelled ${state.fileCancelled}`,
      state.fileRefused === 0 && state.fileCancelled === 0]);
  }
  const chat = state.chatSent + state.chatRecv + state.replayDrops + state.confirmFailures + state.identityFailures;
  if (chat) {
    counts.push(['chat ', `out ${state.chatSent} in ${state.chatRecv} replays ${state.replayDrops}`,
      state.replayDrops === 0 && state.confirmFailures === 0 && state.identityFailures === 0]);
  }
  out.push(statsRow('counters', counts));
  return out;
}
