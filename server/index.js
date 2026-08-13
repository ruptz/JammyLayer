import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configured } from './config.js';
import * as spotify from './spotify.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const ALLOWED_ART_HOST = /(^|\.)scdn\.co$|(^|\.)spotifycdn\.com$/;

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function page(title, heading, body, accentClass = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/setup.css"></head>
<body class="notice"><main class="notice__card ${accentClass}">
<h1>${heading}</h1>${body}
<p><a class="btn" href="/setup">Back to setup</a></p>
</main></body></html>`;
}

async function serveStatic(res, name) {
  const target = resolve(PUBLIC_DIR, name);
  if (!target.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    return send(res, 403, 'Forbidden');
  }

  const type = CONTENT_TYPES[extname(target)];
  if (!type) return send(res, 404, 'Not found');

  try {
    const file = await readFile(target);
    send(res, 200, file, {
      'Content-Type': type,
      // The overlay must pick up edits on an OBS cache refresh, so nothing is cached hard.
      'Cache-Control': 'no-cache',
    });
  } catch {
    send(res, 404, 'Not found');
  }
}

/**
 * Album art is proxied so the overlay can read its pixels on a canvas to derive
 * the accent colour: same-origin means no tainted canvas, whatever CORS headers
 * Spotify's CDN happens to send.
 */
const artCache = new Map();
const ART_CACHE_MAX = 16;

async function serveArt(res, url) {
  const source = url.searchParams.get('u');
  if (!source) return send(res, 400, 'Missing "u" parameter');

  let target;
  try {
    target = new URL(source);
  } catch {
    return send(res, 400, 'Malformed image URL');
  }
  if (target.protocol !== 'https:' || !ALLOWED_ART_HOST.test(target.hostname)) {
    return send(res, 403, 'Only Spotify image hosts are proxied');
  }

  const key = target.toString();
  const cached = artCache.get(key);
  if (cached) {
    artCache.delete(key);
    artCache.set(key, cached);
    return send(res, 200, cached.body, {
      'Content-Type': cached.type,
      'Cache-Control': 'public, max-age=604800, immutable',
    });
  }

  try {
    const upstream = await fetch(key);
    if (!upstream.ok) return send(res, 502, 'Could not load album art');

    const body = Buffer.from(await upstream.arrayBuffer());
    const entry = { body, type: upstream.headers.get('content-type') ?? 'image/jpeg' };
    artCache.set(key, entry);
    while (artCache.size > ART_CACHE_MAX) artCache.delete(artCache.keys().next().value);

    send(res, 200, entry.body, {
      'Content-Type': entry.type,
      'Cache-Control': 'public, max-age=604800, immutable',
    });
  } catch {
    send(res, 502, 'Could not load album art');
  }
}

function serveEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const unsubscribe = spotify.subscribe((state) => {
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  });

  // OBS keeps the source alive for hours; a comment every 15s stops idle
  // connections being dropped by the browser or anything in between.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  req.on('error', close);
}

async function handleCallback(res, url) {
  const error = url.searchParams.get('error');
  if (error) {
    return send(
      res,
      400,
      page('Authorization failed', 'Authorization failed', `<p>Spotify reported: <code>${escapeHtml(error)}</code></p>
<p>Nothing was saved. Start again from the setup page when you're ready.</p>`, 'is-error'),
      { 'Content-Type': CONTENT_TYPES['.html'] },
    );
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !spotify.consumeState(state)) {
    return send(
      res,
      400,
      page('Authorization failed', 'That link has expired', `<p>Authorization links are valid for ten minutes and can only be used once.
Open the setup page and select <strong>Connect Spotify</strong> again.</p>`, 'is-error'),
      { 'Content-Type': CONTENT_TYPES['.html'] },
    );
  }

  try {
    await spotify.exchangeCode(code);
    send(
      res,
      200,
      page('Spotify connected', 'Spotify connected', `<p>The overlay is live. Add it to OBS as a browser source and it will start showing tracks as they play.</p>`),
      { 'Content-Type': CONTENT_TYPES['.html'] },
    );
  } catch (err) {
    send(
      res,
      502,
      page('Authorization failed', 'Could not complete authorization', `<p>${escapeHtml(err.message)}</p>
<p>Check that <code>SPOTIFY_CLIENT_SECRET</code> matches your app and that the redirect URI registered with Spotify is exactly
<code>${escapeHtml(config.redirectUri)}</code>.</p>`, 'is-error'),
      { 'Content-Type': CONTENT_TYPES['.html'] },
    );
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
    }

    switch (path) {
      case '/':
      case '/overlay':
        return serveStatic(res, 'overlay.html');
      case '/setup':
        return serveStatic(res, 'setup.html');
      case '/overlay.css':
      case '/overlay.js':
      case '/setup.css':
      case '/setup.js':
        return serveStatic(res, path.slice(1));
      case '/healthz':
        return sendJson(res, 200, { ok: true, configured: configured(), connected: spotify.connected() });
      case '/api/now-playing':
        return sendJson(res, 200, await spotify.refetch());
      case '/api/config':
        return sendJson(res, 200, {
          configured: configured(),
          connected: spotify.connected(),
          redirectUri: config.redirectUri,
        });
      case '/events':
        return serveEvents(req, res);
      case '/art':
        return serveArt(res, url);
      case '/login':
        if (!configured()) {
          return send(
            res,
            409,
            page('Not configured', 'Client credentials are missing', `<p>Set <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> in your <code>.env</code>, then restart the container.</p>`, 'is-error'),
            { 'Content-Type': CONTENT_TYPES['.html'] },
          );
        }
        res.writeHead(302, { Location: spotify.authorizeUrl(), 'Cache-Control': 'no-store' });
        return res.end();
      case '/callback':
        return handleCallback(res, url);
      case '/api/disconnect':
        if (req.method !== 'POST') return send(res, 405, 'Use POST', { Allow: 'POST' });
        await spotify.disconnect();
        return sendJson(res, 200, { ok: true });
      case '/favicon.ico':
        return send(res, 204, '');
      default:
        return send(res, 404, 'Not found');
    }
  } catch (error) {
    console.error(`[overlay] ${req.method} ${path} failed:`, error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message });
    else res.end();
  }
});

await spotify.init();

server.listen(config.port, config.host, () => {
  console.log(`[overlay] listening on http://${config.host}:${config.port}`);
  console.log(`[overlay] overlay URL   /`);
  console.log(`[overlay] setup page    /setup`);
  console.log(`[overlay] redirect URI  ${config.redirectUri}`);
  if (!configured()) {
    console.warn('[overlay] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set — open /setup for instructions');
  } else if (!spotify.connected()) {
    console.warn('[overlay] no account connected yet — open /setup and select "Connect Spotify"');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
