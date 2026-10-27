/* JammyLayer — overlay control runtime.

   Four jobs:
     - turn the controls into an overlay URL, and mirror that URL into the
       monitor so the preview is the same page OBS will load
     - switch the monitor between your real Spotify playback and demo tracks,
       and light the tally when it is showing the real thing
     - report the true source size by measuring what the overlay actually
       rendered rather than guessing from the layout name
     - keep the section tabs true to the page: they follow what you are reading
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
  setState($('keysTag'), state.configured ? 'Saved' : 'Needed', state.configured ? 'ok' : 'todo');
  setState(
    $('accountTag'),
    state.authError ? 'Reconnect' : state.connected ? 'Connected' : 'Not connected',
    state.authError ? 'bad' : state.connected ? 'ok' : 'todo',
  );
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
    if (data.version) $('footnote').textContent = `JammyLayer ${data.version} · Runs on this PC`;

    prefsBtn.hidden = !data.canEditPreferences;
    showCloseMode(data.closeToTray);

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

// ──────────────────────────────────────────────────────────── song requests

/* The Twitch, Requests and Queue sections. Everything is saved the moment it
   changes, and the server pushes its whole state back over /requests/events
   after every change — its own or anyone else's — so the page draws only from
   that stream and never from a button's own answer. */

const twitchNote = $('twitchNote');
const twitchIdInput = $('twitchId');
const twitchSecretInput = $('twitchSecret');
const requestsNote = $('requestsNote');
const queueList = $('queue');
const queueEmpty = $('queueEmpty');
const clearQueue = $('clearQueue');
const pair = $('pair');

let requestState = null;
let editingApp = false;

function noteOn(el, message, ok) {
  el.hidden = !message;
  el.textContent = message ?? '';
  el.classList.toggle('note--ok', Boolean(ok));
  el.classList.toggle('note--bad', Boolean(message) && !ok);
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/** A button that posts, disabled while it does, with failures noted beside it. */
function wireAction(button, path, body, note) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    if (note) noteOn(note, '');
    try {
      await postJson(path, typeof body === 'function' ? body() : body);
    } catch (error) {
      if (note) noteOn(note, error.message || 'Could not reach the server.', false);
    } finally {
      button.disabled = false;
    }
  });
}

// ─── step 1: the Twitch app

$('saveTwitchBtn').addEventListener('click', async (event) => {
  const clientId = twitchIdInput.value.trim();
  const clientSecret = twitchSecretInput.value.trim();
  if (!clientId) return noteOn(twitchNote, 'Paste the client ID from your Twitch app.', false);
  event.target.disabled = true;
  try {
    await postJson('/api/twitch/credentials', { clientId, clientSecret });
    twitchSecretInput.value = '';
    noteOn(twitchNote, '');
    editingApp = false;
    if (requestState) renderRequests(requestState);
  } catch (error) {
    noteOn(twitchNote, error.message || 'Could not reach the server.', false);
  } finally {
    event.target.disabled = false;
  }
});

$('appEdit').addEventListener('click', () => {
  editingApp = true;
  if (requestState) renderRequests(requestState);
  twitchIdInput.focus();
});

$('appCancel').addEventListener('click', () => {
  editingApp = false;
  noteOn(twitchNote, '');
  if (requestState) renderRequests(requestState);
});

// ─── steps 2 and 3: the channel and the bot

const twitchAlert = $('twitchAlert');
wireAction($('channelConnect'), '/api/twitch/pair', { seat: 'channel' }, twitchAlert);
wireAction($('botConnect'), '/api/twitch/pair', { seat: 'bot' }, twitchAlert);
wireAction($('channelDisconnect'), '/api/twitch/disconnect', { seat: 'channel' }, twitchAlert);
wireAction($('botDisconnect'), '/api/twitch/disconnect', { seat: 'bot' }, twitchAlert);
wireAction($('pairCancel'), '/api/twitch/cancel', {}, twitchAlert);
wireCopy($('pairCopy'), $('pairUrl'));

// ─── requests: switches, limits, the reward

function saveRequestSetting(change) {
  postJson('/api/requests/settings', change)
    .then(() => noteOn(requestsNote, ''))
    .catch((error) => noteOn(requestsNote, error.message || 'Could not reach the server.', false));
}

for (const group of document.querySelectorAll('[data-request]')) {
  const key = group.dataset.request;
  for (const input of group.querySelectorAll('input')) {
    input.addEventListener('change', () => {
      const value = input.value === 'true' ? true : input.value === 'false' ? false : input.value;
      saveRequestSetting({ [key]: value });
    });
  }
}

