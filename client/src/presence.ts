/*
 Media routing and the presence line.

 Nobody is subscribed to a stream they can not see. Audio is played and a
 picture is drawn for a guest only while that guest is in this page's
 conversation, and that is the same set the presence line lists. The line also
 says who each of them is talking to: every guest sends that word over its own
 pair, once per tick, so the answer is the guest's own and not a guess.

 The line therefore has three answers in it and nothing hidden behind them:
 who is in the room, who this page talks to, and who each of them talks to.
*/

import { $ } from './dom.js';
import { state } from './state.js';
import { applyFlags, volGain } from './volume.js';
import { paintPeerVideo } from './devices.js';
import { addChatLine } from './chat.js';
import { layoutStage } from './tiles.js';
import { peerName, shortPeer } from './sealed.js';

const routed = new Map<string, boolean>();
// The pair this page is on, as the guest on the other side reported it. It names
// peer ids, and the line turns them into names for a guest this page can see.
const talks = new Map<string, string[]>();

// presenceDebug writes one line of the proximity decision into the room log,
// so a guest can see why a neighbour is heard or not: who arrived, which
// facing pairs are routed, and where each guest stands. It is the same
// decision the presence line shows, with the numbers behind it. The lines are
// off in a person's page: they fill the room log, which is the sealed chat.
// The browser test turns them on through window.e2eApp.presenceDebug.
let proxNoteAt = 0;
function proxDebugOn(): boolean {
  const w = window as any;
  return !!(w && w.e2eApp && w.e2eApp.presenceDebug);
}
function where(peer: any): string {
  if (!peer) return ' (no peer)';
  const x = Number.isFinite(peer.x) ? Math.round(peer.x) : -1;
  const y = Number.isFinite(peer.y) ? Math.round(peer.y) : -1;
  return ' at ' + x + ',' + y + (peer.waiting ? ' waiting' : '');
}
export function presenceDebug(text: string) {
  if (!proxDebugOn()) return;
  addChatLine('debug', text, Date.now());
}
// proxNote is the rate limited line: a moving guest would otherwise write a
// line per frame.
export function proxNote(text: string) {
  if (!proxDebugOn()) return;
  const now = Date.now();
  if (now - proxNoteAt < 1500) return;
  proxNoteAt = now;
  addChatLine('debug', text, now);
}

// stageLayoutSoon marks the stage for one layout on the next frame. A routing
// change paints a tile and a painted tile asks for a layout, so a batch of them
// costs one layout and not one per pair.
let stageDirty = false;
export function stageLayoutSoon() {
  if (stageDirty) return;
  stageDirty = true;
  const run = () => {
    stageDirty = false;
    layoutStage();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

// setRouted turns the audio and the pictures of one pair on or off. It is the
// only place a remote stream reaches its output, so a guest out of the
// conversation has a silent gain and no picture.
export function setRouted(peerId: string, on: boolean) {
  if (routed.get(peerId) === on) return;
  routed.set(peerId, on);
  const peer = state.peers.get(peerId);
  presenceDebug('route ' + shortPeer(peerId) + ' ' + (on ? 'on' : 'off') + where(peer));
  if (!peer) return;
  applyGain(peer);
  paintPeerVideo(peer);
  stageLayoutSoon();
}

export function isRouted(peerId: string): boolean {
  return routed.get(peerId) === true;
}

// setTalks takes the one word a guest sends about whom it is talking to. Only
// ids that are in this room are kept, so the line never names a stranger.
export function setTalks(peerId: string, ids: unknown) {
  if (!state.peers.has(peerId)) return;
  const list = Array.isArray(ids)
    ? ids.filter((one) => typeof one === 'string' && state.peers.has(one))
    : [];
  const before = talks.get(peerId) || [];
  if (before.length === list.length && before.every((one, i) => one === list[i])) return;
  talks.set(peerId, list);
  presenceDebug(
    'talks ' +
      shortPeer(peerId) +
      ' says ' +
      (list.length ? list.map(shortPeer).join(',') : 'nobody'),
  );
  paintPresence();
}

// applyGain writes the one gain value of a pair: zero outside the conversation,
// the guest's own volume inside it.
export function applyGain(peer: any) {
  if (!peer) return;
  const on = isRouted(peer.id);
  const g = state.deaf || !on ? 0 : volGain(peer.vol);
  if (peer.gain) peer.gain.gain.value = g;
  if (peer.audioEl) peer.audioEl.volume = Math.min(g, 1);
}

// routeNow applies the present state of one pair after its audio was built: a
// track that arrives out of the conversation starts silent.
export function routeNow(peer: any) {
  applyGain(peer);
  if (!isRouted(peer.id)) paintPeerVideo(peer);
}

export function forgetRoute(peerId: string) {
  routed.delete(peerId);
  talks.delete(peerId);
}

// setGuestFlags takes the camera and microphone lamps of one guest from its own
// sealed flags, which the mesh delivers over the pair channel.
export function setGuestFlags(peerId: string, flags: { cam?: boolean; mic?: boolean }) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  const cam = flags.cam !== undefined ? flags.cam !== false : peer.camOn !== false;
  const mic = flags.mic !== undefined ? flags.mic !== false : peer.micOn !== false;
  const changed = cam !== peer.camOn || mic !== peer.micOn;
  peer.camOn = cam;
  peer.micOn = mic;
  if (peer.tile) applyFlags(peer.tile, mic, cam, false);
  if (changed) {
    paintPeerVideo(peer);
    paintPresence();
  }
}

// channelOf is the one word the presence line gives a guest about its media.
export function channelOf(peerId: string): string {
  const peer = state.peers.get(peerId);
  if (!peer) return '';
  if (peer.waiting) return 'not in this room';
  if (peer.camOn !== false) return 'camera on';
  return peer.micOn === false ? 'mic off' : 'voice';
}

// paintPresence draws the one line.
export function paintPresence() {
  const room = $('presence-room') as HTMLElement | null;
  const near = $('presence-near') as HTMLElement | null;
  const via = $('presence-via') as HTMLElement | null;
  if (!room || !near) return;
  const total = state.peers.size;
  room.textContent = total
    ? 'room: ' + total + ' other' + (total === 1 ? '' : 's')
    : 'room: you alone';
  const mine: string[] = [];
  const theirs: string[] = [];
  for (const id of [...routed.keys()].sort()) {
    if (!isRouted(id)) continue;
    const peer = state.peers.get(id);
    if (!peer) continue;
    const name = peerName(peer);
    mine.push(name + ' [' + channelOf(id) + ']');
    const list: string[] = [];
    for (const other of talks.get(id) || []) {
      if (other === state.self) continue;
      const one = state.peers.get(other);
      if (one) list.push(peerName(one));
    }
    if (list.length) theirs.push(name + ' with ' + list.join(', '));
  }
  near.textContent = mine.length
    ? 'hearing: ' + mine.join(' · ')
    : 'hearing: nobody, walk closer or into an area';
  // The line is cut with an ellipsis rather than wrapped, so the box never grows
  // and the column below it never moves. The whole sentence stays on the title.
  near.title = near.textContent;
  room.title = room.textContent;
  if (via) {
    via.textContent = theirs.length ? 'also: ' + theirs.join('; ') : '';
    via.title = via.textContent;
    via.hidden = !theirs.length;
  }
}
