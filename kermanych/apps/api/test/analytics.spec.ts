// apps/api/test/analytics.spec.ts
// «Аналітика»'s ledger writers (docs/specs/2026-11-07-developer-analytics.md, decisions 5-6): the
// one-time history import, the crash recovery of open spans, and codex's cumulative usage.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Subject } from "rxjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, Session } from "@kermanych/core";
import { AnalyticsService, importedHistory } from "../src/analytics/analytics.service";
import { RegistryService } from "../src/registry/registry.service";
import { codexFileUsageEvents, usageHourEntries } from "../src/native/native-session.service";
import type { NativeSessionService } from "../src/native/native-session.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";

type DbAccess = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };
const sql = (r: RegistryService, q: string, ...args: unknown[]) => (r as unknown as DbAccess).db.prepare(q).run(...args);

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// One omp `type:"message"` line, as omp writes it.
function ompLine(role: string, at: number, usage?: { input: number; output: number; cost: number }): string {
  return JSON.stringify({
    type: "message",
    timestamp: iso(at),
    message: {
      role,
      timestamp: at,
      ...(usage
        ? { model: "opus-5", duration: 1_000, usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, cost: { total: usage.cost } } }
        : {}),
    },
  });
}

// Partial mocks at the DI seams: the service only reads `events$` and the file resolver.
function make(registry: RegistryService) {
  const events = new Subject<ServerEvent>();
  const supervisor = { events$: events.asObservable() } as unknown as SupervisorService;
  const native = { sessionFilePath: (s: Session) => s.ompSessionFile } as unknown as NativeSessionService;
  return { svc: new AnalyticsService(supervisor, registry, native), events };
}

const rows = (r: RegistryService) => r.analyticsRows(undefined, iso(0), iso(Date.now() + 10 * HOUR));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kermanych-analytics-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("history import", () => {
  it("counts only what predates ledger_started_at, and a re-run counts nothing twice", async () => {
    const r = new RegistryService(":memory:");
    r.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/p1" });
    const ledger = Date.parse(r.analyticsMeta().ledgerStartedAt);
    const file = join(dir, "s1.jsonl");
    const prUrl = "https://github.com/o/r/pull/7";
    writeFileSync(
      file,
      [
        ompLine("user", ledger - 3 * HOUR),
        ompLine("assistant", ledger - 3 * HOUR + 60_000, { input: 10, output: 5, cost: 0.5 }),
        JSON.stringify({ type: "message", timestamp: iso(ledger - 2 * HOUR), message: { role: "toolResult", timestamp: ledger - 2 * HOUR, content: [{ type: "text", text: prUrl }] } }),
        // At and after the line: live recording's, not the import's.
        ompLine("user", ledger),
        ompLine("assistant", ledger + 60_000, { input: 1_000, output: 1_000, cost: 9 }),
      ].join("\n"),
    );
    const s = r.createSession({ projectId: "p1", name: "a", task: "t", worktreePath: "", branch: "b", ompSessionFile: file });
    r.updateSession(s.id, { prOpened: true, prUrl });
    const { svc } = make(r);

    await svc.runImport();
    const first = rows(r);
    expect(first.usage).toEqual([
      expect.objectContaining({ sessionId: s.id, hour: iso(Math.floor((ledger - 3 * HOUR + 60_000) / HOUR) * HOUR), calls: 1, input: 10, output: 5, cost: 0.5, costKnown: true, modelMs: 1_000 }),
    ]);
    expect(first.spans).toEqual([{ sessionId: s.id, projectId: "p1", kind: "working", startedAt: iso(ledger - 3 * HOUR), endedAt: iso(ledger - 2 * HOUR) }]);
    expect(r.listSessions().find((x) => x.id === s.id)!.prOpenedAt).toBe(iso(ledger - 2 * HOUR));
    expect(r.analyticsMeta().import).toEqual({ state: "done", done: 1, total: 1 });
    expect(r.analyticsMeta().importStats?.files).toBe(1);

    // Done is done: a later start does not import again.
    await svc.runImport();
    expect(rows(r)).toEqual(first);

    // A run cut short by a crash (state left `running`) re-runs from the top without double counting.
    r.setAnalyticsImport({ state: "running", done: 0, total: 1 });
    await svc.runImport();
    expect(rows(r).usage).toEqual(first.usage);
    expect(rows(r).spans).toEqual(first.spans);
  });

  it("leaves out a fork's inherited history", () => {
    const ledger = Date.parse("2026-11-07T12:00:00.000Z");
    const forkedAt = ledger - 5 * HOUR;
    const text = [
      ompLine("user", forkedAt - 2 * HOUR),
      ompLine("assistant", forkedAt - 2 * HOUR + 60_000, { input: 100, output: 100, cost: 3 }),
      ompLine("user", forkedAt + HOUR),
      ompLine("assistant", forkedAt + HOUR + 60_000, { input: 7, output: 3, cost: 0.25 }),
    ].join("\n");
    const fork = { id: "f", projectId: "p1", kind: "discussion", parentSessionId: "parent", createdAt: iso(forkedAt), status: "done" } as Session;

    const h = importedHistory(fork, text, iso(ledger));
    expect(h.usage).toEqual([expect.objectContaining({ calls: 1, input: 7, output: 3, cost: 0.25 })]);
    expect(h.working).toEqual([{ startedAt: iso(forkedAt + HOUR), endedAt: iso(forkedAt + HOUR + 60_000) }]);
  });
});

