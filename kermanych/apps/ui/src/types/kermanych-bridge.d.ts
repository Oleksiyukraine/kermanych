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
      // Electron only. Main renders a standalone HTML document in a hidden, script-less
      // window and resolves with its PDF bytes. Optional for the same stale-preload
      // reason; lib/export-file.ts falls back to the print dialog without it.
      printToPdf?: (html: string) => Promise<Uint8Array>;
    };
  }
}