for (const input of document.querySelectorAll('[data-number]')) {
  input.addEventListener('change', () => {
    const value = Number.parseInt(input.value, 10);
    if (Number.isFinite(value) && value >= 0) saveRequestSetting({ [input.dataset.number]: value });
  });
}

$('rewardTitle').addEventListener('change', (event) => {
  const title = event.target.value.trim();
  if (title) saveRequestSetting({ rewardTitle: title });
});

clearQueue.addEventListener('click', () => {
  // Two presses, not a confirm(): a dialog would block the app's webview.
  if (clearQueue.dataset.armed !== 'true') {
    clearQueue.dataset.armed = 'true';
    clearQueue.textContent = 'Press again to clear';
    setTimeout(() => {
      clearQueue.dataset.armed = 'false';
      clearQueue.textContent = 'Clear all';
    }, 3000);
    return;
  }
  clearQueue.dataset.armed = 'false';
  clearQueue.textContent = 'Clear all';
  postJson('/api/requests/clear').catch((error) => noteOn(requestsNote, error.message, false));
});

// ─── drawing

/** Radio groups and number boxes follow the server, except the one being typed in. */
function showRequestSettings(settings) {
  for (const group of document.querySelectorAll('[data-request]')) {
    const input = group.querySelector(`input[value="${String(settings[group.dataset.request])}"]`);
    if (input) input.checked = true;
  }
  for (const input of document.querySelectorAll('[data-number]')) {
    if (document.activeElement !== input) input.value = settings[input.dataset.number];
  }
  const title = $('rewardTitle');
  if (document.activeElement !== title) title.value = settings.rewardTitle;
}

/** One setup step: done, waiting on this one, or not reachable yet. */
function stepState(id, state) {
  $(id).dataset.state = state;
}

function renderTwitch(state) {
  const { twitch } = state;
  const { channel, bot, pairing } = twitch;

  // Step 1 folds to a summary once saved, until Change opens it again.
  const appOpen = !twitch.configured || editingApp;
  stepState('stepApp', twitch.configured ? 'done' : 'todo');
  $('appForm').hidden = !appOpen;
  $('appEdit').hidden = appOpen;
  $('appCancel').hidden = !twitch.configured;
  $('appSummary').textContent = twitch.configured
    ? `Client ID ${twitch.clientId.slice(0, 6)}… · ${twitch.hasSecret ? 'Confidential' : 'Public, no secret'}`
    : "Registered once, on Twitch's developer console";
  if (appOpen && document.activeElement !== twitchIdInput && !twitchIdInput.value) {
    twitchIdInput.value = twitch.clientId;
  }
  twitchSecretInput.placeholder = twitch.hasSecret ? 'saved — retype only to replace it' : '';

  const seat = (prefix, account, needs, idle) => {
    const waiting = pairing?.seat === prefix;
    stepState(
      prefix === 'channel' ? 'stepChannel' : 'stepBot',
      account.connected ? 'done' : waiting ? 'active' : needs ? 'todo' : 'blocked',
    );
    $(`${prefix}Connect`).hidden = account.connected || waiting;
    $(`${prefix}Connect`).disabled = !needs || Boolean(pairing);
    $(`${prefix}Disconnect`).hidden = !account.connected;
    $(`${prefix}Summary`).textContent = account.connected
      ? `Connected as ${account.login}`
      : waiting ? 'Waiting for the code to be entered…' : idle;
  };
  seat('channel', channel, twitch.configured, 'Reads chat and runs the channel points reward');
  seat(
    'bot',
    bot,
    channel.connected,
    channel.connected
      ? 'Replies come from you until a bot is connected'
      : 'Replies in chat come from a bot instead of you',
  );
  if (bot.connected) {
    $('botSummary').textContent = `Connected as ${bot.login} · make it a mod: /mod ${bot.login}`;
  }

  // The code panel sits in the step it belongs to.
  pair.hidden = !pairing;
  if (pairing) {
    const step = $(pairing.seat === 'bot' ? 'stepBot' : 'stepChannel');
    if (pair.parentElement !== step) step.append(pair);
    const url = pairing.verificationUri || 'https://www.twitch.tv/activate';
    $('pairCode').textContent = pairing.userCode;
    $('pairLink').href = url;
    $('pairUrl').value = url;
    $('pairHelp').textContent = pairing.seat === 'bot'
      ? 'Approve it signed in as the bot, not as you: copy the link into a private window and log in there. Only enter a code JammyLayer showed you.'
      : 'Approve it signed in as your channel. Only enter a code JammyLayer showed you.';
  }

  const done = channel.connected;
  if (!state.settings.enabled) setState($('twitchTag'), 'Off');
  else setState($('twitchTag'), done ? 'Connected' : pairing ? 'Waiting' : 'Not set up', done ? 'ok' : pairing ? 'warn' : 'todo');

  const problems = [channel.error, bot.error && `Bot: ${bot.error}`].filter(Boolean);
  twitchAlert.hidden = problems.length === 0;
  if (problems.length) twitchAlert.textContent = problems.join(' · ');
}

