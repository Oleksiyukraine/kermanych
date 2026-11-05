// apps/api/test/browser-mcp.spec.ts
// The session browser's MCP server (docs/specs/2026-10-05-embedded-browser.md): the per-session
// bearer, the binding a launch is handed, and tools/call routed to the desktop app's host for
// the right session and project. The host is a fake BrowserHost. Also the live-preview tools and
// the platform and kind gates (docs/specs/2026-11-03-session-browser-preview.md), and a Mobile
// project's device tools against a fake DeviceApi (docs/specs/2026-11-03-mobile-device-preview.md).
import { HttpException } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryService } from "../src/registry/registry.service";
import type { PreviewService } from "../src/preview/preview.service";
import type { Platform, PreviewState, Session } from "@kermanych/core";
import { setBrowserHost, type BrowserActionResult, type BrowserHost, type BrowserNetworkEntry } from "../src/browser/browser-host";
import { BrowserMcpService, NETWORK_OUTPUT_LIMIT, screenshotFile } from "../src/browser/browser-mcp.service";
import { BrowserMcpController } from "../src/http/browser-mcp.controller";
import { el, fakeDevice } from "./fake-device";

const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;
const page = { url: "http://localhost:5173/", title: "App" };
type CallResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

function fakeHost() {
  return {
    navigate: vi.fn(async (_t, url: string) => ({ url, title: "App", status: 200 })),
    snapshot: vi.fn(async () => ({ ...page, text: "- button \"Save\" [e1]" })),
    click: vi.fn(async () => page),
    type: vi.fn(async () => page),
    press: vi.fn(async () => page),
    hover: vi.fn(async () => page),
    select: vi.fn(async (): Promise<BrowserActionResult & { selected: string[] }> => ({ ...page, selected: ["Red"] })),
    history: vi.fn(async (): Promise<BrowserActionResult> => page),
    waitFor: vi.fn(async () => ({ ...page, waitedMs: 120 })),
    resize: vi.fn(async (_t, v: { width: number; height?: number } | null) => ({ ...page, viewport: { width: v?.width ?? 900, height: v?.height ?? 700 } })),
    upload: vi.fn(async (): Promise<BrowserActionResult> => page),
    dialog: vi.fn(async (): Promise<BrowserActionResult> => page),
    network: vi.fn(async (): Promise<BrowserNetworkEntry[]> => []),
    screenshot: vi.fn(async () => ({ data: "iVBORw0K", mimeType: "image/png" as const })),
    console: vi.fn(async () => [
      { level: "error" as const, text: "boom", source: "app.js:3", at: 1 },
      { level: "network" as const, text: "GET 404", at: 2 },
    ]),
    evaluate: vi.fn(async () => '"App"'),
    openPreview: vi.fn(async () => {}),
    isPaused: vi.fn(() => false),
    has: vi.fn(() => true),
    close: vi.fn(),
  } satisfies BrowserHost;
}