describe("activity spans", () => {
  it("a span left open by a crash closes at its session's last activity", () => {
    const r = new RegistryService(":memory:");
    r.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/p1" });
    const s = r.createSession({ projectId: "p1", name: "a", task: "t", worktreePath: "", branch: "b" });
    const started = "2026-11-07T09:00:00.000Z";
    const last = "2026-11-07T09:42:00.000Z";
    r.openSpan(s.id, "p1", "working", started);
    sql(r, `UPDATE sessions SET last_activity_at = ? WHERE id = ?`, last, s.id);
    // Already done: the import has nothing to do in this test.
    r.setAnalyticsImport({ state: "done", done: 0, total: 0 });

    make(r).svc.onModuleInit();

    expect(rows(r).spans).toEqual([{ sessionId: s.id, projectId: "p1", kind: "working", startedAt: started, endedAt: last }]);
  });

  it("opens on a status's kind, keeps thinking ↔ tool as one span, and closes on leaving", () => {
    const r = new RegistryService(":memory:");
    r.setAnalyticsImport({ state: "done", done: 0, total: 0 });
    const { svc, events } = make(r);
    svc.onModuleInit();
    const s = { id: "s1", projectId: "p1" } as Session;
    for (const status of ["thinking", "tool", "thinking", "waiting_input", "done"] as const) events.next({ type: "session_update", session: { ...s, status } });

    expect(rows(r).spans.map((x) => x.kind).sort()).toEqual(["waiting", "working"]);
    svc.onModuleDestroy();
  });
});

describe("codex usage", () => {
  it("diffs the cumulative token_count totals into per-call usage", () => {
    const tc = (at: string, input: number, cached: number, output: number) =>
      JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    const text = [
      JSON.stringify({ timestamp: "2026-11-07T09:00:00.000Z", type: "turn_context", payload: { model: "gpt-6" } }),
      tc("2026-11-07T09:10:00.000Z", 100, 40, 10),
      // codex repeats an unchanged total: no call.
      tc("2026-11-07T09:11:00.000Z", 100, 40, 10),
      tc("2026-11-07T10:05:00.000Z", 250, 140, 30),
    ].join("\n");

    const events = codexFileUsageEvents(text);
    expect(events.map((e) => e.usage)).toEqual([
      { input: 60, output: 10, cacheRead: 40, cacheWrite: 0, cost: 0 },
      { input: 50, output: 20, cacheRead: 100, cacheWrite: 0, cost: 0 },
    ]);
    expect(usageHourEntries(events, () => true)).toEqual([
      { hour: "2026-11-07T09:00:00.000Z", model: "gpt-6", calls: 1, modelMs: 0, input: 60, output: 10, cacheRead: 40, cacheWrite: 0, cost: 0 },
      { hour: "2026-11-07T10:00:00.000Z", model: "gpt-6", calls: 1, modelMs: 0, input: 50, output: 20, cacheRead: 100, cacheWrite: 0, cost: 0 },
    ]);
  });
});
