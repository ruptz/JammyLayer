# JammyLayer — Spotify overlay for OBS

[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support%20this%20project-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/ruptz)

A self-hosted "now playing" card for OBS browser sources. It polls Spotify for
the current track, pushes updates to the overlay over Server-Sent Events, and
renders a studio-transport card whose accent colour is derived from the album
art.

**Most people want the desktop app.** Download one installer, run it, and it
sits in the tray on the machine OBS is already on — no terminal, no Node, no
Docker, no `.env`. You type your Spotify credentials into its setup window and
paste one URL into OBS. [Start here.](#setup--the-desktop-app)

| | Who it's for | What it needs |
|---|---|---|
| **[Desktop app](#setup--the-desktop-app)** | **Almost everyone.** OBS and the overlay on one PC | Nothing — download and run |
| [From source](#run-from-source) | Development, or a hand-rolled service | Node 22 |
| [Docker](#docker-on-a-linux-server) | A Linux box serving OBS across the LAN | Docker + Compose |

All three host the same server and produce the same overlay — they differ only
in where it runs and where it keeps your token.

---

## Setup — the desktop app

Three steps: register an app with Spotify, install this one and connect it, then
point OBS at it. Budget ten minutes, most of it spent in Spotify's dashboard.

### 1. Create your Spotify app

The overlay talks to Spotify as *you*, using credentials you own. Spotify does
not hand those out for an app like this, so you register a personal one — it is
free and takes about two minutes.

Go to <https://developer.spotify.com/dashboard> → **Create app**. Name and
description can be anything.

**Redirect URI — use exactly this:**

```
http://127.0.0.1:8888/callback
```

This is the single most common thing to get wrong, because Spotify's rules are
strict and the error message is unhelpful:

- Redirect URIs must be **HTTPS**, *except* loopback addresses, which may use
  HTTP.
- A loopback address must be the **explicit IP**: `http://127.0.0.1:PORT` or
  `http://[::1]:PORT`.
- **`http://localhost:8888/callback` is rejected.** It is not a synonym for
  `127.0.0.1` as far as Spotify is concerned.
- A LAN address like `http://192.168.1.50:8888/callback` is rejected too — it is
  neither HTTPS nor loopback.

Under **Which API/SDKs are you planning to use**, tick **Web API**. Save, then
open the app's settings and copy the **Client ID** and **Client Secret**.

> Spotify apps start in *development mode*, which is fine here — it only limits
> you to users you add by hand, and you are the only user. If authorization is
> refused, add your own Spotify account under **Settings → User Management**.

### 2. Install the app and connect it

Download the installer for your machine from the [latest
release](https://github.com/ruptz/JammyLayer/releases/latest):

| | File | |
|---|---|---|
| Windows | `JammyLayer Setup x.y.z.exe` | The tested platform. A normal wizard installer. |
| macOS | `JammyLayer-x.y.z-arm64.dmg` / `-x64.dmg` | Untested. Take the one matching your chip. |
| Linux | `JammyLayer-x.y.z.AppImage` | Untested. `chmod +x` it, then run it. |

Nothing else is needed — no Node, no npm, no Docker. Electron brings its own
runtime and the server has no dependencies at all.

**The installers are not code-signed**, so your OS will object the first time
you run one:

- **Windows** — SmartScreen says "Windows protected your PC". **More info** →
  **Run anyway**.
- **macOS** — Gatekeeper refuses an unsigned app. Right-click it in Applications
  → **Open** → **Open**. If it claims the app is damaged, clear the quarantine
  flag: `xattr -cr /Applications/JammyLayer.app`.

<details>
<summary><b>Or build it yourself</b> — needs Node 22</summary>

```powershell
npm install     # devDependencies only — the server itself has none
npm run dist    # writes the same installer into dist/
```

To skip installing and run it straight from the source folder:

```powershell
npm run desktop
```

</details>

However you got there, the settings window opens on the setup page at step
**01 Keys**.

1. Paste the **Client ID** and **Client Secret** from step 1.
2. Check the **Redirect URI to register** the page shows you against what you
   registered with Spotify — copy it from here rather than retyping it, because
   Spotify matches the string character for character.
3. Click **Save credentials**.
4. Click **Connect Spotify**.

**Authorization happens in your normal browser, and then the app takes itself
back.** Spotify's sign-in page is not built to be embedded, an embedded window
cannot use the Spotify session you already have, and Google and Apple sign-in
refuse to run in one at all — so the app hands the login to your default browser
and stays parked on the setup page. Approve it there. The moment the tokens are
saved, the app raises its own window and the setup page flips to **Connected**.
The browser tab is finished at that point and says so. Nothing to click, nothing
to copy back.

Your credentials and refresh token are written to a per-user folder, never
inside the install directory:

| | |
|---|---|
| Windows | `%APPDATA%\JammyLayer\` |
| macOS | `~/Library/Application Support/JammyLayer/` |
| Linux | `~/.config/JammyLayer/` |

`settings.json` holds the client ID and secret; `tokens.json` holds the refresh
token. Nothing is sent anywhere except to Spotify.

### 3. Add it to OBS

In OBS: **Sources → + → Browser**.

1. **URL** — click **Copy** in the setup page's **05 Output** section and paste
   it. That URL carries every appearance choice you have made, so copy it again
   after any change.
2. **Width and height** — use the size the setup page reports next to the copy
   field. It is measured off the card the overlay actually rendered, not guessed,
   so it will fit exactly.
3. **Shutdown source when not visible** — leave this **unchecked**. It kills the
   event stream on every scene switch, and the card comes back blank.
4. **Custom CSS** — leave it empty. The page is already transparent.

After changing anything in the setup page, right-click the source → **Refresh
cache of current page**. OBS caches browser sources aggressively and will
otherwise keep showing the old one.

Tune the card from the setup page while OBS is open — the monitor on the right
runs the real overlay at the real size, showing your actual playback when
Spotify is connected.

> **JammyLayer has to be running for the overlay to work.** It is the thing
> serving that URL, so closing it blanks the source. By default closing the
> window does exactly that — see [Living with it](#living-with-it) for the
> switch that leaves it running in the tray instead.

### Living with it

**Closing the window quits the app** — and that stops the overlay, so OBS shows
nothing until you open JammyLayer again.

If you would rather it got out of the way and kept serving, turn it on in either
of two places, which are the same setting:

- the **cog** in the top right of the setup page → **Closing the window** →
  **Keeps running**, or
- **Keep running when I close the window** in the tray menu.

It is off by default because a window that will not close is a surprise, and
this one leaves no visible sign it is still there. With it on, closing hides to
the tray and the browser source stays connected; **Quit** in the tray menu is
then the way out.

The tray menu also has **Open setup…**, **Copy overlay URL** and **Start when I
sign in**.

**Starting automatically** — tick **Start when I sign in** in the tray menu
(Windows and macOS). It comes up silently in the tray, so the overlay is live
before you open OBS.

**Updating** — download the newer installer and run it over the top. Your
credentials and token live outside the install folder and survive it, so you
will not have to reconnect.

**Changing the port** — add `"port": 9000` to `settings.json` in the folder
above, register `http://127.0.0.1:9000/callback` as a second redirect URI with
Spotify, and restart. Spotify allows several redirect URIs per app.

**Disconnecting** — **Disconnect** in step 02 of the setup page forgets the
refresh token on this machine. Your Spotify account is untouched; revoke the app
itself at <https://www.spotify.com/account/apps/> if you want it gone entirely.

---

## Other ways to run it

Both of these need [step 1](#1-create-your-spotify-app) done first — the
credentials and the redirect URI rule are the same everywhere.

### Run from source

For development, or for running it as your own service. No `npm install` is
needed: the server has no runtime dependencies at all.

```powershell
copy .env.example .env
```

Fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. Leave `REDIRECT_URI`
alone. Then:

```powershell
npm run dev
```

`dev` runs Node with `--watch` (restarts on file changes) and
`--env-file-if-exists=.env`, so the `.env` is read without any dotenv package.
`npm start` is the same thing without the watcher.

Open <http://127.0.0.1:8888/setup>, click **Connect Spotify**, approve, and you
land on a "Spotify connected" page. The refresh token is written to
`./data/tokens.json` (gitignored). Then add the OBS source exactly as in
[step 3](#3-add-it-to-obs).

Note that the credentials form is hidden here — it needs `ALLOW_SETUP`, which
only the desktop build sets. From source, credentials come from `.env`.

`?demo=1` on the overlay URL drives it from invented tracks, which is handy for
checking legibility over footage without playing anything.

### Docker on a Linux server

For a Linux box serving the overlay to OBS across the LAN. `.env` is not baked
into the image (`.dockerignore` excludes it); Compose reads it from the host at
run time.

```bash
git pull
cp .env.example .env   # the same client ID/secret
docker compose up -d --build
docker compose logs -f
```

The overlay is then at `http://<server-ip>:8888/`, which is what OBS points at.
Serving the overlay over the LAN is fine — the redirect URI restriction applies
only to the OAuth callback.

Differences from running it from source:

- `DATA_DIR=/data` is set by both the Dockerfile and the compose file, pointing
  at the **named volume** `tokens`. It is a named volume rather than a bind
  mount because the container runs as uid 1000 and a host directory created by
  root would not be writable.
- The container runs unprivileged as `node`.
- `restart: unless-stopped` plus a `HEALTHCHECK` hitting `/healthz`.

#### Connecting on a headless box

The callback has to arrive at `127.0.0.1:8888` — which, on a headless server,
means *your* machine's loopback needs to reach *its* port. SSH tunnel:

```bash
ssh -L 8888:127.0.0.1:8888 you@your-server
```

Leave that open, browse to <http://127.0.0.1:8888/setup> on your PC and click
**Connect Spotify**. Spotify redirects to `127.0.0.1:8888/callback`, the tunnel
carries it to the container, and the refresh token lands in the volume. Close
the tunnel afterwards — it is only needed for authorization, not for the
overlay.

Alternative, if the server already has a domain and a reverse proxy: register an
HTTPS redirect URI such as `https://overlay.example.com/callback`, set
`REDIRECT_URI` to it, and skip the tunnel.

Third option, if you would rather not tunnel: authorize on Windows first, then
copy the `refresh_token` value out of `./data/tokens.json` into
`SPOTIFY_REFRESH_TOKEN=` in the server's `.env`. It is seeded into the volume on
first start.

#### Moving from Windows to the server

The client ID/secret are the same in both places, so the only per-environment
state is the token file. Either re-authorize through the tunnel, or seed
`SPOTIFY_REFRESH_TOKEN` as above. Do not commit either `.env`.

---

## Configuration

Environment variables everywhere except the desktop build, which has no `.env`
to read and uses `settings.json` in its per-user data directory instead.

| Variable | Default | Notes |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | — | required |
| `SPOTIFY_CLIENT_SECRET` | — | required |
| `REDIRECT_URI` | `http://127.0.0.1:8888/callback` | must match the Spotify app exactly |
| `PORT` | `8888` | |
| `HOST` | `0.0.0.0` | desktop build forces `127.0.0.1` |
| `DATA_DIR` | `./data` | container overrides to `/data` |
| `ALLOW_SETUP` | `0` | enables `POST /api/credentials` from loopback |
| `SPOTIFY_REFRESH_TOKEN` | — | optional; skips the browser flow |
| `POLL_PLAYING_MS` | `3000` | ~20 requests/min while playing |
| `POLL_IDLE_MS` | `10000` | |

Environment variables win over `settings.json`, so setting `SPOTIFY_CLIENT_ID`
in the environment pins it regardless of what the setup page saved.

`settings.json` also holds `closeToTray`, which has no environment variable
because it is about the desktop window and nothing else has one. It defaults to
`false`; the setup page's cog and the tray menu both write it.

`ALLOW_SETUP` is deliberately opt-in. Turning it on for a LAN or VPS deployment
lets anyone who can reach the port replace your client secret — the loopback
check is the only thing standing in the way, and it is satisfied by anyone
holding an SSH tunnel.

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
does not match the one the server is sending, byte for byte. Check for
`localhost` vs `127.0.0.1`, a missing or extra trailing slash, http vs https,
and the port. The setup page prints the exact value it is sending, in step 02.

**"That link has expired"** — authorization links are single-use and valid for
ten minutes. Start again from the setup page.

**The browser opened but the app never came back** — the authorization itself
still worked; check the setup window, which should already say **Connected**.
Windows will not always let a background process take the foreground, in which
case the taskbar button flashes instead.

**Port 8888 is already in use** — the desktop app says so on startup rather than
failing silently. Something else has the port; either stop it, or change the
port as described under [Living with it](#living-with-it).

**Overlay is blank in OBS but fine in a browser** — check *Shutdown source when
not visible* is unchecked, then right-click the source → **Refresh cache of
current page**. OBS caches aggressively; after any settings change, refresh the
cache.

**The card is the wrong size in OBS** — the browser source width and height are
set independently of the page. Copy the size the setup page reports and put it
into the source properties.

**Accent colour is not following the artwork** — the art must come through
`/art`. If the canvas is tainted the code falls back to the theme's amber
silently. Check the browser console on the overlay page.

**Nothing updates after a while** — Spotify may have rotated or revoked the
refresh token. The setup page shows the auth error; reconnect the account.
Rotated tokens are persisted automatically, so this should be rare.

**429 in the logs** — rate limited. The server honours `Retry-After` and backs
off on its own; raise `POLL_PLAYING_MS` if it persists.

---

## Support

JammyLayer is free and runs entirely on your own machine — there is no account
to make, no service of mine in the middle, and nothing to pay for.

If it earns its place on your stream and you want to put something in the tip
jar: **[ko-fi.com/ruptz](https://ko-fi.com/ruptz)**. Entirely optional, and it
changes nothing about the software either way.

Bug reports and pull requests are just as welcome, and free.

---

## How it works

Everything below is for people editing the code. Nothing here is needed to use
the overlay.

### Stack

| | |
|---|---|
| Runtime | Node.js 22, ES modules, **no runtime dependencies** |
| Server | `node:http` by hand — no Express |
| Transport | Server-Sent Events (`/events`), with a JSON polling fallback |
| Frontend | Plain HTML/CSS/JS, no build step, no bundler, no framework |
| Auth | Spotify Authorization Code flow; refresh token on disk |
| State | One JSON file (`tokens.json`) — no database |
| Desktop | Electron tray app wrapping the same server |
| Deploy | Docker Compose on Linux, named volume for the token |

**The server still pulls in nothing.** Running from source or in Docker needs no
`npm install` whatsoever. Electron and electron-builder are `devDependencies`
used only to build the desktop app, and the image never sees them —
`.dockerignore` excludes `electron/` and `node_modules/`.

**Browser target: Chromium 103.** OBS 30.x still embeds CEF/Chromium 103, so
`overlay.css` avoids `color-mix()`, `:has()`, `oklch()` and CSS nesting. Colours
are RGB triplets consumed through `rgb(x / a)`. `backdrop-filter`, `filter`,
`mask-image` and `aspect-ratio` are all fine at that version. Keep it that way —
the setup page previews in your modern desktop browser, but the overlay has to
render in OBS.

**The two stylesheets stay separate.** `setup.css` is a spec sheet, not a
dashboard: a wordmark measured to the exact width of its column, a rule under
it, and a three-column grid — index, controls, monitor — with no cards anywhere.
Hairlines and alignment do the separating, every control sits on a common right
edge, and nothing has a corner radius. `overlay.css` is a broadcast graphic
pinned to Chromium 103. Don't share tokens between them; they are solving
different problems for different renderers.

**Type is Archivo and IBM Plex Mono, and the fallback is the point.** Archivo
has a real width axis, so headings run expanded and heavy the way a poster sets
them while the controls drop to a small tight face; anything that changes — a
size, a URL, a counter, a caption — is set in mono so it reads as a measurement.
Both are loaded from Google Fonts and both fall back to Helvetica and Arial,
which is where this style came from anyway. The page renders correctly with no
network at all, which matters because it ships inside a desktop app.

**One saturated colour, and it means "live".** The overlay takes its accent from
each album sleeve, so a control panel that shouts a second hue would fight every
card it previews. Red is reserved for things that are actually happening: the
tally when the monitor shows real playback, the progress bar of a track that is
playing, the section you are reading, and the one action the page is asking for.
Everything else is off-black, off-white, and a flat paper block that inverts to
mark a choice — a printed block rather than a glow, which is also why there are
no shadows on the page.

Dark by default because it sits next to OBS, with a light variant under
`prefers-color-scheme` that inverts the block along with the ground, so
"selected" is always the opposite of the page. The monitor keeps its dark
chrome in both, the way a screen does.

**`overlay.css` declares `color-scheme: dark` for one reason.** A document that
declares none is given an opaque white canvas when it is embedded, and the setup
page embeds the overlay to preview it — without the declaration the monitor's
backdrop switch has nothing to show through. OBS composites its own transparency
and never sees it.

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
  bin.js       entry point for `npm start` and the container
  index.js     HTTP routing, static files, SSE stream, album-art proxy
  config.js    env parsing, layered overrides, redirect URI, OAuth scopes
  spotify.js   OAuth, token refresh, now-playing polling, subscriber fan-out
  store.js     atomic read/write of tokens.json and settings.json
electron/
  main.js        desktop wrapper: tray, settings window, starts the same server
  make-icon.mjs  scales public/logo.png up to the 256px icon the installers want
public/
  overlay.html/.css/.js   the OBS browser source
  setup.html/.css/.js     the configuration + preview UI
  logo.png                the mark: tab icon, masthead, tray, installer
```

`index.js` exports `start()` / `stop()` and starts nothing on import, which is
what lets both entry points share it: `bin.js` adds the logging and signal
handling a daemon needs, `electron/main.js` starts the same server in-process
after pointing it at a per-user data directory. `config.js` is a mutable
singleton rebuilt by `configure(overrides)`, with each call layering on top of
the last — the desktop build sets the data directory first, then the saved
credentials, and `/api/credentials` layers newly-typed ones on top without
disturbing either.

### Routes

| Route | Purpose |
|---|---|
| `/` or `/overlay` | the overlay itself — this is the OBS browser source URL |
| `/setup` | control panel: connect account, tune appearance, copy the URL |
| `/events` | SSE stream of playback state |
| `/api/now-playing` | JSON snapshot (fallback for browsers without EventSource) |
| `/api/config` | reports whether creds are set, connected, and the redirect URI |
| `/api/credentials` | POST — saves client ID/secret; **desktop only**, see below |
| `/api/preferences` | POST — saves `closeToTray`; **desktop only** |
| `/api/disconnect` | POST — forgets the refresh token |
| `/login` → `/callback` | the Spotify OAuth round trip |
| `/art?u=…` | proxies Spotify CDN images (see below) |
| `/logo.png` | the mark |
| `/healthz` | container healthcheck |

Six design notes worth keeping in mind when editing:

- **The preview on `/setup` runs the real overlay.** The monitor is an iframe
  pointed at the same URL you paste into OBS, so you are judging the page OBS
  loads rather than a mock-up — which is also why the reported source size is
  measured off the rendered `.stage` instead of guessed from the layout name.
  When Spotify is connected and has a track loaded, the preview drops `demo=1`
  and shows your actual playback; the tally lamp is lit whenever that is what
  you are looking at, and the **Feed** switch lets you pin it to either source.
  Falling back to demo waits five seconds, because Spotify returns 204 for a
  moment between tracks and the monitor should not flicker through demo mode on
  the way. `idle` and `paused` hiding are neutralised in the preview only, so
  there is always a card on screen to judge.
- **The desktop build sends OAuth to the real browser, and the server tells it
  when to come back.** `electron/main.js` routes `/login` and every off-origin
  URL to `shell.openExternal`, listening on both `will-navigate` *and*
  `will-redirect` — `/login` answers with a redirect, and a redirect is not a
  navigation as far as the first event is concerned. `index.js` exports
  `onConnected()`, fired once the tokens are saved, which the wrapper uses to
  raise its window. The setup page has already updated itself over `/events` by
  then; the callback is only about which window has focus.
- **One setting, two places, one source of truth.** "Keep running when I close
  the window" is in both the setup page and the tray menu, and both write
  `closeToTray` to `settings.json` through `server/store.js` — neither keeps its
  own copy. Changed from the page, `onSettingsChanged()` tells the wrapper to
  rebuild the tray menu, because a context menu is built once rather than read
  on open. Changed from the tray, the page picks it up by re-reading
  `/api/config` on `window.focus`, which is the only moment it can matter.
- **Album art is proxied** through `/art` rather than loaded straight from
  Spotify's CDN. The overlay reads the artwork's pixels on a `<canvas>` to
  derive the accent colour, and that only works same-origin — otherwise the
  canvas is tainted and `getImageData` throws. The proxy allow-lists
  `scdn.co` / `spotifycdn.com` only.
- **Polling only runs while something is watching.** With no overlay and no
  setup page connected, the timer is cleared and the server makes zero Spotify
  requests. An offline stream costs no API quota.
- **Writing credentials over HTTP is off unless asked for.** `/api/credentials`
  needs both `ALLOW_SETUP` (which only the desktop build sets) *and* a loopback
  client — on a VPS the setup page is reachable by anyone who can reach the port,
  and it would be a hole to let them rewrite the client secret. The setup page
  hides the form and the client ID entirely unless the server says both hold.
