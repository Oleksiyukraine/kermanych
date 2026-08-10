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
  }

  listGroups(): Group[] {
    return this.db
      .prepare(
        `SELECT id, name, project_dir as projectDir, preview_command as previewCommand, api_command as apiCommand, created_at as createdAt FROM groups ORDER BY created_at`,
      )
      .all() as Group[];
  }

  createGroup(g: Omit<Group, "id" | "createdAt">): Group {
    const row: Group = { ...g, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare(`INSERT INTO groups (id, name, project_dir, created_at) VALUES (?,?,?,?)`)
      .run(row.id, row.name, row.projectDir, row.createdAt);
    return row;
  }

  updateGroup(id: string, patch: { previewCommand?: string; apiCommand?: string }): Group {
    const cur = this.listGroups().find((g) => g.id === id);
    if (!cur) throw new Error("group not found");
    const next = { ...cur, ...patch };
    this.db
      .prepare(`UPDATE groups SET preview_command=?, api_command=? WHERE id=?`)
      .run(next.previewCommand ?? null, next.apiCommand ?? null, id);
    return next;
  }

  removeGroup(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE group_id = ?`).run(id);
    this.db.prepare(`DELETE FROM groups WHERE id = ?`).run(id);
  }

  listSessions(groupId?: string): Session[] {
    const sql = `SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, status, archived, created_at as createdAt FROM sessions`;
    const rows = (
      groupId
        ? this.db.prepare(sql + ` WHERE group_id = ? ORDER BY created_at`).all(groupId)
        : this.db.prepare(sql + ` ORDER BY created_at`).all()
    ) as (Omit<Session, "archived"> & { archived: number })[];
    // SQLite stores the flag as 0/1; hand callers a real boolean.
    return rows.map((r) => ({ ...r, archived: r.archived !== 0 }));
  }

  createSession(
    s: Omit<Session, "id" | "createdAt" | "status"> & { status?: SessionStatus },
  ): Session {
    const row: Session = {
      ...s,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: s.status ?? "queued",
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, omp_session_id, omp_session_file, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.groupId,
        row.name,
        row.task,
        row.worktreePath,
        row.branch,
        row.ompSessionId ?? null,
        row.ompSessionFile ?? null,
        row.status,
        row.createdAt,
      );
    return row;
  }

  updateSession(id: string, patch: Partial<Session>): Session {
    const cur = this.listSessions().find((s) => s.id === id);
    if (!cur) throw new Error("session not found");
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE sessions SET name=?, task=?, worktree_path=?, branch=?, omp_session_id=?, omp_session_file=?, status=?, archived=? WHERE id=?`,
      )
      .run(
        next.name,
        next.task,
        next.worktreePath,
        next.branch,
        next.ompSessionId ?? null,
        next.ompSessionFile ?? null,
        next.status,
        next.archived ? 1 : 0,
        id,
      );
    return next;
  }

  removeSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }
}