function make(
  previewUrl?: string,
  opts: { platform?: Platform; kind?: Session["kind"]; worktreePath?: string; worktree?: boolean } = {},
) {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/p1", ...(opts.platform ? { platform: opts.platform } : {}) });
  const s = registry.createSession({
    projectId: "p1", name: "n", task: "t", worktreePath: opts.worktreePath ?? "", branch: "b",
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.worktree === undefined ? {} : { worktree: opts.worktree }),
  });
  const running: PreviewState = { phase: "running", url: "http://localhost:5199", services: [{ name: "web", port: 5199 }] };
  const preview = {
    urlOf: vi.fn(() => previewUrl),
    start: vi.fn((): PreviewState => ({ phase: "starting", step: "web", services: [] })),
    settled: vi.fn(async (): Promise<PreviewState | null> => running),
    stop: vi.fn(async () => {}),
    steps: vi.fn(() => ["setup", "web"]),
    tail: vi.fn((_id: string, _step: string, n: number) => ["one", "two", "three"].slice(-n)),
    app: vi.fn(async (_id: string, action: string): Promise<PreviewState> => ({ ...running, app: action === "terminate" ? "exited" : "running" })),
  };
  const fake = fakeDevice();
  const mcp = new BrowserMcpService(registry, preview as unknown as PreviewService, fake.device, http);
  const host = fakeHost();
  setBrowserHost(host);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    // handle() answers unknown; a tools/call request always gets a JSON-RPC result.
    const reply = (await mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: CallResult };
    return reply.result;
  };
  const list = async () => ((await mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  return { mcp, host, s, call, list, preview, registry, fake, device: fake.device };
}

const PREVIEW_TOOL_NAMES = ["preview_start", "preview_status", "preview_stop", "preview_logs"];
const DEVICE_TOOL_NAMES = [
  "device_snapshot",
  "device_screenshot",
  "device_tap",
  "device_swipe",
  "device_type",
  "device_press",
  "device_wait_for",
  "device_open_url",
  "device_app",
  "device_rotate",
];

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kermanych-shot-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setBrowserHost(undefined);
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bearer and binding", () => {
  it("one token per session, reused until revoked; the controller refuses anything else", async () => {
    const { mcp, s } = make();
    const binding = mcp.bindingFor(s.id)!;
    expect(binding).toEqual({ name: "kermanych", url: "http://127.0.0.1:4317/api/browser/mcp", token: expect.any(String) });
    expect(mcp.bindingFor(s.id)!.token).toBe(binding.token);
    expect(mcp.sessionFor(binding.token)).toBe(s.id);

    const ctl = new BrowserMcpController(mcp);
    const res = { status: vi.fn() };
    await expect(ctl.post("Bearer nope", { jsonrpc: "2.0", id: 1, method: "ping" }, res)).rejects.toMatchObject({ status: 401 });
    await expect(ctl.post(`Bearer ${binding.token}`, { jsonrpc: "2.0", id: 1, method: "ping" }, res)).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(res.status).toHaveBeenLastCalledWith(200);
    await ctl.post(`Bearer ${binding.token}`, { jsonrpc: "2.0", method: "notifications/initialized" }, res);
    expect(res.status).toHaveBeenLastCalledWith(202);

    mcp.revoke(s.id);
    expect(mcp.sessionFor(binding.token)).toBeUndefined();
    await expect(ctl.post(`Bearer ${binding.token}`, { jsonrpc: "2.0", id: 1, method: "ping" }, res)).rejects.toBeInstanceOf(HttpException);
    expect(mcp.bindingFor(s.id)!.token).not.toBe(binding.token);
  });

  it("without a browser host the binding still exists and lists the preview and findings tools", async () => {
    const { mcp, s, list } = make();
    setBrowserHost(undefined);
    expect(mcp.bindingFor(s.id)).toEqual({ name: "kermanych", url: "http://127.0.0.1:4317/api/browser/mcp", token: expect.any(String) });
    expect(await list()).toEqual([...PREVIEW_TOOL_NAMES, "report_finding", "list_findings"]);
  });

  it("asks for the findings in the operator's agent language, English while none is chosen", async () => {
    const { mcp, s, registry } = make();
    const env = process.env.KERMANYCH_LANGUAGE;
    delete process.env.KERMANYCH_LANGUAGE;
    const reportDescription = async () => {
      const reply = (await mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; description: string }[] } };
      return reply.result.tools.find((t) => t.name === "report_finding")!.description;
    };
    try {
      expect(await reportDescription()).toContain("Write every field in English;");
      registry.setAuthSession({ userId: "u1", accessToken: "t", agentLanguage: "uk" });
      expect(await reportDescription()).toContain("Write every field in Ukrainian;");
      registry.setAuthSession({ userId: "u1", accessToken: "t", agentLanguage: "en-ste-80" });
      expect(await reportDescription()).toContain("Write every field in English;");
      process.env.KERMANYCH_LANGUAGE = "de";
      expect(await reportDescription()).toContain("Write every field in German;");
    } finally {
      if (env === undefined) delete process.env.KERMANYCH_LANGUAGE;
      else process.env.KERMANYCH_LANGUAGE = env;
    }
  });

  it("lists every browser tool, then the preview tools, then the findings tools, each with a closed object schema", async () => {
    const { mcp, s } = make();
    const reply = (await mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean } }[] };
    };
    const tools = reply.result.tools;
    expect(tools.map((t) => t.name)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_hover",
      "browser_select",
      "browser_history",
      "browser_wait_for",
      "browser_resize",
      "browser_screenshot",
      "browser_upload",
      "browser_dialog",
      "browser_console",
      "browser_network",
      "browser_evaluate",
      ...PREVIEW_TOOL_NAMES,
      "report_finding",
      "list_findings",
    ]);
    for (const t of tools) {
      if (t.name.startsWith("browser_")) expect(t.description).toMatch(/THIS session only/);
      if (t.name.startsWith("preview_")) expect(t.description).toMatch(/\.kermanych\/preview\.json/);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties)).toContain(r);
    }
  });

  // Decision 9: a back-end project has no browser and no preview; decision 8: only an agent
  // session has the preview. Mobile decision 8: a Mobile project's agent session has the preview
  // and the device instead of the browser. The findings tools stay in every case.
  it("gates the browser, preview and device tools by the project's platform and the session's kind", async () => {
    expect(await make(undefined, { platform: "backend" }).list()).toEqual(["report_finding", "list_findings"]);
    const web = await make(undefined, { platform: "web" }).list();
    expect(web).toContain("browser_navigate");
    expect(web).toContain("preview_start");
    expect(web.some((n) => n.startsWith("device_"))).toBe(false);
    const chat = await make(undefined, { kind: "chat" }).list();
    expect(chat).toContain("browser_navigate");
    expect(chat.some((n) => n.startsWith("preview_"))).toBe(false);

    const mobile = make(undefined, { platform: "mobile" });
    expect(await mobile.list()).toEqual([...PREVIEW_TOOL_NAMES, ...DEVICE_TOOL_NAMES, "report_finding", "list_findings"]);
    // The device is driven by the api: the web build (no host) lists the same.
    setBrowserHost(undefined);
    expect(await mobile.list()).toEqual([...PREVIEW_TOOL_NAMES, ...DEVICE_TOOL_NAMES, "report_finding", "list_findings"]);
    for (const kind of ["chat", "discussion"] as const) expect(await make(undefined, { platform: "mobile", kind }).list()).toEqual(["report_finding", "list_findings"]);
  });
});

