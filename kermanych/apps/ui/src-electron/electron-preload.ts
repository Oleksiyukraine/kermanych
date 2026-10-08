import { contextBridge, ipcRenderer } from 'electron';

// main passes --api-base=<url> via webPreferences.additionalArguments.
const arg = process.argv.find((a) => a.startsWith('--api-base='));
const apiBase = arg ? arg.slice('--api-base='.length) : 'http://localhost:4317/api';

// Subscribe to one of main's `kermanych:browser:*` events; returns the unsubscribe.
function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('kermanych', {
  apiBase,
  focus: () => ipcRenderer.send('kermanych:focus'),
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
    state: (sessionId) => ipcRenderer.invoke('kermanych:browser:state', sessionId),
    lastUrl: (sessionId) => ipcRenderer.invoke('kermanych:browser:last-url', sessionId),
    onState: (cb) => subscribe<[KermanychBrowserState]>('kermanych:browser:state-changed', cb),
    onClosed: (cb) => subscribe<[string]>('kermanych:browser:closed', cb),
    onShortcut: (cb) => subscribe<[string, KermanychBrowserShortcut]>('kermanych:browser:shortcut', cb),
    onDownload: (cb) => subscribe<[string, { name: string; path: string }]>('kermanych:browser:download', cb),
  } satisfies KermanychBrowserBridge,
});
