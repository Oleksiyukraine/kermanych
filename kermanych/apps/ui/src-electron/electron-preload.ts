import { contextBridge, ipcRenderer } from 'electron';

// main passes --api-base=<url> via webPreferences.additionalArguments.
const arg = process.argv.find((a) => a.startsWith('--api-base='));
const apiBase = arg ? arg.slice('--api-base='.length) : 'http://localhost:4317/api';

contextBridge.exposeInMainWorld('kermanych', {
  apiBase,
  focus: () => ipcRenderer.send('kermanych:focus'),
});
