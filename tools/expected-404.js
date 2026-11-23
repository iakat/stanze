/* One console line is not a fault.
 *
 * The optional transcription engines ask once for their model list, and a
 * server that was started without the model directory answers 404. Chromium
 * logs every failed resource load as a console error, so a bare server writes
 * one of these to the console on every page. The answer is expected: the page
 * reads it as "this engine is not offered".
 *
 * Every other console error stays fatal in the suites that use this filter.
 */
'use strict';

const EXPECTED = ['/vosk/models', '/omni/models'];

function expectedMiss(msg) {
  let at = null;
  try {
    at = msg.location ? msg.location() : null;
  } catch (_err) {
    return false;
  }
  return !!(at && at.url && EXPECTED.some((path) => at.url.endsWith(path)));
}

module.exports = { expectedMiss };
