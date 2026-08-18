/**
 * Desktop wrapper: runs the exact same HTTP server as the container, but points
 * it at a per-user data directory and puts a tray icon and a settings window in
 * front of it. OBS still renders the overlay through a browser source — this
 * process only hosts it, so nothing about the overlay itself changes.
 */
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, nativeImage, shell } from 'electron';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySettings, config, configure } from '../server/config.js';
import { baseUrl, onConnected, onSettingsChanged, start, stop } from '../server/index.js';
import * as store from '../server/store.js';

// Set before anything reads getPath('userData'): Electron derives the per-user
// directory from the app name, so this is what decides where the token lives.
app.setName('JammyLayer');

let tray = null;
let win = null;
let quitting = false;
let shuttingDown = false;

// The same mark the setup page and the installer use, so the tray, the taskbar
// and the page all agree on what this app looks like.
const MARK = fileURLToPath(new URL('../public/logo.png', import.meta.url));

const appIcon = () => nativeImage.createFromPath(MARK);

/**
 * Not a template image: the mark is in colour, and macOS renders a template as
 * a flat silhouette, which would reduce it to a green blob.
 */
function trayIcon() {
  // macOS measures the menu bar in logical pixels and wants ~22; Windows and
  // most Linux panels take 32 and scale it down themselves.
  const size = process.platform === 'darwin' ? 22 : 32;
  return appIcon().resize({ width: size, height: size, quality: 'best' });
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    title: 'JammyLayer',
    // Matches --void in setup.css, so the frame that paints before the page
    // does is the page's own ground rather than a flash of white.
    backgroundColor: '#0A0A0B',
    autoHideMenuBar: true,
    icon: appIcon(),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.loadURL(`${baseUrl()}/setup`);

  // Anything asking for a window of its own — "Open overlay", the developer
  // dashboard link — is a browser's job. Denying without opening it, which is
  // what a bare deny does, just makes the control look broken.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // This window shows one thing: the setup page. Navigations that would take it
  // anywhere else are handed to the browser instead, so the app never ends up
  // parked on a page it has no way back from.
  const keepOnSetup = (event, url) => {
    if (!leavesTheApp(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  };

  win.webContents.on('will-navigate', keepOnSetup);
  // Separate event, and the one that matters here: /login answers with a
  // redirect, and a redirect is not a navigation as far as will-navigate is
  // concerned.
  win.webContents.on('will-redirect', keepOnSetup);

  win.on('close', (event) => {
    if (quitting) return;

    // Off by default, because a window that will not close is a surprise and
    // this one leaves no visible sign it is still running. Turned on, closing
    // leaves the server up in the tray so OBS keeps its browser source.
    if (config.closeToTray) {
      event.preventDefault();
      win.hide();
      return;
    }

    // Let the window go, and take the server with it — will-quit stops it
    // cleanly, so the overlay's event stream is closed rather than dropped.
    app.quit();
  });
}

/**
 * Spotify's authorisation page has to open in the real browser — it is not built
 * for an embedded window, an embedded one cannot use the Spotify session the
 * user already has, and Google and Apple sign-in refuse to run in one at all.
 *
 * /login is our own URL but counts as leaving: it answers with a redirect to
 * accounts.spotify.com, so following it in this window would drag the app onto
 * Spotify's login page. Sending the whole flow to the browser keeps it in one
 * place, and the callback lands back on this same loopback server regardless of
 * which browser did the authorising.
 */
function leavesTheApp(url) {
  if (!url.startsWith(baseUrl())) return true;
  try {
    return new URL(url).pathname === '/login';
  } catch {
    return false;
  }
}

/**
 * Bring the app back in front. Called when the browser tab finishes authorising,
 * because at that point the tab is spent and everything else happens in here.
 */
function surface() {
  showWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();

  // Windows will not hand the foreground to a process the user is not currently
  // interacting with, and they are in the browser. A moment pinned on top is
  // what gets through; flashing the taskbar button covers the rest.
  win.setAlwaysOnTop(true);
  win.focus();
  app.focus({ steal: true });
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
  }, 500);
  win.flashFrame(true);
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.flashFrame(false);
  }, 3000);
}

