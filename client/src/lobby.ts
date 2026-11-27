/*
 The lobby window on a desktop.
*/

import { $ } from './dom.js';
import { load, store } from './prefs.js';
import { clamp } from './util.js';

// ------------------------------------------------------------- lobby window
// A desktop window: dragged by its title bar, kept inside the viewport and
// remembered. The arrow keys move it too, for a guest without a pointer. The
// call stage is maximised and has no drag.
const LOBBY_STEP = 16;

// lobbyPlace puts the window at x, y inside the viewport and returns the place.
function lobbyPlace(win, x, y) {
  const w = win.offsetWidth;
  const h = win.offsetHeight;
  // A window wider than the viewport still leaves its left edge at the rim and
  // its right edge reachable.
  const maxX = Math.max(0, document.documentElement.clientWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  const cx = clamp(Math.round(x), 0, maxX);
  const cy = clamp(Math.round(y), 0, maxY);
  win.classList.add('moved');
  win.style.left = `${cx}px`;
  win.style.top = `${cy}px`;
  return { x: cx, y: cy };
}

export function initLobbyWindow() {
  const win = $('lobby');
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
    // A mouse that left the bar during the drag leaves it out of the tab order.
    if (!bar.matches(':hover')) focusable(false);
  };
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);

  // The bar takes the focus from a pointer, and lets it go again, so a guest
  // who grabs the window can move it with the arrow keys. It is not a tab stop:
  // the tab order starts at the skip link and the form, never at the frame.
  const focusable = (on: boolean) => {
    if (on) {
      bar.tabIndex = 0;
      bar.setAttribute('aria-label', 'stanze window, move it with the arrow keys');
    } else {
      bar.removeAttribute('tabindex');
      bar.removeAttribute('aria-label');
    }
  };
  focusable(false);
  bar.addEventListener('pointerenter', () => focusable(true));
  bar.addEventListener('pointerleave', () => {
    if (!grab) focusable(false);
  });
  bar.addEventListener('keydown', (event: KeyboardEvent) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      event.key
    ];
    if (!d) return;
    event.preventDefault();
    const here = at();
    keep(lobbyPlace(win, here.x + d[0] * LOBBY_STEP, here.y + d[1] * LOBBY_STEP));
  });
  // A smaller viewport, or a rotation, pulls the window back in. On a phone the
  // window takes its own place again: a fixed left and top from a wide screen
  // has nothing to clamp against in a narrow one.
  const small = typeof matchMedia === 'function' ? matchMedia('(max-width: 700px)') : null;
  const fit = () => {
    if (win.hidden || !win.classList.contains('moved')) return;
    if (small && small.matches) {
      win.classList.remove('moved');
      win.style.left = '';
      win.style.top = '';
      keep(null);
      return;
    }
    const here = at();
    lobbyPlace(win, here.x, here.y);
  };
  if (small) small.addEventListener('change', fit);
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
}