describe("tools/call", () => {
  it("routes to the host with the session's target and formats results", async () => {
    const { host, s, call } = make();
    const target = { sessionId: s.id, projectId: "p1" };

    expect(await call("browser_snapshot")).toEqual({ content: [{ type: "text", text: 'Page: App — http://localhost:5173/\n\n- button "Save" [e1]' }] });
    expect(host.snapshot).toHaveBeenCalledWith(target);

    expect((await call("browser_click", { ref: "e1" })).content[0].text).toBe("now at http://localhost:5173/ (App)");
    expect(host.click).toHaveBeenCalledWith(target, "e1");

    await call("browser_type", { ref: "e2", text: "hi", submit: true });
    expect(host.type).toHaveBeenCalledWith(target, "e2", "hi", { clear: true, submit: true });

    expect((await call("browser_console")).content[0].text).toBe("[error] boom (app.js:3)\n[network] GET 404");
    expect(host.console).toHaveBeenCalledWith(target, { clear: false });

    expect(await call("browser_screenshot")).toEqual({ content: [{ type: "image", data: "iVBORw0K", mimeType: "image/png" }] });
  });

  it("navigate without a url opens the running preview, and errors without one", async () => {
    const running = make("http://localhost:5199/");
    expect((await running.call("browser_navigate")).content[0].text).toBe("now at http://localhost:5199/ (App)");
    expect(running.host.navigate).toHaveBeenCalledWith({ sessionId: running.s.id, projectId: "p1" }, "http://localhost:5199/");

    const idle = make();
    const out = await idle.call("browser_navigate");
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/preview_start/);
    expect(idle.host.navigate).not.toHaveBeenCalled();
  });

  it("a host failure or a missing argument is a tool error, not a protocol error", async () => {
    const { host, call } = make();
    host.click.mockRejectedValueOnce(new Error("no element for ref e9"));
    expect(await call("browser_click", { ref: "e9" })).toEqual({ content: [{ type: "text", text: "no element for ref e9" }], isError: true });
    expect((await call("browser_press", {})).isError).toBe(true);
    expect(host.press).not.toHaveBeenCalled();
  });

  it("a session's parallel calls run in arrival order, and a failure does not stall the next", async () => {
    const { host, call } = make();
    const order: string[] = [];
    let finishNavigate!: () => void;
    host.navigate.mockImplementationOnce(async (_t, url: string) => {
      order.push("navigate:start");
      await new Promise<void>((resolve) => (finishNavigate = resolve));
      order.push("navigate:end");
      return { url, title: "App", status: 200 };
    });
    host.snapshot.mockImplementationOnce(async () => {
      order.push("snapshot");
      throw new Error("stale");
    });
    host.click.mockImplementationOnce(async () => {
      order.push("click");
      return page;
    });

    const navigating = call("browser_navigate", { url: "http://localhost:5173/" });
    const snapshotting = call("browser_snapshot");
    const clicking = call("browser_click", { ref: "e1" });
    await vi.waitFor(() => expect(order).toEqual(["navigate:start"]));
    finishNavigate();

    expect((await snapshotting).isError).toBe(true);
    expect((await clicking).isError).toBeUndefined();
    await navigating;
    expect(order).toEqual(["navigate:start", "navigate:end", "snapshot", "click"]);
  });

  it("routes the newer tools with parsed arguments", async () => {
    const { host, s, call } = make();
    const target = { sessionId: s.id, projectId: "p1" };

    expect((await call("browser_hover", { ref: "e3" })).content[0].text).toBe("now at http://localhost:5173/ (App)");
    expect(host.hover).toHaveBeenCalledWith(target, "e3");

    expect((await call("browser_select", { ref: "e4", values: ["red"] })).content[0].text).toBe("now at http://localhost:5173/ (App)\nselected: Red");
    expect(host.select).toHaveBeenCalledWith(target, "e4", ["red"]);

    await call("browser_history", { action: "back" });
    expect(host.history).toHaveBeenCalledWith(target, "back");

    expect((await call("browser_wait_for", { text: "Saved" })).content[0].text).toBe("found after 120 ms; now at http://localhost:5173/ (App)");
    expect(host.waitFor).toHaveBeenLastCalledWith(target, { text: "Saved", selector: undefined, gone: false, timeoutMs: 10_000 });
    await call("browser_wait_for", { selector: ".spinner", gone: true, timeout: 2.5 });
    expect(host.waitFor).toHaveBeenLastCalledWith(target, { text: undefined, selector: ".spinner", gone: true, timeoutMs: 2500 });

    expect((await call("browser_resize", { width: 390, height: 844 })).content[0].text).toBe("viewport 390×844; now at http://localhost:5173/ (App)");
    expect(host.resize).toHaveBeenLastCalledWith(target, { width: 390, height: 844 });
    await call("browser_resize", { width: 1024 });
    expect(host.resize).toHaveBeenLastCalledWith(target, { width: 1024 });
    await call("browser_resize", { reset: true });
    expect(host.resize).toHaveBeenLastCalledWith(target, null);

    await call("browser_screenshot", { full_page: true });
    expect(host.screenshot).toHaveBeenLastCalledWith(target, { fullPage: true });
    await call("browser_screenshot", { ref: "e1" });
    expect(host.screenshot).toHaveBeenLastCalledWith(target, { fullPage: false, ref: "e1" });

    await call("browser_upload", { ref: "e5", paths: ["/tmp/a.png"] });
    expect(host.upload).toHaveBeenCalledWith(target, "e5", ["/tmp/a.png"]);

    await call("browser_dialog", { accept: true });
    expect(host.dialog).toHaveBeenLastCalledWith(target, { accept: true });
    await call("browser_dialog", { accept: false });
    expect(host.dialog).toHaveBeenLastCalledWith(target, { accept: false });

    await call("browser_network", { clear: true, filter: "/api" });
    expect(host.network).toHaveBeenLastCalledWith(target, { clear: true, filter: "/api" });
  });

  it("invalid arguments are tool errors and never reach the host", async () => {
    const { host, call } = make();
    const cases: [string, Record<string, unknown>][] = [
      ["browser_wait_for", {}],
      ["browser_wait_for", { text: "a", selector: "b" }],
      ["browser_wait_for", { text: "a", timeout: 61 }],
      ["browser_resize", { reset: true, width: 400 }],
      ["browser_resize", {}],
      ["browser_resize", { width: 100 }],
      ["browser_screenshot", { full_page: true, ref: "e1" }],
      ["browser_select", { ref: "e1", values: [] }],
      ["browser_upload", { ref: "e1", paths: ["a.png"] }],
      ["browser_history", { action: "up" }],
      ["browser_dialog", {}],
    ];
    for (const [name, args] of cases) {
      const out = await call(name, args);
      expect(out.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(out.content[0].text).toBeTruthy();
    }
    for (const fn of [host.waitFor, host.resize, host.screenshot, host.select, host.upload, host.history, host.dialog]) expect(fn).not.toHaveBeenCalled();
  });

  it("tells the agent about a dialog or popup the action opened", async () => {
    const { host, call } = make();
    host.click.mockResolvedValueOnce({ ...page, dialog: { type: "confirm", message: "Delete it?" } });
    expect((await call("browser_click", { ref: "e1" })).content[0].text).toBe(
      "now at http://localhost:5173/ (App)\nA JavaScript confirm dialog is open: «Delete it?» — the page is blocked until you answer it with browser_dialog.",
    );
    host.click.mockResolvedValueOnce({ ...page, popup: "https://accounts.example.com/o/auth" });
    expect((await call("browser_click", { ref: "e1" })).content[0].text).toBe(
      "now at http://localhost:5173/ (App)\nA popup window opened at https://accounts.example.com/o/auth; it belongs to the operator (agent tools cannot drive it).",
    );
  });

  it("formats network requests and keeps the newest under the cap", async () => {
    const { host, call } = make();
    expect((await call("browser_network")).content[0].text).toBe("(no requests)");
    host.network.mockResolvedValueOnce([
      { method: "GET", url: "https://x.dev/a", type: "Fetch", status: 200, ms: 123.4, at: 1 },
      { method: "POST", url: "https://x.dev/b", type: "XHR", failed: "net::ERR_FAILED", ms: 5, at: 2 },
      { method: "GET", url: "https://x.dev/c", at: 3 },
    ]);
    expect((await call("browser_network")).content[0].text).toBe(
      "GET 200 Fetch 123ms https://x.dev/a\nPOST failed(net::ERR_FAILED) XHR 5ms https://x.dev/b\nGET … https://x.dev/c (pending)",
    );
    const many = Array.from({ length: 1000 }, (_, i) => ({ method: "GET", url: `https://x.dev/${"p".repeat(40)}/${i}`, status: 200, ms: 1, at: i }));
    host.network.mockResolvedValueOnce(many);
    const out = (await call("browser_network")).content[0].text!;
    expect(out.length).toBeLessThanOrEqual(NETWORK_OUTPUT_LIMIT + 100);
    expect(out).toMatch(/^\(\d+ older requests dropped\)\n/);
    expect(out.endsWith("/999")).toBe(true);
    expect(out).not.toMatch(/\/0\n/);
  });

  it("browser_dialog, console and network bypass a queue stuck on the dialog", async () => {
    const { host, call } = make();
    let unblock!: () => void;
    host.click.mockImplementationOnce(() => new Promise((resolve) => (unblock = () => resolve(page))));
    host.dialog.mockImplementationOnce(async () => {
      unblock();
      return page;
    });
    const clicking = call("browser_click", { ref: "e1" });
    await vi.waitFor(() => expect(host.click).toHaveBeenCalled());
    expect((await call("browser_console")).isError).toBeUndefined();
    expect((await call("browser_network")).content[0].text).toBe("(no requests)");
    expect((await call("browser_dialog", { accept: true })).isError).toBeUndefined();
    expect((await clicking).isError).toBeUndefined();
  });
});

