/* A jitsi-shaped link keeps the room in the path, and the client reads the
 * fragment. This runs before the client boots and hands the room over in the
 * form the client expects, so a page opened at /jit/Name joins Name. */
(function () {
  'use strict';
  if (location.hash) return;
  var m = /^\/jit\/([^/?#]+)/.exec(location.pathname);
  if (!m) return;
  var raw = m[1];
  try { raw = decodeURIComponent(raw); } catch (e) { /* keep the raw text */ }
  var room = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  if (!room) return;
  try {
    history.replaceState(null, '', '/jit/' + encodeURIComponent(room) + '#r=' + encodeURIComponent(room));
  } catch (e) { /* a browser that refuses the rewrite still joins from the hash below */ }
})();
