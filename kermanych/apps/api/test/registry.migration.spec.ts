// apps/api/test/registry.migration.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-migrate-"));
  file = join(dir, "kermanych.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Build the pre-cloud (v0) schema by hand: the two baseline tables plus every additive
// column the old constructor added, i.e. exactly what a real user's DB looks like today.
function seedLegacyDb(path: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, project_dir TEXT, created_at TEXT,
    preview_command TEXT, api_command TEXT, carry_files TEXT NOT NULL DEFAULT '[".env"]',
    color TEXT, default_branch TEXT, conventions TEXT)`);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, group_id TEXT, name TEXT, task TEXT,
    worktree_path TEXT, branch TEXT, omp_session_id TEXT, omp_session_file TEXT, status TEXT,
    created_at TEXT, archived INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT,
    worktree INTEGER NOT NULL DEFAULT 1, base_branch TEXT, parent_session_id TEXT,
    kind TEXT NOT NULL DEFAULT 'agent', model TEXT, prefix TEXT, platform TEXT)`);
  db.prepare(
    `INSERT INTO groups (id, name, project_dir, carry_files, color, default_branch, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run("g-legacy", "Acme", "/tmp/acme", '[".env",".env.local"]', "#ff563c", "main", "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, status, created_at, last_activity_at, kind, worktree) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("s-legacy", "g-legacy", "old task", "do it", "/wt/old", "feature/old", "done", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "agent", 1);
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  db.close();
}

test("v0 -> v1 renames groups/project_dir/group_id and preserves every row", () => {
  seedLegacyDb(file);

  const r = new RegistryService(file);

  const projects = r.listProjects();
  expect(projects).toHaveLength(1);
  expect(projects[0]!.id).toBe("g-legacy");
  expect(projects[0]!.name).toBe("Acme");
  expect(projects[0]!.localRepoPath).toBe("/tmp/acme");
  expect(projects[0]!.carryFiles).toEqual([".env", ".env.local"]);
  expect(projects[0]!.color).toBe("#ff563c");
  expect(projects[0]!.defaultBranch).toBe("main");
  expect(projects[0]!.createdAt).toBe("2026-01-01T00:00:00.000Z");

  const sessions = r.listSessions("g-legacy");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.id).toBe("s-legacy");
  expect(sessions[0]!.projectId).toBe("g-legacy");
  expect(sessions[0]!.branch).toBe("feature/old");
  expect(sessions[0]!.status).toBe("done");
  expect(sessions[0]!.taskId).toBeUndefined();

  const db = new Database(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  expect(tables).toContain("projects");
  expect(tables).not.toContain("groups");
  db.close();
});

test("reopening a migrated DB is a no-op and keeps the data", () => {
  seedLegacyDb(file);
  new RegistryService(file);

  const again = new RegistryService(file);
  expect(again.listProjects().map((p) => p.id)).toEqual(["g-legacy"]);
  expect(again.listProjects()[0]!.localRepoPath).toBe("/tmp/acme");
  expect(again.listSessions().map((s) => s.projectId)).toEqual(["g-legacy"]);

  const db = new Database(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  db.close();
});

test("a fresh DB gets the v1 shape, task_id and the project index without any rename", () => {
  const r = new RegistryService(file);
  const p = r.upsertProject({ id: "cloud-1", name: "Fresh", localRepoPath: "/tmp/fresh" });
  const s = r.createSession({
    projectId: p.id, taskId: "task-1", name: "t", task: "do", worktreePath: "", branch: "b",
  });
  expect(s.taskId).toBe("task-1");
  expect(r.listSessions("cloud-1")[0]!.taskId).toBe("task-1");

  const db = new Database(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((i) => i.name);
  expect(indexes).toContain("sessions_project_idx");
  db.close();
});

test("a legacy row gains the usage column, and a session's spend survives reopen and patches", () => {
  seedLegacyDb(file);

  const first = new RegistryService(file);
  // The column is additive, so an existing agent has no figure — not a zeroed one.
  expect(first.listSessions()[0]!.usage).toBeUndefined();
  first.addUsage("s-legacy", { input: 5, output: 7, cacheRead: 1000, cacheWrite: 200, cost: 0.5 });
  first.addUsage("s-legacy", { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.25 });
  // A whole-row patch must not touch the total: updateSession rebuilds the row from a read
  // taken before the turn landed, and money that goes backwards is money nobody trusts.
  first.updateSession("s-legacy", { status: "thinking" });

  const reopened = new RegistryService(file);
  const s = reopened.listSessions()[0]!;
  expect(s.status).toBe("thinking");
  expect(s.usage).toEqual({ input: 8, output: 11, cacheRead: 1000, cacheWrite: 200, cost: 0.75 });
});
