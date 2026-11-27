/*
 The cue board: a panel of one shot notification cues, played by hand and
 nothing else. Every cue goes through playSfx, so it shares the cache, the gain
 and the sound switch with the rest of the page.
*/

import { $ } from './dom.js';
import { ensureSfx, playSfx, stopSfx } from './sfx.js';

// The order is the order of the buttons and of the number keys.
const CUES = [
  { name: 'joined', label: 'joined' },
  { name: 'left', label: 'left' },
  { name: 'knock', label: 'knock' },
  { name: 'raisehand', label: 'raise hand' },
  { name: 'msg', label: 'message' },
  { name: 'unmuted', label: 'mic on' },
  { name: 'muted', label: 'mic off' },
  { name: 'lost', label: 'lost' },
];

// How loud a cue is against the page's own cues; the slider moves this.
let rate = 0.8;

export function boardOpen() {
  return !$('sfx-panel').hidden;
}

export function setBoardOpen(open: boolean) {
  $('sfx-panel').hidden = !open;
  $('sfx-btn').setAttribute('aria-pressed', String(open));
  if (open) ensureSfx();
}

function play(i: number) {
  if (i < 0 || i >= CUES.length) return;
  playSfx(CUES[i].name, rate);
}

// wireBoard builds the buttons, the volume and the stop, and gives the panel
// its number keys. Nothing here starts on its own.
export function wireBoard() {
  const grid = $('sfx-grid');
  CUES.forEach((cue, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sfx-cue';
    button.textContent = cue.label;
    button.title = 'play this cue (key ' + (i + 1) + ')';
    button.setAttribute('aria-label', 'play the ' + cue.label + ' cue');
    button.addEventListener('click', () => play(i));
    grid.appendChild(button);
  });

  $('sfx-btn').addEventListener('click', () => setBoardOpen(!boardOpen()));
  $('sfx-close').addEventListener('click', () => setBoardOpen(false));
  $('sfx-stop').addEventListener('click', () => stopSfx());

  const volume = $('sfx-vol') as HTMLInputElement;
  rate = Number(volume.value) / 100;
  volume.addEventListener('input', () => {
    rate = Number(volume.value) / 100;
  });

  document.addEventListener('keydown', (event) => {
    if (!boardOpen()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {
      setBoardOpen(false);
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      return;
    }
    if (!/^[1-9]$/.test(event.key)) return;
    const i = Number(event.key) - 1;
    if (i >= CUES.length) return;
    event.preventDefault();
    play(i);
  });
}
