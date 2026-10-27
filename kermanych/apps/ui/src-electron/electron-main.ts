import { app, BrowserWindow, ipcMain, dialog, nativeImage, powerSaveBlocker, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@kermanych/api';
import type { INestApplication } from '@nestjs/common';
import { closeLoopback, startLoopbackOAuth } from './oauth-loopback';
import { routeLinksToDefaultBrowser } from './external-links';
import { htmlToPdf } from './print-pdf';
import { SessionBrowsers } from './session-browser';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

let mainWindow: BrowserWindow | undefined;
let nest: INestApplication | undefined;
// The session browser: its IPC is registered now, its views live in the window once attached,
// and the api reaches it as the BrowserHost behind the agents' browser_* MCP tools.
const browsers = new SessionBrowsers();
// The per-launch secret that lets this window's renderer — and nothing else — hand the local api
// a session (apps/api/src/auth/ui-proof.ts). The api learns it through bootstrap(), the
// renderer through the preload; a web page in the operator's browser never sees it.
const uiKey = randomBytes(32).toString('hex');

// Prefer 4317; fall back to an OS-assigned free port if it is taken.
function freePort(preferred: number): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.once('error', () => {
    // Preferred port is taken: grab an OS-assigned free port instead.
    const any = createServer();
    any.listen(0, '127.0.0.1', () => {
      const addr = any.address();
      const p = typeof addr === 'object' && addr ? addr.port : preferred;
      any.close(() => resolve(p));
    });
  });
  srv.listen(preferred, '127.0.0.1', () => srv.close(() => resolve(preferred)));
  return promise;
}

// Start-up runs in parallel (docs/specs/2026-10-21-async-feedback.md, decision 10): the window
// is created as soon as the port is chosen, so its splash covers the seconds `bootstrap()` takes
// instead of the operator staring at nothing. The renderer's first boot file awaits
// `kermanych:backend-ready` before anything talks to the api.
const backend = Promise.withResolvers<void>();
// The renderer may not have asked yet when bootstrap fails; the failure is reported by the
// error box below, so an unobserved rejection here is not a second error.
backend.promise.catch(() => {});
ipcMain.handle('kermanych:backend-ready', () => backend.promise);

// What the splash says. Kept so a page that loads after a change (dev reload) still gets it:
// the status is re-sent on dom-ready, and the preload replays the latest one to late listeners.
let bootStatus: KermanychBootStatus = 'backend';
function setBootStatus(status: KermanychBootStatus): void {
  bootStatus = status;
  mainWindow?.webContents.send('kermanych:boot-status', status);
}

