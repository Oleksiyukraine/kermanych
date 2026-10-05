import { contextBridge, ipcRenderer } from 'electron';

// main passes --api-base=<url> via webPreferences.additionalArguments.
const arg = process.argv.find((a) => a.startsWith('--api-base='));
const apiBase = arg ? arg.slice('--api-base='.length) : 'http://localhost:4317/api';

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
    hide: () => ipcRenderer.send('kermanych:browser:hide'),
    navigate: (sessionId, projectId, url) => ipcRenderer.invoke('kermanych:browser:navigate', sessionId, projectId, url),
    back: (sessionId) => ipcRenderer.send('kermanych:browser:back', sessionId),
    forward: (sessionId) => ipcRenderer.send('kermanych:browser:forward', sessionId),
    reload: (sessionId) => ipcRenderer.send('kermanych:browser:reload', sessionId),
    openDevTools: (sessionId) => ipcRenderer.send('kermanych:browser:devtools', sessionId),
    pick: (sessionId) => ipcRenderer.invoke('kermanych:browser:pick', sessionId),
    cancelPick: (sessionId) => ipcRenderer.send('kermanych:browser:cancel-pick', sessionId),
    state: (sessionId) => ipcRenderer.invoke('kermanych:browser:state', sessionId),
    onState: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, state: KermanychBrowserState) => cb(state);
      ipcRenderer.on('kermanych:browser:state-changed', listener);
      return () => ipcRenderer.removeListener('kermanych:browser:state-changed', listener);
    },
  } satisfies KermanychBrowserBridge,
});