describe("preview tools", () => {
  it("preview_start starts, waits up to 60 s and answers with the running URL", async () => {
    const { preview, s, call } = make();
    const out = await call("preview_start", { restart: true });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toMatch(/^Running at http:\/\/localhost:5199 \(web :5199\)/);
    expect(preview.start).toHaveBeenCalledWith(s.id, { restart: true });
    expect(preview.settled).toHaveBeenCalledWith(s.id, 60_000);
  });

  it("a failed start answers with the failed step and the last lines of its log", async () => {
    const { preview, call } = make();
    preview.settled.mockResolvedValueOnce({ phase: "failed", step: "web", error: "exited with code 1 before the preview was running\nthree" });
    const out = await call("preview_start");
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("Failed at web: exited with code 1 before the preview was running\n\nLast 3 lines of web:\none\ntwo\nthree");
    expect(preview.tail).toHaveBeenCalledWith(expect.any(String), "web", 50);
  });

  it("a still-starting preview hands over to preview_status; a missing file names the skill", async () => {
    const { preview, call } = make();
    preview.settled.mockResolvedValueOnce({ phase: "starting", step: "api", services: [{ name: "api", port: 4100 }] });
    expect((await call("preview_start")).content[0].text).toMatch(/waiting for api.*preview_status/);
    preview.start.mockImplementationOnce(() => {
      throw new Error(".kermanych/preview.json is missing in the session directory");
    });
    const missing = await call("preview_start");
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/preview-config skill/);
  });

  it("the operator's pause refuses start and stop, not reading", async () => {
    const { host, preview, call } = make();
    host.isPaused.mockReturnValue(true);
    expect((await call("preview_start")).isError).toBe(true);
    expect((await call("preview_stop")).isError).toBe(true);
    expect(preview.start).not.toHaveBeenCalled();
    expect(preview.stop).not.toHaveBeenCalled();
    expect((await call("preview_status")).isError).toBeUndefined();
  });

  it("preview_status waits only within bounds; preview_logs reads one step of the latest start", async () => {
    const { preview, s, call } = make();
    await call("preview_status", { wait: 5 });
    expect(preview.settled).toHaveBeenCalledWith(s.id, 5000);
    expect((await call("preview_status", { wait: 61 })).isError).toBe(true);
    expect((await call("preview_logs", { step: "web", lines: 2 })).content[0].text).toBe("two\nthree");
    expect(preview.tail).toHaveBeenLastCalledWith(s.id, "web", 2);
    const unknown = await call("preview_logs", { step: "api" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/setup, web/);
    expect((await call("preview_logs", { step: "web", lines: 1001 })).isError).toBe(true);
    expect((await call("preview_stop")).isError).toBeUndefined();
    expect(preview.stop).toHaveBeenCalledWith(s.id);
  });

  it("a preview start does not wait for the page queue", async () => {
    const { host, preview, call } = make();
    host.click.mockImplementationOnce(() => new Promise(() => {}));
    void call("browser_click", { ref: "e1" });
    await vi.waitFor(() => expect(host.click).toHaveBeenCalled());
    expect((await call("preview_start")).isError).toBeUndefined();
    expect(preview.start).toHaveBeenCalled();
  });

  // Decision 9: an agent listed the tools before the project became back-end or mobile.
  it("calls are refused for a back-end project and for a non-agent session", async () => {
    const backend = make(undefined, { platform: "backend" });
    const click = await backend.call("browser_click", { ref: "e1" });
    expect(click).toEqual({ content: [{ type: "text", text: "The session browser is off: this is a backend project." }], isError: true });
    expect(backend.host.click).not.toHaveBeenCalled();
    expect((await backend.call("preview_start")).content[0].text).toBe("The live preview is off: this is a backend project.");
    expect(backend.preview.start).not.toHaveBeenCalled();

    const chat = make(undefined, { kind: "chat" });
    expect((await chat.call("preview_status")).isError).toBe(true);
    expect(chat.preview.settled).not.toHaveBeenCalled();
  });
});

