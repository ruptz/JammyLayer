/* Now Playing overlay — client runtime.

   Responsibilities, in order of interest:
     - derive the accent colour from the album art (canvas, same-origin proxy)
     - drive the bloom layer, which is the same artwork scaled and blurred; the
       glass surface refracts it with backdrop-filter and bleed uses it as the
       card's background, so both get their colour from real light off the art
     - paint the tick ruler at a spacing set by the track's real duration
     - interpolate playback position between server polls so the playhead is
       smooth without the server hammering Spotify's API
*/

const stage = document.getElementById('stage');
const card = document.querySelector('.card');
const artEl = document.querySelector('.art');
const bloomEl = document.getElementById('bloom');
const artA = document.getElementById('artA');
const artB = document.getElementById('artB');
const titleClip = document.getElementById('titleClip');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const scaleEl = document.getElementById('scale');
const ticksEl = document.getElementById('ticks');
const ticksOnEl = document.getElementById('ticksOn');
const playedEl = document.getElementById('played');
const headEl = document.getElementById('head');
const elapsedEl = document.getElementById('elapsed');
const totalEl = document.getElementById('total');

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// ------------------------------------------------------------------- parameters

const search = new URLSearchParams(location.search);

const pick = (key, allowed, fallback) => {
  const value = (search.get(key) ?? '').toLowerCase();
  return allowed.includes(value) ? value : fallback;
};

const params = {
  layout: pick('layout', ['transport', 'strip', 'stack'], 'transport'),
  surface: pick('surface', ['glass', 'bare', 'bleed'], 'glass'),
  theme: pick('theme', ['ink', 'paper'], 'ink'),
  align: pick('align', ['left', 'right'], 'left'),
  idle: pick('idle', ['hide', 'show'], 'hide'),
  paused: pick('paused', ['dim', 'show', 'hide'], 'dim'),
  ticks: pick('ticks', ['on', 'off'], 'on'),
  art: pick('art', ['on', 'off'], 'on'),
  scale: clamp(Number.parseFloat(search.get('scale') ?? '1') || 1, 0.4, 4),
  width: Number.parseInt(search.get('width') ?? '', 10),
  accent: (search.get('accent') ?? 'auto').toLowerCase(),
};

Object.assign(document.body.dataset, {
  layout: params.layout,
  surface: params.surface,
  theme: params.theme,
  align: params.align,
  art: params.art,
  paused: 'false',
});

document.documentElement.style.setProperty('--scale', String(params.scale));
if (Number.isFinite(params.width)) {
  document.body.style.setProperty('--w', `${clamp(params.width, 160, 1600)}px`);
}

const fixedAccent = parseHex(params.accent);
if (fixedAccent) document.body.style.setProperty('--accent', fixedAccent.join(' '));

function parseHex(value) {
  const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

// ------------------------------------------------------------- colour from art

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, l];

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const flat = Math.round(l * 255);
    return [flat, flat, flat];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map((v) => Math.round(v * 255));
}

const HUE_BUCKETS = 24;

/**
 * Pick one colour that represents the artwork. Raw dominant colours are usually
 * muddy or too dark to read, so hue comes from the art but saturation and
 * lightness are pinned to a band that stays legible on the card.
 */
function accentFromArt(img, theme) {
  const size = 40;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);

  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // Tainted canvas: art was not served through our proxy.
  }

  const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ w: 0, x: 0, y: 0, s: 0 }));
  let counted = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (l < 0.12 || l > 0.93 || s < 0.18) continue; // near-black, blown out, or grey

    const weight = s * (1 - Math.abs(l - 0.5) * 0.8);
    const bucket = buckets[Math.min(HUE_BUCKETS - 1, Math.floor(h / (360 / HUE_BUCKETS)))];
    const radians = (h * Math.PI) / 180;
    bucket.w += weight;
    bucket.x += Math.cos(radians) * weight;
    bucket.y += Math.sin(radians) * weight;
    bucket.s += s * weight;
    counted += 1;
  }

  if (counted < 24) return null; // Monochrome sleeve — keep the theme fallback.

  // Score each bucket with its neighbours: one hue cluster often straddles a
  // bucket edge, which would otherwise split its weight and lose to noise.
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < HUE_BUCKETS; i += 1) {
    const score = buckets[i].w
      + buckets[(i + 1) % HUE_BUCKETS].w * 0.6
      + buckets[(i - 1 + HUE_BUCKETS) % HUE_BUCKETS].w * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return null;

  let x = 0;
  let y = 0;
  let weight = 0;
  let saturationSum = 0;
  for (const offset of [-1, 0, 1]) {
    const bucket = buckets[(best + offset + HUE_BUCKETS) % HUE_BUCKETS];
    x += bucket.x;
    y += bucket.y;
    weight += bucket.w;
    saturationSum += bucket.s;
  }
  if (weight <= 0) return null;

  const hue = (Math.atan2(y / weight, x / weight) * 180) / Math.PI;
  const saturation = clamp((saturationSum / weight) * 1.12, 0.5, 0.92);
  const lightness = theme === 'paper' ? 0.38 : 0.63;
  return hslToRgb(hue, saturation, lightness);
}

