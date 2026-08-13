# Now Playing — Spotify overlay for OBS

A self-hosted "now playing" card for OBS browser sources. It polls Spotify for
the current track, pushes updates to the overlay over Server-Sent Events, and
renders a studio-transport card whose accent colour is derived from the album
art.

Developed and tested on a **Windows PC**, deployed to a **Linux home server via
Docker**. Both halves are documented below.

---

## Stack

| | |
|---|---|
| Runtime | Node.js 22, ES modules, **zero npm dependencies** |
| Server | `node:http` by hand — no Express |
| Transport | Server-Sent Events (`/events`), with a JSON polling fallback |
| Frontend | Plain HTML/CSS/JS, no build step, no bundler, no framework |
| Auth | Spotify Authorization Code flow; refresh token on disk |
| State | One JSON file (`tokens.json`) — no database |
| Deploy | Docker Compose on Linux, named volume for the token |

There is no `package-lock.json` and no `node_modules` because there are no
dependencies. `npm install` is never needed.

**Browser target: Chromium 103.** OBS 30.x still embeds CEF/Chromium 103, so
`overlay.css` avoids `color-mix()`, `:has()`, `oklch()` and CSS nesting. Colours
are RGB triplets consumed through `rgb(x / a)`. `backdrop-filter`, `filter`,
`mask-image` and `aspect-ratio` are all fine at that version. Keep it that way —
the setup page previews in your modern desktop browser, but the overlay has to
render in OBS.

**The two stylesheets are deliberately unrelated.** `setup.css` is an
application settings UI — system font stack, neutral palette, one accent, and it
follows the OS light/dark preference via `prefers-color-scheme`. It targets your
desktop browser, so it can use anything modern. `overlay.css` is a broadcast
graphic pinned to Chromium 103 with a display typeface. Don't share tokens
between them; they are solving different problems for different renderers.

**Why the overlay can't frost your actual footage.** In OBS the browser source
is composited over video *outside* the page, so the page can never see what is
behind it and `backdrop-filter` has no footage to blur. What it *can* blur is
another layer inside the page — which is why the markup is
`.stage > .frame > (.bloom + .card)`. The bloom is the album art again, scaled
and blurred; the glass surface refracts that. Real frosted glass over gameplay
is not achievable in a browser source, by anyone.

### Files

```
server/
  index.js     HTTP routing, static files, SSE stream, album-art proxy
  config.js    env parsing, redirect URI, OAuth scopes
  spotify.js   OAuth, token refresh, now-playing polling, subscriber fan-out
  store.js     atomic read/write of tokens.json
public/
  overlay.html/.css/.js   the OBS browser source
  setup.html/.css/.js     the configuration + preview UI
```

### Routes

| Route | Purpose |
|---|---|
| `/` or `/overlay` | the overlay itself — this is the OBS browser source URL |
| `/setup` | control panel: connect account, tune appearance, copy the URL |
| `/events` | SSE stream of playback state |
| `/api/now-playing` | JSON snapshot (fallback for browsers without EventSource) |
| `/api/config` | reports whether creds are set, connected, and the redirect URI |
| `/api/disconnect` | POST — forgets the refresh token |
| `/login` → `/callback` | the Spotify OAuth round trip |
| `/art?u=…` | proxies Spotify CDN images (see below) |
| `/healthz` | container healthcheck |

Two design notes worth keeping in mind when editing:

- **Album art is proxied** through `/art` rather than loaded straight from
  Spotify's CDN. The overlay reads the artwork's pixels on a `<canvas>` to
  derive the accent colour, and that only works same-origin — otherwise the
  canvas is tainted and `getImageData` throws. The proxy allow-lists
  `scdn.co` / `spotifycdn.com` only.
- **Polling only runs while something is watching.** With no overlay and no
  setup page connected, the timer is cleared and the server makes zero Spotify
  requests. An offline stream costs no API quota.

---

## 1. Create the Spotify app

At <https://developer.spotify.com/dashboard> → **Create app**.

