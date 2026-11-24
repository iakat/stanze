/*
 What a browser keeps between loads: name, room, devices, volume,
 quality, camera look.
*/

// ---------------------------------------------------------------- preferences
// Small strings under a rooms. prefix: name, room, devices, path, denoise, and
// each peer's volume under its key fingerprint. A storage that throws keeps nothing.
export function store(key, value) {
  if (!window.localStorage) return;
  try {
    localStorage.setItem('rooms.' + key, String(value));
  } catch {
    /* private mode */
  }
}

export function load(key) {
  if (!window.localStorage) return '';
  try {
    return localStorage.getItem('rooms.' + key) || '';
  } catch {
    return '';
  }
}
