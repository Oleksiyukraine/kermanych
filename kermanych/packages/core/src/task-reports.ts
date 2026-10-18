// The reports a session leaves on its cloud card, so its «Документація» and «Сесія» tabs survive
// an api restart and «Завершити», and every member of the workspace can read them
// (docs/specs/2026-10-12-docs-tab-survives-restart.md). Each tab owns one column, the way the QA
// tab owns `tasks.qa_checklist`: `tasks.docs_report` and `tasks.session_report`.
//
// Pure, like docsRead and skillsUsed: the api builds a write from the session's own sources
// (its transcript, its worktree diff, its registry row), queues it, and merges it onto the card's
// current value when the queue drains. The UI only reads.

import { docsRead, isDocPath } from "./docs";
import { isNativeHarness, type NativeHarness } from "./runtime";
import { skillsUsed } from "./skills";
import { isThinkingLevel, type ThinkingLevel } from "./thinking";
import type { Session, TranscriptEntry, Usage } from "./types";

/** One changed documentation file, counted the way the «Зміни» listing counts it. */
export type DocChange = { path: string; added: number; removed: number };

/** «Документація»: what the session read, and what it created or updated. */
export type DocsReport = {
  /** The session this report describes; a relaunch of the card writes another one. */
  sessionId: string;
  /** ISO time of the write that produced this value. */
  generatedAt: string;
  read: string[];
  changed: DocChange[];
};

/** «Сесія»: what a teammate cannot read off the card itself. */
export type SessionReport = {
  sessionId: string;
  generatedAt: string;
  runtime: NativeHarness;
  native: boolean;
  /** What the agent actually ran with — the card's own `model`/`effort` are the launch request. */
  model?: string;
  effort?: ThinkingLevel;
  /** The working branch; the card's `branch` is the base it was asked to fork from. */
  branch: string;
  baseBranch?: string;
  worktree: boolean;
  skills: string[];
  usage?: Usage;
  /** omp's session id or claude's session UUID. Never a path on the author's disk. */
  providerSessionId?: string;
};

export type TaskReports = { docs?: DocsReport; session?: SessionReport };

/** The session-level facts a write carries whole: everything in SessionReport but the lists. */
export type SessionFacts = Omit<SessionReport, "sessionId" | "generatedAt" | "skills">;

/**
 * What one moment of a session knows. An absent `read` / `skills` means no transcript was at
 * hand — «Завершити» on a session that is dormant after a restart — so the card keeps its lists.
 * An absent `changed` means no listing was at hand, and the card keeps its list too.
 */
export type TaskReportsWrite = {
  sessionId: string;
  generatedAt: string;
  read?: string[];
  changed?: DocChange[];
  skills?: string[];
  session: SessionFacts;
};

export type ReportSource = Pick<
  Session,
  "id" | "runtime" | "native" | "model" | "effort" | "branch" | "baseBranch" | "worktree" | "usage" | "ompSessionId"
>;

/**
 * Build a write from what the session has right now: `entries` is its FULL transcript (omit it
 * when only the dormant notice is at hand), `changedFiles` the worktree's «Зміни» listing (omit
 * it when there is no worktree to list). Only documentation paths survive, exactly as the tab
 * filters them.
 */
export function taskReportsWrite(input: {
  session: ReportSource;
  at: string;
  entries?: readonly TranscriptEntry[];
  changedFiles?: readonly DocChange[];
}): TaskReportsWrite {
  const { session: s, entries, changedFiles } = input;
  const facts: SessionFacts = {
    runtime: s.runtime ?? "omp",
    native: s.native === true,
    branch: s.branch,
    worktree: s.worktree,
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.baseBranch ? { baseBranch: s.baseBranch } : {}),
    ...(s.usage ? { usage: s.usage } : {}),
    ...(s.ompSessionId ? { providerSessionId: s.ompSessionId } : {}),
  };
  return {
    sessionId: s.id,
    generatedAt: input.at,
    ...(entries ? { read: docsRead(entries), skills: skillsUsed(entries) } : {}),
    ...(changedFiles
      ? { changed: changedFiles.filter((f) => isDocPath(f.path)).map(({ path, added, removed }) => ({ path, added, removed })) }
      : {}),
    session: facts,
  };
}

// First-seen order, no repeats. Reads and skills only ever accumulate: a compacted context or a
// resume that rehydrates fewer messages must not make a document the agent read disappear.
function union(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const v of b) if (!out.includes(v)) out.push(v);
  return out;
}

