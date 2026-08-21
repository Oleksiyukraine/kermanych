// Exposed by src-electron/electron-preload.ts via contextBridge. Absent in the browser.
export {};
declare global {
  interface Window {
    kermanych?: {
      apiBase: string;
      focus: () => void;
      // Electron only. The renderer cannot receive a browser redirect, so main
      // runs a one-shot loopback listener and resolves with the PKCE code.
      // Optional so a stale packaged preload degrades to the browser flow
      // instead of throwing.
      startOAuth?: (authorizeUrl: string) => Promise<{ code: string }>;
    };
  }
}
