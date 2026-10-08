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
  // The layout width (and, for a view nobody is looking at, height) the page is shown at;
  // null follows the pane.
  type KermanychBrowserViewport = { width: number; height?: number } | null;
  interface KermanychBrowserState {
    sessionId: string;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    // Epoch ms of the agent's last browser tool call on this session, 0 when never.
    agentAt: number;
    // The operator took control: the agent's browser tools refuse until it is handed back.
    agentPaused: boolean;
    viewport: KermanychBrowserViewport;
    // < 1 when the viewport is wider than the pane and the page is drawn scaled down.
    scale: number;
    // The current navigation's main-frame failure (connection refused, DNS, …); null once a
    // page loads. The pane shows it instead of the blank view.
    error: { code: number; description: string; url: string } | null;
    // The page's renderer process died; reload (or navigate) brings it back.
    crashed: boolean;
    // A JavaScript dialog the page is blocked on (answered by the operator or the agent).
    dialog: { type: 'alert' | 'confirm'; message: string } | null;
    // The page asked for HTTP sign-in (basic/digest auth or a proxy); answerAuth replies.
    auth: { id: string; host: string; realm: string; isProxy: boolean } | null;
    // Find in page: the last result (null while the find bar is closed).
    find: { query: string; matches: number; active: number } | null;
  }
  // One element the operator clicked in Design-mode picking.
  interface KermanychBrowserPick {
    url: string;
    // A CSS selector unique in the document at pick time (inside `frame` when set).
    selector: string;
    // The same-origin iframe the element is in (its URL), when not the top document.
    frame?: string;
    tag: string;
    // Visible text, trimmed to a few hundred characters.
    text: string;
    // outerHTML, long attribute values and deep children trimmed (a few KB at most).
    html: string;
    // A curated subset of computed styles (layout, box model, typography, colours).
    styles: Record<string, string>;
    // Viewport-relative CSS pixels at pick time.
    rect: KermanychBrowserBounds;
    // The page's layout viewport and scroll offset at pick time (CSS pixels): breakpoints and
    // position matter for most layout bugs.
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    // The click held Shift: the operator wants to keep picking.
    more: boolean;
    // The component that rendered it, when the page is a dev build that exposes it
    // (Vue `__file`, React `_debugSource`, Svelte `__svelte_meta`).
    source?: { file: string; line?: number; component?: string };
    // A cropped PNG of the element; `path` is the same image on disk (a temp file) so a
    // text-only agent (native session) can open it.
    screenshot?: { data: string; mimeType: 'image/png'; path: string };
  }
  // A key press in the page that belongs to the app (the address bar, find): main forwards it.
  type KermanychBrowserShortcut = 'focus-address' | 'find';
  interface KermanychBrowserBridge {
    // Attach the session's view at `bounds` (creating it on first use) and park any other.
    show: (sessionId: string, projectId: string, bounds: KermanychBrowserBounds) => void;
    // Park whichever view is shown (it keeps running, invisible). With `freeze`, resolves with a
    // PNG data URL of what it showed, captured just before parking, for the pane to display in
    // its place while an overlay is open; otherwise (or when capture fails) null.
    hide: (opts?: { freeze?: boolean }) => Promise<string | null>;
    // Rejects with the load error; the pane also gets it as `state.error`.
    navigate: (sessionId: string, projectId: string, url: string) => Promise<void>;
    back: (sessionId: string) => void;
    forward: (sessionId: string) => void;
    reload: (sessionId: string) => void;
    stop: (sessionId: string) => void;
    openDevTools: (sessionId: string) => void;
    // Resolves with the clicked element, or null when cancelled (Esc / cancelPick / navigation).
    pick: (sessionId: string) => Promise<KermanychBrowserPick | null>;
    cancelPick: (sessionId: string) => void;
    answerDialog: (sessionId: string, accept: boolean) => Promise<void>;
    // null cancels the sign-in.
    answerAuth: (sessionId: string, id: string, credentials: { username: string; password: string } | null) => void;
    setAgentPaused: (sessionId: string, paused: boolean) => void;
    setViewport: (sessionId: string, projectId: string, viewport: KermanychBrowserViewport) => void;
    // Highlight matches of `query` (next/previous with `forward`); empty query or stopFind clears.
    find: (sessionId: string, query: string, forward: boolean) => void;
    stopFind: (sessionId: string) => void;
    // Current state, or null when the session has no browser yet.
    state: (sessionId: string) => Promise<KermanychBrowserState | null>;
    // The URL the session's browser was last at (kept across restarts and idle closes), or null.
    lastUrl: (sessionId: string) => Promise<string | null>;
    // Every state change of every session's browser; returns the unsubscribe.
    onState: (cb: (state: KermanychBrowserState) => void) => () => void;
    // A session's browser was closed (deleted session, idle close); its state is gone.
    onClosed: (cb: (sessionId: string) => void) => () => void;
    onShortcut: (cb: (sessionId: string, shortcut: KermanychBrowserShortcut) => void) => () => void;
    // A download the page started finished saving.
    onDownload: (cb: (sessionId: string, file: { name: string; path: string }) => void) => () => void;
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
