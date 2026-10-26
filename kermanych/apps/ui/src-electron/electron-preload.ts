import { contextBridge, ipcRenderer } from 'electron';

// main passes --api-base=<url> and --ui-key=<secret> via webPreferences.additionalArguments.
const arg = process.argv.find((a) => a.startsWith('--api-base='));
const apiBase = arg ? arg.slice('--api-base='.length) : 'http://localhost:4317/api';
const keyArg = process.argv.find((a) => a.startsWith('--ui-key='));
const uiKey = keyArg ? keyArg.slice('--ui-key='.length) : undefined;

// Subscribe to one of main's `kermanych:browser:*` events; returns the unsubscribe.
function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// The splash status from main. Listened to from the preload's first tick, before any page
// script, and the latest one is replayed to a late subscriber: the index.html splash script and
// main's sends do not otherwise agree on an order.
let bootStatus: KermanychBootStatus | undefined;
const bootListeners = new Set<(status: KermanychBootStatus) => void>();
ipcRenderer.on('kermanych:boot-status', (_event, status: KermanychBootStatus) => {
  bootStatus = status;
  for (const cb of bootListeners) cb(status);
});

contextBridge.exposeInMainWorld('kermanych', {
  apiBase,
  uiKey,
  focus: () => ipcRenderer.send('kermanych:focus'),
  // Main starts the local api in parallel with the window; resolves once it listens, rejects
  // when it failed to start (main then shows the error and quits).
  backendReady: (): Promise<void> => ipcRenderer.invoke('kermanych:backend-ready'),
  onBootStatus: (cb: (status: KermanychBootStatus) => void): (() => void) => {
    bootListeners.add(cb);
    if (bootStatus) cb(bootStatus);
    return () => bootListeners.delete(cb);
  },
  // The applied theme's canvas colour, for the next launch's window background.
  reportTheme: (background: string) => ipcRenderer.send('kermanych:theme', background),
  // Resolves { code } once the loopback listener in main catches the redirect.
  // Its presence is how stores/auth.ts detects the desktop build.
  startOAuth: (authorizeUrl: string): Promise<{ code: string }> =>
    ipcRenderer.invoke('kermanych:oauth', authorizeUrl),
  // Resolves with the PDF bytes of a standalone HTML document (a register export).
  printToPdf: (html: string): Promise<Uint8Array> => ipcRenderer.invoke('kermanych:print-pdf', html),
  // The session browser: main owns one WebContentsView per session and lays it over the
  // placeholder whose bounds the Браузер tab reports.
  browser: {
    show: (sessionId, projectId, bounds) => ipcRenderer.send('kermanych:browser:show', sessionId, projectId, bounds),
    hide: (opts) => ipcRenderer.invoke('kermanych:browser:hide', opts ?? {}),
    navigate: (sessionId, projectId, url) => ipcRenderer.invoke('kermanych:browser:navigate', sessionId, projectId, url),
    back: (sessionId) => ipcRenderer.send('kermanych:browser:back', sessionId),
    forward: (sessionId) => ipcRenderer.send('kermanych:browser:forward', sessionId),
    reload: (sessionId) => ipcRenderer.send('kermanych:browser:reload', sessionId),
    stop: (sessionId) => ipcRenderer.send('kermanych:browser:stop', sessionId),
    openDevTools: (sessionId) => ipcRenderer.send('kermanych:browser:devtools', sessionId),
    pick: (sessionId) => ipcRenderer.invoke('kermanych:browser:pick', sessionId),
    cancelPick: (sessionId) => ipcRenderer.send('kermanych:browser:cancel-pick', sessionId),
    answerDialog: (sessionId, accept) => ipcRenderer.invoke('kermanych:browser:answer-dialog', sessionId, accept),
    answerAuth: (sessionId, id, credentials) => ipcRenderer.send('kermanych:browser:answer-auth', sessionId, id, credentials),
    setAgentPaused: (sessionId, paused) => ipcRenderer.send('kermanych:browser:set-agent-paused', sessionId, paused),
    setViewport: (sessionId, projectId, viewport) => ipcRenderer.send('kermanych:browser:set-viewport', sessionId, projectId, viewport),
    find: (sessionId, query, forward) => ipcRenderer.send('kermanych:browser:find', sessionId, query, forward),
    stopFind: (sessionId) => ipcRenderer.send('kermanych:browser:stop-find', sessionId),
    close: (sessionId) => ipcRenderer.send('kermanych:browser:close', sessionId),
    state: (sessionId) => ipcRenderer.invoke('kermanych:browser:state', sessionId),
    lastUrl: (sessionId) => ipcRenderer.invoke('kermanych:browser:last-url', sessionId),
    onState: (cb) => subscribe<[KermanychBrowserState]>('kermanych:browser:state-changed', cb),
    onClosed: (cb) => subscribe<[string]>('kermanych:browser:closed', cb),
    onShortcut: (cb) => subscribe<[string, KermanychBrowserShortcut]>('kermanych:browser:shortcut', cb),
    onDownload: (cb) => subscribe<[string, { name: string; path: string }]>('kermanych:browser:download', cb),
  } satisfies KermanychBrowserBridge,
});
