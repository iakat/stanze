/*
 The relay mark of a tile.
*/

// ---------------------------------------------------------------- relay badge
// markRelay reads the report once when the link comes up and marks the tile
// when either side of the chosen pair is a relay candidate. The stats round
// keeps the mark fresh after that. The `selected` flag is a Firefox extra.
export async function markRelay(peer) {
  try {
    const stats = await peer.pc.getStats();
    if (!peer.tile) return;
    let pair = null;
    stats.forEach((r) => {
      if (!pair && r.type === 'transport' && r.selectedCandidatePairId) {
        pair = stats.get(r.selectedCandidatePairId) || null;
      }
    });
    if (!pair)
      stats.forEach((r) => {
        if (
          !pair &&
          r.type === 'candidate-pair' &&
          (r.selected || (r.nominated && r.state === 'succeeded'))
        )
          pair = r;
      });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const relayed = !!(
      (local && local.candidateType === 'relay') ||
      (remote && remote.candidateType === 'relay')
    );
    peer.tile.dataset.relay = relayed ? 'yes' : 'no';
  } catch {
    /* stats are best effort */
  }
}
