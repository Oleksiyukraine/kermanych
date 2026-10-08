// apps/api/src/browser/browser-mcp.service.ts
// The session browser's agent side (docs/specs/2026-10-05-embedded-browser.md): the tools that
// drive ONE session's embedded browser view, spoken as MCP over the local api — the same
// four-method Streamable HTTP subset as management-mcp.service.ts, so claude consumes it
// natively (SDK `mcpServers`, native `--mcp-config`) and omp through runtime/omp-mcp-bridge.ts.
//
// The bearer is per SESSION, not per child: a session's managed child and its native harness
// are relaunched freely (resume, reap, restart), and each relaunch must keep reaching the same
// browser. So the secret is minted on the session's first launch, reused by every later one
// for the life of this api process, and revoked when the session is deleted. The route is
// @Public and the bearer is the caller's whole credential; it names the session, and the tools
// act on that session's view only.
import { Injectable, Optional } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { RegistryService } from "../registry/registry.service";
import { PreviewService } from "../preview/preview.service";
import {
  browserHost,
  type BrowserActionResult,
  type BrowserNetworkEntry,
  type BrowserPageInfo,
  type BrowserTarget,
} from "./browser-host";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown };
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

// The name the server is given in the child: claude shows `mcp__kermanych__browser_*`, omp
// the bare names.
export const BROWSER_MCP_SERVER_NAME = "kermanych";
const PROTOCOL_VERSION = "2025-06-18";

// Said once in every tool's description, because a model reads tools one by one.
const SHARED =
  "This is the operator's visible browser pane in Kermanych, belonging to THIS session only and shared live with the operator: they see every page you open and may be using it themselves.";

const REF = { type: "string", description: "A ref from the latest browser_snapshot (e.g. e12), or a CSS selector." };