function applyAccent(img) {
  if (fixedAccent) return;
  const rgb = accentFromArt(img, params.theme);
  if (rgb) document.body.style.setProperty('--accent', rgb.join(' '));
  else document.body.style.removeProperty('--accent');
}

// ------------------------------------------------------------------- tick ruler

// Candidate spacings in seconds; the first one that leaves ticks readable wins.
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 300];
const MIN_TICK_GAP = 5.5;

function paintScale(durationMs) {
  const width = scaleEl.clientWidth;
  const height = scaleEl.clientHeight;
  if (!width) return;

  if (params.ticks === 'off' || !durationMs) {
    const rail = 'linear-gradient(currentColor, currentColor)';
    for (const el of [ticksEl, ticksOnEl]) {
      el.style.backgroundImage = rail;
      el.style.backgroundSize = '100% 2px';
      el.style.backgroundRepeat = 'repeat-x';
      el.style.backgroundPosition = '0 100%';
    }
    scaleEl.style.setProperty('--scale-w', `${width}px`);
    return;
  }

  const minorSeconds = TICK_STEPS.find(
    (step) => (width * step * 1000) / durationMs >= MIN_TICK_GAP,
  ) ?? TICK_STEPS[TICK_STEPS.length - 1];

  const minorGap = (width * minorSeconds * 1000) / durationMs;
  const majorGap = minorGap * 4;
  const minorHeight = Math.max(3, Math.round(height * 0.45));
  const majorHeight = Math.max(minorHeight + 2, Math.round(height * 0.85));

  const ruler = (gap) => `repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px ${gap}px)`;

  for (const el of [ticksEl, ticksOnEl]) {
    el.style.backgroundImage = `${ruler(minorGap)}, ${ruler(majorGap)}`;
    el.style.backgroundSize = `100% ${minorHeight}px, 100% ${majorHeight}px`;
    el.style.backgroundRepeat = 'repeat-x, repeat-x';
    el.style.backgroundPosition = '0 100%, 0 100%';
  }

  // The played layer sits in a clipping window, so its ruler needs the full
  // scale width to keep its ticks aligned with the unplayed ones behind it.
  scaleEl.style.setProperty('--scale-w', `${width}px`);
}

// -------------------------------------------------------------------- title fit

function fitTitle() {
  titleEl.classList.remove('is-marquee');
  titleClip.classList.remove('is-masked');
  titleEl.style.removeProperty('--shift');

  const overflow = titleEl.offsetWidth - titleClip.clientWidth;
  if (overflow <= 2) return;

  titleClip.classList.add('is-masked');
  if (reduceMotion.matches) return;

  titleEl.style.setProperty('--shift', `${-(overflow + 6)}px`);
  titleEl.style.setProperty('--marquee-dur', `${clamp(9 + overflow / 16, 9, 30).toFixed(1)}s`);
  titleEl.classList.add('is-marquee');
}

// ------------------------------------------------------------------------ clock

let state = null;
let clockSkew = 0; // local clock minus server clock
let clockTimer = null;
let lastSecond = -1;

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateProgress() {
  const item = state?.item;
  if (!item) return;

  // Between polls the position is extrapolated from the server's own clock, so
  // a slow LAN or a skewed client clock cannot drag the playhead off.
  const drift = state.playing ? Math.max(0, Date.now() - clockSkew - state.fetchedAt) : 0;
  const elapsed = Math.min(item.durationMs || 0, state.progressMs + drift);
  const ratio = item.durationMs ? clamp(elapsed / item.durationMs, 0, 1) : 0;

  const width = scaleEl.clientWidth;
  playedEl.style.width = `${ratio * width}px`;
  headEl.style.setProperty('--head', `${clamp(ratio * width, 0, Math.max(0, width - 2))}px`);

  const second = Math.floor(elapsed / 1000);
  if (second !== lastSecond) {
    lastSecond = second;
    elapsedEl.textContent = formatTime(elapsed);
  }
}

// The playhead crosses the ruler at roughly one pixel per second, so 250ms is
// already finer than the display can show — and it keeps CPU off the encoder.
function startClock() {
  updateProgress();
  if (!clockTimer) clockTimer = setInterval(updateProgress, 250);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
  updateProgress();
}

// ----------------------------------------------------------------------- render

let frontLayer = artA;

function setArt(url) {
  if (!url) {
    artEl.classList.add('is-empty');
    artA.classList.remove('is-front');
    artB.classList.remove('is-front');
    bloomEl.classList.remove('is-lit');
    return;
  }

  // Spotify art goes through our proxy so the canvas stays readable; the demo
  // sleeves are already local data URLs.
  const proxied = url.startsWith('data:') ? url : `/art?u=${encodeURIComponent(url)}`;
  const back = frontLayer === artA ? artB : artA;

  // Decode before swapping so the crossfade never shows an empty frame.
  const loader = new Image();
  loader.addEventListener('load', () => {
    back.src = proxied;
    artEl.classList.remove('is-empty');
    back.classList.add('is-front');
    frontLayer.classList.remove('is-front');
    frontLayer = back;

    // Same decoded image, so the bloom never lags a track behind the sleeve.
    bloomEl.style.backgroundImage = `url("${proxied}")`;
    bloomEl.classList.add('is-lit');

    applyAccent(loader);
  });
  loader.addEventListener('error', () => {
    artEl.classList.add('is-empty');
    bloomEl.classList.remove('is-lit');
  });
  loader.src = proxied;
}

