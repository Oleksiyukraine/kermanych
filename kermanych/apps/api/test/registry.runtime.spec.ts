import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

test("auth_session round-trips agentRuntime", () => {
  const r = new RegistryService(":memory:");
  
  r.setAuthSession({
    userId: "u-1",
    accessToken: "jwt-1",
    agentRuntime: "claude-code",
  });

  const session = r.getAuthSession();
  expect(session?.agentRuntime).toBe("claude-code");
});

test("auth_session accepts omp runtime", () => {
  const r = new RegistryService(":memory:");
  
  r.setAuthSession({
    userId: "u-1",
    accessToken: "jwt-1",
    agentRuntime: "omp",
  });

  expect(r.getAuthSession()?.agentRuntime).toBe("omp");
});

test("auth_session agentRuntime is optional", () => {
  const r = new RegistryService(":memory:");
  
  r.setAuthSession({
    userId: "u-1",
    accessToken: "jwt-1",
  });

  expect(r.getAuthSession()?.agentRuntime).toBeUndefined();
});

test("auth_session guards agentRuntime with isAgentRuntime", () => {
  const r = new RegistryService(":memory:");
  
  r.setAuthSession({
    userId: "u-1",
    accessToken: "jwt-1",
  });
  
  // Access private db to corrupt with invalid value — tests the guard logic
  type DbAccess = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };
  const db = (r as unknown as DbAccess).db;
  db.prepare(`UPDATE auth_session SET agent_runtime = ? WHERE id = 1`).run("invalid-runtime");
  
  // Should be filtered out by isAgentRuntime guard
  const session = r.getAuthSession();
  expect(session?.agentRuntime).toBeUndefined();
});

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

test("session guards runtime with isAgentRuntime", () => {
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
  
  // Should be filtered out by isAgentRuntime guard
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
