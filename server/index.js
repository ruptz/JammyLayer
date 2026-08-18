import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySettings, config, configured } from './config.js';
import * as spotify from './spotify.js';
import * as store from './store.js';

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

const BACK_TO_SETUP = '<p class="notice__act"><a class="btn btn--accent" href="/setup">Back to setup</a></p>';

function page(title, heading, body, { tone = '', tag = 'JammyLayer', act = BACK_TO_SETUP } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/setup.css"></head>
<body class="notice"><main class="notice__card ${tone}">
<img class="notice__mark" src="/logo.png" alt="" width="60" height="60">
<p class="notice__tag">${tag}</p>
<h1>${heading}</h1>${body}${act}
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

const connectWatchers = new Set();

/**
 * Fires once the authorization code has been traded for tokens. The desktop
 * wrapper uses this to pull itself back in front of the browser tab the user
 * was sent to — the tab has done its job by then, and the app is where the
 * setup page lives.
 */
export function onConnected(listener) {
  connectWatchers.add(listener);
  return () => connectWatchers.delete(listener);
}

const settingsWatchers = new Set();

/**
 * Fires when a preference is changed from the setup page. Only the desktop
 * wrapper listens: its tray menu shows the same switch, and a context menu is
 * built once rather than re-read on open, so it has to be told to rebuild.
 */
export function onSettingsChanged(listener) {
  settingsWatchers.add(listener);
  return () => settingsWatchers.delete(listener);
}

function announceSettings() {
  for (const watcher of settingsWatchers) {
    try {
      watcher();
    } catch (error) {
      console.error('[jammylayer] settings listener failed:', error);
    }
  }
}

function announceConnected() {
  for (const watcher of connectWatchers) {
    try {
      watcher();
    } catch (error) {
      console.error('[jammylayer] connect listener failed:', error);
    }
  }
}

async function handleCallback(res, url) {
  const error = url.searchParams.get('error');
  if (error) {
    return send(
      res,
      400,
      page('Authorization failed', 'Authorization failed', `<p>Spotify reported: <code>${escapeHtml(error)}</code></p>
<p>Nothing was saved. Start again when you're ready.</p>`, { tone: 'is-error', tag: 'Step 02 — Account', act: returnAct() }),
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
Select <strong>Connect Spotify</strong> again to start a fresh one.</p>`, { tone: 'is-error', tag: 'Step 02 — Account', act: returnAct() }),
      { 'Content-Type': CONTENT_TYPES['.html'] },
    );
  }

  try {
    await spotify.exchangeCode(code);
    send(
      res,
      200,
      page(
        'Spotify connected',
        'Spotify connected',
        config.desktop
          ? `<p>JammyLayer has your account and is back in front. You can close this tab.</p>`
          : `<p>The overlay is live. Add it to OBS as a browser source and it will start showing tracks as they play.</p>`,
        { tag: 'Step 02 — Account', act: returnAct() },
      ),
      { 'Content-Type': CONTENT_TYPES['.html'] },
    );
    // After the response, so a listener that raises a window cannot delay it.
    announceConnected();
  } catch (err) {
    send(
      res,
      502,
      page('Authorization failed', 'Could not complete authorization', `<p>${escapeHtml(err.message)}</p>
<p>Check that <code>SPOTIFY_CLIENT_SECRET</code> matches your app and that the redirect URI registered with Spotify is exactly
<code>${escapeHtml(config.redirectUri)}</code>.</p>`, { tone: 'is-error', tag: 'Step 02 — Account', act: returnAct() }),
      { 'Content-Type': CONTENT_TYPES['.html'] },
    );
  }
}

/**
 * The desktop build sends people to their real browser to authorize, so this
 * page opens in a tab that is finished the moment it renders — linking it back
 * to a setup page that is already open in the app would be sending them the
 * wrong way. A hosted deployment has no app to return to, so it keeps the link.
 */
function returnAct() {
  return config.desktop
    ? '<p class="notice__act notice__act--quiet">Close this tab and carry on in the app.</p>'
    : BACK_TO_SETUP;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

// ------------------------------------------------------------------ credentials

const isLoopback = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

async function readJsonBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('Malformed JSON body');
  }
}

/**
 * Lets the desktop build take client credentials from the setup page, since a
 * packaged app has no .env to edit. Gated twice: the deployment has to opt in
 * via ALLOW_SETUP, and the request has to come from this machine.
 */
async function handleCredentials(req, res) {
  if (req.method !== 'POST') return send(res, 405, 'Use POST', { Allow: 'POST' });
  if (!config.allowSetup) {
    return sendJson(res, 403, {
      ok: false,
      error: 'This deployment takes its credentials from the environment. Set them in .env and restart.',
    });
  }
  if (!isLoopback(req)) {
    return sendJson(res, 403, { ok: false, error: 'Credentials can only be changed from this machine.' });
  }

  const body = await readJsonBody(req);
  const clientId = String(body.clientId ?? '').trim();
  const clientSecret = String(body.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    return sendJson(res, 400, { ok: false, error: 'Both a client ID and a client secret are required.' });
  }

  await store.saveSettings({ ...(await store.loadSettings()), clientId, clientSecret });
  applySettings({ clientId, clientSecret });
  return sendJson(res, 200, { ok: true, configured: configured() });
}

/**
  * Desktop-only preferences. Same two gates as the credentials endpoint — the
  * deployment has to be the desktop build, and the request has to come from this
  * machine — because on anything else there is no window to close and no tray to
  * close it to.
  */
async function handlePreferences(req, res) {
  if (req.method !== 'POST') return send(res, 405, 'Use POST', { Allow: 'POST' });
  if (!config.desktop || !isLoopback(req)) {
    return sendJson(res, 403, { ok: false, error: 'Preferences are only settable from the desktop app.' });
  }

  const body = await readJsonBody(req);
  if (typeof body.closeToTray !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: 'closeToTray must be true or false.' });
  }

  const { closeToTray } = body;
  await store.saveSettings({ ...(await store.loadSettings()), closeToTray });
  applySettings({ closeToTray });
  announceSettings();
  return sendJson(res, 200, { ok: true, closeToTray });
}

const handler = async (req, res) => {
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
      case '/logo.png':
        return serveStatic(res, path.slice(1));
      case '/healthz':
        return sendJson(res, 200, { ok: true, configured: configured(), connected: spotify.connected() });
      case '/api/now-playing':
        return sendJson(res, 200, await spotify.refetch());
      case '/api/config': {
        // Drives whether the setup page offers a credentials form or leaves the
        // user to edit .env.
        const canEditCredentials = config.allowSetup && isLoopback(req);
        // Preferences are about the desktop window, so they exist nowhere else.
        const canEditPreferences = Boolean(config.desktop) && isLoopback(req);
        return sendJson(res, 200, {
          configured: configured(),
          connected: spotify.connected(),
          redirectUri: config.redirectUri,
          canEditCredentials,
          canEditPreferences,
          closeToTray: Boolean(config.closeToTray),
          // Only echoed back to a machine-local editor, so the form can prefill
          // and ask for nothing but the secret. Never on a shared deployment.
          clientId: canEditCredentials ? config.clientId : undefined,
        });
      }
      case '/events':
        return serveEvents(req, res);
      case '/art':
        return serveArt(res, url);
      case '/login':
        if (!configured()) {
          return send(
            res,
            409,
            page('Not configured', 'Client credentials are missing', `<p>Set <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> in your <code>.env</code>, then restart the container.</p>`, { tone: 'is-error', tag: 'Step 01 — Keys' }),
            { 'Content-Type': CONTENT_TYPES['.html'] },
          );
        }
        res.writeHead(302, { Location: spotify.authorizeUrl(), 'Cache-Control': 'no-store' });
        return res.end();
      case '/callback':
        return handleCallback(res, url);
      case '/api/credentials':
        return handleCredentials(req, res);
      case '/api/preferences':
        return handlePreferences(req, res);
      case '/api/disconnect':
        if (req.method !== 'POST') return send(res, 405, 'Use POST', { Allow: 'POST' });
        await spotify.disconnect();
        return sendJson(res, 200, { ok: true });
      case '/favicon.ico':
        // Browsers ask for this by convention even when a <link rel="icon">
        // points elsewhere; answering with the mark beats a blank tab.
        return serveStatic(res, 'logo.png');
      default:
        return send(res, 404, 'Not found');
    }
  } catch (error) {
    console.error(`[jammylayer] ${req.method} ${path} failed:`, error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message });
    else res.end();
  }
};

let server = null;

/** Reachable base URL — what you open for /setup and paste into OBS. */
export const baseUrl = () => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}`;
};

/**
 * Resolves once the server is actually listening, so both entry points — the
 * container's bin.js and the desktop wrapper — can surface a real failure
 * (a port already in use, most often) rather than an unhandled 'error' event.
 */
export async function start() {
  if (server) return server;

  // Loaded here rather than in the desktop wrapper so that running from source
  // with ALLOW_SETUP=1 also survives a restart. Anything set in the environment
  // still wins.
  const settings = await store.loadSettings();
  if (settings) {
    applySettings({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      port: settings.port,
      closeToTray: settings.closeToTray,
    });
  }

  await spotify.init();
  const instance = createServer(handler);

  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(config.port, config.host, () => {
      instance.off('error', reject);
      resolve();
    });
  });

  server = instance;
  return server;
}

export async function stop() {
  if (!server) return;
  const instance = server;
  server = null;

  await new Promise((resolve) => {
    instance.close(resolve);
    // Overlay clients hold an SSE stream open for as long as OBS is running, so
    // close() on its own would never finish.
    instance.closeAllConnections?.();
    setTimeout(resolve, 3000).unref?.();
  });
}
