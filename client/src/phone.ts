/*
 The phone frame of the layout.
*/

import { $ } from './dom.js';
import { menuClose } from './menu.js';
import { setStatsOpen, statsOpen } from './stats.js';

// ---------------------------------------------------------------- phone frame
// A phone shows the call as a picture: the class folds the app frame away in
// the stylesheet and a tap brings it back. The query is the stylesheet's own,
// so a desktop never gets the class.
export const phoneQuery = window.matchMedia
  ? window.matchMedia('(max-width: 620px), (max-height: 520px) and (hover: none)')
  : null;

// applyImmersive folds the call view for this window and for every window after
// a rotation. Only a stage on screen is folded, so the lobby stays a whole card.
export function applyImmersive() {
  const stage = $('stage');
  const on = !!phoneQuery && phoneQuery.matches && !stage.hidden;
  stage.classList.toggle('immersive', on);
  if (!on) stage.classList.remove('chrome');
  $('chrome-btn').setAttribute('aria-expanded', String(stage.classList.contains('chrome')));
}

// setChrome shows or folds the app frame. Menus and the stats sheet close with
// it, because their buttons leave and a sheet without its button cannot be shut.
export function setChrome(show) {
  const stage = $('stage');
  if (!stage.classList.contains('immersive')) return;
  stage.classList.toggle('chrome', show);
  $('chrome-btn').setAttribute('aria-expanded', String(show));
  if (show) return;
  menuClose();
  if (statsOpen()) setStatsOpen(false);
}
