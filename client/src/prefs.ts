/*
 What a browser keeps between loads: name, room, devices, volume,
 quality, camera look.
*/

// ---------------------------------------------------------------- preferences
// The browser keeps a few small strings: the name, the room, the last
// microphone and camera choice, the media path, denoise, and the volume of
// each peer by name. An unreadable storage (private mode) simply keeps nothing.
export function store(key, value) {
  if (!window.localStorage) return;
  try { localStorage.setItem('rooms.' + key, String(value)); } catch { /* private mode */ }
}

export function load(key) {
  if (!window.localStorage) return '';
  try { return localStorage.getItem('rooms.' + key) || ''; } catch { return ''; }
}