**Redirect URI — use exactly this:**

```
http://127.0.0.1:8888/callback
```

Spotify's rules here are strict and are the most common thing to get wrong:

- Redirect URIs must be **HTTPS**, *except* loopback addresses, which may use
  HTTP.
- A loopback address must be the **explicit IP**: `http://127.0.0.1:PORT` or
  `http://[::1]:PORT`.
- **`http://localhost:8888/callback` is rejected.** It is not a synonym for
  `127.0.0.1` as far as Spotify is concerned.
- A LAN address like `http://192.168.1.50:8888/callback` is rejected too — it
  is neither HTTPS nor loopback.

So register `http://127.0.0.1:8888/callback` and use that same value on the
Windows PC *and* on the Linux server (see "Connect on the Linux box" below for
how the callback reaches a headless machine).

If you change `PORT`, change the port in the redirect URI to match, in both the
Spotify dashboard and `.env`. The two strings must match character for
character.

Under **Which API/SDKs are you planning to use**, tick **Web API**. Then copy
the Client ID and Client Secret.

> Spotify apps start in *development mode*, which is fine here — it only limits
> you to users you add manually, and you are the only user. Add your own Spotify
> account under **Settings → User Management** if the authorization is refused.

---

## 2. Windows: run it locally

```powershell
copy .env.example .env
```

Fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. Leave `REDIRECT_URI`
alone. Then:

```powershell
npm run dev
```

`dev` runs Node with `--watch` (restarts on file changes) and
`--env-file-if-exists=.env`, so the `.env` is loaded without any dotenv package.
`npm start` is the same thing without the watcher. No `npm install` step —
there are no dependencies.

Open <http://127.0.0.1:8888/setup>, click **Connect Spotify**, approve, and you
land back on a "Spotify connected" page. The refresh token is written to
`./data/tokens.json` (gitignored).

Then add the OBS browser source using the URL the setup page gives you, at the
size it reports. Leave *Shutdown source when not visible* **unchecked** so the
SSE connection survives scene switches.

Use `?demo=1` on the overlay URL to drive it from invented tracks — handy for
checking legibility over footage without playing anything.

---

## 3. Linux: the Docker deploy

`.env` is not baked into the image (`.dockerignore` excludes it); Compose reads
it from the host at run time.

```bash
git pull
cp .env.example .env   # fill in the same client ID/secret
docker compose up -d --build
docker compose logs -f
```

The overlay is then on `http://<server-ip>:8888/`, which is what OBS points at.
Serving the overlay over the LAN is fine — the redirect URI restriction applies
only to the OAuth callback.

Differences from the Windows run:

- `DATA_DIR=/data` is set by both the Dockerfile and the compose file, pointing
  at the **named volume** `tokens`. It is a named volume rather than a bind
  mount because the container runs as uid 1000 and a host directory created by
  root would not be writable.
- The container runs unprivileged as `node`.
- `restart: unless-stopped` plus a `HEALTHCHECK` hitting `/healthz`.

### Connect on the Linux box

The callback has to arrive at `127.0.0.1:8888` — which, on a headless server,
means *your* machine's loopback needs to reach *its* port. SSH tunnel:

```bash
ssh -L 8888:127.0.0.1:8888 you@your-server
```

Leave that open, then browse to <http://127.0.0.1:8888/setup> on your PC and
click **Connect Spotify**. Spotify redirects to `127.0.0.1:8888/callback`, the
tunnel carries it to the container, and the refresh token lands in the volume.
Close the tunnel afterwards — it is only needed for authorization, not for the
overlay.

Alternative, if the server already has a domain and a reverse proxy: register an
HTTPS redirect URI such as `https://overlay.example.com/callback`, set
`REDIRECT_URI` to it, and skip the tunnel. Spotify permits multiple redirect
URIs per app, so both can be registered at once.

