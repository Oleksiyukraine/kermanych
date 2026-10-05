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
import { RegistryService } from "../registry/registry.service";
import { PreviewService } from "../preview/preview.service";
import { browserHost, type BrowserPageInfo, type BrowserTarget } from "./browser-host";

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

const TOOLS = [
  {
    name: "browser_navigate",
    description:
      `${SHARED} Load a URL in it and wait for the page to settle. Without \`url\` it opens this session's running live preview (the app built from this session's worktree). ` +
      "Answers with where the page ended up; follow with browser_snapshot to read it.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "An http(s) URL or about:blank. Omit to open the session's live preview." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      `${SHARED} A text outline of the visible page. Interactive elements carry refs (e1, e2, …) that browser_click and browser_type accept; ` +
      "every snapshot reassigns them, so take a fresh one after the page changes. Prefer this to find elements and read content; use browser_screenshot to check visuals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_click",
    description: `${SHARED} Click an element with a real mouse event. Answers with the page's URL and title afterwards, so you can tell whether it navigated.`,
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "A ref from the latest browser_snapshot (e.g. e12), or a CSS selector." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: `${SHARED} Focus an input or editable element and type text into it as real keyboard input.`,
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "A ref from the latest browser_snapshot (e.g. e12), or a CSS selector." },
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
    name: "browser_screenshot",
    description: `${SHARED} A PNG of the visible viewport. Use it to check layout and visuals; to find elements or read text, browser_snapshot is cheaper and gives refs.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function at(p: BrowserPageInfo): string {
  return `now at ${p.url} (${p.title})`;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`\`${key}\` is required`);
  return v;
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : fallback;
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
        const run = (this.queues.get(sessionId) ?? Promise.resolve()).then(() => this.call(sessionId, name, args));
        const tail = run.catch(() => undefined);
        this.queues.set(sessionId, tail);
        void tail.then(() => {
          if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
        });
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
        return text(at(await host.click(target, str(args, "ref"))));
      case "browser_type": {
        const typed = typeof args.text === "string" ? args.text : undefined;
        if (typed === undefined) throw new Error("`text` is required");
        return text(at(await host.type(target, str(args, "ref"), typed, { clear: bool(args, "clear", true), submit: bool(args, "submit", false) })));
      }
      case "browser_press":
        return text(at(await host.press(target, str(args, "key"))));
      case "browser_screenshot": {
        const shot = await host.screenshot(target);
        return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] };
      }
      case "browser_console": {
        const entries = await host.console(target, { clear: bool(args, "clear", false) });
        return text(entries.length ? entries.map((e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source})` : ""}`).join("\n") : "(no entries)");
      }
      case "browser_evaluate":
        return text(await host.evaluate(target, str(args, "expression")));
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
