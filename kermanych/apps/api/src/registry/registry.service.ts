// apps/api/src/registry/registry.service.ts
import { Injectable, Optional } from "@nestjs/common";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Project, Session, SessionStatus } from "@kermanych/core";

// The cached Supabase session. Lives in SQLite so a restarted api still knows who
// its user is without a cloud round trip.
export type AuthSessionRow = {
  userId: string;
  accessToken: string;
  expiresAt?: string;
  githubUsername?: string;
};

// A queued cloud status push. One row per task — the outbox is a latest-wins mailbox, not a
// log: if a session goes thinking → tool → thinking while offline, only the newest status is
// worth sending, and the cloud board has no use for the intermediate ones.
export type OutboxRow = { taskId: string; status: SessionStatus; updatedAt: string; attempts: number; lastError?: string };

@Injectable()
export class RegistryService {
  private db: Database.Database;

  constructor(@Optional() path: string = process.env.KERMANYCH_DB ?? join(homedir(), ".kermanych", "kermanych.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL + busy timeout so a preview instance that shares this file (Kermanych previewing
    // itself) can't crash the main api on concurrent access.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    // Versioned migration FIRST: on a legacy DB, `CREATE TABLE IF NOT EXISTS projects`
    // below would create an empty table and make the RENAME impossible forever.
    this.migrateToV1();
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, local_repo_path TEXT, created_at TEXT)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, task TEXT, worktree_path TEXT, branch TEXT, omp_session_id TEXT, omp_session_file TEXT, status TEXT, created_at TEXT)`,
    );
    // The one cached Supabase session for this machine. Single-row by construction
    // (CHECK id = 1): one developer per Kermanych install. The guard compares the
    // presented bearer against access_token; expires_at is informational for the
    // UI, because an expired token must still control the LOCAL machine (spec D4).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS auth_session (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL, access_token TEXT NOT NULL, expires_at TEXT, github_username TEXT)`,
    );
    // Additive migration: preview commands arrived after the initial schema.
    for (const col of ["preview_command", "api_command"]) {
      try {
        this.db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
      } catch {
        /* column already exists */
      }
    }
    // Additive migration: archiving arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    // Additive migration: last-activity tracking arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_activity_at TEXT`);
    } catch {
      /* column already exists */
    }
    // Backfill pre-existing rows so the column is never null for old sessions.
    this.db.exec(`UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL`);
    // Additive migration: worktree isolation toggle + in-place base branch.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree INTEGER NOT NULL DEFAULT 1`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN base_branch TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'`);
    } catch {
      /* column already exists */
    }
    // Additive migration: per-project carry-files list arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN carry_files TEXT NOT NULL DEFAULT '[".env"]'`);
    } catch {
      /* column already exists */
    }
    // Additive migration: per-project accent color arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN color TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: per-project default fork branch arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN default_branch TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: per-project PR/commit convention fallback arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN conventions TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: backlog tasks persist their launch config (branch prefix + model)
    // so "Start" can spawn them later with the same settings the operator chose.
    for (const col of ["model", "prefix", "platform"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
      } catch {
        /* column already exists */
      }
    }
    // Additive migration: a session launched from a cloud task remembers which task it is.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN task_id TEXT`);
    } catch {
      /* column already exists */
    }
    // The first index in this schema: listSessions(projectId) filters on project_id on
    // every board render and every supervisor lookup.
    this.db.exec(`CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id)`);
    // Durable queue of cloud status pushes. `task_id` is the PRIMARY KEY, so an UPSERT
    // collapses a burst of changes into the newest one. No FK: the tasks live in Postgres.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS status_outbox (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
    );
  }

  // v1 (2026-08-21, team cloud): `groups` becomes `projects`, its id becomes the CLOUD
  // project UUID, `project_dir` becomes `local_repo_path` (this machine's binding) and
  // `sessions.group_id` becomes `sessions.project_id`. Guarded by pragma user_version so
  // it runs exactly once; the shape checks make a second run on a half-migrated DB safe.
  private migrateToV1(): void {
    if (Number(this.db.pragma("user_version", { simple: true })) >= 1) return;
    const tables = new Set(
      (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
    );
    if (tables.has("groups") && !tables.has("projects")) this.db.exec(`ALTER TABLE groups RENAME TO projects`);
    if (this.hasColumn("projects", "project_dir"))
      this.db.exec(`ALTER TABLE projects RENAME COLUMN project_dir TO local_repo_path`);
    if (this.hasColumn("sessions", "group_id"))
      this.db.exec(`ALTER TABLE sessions RENAME COLUMN group_id TO project_id`);
    this.db.pragma("user_version = 1");
  }

  // Exception-swallowing is not enough for RENAME COLUMN: "no such table" (fresh DB) and
  // "no such column" (already migrated) are indistinguishable, and one must not silence
  // the other. `pragma table_info` on a missing table returns no rows.
  private hasColumn(table: string, column: string): boolean {
    return (this.db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, local_repo_path as localRepoPath, color, preview_command as previewCommand, api_command as apiCommand, carry_files as carryFiles, default_branch as defaultBranch, conventions, created_at as createdAt FROM projects ORDER BY created_at`,
      )
      .all() as (Omit<Project, "carryFiles"> & { carryFiles: string })[];
    // An unbound project stores NULL/"" for its path; hand callers a plain "" so a
    // `!project.localRepoPath` check is all the launch path ever needs.
    return rows.map((r) => ({ ...r, localRepoPath: r.localRepoPath ?? "", carryFiles: JSON.parse(r.carryFiles) as string[], color: r.color ?? undefined, defaultBranch: r.defaultBranch ?? undefined, conventions: r.conventions ?? undefined }));
  }

  // Local project rows MIRROR cloud projects, so the id always comes from the caller —
  // never randomUUID. A cloud refresh omits localRepoPath, and the CASE below keeps this
  // machine's existing binding instead of wiping it (design D1).
  upsertProject(p: Omit<Project, "createdAt" | "localRepoPath"> & { localRepoPath?: string; createdAt?: string }): Project {
    const row: Project = {
      ...p,
      localRepoPath: p.localRepoPath ?? "",
      carryFiles: p.carryFiles ?? [".env"],
      createdAt: p.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, local_repo_path, color, preview_command, api_command, carry_files, default_branch, conventions, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           local_repo_path = CASE WHEN excluded.local_repo_path = '' THEN projects.local_repo_path ELSE excluded.local_repo_path END,
           color = excluded.color,
           preview_command = excluded.preview_command,
           api_command = excluded.api_command,
           carry_files = excluded.carry_files,
           default_branch = excluded.default_branch,
           conventions = excluded.conventions`,
      )
      .run(row.id, row.name, row.localRepoPath, row.color || null, row.previewCommand ?? null, row.apiCommand ?? null, JSON.stringify(row.carryFiles), row.defaultBranch || null, row.conventions || null, row.createdAt);
    // Re-read: the CASE may have kept a binding (and the original created_at) the caller
    // never sent, so the in-memory `row` is not the truth.
    return this.listProjects().find((x) => x.id === row.id)!;
  }

  patchProject(id: string, patch: { name?: string; localRepoPath?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string }): Project {
    const cur = this.listProjects().find((p) => p.id === id);
    if (!cur) throw new Error("project not found");
    const next = { ...cur, ...patch, color: (patch.color ?? cur.color) || undefined, defaultBranch: (patch.defaultBranch ?? cur.defaultBranch) || undefined, conventions: (patch.conventions ?? cur.conventions) || undefined };
    this.db
      .prepare(`UPDATE projects SET name=?, local_repo_path=?, color=?, preview_command=?, api_command=?, carry_files=?, default_branch=?, conventions=? WHERE id=?`)
      .run(next.name, next.localRepoPath, next.color || null, next.previewCommand ?? null, next.apiCommand ?? null, JSON.stringify(next.carryFiles ?? [".env"]), next.defaultBranch || null, next.conventions || null, id);
    return next;
  }

  removeProject(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  listSessions(projectId?: string): Session[] {
    const sql = `SELECT id, project_id as projectId, task_id as taskId, name, task, worktree_path as worktreePath, branch, worktree, base_branch as baseBranch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, parent_session_id as parentSessionId, kind, model, prefix, platform, status, archived, created_at as createdAt, last_activity_at as lastActivityAt FROM sessions`;
    const rows = (
      projectId
        ? this.db.prepare(sql + ` WHERE project_id = ? ORDER BY created_at`).all(projectId)
        : this.db.prepare(sql + ` ORDER BY created_at`).all()
    ) as (Omit<Session, "archived" | "worktree"> & { archived: number; worktree: number })[];
    // SQLite stores the flag as 0/1; hand callers a real boolean.
    return rows.map((r) => ({ ...r, archived: r.archived !== 0, worktree: r.worktree !== 0, taskId: r.taskId ?? undefined, model: r.model ?? undefined, prefix: r.prefix ?? undefined, platform: r.platform ?? undefined }));
  }

  createSession(
    s: Omit<Session, "id" | "createdAt" | "status" | "worktree" | "baseBranch" | "lastActivityAt" | "kind" | "parentSessionId"> & {
      status?: SessionStatus; worktree?: boolean; baseBranch?: string;
      kind?: Session["kind"]; parentSessionId?: string;
    },
  ): Session {
    const createdAt = new Date().toISOString();
    const row: Session = {
      ...s,
      worktree: s.worktree ?? true,
      baseBranch: s.baseBranch,
      kind: s.kind ?? "agent",
      parentSessionId: s.parentSessionId,
      id: randomUUID(),
      createdAt,
      status: s.status ?? "queued",
      lastActivityAt: createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, task_id, name, task, worktree_path, branch, worktree, base_branch, omp_session_id, omp_session_file, parent_session_id, kind, model, prefix, platform, status, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.taskId ?? null,
        row.name,
        row.task,
        row.worktreePath,
        row.branch,
        row.worktree ? 1 : 0,
        row.baseBranch ?? null,
        row.ompSessionId ?? null,
        row.ompSessionFile ?? null,
        row.parentSessionId ?? null,
        row.kind,
        row.model ?? null,
        row.prefix ?? null,
        row.platform ?? null,
        row.status,
        row.createdAt,
        row.lastActivityAt,
      );
    return row;
  }

  updateSession(id: string, patch: Partial<Session>): Session {
    const cur = this.listSessions().find((s) => s.id === id);
    if (!cur) throw new Error("session not found");
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE sessions SET project_id=?, task_id=?, name=?, task=?, worktree_path=?, branch=?, worktree=?, base_branch=?, omp_session_id=?, omp_session_file=?, kind=?, model=?, prefix=?, platform=?, status=?, archived=? WHERE id=?`,
      )
      .run(
        next.projectId,
        next.taskId ?? null,
        next.name,
        next.task,
        next.worktreePath,
        next.branch,
        next.worktree ? 1 : 0,
        next.baseBranch ?? null,
        next.ompSessionId ?? null,
        next.ompSessionFile ?? null,
        next.kind,
        next.model ?? null,
        next.prefix ?? null,
        next.platform ?? null,
        next.status,
        next.archived ? 1 : 0,
        id,
      );
    return next;
  }

  // Bump the session's activity clock. A targeted write (no read-modify-write)
  // because it runs on the high-frequency agent-event path.
  touchSession(id: string): void {
    this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  removeSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // Queue (or replace) the pending cloud status for a task. Resetting `attempts` is
  // deliberate: a NEW status is a new delivery, so it must not inherit the previous
  // status's backoff and wait a minute before its first try.
  enqueueTaskStatus(taskId: string, status: SessionStatus, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO status_outbox (task_id, status, updated_at, attempts, last_error) VALUES (?,?,?,0,NULL)
         ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, attempts = 0, last_error = NULL`,
      )
      .run(taskId, status, updatedAt);
  }

  listOutbox(): OutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT task_id as taskId, status, updated_at as updatedAt, attempts, last_error as lastError FROM status_outbox ORDER BY updated_at`,
      )
      .all() as (Omit<OutboxRow, "lastError"> & { lastError: string | null })[];
    return rows.map((r) => ({ ...r, lastError: r.lastError ?? undefined }));
  }

  // Retire ONE version of a task's queued status: the row the caller has just delivered,
  // identified by its `status`/`updated_at`. A push is awaited, and a `session_update`
  // landing during that await UPSERTs a newer status onto the same `task_id`; a delete by
  // id alone would drop that newer status unpushed — and the pusher's edge filter, which
  // already recorded it as sent, would never enqueue it again. Scoped this way, the
  // superseded row simply survives and the next pass ships it.
  dropOutbox(taskId: string, status: SessionStatus, updatedAt: string): void {
    this.db
      .prepare(`DELETE FROM status_outbox WHERE task_id = ? AND status = ? AND updated_at = ?`)
      .run(taskId, status, updatedAt);
  }

  // Charge a failed delivery to the exact version that failed, for the mirror of the reason
  // `dropOutbox` is scoped: a newer status may have UPSERTed onto this `task_id` mid-push,
  // and `enqueueTaskStatus` deliberately reset its `attempts` to 0. Bumping by id alone
  // would hand that fresh status a backoff it never earned, delaying a status the user is
  // waiting on. Scoped this way, a superseded row keeps its own counter.
  bumpOutboxAttempt(taskId: string, status: SessionStatus, updatedAt: string, error: string): void {
    this.db
      .prepare(
        `UPDATE status_outbox SET attempts = attempts + 1, last_error = ? WHERE task_id = ? AND status = ? AND updated_at = ?`,
      )
      .run(error, taskId, status, updatedAt);
  }

  getAuthSession(): AuthSessionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id as userId, access_token as accessToken, expires_at as expiresAt, github_username as githubUsername FROM auth_session WHERE id = 1`,
      )
      .get() as AuthSessionRow | undefined;
    if (!row) return undefined;
    return { ...row, expiresAt: row.expiresAt ?? undefined, githubUsername: row.githubUsername ?? undefined };
  }

  setAuthSession(row: AuthSessionRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO auth_session (id, user_id, access_token, expires_at, github_username) VALUES (1,?,?,?,?)`,
      )
      .run(row.userId, row.accessToken, row.expiresAt ?? null, row.githubUsername ?? null);
  }

  clearAuthSession(): void {
    this.db.prepare(`DELETE FROM auth_session WHERE id = 1`).run();
  }
}
