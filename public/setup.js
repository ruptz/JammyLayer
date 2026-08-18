/* JammyLayer — overlay control runtime.

   Four jobs:
     - turn the controls into an overlay URL, and mirror that URL into the
       monitor so the preview is the same page OBS will load
     - switch the monitor between your real Spotify playback and demo tracks,
       and light the tally when it is showing the real thing
     - report the true source size by measuring what the overlay actually
       rendered rather than guessing from the layout name
     - keep the masthead and the index true to the page: the word is measured
       to its column, and the index follows what you are reading
*/

const DEFAULTS = {
  layout: 'transport',
  surface: 'glass',
  theme: 'ink',
  align: 'left',
  ticks: 'on',
  paused: 'dim',
  idle: 'hide',
  art: 'on',
  scale: '1',
  width: '',
  accent: 'auto',
};

const PARAMS = ['layout', 'surface', 'theme', 'align', 'ticks', 'paused', 'idle', 'art'];

const SURFACE_LABEL = { glass: 'Glass', bare: 'Bare', bleed: 'Art bleed' };

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const preview = $('preview');
const viewport = $('viewport');
const overlayUrl = $('overlayUrl');
const openOverlay = $('openOverlay');
const sourceSize = $('sourceSize');
const statSize = $('statSize');
const statSurface = $('statSurface');
const statScale = $('statScale');
const stepSize = $('stepSize');
const scaleInput = $('scale');
const scaleOut = $('scaleOut');
const widthInput = $('width');
const accentInput = $('accent');
const accentPick = $('accentPick');
const swatchLabel = $('swatchLabel');
const tally = $('tally');
const tallyText = $('tallyText');
const tallyTrack = $('tallyTrack');
const lamp = $('lamp');
const lampText = $('lampText');
const account = $('sec-account');
const accountFoot = $('accountFoot');
const heroConnect = $('heroConnect');
const heroCopy = $('heroCopy');
const disconnectBtn = $('disconnectBtn');
const alertBox = $('alert');
const resetBtn = $('resetBtn');

// ──────────────────────────────────────────────────────────── settings → URL

function currentSettings() {
  const settings = {};
  for (const name of PARAMS) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    settings[name] = checked ? checked.value : DEFAULTS[name];
  }
  settings.scale = String(Number.parseFloat(scaleInput.value) || 1);
  settings.width = widthInput.value.trim();
  settings.accent = accentInput.value.trim().toLowerCase() || 'auto';
  return settings;
}

/** Only non-default values go into the URL, so the string stays readable. */
function buildQuery(settings) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(settings)) {
    if (value && value !== DEFAULTS[key]) query.set(key, value);
  }
  return query;
}

// ────────────────────────────────────────────────────────────── the monitor

/* The monitor runs the same page OBS will, so it needs a card on screen at all
   times — `idle` and `paused` hiding are neutralised in the preview only, and
   the Behaviour card says so. What changes between the two feeds is where the
   playback comes from: `demo=1` invents tracks, and without it the overlay
   opens its own /events stream and shows what you are really playing. */

let feedChoice = null; // 'live' | 'demo' once the user picks; null means follow Spotify
let liveReady = false; // a real track is loaded on Spotify right now
let dropTimer = null;
let previewSrc = '';
let refreshTimer = null;

const feedInputs = Object.fromEntries(
  [...document.querySelectorAll('#feed input')].map((input) => [input.value, input]),
);

const liveLabel = feedInputs.live.closest('label');

const activeFeed = () => (feedChoice === 'demo' || !liveReady ? 'demo' : 'live');

/**
 * Spotify returns 204 for a moment between tracks, and a paused track that gets
 * resumed shouldn't bounce the monitor through demo mode on the way. Coming up
 * is instant; dropping out waits.
 */
function setLiveReady(ready) {
  if (ready) {
    clearTimeout(dropTimer);
    dropTimer = null;
    if (liveReady) return;
    liveReady = true;
    refresh();
  } else if (liveReady && !dropTimer) {
    dropTimer = setTimeout(() => {
      dropTimer = null;
      liveReady = false;
      refresh();
    }, 5000);
  }
}

