// Exposed by src-electron/electron-preload.ts via contextBridge. Absent in the browser.
export {};
declare global {
  interface Window {
    kermanych?: { apiBase: string; focus: () => void };
  }
}
