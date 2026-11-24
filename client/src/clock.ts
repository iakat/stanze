/*
 The call clock.
*/

import { $ } from './dom.js';
import { state } from './state.js';

// ---------------------------------------------------------------- call clock
// clockText renders a duration as h:mm:ss.
function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// startCallClock counts from the moment the call UI appears.
export function startCallClock() {
  stopCallClock();
  state.callStart = Date.now();
  $('call-timer').textContent = clockText(0);
  state.callTimer = setInterval(() => {
    if (!state.callStart) return;
    $('call-timer').textContent = clockText(Date.now() - state.callStart);
  }, 1000);
}

// stopCallClock ends the count and clears the field.
export function stopCallClock() {
  if (state.callTimer) clearInterval(state.callTimer);
  state.callTimer = null;
  state.callStart = 0;
  const el = $('call-timer');
  if (el) el.textContent = '';
}
