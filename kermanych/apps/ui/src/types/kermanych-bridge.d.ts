// Exposed by src-electron/electron-preload.ts via contextBridge. Absent in the browser.
export {};
declare global {
  // The session browser (docs/specs/2026-10-05-embedded-browser.md): one Electron
  // WebContentsView per session, positioned by the renderer over a placeholder element.
  interface KermanychBrowserBounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  interface KermanychBrowserState {
    sessionId: string;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    // Epoch ms of the agent's last browser tool call on this session, 0 when never.
    agentAt: number;
  }
  // One element the operator clicked in Design-mode picking.
  interface KermanychBrowserPick {
    url: string;
    // A CSS selector unique in the document at pick time.
    selector: string;
    tag: string;
    // Visible text, trimmed to a few hundred characters.
    text: string;
    // outerHTML, long attribute values and deep children trimmed (a few KB at most).
    html: string;
    // A curated subset of computed styles (layout, box model, typography, colours).
    styles: Record<string, string>;
    // Viewport-relative CSS pixels at pick time.
    rect: KermanychBrowserBounds;
    // The component that rendered it, when the page is a dev build that exposes it
    // (Vue `__file`, React `_debugSource`, Svelte `__svelte_meta`).
    source?: { file: string; line?: number; component?: string };
    // A cropped PNG of the element; `path` is the same image on disk (a temp file) so a
    // text-only agent (native session) can open it.
    screenshot?: { data: string; mimeType: 'image/png'; path: string };
  }
  interface KermanychBrowserBridge {
    // Attach the session's view at `bounds` (creating it on first use) and park any other.
    show: (sessionId: string, projectId: string, bounds: KermanychBrowserBounds) => void;
    // Park whichever view is shown (it keeps running, invisible).
    hide: () => void;
    navigate: (sessionId: string, projectId: string, url: string) => Promise<void>;
    back: (sessionId: string) => void;
    forward: (sessionId: string) => void;
    reload: (sessionId: string) => void;
    openDevTools: (sessionId: string) => void;
    // Resolves with the clicked element, or null when cancelled (Esc / cancelPick / navigation).
    pick: (sessionId: string) => Promise<KermanychBrowserPick | null>;
    cancelPick: (sessionId: string) => void;
    // Current state, or null when the session has no browser yet.
    state: (sessionId: string) => Promise<KermanychBrowserState | null>;
    // Every state change of every session's browser; returns the unsubscribe.
    onState: (cb: (state: KermanychBrowserState) => void) => () => void;
  }
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
      // Electron only. Optional for the same stale-preload reason; the Браузер tab is hidden
      // without it.
      browser?: KermanychBrowserBridge;
    };
  }
}