function refresh() {
  const settings = currentSettings();
  const query = buildQuery(settings);
  const suffix = query.toString() ? `?${query}` : '';

  scaleOut.textContent = `${Number.parseFloat(settings.scale).toFixed(2)}×`;
  statScale.textContent = scaleOut.textContent;
  statSurface.textContent = SURFACE_LABEL[settings.surface] ?? settings.surface;
  overlayUrl.value = `${location.origin}/${suffix}`;
  openOverlay.href = `/${suffix}`;

  const feed = activeFeed();
  const monitor = new URLSearchParams(query);
  monitor.set('idle', 'show');
  monitor.set('paused', 'show');
  if (feed === 'demo') monitor.set('demo', '1');

  feedInputs.live.disabled = !liveReady;
  liveLabel.title = liveReady
    ? 'Show what you are playing on Spotify'
    : 'Nothing is playing on Spotify right now';
  feedInputs[feed].checked = true;
  tally.dataset.live = String(feed === 'live');
  tallyText.textContent = feed === 'live' ? 'Live' : 'Demo';
  updateTallyTrack();

  const nextSrc = `/?${monitor}`;
  if (nextSrc !== previewSrc) {
    previewSrc = nextSrc;
    viewport.classList.remove('is-ready');
    resetFrame();
    preview.src = nextSrc;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 180);
}

/* The frame the overlay is given to lay out in. Oversized, so the measurement
   never depends on how far the monitor happens to be scaled — and reset to this
   on every reload, because a big card may have grown it (see below). */
const FRAME_W = 1600;
const FRAME_H = 1000;

function resetFrame() {
  preview.style.width = `${FRAME_W}px`;
  preview.style.height = `${FRAME_H}px`;
}

resetFrame();

/**
 * Measure the rendered card, report its true size, then scale and place the
 * frame so the card sits in the middle of the screen.
 *
 * Measuring .stage rather than .card matters because each surface sets its own
 * padding — glass leaves room for the bloom to spill past the panel, bare needs
 * almost none — and that padding is part of what OBS has to capture. `zoom` is
 * already baked into getBoundingClientRect, so the rect is the source size with
 * nothing left to recompute. The frame's own scaling is a transform applied
 * from the outside, which the rect inside is unaffected by.
 */
function fitAndMeasure(attempt = 0) {
  const stage = preview.contentDocument?.getElementById('stage');
  if (!stage) return;

  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  // .stage is a flex item, so a card wider than the frame gets shrunk to fit it
  // and would report a size OBS is never going to use. Filling the frame is the
  // tell; grow it and measure again. A 1200px card at 2.5× needs one doubling.
  if (attempt < 2 && (rect.width >= preview.clientWidth - 1 || rect.height >= preview.clientHeight - 1)) {
    preview.style.width = `${preview.clientWidth * 2}px`;
    preview.style.height = `${preview.clientHeight * 2}px`;
    requestAnimationFrame(() => fitAndMeasure(attempt + 1));
    return;
  }

  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const size = `${width} × ${height}`;

  sourceSize.textContent = size;
  statSize.textContent = size;
  stepSize.textContent = size;

  const room = 34;
  const screenW = viewport.clientWidth;
  const screenH = viewport.clientHeight;
  const fit = clamp(Math.min((screenW - room) / width, (screenH - room) / height), 0.15, 1);

  // The card is anchored inside the frame — left by default, right when the
  // anchor says so — so centring it means offsetting the frame by wherever the
  // card actually landed, scaled.
  viewport.style.setProperty('--fit', fit.toFixed(4));
  preview.style.left = `${Math.round((screenW - width * fit) / 2 - rect.left * fit)}px`;
  preview.style.top = `${Math.round((screenH - height * fit) / 2 - rect.top * fit)}px`;
  viewport.classList.add('is-ready');
}

/* Changing a setting reloads the frame, so several loads can be in flight while
   someone drags the size slider. Each one stamps a generation and its own
   passes check it before writing, otherwise a timer left over from the previous
   card reports that card's size against the current one. */
let loadGen = 0;

preview.addEventListener('load', () => {
  const gen = (loadGen += 1);
  // The first artwork decode lands after the load event, and the demo sleeves
  // are painted on a canvas at startup, so measure again once it has settled.
  const pass = () => { if (gen === loadGen) fitAndMeasure(); };
  requestAnimationFrame(pass);
  setTimeout(pass, 160);
  setTimeout(pass, 500);
});

window.addEventListener('resize', () => {
  clearTimeout(fitAndMeasure.timer);
  fitAndMeasure.timer = setTimeout(() => fitAndMeasure(), 140);
});

// ────────────────────────────────────────────────────────────────── controls

for (const input of document.querySelectorAll('.opts input[name], .seg input[name]')) {
  if (input.name === 'backdrop' || input.name === 'feed' || input.name === 'closeMode') continue;
  input.addEventListener('change', refresh);
}

