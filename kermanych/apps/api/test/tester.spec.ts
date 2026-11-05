// «Тестувальник» (docs/specs/2026-11-04-qa-tester-agent.md): the qa-run guard and launch, the
// MCP tools a tester run gets, the credential tool's secrecy, the parent's preview, «Створити ПР»
// keeping an existing checklist, and ⤴ of a run with nothing to hand over. A Mobile project's run
// on the doer's device: docs/specs/2026-11-04-tester-mobile-device.md.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Subject } from "rxjs";
import type { HttpAdapterHost } from "@nestjs/core";
import type { DeviceRuntime, PreviewConfigStatus, PreviewState, QaChecklist, QaChecklistItem, ServerEvent, Session } from "@kermanych/core";
import type { Task } from "@kermanych/cloud";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { PreviewService } from "../src/preview/preview.service";
import { fakeDevice } from "./fake-device";
import type { BrowserMcpService as BrowserMcp } from "../src/browser/browser-mcp.service";

type RpcOpts = { cwd: string; tools?: string[] };
const started: RpcOpts[] = [];
const prompts: string[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: RpcOpts) { started.push(opts); }
    onEvent() {} onExit() {}
    async start() {} async switchSession() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; } async stop() {}
    isAlive() { return true; }
    prompt(m: string) { prompts.push(m); } followUp(m: string) { prompts.push(m); } steer(m: string) { prompts.push(m); }
  }
  return { RpcSession: FakeRpc };
});

const cards = new Map<string, Task>();
let cardReadFails = false;
const patchQaItems = vi.fn(async (_c: unknown, taskId: string, ids: string[], patch: Record<string, unknown>, drop: string[] = []): Promise<QaChecklist> => {
  const card = cards.get(taskId)!;
  const items = card.qaChecklist!.items.map((i) => {
    if (!ids.includes(i.id)) return i;
    const next: Record<string, unknown> = { ...i, ...patch };
    for (const k of drop) delete next[k];
    return next as QaChecklistItem;
  });
  if (!card.qaChecklist!.items.some((i) => ids.includes(i.id))) throw new Error("qa checklist item not found");
  const checklist = { ...card.qaChecklist!, items };
  cards.set(taskId, { ...card, qaChecklist: checklist });
  return checklist;
});
const setQaChecklistIfEmpty = vi.fn(async (_c: unknown, taskId: string, checklist: QaChecklist) => {
  const card = cards.get(taskId)!;
  if (card.qaChecklist?.items.length) return false;
  cards.set(taskId, { ...card, qaChecklist: checklist });
  return true;
});
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_c: unknown, id: string) => {
    if (cardReadFails) throw new Error("fetch failed");
    return cards.get(id);
  },
  patchQaItems: (...a: Parameters<typeof patchQaItems>) => patchQaItems(...a),
  setQaChecklistIfEmpty: (...a: Parameters<typeof setQaChecklistIfEmpty>) => setQaChecklistIfEmpty(...a),
  patchTask: async () => undefined,
  listProjects: async () => [],
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { BrowserMcpService } from "../src/browser/browser-mcp.service";
import { TesterController } from "../src/http/tester.controller";
import { setBrowserHost, type BrowserHost } from "../src/browser/browser-host";
import { stubSkills } from "./skills-stub";

const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;
const auth = { current: () => ({ userId: "u1", accessToken: "t" }), cloudClient: () => ({}) } as unknown as AuthService;
const page = { url: "http://localhost:5199/", title: "App" };

function fakeHost() {
  return {
    navigate: vi.fn(async (_t, url: string) => ({ url, title: "App", status: 200 })),
    type: vi.fn(async () => page),
    openPreview: vi.fn(async () => {}),
    isPaused: vi.fn(() => false),
    has: vi.fn(() => true),
    close: vi.fn(),
  } as unknown as BrowserHost & { navigate: Mock; type: Mock; close: Mock };
}

function card(id: string, items: Partial<QaChecklistItem>[] = []): Task {
  const t = { id, projectId: "p1", title: "Login", status: "in_progress" } as unknown as Task;
  if (items.length) t.qaChecklist = { generatedAt: "2026-11-01T00:00:00Z", items: items.map((i, n) => ({ id: `q${n + 1}`, text: `item ${n + 1}`, checked: false, ...i })) };
  return t;
}

