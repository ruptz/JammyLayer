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

const preview = document.getElementById('preview');
const viewport = document.getElementById('viewport');
const overlayUrl = document.getElementById('overlayUrl');
const sourceSize = document.getElementById('sourceSize');
const scaleInput = document.getElementById('scale');
const scaleOut = document.getElementById('scaleOut');
const widthInput = document.getElementById('width');
const accentInput = document.getElementById('accent');
const copyBtn = document.getElementById('copyBtn');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const alertBox = document.getElementById('alert');
const statusPill = document.getElementById('statusPill');

function currentSettings() {
  const settings = {};
  for (const name of ['layout', 'surface', 'theme', 'align', 'ticks', 'paused', 'idle', 'art']) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    settings[name] = checked ? checked.value : DEFAULTS[name];
  }
  settings.scale = String(Number.parseFloat(scaleInput.value));
  settings.width = widthInput.value.trim();
  settings.accent = accentInput.value.trim() || 'auto';
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

let previewSrc = '';
let refreshTimer = null;

function refresh() {
  const settings = currentSettings();
  const query = buildQuery(settings);

  scaleOut.textContent = `${Number.parseFloat(settings.scale).toFixed(2)}×`;
  overlayUrl.value = `${location.origin}/${query.toString() ? `?${query}` : ''}`;

  const demo = new URLSearchParams(query);
  demo.set('demo', '1');
  // The preview must always render a card, so idle/paused hiding is neutralised.
  demo.set('idle', 'show');
  demo.set('paused', 'show');
  const nextSrc = `/?${demo}`;

  if (nextSrc !== previewSrc) {
    previewSrc = nextSrc;
    preview.src = nextSrc;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 180);
}

/**
 * Read the real rendered stage instead of guessing from the layout name — it
 * accounts for scale, width overrides and hidden artwork automatically.
 *
 * Measuring .stage rather than .card matters now that each surface sets its own
 * padding: glass needs room for the bloom to spill past the panel, bare needs
 * almost none. `zoom` is already baked into getBoundingClientRect, so the rect
 * is the true OBS source size with nothing left to recompute.
 */
function measure() {
  const stage = preview.contentDocument?.getElementById('stage');
  if (!stage) return;

  const rect = stage.getBoundingClientRect();
  if (!rect.width) return;

  sourceSize.textContent = `${Math.ceil(rect.width)} × ${Math.ceil(rect.height)}`;
}

preview.addEventListener('load', () => {
  requestAnimationFrame(measure);
  setTimeout(measure, 400);
});

for (const input of document.querySelectorAll('.segments input[name]')) {
  if (input.name === 'backdrop') continue;
  input.addEventListener('change', refresh);
}

for (const input of document.querySelectorAll('#backdrop input')) {
  input.addEventListener('change', () => {
    viewport.dataset.backdrop = input.value;
  });
}

scaleInput.addEventListener('input', () => {
  scaleOut.textContent = `${Number.parseFloat(scaleInput.value).toFixed(2)}×`;
  scheduleRefresh();
});
widthInput.addEventListener('input', scheduleRefresh);
accentInput.addEventListener('input', scheduleRefresh);

copyBtn.addEventListener('click', async () => {
  const done = () => {
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
  };
  try {
    await navigator.clipboard.writeText(overlayUrl.value);
    done();
  } catch {
    // Clipboard access needs a secure context; selecting the text is the fallback.
    overlayUrl.select();
    copyBtn.textContent = 'Press Ctrl+C';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2200);
  }
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  try {
    await fetch('/api/disconnect', { method: 'POST' });
  } finally {
    disconnectBtn.disabled = false;
  }
});

// -------------------------------------------------------------------- status

function set(id, text, tone) {
  const el = document.getElementById(id);
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function renderStatus(state) {
  set('credState', state.configured ? 'Set' : 'Missing', state.configured ? 'ok' : 'bad');
  set('authState', state.connected ? 'Connected' : 'Not connected', state.connected ? 'ok' : 'bad');
  set('deviceState', state.device || '—');

  if (state.item) {
    set('trackState', `${state.item.title} — ${state.item.subtitle}`);
  } else {
    set('trackState', state.connected ? 'Nothing playing' : '—');
  }

  connectBtn.hidden = state.connected;
  connectBtn.textContent = state.connected ? 'Reconnect Spotify' : 'Connect Spotify';
  disconnectBtn.hidden = !state.connected;

  const problem = state.authError || state.error;
  alertBox.hidden = !problem;
  if (problem) alertBox.textContent = problem;

  if (!state.configured) {
    statusPill.textContent = 'Not configured';
    statusPill.dataset.tone = 'bad';
  } else if (!state.connected) {
    statusPill.textContent = 'Connect account';
    statusPill.dataset.tone = 'bad';
  } else if (state.item && state.playing) {
    statusPill.textContent = 'Playing';
    statusPill.dataset.tone = 'ok';
  } else {
    statusPill.textContent = state.item ? 'Paused' : 'Idle';
    statusPill.dataset.tone = 'ok';
  }
}

fetch('/api/config')
  .then((res) => res.json())
  .then((data) => { document.getElementById('redirectUri').textContent = data.redirectUri; })
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

refresh();
