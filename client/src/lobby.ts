/*
 The lobby window on a desktop.
*/

import { load, store } from './prefs.js';

// ------------------------------------------------------------- lobby window
// A desktop window: dragged by its title bar, kept inside the viewport and
// remembered. The arrow keys move it too, for a guest without a pointer. The
// call stage is maximised and has no drag.
const LOBBY_STEP = 16;

// lobbyPlace puts the window at x, y inside the viewport and returns the place.
function lobbyPlace(win, x, y) {
  const w = win.offsetWidth;
  const h = win.offsetHeight;
  const maxX = Math.max(0, document.documentElement.clientWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  const cx = Math.min(Math.max(0, Math.round(x)), maxX);
  const cy = Math.min(Math.max(0, Math.round(y)), maxY);
  win.classList.add('moved');
  win.style.left = `${cx}px`;
  win.style.top = `${cy}px`;
  return { x: cx, y: cy };
}

export function initLobbyWindow() {
  const win = document.getElementById('lobby');
  const bar = win && (win.querySelector('.titlebar') as HTMLElement | null);
  // No title bar means no drag, as on a skin that hides it.
  if (!win || !bar || getComputedStyle(bar).display === 'none') return;

  const keep = (pos) => store('lobbypos', JSON.stringify(pos));
  const at = () => {
    const r = win.getBoundingClientRect();
    return { x: r.left, y: r.top };
  };

  // The kept place, if a valid one is stored.
  try {
    const kept = JSON.parse(load('lobbypos') || 'null');
    if (kept && Number.isFinite(kept.x) && Number.isFinite(kept.y)) lobbyPlace(win, kept.x, kept.y);
  } catch {
    /* no kept place */
  }

  let grab = null;
  bar.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const here = at();
    grab = { id: event.pointerId, dx: event.clientX - here.x, dy: event.clientY - here.y };
    // A fixed window from the first grab, at the place it has now.
    lobbyPlace(win, here.x, here.y);
    win.classList.add('dragging');
    bar.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  bar.addEventListener('pointermove', (event: PointerEvent) => {
    if (!grab || event.pointerId !== grab.id) return;
    lobbyPlace(win, event.clientX - grab.dx, event.clientY - grab.dy);
  });
  const drop = (event: PointerEvent) => {
    if (!grab || event.pointerId !== grab.id) return;
    grab = null;
    win.classList.remove('dragging');
    keep(at());
  };
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);

  bar.tabIndex = 0;
  bar.setAttribute('aria-label', 'stanze window, move it with the arrow keys');
  bar.addEventListener('keydown', (event: KeyboardEvent) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      event.key
    ];
    if (!d) return;
    event.preventDefault();
    const here = at();
    keep(lobbyPlace(win, here.x + d[0] * LOBBY_STEP, here.y + d[1] * LOBBY_STEP));
  });

  // A smaller viewport pulls the window back in.
  window.addEventListener('resize', () => {
    if (!win.classList.contains('moved') || win.hidden) return;
    const here = at();
    lobbyPlace(win, here.x, here.y);
  });
}