function make(opts: { platform?: "web" | "backend" | "mobile"; host?: boolean } = {}) {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/kmq-tester", ...(opts.platform ? { platform: opts.platform } : {}) });
  const worktree = {
    currentBranch: vi.fn().mockResolvedValue("main"),
    unmergedFiles: vi.fn().mockResolvedValue([]),
    fetchBranch: vi.fn().mockResolvedValue("skipped"),
    refExists: vi.fn().mockResolvedValue(false),
    behindCount: vi.fn().mockResolvedValue(0),
  };
  // The doer's preview: its config decides whether a run may start (session-env spec, decision 3).
  const config: { status: PreviewConfigStatus } = { status: { kind: "ok", services: ["web"], platforms: [] } };
  const preview = {
    urlOf: vi.fn(() => undefined as string | undefined),
    state: vi.fn((): PreviewState | null => null),
    start: vi.fn(),
    settled: vi.fn(async () => null),
    info: vi.fn(() => ({ state: null, config: config.status })),
    changes$: new Subject(),
    states: () => ({}),
    stopUnfit: async () => {},
    forget: async () => {},
    stop: async () => {},
    retire: async () => {},
  };
  const fake = fakeDevice();
  const browser = new BrowserMcpService(registry, preview as unknown as PreviewService, fake.device, http, auth);
  const bindingFor = vi.spyOn(browser, "bindingFor");
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth, stubSkills(), undefined as never, undefined, browser, undefined, undefined, undefined, undefined, undefined, preview as unknown as PreviewService);
  const events: ServerEvent[] = [];
  sup.events$.subscribe((e) => events.push(e));
  const host = fakeHost();
  if (opts.host !== false) setBrowserHost(host);
  const doer = registry.createSession({ projectId: "p1", taskId: "t1", name: "Login", task: "Add login", worktreePath: "/tmp/kmq-tester-wt", branch: "feature/login" });
  registry.updateSession(doer.id, { ompSessionFile: "/tmp/doer.jsonl", status: "done" });
  return { registry, sup, browser, bindingFor, preview, config, host, events, doer, fake };
}

