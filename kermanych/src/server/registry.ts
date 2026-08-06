// src/server/registry.ts
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { Group, Session, SessionStatus } from "./types";

export class Registry {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, project_dir TEXT, created_at TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, group_id TEXT, name TEXT, task TEXT, worktree_path TEXT, branch TEXT, omp_session_id TEXT, omp_session_file TEXT, status TEXT, created_at TEXT)`);
  }
  listGroups(): Group[] {
    return this.db.query(`SELECT id, name, project_dir as projectDir, created_at as createdAt FROM groups ORDER BY created_at`).all() as Group[];
  }
  createGroup(g: Omit<Group, "id" | "createdAt">): Group {
    const row: Group = { id: randomUUID(), createdAt: new Date().toISOString(), ...g };
    this.db.run(`INSERT INTO groups (id, name, project_dir, created_at) VALUES (?,?,?,?)`, [row.id, row.name, row.projectDir, row.createdAt]);
    return row;
  }
  removeGroup(id: string): void {
    this.db.run(`DELETE FROM sessions WHERE group_id = ?`, [id]);
    this.db.run(`DELETE FROM groups WHERE id = ?`, [id]);
  }
  listSessions(groupId?: string): Session[] {
    const sql = `SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, status, created_at as createdAt FROM sessions`;
    return (groupId ? this.db.query(sql + ` WHERE group_id = ? ORDER BY created_at`).all(groupId) : this.db.query(sql + ` ORDER BY created_at`).all()) as Session[];
  }
  createSession(s: Omit<Session, "id" | "createdAt" | "status"> & { status?: SessionStatus }): Session {
    const row: Session = { id: randomUUID(), createdAt: new Date().toISOString(), status: s.status ?? "queued", ...s } as Session;
    this.db.run(`INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, omp_session_id, omp_session_file, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.groupId, row.name, row.task, row.worktreePath, row.branch, row.ompSessionId ?? null, row.ompSessionFile ?? null, row.status, row.createdAt]);
    return row;
  }
  updateSession(id: string, patch: Partial<Session>): Session {
    const cur = (this.db.query(`SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, status, created_at as createdAt FROM sessions WHERE id = ?`).get(id)) as Session;
    const next = { ...cur, ...patch };
    this.db.run(`UPDATE sessions SET name=?, task=?, worktree_path=?, branch=?, omp_session_id=?, omp_session_file=?, status=? WHERE id=?`,
      [next.name, next.task, next.worktreePath, next.branch, next.ompSessionId ?? null, next.ompSessionFile ?? null, next.status, id]);
    return next;
  }
  removeSession(id: string): void { this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]); }
}
