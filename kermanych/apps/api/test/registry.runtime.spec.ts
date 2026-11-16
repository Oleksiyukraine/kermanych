import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

test("session round-trips runtime", () => {
  const r = new RegistryService(":memory:");
  const proj = r.upsertProject({ id: "p-1", name: "test" });
  
  const session = r.createSession({
    projectId: proj.id,
    name: "task",
    task: "do it",
    worktreePath: "/tmp/wt",
    branch: "feature/test",
    runtime: "claude-code",
  });

  expect(session.runtime).toBe("claude-code");
  
  const sessions = r.listSessions(proj.id);
  expect(sessions[0].runtime).toBe("claude-code");
});

test("session runtime defaults to undefined", () => {
  const r = new RegistryService(":memory:");
  const proj = r.upsertProject({ id: "p-1", name: "test" });
  
  const session = r.createSession({
    projectId: proj.id,
    name: "task",
    task: "do it",
    worktreePath: "/tmp/wt",
    branch: "feature/test",
  });

  expect(session.runtime).toBeUndefined();
  expect(r.listSessions(proj.id)[0].runtime).toBeUndefined();
});

// «Глибокий аналіз»: set at creation, or by the write that promotes a research into a
// deep-analysis agent (and cleared by that promotion's revert); surfaced only when set.
test("session round-trips deepAnalysis", () => {
  const r = new RegistryService(":memory:");
  const proj = r.upsertProject({ id: "p-1", name: "test" });
  const base = { projectId: proj.id, name: "task", task: "do it", worktreePath: "/tmp/wt", branch: "feature/test" };
  const deep = r.createSession({ ...base, deepAnalysis: true });
  const plain = r.createSession({ ...base, deepAnalysis: false });
  const absent = r.createSession(base);
  const promoted = r.createSession(base);
  const reverted = r.createSession({ ...base, deepAnalysis: true });

  r.updateSession(deep.id, { status: "done" });
  r.updateSession(plain.id, { status: "done" });
  r.updateSession(promoted.id, { deepAnalysis: true });
  r.updateSession(reverted.id, { deepAnalysis: undefined });
  const byId = new Map(r.listSessions(proj.id).map((s) => [s.id, s]));
  expect(byId.get(deep.id)?.deepAnalysis).toBe(true);
  expect(byId.get(promoted.id)?.deepAnalysis).toBe(true);
  expect("deepAnalysis" in byId.get(plain.id)!).toBe(false);
  expect("deepAnalysis" in byId.get(absent.id)!).toBe(false);
  expect("deepAnalysis" in byId.get(reverted.id)!).toBe(false);
});

test("session guards runtime with isNativeHarness", () => {
  const r = new RegistryService(":memory:");
  const proj = r.upsertProject({ id: "p-1", name: "test" });
  
  const session = r.createSession({
    projectId: proj.id,
    name: "task",
    task: "do it",
    worktreePath: "/tmp/wt",
    branch: "feature/test",
    runtime: "omp",
  });

  // Access private db to corrupt with invalid value — tests the guard logic
  type DbAccess = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };
  const db = (r as unknown as DbAccess).db;
  db.prepare(`UPDATE sessions SET runtime = ? WHERE id = ?`).run("invalid-runtime", session.id);
  
  // Should be filtered out by the isNativeHarness guard
  const sessions = r.listSessions(proj.id);
  expect(sessions[0].runtime).toBeUndefined();
});

test("updateSession persists runtime changes", () => {
  const r = new RegistryService(":memory:");
  const proj = r.upsertProject({ id: "p-1", name: "test" });
  
  const session = r.createSession({
    projectId: proj.id,
    name: "task",
    task: "do it",
    worktreePath: "/tmp/wt",
    branch: "feature/test",
    runtime: "omp",
  });

  const updated = r.updateSession(session.id, { runtime: "claude-code" });
  expect(updated.runtime).toBe("claude-code");
  expect(r.listSessions(proj.id)[0].runtime).toBe("claude-code");
});

