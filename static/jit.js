/* A jitsi-shaped front over the same client. This file loads after app.js and
 * only decorates: the socket, the sealed room and the media all stay in app.js.
 * Everything here is paint, chrome and four short cues. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  document.body.classList.add('jit');

  // ---------------------------------------------------------------- the way in

  // The pickers that the original keeps behind a gear move into the settings
  // sheet. The name and the room stay on the card, because a guest types those
  // two to join.
  function buildLobby() {
    const form = $('join-form');
    if (!form) return;
    const keep = new Set([$('name').closest('label'), $('room').closest('label')]);
    const adv = document.createElement('details');
    adv.className = 'jit-adv';
    const summary = document.createElement('summary');
    summary.textContent = 'Settings';
    adv.appendChild(summary);
    for (const child of Array.from(form.children)) {
      if (keep.has(child)) continue;
      if (child.contains($('enter-btn')) && !child.contains($('room'))) {
        $('room').closest('.with-button').appendChild($('enter-btn'));
        child.remove();
        continue;
      }
      adv.appendChild(child);
    }
    // The notes that belong to the settings go with them; the one line about
    // the sealed room stays on the card, since it is not a setting.
    form.appendChild(adv);
  }

  // A room name from a jitsi link may hold spaces and capitals. The client
  // accepts a-z 0-9 . _ - only, so the field is tidied in place, on the way out
  // of the field and never under the fingers of the person typing.
  function tidyRoomField() {
    const field = $('room');
    if (!field) return;
    const clean = () => {
      const tidy = field.value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
      if (tidy !== field.value) field.value = tidy;
    };
    field.addEventListener('blur', clean);
    $('join-form').addEventListener('submit', clean, true);
  }

  // ---------------------------------------------------------------- the cues

  let audio = null;
  function ctx() {
    if (!audio) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { audio = new C(); } catch { return null; }
    }
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    return audio;
  }

  function note(freq, after, dur, gain, type) {
    const a = ctx();
    if (!a) return;
    const t0 = a.currentTime + after;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  const cueJoin = () => { note(659.25, 0, 0.5, 0.10); note(987.77, 0.09, 0.6, 0.075, 'triangle'); };
  const cueLeave = () => { note(587.33, 0, 0.32, 0.09); note(440, 0.07, 0.42, 0.07); };
  const cueChat = () => { note(1046.5, 0, 0.09, 0.05); };

  // ---------------------------------------------------------------- the chrome

  function ctrlButton(id, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'ctrl';
    b.dataset.label = label;
    b.setAttribute('aria-pressed', 'false');
    return b;
  }

  // The labels of the three buttons the client repaints follow the state that
  // the client already publishes on aria-pressed.
  const LABELS = {
    'mic-btn': ['Mute', 'Unmute'],
    'cam-btn': ['Stop camera', 'Start camera'],
    'share-btn': ['Stop sharing', 'Share screen'],
  };

  function syncLabel(button) {
    const pair = LABELS[button.id];
    if (!pair) return;
    button.dataset.label = button.getAttribute('aria-pressed') === 'true' ? pair[0] : pair[1];
  }

  let sidePanel = '';

  function setSide(next) {
    sidePanel = sidePanel === next ? '' : next;
    document.body.classList.toggle('jit-chat', sidePanel === 'chat');
    document.body.classList.toggle('jit-people', sidePanel === 'people');
    const chat = $('chat-btn');
    const people = $('people-btn');
    if (chat) chat.setAttribute('aria-pressed', String(sidePanel === 'chat'));
    if (people) people.setAttribute('aria-pressed', String(sidePanel === 'people'));
  }

  function buildToolbar() {
    const bar = document.querySelector('.controls');
    if (!bar || $('chat-btn')) return;
    const chat = ctrlButton('chat-btn', 'Chat');
    const people = ctrlButton('people-btn', 'People');
    const settings = ctrlButton('settings-btn', 'Settings');
    const share = $('share-btn');
    share.insertAdjacentElement('afterend', chat);
    chat.insertAdjacentElement('afterend', people);
    people.insertAdjacentElement('afterend', $('stats-btn'));
    $('leave-btn').insertAdjacentElement('beforebegin', settings);

    for (const id of ['stats-btn', 'leave-btn']) {
      const b = $(id);
      if (b) b.dataset.label = id === 'stats-btn' ? 'Stats' : 'Hang up';
    }
    for (const id of Object.keys(LABELS)) {
      const b = $(id);
      if (!b) continue;
      syncLabel(b);
      new MutationObserver(() => syncLabel(b)).observe(b, { attributes: true, attributeFilter: ['aria-pressed'] });
    }

    chat.addEventListener('click', () => setSide('chat'));
    people.addEventListener('click', () => setSide('people'));
    settings.addEventListener('click', () => document.body.classList.toggle('jit-settings'));
  }

  function buildSettings() {
    if ($('jit-settings')) return;
    const panel = document.createElement('div');
    panel.id = 'jit-settings';
    const sheet = document.createElement('div');
    sheet.className = 'jit-sheet';
    const head = document.createElement('div');
    head.className = 'jit-sheet-head';
    head.innerHTML = '<span>Settings</span>';
    const close = document.createElement('button');
    close.type = 'button';
    close.id = 'jit-settings-close';
    close.setAttribute('aria-label', 'close the settings');
    close.textContent = '\u00d7';
    head.appendChild(close);
    sheet.appendChild(head);
    panel.appendChild(sheet);
    document.body.appendChild(panel);
    for (const pick of Array.from(document.querySelectorAll('.controls .pick'))) sheet.appendChild(pick);
    close.addEventListener('click', () => document.body.classList.remove('jit-settings'));
    panel.addEventListener('click', (event) => {
      if (event.target === panel) document.body.classList.remove('jit-settings');
    });
  }

  // ---------------------------------------------------------------- the notices

  const toast = $('jit-toast');
  let toastTimer = 0;
  function showToast(text, ms) {
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms || 5000);
  }

  function tileName(tile) {
    const name = tile.querySelector('.name');
    return name ? name.textContent.trim() : 'Somebody';
  }

  // ---------------------------------------------------------------- the meeting

  function onStageShown() {
    setSide('');
    document.body.classList.remove('jit-settings');
    showToast('You are the only one in the meeting');
    cueJoin();
  }

  function watchStage() {
    const stage = $('stage');
    if (!stage) return;
    let shown = !stage.hidden;
    new MutationObserver(() => {
      const now = !stage.hidden;
      if (now === shown) return;
      shown = now;
      if (now) onStageShown();
      else {
        setSide('');
        document.body.classList.remove('jit-settings');
        if (toast) toast.hidden = true;
      }
    }).observe(stage, { attributes: true, attributeFilter: ['hidden'] });
  }

  // A tile that appears is a participant that joined, and one that goes is a
  // participant that left; the room's own preview never makes a sound.
  function watchTiles() {
    const main = $('stage-main');
    if (!main) return;
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.classList.contains('tile') || node.dataset.local) continue;
          cueJoin();
          showToast(tileName(node) + ' joined the meeting');
        }
        for (const node of rec.removedNodes) {
          if (!(node instanceof HTMLElement) || !node.classList.contains('tile') || node.dataset.local) continue;
          cueLeave();
        }
      }
    }).observe(main, { childList: true });
  }

  function watchChat() {
    const log = $('chat-log');
    if (!log) return;
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (!(node instanceof HTMLElement) || node.tagName !== 'LI') continue;
          const who = node.querySelector('.who');
          const mine = $('name') ? $('name').value.trim() : '';
          if (who && mine && who.textContent.trim() === mine) continue;
          cueChat();
        }
      }
    }).observe(log, { childList: true });
  }

  function watchTitle() {
    const label = $('room-label');
    if (!label) return;
    const paint = () => {
      const room = label.textContent.trim();
      document.title = room ? room + ' - Jitsi Meet' : 'Jitsi Meet';
    };
    paint();
    new MutationObserver(paint).observe(label, { childList: true, characterData: true, subtree: true });
  }

  // ---------------------------------------------------------------- the link

  // The share button of the original copies a fragment link. A meeting link
  // here has to look like a room in the path, so this listener is added after
  // the client's own and writes the path form over it.
  function shareLink() {
    const button = $('copy-btn');
    if (!button) return;
    const room = () => {
      const label = $('room-label') ? $('room-label').textContent.trim() : '';
      if (label) return label;
      const m = /(?:^|[#&])r=([^&]+)/.exec(location.hash);
      return m ? decodeURIComponent(m[1]) : '';
    };
    button.addEventListener('click', async () => {
      const id = room();
      if (!id) return;
      const link = location.origin + '/jit/' + encodeURIComponent(id);
      try {
        await navigator.clipboard.writeText(link);
        showToast('Meeting link copied');
      } catch {
        window.prompt('Copy this link', link);
      }
    });
  }

  // The join click is the gesture that unlocks the audio context, so it is
  // taken here before the room asks for the microphone.
  function unlockAudio() {
    const button = $('enter-btn');
    if (button) button.addEventListener('click', () => { ctx(); });
    const form = $('join-form');
    if (form) form.addEventListener('submit', () => { ctx(); });
  }

  buildLobby();
  tidyRoomField();
  buildToolbar();
  buildSettings();
  unlockAudio();
  watchStage();
  watchTiles();
  watchChat();
  watchTitle();
  shareLink();
})();
