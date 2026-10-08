// apps/api/src/browser/browser-host.ts
// The session browser (docs/specs/2026-10-05-embedded-browser.md) lives in the desktop app's
// main process — one Electron WebContentsView per session — while the agent reaches it through
// this api's MCP endpoint (browser-mcp.service.ts). The api imports nothing from electron, so
// main hands its implementation in through `bootstrap({ browser })`; a standalone api (`pnpm
// dev:api`, a preview api) has none, and then no session is offered the browser tools at all.
//
// Every method throws an Error whose message is meant for the agent (the MCP service returns
// it as the tool's error): no page yet, the operator paused the agent, a JavaScript dialog is
// blocking the page, an element is covered, …

// Which session's browser, and the project whose cookie jar (Electron partition) it uses.
export interface BrowserTarget {
  sessionId: string;
  projectId: string;
}

// Where the page is after an action: the agent reads it to see whether a click navigated.
export interface BrowserPageInfo {
  url: string;
  title: string;
}

// A JavaScript dialog the page opened and is blocked on until it is answered. Only these two
// reach the session browser: Electron's renderer throws on prompt(), and «Leave site?»
// (beforeunload) is always allowed.
export interface BrowserDialogInfo {
  type: "alert" | "confirm";
  message: string;
}

// The page after an input action, plus what the action set off that the agent must know about.
export interface BrowserActionResult extends BrowserPageInfo {
  // The action opened a dialog; the page waits for browser_dialog.
  dialog?: BrowserDialogInfo;
  // The action opened a separate popup window (window.open with features, e.g. an OAuth
  // sign-in). It is the operator's to complete; the agent cannot drive it.
  popup?: string;
}

export interface BrowserConsoleEntry {
  // console.* level, or `network` for a failed / 4xx / 5xx request, or `page` for a failed load
  // and other page events (a download, a popup, a blocked external link).
  level: "debug" | "info" | "warning" | "error" | "network" | "page";
  text: string;
  // Source location for console messages, the request URL for network entries.
  source?: string;
  at: number; // epoch ms
}

// One request the page made (main frame and subresources, fetch/XHR included).
export interface BrowserNetworkEntry {
  method: string;
  url: string;
  // CDP resource type: Document, Script, Fetch, XHR, Image, …
  type?: string;
  status?: number;
  // Network error text when the request failed (net::ERR_…, blocked reasons).
  failed?: string;
  // Duration until the response finished or failed; absent while in flight.
  ms?: number;
  at: number; // epoch ms the request started
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserHost {
  // Load `url` and resolve once the load settles (or a bounded wait elapses). Creates the
  // session's browser when it does not exist yet.
  navigate(target: BrowserTarget, url: string): Promise<BrowserPageInfo & { status?: number }>;
  // A text outline of the page. Interactive elements carry refs (`e1`, `e2`, …) that the
  // element tools accept; refs are reassigned by every snapshot. Same-origin iframes are
  // included; cross-origin ones are named only.
  snapshot(target: BrowserTarget): Promise<BrowserPageInfo & { text: string }>;
  // `ref` from the last snapshot, or a CSS selector. Refuses (throws) when another element
  // covers the target's click point, naming the covering element.
  click(target: BrowserTarget, ref: string): Promise<BrowserActionResult>;
  type(target: BrowserTarget, ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<BrowserActionResult>;
  // A key name as in KeyboardEvent.key (`Enter`, `Escape`, `ArrowDown`, `a`), optionally with
  // modifiers joined by `+` (`Meta+a`, `Shift+Tab`).
  press(target: BrowserTarget, key: string): Promise<BrowserActionResult>;
  // Move the mouse over the element (hover menus, tooltips).
  hover(target: BrowserTarget, ref: string): Promise<BrowserActionResult>;
  // Choose options of a <select> by value or visible label; resolves with the labels selected.
  select(target: BrowserTarget, ref: string, values: string[]): Promise<BrowserActionResult & { selected: string[] }>;
  history(target: BrowserTarget, action: "back" | "forward" | "reload"): Promise<BrowserActionResult>;
  // Wait until `text` appears in the page / `selector` matches (or, with `gone`, until it no
  // longer does). Throws on timeout.
  waitFor(
    target: BrowserTarget,
    opts: { text?: string; selector?: string; gone: boolean; timeoutMs: number },
  ): Promise<BrowserPageInfo & { waitedMs: number }>;
  // Lay the page out at `width` (and `height` while the operator is not looking at it); null
  // follows the operator's pane again. Resolves with the viewport in effect.
  resize(target: BrowserTarget, viewport: { width: number; height?: number } | null): Promise<BrowserPageInfo & { viewport: BrowserViewport }>;
  // PNG, base64: the viewport, the whole page (`fullPage`) or one element (`ref`).
  screenshot(target: BrowserTarget, opts: { fullPage: boolean; ref?: string }): Promise<{ data: string; mimeType: "image/png" }>;
  // Set the files of an <input type=file> (absolute paths on this machine).
  upload(target: BrowserTarget, ref: string, paths: string[]): Promise<BrowserActionResult>;
  // Answer the open JavaScript dialog. Throws when none is open.
  dialog(target: BrowserTarget, opts: { accept: boolean }): Promise<BrowserActionResult>;
  // Console messages and network failures since the browser was created or last cleared.
  console(target: BrowserTarget, opts: { clear: boolean }): Promise<BrowserConsoleEntry[]>;
  // Requests since the browser was created or last cleared, oldest first; `filter` keeps those
  // whose URL contains it.
  network(target: BrowserTarget, opts: { clear: boolean; filter?: string }): Promise<BrowserNetworkEntry[]>;
  // Evaluate a JavaScript expression in the page (promises are awaited); the result as JSON
  // text, or the thrown error's message.
  evaluate(target: BrowserTarget, expression: string): Promise<string>;
  // Whether this session's browser exists right now.
  has(sessionId: string): boolean;
  // Destroy the session's browser and its temp files (the session was deleted). No-op when
  // there is none.
  close(sessionId: string): void;
}

let host: BrowserHost | undefined;

export function setBrowserHost(next: BrowserHost | undefined): void {
  host = next;
}

export function browserHost(): BrowserHost | undefined {
  return host;
}