function replayEnter() {
  card.classList.remove('is-enter');
  void card.offsetWidth; // force a reflow so the animation restarts
  card.classList.add('is-enter');
}

function renderTrack(item) {
  titleEl.textContent = item.title || 'Unknown track';
  subtitleEl.textContent = item.subtitle || item.context || '';
  totalEl.textContent = formatTime(item.durationMs || 0);
  lastSecond = -1;

  setArt(item.artUrl);
  paintScale(item.durationMs);
  fitTitle();
  replayEnter();
}

function renderEmpty() {
  titleEl.textContent = 'Nothing playing';
  subtitleEl.textContent = '';
  elapsedEl.textContent = '0:00';
  totalEl.textContent = '0:00';
  setArt(null);
  paintScale(0);
  playedEl.style.width = '0px';
  headEl.style.setProperty('--head', '0px');
  fitTitle();
}

let renderedId = null;

function apply(next) {
  clockSkew = Date.now() - next.serverTime;
  state = next;

  const item = next.item;
  document.body.dataset.paused = String(Boolean(item) && !next.playing);

  const hidden = !item || (!next.playing && params.paused === 'hide');
  if (hidden) {
    if (!item && params.idle === 'show') {
      if (renderedId !== null) renderEmpty();
      stage.dataset.state = 'empty';
    } else {
      stage.dataset.state = 'idle';
    }
    // Clearing this replays the entrance when the card comes back.
    renderedId = null;
    stopClock();
    return;
  }

  if (item.id !== renderedId) {
    renderedId = item.id;
    renderTrack(item);
  }

  stage.dataset.state = 'live';
  if (next.playing) startClock();
  else stopClock();
}

// ---------------------------------------------------------------------- transport

function listen() {
  if (!window.EventSource) {
    const poll = async () => {
      try {
        const res = await fetch('/api/now-playing', { cache: 'no-store' });
        if (res.ok) apply(await res.json());
      } catch {
        /* keep the last frame on screen and try again on the next tick */
      }
    };
    poll();
    setInterval(poll, 3000);
    return;
  }

  // EventSource reconnects on its own using the server's `retry` hint, which is
  // what keeps the overlay alive across container restarts mid-stream.
  const source = new EventSource('/events');
  source.addEventListener('message', (event) => {
    try {
      apply(JSON.parse(event.data));
    } catch {
      /* ignore a malformed frame rather than tearing down the stream */
    }
  });
}

// -------------------------------------------------------------------- demo mode

/* ?demo=1 drives the overlay from invented tracks instead of the server. The
   setup page uses it so the preview shows a card whether or not anything is
   playing, and it doubles as a way to check legibility over real footage. */

function demoSleeve(hueA, hueB) {
  const size = 300;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, `hsl(${hueA}, 74%, 48%)`);
  gradient.addColorStop(1, `hsl(${hueB}, 62%, 20%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
  for (let i = 0; i < 5; i += 1) ctx.fillRect(0, 168 + i * 24, size, 9);
  return canvas.toDataURL('image/png');
}

const DEMO_TRACKS = [
  {
    id: 'demo-1',
    title: 'Signal Path',
    subtitle: 'Nightshift Radio',
    context: 'Long Wave',
    durationMs: 224_000,
    offset: 71_000,
    hue: [196, 232],
  },
  {
    id: 'demo-2',
    title: 'A Title Long Enough To Show The Marquee Panning',
    subtitle: 'The Demo Orchestra',
    context: 'Preview Sessions',
    durationMs: 402_000,
    offset: 15_000,
    hue: [26, 348],
  },
];

function startDemo() {
  for (const track of DEMO_TRACKS) track.art = demoSleeve(track.hue[0], track.hue[1]);

  let index = 0;
  let started = Date.now();

  const push = () => {
    const track = DEMO_TRACKS[index];
    const now = Date.now();
    apply({
      playing: true,
      progressMs: (track.offset + (now - started)) % track.durationMs,
      device: 'Preview',
      item: {
        id: track.id,
        type: 'track',
        title: track.title,
        subtitle: track.subtitle,
        context: track.context,
        durationMs: track.durationMs,
        artUrl: track.art,
        explicit: false,
      },
      fetchedAt: now,
      serverTime: now,
      configured: true,
      connected: true,
      authError: null,
      error: null,
    });
  };

  push();
  setInterval(push, 1000);
  setInterval(() => {
    index = (index + 1) % DEMO_TRACKS.length;
    started = Date.now();
    push();
  }, 11_000);
}

let resizeFrame = null;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    paintScale(state?.item?.durationMs ?? 0);
    fitTitle();
    updateProgress();
  });
}).observe(scaleEl);

reduceMotion.addEventListener('change', fitTitle);

if (search.get('demo')) startDemo();
else listen();