async function mcp(browser: BrowserMcp, sessionId: string, method: string, params: Record<string, unknown> = {}) {
  return ((await browser.handle(sessionId, { jsonrpc: "2.0", id: 1, method, params })) as { result: unknown }).result;
}
const list = async (browser: BrowserMcp, id: string) => ((await mcp(browser, id, "tools/list")) as { tools: { name: string }[] }).tools.map((t) => t.name);
const call = async (browser: BrowserMcp, id: string, name: string, args: Record<string, unknown>) =>
  (await mcp(browser, id, "tools/call", { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };

beforeEach(() => {
  started.length = 0;
  prompts.length = 0;
  cards.clear();
  cardReadFails = false;
  patchQaItems.mockClear();
  setQaChecklistIfEmpty.mockClear();
});
afterEach(() => setBrowserHost(undefined));

describe("POST qa-run guard", () => {
  it("refuses a session without a card, a non-agent, no browser host, a back-end project and a second run", async () => {
    const plain = make();
    const local = plain.registry.createSession({ projectId: "p1", name: "x", task: "x", worktreePath: "/tmp/w", branch: "b" });
    await expect(plain.sup.runTester(local.id, "all")).rejects.toThrow(/task card/);

    cards.set("t1", card("t1", [{}]));
    const tester = await plain.sup.runTester(plain.doer.id, "all");
    await expect(plain.sup.runTester(plain.doer.id, "all")).rejects.toThrow(/already running/);
    await expect(plain.sup.runTester(tester.id, "all")).rejects.toThrow(/only agent sessions/);

    setBrowserHost(undefined);
    const noHost = make({ host: false });
    await expect(noHost.sup.runTester(noHost.doer.id, "all")).rejects.toThrow(/desktop app/);

    const backend = make({ platform: "backend" });
    await expect(backend.sup.runTester(backend.doer.id, "all")).rejects.toThrow(/neither a browser nor a device/);
  });

  // docs/specs/2026-11-04-session-env-and-tester-preview-gate.md, decision 3: a run whose preview
  // cannot start would block every item, so it does not start at all.
  it("refuses while the doer's .kermanych/preview.json is missing or invalid, and starts once it is valid", async () => {
    const { sup, doer, registry, config, preview } = make();
    cards.set("t1", card("t1", [{}]));

    config.status = { kind: "missing" };
    await expect(sup.runTester(doer.id, "all")).rejects.toThrow(/set up the live preview first: \.kermanych\/preview\.json is missing/);
    config.status = { kind: "invalid", error: "services[0].command is required" };
    await expect(sup.runTester(doer.id, "all")).rejects.toThrow(/is invalid: services\[0\]\.command is required/);
    expect(preview.info).toHaveBeenCalledWith(doer.id);
    expect(registry.listSessions().some((s) => s.tester === true)).toBe(false);
    expect(patchQaItems).not.toHaveBeenCalled();

    config.status = { kind: "ok", services: ["web"], platforms: [] };
    await expect(sup.runTester(doer.id, "all")).resolves.toMatchObject({ tester: true });
  });

  it("launches a tester review child with the browser binding and clears in-scope verdicts", async () => {
    const { sup, doer, events, bindingFor } = make();
    const verdict = { status: "failed", note: "x", sessionId: "old", at: "2026-11-01T00:00:00Z" };
    cards.set("t1", card("t1", [{ agent: { ...verdict, status: "passed" } as QaChecklistItem["agent"] }, { agent: verdict as QaChecklistItem["agent"] }, {}]));

    const child = await sup.runTester(doer.id, "open");

    expect(child).toMatchObject({ kind: "review", tester: true, parentSessionId: doer.id, name: "тестування: Login" });
    expect(started.at(-1)).toMatchObject({ cwd: "/tmp/kmq-tester-wt", tools: ["read", "grep", "glob"] });
    expect(bindingFor).toHaveBeenCalledWith(child.id);
    // `open`: the failed and the never-tested item, not the passed one.
    expect(patchQaItems).toHaveBeenCalledWith(expect.anything(), "t1", ["q2", "q3"], {}, ["agent"]);
    expect(events.some((e) => e.type === "qa_checklist_update" && e.taskId === "t1")).toBe(true);
    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("`q2`");
    expect(prompt).not.toContain("`q1`: item 1");
    expect(prompt).toContain("report_qa_result");
  });
});

describe("tester MCP tools", () => {
  it("tools/list: a tester gets browser, credential, preview and QA tools; a plain review none of them; an agent no QA tools", async () => {
    const { sup, browser, doer, registry } = make();
    cards.set("t1", card("t1", [{}]));
    const tester = await sup.runTester(doer.id, "all");
    const review = registry.createSession({ projectId: "p1", name: "r", task: "t", worktreePath: "", branch: "", worktree: false, kind: "review", parentSessionId: doer.id });

    const t = await list(browser, tester.id);
    expect(t).toEqual(expect.arrayContaining(["browser_navigate", "browser_type_credential", "preview_start", "report_qa_result", "set_qa_checklist", "report_finding"]));
    const r = await list(browser, review.id);
    expect(r.some((n) => n.startsWith("preview_") || n === "report_qa_result" || n === "set_qa_checklist" || n === "browser_type_credential")).toBe(false);
    const a = await list(browser, doer.id);
    expect(a).toContain("preview_start");
    expect(a.some((n) => n === "report_qa_result" || n === "set_qa_checklist" || n === "browser_type_credential")).toBe(false);
  });

  it("browser_type_credential types the password into the ephemeral page and never answers it", async () => {
    const { sup, browser, doer, registry, host } = make();
    cards.set("t1", card("t1", [{}]));
    registry.setTesterSettings("p1", { loginPath: "/login", notes: "", accounts: [{ id: "a1", name: "Адмін", login: "admin@x.io", password: "s3cret-pw", note: "" }] });
    const tester = await sup.runTester(doer.id, "all");
    expect(prompts.at(-1)).not.toContain("s3cret-pw");

    const out = await call(browser, tester.id, "browser_type_credential", { ref: "e3", account: "Адмін", field: "password" });

    expect(out.isError).toBeFalsy();
    expect(host.type).toHaveBeenCalledWith({ sessionId: tester.id, projectId: "p1", ephemeral: true }, "e3", "s3cret-pw", { clear: true, submit: false });
    expect(JSON.stringify(out)).not.toContain("s3cret-pw");
    expect(out.content[0].text).toContain("password of «Адмін»");

    host.type.mockRejectedValueOnce(new Error("could not type s3cret-pw into e3"));
    const failed = await call(browser, tester.id, "browser_type_credential", { ref: "e3", account: "Адмін", field: "password" });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("s3cret-pw");
  });

  it("a tester's preview tools and URL-less navigate act on the parent's preview", async () => {
    const { sup, browser, doer, preview, host } = make();
    cards.set("t1", card("t1", [{}]));
    const tester = await sup.runTester(doer.id, "all");
    preview.urlOf.mockImplementation(((id: string) => (id === doer.id ? "http://localhost:5199/" : undefined)) as () => undefined);

    await call(browser, tester.id, "preview_start", {});
    expect(preview.start).toHaveBeenCalledWith(doer.id, { restart: false });

    await call(browser, tester.id, "browser_navigate", {});
    expect(host.navigate).toHaveBeenCalledWith({ sessionId: tester.id, projectId: "p1", ephemeral: true }, "http://localhost:5199/");
  });

  it("report_qa_result writes the verdict onto the parent's card and announces it", async () => {
    const { sup, browser, doer, events } = make();
    cards.set("t1", card("t1", [{}]));
    const tester = await sup.runTester(doer.id, "all");

    const out = await call(browser, tester.id, "report_qa_result", { itemId: "q1", status: "passed", note: "Logged in." });

    expect(out.isError).toBeFalsy();
    expect(cards.get("t1")!.qaChecklist!.items[0].agent).toMatchObject({ status: "passed", note: "Logged in.", sessionId: tester.id });
    expect(events.filter((e) => e.type === "qa_checklist_update").length).toBeGreaterThanOrEqual(2);
    expect((await call(browser, tester.id, "report_qa_result", { itemId: "q9", status: "passed", note: "x" })).isError).toBe(true);
    expect((await call(browser, tester.id, "set_qa_checklist", { items: ["a"] })).isError).toBe(true);
  });
});

describe("a Mobile project's tester (docs/specs/2026-11-04-tester-mobile-device.md)", () => {
  const runtime: DeviceRuntime = { platform: "ios", serial: "SIM-UDID-1", name: "iPhone 16", screen: { width: 393, height: 852 } };
  const runningOnDevice = { phase: "running", url: null, services: [], device: runtime, app: "running" } as unknown as PreviewState;

  it("starts without a browser host and gets the doer's device and preview, never the browser", async () => {
    const { sup, browser, doer } = make({ platform: "mobile", host: false });
    cards.set("t1", card("t1", [{}]));

    const tester = await sup.runTester(doer.id, "all");

    expect(prompts.at(-1)).toContain("device_type_credential");
    const t = await list(browser, tester.id);
    expect(t).toEqual(expect.arrayContaining(["device_snapshot", "device_tap", "device_type_credential", "preview_start", "report_qa_result"]));
    expect(t.some((n) => n.startsWith("browser_"))).toBe(false);
    expect(await list(browser, doer.id)).not.toContain("device_type_credential");
  });

  it("the first preview_start restarts the doer's preview clean; device tools wait for it, then drive the doer's device", async () => {
    const { sup, browser, doer, preview, fake } = make({ platform: "mobile" });
    cards.set("t1", card("t1", [{}]));
    const tester = await sup.runTester(doer.id, "all");
    fake.boot(doer.id, runtime);
    preview.state.mockReturnValue(runningOnDevice);

    const early = await call(browser, tester.id, "device_snapshot", {});
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toMatch(/preview_start first/);

    await call(browser, tester.id, "preview_start", { restart: false });
    expect(preview.start).toHaveBeenLastCalledWith(doer.id, { restart: true, clean: true });
    // Still starting: the clean start is followed, not started again.
    preview.state.mockReturnValue({ phase: "starting", step: "device", services: [] } as unknown as PreviewState);
    await call(browser, tester.id, "preview_start", {});
    expect(preview.start).toHaveBeenCalledTimes(1);
    expect((await call(browser, tester.id, "device_snapshot", {})).isError).toBe(true);

    preview.state.mockReturnValue(runningOnDevice);
    expect((await call(browser, tester.id, "device_snapshot", {})).isError).toBeFalsy();
    expect(fake.device.tree).toHaveBeenLastCalledWith(doer.id);
    await call(browser, tester.id, "preview_start", {});
    expect(preview.start).toHaveBeenLastCalledWith(doer.id, { restart: false });
    expect((await call(browser, tester.id, "preview_start", { platform: "android" })).isError).toBe(true);

    // A failed clean start is retried clean by the next run's first start.
    const next = make({ platform: "mobile" });
    cards.set("t1", card("t1", [{}]));
    const again = await next.sup.runTester(next.doer.id, "all");
    await call(next.browser, again.id, "preview_start", {});
    next.preview.state.mockReturnValue({ phase: "failed", step: "device", error: "could not clear the data" } as unknown as PreviewState);
    await call(next.browser, again.id, "preview_start", {});
    expect(next.preview.start.mock.calls).toEqual([
      [next.doer.id, { restart: true, clean: true }],
      [next.doer.id, { restart: true, clean: true }],
    ]);
  });

  it("locks the doer out of the device until the run is handed over, and types a credential without answering it", async () => {
    const { sup, browser, doer, preview, fake, registry } = make({ platform: "mobile" });
    cards.set("t1", card("t1", [{}]));
    registry.setTesterSettings("p1", { loginPath: "myapp://login", notes: "", accounts: [{ id: "a1", name: "Адмін", login: "admin@x.io", password: "s3cret-pw", note: "" }] });
    const tester = await sup.runTester(doer.id, "all");
    expect(prompts.at(-1)).toContain("`myapp://login` — open it with `device_open_url`");
    fake.boot(doer.id, runtime);
    preview.state.mockReturnValue(runningOnDevice);

    expect((await call(browser, doer.id, "device_tap", { x: 10, y: 10 })).content[0].text).toMatch(/busy with a «Тестувальник» run/);
    expect((await call(browser, doer.id, "preview_stop", {})).isError).toBe(true);
    expect((await call(browser, doer.id, "preview_status", {})).isError).toBeFalsy();

    await call(browser, tester.id, "preview_start", {});
    const out = await call(browser, tester.id, "device_type_credential", { account: "Адмін", field: "password" });
    expect(out.isError).toBeFalsy();
    expect(fake.device.type).toHaveBeenCalledWith(doer.id, "s3cret-pw", { secret: true });
    expect(JSON.stringify(out)).not.toContain("s3cret-pw");
    fake.device.type.mockRejectedValueOnce(new Error("paste of s3cret-pw failed"));
    const failed = await call(browser, tester.id, "device_type_credential", { account: "Адмін", field: "password" });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("s3cret-pw");

    await sup.mergeDiscussion(tester.id);
    expect((await call(browser, doer.id, "device_tap", { x: 10, y: 10 })).isError).toBeFalsy();
    expect(fake.device.tap).toHaveBeenLastCalledWith(doer.id, 10, 10);
  });
});

describe("createPullRequest and the QA directive", () => {
  it("asks for a checklist only when the card has none, and not when the card cannot be read", async () => {
    const { sup, doer } = make();
    cards.set("t1", card("t1"));
    await sup.createPullRequest(doer.id);
    expect(prompts.at(-1)).toContain("kermanych-action");

    cards.set("t1", card("t1", [{}]));
    await sup.createPullRequest(doer.id);
    expect(prompts.at(-1)).not.toContain("kermanych-action");

    cardReadFails = true;
    await sup.createPullRequest(doer.id);
    expect(prompts.at(-1)).not.toContain("kermanych-action");
  });
});

describe("⤴ of a tester run", () => {
  it("sends nothing when every item passed, retires the child and closes its browser", async () => {
    const { sup, doer, registry, host } = make();
    cards.set("t1", card("t1", [{}]));
    const tester = await sup.runTester(doer.id, "all");
    const passed: QaChecklistItem["agent"] = { status: "passed", note: "ok", sessionId: tester.id, at: "2026-11-04T00:00:00Z" };
    cards.set("t1", card("t1", [{ agent: passed }]));
    const sent = prompts.length;

    await sup.mergeDiscussion(tester.id);

    expect(prompts.length).toBe(sent);
    expect(registry.listSessions().find((s: Session) => s.id === tester.id)?.status).toBe("merged");
    expect(host.close).toHaveBeenCalledWith(tester.id);
  });

  it("hands the failed items to the doer", async () => {
    const { sup, doer } = make();
    cards.set("t1", card("t1", [{}]));
    const tester = await sup.runTester(doer.id, "all");
    cards.set("t1", card("t1", [{ agent: { status: "failed", note: "500 on submit", sessionId: tester.id, at: "2026-11-04T00:00:00Z" } }]));

    await sup.mergeDiscussion(tester.id);

    expect(prompts.at(-1)).toContain("[тестування: Login]");
    expect(prompts.at(-1)).toContain("500 on submit");
  });
});

describe("tester settings", () => {
  it("PUT trims, drops accounts without a name or login, assigns missing ids, keeps order; GET reads them back", () => {
    const registry = new RegistryService(":memory:");
    registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/kmq-tester" });
    const ctl = new TesterController(registry);

    const saved = ctl.put("p1", {
      loginPath: " /login ",
      notes: " no deletes ",
      accounts: [
        { id: "", name: " Адмін ", login: " a@x.io ", password: " pw ", note: "" },
        { name: "", login: "nobody" },
        { id: "keep", name: "User", login: "u@x.io", password: "p2", note: " n " },
      ],
    });

    expect(saved.loginPath).toBe("/login");
    expect(saved.notes).toBe("no deletes");
    expect(saved.accounts.map((a) => [a.name, a.login, a.password, a.note])).toEqual([["Адмін", "a@x.io", " pw ", ""], ["User", "u@x.io", "p2", "n"]]);
    expect(saved.accounts[0].id).not.toBe("");
    expect(saved.accounts[1].id).toBe("keep");
    expect(ctl.get("p1")).toEqual(saved);
    expect(() => ctl.get("nope")).toThrow(/project not found/);
  });
});
