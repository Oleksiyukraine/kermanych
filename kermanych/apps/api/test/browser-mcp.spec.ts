// apps/api/test/browser-mcp.spec.ts
// The session browser's MCP server (docs/specs/2026-10-05-embedded-browser.md): the per-session
// bearer, the binding a launch is handed, and tools/call routed to the desktop app's host for
// the right session and project. The host is a fake BrowserHost.
import { HttpException } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryService } from "../src/registry/registry.service";
import type { PreviewService } from "../src/preview/preview.service";
import { setBrowserHost, type BrowserActionResult, type BrowserHost, type BrowserNetworkEntry } from "../src/browser/browser-host";
import { BrowserMcpService, NETWORK_OUTPUT_LIMIT } from "../src/browser/browser-mcp.service";
import { BrowserMcpController } from "../src/http/browser-mcp.controller";

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
    has: vi.fn(() => true),
    close: vi.fn(),
  } satisfies BrowserHost;
}

function make(previewUrl?: string) {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/p1" });
  const s = registry.createSession({ projectId: "p1", name: "n", task: "t", worktreePath: "", branch: "b" });
  const preview = { urlOf: vi.fn(() => previewUrl) } as unknown as PreviewService;
  const mcp = new BrowserMcpService(registry, preview, http);
  const host = fakeHost();
  setBrowserHost(host);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    // handle() answers unknown; a tools/call request always gets a JSON-RPC result.
    const reply = (await mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: CallResult };
    return reply.result;
  };
  return { mcp, host, s, call };
}

afterEach(() => setBrowserHost(undefined));

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

  it("no binding without a browser host", () => {
    const { mcp, s } = make();
    setBrowserHost(undefined);
    expect(mcp.bindingFor(s.id)).toBeUndefined();
  });

  it("lists every browser tool with a closed object schema", async () => {
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
    ]);
    for (const t of tools) {
      expect(t.description).toMatch(/THIS session only/);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties)).toContain(r);
    }
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
    expect(out.content[0].text).toMatch(/preview/);
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
