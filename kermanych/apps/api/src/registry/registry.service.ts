// apps/api/src/registry/registry.service.ts
import { Injectable, Optional } from "@nestjs/common";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Group, Session, SessionStatus } from "@kermanych/core";

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
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, project_dir TEXT, created_at TEXT)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, group_id TEXT, name TEXT, task TEXT, worktree_path TEXT, branch TEXT, omp_session_id TEXT, omp_session_file TEXT, status TEXT, created_at TEXT)`,
    );
    // Additive migration: preview commands arrived after the initial schema.
    for (const col of ["preview_command", "api_command"]) {
      try {
        this.db.exec(`ALTER TABLE groups ADD COLUMN ${col} TEXT`);
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
      this.db.exec(`ALTER TABLE groups ADD COLUMN carry_files TEXT NOT NULL DEFAULT '[".env"]'`);
    } catch {
      /* column already exists */
    }
    // Additive migration: per-project accent color arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE groups ADD COLUMN color TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: backlog tasks persist their launch config (branch prefix + model)
    // so "Start" can spawn them later with the same settings the operator chose.
    for (const col of ["model", "prefix"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
      } catch {
        /* column already exists */
      }
    }
  }

  listGroups(): Group[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, project_dir as projectDir, color, preview_command as previewCommand, api_command as apiCommand, carry_files as carryFiles, created_at as createdAt FROM groups ORDER BY created_at`,
      )
      .all() as (Omit<Group, "carryFiles"> & { carryFiles: string })[];
    return rows.map((r) => ({ ...r, carryFiles: JSON.parse(r.carryFiles) as string[], color: r.color ?? undefined }));
  }

  createGroup(g: Omit<Group, "id" | "createdAt">): Group {
    const carryFiles = g.carryFiles ?? [".env"];
    const row: Group = { ...g, carryFiles, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare(`INSERT INTO groups (id, name, project_dir, color, carry_files, created_at) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.name, row.projectDir, row.color || null, JSON.stringify(carryFiles), row.createdAt);
    return row;
  }

  updateGroup(id: string, patch: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[] }): Group {
    const cur = this.listGroups().find((g) => g.id === id);
    if (!cur) throw new Error("group not found");
    const next = { ...cur, ...patch, color: (patch.color ?? cur.color) || undefined };
    this.db
      .prepare(`UPDATE groups SET name=?, color=?, preview_command=?, api_command=?, carry_files=? WHERE id=?`)
      .run(next.name, next.color || null, next.previewCommand ?? null, next.apiCommand ?? null, JSON.stringify(next.carryFiles ?? [".env"]), id);
    return next;
  }

  removeGroup(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE group_id = ?`).run(id);
    this.db.prepare(`DELETE FROM groups WHERE id = ?`).run(id);
  }

  listSessions(groupId?: string): Session[] {
    const sql = `SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, worktree, base_branch as baseBranch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, parent_session_id as parentSessionId, kind, model, prefix, status, archived, created_at as createdAt, last_activity_at as lastActivityAt FROM sessions`;
    const rows = (
      groupId
        ? this.db.prepare(sql + ` WHERE group_id = ? ORDER BY created_at`).all(groupId)
        : this.db.prepare(sql + ` ORDER BY created_at`).all()
    ) as (Omit<Session, "archived" | "worktree"> & { archived: number; worktree: number })[];
    // SQLite stores the flag as 0/1; hand callers a real boolean.
    return rows.map((r) => ({ ...r, archived: r.archived !== 0, worktree: r.worktree !== 0, model: r.model ?? undefined, prefix: r.prefix ?? undefined }));
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
        `INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, worktree, base_branch, omp_session_id, omp_session_file, parent_session_id, kind, model, prefix, status, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.groupId,
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
        `UPDATE sessions SET name=?, task=?, worktree_path=?, branch=?, worktree=?, base_branch=?, omp_session_id=?, omp_session_file=?, kind=?, model=?, prefix=?, status=?, archived=? WHERE id=?`,
      )
      .run(
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
}
