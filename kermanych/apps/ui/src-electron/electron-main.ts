import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@kermanych/api';
import type { INestApplication } from '@nestjs/common';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

let mainWindow: BrowserWindow | undefined;
let nest: INestApplication | undefined;

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

async function startBackend(): Promise<string> {
  const port = await freePort(4317);
  const res = await bootstrap({ port });
  nest = res.app;
  return `${res.url}/api`;
}

async function createWindow(apiBase: string) {
  mainWindow = new BrowserWindow({
    icon: path.resolve(currentDir, 'icons/icon.png'), // tray icon
    width: 1400,
    height: 900,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false, // preload needs process.argv to read --api-base
      // More info: https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/electron-preload-script
      preload: path.resolve(
        currentDir,
        path.join(process.env.QUASAR_ELECTRON_PRELOAD_FOLDER, 'electron-preload' + process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION)
      ),
      additionalArguments: [`--api-base=${apiBase}`],
    },
  });

  if (process.env.DEV) {
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

void app.whenReady().then(async () => {
  try {
    const apiBase = await startBackend();
    await createWindow(apiBase);
  } catch (err) {
    dialog.showErrorBox('Kermanych failed to start', String((err as Error).stack ?? err));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
  if (nest) {
    e.preventDefault();
    const closing = nest;
    nest = undefined;
    // runs onModuleDestroy: kills omp rpc + preview children
    void closing.close().then(() => app.quit());
  }
});
