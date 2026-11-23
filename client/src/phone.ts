/*
 The phone frame of the layout.
*/

import { $ } from './dom.js';
import { menuClose } from './menu.js';
import { setStatsOpen, statsOpen } from './stats.js';

// ---------------------------------------------------------------- phone frame
// A phone shows the call as a picture. The class folds the frame of the app
// away in the stylesheet, and a tap on the picture brings it back over it. The
// query is the one the stylesheet uses, so a desktop never gets the class and
// keeps its frame in place.
export const phoneQuery = window.matchMedia
  ? window.matchMedia('(max-width: 620px), (max-height: 520px) and (hover: none)')
  : null;

// applyImmersive turns the folded call view on or off for the window that is
// here now, and every window that comes after a rotation. It only ever folds a
// stage that is on screen, so the lobby stays a whole card.
export function applyImmersive() {
  const stage = $('stage');
  const on = !!phoneQuery && phoneQuery.matches && !stage.hidden;
  stage.classList.toggle('immersive', on);
  if (!on) stage.classList.remove('chrome');
  $('chrome-btn').setAttribute('aria-expanded', String(stage.classList.contains('chrome')));
}

// setChrome shows or folds the frame of the app. The menus and the stats sheet
// go with it when it folds, because their buttons leave with the frame and a
// sheet whose button is gone cannot be shut.
export function setChrome(show) {
  const stage = $('stage');
  if (!stage.classList.contains('immersive')) return;
  stage.classList.toggle('chrome', show);
  $('chrome-btn').setAttribute('aria-expanded', String(show));
  if (show) return;
  menuClose();
  if (statsOpen()) setStatsOpen(false);
}