const TOOLS = [
  {
    name: "browser_navigate",
    description:
      `${SHARED} Load a URL in it and wait for the page to settle. Without \`url\` it opens this session's running live preview (the app built from this session's worktree). ` +
      "Answers with where the page ended up; follow with browser_snapshot to read it. A page that asks for HTTP sign-in (a browser login prompt) or opens a popup window " +
      "(e.g. an OAuth sign-in) needs the operator: ask them to complete it in the pane.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "An http(s) URL or about:blank. Omit to open the session's live preview." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      `${SHARED} A text outline of the whole page document, including same-origin iframes (cross-origin ones are named only). Interactive elements carry refs (e1, e2, …) that the element tools accept; ` +
      "every snapshot reassigns them, so take a fresh one after the page changes. Prefer this to find elements and read content; use browser_screenshot to check visuals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_click",
    description:
      `${SHARED} Click an element with a real mouse event at its visible point. Refuses when another element covers that point and names the covering element, ` +
      "so a click never silently lands on an overlay. Answers with the page's URL and title afterwards, so you can tell whether it navigated.",
    inputSchema: { type: "object", properties: { ref: REF }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "browser_type",
    description: `${SHARED} Focus an input or editable element and type text into it as real keyboard input. For a <select> use browser_select instead.`,
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        text: { type: "string", description: "The text to type." },
        clear: { type: "boolean", description: "Replace the field's current value (default true); false appends.", default: true },
        submit: { type: "boolean", description: "Press Enter after typing (default false).", default: false },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: `${SHARED} Press a key in the focused element, e.g. Enter, Escape, Tab, ArrowDown, a; modifiers join with +, e.g. Meta+a, Shift+Tab.`,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "A KeyboardEvent.key name, optionally with modifiers joined by +." } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description: `${SHARED} Move the mouse over an element, e.g. to open a hover-only menu or a tooltip; take a snapshot afterwards to see what appeared.`,
    inputSchema: { type: "object", properties: { ref: REF }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "browser_select",
    description:
      `${SHARED} Choose options of a <select> element, each by its option value or visible label. Native selects cannot be operated by clicks or keys — use this. ` +
      "Answers with the labels selected.",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        values: { type: "array", items: { type: "string" }, minItems: 1, description: "Option values or visible labels; more than one only for a multiple select." },
      },
      required: ["ref", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_history",
    description: `${SHARED} Go back, go forward or reload the page, and wait for it to settle.`,
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["back", "forward", "reload"] } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description:
      `${SHARED} Wait until a text appears in the page or a CSS selector matches (with \`gone\`, until it no longer does). Give exactly one of \`text\` and \`selector\`. ` +
      "Use it instead of sleeping after an action that loads content.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to look for in the page." },
        selector: { type: "string", description: "A CSS selector to look for." },
        gone: { type: "boolean", description: "Wait for it to disappear instead (default false).", default: false },
        timeout: { type: "number", description: "Seconds to wait (default 10, max 60).", default: 10, minimum: 0, maximum: 60 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_resize",
    description:
      `${SHARED} Lay the page out at a given viewport width (e.g. to check a mobile layout), and height while the operator is not looking at the pane; ` +
      "the operator sees the same viewport (scaled to fit their pane), and while they are looking the height follows their pane. " +
      "`{reset: true}` goes back to following the operator's pane.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer", minimum: 320, maximum: 3840, description: "Viewport width in CSS pixels." },
        height: { type: "integer", minimum: 240, maximum: 2400, description: "Viewport height in CSS pixels." },
        reset: { type: "boolean", description: "Follow the operator's pane again; not combined with width/height." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      `${SHARED} A PNG of the visible viewport, the whole page (\`full_page\`) or one element (\`ref\`). Use it to check layout and visuals; ` +
      "to find elements or read text, browser_snapshot is cheaper and gives refs.",
    inputSchema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture the whole scrollable page (default false).", default: false },
        ref: { ...REF, description: "Capture only this element: a ref from the latest browser_snapshot, or a CSS selector." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload",
    description: `${SHARED} Set the files of an <input type=file> element without the native file dialog.`,
    inputSchema: {
      type: "object",
      properties: {
        ref: REF,
        paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Absolute paths of files on this machine." },
      },
      required: ["ref", "paths"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_dialog",
    description: `${SHARED} Answer the JavaScript dialog (alert or confirm) the page is blocked on. The operator sees it too and may answer it first.`,
    inputSchema: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "OK (true) or Cancel (false)." },
      },
      required: ["accept"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    description: `${SHARED} Console messages, failed requests and 4xx/5xx responses collected since the browser opened or was last cleared — check it after something does not work.`,
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", description: "Clear the collected entries after reading them (default false).", default: false } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    description: `${SHARED} Requests the page made (method, status, type, duration, URL) since the browser opened or was last cleared, oldest first.`,
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "Clear the collected requests after reading them (default false).", default: false },
        filter: { type: "string", description: "Keep only requests whose URL contains this text." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description: `${SHARED} Evaluate a JavaScript expression in the page (a promise is awaited) and answer with its result as JSON. It runs in the operator's live page: avoid side effects they did not ask for.`,
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "A JavaScript expression, e.g. document.title or (async () => { … })()." } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
];

// Tools that skip the session's queue. browser_dialog must reach a page whose queued action is
// itself blocked on that very dialog (actions return early when they open one, but a dialog the
// page opens on its own — a timer, a late handler — can still catch an action mid-flight), and
// browser_console / browser_network only read buffers the main process collects, which is how
// the agent finds out why an action hangs.
const UNQUEUED = new Set(["browser_dialog", "browser_console", "browser_network"]);

// browser_network's answer is capped so a chatty page cannot flood the agent's context; the
// newest requests are the interesting ones, so the oldest are dropped.
export const NETWORK_OUTPUT_LIMIT = 20_000;

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function at(p: BrowserPageInfo): string {
  return `now at ${p.url} (${p.title})`;
}

// An input action's answer: where the page is, and what the action set off that the agent
// must act on (a blocking dialog) or leave to the operator (a popup window).
function acted(r: BrowserActionResult, extra = ""): string {
  const lines = [at(r) + extra];
  if (r.dialog) {
    lines.push(`A JavaScript ${r.dialog.type} dialog is open: «${r.dialog.message}» — the page is blocked until you answer it with browser_dialog.`);
  }
  if (r.popup) lines.push(`A popup window opened at ${r.popup}; it belongs to the operator (agent tools cannot drive it).`);
  return lines.join("\n");
}

function networkLine(e: BrowserNetworkEntry): string {
  const outcome = e.failed ? `failed(${e.failed})` : e.status !== undefined ? String(e.status) : "…";
  const parts = [e.method, outcome];
  if (e.type) parts.push(e.type);
  if (e.ms !== undefined) parts.push(`${Math.round(e.ms)}ms`);
  parts.push(e.url);
  if (e.ms === undefined && !e.failed) parts.push("(pending)");
  return parts.join(" ");
}

export function formatNetwork(entries: BrowserNetworkEntry[]): string {
  if (!entries.length) return "(no requests)";
  const kept: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = networkLine(entries[i]);
    if (kept.length && size + line.length + 1 > NETWORK_OUTPUT_LIMIT) break;
    kept.push(line);
    size += line.length + 1;
  }
  kept.reverse();
  const dropped = entries.length - kept.length;
  return (dropped ? `(${dropped} older requests dropped)\n` : "") + kept.join("\n");
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`\`${key}\` is required`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`\`${key}\` must be a string`);
  return v;
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : fallback;
}

