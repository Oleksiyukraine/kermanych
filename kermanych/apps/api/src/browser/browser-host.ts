// apps/api/src/browser/browser-host.ts
// The session browser (docs/specs/2026-10-05-embedded-browser.md) lives in the desktop app's
// main process — one Electron WebContentsView per session — while the agent reaches it through
// this api's MCP endpoint (browser-mcp.service.ts). The api imports nothing from electron, so
// main hands its implementation in through `bootstrap({ browser })`; a standalone api (`pnpm
// dev:api`, a preview api) has none, and then no session is offered the browser tools at all.

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

export interface BrowserConsoleEntry {
  // console.* level, or `network` for a failed / 4xx / 5xx request, or `page` for a failed load.
  level: "debug" | "info" | "warning" | "error" | "network" | "page";
  text: string;
  // Source location for console messages, the request URL for network entries.
  source?: string;
  at: number; // epoch ms
}

export interface BrowserHost {
  // Load `url` and resolve once the load settles (or a bounded wait elapses). Creates the
  // session's browser when it does not exist yet.
  navigate(target: BrowserTarget, url: string): Promise<BrowserPageInfo & { status?: number }>;
  // A text outline of the visible page. Interactive elements carry refs (`e1`, `e2`, …) that
  // click/type accept; refs are reassigned by every snapshot.
  snapshot(target: BrowserTarget): Promise<BrowserPageInfo & { text: string }>;
  // `ref` from the last snapshot, or a CSS selector.
  click(target: BrowserTarget, ref: string): Promise<BrowserPageInfo>;
  type(target: BrowserTarget, ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<BrowserPageInfo>;
  // A key name as in KeyboardEvent.key (`Enter`, `Escape`, `ArrowDown`, `a`), optionally with
  // modifiers joined by `+` (`Meta+a`, `Shift+Tab`).
  press(target: BrowserTarget, key: string): Promise<BrowserPageInfo>;
  // The visible viewport as PNG, base64.
  screenshot(target: BrowserTarget): Promise<{ data: string; mimeType: "image/png" }>;
  // Console messages and network failures since the browser was created or last cleared.
  console(target: BrowserTarget, opts: { clear: boolean }): Promise<BrowserConsoleEntry[]>;
  // Evaluate a JavaScript expression in the page (promises are awaited); the result as JSON
  // text, or the thrown error's message.
  evaluate(target: BrowserTarget, expression: string): Promise<string>;
  // Whether this session's browser exists right now.
  has(sessionId: string): boolean;
  // Destroy the session's browser (the session was deleted). No-op when there is none.
  close(sessionId: string): void;
}

let host: BrowserHost | undefined;

export function setBrowserHost(next: BrowserHost | undefined): void {
  host = next;
}

export function browserHost(): BrowserHost | undefined {
  return host;
}
