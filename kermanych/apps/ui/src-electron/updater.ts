import { app, ipcMain, net, type BrowserWindow } from 'electron';
// electron-updater is CommonJS; its named exports are getters Node's ESM loader cannot see.
import updaterPkg from 'electron-updater';

// Automatic updates from GitHub Releases (spec: docs/specs/2026-10-12-desktop-releases-and-
// updates.md, decisions 1, 2 and 7). The feed itself (`app-update.yml`, written into the bundle
// from quasar.config.ts `publish`) names the repository; REPO below is only for the raw
// CHANGELOG.md the banner's «What's new» reads.
//
// Behaviour: check at launch and every 4 hours, download in the background, install on the
// next normal quit or when the renderer asks for a restart. Never restart on our own. Errors
// (offline, an unsigned local build Squirrel refuses) are logged and retried next cycle.

const { autoUpdater } = updaterPkg;
const REPO = 'Oleksiyukraine/kermanych';
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let state: KermanychUpdateState = { phase: 'idle' };
let target: BrowserWindow | undefined;

function publish(next: KermanychUpdateState): void {
  state = next;
  if (target && !target.isDestroyed()) target.webContents.send('kermanych:update:state-changed', state);
}

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[kermanych] update check failed:', (err as Error).message);
  }
}

// Wires the IPC the preload's `updates` bridge talks to. Registered in every run so a dev
// renderer gets an answer (`idle`) rather than a rejected invoke; only a packaged app that the
// updater can actually replace ever checks.
export function startUpdater(): void {
  ipcMain.handle('kermanych:update:state', () => state);
  ipcMain.handle('kermanych:update:check', () => check());
  ipcMain.on('kermanych:update:install', () => {
    // isForceRunAfter: an AppImage relaunches only when asked (Squirrel.Mac always does).
    // The quit still runs before-quit, which stops the api and its children first.
    if (state.phase === 'ready') autoUpdater.quitAndInstall(true, true);
  });
  // The banner's «What's new» before installing: the CHANGELOG.md as of the downloaded tag.
  // The renderer cuts out the versions between its own and that one (changelogBetween).
  ipcMain.handle('kermanych:update:changelog', async (_e, version: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    try {
      const res = await net.fetch(`https://raw.githubusercontent.com/${REPO}/v${version}/kermanych/CHANGELOG.md`);
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  });

  // electron-updater replaces only an AppImage on Linux; any other launch (a dev tree, an
  // unpacked build) has nothing it could swap.
  const updatable = app.isPackaged && (process.platform !== 'linux' || !!process.env.APPIMAGE);
  if (!updatable) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => publish({ phase: 'downloading', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => publish({ phase: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    console.warn('[kermanych] updater error:', err.message);
    // A failed download goes back to idle; a finished one stays installable.
    if (state.phase === 'downloading') publish({ phase: 'idle' });
  });
  void check();
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
}

// The window that receives state changes; the renderer also asks for the current state on
// mount, so a window created after a download still shows the banner.
export function attachUpdaterWindow(win: BrowserWindow): void {
  target = win;
}