for (const input of document.querySelectorAll('#backdrop input')) {
  input.addEventListener('change', () => {
    viewport.dataset.backdrop = input.value;
  });
}

for (const [value, input] of Object.entries(feedInputs)) {
  input.addEventListener('change', () => {
    feedChoice = value;
    refresh();
  });
}

scaleInput.addEventListener('input', () => {
  const shown = `${Number.parseFloat(scaleInput.value).toFixed(2)}×`;
  scaleOut.textContent = shown;
  statScale.textContent = shown;
  scheduleRefresh();
});

widthInput.addEventListener('input', scheduleRefresh);

const HEX = /^#?([\da-f]{3}|[\da-f]{6})$/i;

function syncSwatch() {
  const match = HEX.exec(accentInput.value.trim());
  if (!match) {
    swatchLabel.style.removeProperty('--swatch');
    return;
  }
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  swatchLabel.style.setProperty('--swatch', `#${hex}`);
  accentPick.value = `#${hex.toLowerCase()}`;
}

accentInput.addEventListener('input', () => {
  syncSwatch();
  scheduleRefresh();
});

accentPick.addEventListener('input', () => {
  accentInput.value = accentPick.value;
  syncSwatch();
  scheduleRefresh();
});

resetBtn.addEventListener('click', () => {
  for (const name of PARAMS) {
    const input = document.querySelector(`input[name="${name}"][value="${DEFAULTS[name]}"]`);
    if (input) input.checked = true;
  }
  scaleInput.value = DEFAULTS.scale;
  widthInput.value = DEFAULTS.width;
  accentInput.value = DEFAULTS.accent;
  syncSwatch();
  refresh();
});

// ──────────────────────────────────────────────────────────────────── copying

function wireCopy(button, field, label = button.textContent) {
  button.addEventListener('click', async () => {
    const restore = (text, delay) => {
      button.textContent = text;
      setTimeout(() => { button.textContent = label; }, delay);
    };
    try {
      await navigator.clipboard.writeText(field.value);
      restore('Copied', 1500);
    } catch {
      // Clipboard access needs a secure context; selecting the text is the fallback.
      field.select();
      restore('Press Ctrl+C', 2400);
    }
  });
}

wireCopy($('copyBtn'), overlayUrl);
wireCopy(heroCopy, overlayUrl);

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  try {
    await fetch('/api/disconnect', { method: 'POST' });
  } finally {
    disconnectBtn.disabled = false;
  }
});

// ────────────────────────────────────────────────────────────────────── status

const sleeve = $('nowSleeve');
const nowArt = $('nowArt');
const nowTitle = $('nowTitle');
const nowSub = $('nowSub');
const nowFill = $('nowFill');
const nowTime = $('nowTime');
const credState = $('credState');
const authState = $('authState');
const deviceState = $('deviceState');

let status = null;
let clockSkew = 0;
let shownTrack = null;

