/* One console line is not a fault.
 *
 * The optional transcription engines ask once for their model list, and a
 * server that was started without the model directory answers 404. Chromium
 * logs every failed resource load as a console error, so a bare server writes
 * one of these to the console on every page. The answer is expected: the page
 * reads it as "this engine is not offered".
 *
 * A .wam world names its map inside the world, and that map may be absent: the
 * world is read in its place, and the one 404 is the world's own gap.
 *
 * Every other console error stays fatal in the suites that use this filter.
 */
'use strict';

const EXPECTED = ['/vosk/models', '/omni/models'];

// The zone sidecar is the authored zone list beside a map, and a map may be
// authored without one: the object layer of the map then carries the zones.
const ZONES = /\/world\/maps\/[^/]+\.zones\.json$/;

function expectedMiss(msg) {
  let at = null;
  try {
    at = msg.location ? msg.location() : null;
  } catch (_err) {
    return false;
  }
  if (!at || !at.url) return false;
  if (EXPECTED.some((path) => at.url.endsWith(path))) return true;
  if (ZONES.test(at.url.split('?')[0])) return true;
  // No wildcard over /world/maps/: a script or worker error that happens to be
  // located under a map URL is a real fault, and it used to be swallowed.
  return false;
}

module.exports = { expectedMiss };
