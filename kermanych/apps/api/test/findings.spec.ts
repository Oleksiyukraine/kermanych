// apps/api/test/findings.spec.ts
// «Знахідки» (docs/specs/2026-10-13-agent-findings.md): the agent reports over the session's MCP
// server (no desktop app needed), the registry keeps the findings with their session, the
// session row carries the open count to the UI, and the operator's decision is recorded once.
import type { HttpAdapterHost } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { OPEN_FINDINGS_LIMIT, type ServerEvent } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import type { PreviewService } from "../src/preview/preview.service";
import type { ModelsService } from "../src/models/models.service";
import { BrowserMcpService } from "../src/browser/browser-mcp.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SessionsController } from "../src/http/sessions.controller";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;
type CallResult = { content: { type: string; text: string }[]; isError?: boolean };

const report = {
  title: "Preview port stays bound after session deletion",
  kind: "bug",
  context: "Deleting a session leaves its preview running.",
  evidence: ["apps/api/src/supervisor/supervisor.service.ts:1869"],
  acceptanceCriteria: ["Deleting a session frees its preview port"],
};

function make() {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/p1" });
  const s = registry.createSession({ projectId: "p1", name: "n", task: "t", worktreePath: "", branch: "b" });
  const other = registry.createSession({ projectId: "p1", name: "o", task: "t", worktreePath: "", branch: "o" });
  const mcp = new BrowserMcpService(registry, { urlOf: () => undefined } as unknown as PreviewService, http);
  const sup = new SupervisorService(registry, new WorktreeService(), offlineAuth(), stubSkills(), undefined as unknown as ModelsService, undefined, mcp);
  const events: ServerEvent[] = [];
  sup.events$.subscribe((e) => events.push(e));
  const call = async (name: string, args: Record<string, unknown> = {}, sessionId = s.id): Promise<CallResult> => {
    const reply = (await mcp.handle(sessionId, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: CallResult };
    return reply.result;
  };
  const updates = () => events.flatMap((e) => (e.type === "session_update" ? [e.session] : []));
  return { registry, s, other, sup, call, updates, ctl: new SessionsController(sup, registry, {} as PreviewService) };
}

describe("report_finding / list_findings", () => {
  it("stores a report for the calling session only and pushes its open count", async () => {
    const { registry, s, other, call, updates } = make();
    const r = await call("report_finding", report);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/^Recorded finding /);
    expect(registry.listFindings(s.id)).toEqual([
      expect.objectContaining({ ...report, sessionId: s.id, status: "open" }),
    ]);
    expect(registry.listFindings(other.id)).toEqual([]);
    expect(updates().at(-1)).toMatchObject({ id: s.id, openFindings: 1 });
    expect(registry.listSessions().find((x) => x.id === other.id)).not.toHaveProperty("openFindings");
  });

  it("refuses a malformed report with the field to fix, and stores nothing", async () => {
    const { registry, s, call, updates } = make();
    const r = await call("report_finding", { ...report, kind: "style" });
    expect(r).toEqual({ content: [{ type: "text", text: expect.stringMatching(/^Not recorded: `kind` must be one of/) }], isError: true });
    expect(registry.listFindings(s.id)).toEqual([]);
    expect(updates()).toEqual([]);
  });

  it("stops at the open limit; a decided finding frees a slot", async () => {
    const { registry, s, call } = make();
    for (let i = 0; i < OPEN_FINDINGS_LIMIT; i++) await call("report_finding", { ...report, title: `Finding ${i}` });
    const refused = await call("report_finding", { ...report, title: "One too many" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/already wait for the operator/);
    registry.resolveFinding(s.id, registry.listFindings(s.id)[0]!.id, { status: "dismissed" });
    expect((await call("report_finding", { ...report, title: "Now it fits" })).isError).toBeUndefined();
  });

  it("lists every state with the filed target", async () => {
    const { registry, s, call } = make();
    expect((await call("list_findings")).content[0]!.text).toMatch(/No findings/);
    await call("report_finding", { ...report, title: "A" });
    await call("report_finding", { ...report, title: "B", kind: "docs" });
    await call("report_finding", { ...report, title: "C" });
    const [a, b] = registry.listFindings(s.id);
    registry.resolveFinding(s.id, a!.id, { status: "filed", target: { kind: "jira", key: "KRM-7", url: "https://x.atlassian.net/browse/KRM-7" } });
    registry.resolveFinding(s.id, b!.id, { status: "dismissed" });
    const text = (await call("list_findings")).content[0]!.text.split("\n");
    expect(text).toEqual([
      expect.stringMatching(/^- \[filed → Jira KRM-7\] \(bug\) A {2}id=/),
      expect.stringMatching(/^- \[dismissed\] \(docs\) B {2}id=/),
      expect.stringMatching(/^- \[open\] \(bug\) C {2}id=/),
    ]);
  });

  it("answers a deleted session with a tool error", async () => {
    const { registry, s, call } = make();
    registry.removeSession(s.id);
    const r = await call("report_finding", report);
    expect(r).toEqual({ content: [{ type: "text", text: "This session no longer exists." }], isError: true });
  });
});

describe("registry ownership", () => {
  it("findings go with their session and with their project", async () => {
    const { registry, s, other, call } = make();
    await call("report_finding", report);
    await call("report_finding", report, other.id);
    registry.removeSession(s.id);
    expect(registry.listFindings(s.id)).toEqual([]);
    expect(registry.listFindings(other.id)).toHaveLength(1);
    registry.removeProject("p1");
    expect(registry.listFindings(other.id)).toEqual([]);
  });
});

describe("findings routes", () => {
  it("records a filing once, drops the open count, and refuses a second decision", async () => {
    const { s, call, ctl, updates } = make();
    await call("report_finding", report);
    const [f] = ctl.listFindings(s.id);
    const filed = ctl.findingFiled(s.id, f!.id, { kind: "board", taskId: "t-1" });
    expect(filed).toMatchObject({ id: f!.id, status: "filed", target: { kind: "board", taskId: "t-1" } });
    expect(updates().at(-1)).toMatchObject({ id: s.id });
    expect(updates().at(-1)).not.toHaveProperty("openFindings");
    expect(() => ctl.dismissFinding(s.id, f!.id)).toThrow(expect.objectContaining({ status: 400, message: "finding is not open" }));
  });

  it("404s an unknown session or finding, 400s a malformed target", async () => {
    const { s, call, ctl } = make();
    await call("report_finding", report);
    const [f] = ctl.listFindings(s.id);
    expect(() => ctl.listFindings("nope")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => ctl.dismissFinding(s.id, "nope")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => ctl.findingFiled(s.id, f!.id, { kind: "jira", key: "K-1", url: "javascript:alert(1)" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => ctl.findingFiled(s.id, f!.id, { kind: "board" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(ctl.listFindings(s.id)[0]!.status).toBe("open");
  });
});