function setState(el, text, tone) {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Interpolated between polls off the server's clock, the way the overlay does. */
function tickProgress() {
  const item = status?.item;
  if (!item?.durationMs) {
    nowFill.style.width = '0%';
    nowTime.textContent = '';
    return;
  }
  const drift = status.playing ? Math.max(0, Date.now() - clockSkew - status.fetchedAt) : 0;
  const elapsed = Math.min(item.durationMs, status.progressMs + drift);
  nowFill.style.width = `${clamp((elapsed / item.durationMs) * 100, 0, 100)}%`;
  nowTime.textContent = `${formatTime(elapsed)} / ${formatTime(item.durationMs)}`;
}

setInterval(tickProgress, 500);

function updateTallyTrack() {
  if (activeFeed() !== 'live') {
    tallyTrack.textContent = 'Preview tracks';
    return;
  }
  const item = status?.item;
  if (!item) {
    tallyTrack.textContent = 'Your Spotify playback';
    return;
  }
  const by = item.subtitle || item.context;
  tallyTrack.textContent = by ? `${item.title} — ${by}` : item.title;
}

function renderStatus(state) {
  status = state;
  clockSkew = Date.now() - state.serverTime;

  const item = state.item;
  setLiveReady(Boolean(state.connected && item));

  setState(credState, state.configured ? 'Set' : 'Missing', state.configured ? 'ok' : 'bad');
  setState(authState, state.connected ? 'Connected' : 'Not connected', state.connected ? 'ok' : 'bad');
  setState(deviceState, state.device || '—');

  if (item) {
    nowTitle.textContent = item.title || 'Unknown track';
    nowSub.textContent = item.subtitle || item.context || '';
    if (item.id !== shownTrack) {
      shownTrack = item.id;
      sleeve.classList.remove('is-on');
      if (item.artUrl) nowArt.src = `/art?u=${encodeURIComponent(item.artUrl)}`;
      else nowArt.removeAttribute('src');
    }
  } else {
    shownTrack = null;
    sleeve.classList.remove('is-on');
    nowArt.removeAttribute('src');
    if (!state.configured) {
      nowTitle.textContent = 'No client keys';
      nowSub.textContent = 'Add a client ID and secret to get started';
    } else if (!state.connected) {
      nowTitle.textContent = 'Not connected';
      nowSub.textContent = 'Authorize JammyLayer to read your playback';
    } else {
      nowTitle.textContent = 'Nothing playing';
      nowSub.textContent = 'Start something in Spotify and it lands here';
    }
  }

  tickProgress();
  updateTallyTrack();

  // One primary action in the hero, and it follows the state: connect while
  // there is nothing to copy, copy once there is.
  const linked = state.connected && !state.authError;
  heroConnect.hidden = linked;
  heroConnect.textContent = state.connected ? 'Reconnect Spotify' : 'Connect Spotify';
  heroCopy.hidden = !linked;
  accountFoot.hidden = !state.connected;

  const problem = state.authError || state.error;
  alertBox.hidden = !problem;
  if (problem) alertBox.textContent = problem;

  if (!state.configured) {
    account.dataset.state = 'unconfigured';
    lamp.dataset.tone = 'bad';
    lampText.textContent = 'No keys';
  } else if (!state.connected) {
    account.dataset.state = 'disconnected';
    lamp.dataset.tone = 'bad';
    lampText.textContent = 'Not linked';
  } else if (item && state.playing) {
    account.dataset.state = 'live';
    lamp.dataset.tone = 'ok';
    lampText.textContent = 'Playing';
  } else if (item) {
    account.dataset.state = 'paused';
    lamp.dataset.tone = 'warn';
    lampText.textContent = 'Paused';
  } else {
    account.dataset.state = 'idle';
    lamp.dataset.tone = '';
    lampText.textContent = 'Idle';
  }
}

nowArt.addEventListener('load', () => sleeve.classList.add('is-on'));
nowArt.addEventListener('error', () => sleeve.classList.remove('is-on'));

// ─────────────────────────────────────────────────────────────── credentials

const credsPanel = $('sec-keys');
const clientIdInput = $('clientId');
const clientSecretInput = $('clientSecret');
const saveCredsBtn = $('saveCredsBtn');
const credsNote = $('credsNote');

function noteCreds(message, ok) {
  credsNote.hidden = !message;
  credsNote.textContent = message ?? '';
  credsNote.classList.toggle('note--ok', Boolean(ok));
  credsNote.classList.toggle('note--bad', Boolean(message) && !ok);
}

saveCredsBtn.addEventListener('click', async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();

  if (!clientId || !clientSecret) {
    return noteCreds('Enter both the client ID and the client secret.', false);
  }

  saveCredsBtn.disabled = true;
  noteCreds('', false);

  try {
    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      noteCreds(data.error || `Could not save credentials (${res.status}).`, false);
    } else {
      // The secret is never read back, so clearing it makes that obvious rather
      // than leaving a box that looks like it still holds the real value.
      clientSecretInput.value = '';
      noteCreds('Saved. Connect your Spotify account next.', true);
    }
  } catch (error) {
    noteCreds(error.message || 'Could not reach the server.', false);
  } finally {
    saveCredsBtn.disabled = false;
  }
});

// ───────────────────────────────────────────────────────────── app settings

/* Desktop build only — this is about the app window, and a container has none.
   The tray menu carries the same switch, so the page re-reads the value when it
   regains focus rather than trusting that it was the last thing to set it. */

const prefsBtn = $('prefsBtn');
const prefsDialog = $('prefs');
const prefsNote = $('prefsNote');

function showCloseMode(closeToTray) {
  const input = document.querySelector(
    `input[name="closeMode"][value="${closeToTray ? 'tray' : 'quit'}"]`,
  );
  if (input) input.checked = true;
}

function notePrefs(message, ok) {
  prefsNote.hidden = !message;
  prefsNote.textContent = message ?? '';
  prefsNote.classList.toggle('note--ok', Boolean(ok));
  prefsNote.classList.toggle('note--bad', Boolean(message) && !ok);
}

