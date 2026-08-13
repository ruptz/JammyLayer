const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const str = (value, fallback = '') => (value ?? fallback).trim();

export const config = {
  port: int(process.env.PORT, 8888),
  host: str(process.env.HOST, '0.0.0.0'),
  clientId: str(process.env.SPOTIFY_CLIENT_ID),
  clientSecret: str(process.env.SPOTIFY_CLIENT_SECRET),
  seedRefreshToken: str(process.env.SPOTIFY_REFRESH_TOKEN),
  // Relative default so `npm run dev` on a Windows box writes into the repo's
  // own ./data instead of trying to create C:\data. The Dockerfile and compose
  // file both set DATA_DIR=/data explicitly for the container's named volume.
  dataDir: str(process.env.DATA_DIR, './data'),
  pollPlayingMs: int(process.env.POLL_PLAYING_MS, 3000),
  pollIdleMs: int(process.env.POLL_IDLE_MS, 10000),
};

// Spotify only accepts HTTPS redirect URIs or the literal loopback address.
// "localhost" is rejected, so the default targets 127.0.0.1 and you reach it
// through an SSH tunnel to the VPS. See README, "Connect your account".
config.redirectUri = str(process.env.REDIRECT_URI, `http://127.0.0.1:${config.port}/callback`);

export const SCOPES = 'user-read-currently-playing user-read-playback-state';

export const configured = () => Boolean(config.clientId && config.clientSecret);