describe("device tools (Mobile)", () => {
  const ios = { platform: "ios" as const, serial: "SIM-UDID-1", name: "iPhone 16", screen: { width: 393, height: 852 } };
  const android = { platform: "android" as const, serial: "emulator-5584", name: "Pixel 8", screen: { width: 1080, height: 2400 } };
  const login = () => [
    el("Window", null, [0, 0, 393, 852], {
      children: [
        el("StaticText", "Вхід", [24, 100, 345, 40]),
        el("TextField", "Email", [24, 200, 345, 44], { id: "email", value: "a@b.c" }),
        el("Button", "Увійти", [24, 610, 345, 48], { id: "login" }),
        el("Other", null, [0, 0, 0, 0], { children: [el("Button", "Hidden child", [10, 10, 20, 20], { enabled: false })] }),
      ],
    }),
  ];
  function mobile(runtime: typeof ios | typeof android | null = ios, opts: { kind?: Session["kind"]; worktreePath?: string } = {}) {
    const m = make(undefined, { platform: "mobile", ...opts });
    if (runtime) m.fake.boot(m.s.id, runtime);
    m.fake.setTree(login());
    return m;
  }

  it("describes the device's preview and coordinate space, with closed schemas", async () => {
    const { mcp, s } = mobile();
    const reply = (await mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean } }[] };
    };
    const tools = new Map(reply.result.tools.map((t) => [t.name, t]));
    expect(Object.keys(tools.get("preview_start")!.inputSchema.properties)).toEqual(["restart", "platform"]);
    for (const name of PREVIEW_TOOL_NAMES) expect(tools.get(name)!.description).toMatch(/«Пристрій»/);
    for (const name of DEVICE_TOOL_NAMES) {
      const t = tools.get(name)!;
      expect(t.description).toMatch(/THIS session's virtual device/);
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties)).toContain(r);
    }
    for (const name of ["device_snapshot", "device_tap", "device_swipe"]) expect(tools.get(name)!.description).toMatch(/points on iOS, pixels on Android/);
    // A web project's preview_start has no platform.
    const w = make();
    const web = (await w.mcp.handle(w.s.id, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as typeof reply;
    expect(Object.keys(web.result.tools.find((t) => t.name === "preview_start")!.inputSchema.properties)).toEqual(["restart"]);
  });

  it("device_snapshot answers the compact tree with refs, ids and values, skipping what has no area", async () => {
    const { call } = mobile();
    expect((await call("device_snapshot")).content[0].text).toBe(
      [
        "Device: iPhone 16 (ios), screen 393×852 points. The refs are valid for this snapshot only.",
        "",
        "e1 Window [0,0 393×852]",
        '  e2 StaticText "Вхід" [24,100 345×40]',
        '  e3 TextField "Email" [24,200 345×44] id=email value="a@b.c"',
        '  e4 Button "Увійти" [24,610 345×48] id=login',
        '    e5 Button "Hidden child" [10,10 20×20] disabled',
      ].join("\n"),
    );
  });

  it("a ref taps its element where it is now, and is refused once the element is no longer near where the snapshot saw it", async () => {
    const { call, device, fake, s } = mobile();
    await call("device_snapshot");
    expect((await call("device_tap", { ref: "e4" })).content[0].text).toBe('tapped Button "Увійти" [24,610 345×48] id=login');
    expect(device.tap).toHaveBeenLastCalledWith(s.id, 196.5, 634);

    // A few points of layout shift: the same button, tapped where it is now.
    const shifted = login();
    shifted[0]!.children[2]!.frame.y = 616;
    fake.setTree(shifted);
    await call("device_tap", { ref: "e4" });
    expect(device.tap).toHaveBeenLastCalledWith(s.id, 196.5, 640);

    // The screen scrolled: a button of that label is elsewhere now. Not tapped blind.
    const moved = login();
    moved[0]!.children[2]!.frame.y = 700;
    fake.setTree(moved);
    device.tap.mockClear();
    const stale = await call("device_tap", { ref: "e4" });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toBe('e4 (Button "Увійти") is no longer where device_snapshot saw it: the screen changed. Take a new device_snapshot.');
    const relabelled = login();
    relabelled[0]!.children[2]!.label = "Вийти";
    fake.setTree(relabelled);
    expect((await call("device_tap", { ref: "e4" })).isError).toBe(true);
    expect((await call("device_swipe", { ref: "e4", direction: "up" })).isError).toBe(true);
    expect((await call("device_tap", { ref: "e99" })).content[0].text).toMatch(/^Unknown ref e99/);
    expect(device.tap).not.toHaveBeenCalled();
    expect(device.swipe).not.toHaveBeenCalled();

    // A new snapshot binds the refs again; a rotation unbinds them.
    await call("device_snapshot");
    expect((await call("device_tap", { ref: "e4" })).isError).toBeUndefined();
    await call("device_rotate", { orientation: "landscape" });
    expect(device.rotate).toHaveBeenCalledWith(s.id, "landscape");
    expect((await call("device_tap", { ref: "e4" })).content[0].text).toMatch(/^Unknown ref e4/);
  });

  it("taps by label, id or point, and refuses a bad target", async () => {
    const { call, device, s } = mobile();
    await call("device_tap", { label: "Email" });
    expect(device.tap).toHaveBeenLastCalledWith(s.id, 196.5, 222);
    await call("device_tap", { id: "login" });
    expect(device.tap).toHaveBeenLastCalledWith(s.id, 196.5, 634);
    expect((await call("device_tap", { x: 10, y: 20 })).content[0].text).toBe("tapped (10, 20)");
    device.tap.mockClear();
    for (const args of [{}, { ref: "e1", x: 1, y: 1 }, { x: 10 }, { x: 400, y: 10 }, { label: "Nope" }, { label: "Email", id: "email" }]) {
      expect((await call("device_tap", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(device.tap).not.toHaveBeenCalled();
  });

  it("swipes between points or in a direction, inside the screen", async () => {
    const { call, device, s } = mobile();
    await call("device_swipe", { x: 100, y: 700, to_x: 100, to_y: 200 });
    expect(device.swipe).toHaveBeenLastCalledWith(s.id, { x: 100, y: 700 }, { x: 100, y: 200 }, 300);
    // Without a start: the centre; the finger moves up half the screen.
    await call("device_swipe", { direction: "up" });
    expect(device.swipe).toHaveBeenLastCalledWith(s.id, { x: 196.5, y: 426 }, { x: 196.5, y: 0 }, 300);
    await call("device_swipe", { x: 300, y: 400, direction: "right", distance: 0.8, duration_ms: 1000 });
    expect(device.swipe).toHaveBeenLastCalledWith(s.id, { x: 300, y: 400 }, { x: 393, y: 400 }, 1000);
    device.swipe.mockClear();
    for (const args of [{}, { to_x: 1, to_y: 1 }, { x: 1, y: 1, to_x: 2, to_y: 2, direction: "up" }, { direction: "sideways" }, { direction: "up", distance: 2 }]) {
      expect((await call("device_swipe", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(device.swipe).not.toHaveBeenCalled();
  });

  it("types, presses the buttons the platform has, opens URLs, and waits for the tree", async () => {
    const ios = mobile();
    await ios.call("device_type", { text: "Привіт", submit: true });
    expect(ios.device.type).toHaveBeenCalledWith(ios.s.id, "Привіт");
    expect(ios.device.press).toHaveBeenCalledWith(ios.s.id, "enter");
    const back = await ios.call("device_press", { button: "back" });
    expect(back.isError).toBe(true);
    expect(back.content[0].text).toMatch(/An ios device has no back button/);
    expect((await ios.call("device_open_url", { url: "not a url" })).isError).toBe(true);
    await ios.call("device_open_url", { url: "myapp://orders/42" });
    expect(ios.device.openUrl).toHaveBeenCalledWith(ios.s.id, "myapp://orders/42");

    expect((await ios.call("device_wait_for", { text: "Вхід" })).content[0].text).toMatch(/^found StaticText "Вхід" \[24,100 345×40\] after \d+ ms$/);
    const missing = await ios.call("device_wait_for", { id: "welcome", timeout: 0.2 });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe("Not on the screen after 0.2 s: id welcome.");
    setTimeout(() => ios.fake.setTree([]), 100);
    expect((await ios.call("device_wait_for", { text: "Вхід", gone: true, timeout: 5 })).content[0].text).toMatch(/^gone after \d+ ms$/);

    const droid = mobile(android);
    expect((await droid.call("device_press", { button: "back" })).isError).toBeUndefined();
    expect(droid.device.press).toHaveBeenCalledWith(droid.s.id, "back");
  });

  it("device_screenshot answers the PNG or saves it under the worktree's docs/", async () => {
    const worktree = tmp();
    const { call } = mobile(ios, { worktreePath: worktree });
    expect(await call("device_screenshot")).toEqual({ content: [{ type: "image", data: "iVBORw0K", mimeType: "image/png" }] });
    expect((await call("device_screenshot", { path: "docs/screens/login.png" })).content[0].text).toBe("saved docs/screens/login.png (6 bytes)");
    expect(readFileSync(join(worktree, "docs/screens/login.png"))).toEqual(Buffer.from("iVBORw0K", "base64"));
    expect((await call("device_screenshot", { path: "src/x.png" })).isError).toBe(true);
  });

  it("device_app goes through the preview, and preview_start takes the platform", async () => {
    const { call, preview, s } = mobile();
    expect((await call("device_app", { action: "restart" })).content[0].text).toBe("restarted the app; it is running");
    expect(preview.app).toHaveBeenCalledWith(s.id, "restart");
    expect((await call("device_app", { action: "terminate" })).content[0].text).toBe("terminated the app");
    preview.app.mockResolvedValueOnce({ phase: "running", url: null, services: [], device: ios, app: "exited" });
    expect((await call("device_app", { action: "launch" })).isError).toBe(true);
    expect((await call("device_app", { action: "kill" })).isError).toBe(true);

    await call("preview_start", { platform: "android" });
    expect(preview.start).toHaveBeenLastCalledWith(s.id, { restart: false, platform: "android" });
    expect((await call("preview_start", { platform: "windows" })).isError).toBe(true);
    preview.settled.mockResolvedValueOnce({ phase: "running", url: null, services: [], device: ios, app: "exited" });
    expect((await call("preview_status")).content[0].text).toBe(
      "Running on iPhone 16 (ios, DEVICE_ID SIM-UDID-1, screen 393×852 points). The app has exited (it crashed or was closed); the services and the device keep running. Read preview_logs for `device`, then start it again with device_app launch.",
    );
    preview.settled.mockResolvedValueOnce({ phase: "crashed", step: "device", code: null, signal: null });
    expect((await call("preview_status")).content[0].text).toMatch(/^Crashed: the device itself \(simulator or emulator\) exited/);
  });

  it("the operator's pause refuses every device action and preview start/stop, not reading", async () => {
    const { call, device, preview, host, s } = mobile();
    device.setPaused(s.id, true);
    for (const [name, args] of [["device_snapshot", {}], ["device_tap", { x: 1, y: 1 }], ["device_app", { action: "launch" }], ["preview_start", {}], ["preview_stop", {}]] as const) {
      const out = await call(name, args);
      expect(out.isError, name).toBe(true);
      expect(out.content[0].text).toMatch(/paused your control of this session's device/);
    }
    expect(device.tree).not.toHaveBeenCalled();
    expect(device.tap).not.toHaveBeenCalled();
    expect(preview.app).not.toHaveBeenCalled();
    expect(preview.start).not.toHaveBeenCalled();
    expect(preview.stop).not.toHaveBeenCalled();
    expect((await call("preview_status")).isError).toBeUndefined();
    // On Mobile the browser's pause is not the one that counts.
    device.setPaused(s.id, false);
    host.isPaused.mockReturnValue(true);
    expect((await call("preview_start")).isError).toBeUndefined();
    // And on the web the device's pause is not.
    const web = make();
    web.device.setPaused(web.s.id, true);
    expect((await web.call("preview_start")).isError).toBeUndefined();
  });

  it("calls are refused off Mobile, for a non-agent session and while no device runs", async () => {
    const web = make();
    web.fake.boot(web.s.id, ios);
    expect((await web.call("device_snapshot")).content[0].text).toBe("The device is off: this project's platform is not set, not Mobile.");

    // The agent listed the tools before the project became a web one.
    const switched = mobile();
    switched.registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/p1", platform: "web" });
    expect((await switched.call("device_tap", { x: 1, y: 1 })).content[0].text).toBe("The device is off: this project's platform is web, not Mobile.");
    expect(switched.device.tap).not.toHaveBeenCalled();

    expect((await mobile(ios, { kind: "chat" }).call("device_snapshot")).content[0].text).toMatch(/only for agent sessions/);
    const idle = mobile(null);
    const out = await idle.call("device_snapshot");
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/not running.*preview_start/);
    expect(idle.device.tree).not.toHaveBeenCalled();
  });

  it("device actions wait in the session's queue", async () => {
    const { call, device } = mobile();
    const order: string[] = [];
    let release!: () => void;
    device.tap.mockImplementationOnce(async () => {
      order.push("tap:start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("tap:end");
    });
    device.type.mockImplementationOnce(async () => {
      order.push("type");
    });
    const tapping = call("device_tap", { x: 1, y: 1 });
    const typing = call("device_type", { text: "a" });
    await vi.waitFor(() => expect(order).toEqual(["tap:start"]));
    release();
    await Promise.all([tapping, typing]);
    expect(order).toEqual(["tap:start", "tap:end", "type"]);
  });
});

describe("browser_screenshot with path", () => {
  // "iVBORw0K" is the fake host's base64 — the PNG signature's first 6 bytes.
  const png = Buffer.from("iVBORw0K", "base64");

  it("saves the PNG under the worktree's docs/ and answers with the path, not the image", async () => {
    const worktree = tmp();
    const { host, s, call } = make(undefined, { worktreePath: worktree });
    const path = "docs/design/2026-10-29-orders/screens/list-empty@390.png";
    expect(await call("browser_screenshot", { path, full_page: true })).toEqual({ content: [{ type: "text", text: `saved ${path} (${png.length} bytes)` }] });
    expect(host.screenshot).toHaveBeenCalledWith({ sessionId: s.id, projectId: "p1" }, { fullPage: true });
    expect(readFileSync(join(worktree, path))).toEqual(png);
  });

  it("refuses a bad path or a session without its own worktree, capturing and writing nothing", async () => {
    const worktree = tmp();
    const inWorktree = make(undefined, { worktreePath: worktree });
    for (const path of ["../x.png", "src/x.png", "docs/x.jpg"]) {
      const out = await inWorktree.call("browser_screenshot", { path });
      expect(out.isError, path).toBe(true);
    }
    expect(inWorktree.host.screenshot).not.toHaveBeenCalled();

    const checkout = tmp();
    const inCheckout = make(undefined, { worktreePath: checkout, worktree: false });
    const out = await inCheckout.call("browser_screenshot", { path: "docs/x.png" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/worktree/);
    expect(inCheckout.host.screenshot).not.toHaveBeenCalled();
    expect(existsSync(join(checkout, "docs"))).toBe(false);
  });
});

describe("screenshotFile", () => {
  it("accepts a .png under docs/, resolved inside the worktree", () => {
    const worktree = tmp();
    const file = screenshotFile(worktree, "docs/a/b@390.png");
    expect(file.endsWith(join("docs", "a", "b@390.png"))).toBe(true);
    expect(screenshotFile(worktree, "docs/Shot.PNG").endsWith("Shot.PNG")).toBe(true);
  });

  it.each([
    ["../x.png"],
    ["/abs/docs/x.png"],
    ["docs/../x.png"],
    ["docs/./x.png"],
    ["docs//x.png"],
    ["docs\\x.png"],
    ["src/x.png"],
    ["docs"],
    ["docs/x.jpg"],
    ["docs/.png"],
  ])("refuses %s", (path) => {
    expect(() => screenshotFile(tmp(), path)).toThrow(/`path`/);
  });

  it("refuses a path that a symlink inside docs/ leads out of the worktree", () => {
    const worktree = tmp();
    const outside = tmp();
    mkdirSync(join(worktree, "docs"));
    symlinkSync(outside, join(worktree, "docs", "link"));
    expect(() => screenshotFile(worktree, "docs/link/x.png")).toThrow(/outside/);
    expect(() => screenshotFile(worktree, "docs/link/deeper/x.png")).toThrow(/outside/);
    // A symlink to /tmp itself, as an agent might plant it.
    symlinkSync("/tmp", join(worktree, "docs", "tmp"));
    expect(() => screenshotFile(worktree, "docs/tmp/x.png")).toThrow(/outside/);
  });

  it("refuses a dangling symlink at the file itself", () => {
    const worktree = tmp();
    mkdirSync(join(worktree, "docs"));
    symlinkSync(join(tmp(), "missing.png"), join(worktree, "docs", "x.png"));
    expect(() => screenshotFile(worktree, "docs/x.png")).toThrow(/outside/);
  });
});
