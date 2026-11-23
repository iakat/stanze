/*
 The relay badge and the sealed badge.
*/

import { state } from './state.js';

// ---------------------------------------------------------------- relay badge
// selectedPair is the candidate pair that carries the media. The standard way
// to find it is the transport report; the `selected` flag on the pair is a
// Firefox extra, so a lookup that relied on it never marked a Chrome guest.
export function selectedPair(stats) {
  let pair = null;
  stats.forEach((r) => {
    if (!pair && r.type === 'transport' && r.selectedCandidatePairId) {
      pair = stats.get(r.selectedCandidatePairId) || null;
    }
  });
  if (pair) return pair;
  stats.forEach((r) => {
    if (!pair && r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
  });
  return pair;
}

// paintRelay marks a tile when the link to that peer runs through the TURN
// relay. The selected pair is read once, when the link comes up; a reconnect
// runs this again.
export async function paintRelay(peer) {
  try {
    const stats = await peer.pc.getStats();
    const pair = selectedPair(stats);
    const local = pair ? stats.get(pair.localCandidateId) : null;
    const remote = pair ? stats.get(pair.remoteCandidateId) : null;
    const relayed = !!((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay'));
    if (peer.tile) peer.tile.dataset.relay = relayed ? 'yes' : 'no';
  } catch {
    /* stats are best effort */
  }
}
