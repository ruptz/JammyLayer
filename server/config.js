const int = (value, fallback = 0) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const str = (value, fallback = '') => (value ?? fallback).trim();

const bool = (value) => ['1', 'true', 'yes', 'on'].includes(str(value).toLowerCase());

const DEFAULTS = {
  port: 8888,
  host: '0.0.0.0',
  clientId: '',
  clientSecret: '',
  seedRefreshToken: '',
  // Relative default so `npm run dev` on a Windows box writes into the repo's
  // own ./data instead of trying to create C:\data. The Dockerfile and compose
  // file both set DATA_DIR=/data explicitly for the container's named volume,
  // and the desktop build points it at Electron's per-user directory.
  dataDir: './data',
  pollPlayingMs: 3000,
  pollIdleMs: 10000,
  redirectUri: '',
  // Saving credentials over HTTP is off by default: on a VPS the setup page is
  // reachable by anyone who can reach the port. The desktop build turns it on,
  // because a packaged app has no .env to edit.
  allowSetup: false,
  // Set by the desktop wrapper. The only thing the server does with it is
  // change what the /callback page says once the tokens land: in a browser tab
  // opened by the app, "you are done here" is more useful than a link back to a
  // setup page that is already open behind it.
  desktop: false,
  // Desktop only, and off unless asked for: closing the window quits the app.
  // Turned on, it hides to the tray instead and keeps serving, which is what
  // OBS wants but not what "close" usually means.
  closeToTray: false,
};

const ENV = {
  PORT: ['port', int],
  HOST: ['host', str],
  SPOTIFY_CLIENT_ID: ['clientId', str],
  SPOTIFY_CLIENT_SECRET: ['clientSecret', str],
  SPOTIFY_REFRESH_TOKEN: ['seedRefreshToken', str],
  DATA_DIR: ['dataDir', str],
  POLL_PLAYING_MS: ['pollPlayingMs', int],
  POLL_IDLE_MS: ['pollIdleMs', int],
  REDIRECT_URI: ['redirectUri', str],
  ALLOW_SETUP: ['allowSetup', bool],
};

function fromEnv() {
  const out = {};
  for (const [name, [key, parse]] of Object.entries(ENV)) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') continue;
    out[key] = parse(raw);
  }
  return out;
}

/** Blank and absent values must not shadow a lower layer. */
const present = (source) =>
  Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );

/**
 * A mutable singleton rather than a frozen snapshot: every other module reads
 * `config.x` at call time, so a later layer takes effect everywhere without
 * threading a config object through the whole server.
 */
export const config = {};

// Lowest to highest: DEFAULTS < settings.json < environment < programmatic.
// The environment outranks settings.json so an operator who pins a value in
// .env keeps it whatever a stale settings file says; `overrides` outranks both
// because it carries things only the host process knows, like Electron's
// per-user data directory.
let saved = {};
let overrides = {};

function rebuild() {
  Object.assign(config, DEFAULTS, present(saved), fromEnv(), present(overrides));

  // Spotify only accepts HTTPS redirect URIs or the literal loopback address.
  // "localhost" is rejected, so the default targets 127.0.0.1: the desktop build
  // reaches that directly, the VPS through an SSH tunnel. See README, "Connect".
  if (!config.redirectUri) config.redirectUri = `http://127.0.0.1:${config.port}/callback`;

  return config;
}

/** Host-supplied values that outrank the environment. */
export function configure(next = {}) {
  overrides = { ...overrides, ...next };
  return rebuild();
}

/** Values read back from settings.json, which the environment may override. */
export function applySettings(next = {}) {
  saved = { ...saved, ...next };
  return rebuild();
}

rebuild();

export const SCOPES = 'user-read-currently-playing user-read-playback-state';

export const configured = () => Boolean(config.clientId && config.clientSecret);