function strings(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x))
    throw new Error(`\`${key}\` must be a non-empty array of non-empty strings`);
  return v as string[];
}

function int(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`\`${key}\` must be an integer from ${min} to ${max}`);
  return v;
}

@Injectable()
export class BrowserMcpService {
  private tokens = new Map<string, string>(); // sessionId → token
  private sessions = new Map<string, string>(); // token → sessionId
  // The tail of each session's tool-call chain. Agents fire calls in parallel (a snapshot
  // beside the navigate it depends on — observed with omp), and one page cannot serve two
  // actions at once, so a session's calls run one after another in arrival order.
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private registry: RegistryService,
    private preview: PreviewService,
    @Optional() private http?: HttpAdapterHost,
  ) {}

  tokenFor(sessionId: string): string {
    let token = this.tokens.get(sessionId);
    if (!token) {
      token = randomBytes(32).toString("base64url");
      this.tokens.set(sessionId, token);
      this.sessions.set(token, sessionId);
    }
    return token;
  }

  sessionFor(token: string | undefined): string | undefined {
    return token ? this.sessions.get(token) : undefined;
  }

  revoke(sessionId: string): void {
    const token = this.tokens.get(sessionId);
    if (!token) return;
    this.tokens.delete(sessionId);
    this.sessions.delete(token);
  }

  // The server a launch hands its agent, or undefined when there is no browser to drive (a
  // standalone api) or no port to reach this api on yet (specs) — then the agent gets no tools.
  bindingFor(sessionId: string): { name: string; url: string; token: string } | undefined {
    if (!browserHost()) return undefined;
    const address = this.http?.httpAdapter?.getHttpServer()?.address() as { port?: number } | string | null | undefined;
    const port = address && typeof address === "object" ? address.port : undefined;
    if (!port) return undefined;
    return { name: BROWSER_MCP_SERVER_NAME, url: `http://127.0.0.1:${port}/api/browser/mcp`, token: this.tokenFor(sessionId) };
  }

  // One POST body → the response body, or `undefined` when it held only notifications.
  async handle(sessionId: string, body: unknown): Promise<unknown> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.one(sessionId, m)))).filter((r) => r !== undefined);
      return out.length ? out : undefined;
    }
    return this.one(sessionId, body);
  }

  private async one(sessionId: string, raw: unknown): Promise<unknown> {
    const msg = (raw && typeof raw === "object" ? raw : {}) as JsonRpcRequest;
    if (msg.id === undefined || msg.id === null) return undefined;
    const id = msg.id;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
    switch (msg.method) {
      case "initialize":
        return result({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BROWSER_MCP_SERVER_NAME, version: "1.0.0" },
        });
      case "ping":
        return result({});
      case "tools/list":
        return result({ tools: TOOLS });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        let run: Promise<ToolResult>;
        if (UNQUEUED.has(name)) run = this.call(sessionId, name, args);
        else {
          run = (this.queues.get(sessionId) ?? Promise.resolve()).then(() => this.call(sessionId, name, args));
          const tail = run.catch(() => undefined);
          this.queues.set(sessionId, tail);
          void tail.then(() => {
            if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
          });
        }
        try {
          return result(await run);
        } catch (err) {
          return result({ content: [{ type: "text", text: (err as Error)?.message ?? String(err) }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
    }
  }

  private async call(sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const host = browserHost();
    if (!host) throw new Error("The session browser is not available: Kermanych is running without its desktop app.");
    const session = this.registry.listSessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("This session no longer exists.");
    const target: BrowserTarget = { sessionId, projectId: session.projectId };
    switch (name) {
      case "browser_navigate": {
        const url = typeof args.url === "string" && args.url ? args.url : this.preview.urlOf(sessionId);
        if (!url)
          throw new Error(
            "No url given and this session's live preview is not running. Pass a url, or ask the operator to start the preview with the ▶ button.",
          );
        const page = await host.navigate(target, url);
        return text(`${at(page)}${page.status && page.status >= 400 ? ` — HTTP ${page.status}` : ""}`);
      }
      case "browser_snapshot": {
        const page = await host.snapshot(target);
        return text(`Page: ${page.title} — ${page.url}\n\n${page.text}`);
      }
      case "browser_click":
        return text(acted(await host.click(target, str(args, "ref"))));
      case "browser_type": {
        const typed = typeof args.text === "string" ? args.text : undefined;
        if (typed === undefined) throw new Error("`text` is required");
        return text(acted(await host.type(target, str(args, "ref"), typed, { clear: bool(args, "clear", true), submit: bool(args, "submit", false) })));
      }
      case "browser_press":
        return text(acted(await host.press(target, str(args, "key"))));
      case "browser_hover":
        return text(acted(await host.hover(target, str(args, "ref"))));
      case "browser_select": {
        const ref = str(args, "ref");
        const r = await host.select(target, ref, strings(args, "values"));
        return text(acted(r, `\nselected: ${r.selected.join(", ")}`));
      }
      case "browser_history": {
        const action = args.action;
        if (action !== "back" && action !== "forward" && action !== "reload") throw new Error("`action` must be back, forward or reload");
        return text(acted(await host.history(target, action)));
      }
      case "browser_wait_for": {
        const waitText = optStr(args, "text");
        const selector = optStr(args, "selector");
        if (!waitText === !selector) throw new Error("Give exactly one of `text` and `selector`.");
        const timeout = args.timeout === undefined || args.timeout === null ? 10 : args.timeout;
        if (typeof timeout !== "number" || !(timeout >= 0 && timeout <= 60)) throw new Error("`timeout` must be a number of seconds from 0 to 60");
        const r = await host.waitFor(target, { text: waitText, selector, gone: bool(args, "gone", false), timeoutMs: Math.round(timeout * 1000) });
        return text(`found after ${r.waitedMs} ms; ${at(r)}`);
      }
      case "browser_resize": {
        const width = int(args, "width", 320, 3840);
        const height = int(args, "height", 240, 2400);
        const reset = bool(args, "reset", false);
        if (reset && (width !== undefined || height !== undefined)) throw new Error("`reset` cannot be combined with `width`/`height`.");
        if (!reset && width === undefined) throw new Error("Give `width` (and optionally `height`), or `reset: true`.");
        const r = await host.resize(target, reset ? null : height === undefined ? { width: width! } : { width: width!, height });
        return text(`viewport ${r.viewport.width}×${r.viewport.height}; ${at(r)}`);
      }
      case "browser_screenshot": {
        const fullPage = bool(args, "full_page", false);
        const ref = optStr(args, "ref");
        if (fullPage && ref) throw new Error("`full_page` and `ref` cannot be combined.");
        const shot = await host.screenshot(target, ref ? { fullPage, ref } : { fullPage });
        return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] };
      }
      case "browser_upload": {
        const ref = str(args, "ref");
        const paths = strings(args, "paths");
        const relative = paths.find((p) => !isAbsolute(p));
        if (relative) throw new Error(`Paths must be absolute: ${relative}`);
        return text(acted(await host.upload(target, ref, paths)));
      }
      case "browser_dialog": {
        if (typeof args.accept !== "boolean") throw new Error("`accept` is required (true for OK, false for Cancel)");
        return text(acted(await host.dialog(target, { accept: args.accept })));
      }
      case "browser_console": {
        const entries = await host.console(target, { clear: bool(args, "clear", false) });
        return text(entries.length ? entries.map((e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source})` : ""}`).join("\n") : "(no entries)");
      }
      case "browser_network": {
        const filter = optStr(args, "filter");
        return text(formatNetwork(await host.network(target, filter ? { clear: bool(args, "clear", false), filter } : { clear: bool(args, "clear", false) })));
      }
      case "browser_evaluate":
        return text(await host.evaluate(target, str(args, "expression")));
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
