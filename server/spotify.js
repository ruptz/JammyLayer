import { randomBytes } from 'node:crypto';
import { SCOPES, config, configured } from './config.js';
import * as store from './store.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

/** @type {{access_token?: string, refresh_token?: string, expires_at?: number}|null} */
let tokens = null;
let refreshing = null;
let authError = null;

let state = {
  playing: false,
  item: null,
  progressMs: 0,
  device: null,
  fetchedAt: 0,
  error: null,
};

const subscribers = new Set();
let timer = null;
let failures = 0;

export async function init() {
  const saved = await store.load();
  if (saved?.refresh_token) {
    tokens = { refresh_token: saved.refresh_token };
  } else if (config.seedRefreshToken) {
    tokens = { refresh_token: config.seedRefreshToken };
    await store.save({ refresh_token: config.seedRefreshToken, source: 'env', obtained_at: new Date().toISOString() });
  }
}

export const connected = () => Boolean(tokens?.refresh_token);

export function snapshot() {
  return {
    ...state,
    configured: configured(),
    connected: connected(),
    authError,
    serverTime: Date.now(),
  };
}

// ---------------------------------------------------------------- authorization

const pendingStates = new Map();

export function authorizeUrl() {
  const value = randomBytes(16).toString('hex');
  const now = Date.now();
  for (const [key, expires] of pendingStates) if (expires < now) pendingStates.delete(key);
  pendingStates.set(value, now + 10 * 60_000);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: SCOPES,
    redirect_uri: config.redirectUri,
    state: value,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

export function consumeState(value) {
  const expires = pendingStates.get(value);
  if (!expires) return false;
  pendingStates.delete(value);
  return expires >= Date.now();
}

function basicAuth() {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });

  const text = await res.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    /* Spotify returned something that isn't JSON; fall through to the status-based message. */
  }

  if (!res.ok) {
    const error = new Error(payload.error_description || payload.error || `token request failed (${res.status})`);
    error.status = res.status;
    error.code = payload.error;
    throw error;
  }
  return payload;
}

export async function exchangeCode(code) {
  const granted = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  tokens = {
    access_token: granted.access_token,
    refresh_token: granted.refresh_token,
    expires_at: Date.now() + granted.expires_in * 1000,
  };
  authError = null;
  failures = 0;
  await store.save({ refresh_token: tokens.refresh_token, obtained_at: new Date().toISOString() });
  await refetch();
}

export async function disconnect() {
  tokens = null;
  authError = null;
  await store.clear();
  state = { ...state, playing: false, item: null, progressMs: 0, error: null };
  emit();
}

async function performRefresh() {
  try {
    const granted = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });

    tokens.access_token = granted.access_token;
    tokens.expires_at = Date.now() + granted.expires_in * 1000;

    // Spotify may hand back a rotated refresh token. Persist it or the next
    // restart authenticates with a token Spotify has already retired.
    if (granted.refresh_token && granted.refresh_token !== tokens.refresh_token) {
      tokens.refresh_token = granted.refresh_token;
      await store.save({ refresh_token: tokens.refresh_token, obtained_at: new Date().toISOString() });
    }

    authError = null;
    return tokens.access_token;
  } catch (error) {
    if (error.code === 'invalid_grant') {
      tokens = null;
      authError = 'Spotify rejected the saved authorization. Connect the account again.';
      await store.clear();
    }
    throw error;
  }
}