Third option, if you would rather not tunnel: authorize on Windows first, then
copy the `refresh_token` value out of `./data/tokens.json` into
`SPOTIFY_REFRESH_TOKEN=` in the server's `.env`. It is seeded into the volume on
first start.

### Moving from Windows to the server

The client ID/secret are the same in both places, so the only per-environment
state is the token file. Either re-authorize through the tunnel, or seed
`SPOTIFY_REFRESH_TOKEN` as above. Do not commit either `.env`.

---

## Configuration

Everything is environment variables; there is no config file.

| Variable | Default | Notes |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | — | required |
| `SPOTIFY_CLIENT_SECRET` | — | required |
| `REDIRECT_URI` | `http://127.0.0.1:8888/callback` | must match the Spotify app exactly |
| `PORT` | `8888` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data` | container overrides to `/data` |
| `SPOTIFY_REFRESH_TOKEN` | — | optional; skips the browser flow |
| `POLL_PLAYING_MS` | `3000` | ~20 requests/min while playing |
| `POLL_IDLE_MS` | `10000` | |

### Surfaces

`surface` is the material treatment, and it is independent of `layout` and
`theme` — 3 × 3 × 2 combinations, all previewable from `/setup`.

- **`glass`** — a translucent panel over a blurred, scaled copy of the album
  art, refracted with `backdrop-filter`. The flat ink tint underneath is a
  *floor*, not a wash: without it a white or neon sleeve lights the panel
  brightly enough to swallow the type. Widest padding of the three, because the
  bloom deliberately spills past the panel.
- **`bare`** — no container at all. Type and artwork sit straight on the
  footage, held legible by a two-part text shadow (a tight dark one for edge
  contrast, a wide soft one as a halo) rather than by a plate.
- **`bleed`** — the sleeve *is* the background: scaled, blurred, clipped to the
  card, then covered by a directional scrim. Opaque, so it survives any footage.
  Saturation carries the colour rather than exposure — darkening the art to make
  room for the scrim is what turns a red sleeve into grey mud.

All three take their colour from the artwork itself rather than from a computed
swatch painted onto trim.

### Overlay URL parameters

Set these from `/setup` rather than by hand — it previews the result and only
writes non-default values into the URL.

| Param | Values | Default |
|---|---|---|
| `surface` | `glass`, `bare`, `bleed` | `glass` |
| `layout` | `transport`, `strip`, `stack` | `transport` |
| `theme` | `ink`, `paper` | `ink` |
| `align` | `left`, `right` | `left` |
| `ticks` | `on`, `off` | `on` |
| `paused` | `dim`, `show`, `hide` | `dim` |
| `idle` | `hide`, `show` | `hide` |
| `art` | `on`, `off` | `on` |
| `scale` | `0.4`–`4` | `1` |
| `width` | px, `160`–`1600` | auto per layout |
| `accent` | `auto` or `#rrggbb` | `auto` |
| `demo` | `1` | off |

---

## Troubleshooting

**`INVALID_CLIENT: Invalid redirect URI`** — the string registered with Spotify
does not match `REDIRECT_URI` byte for byte. Check for `localhost` vs
`127.0.0.1`, a missing or extra trailing slash, http vs https, and the port.
`/setup` prints the exact value the server is sending.

**"That link has expired"** — authorization links are single-use and valid for
ten minutes. Start again from `/setup`.

**Overlay is blank in OBS but fine in a browser** — check *Shutdown source when
not visible* is unchecked, then right-click the source → **Refresh cache of
current page**. OBS caches aggressively; after any settings change, refresh the
cache.

**Accent colour is not following the artwork** — the art must come through
`/art`. If the canvas is tainted the code falls back to the theme's amber
silently. Check the browser console on the overlay page.

**Nothing updates after a while** — Spotify may have rotated or revoked the
refresh token. `/setup` shows the auth error; reconnect the account. Rotated
tokens are persisted automatically, so this should be rare.

**429 in the logs** — rate limited. The server honours `Retry-After` and backs
off on its own; raise `POLL_PLAYING_MS` if it persists.