const LINK_LABEL = { off: 'Off', connecting: 'Connecting', live: 'Listening', down: 'Retrying' };

function renderRequestFacts(state) {
  const { settings, twitch } = state;
  const on = settings.chatEnabled || settings.pointsEnabled;

  setState(
    $('linkState'),
    !twitch.channel.connected ? 'Not connected' : LINK_LABEL[twitch.link] ?? twitch.link,
    !twitch.channel.connected || twitch.link === 'down' ? 'bad' : twitch.link === 'live' ? 'ok' : undefined,
  );
  setState(
    $('queueState'),
    !state.spotifyConnected ? 'Not connected' : state.canQueue === false ? 'Reconnect Spotify' : 'Ready',
    !state.spotifyConnected || state.canQueue === false ? 'bad' : 'ok',
  );
  setState(
    $('replyState'),
    !settings.chatReplies ? 'Off' : twitch.bot.connected ? twitch.bot.login : twitch.channel.login || '—',
  );

  const live = on && twitch.link === 'live';
  if (live && settings.paused) setState($('requestsTag'), 'Paused', 'warn');
  else setState($('requestsTag'), live ? 'Live' : on ? LINK_LABEL[twitch.link] : 'Off', live ? 'ok' : on ? 'warn' : undefined);
  $('rewardHelp').textContent = settings.pointsEnabled
    ? `"${settings.rewardTitle}" is on your channel for ${settings.rewardCost} points. Off hides it.`
    : 'Creates the reward the first time. Off hides it, so nobody spends points on a request that won’t play. Needs Affiliate or Partner.';

  const problems = [
    on && !twitch.channel.connected && 'Connect your channel in 06 · Requests for requests to arrive.',
    on && twitch.linkError,
    state.canQueue === false && 'Your Spotify sign-in predates song requests. Reconnect Spotify in 02 · Account so JammyLayer can queue songs.',
    state.pointsError,
    state.spotifyError && `Spotify: ${state.spotifyError}`,
  ].filter(Boolean);
  const alertBox = $('requestsAlert');
  alertBox.hidden = problems.length === 0;
  alertBox.textContent = problems.join(' · ');
}