function syncPreferences() {
  return fetch('/api/config')
    .then((res) => res.json())
    .then((data) => {
      prefsBtn.hidden = !data.canEditPreferences;
      showCloseMode(data.closeToTray);
    })
    .catch(() => {});
}

prefsBtn.addEventListener('click', () => {
  notePrefs('', false);
  prefsDialog.showModal();
});

// A modal dialog is the click target for its own backdrop, which is the only
// way to offer click-outside-to-close without a wrapper element.
prefsDialog.addEventListener('click', (event) => {
  if (event.target === prefsDialog) prefsDialog.close();
});

for (const input of document.querySelectorAll('input[name="closeMode"]')) {
  input.addEventListener('change', async () => {
    const closeToTray = input.value === 'tray';
    try {
      const res = await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closeToTray }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not save (${res.status}).`);

      notePrefs(
        closeToTray
          ? 'Closing the window leaves JammyLayer running in the tray.'
          : 'Closing the window quits JammyLayer and stops the overlay.',
        true,
      );
    } catch (error) {
      notePrefs(error.message || 'Could not reach the server.', false);
      // Put the switch back to whatever the server still has.
      syncPreferences();
    }
  });
}

window.addEventListener('focus', syncPreferences);

fetch('/api/config')
  .then((res) => res.json())
  .then((data) => {
    $('redirectUri').textContent = data.redirectUri;

    prefsBtn.hidden = !data.canEditPreferences;
    showCloseMode(data.closeToTray);

    // The container build leaves this hidden: it takes credentials from .env.
    if (!data.canEditCredentials) return;
    credsPanel.hidden = false;
    $('railKeys').hidden = false;
    markSection();
    $('redirectUriHint').value = data.redirectUri;
    wireCopy($('copyRedirectBtn'), $('redirectUriHint'));
    if (data.clientId) clientIdInput.value = data.clientId;
    if (data.configured) {
      $('secretHelp').textContent = 'Already set — retype only to replace it.';
    }
  })
  .catch(() => {});

if (window.EventSource) {
  const source = new EventSource('/events');
  source.addEventListener('message', (event) => {
    try {
      renderStatus(JSON.parse(event.data));
    } catch {
      /* ignore a malformed frame */
    }
  });
} else {
  const poll = () => fetch('/api/now-playing').then((r) => r.json()).then(renderStatus).catch(() => {});
  poll();
  setInterval(poll, 4000);
}

// ────────────────────────────────────────────────────────── masthead + index

const wordmark = $('wordmark');

/**
 * The word is set to the exact width of the column it sits in, which is the one
 * thing on the page that has to be measured rather than declared: Archivo and
 * the Helvetica it falls back to are different widths, so a size hard-coded for
 * either would leave a gap under one of them.
 *
 * Measured at a known size against max-content — the element is a block, so its
 * own width would otherwise just report the column back.
 */
function fitWordmark() {
  const room = wordmark.parentElement.clientWidth;
  if (!room) return;

  wordmark.style.fontSize = '100px';
  wordmark.style.width = 'max-content';
  const width = wordmark.offsetWidth;
  wordmark.style.width = '';

  if (width) wordmark.style.fontSize = `${Math.max(30, (room / width) * 100).toFixed(2)}px`;
}

const railLinks = [...document.querySelectorAll('.rail__list a')];
const railTargets = railLinks
  .map((link) => ({ link, section: document.querySelector(link.getAttribute('href')) }))
  .filter((pair) => pair.section);

/**
 * Whichever section has most recently crossed the reading line, so the index
 * says where you are rather than where you clicked. Hidden sections — the keys
 * panel on a hosted deployment — are skipped, and the first visible one holds
 * the mark until something scrolls past.
 */
function markSection() {
  const line = 150;
  let current = null;

  for (const pair of railTargets) {
    if (pair.section.hidden) continue;
    if (!current || pair.section.getBoundingClientRect().top <= line) current = pair;
  }

  for (const pair of railTargets) {
    pair.link.setAttribute('aria-current', String(pair === current));
  }
}

let spyPending = false;

function scheduleSpy() {
  if (spyPending) return;
  spyPending = true;
  requestAnimationFrame(() => {
    spyPending = false;
    markSection();
  });
}

window.addEventListener('scroll', scheduleSpy, { passive: true });

window.addEventListener('resize', () => {
  fitWordmark();
  scheduleSpy();
});

// The fallback face is a different width, so the fit has to be taken again once
// the real one has arrived.
document.fonts?.ready.then(fitWordmark).catch(() => {});

fitWordmark();
markSection();
syncSwatch();
refresh();