async function accessToken() {
  if (!configured()) throw new Error('Spotify client credentials are not set');
  if (!tokens?.refresh_token) throw new Error('No Spotify account connected');
  if (tokens.access_token && tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;

  if (!refreshing) {
    const attempt = performRefresh();
    refreshing = attempt;
    attempt.catch(() => {}).finally(() => {
      if (refreshing === attempt) refreshing = null;
    });
  }
  return refreshing;
}

// ------------------------------------------------------------------- now playing

function pickImage(images) {
  if (!images?.length) return null;
  // Around 300px keeps the art crisp at overlay sizes without pulling a 640px JPEG every track.
  const byCloseness = [...images].sort(
    (a, b) => Math.abs((a.width || 0) - 300) - Math.abs((b.width || 0) - 300),
  );
  return byCloseness[0]?.url ?? null;
}

function normalize(body) {
  const item = body?.item;
  if (!item) {
    return { playing: Boolean(body?.is_playing), item: null, progressMs: 0, device: body?.device?.name ?? null };
  }

  const isEpisode = item.type === 'episode';
  const images = (isEpisode ? item.images ?? item.show?.images : item.album?.images) ?? [];

  return {
    playing: Boolean(body.is_playing),
    progressMs: body.progress_ms ?? 0,
    device: body.device?.name ?? null,
    item: {
      id: item.id || item.uri || item.name,
      type: item.type,
      title: item.name ?? '',
      subtitle: isEpisode
        ? item.show?.name ?? ''
        : (item.artists ?? []).map((artist) => artist.name).join(', '),
      context: (isEpisode ? item.show?.publisher : item.album?.name) ?? '',
      durationMs: item.duration_ms ?? 0,
      artUrl: pickImage(images),
      explicit: Boolean(item.explicit),
    },
  };
}

async function fetchNowPlaying() {
  const url = `${API}/me/player/currently-playing?additional_types=track,episode`;
  let token = await accessToken();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 401) {
    // Token was revoked or expired early. Force one refresh, then retry once.
    if (tokens) tokens.access_token = null;
    token = await accessToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }

  if (res.status === 429) {
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '5', 10);
    const error = new Error('Spotify rate limit reached');
    error.retryAfterMs = (Number.isFinite(retryAfter) ? retryAfter + 1 : 6) * 1000;
    throw error;
  }

  // 204 means the account is connected but nothing is loaded in any player.
  if (res.status === 204) return { playing: false, item: null, progressMs: 0, device: null };

  if (!res.ok) {
    const error = new Error(`Spotify API returned ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return normalize(await res.json());
}

// ----------------------------------------------------------------------- polling

function emit() {
  const payload = snapshot();
  for (const subscriber of subscribers) {
    try {
      subscriber(payload);
    } catch {
      /* A broken client stream must not stop the others from updating. */
    }
  }
}

function schedule(delay) {
  clearTimeout(timer);
  if (subscribers.size === 0) {
    timer = null;
    return;
  }
  timer = setTimeout(tick, delay);
  timer.unref?.();
}

async function tick() {
  if (!configured() || !connected()) {
    state = { ...state, playing: false, item: null, progressMs: 0, error: null };
    emit();
    schedule(config.pollIdleMs);
    return;
  }

  try {
    const next = await fetchNowPlaying();
    state = { ...next, fetchedAt: Date.now(), error: null };
    failures = 0;
    emit();
    schedule(state.playing ? config.pollPlayingMs : config.pollIdleMs);
  } catch (error) {
    // Keep the last known track on screen rather than blanking the overlay mid-stream.
    state = { ...state, error: error.message || String(error) };
    emit();
    const backoff = error.retryAfterMs ?? Math.min(30_000, config.pollPlayingMs * 2 ** failures++);
    schedule(backoff);
  }
}

/** Refresh on demand, used by the JSON endpoint when no overlay is streaming. */
export async function refetch() {
  const stale = Date.now() - state.fetchedAt > Math.min(2000, config.pollPlayingMs);
  if (!stale) return snapshot();
  await tick();
  return snapshot();
}

/**
 * Polling only runs while something is watching, so an offline stream costs no
 * API quota. The first subscriber triggers an immediate fetch.
 */
export function subscribe(listener) {
  subscribers.add(listener);
  listener(snapshot());
  if (subscribers.size === 1) {
    clearTimeout(timer);
    tick();
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