function queueButton(label, text, onClick, disabled) {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.textContent = text;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function renderQueue(queue) {
  queueList.replaceChildren(
    ...queue.map((request, index) => {
      const item = document.createElement('li');
      item.className = 'queue__item';
      item.classList.toggle('is-handed', request.handedOff);

      const pos = document.createElement('span');
      pos.className = 'queue__pos';
      pos.textContent = String(index + 1);

      const art = document.createElement('img');
      art.className = 'queue__art';
      art.alt = '';
      art.decoding = 'async';
      if (request.artUrl) art.src = `/art?u=${encodeURIComponent(request.artUrl)}`;

      const meta = document.createElement('span');
      meta.className = 'queue__meta';
      const title = document.createElement('span');
      title.className = 'queue__title';
      title.textContent = request.title;
      const sub = document.createElement('span');
      sub.className = 'queue__sub';
      sub.textContent = `${request.artist} · ${formatTime(request.durationMs)}`;
      const by = document.createElement('span');
      by.className = 'queue__by';
      by.textContent = `${request.redemption ? 'Points' : 'Chat'} · ${request.userName}`;
      meta.append(title, sub, by);

      const prev = queue[index - 1];
      const next = queue[index + 1];
      const tools = document.createElement('span');
      tools.className = 'queue__tools';
      const move = (up) => () => postJson('/api/requests/move', { id: request.id, up }).catch(() => {});
      const remove = queueButton('Remove', '✕', () => {
        postJson('/api/requests/remove', { id: request.id }).catch((error) => noteOn(requestsNote, error.message, false));
      }, false);
      remove.classList.add('is-remove');
      tools.append(
        queueButton('Move up', '↑', move(true), !prev || prev.handedOff || request.handedOff),
        queueButton('Move down', '↓', move(false), !next || request.handedOff),
        remove,
      );

      item.append(pos, art, meta, tools);
      return item;
    }),
  );
  queueEmpty.hidden = queue.length > 0;
  clearQueue.hidden = queue.length === 0;
  $('queueCount').textContent = queue.length ? String(queue.length) : '';
}

const pauseButton = $('pauseRequests');

pauseButton.addEventListener('click', () => {
  const paused = pauseButton.getAttribute('aria-pressed') !== 'true';
  saveRequestSetting({ paused });
});

/** The toolbar button: only there while requests are on, and amber while paused. */
function showPause(settings) {
  pauseButton.hidden = !settings.enabled;
  pauseButton.setAttribute('aria-pressed', String(settings.paused));
  pauseButton.textContent = settings.paused ? 'Resume requests' : 'Pause requests';
  pauseButton.title = settings.paused
    ? 'Requests are paused: !sr is turned away and the reward can\u2019t be redeemed'
    : 'Stop taking new requests for now. The queue keeps playing.';
}

/** Off, song requests are one switch; everything else waits until they're on. */
function showRequestSections(enabled) {
  const changed = $('sec-queue').hidden === enabled;
  $('twitchSetup').hidden = !enabled;
  for (const id of ['sec-requests', 'sec-queue', 'railRules', 'railQueue']) $(id).hidden = !enabled;
  if (changed) markSection();
}

function renderRequests(state) {
  requestState = state;
  showRequestSettings(state.settings);
  showRequestSections(state.settings.enabled);
  showPause(state.settings);
  renderTwitch(state);
  renderRequestFacts(state);
  renderQueue(state.queue);
}

if (window.EventSource) {
  const requestSource = new EventSource('/requests/events');
  requestSource.addEventListener('message', (event) => {
    try {
      renderRequests(JSON.parse(event.data));
    } catch {
      /* ignore a malformed frame */
    }
  });
} else {
  const pollRequests = () => fetch('/api/requests').then((r) => r.json()).then(renderRequests).catch(() => {});
  pollRequests();
  setInterval(pollRequests, 4000);
}

// ─────────────────────────────────────────────────────────── outside links

/* In the app, a link that would open a new tab is handed to the system
   browser through Tauri's opener — the webview has no tabs of its own, and
   left to itself the click goes nowhere. In an ordinary browser, links behave
   as links. */
if (window.__TAURI__?.core) {
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[target="_blank"]');
    if (!link || event.defaultPrevented) return;
    event.preventDefault();
    window.__TAURI__.core
      .invoke('plugin:opener|open_url', { url: link.href })
      .catch((error) => console.warn('[jammylayer] could not open link', error));
  });
}

// ──────────────────────────────────────────────────────────── section tabs

const scroller = $('scroller');
const railLinks = [...document.querySelectorAll('.rail__list a')];
const railTargets = railLinks
  .map((link) => ({ link, section: document.querySelector(link.getAttribute('href')) }))
  .filter((pair) => pair.section);

/**
 * Whichever section has most recently crossed the reading line, so the tabs
 * say where you are rather than where you clicked. Hidden sections are
 * skipped, and the first visible one holds the mark until something scrolls
 * past. Reaching the bottom marks the last, which may never cross the line.
 */
function markSection() {
  const line = scroller.getBoundingClientRect().top + 120;
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
  let current = null;

  for (const pair of railTargets) {
    if (pair.section.hidden) continue;
    if (!current || atEnd || pair.section.getBoundingClientRect().top <= line) current = pair;
  }

  for (const pair of railTargets) {
    const on = pair === current;
    pair.link.setAttribute('aria-current', String(on));
    pair.section.classList.toggle('is-current', on);
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

scroller.addEventListener('scroll', scheduleSpy, { passive: true });
window.addEventListener('resize', scheduleSpy);

// ─────────────────────────────────────────────────────────── window controls

/* Inside the app the window has no system frame, so the title bar carries its
   buttons. Opened in an ordinary browser there's no window to control. */
if (window.__TAURI__?.window) {
  const win = window.__TAURI__.window.getCurrentWindow();
  $('windowControls').hidden = false;
  $('winMin').addEventListener('click', () => win.minimize());
  $('winMax').addEventListener('click', () => win.toggleMaximize());
  // The same close as any other: it hides to the tray when that's switched on.
  $('winClose').addEventListener('click', () => win.close());
}

markSection();
syncSwatch();
refresh();
