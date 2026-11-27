/*
 The one element lookup. The Elements interface mirrors the markup, so a listed
 id hands back the right DOM type and an unlisted one is a typo.
*/

export interface Elements {
  lobby: HTMLElement;
  'join-form': HTMLFormElement;
  name: HTMLInputElement;
  room: HTMLInputElement;
  'newid-btn': HTMLButtonElement;
  pass: HTMLInputElement;
  path: HTMLSelectElement;
  noise: HTMLInputElement;
  'enter-btn': HTMLButtonElement;
  'sealed-note': HTMLElement;
  'lobby-error': HTMLElement;
  stage: HTMLElement;
  'room-label': HTMLElement;
  'peer-count': HTMLElement;
  'copy-btn': HTMLButtonElement;
  grid: HTMLElement;
  'stage-main': HTMLElement;
  'stage-rail': HTMLElement;
  'self-pip': HTMLElement;
  'pin-count': HTMLElement;
  'stats-panel': HTMLElement;
  'stats-graph-box': HTMLElement;
  'stats-graph-down': HTMLCanvasElement;
  'stats-graph-rtt': HTMLCanvasElement;
  'stats-graph-loss': HTMLCanvasElement;
  'stats-note-down': HTMLElement;
  'stats-note-rtt': HTMLElement;
  'stats-note-loss': HTMLElement;
  'stats-sum': HTMLElement;
  'stats-body': HTMLElement;
  'chat-log': HTMLElement;
  'chat-form': HTMLFormElement;
  'chat-text': HTMLInputElement;
  'chat-note': HTMLElement;
  'mic-btn': HTMLButtonElement;
  'chat-panel': HTMLElement;
  'file-btn': HTMLButtonElement;
  'file-input': HTMLInputElement;
  'cam-btn': HTMLButtonElement;
  'deaf-btn': HTMLButtonElement;
  'hand-btn': HTMLButtonElement;
  'share-btn': HTMLButtonElement;
  'stats-btn': HTMLButtonElement;
  'stats-close': HTMLButtonElement;
  'sfx-btn': HTMLButtonElement;
  'sfx-panel': HTMLElement;
  'sfx-close': HTMLButtonElement;
  'sfx-grid': HTMLElement;
  'sfx-vol': HTMLInputElement;
  'sfx-stop': HTMLButtonElement;
  'leave-btn': HTMLButtonElement;
  'call-timer': HTMLElement;
  mirror: HTMLInputElement;
  pip: HTMLInputElement;
  'voice-tiles': HTMLInputElement;
  'chrome-btn': HTMLButtonElement;
  'menu-settings-btn': HTMLButtonElement;
  'menu-settings': HTMLElement;
  'menu-asr': HTMLElement;
  'menu-effects-btn': HTMLButtonElement;
  'menu-effects': HTMLElement;
  'noise-live': HTMLInputElement;
  'noise-engine': HTMLSelectElement;
  'noise-note-out': HTMLElement;
  'noise-note-in': HTMLElement;
  'stage-error': HTMLElement;
  'cam-select': HTMLSelectElement;
  'mic-select': HTMLSelectElement;
  'menu-devices-btn': HTMLButtonElement;
  'menu-devices': HTMLElement;
  'dev-mic-list': HTMLElement;
  'dev-cam-list': HTMLElement;
  'dev-camq-list': HTMLElement;
  'dev-scrq-list': HTMLElement;
  perf: HTMLInputElement;
  sounds: HTMLInputElement;
  'waiting-room': HTMLInputElement;
  'waiting-banner': HTMLElement;
  'perf-live': HTMLInputElement;
  'perf-text': HTMLElement;
  'perf-live-text': HTMLElement;
  'menu-asr-btn': HTMLButtonElement;
  'asr-on': HTMLInputElement;
  'asr-lang': HTMLSelectElement;
  'asr-note': HTMLElement;
  'look-filter': HTMLSelectElement;
  freeze: HTMLInputElement;
  'stats-bytes': HTMLInputElement;
  'cx-swap': HTMLInputElement;
}

export function $<K extends keyof Elements>(id: K): Elements[K];
export function $(id: string): HTMLElement;
export function $(id: string): HTMLElement {
  return document.getElementById(id);
}
