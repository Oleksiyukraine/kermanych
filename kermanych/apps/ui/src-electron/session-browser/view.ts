// The state main keeps per session browser (docs/specs/2026-10-05-embedded-browser.md), shared
// by browsers.ts (lifecycle, operator side, IPC) and actions.ts (the agent's tools).
import type { WebContents, WebContentsView } from 'electron';
import type { BrowserConsoleEntry, BrowserDialogInfo, BrowserNetworkEntry } from '@kermanych/api';

// Size of a view the agent created before the operator ever showed it (the agent's viewport).
export const DEFAULT_SIZE = { width: 1280, height: 800 };
export const CONSOLE_LIMIT = 200;
export const NETWORK_LIMIT = 300;
// How long a navigation (or a click/key that started one) may take before the tool returns
// anyway; the page keeps loading and the agent sees `loading` in the next snapshot.
export const SETTLE_MS = 15_000;

export interface SessionView {
  sessionId: string;
  projectId: string;
  view: WebContentsView;
  wc: WebContents;
  // The size the page lays out at while parked: the pane's size when it was last shown, or
  // DEFAULT_SIZE for a view the operator never looked at. A parked view keeps it so the page
  // does not re-lay out (a `viewport` overrides it).
  width: number;
  height: number;
  // The layout viewport the operator or the agent picked (null: follow the pane). Wider than
  // the pane, the page is laid out at `viewport.width` and drawn scaled down by `scale`
  // (webContents.enableDeviceEmulation); CDP input is in that scaled space, so a click at
  // CSS point (x, y) is dispatched at (x * scale, y * scale).
  viewport: { width: number; height?: number } | null;
  scale: number;
  log: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  // requestId → its entry in `network`, updated in place while in flight (responseReceived,
  // loadingFinished and loadingFailed carry no URL).
  requests: Map<string, BrowserNetworkEntry>;
  // HTTP status of the last main-frame navigation.
  status?: number | undefined;
  // The last main-frame load failure of the current navigation; cleared by the next one.
  error?: { code: number; description: string; url: string } | undefined;
  // Why the page's renderer process died (Electron's reason: `crashed`, `oom`, `killed`, …);
  // undefined while it lives. The next navigation brings it back.
  crashed?: string | undefined;
  // A JavaScript dialog (alert/confirm) the page is blocked on. While it is open the page's
  // main thread answers no CDP command, so every tool but browser_dialog / console / network
  // refuses (assertNoDialog).
  dialog?: BrowserDialogInfo | undefined;
  // Answers the open dialog (Electron's dialog callback, wrapped by browsers.ts so it also
  // clears `dialog` and tells the pane). Set exactly while `dialog` is.
  dialogReply?: ((accept: boolean) => void) | undefined;
  // Called with the dialog the moment one opens: an in-flight action that triggered it
  // returns early instead of hanging until the CDP timeout (actions.settle).
  dialogWaiters: Set<(d: BrowserDialogInfo) => void>;
  // The page asked for HTTP sign-in (basic/digest, a proxy) and waits for the operator; `reply`
  // passes the credentials on (no arguments cancels) and clears the 2-minute auto-cancel.
  auth?: { id: string; host: string; realm: string; isProxy: boolean; reply: (username?: string, password?: string) => void } | undefined;
  // Find in page: the query and its last result; null while the operator's find bar is closed.
  find: { query: string; matches: number; active: number } | null;
  // The operator took control: the agent's tools refuse until they hand it back.
  agentPaused: boolean;
  agentAt: number;
  // Agent tool calls on this view in flight. CDP input emits `before-mouse-event` exactly like
  // the operator's mouse (probed), so a mouse press counts as the operator's only while this is 0.
  agentBusy: number;
  // Epoch ms the view was last shown or used by the agent (idle eviction).
  usedAt: number;
  // The last separate popup window the page opened (window.open with features): an action
  // started at or before `at` reports it, since the agent cannot drive that window.
  popup?: { url: string; at: number } | undefined;
  // Until then a focus the view takes was not the operator's doing (a load the agent or a
  // popup started): browsers.ts hands the keyboard back to the app window.
  suppressFocusUntil: number;
  // Resolves the pending pick with null from main's side (cancel, navigation, close).
  endPick?: (() => void) | undefined;
  // Re-attach the debugger after DevTools or a crash dropped it (set by browsers.ts).
  ensureDebugger: () => void;
}

export function assertNoDialog(v: SessionView): void {
  const d = v.dialog;
  if (d) {
    throw new Error(
      `A JavaScript ${d.type} dialog is open on the page («${d.message}»); the page is blocked until it is answered — call browser_dialog first`,
    );
  }
}