/**
 * Persisted in settings.json beside the credentials rather than in Electron's
 * own store, so the setup page and the tray menu read and write one value
 * through one path.
 */
async function setCloseToTray(value) {
  applySettings({ closeToTray: value });
  try {
    await store.saveSettings({ ...(await store.loadSettings()), closeToTray: value });
  } catch (error) {
    console.error('[jammylayer] could not save the close preference:', error);
  }
  buildTrayMenu();
}

function buildTrayMenu() {
  const items = [
    { label: `Serving ${baseUrl()}`, enabled: false },
    { type: 'separator' },
    { label: 'Open setup…', click: showWindow },
    { label: 'Copy overlay URL', click: () => clipboard.writeText(`${baseUrl()}/`) },
  ];

  items.push(
    { type: 'separator' },
    {
      label: 'Keep running when I close the window',
      type: 'checkbox',
      checked: Boolean(config.closeToTray),
      click: (item) => setCloseToTray(item.checked),
    },
  );

  // Not supported on Linux, where autostart is a .desktop file the user manages.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    items.push(
      { type: 'separator' },
      {
        label: 'Start when I sign in',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
          buildTrayMenu();
        },
      },
    );
  }

  items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/**
 * The app was called "spotify-obs-overlay" before the rename, and Electron
 * derives the per-user directory from the app name — so without this the rename
 * would strand the refresh token and the saved client credentials in a folder
 * nothing reads any more. Copies once, and never over a file that already
 * exists, so it cannot clobber newer state.
 */
async function adoptLegacyData(dataDir) {
  const legacy = join(dirname(dataDir), 'spotify-obs-overlay');
  if (legacy === dataDir) return;

  for (const name of ['tokens.json', 'settings.json']) {
    try {
      await access(join(dataDir, name));
      continue;
    } catch {
      /* not there yet — a candidate for adoption */
    }
    try {
      await mkdir(dataDir, { recursive: true });
      await copyFile(join(legacy, name), join(dataDir, name));
      console.log(`[jammylayer] carried ${name} over from ${legacy}`);
    } catch {
      /* no legacy install, or nothing to carry over */
    }
  }
}

async function main() {
  await app.whenReady();

  // Settings live beside the token file in Electron's per-user directory, so an
  // installed build never writes inside its own program folder. start() reads
  // that file itself; these three are ours to impose.
  const dataDir = app.getPath('userData');
  await adoptLegacyData(dataDir);
  configure({ dataDir, host: '127.0.0.1', allowSetup: true, desktop: true });

  try {
    await start();
  } catch (error) {
    const message = error.code === 'EADDRINUSE'
      ? `Port ${config.port} is already in use.\n\n`
        + 'Another copy of the overlay may already be running. To pick a different port, '
        + `set "port" in:\n${join(dataDir, 'settings.json')}\n\n`
        + 'Update the redirect URI in your Spotify app to match.'
      : error.message;
    dialog.showErrorBox('JammyLayer could not start', message);
    app.exit(1);
    return;
  }

  // The setup page picks the new state up over its own event stream; this is
  // only about which window the user is looking at when it does.
  onConnected(surface);

  // Changed from the setup page: a context menu is built once, so it has to be
  // rebuilt to show the new state. The other direction is covered by the page
  // re-reading /api/config whenever it regains focus.
  onSettingsChanged(() => buildTrayMenu());

  tray = new Tray(trayIcon());
  tray.setToolTip('JammyLayer');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  buildTrayMenu();

  // Launched by the autostart entry: come up silently in the tray.
  if (!app.getLoginItemSettings().wasOpenedAsHidden) showWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // Closing the settings window is not quitting — the server lives in the tray.
  app.on('window-all-closed', () => {});
  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; });

  app.on('will-quit', (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    stop().finally(() => app.exit(0));
  });

  main();
}