/**
 * The card's reports once `write` lands, or `undefined` when the write is stale: the card already
 * holds a NEWER report of another session (the card was relaunched, and an old machine's queued
 * write must not overwrite it). The same session's reads and skills accumulate; its changed list
 * and session facts are replaced, so a reverted document drops out.
 */
export function mergeTaskReports(current: TaskReports, write: TaskReportsWrite): TaskReports | undefined {
  const own = <T extends { sessionId: string; generatedAt: string }>(r: T | undefined): T | undefined | null => {
    if (!r || r.sessionId === write.sessionId) return r;
    return r.generatedAt > write.generatedAt ? null : undefined;
  };
  const docs = own(current.docs);
  const session = own(current.session);
  if (docs === null || session === null) return undefined;
  return {
    docs: {
      sessionId: write.sessionId,
      generatedAt: write.generatedAt,
      read: union(docs?.read ?? [], write.read ?? []),
      changed: write.changed ?? docs?.changed ?? [],
    },
    session: {
      ...write.session,
      sessionId: write.sessionId,
      generatedAt: write.generatedAt,
      skills: union(session?.skills ?? [], write.skills ?? []),
    },
  };
}

/** Two queued writes for one card as one, so the outbox holds a single pending write per card. */
export function combineReportWrites(older: TaskReportsWrite, newer: TaskReportsWrite): TaskReportsWrite {
  if (older.sessionId !== newer.sessionId) return newer.generatedAt >= older.generatedAt ? newer : older;
  const read = older.read || newer.read ? union(older.read ?? [], newer.read ?? []) : undefined;
  const skills = older.skills || newer.skills ? union(older.skills ?? [], newer.skills ?? []) : undefined;
  const changed = newer.changed ?? older.changed;
  return {
    sessionId: newer.sessionId,
    generatedAt: newer.generatedAt > older.generatedAt ? newer.generatedAt : older.generatedAt,
    ...(read ? { read } : {}),
    ...(changed ? { changed } : {}),
    ...(skills ? { skills } : {}),
    session: newer.session,
  };
}

// ── reading a stored value back ───────────────────────────────────────────────
// The columns are jsonb a client of any version may have written, so a value is checked rather
// than cast: anything unusable reads as «no report», and a list keeps only its well-formed rows.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stamp(raw: Record<string, unknown>): { sessionId: string; generatedAt: string } | undefined {
  const { sessionId, generatedAt } = raw;
  return typeof sessionId === "string" && sessionId && typeof generatedAt === "string" && generatedAt
    ? { sessionId, generatedAt }
    : undefined;
}

export function readDocsReport(raw: unknown): DocsReport | undefined {
  if (!isObj(raw)) return undefined;
  const head = stamp(raw);
  if (!head) return undefined;
  const changed = Array.isArray(raw.changed)
    ? raw.changed.flatMap((c): DocChange[] => {
        if (!isObj(c) || typeof c.path !== "string" || !c.path) return [];
        const { added, removed } = c;
        return [{ path: c.path, added: typeof added === "number" && added > 0 ? added : 0, removed: typeof removed === "number" && removed > 0 ? removed : 0 }];
      })
    : [];
  const read = Array.isArray(raw.read) ? raw.read.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
  return { ...head, read, changed };
}

function readUsage(v: unknown): Usage | undefined {
  if (!isObj(v)) return undefined;
  const { input, output, cacheRead, cacheWrite, cost } = v;
  return typeof input === "number" && typeof output === "number" && typeof cacheRead === "number" && typeof cacheWrite === "number" && typeof cost === "number"
    ? { input, output, cacheRead, cacheWrite, cost }
    : undefined;
}

export function readSessionReport(raw: unknown): SessionReport | undefined {
  if (!isObj(raw)) return undefined;
  const head = stamp(raw);
  if (!head || !isNativeHarness(raw.runtime) || typeof raw.branch !== "string") return undefined;
  const usage = readUsage(raw.usage);
  return {
    ...head,
    runtime: raw.runtime,
    native: raw.native === true,
    branch: raw.branch,
    worktree: raw.worktree !== false,
    skills: Array.isArray(raw.skills) ? raw.skills.filter((n): n is string => typeof n === "string" && n.length > 0) : [],
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    ...(isThinkingLevel(raw.effort) ? { effort: raw.effort } : {}),
    ...(typeof raw.baseBranch === "string" && raw.baseBranch ? { baseBranch: raw.baseBranch } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof raw.providerSessionId === "string" && raw.providerSessionId ? { providerSessionId: raw.providerSessionId } : {}),
  };
}
