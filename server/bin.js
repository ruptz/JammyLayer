/**
 * Entry point for running the overlay as a plain server — `npm start`, the
 * Docker image, a systemd unit. The desktop build starts the same server from
 * electron/main.js instead, which is why the logging and signal handling live
 * here rather than in index.js.
 */
import { config, configured } from './config.js';
import { baseUrl, start, stop } from './index.js';
import * as spotify from './spotify.js';

try {
  await start();
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`[jammylayer] port ${config.port} is already in use — set PORT to a free port`);
  } else {
    console.error('[jammylayer] failed to start:', error.message);
  }
  process.exit(1);
}

console.log(`[jammylayer] listening on http://${config.host}:${config.port}`);
console.log(`[jammylayer] overlay URL   ${baseUrl()}/`);
console.log(`[jammylayer] setup page    ${baseUrl()}/setup`);
console.log(`[jammylayer] redirect URI  ${config.redirectUri}`);

if (!configured()) {
  console.warn('[jammylayer] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set — open /setup for instructions');
} else if (!spotify.connected()) {
  console.warn('[jammylayer] no account connected yet — open /setup and select "Connect Spotify"');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