// While a «Посіпака» run is in progress the api holds the machine awake
// (docs/specs/2026-10-23-minion-auto-run.md, decision 13): `prevent-app-suspension` keeps the
// Mac out of idle sleep and the app from being suspended, while the screen may still turn off.
// The api reports every change of «any run in progress», so the hook is idempotent: one blocker
// at most, released when the last run ends.
let awakeBlocker: number | undefined;
function keepAwake(hold: boolean): void {
  if (hold) {
    if (awakeBlocker === undefined || !powerSaveBlocker.isStarted(awakeBlocker)) {
      awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else if (awakeBlocker !== undefined) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = undefined;
  }
}

async function startBackend(port: number): Promise<void> {
  try {
    const res = await bootstrap({ port, browser: browsers, keepAwake, uiKey });
    nest = res.app;
    backend.resolve();
    setBootStatus('ready');
  } catch (err) {
    backend.reject(err as Error);
    throw err;
  }
}

// The window's own colour, painted before the page: the canvas of the theme the renderer last
// applied (it reports it over `kermanych:theme`), so a light-theme operator gets no dark frame.
// Stored in userData rather than read from the renderer's localStorage, which main cannot
// reach before the page loads.
const themeFile = path.join(app.getPath('userData'), 'window-theme.json');
// `--k-canvas` of the dark set in @kermanych/tokens: dark is the app's default theme regardless
// of the OS preference (lib/theme.ts DEFAULT_THEME), so a first launch paints dark too.
const DEFAULT_BACKGROUND = '#050505';
const COLOR = /^#[0-9a-f]{3,8}$/i;
let windowBackground = readWindowBackground();

function readWindowBackground(): string {
  try {
    const bg = (JSON.parse(readFileSync(themeFile, 'utf8')) as { background?: unknown }).background;
    if (typeof bg === 'string' && COLOR.test(bg)) return bg;
  } catch {
    /* first launch or an unreadable file: the default theme's canvas */
  }
  return DEFAULT_BACKGROUND;
}

ipcMain.on('kermanych:theme', (_event, background: unknown) => {
  if (typeof background !== 'string' || !COLOR.test(background) || background === windowBackground) return;
  windowBackground = background;
  mainWindow?.setBackgroundColor(background);
  void writeFile(themeFile, JSON.stringify({ background })).catch(() => {});
});

async function createWindow(apiBase: string) {
  mainWindow = new BrowserWindow({
    icon: path.resolve(currentDir, 'icons/icon.png'), // tray icon
    width: 1400,
    height: 900,
    useContentSize: true,
    // Shown on ready-to-show, i.e. once the splash in index.html has painted, over a
    // background of the operator's theme — never a white or wrong-theme frame.
    show: false,
    backgroundColor: windowBackground,
    webPreferences: {
      contextIsolation: true,
      sandbox: false, // preload needs process.argv to read --api-base and --ui-key
      plugins: true, // Chromium's built-in PDF viewer — the file viewers' PDF preview
      // More info: https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/electron-preload-script
      preload: path.resolve(
        currentDir,
        path.join(process.env.QUASAR_ELECTRON_PRELOAD_FOLDER, 'electron-preload' + process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION)
      ),
      additionalArguments: [`--api-base=${apiBase}`, `--ui-key=${uiKey}`],
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('dom-ready', () => mainWindow?.webContents.send('kermanych:boot-status', bootStatus));
  routeLinksToDefaultBrowser(mainWindow, (url) => shell.openExternal(url));
  browsers.attach(mainWindow);

  if (process.env.DEV) {
    // Vite serves optimized deps as `immutable` under a `?v=<browserHash>` query that does NOT
    // change when a linked workspace dep (@kermanych/core) is rebuilt with new content. Electron's
    // persistent Chromium cache then serves a stale dep across restarts — a fresh core export (e.g.
    // buildChatBlocks) reads as `undefined` and the panel throws on open. Drop the HTTP cache each
    // dev launch so the renderer always fetches the freshly-optimized modules.
    await mainWindow.webContents.session.clearCache();
    await mainWindow.loadURL(process.env.APP_URL);
  } else {
    await mainWindow.loadFile('index.html');
  }

  if (process.env.DEBUGGING) {
    // if on DEV or Production with debug enabled
    mainWindow.webContents.openDevTools();
  } else {
    // we're on production; no access to devtools pls
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

ipcMain.on('kermanych:focus', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// The renderer builds the authorize URL (the PKCE verifier must stay in its own
// storage) and we run the round trip: open the system browser, catch the
// loopback redirect, hand back the code. First invoke/handle pair in the app.
ipcMain.handle('kermanych:oauth', async (_event, authorizeUrl: string) => {
  return await startLoopbackOAuth(authorizeUrl, (url) => shell.openExternal(url));
});

// A register export's PDF. The bytes go back to the renderer, which saves them through the
// same download path as the Excel export, so both formats end in the same Save dialog.
ipcMain.handle('kermanych:print-pdf', async (_event, html: string) => await htmlToPdf(html));

void app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin' && process.env.DEV) {
      // Dev launches the stock Electron.app from node_modules, whose Dock icon is
      // Electron's default atom. Our bundle icon (src-electron/icons/icon.icns) only
      // applies to packaged builds, and BrowserWindow.icon is ignored on macOS — so
      // set the Dock icon explicitly in dev, resolving the PNG from the source tree
      // (Quasar does not copy icons/ next to the compiled main).
      const devIcon = nativeImage.createFromPath(
        path.resolve(currentDir, '../../src-electron/icons/icon.png'),
      );
      if (!devIcon.isEmpty()) app.dock?.setIcon(devIcon);
    }
    // bootstrap() listens on 127.0.0.1:<port> and serves under /api, so the api base is known
    // before it finishes and the window need not wait for it.
    const port = await freePort(4317);
    await Promise.all([startBackend(port), createWindow(`http://127.0.0.1:${port}/api`)]);
  } catch (err) {
    dialog.showErrorBox('Kermanych failed to start', String((err as Error).stack ?? err));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
  // A half-finished OAuth round trip would otherwise keep an HTTP handle open
  // and stop the app from quitting.
  closeLoopback();
  if (nest) {
    e.preventDefault();
    const closing = nest;
    nest = undefined;
    // nest.close() runs each module's onModuleDestroy: SupervisorService stops the omp
    // rpc children and PreviewService stops preview children. finally() guarantees quit
    // even if a child's stop() rejects, so the app can never get stuck un-quittable.
    void closing.close().finally(() => app.quit());
  }
});