// Decision 9 of docs/specs/2026-11-05-remove-managed-claude-code.md: at start, every managed
// `claude-code` row loses its slot-queue entry and stops if it was active; plain agent rows
// become native claude sessions; every other such row (chats too) is archived. A second start changes nothing.
test("start retires managed claude-code rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "kmq-retire-"));
  try {
    const path = join(dir, "k.sqlite");
    const r = new RegistryService(path);
    const proj = r.upsertProject({ id: "p-1", name: "test" });
    const base = { projectId: proj.id, name: "t", task: "do it", worktreePath: "/tmp/wt", branch: "feature/t" };
    const agent = r.createSession({ ...base, runtime: "claude-code", status: "thinking" });
    const chat = r.createSession({ ...base, runtime: "claude-code", kind: "chat", status: "done" });
    const design = r.createSession({ ...base, runtime: "claude-code" });
    const minion = r.createSession({ ...base, runtime: "claude-code", minion: true, status: "queued" });
    const tester = r.createSession({ ...base, runtime: "claude-code", kind: "review", tester: true });
    const review = r.createSession({ ...base, runtime: "claude-code", kind: "review" });
    const native = r.createSession({ ...base, runtime: "claude-code", native: true, status: "thinking" });
    const omp = r.createSession({ ...base, runtime: "omp", status: "thinking" });
    type DbAccess = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };
    (r as unknown as DbAccess).db.prepare(`UPDATE sessions SET pending_prompt = 'go', slot_queued_at = 1`).run();
    // A row of the retired «Дизайн» tab: only an old database still carries its folder.
    (r as unknown as DbAccess).db.prepare(`UPDATE sessions SET design_dir = 'docs/design/x' WHERE id = ?`).run(design.id);

    const read = (reg: RegistryService) => new Map(reg.listSessions(proj.id).map((s) => [s.id, s]));
    const queue = (reg: RegistryService, id: string) =>
      (reg as unknown as { db: { prepare: (sql: string) => { get: (id: string) => unknown } } }).db
        .prepare(`SELECT pending_prompt as p, slot_queued_at as q FROM sessions WHERE id = ?`)
        .get(id) as { p: string | null; q: number | null };

    const once = new RegistryService(path);
    const byId = read(once);
    expect(byId.get(agent.id)).toMatchObject({ native: true, status: "stopped", archived: false });
    for (const id of [chat.id, design.id, minion.id, tester.id, review.id]) {
      expect(byId.get(id)?.native).toBeUndefined();
      expect(byId.get(id)?.archived).toBe(true);
    }
    // An archived row left `queued` would hold a Посіпака slot and its card for ever.
    expect(byId.get(minion.id)?.status).toBe("stopped");
    for (const id of [agent.id, chat.id, design.id, minion.id, tester.id, review.id]) expect(queue(once, id)).toEqual({ p: null, q: null });
    // Already-native and omp rows are not touched.
    expect(byId.get(native.id)).toMatchObject({ status: "thinking", archived: false });
    expect(byId.get(omp.id)).toMatchObject({ status: "thinking", archived: false });
    expect(queue(once, native.id)).toEqual({ p: "go", q: 1 });
    expect(queue(once, omp.id)).toEqual({ p: "go", q: 1 });

    const twice = new RegistryService(path);
    expect(read(twice)).toEqual(byId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// docs/specs/2026-11-16-research-mode.md, decision 9: native chats are gone, so the rows left
// from before are archived at start (one mid-turn reads as stopped); native agents and managed
// chats stay as they are.
test("start archives native chat rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "kmq-native-chat-"));
  try {
    const path = join(dir, "k.sqlite");
    const r = new RegistryService(path);
    const proj = r.upsertProject({ id: "p-1", name: "test" });
    const base = { projectId: proj.id, name: "t", task: "", worktreePath: "", branch: "", worktree: false };
    const idle = r.createSession({ ...base, kind: "chat", runtime: "codex", native: true, status: "done" });
    const busy = r.createSession({ ...base, kind: "chat", runtime: "omp", native: true, status: "thinking" });
    const managed = r.createSession({ ...base, kind: "chat", runtime: "omp", status: "done" });
    const agent = r.createSession({ ...base, kind: "agent", runtime: "omp", native: true, status: "thinking" });

    const once = new Map(new RegistryService(path).listSessions(proj.id).map((s) => [s.id, s]));
    expect(once.get(idle.id)).toMatchObject({ archived: true, status: "done" });
    expect(once.get(busy.id)).toMatchObject({ archived: true, status: "stopped" });
    expect(once.get(managed.id)).toMatchObject({ archived: false, status: "done" });
    expect(once.get(agent.id)).toMatchObject({ archived: false, status: "thinking" });

    const twice = new Map(new RegistryService(path).listSessions(proj.id).map((s) => [s.id, s]));
    expect(twice).toEqual(once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
