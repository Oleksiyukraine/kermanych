// apps/api/src/registry/registry.service.ts
import { Injectable, Optional } from "@nestjs/common";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { Subject } from "rxjs";
import { isThinkingLevel, isAgentRuntime, isNativeHarness, isAgentLanguage, isFindingKind, parseFindingTarget, docsPolicy, combineReportWrites, readMinionResult, isMinionPauseCode, clampMinionCap, MINION_CAP_DEFAULT } from "@kermanych/core";
import type { AgentFinding, DocsPolicy, FindingReport, FindingTarget, MinionPause, MinionResult, Project, ResourceDecision, Session, SessionStatus, ThinkingLevel, Usage, AgentRuntimeKind, AgentLanguage, TaskReportsWrite } from "@kermanych/core";

// The cached Supabase session. Lives in SQLite so a restarted api still knows who
// its user is without a cloud round trip.
export type AuthSessionRow = {
  userId: string;
  accessToken: string;
  expiresAt?: string;
  githubUsername?: string;
  agentRuntime?: AgentRuntimeKind;
  agentLanguage?: AgentLanguage;
};

// This machine's resource-profile row. `overrides` stays JSON text here; the profile service
// owns its shape (and tolerates a row written by another version).
export type MachineResourcesRow = { fingerprint: string; decision: ResourceDecision | null; overrides: string };

// «Посіпака» on this machine, as stored: the cap, the pause (absent while it works) and the
// consecutive failures (docs/specs/2026-10-23-minion-auto-run.md, decisions 8-9).
export type MinionSettingsRow = { cap: number; pause?: MinionPause; failures: number };

// A queued cloud status push. One row per task — the outbox is a latest-wins mailbox, not a
// log: if a session goes thinking → tool → thinking while offline, only the newest status is
// worth sending, and the cloud board has no use for the intermediate ones.
export type OutboxRow = { taskId: string; status: SessionStatus; updatedAt: string; attempts: number; lastError?: string };

// A queued write of a session's «Документація» / «Сесія» reports onto its cloud card
// (docs/specs/2026-10-12-docs-tab-survives-restart.md). One row per card, like status_outbox,
// but coalesced rather than latest-wins: a later write may carry no transcript (a dormant
// «Завершити»), and replacing the row with it would lose the reads still waiting to be sent.
// `queuedAt` is the row's version — what a delivery retires and a failure is charged to.
export type ReportOutboxRow = { taskId: string; write: TaskReportsWrite; queuedAt: string; attempts: number; lastError?: string };

// One stored Slack bot (for a Kermanych workspace, for the user who owns the row). Both
// tokens are secrets that never leave this machine; team and bot identity are what
// `auth.test` reported when the bot token was validated.
export type SlackTokenRow = {
  workspaceId: string;
  botToken: string;
  appToken: string;
  teamId: string;
  teamName: string;
  botUserId: string;
};
const SLACK_TOKEN_COLUMNS =
  "workspace_id as workspaceId, bot_token as botToken, app_token as appToken, team_id as teamId, team_name as teamName, bot_user_id as botUserId";

// One member's Slack USER token (`xoxp-`) for a Kermanych workspace: what posts that
// workspace's release notes under the member's own name. A secret that never leaves this
// machine. `clientId` is the Slack app the token was granted by; the identity is what
// `auth.test` reported when the token was obtained.
//
// A ROTATING token (`xoxe.xoxp-`, docs.slack.dev/authentication/using-token-rotation) lives 12
// hours: Slack issues one whenever the app has token rotation on — which cannot be turned off
// once on — and `refreshToken` / `expiresAt` (epoch ms) are what renews it. Both are null for a
// token that never expires, and for a row written before they were kept.
export type SlackUserTokenRow = {
  workspaceId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string;
  teamId: string;
  teamName: string;
  slackUserId: string;
  slackUserName: string;
};
const SLACK_USER_TOKEN_COLUMNS =
  "workspace_id as workspaceId, access_token as accessToken, refresh_token as refreshToken, expires_at as expiresAt, client_id as clientId, team_id as teamId, team_name as teamName, slack_user_id as slackUserId, slack_user_name as slackUserName";

// The `usage` column, back into a shape. Tolerant on purpose: a row written before the
// column existed reads `null`, and a hand-edited or half-written blob must degrade to
// "no figure" rather than crash the board. Absent stays absent — zeros would be a claim.
function readUsage(raw: string | null): Usage | undefined {
  if (!raw) return undefined;
  try {
    const u = JSON.parse(raw) as Partial<Usage>;
    if (typeof u?.cost !== "number") return undefined;
    return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost };
  } catch {
    return undefined;
  }
}

// The `minion_result` column, back into a shape — tolerant like readUsage.
function readMinionColumn(raw: string | null): MinionResult | undefined {
  if (!raw) return undefined;
  try {
    return readMinionResult(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// The `minion_settings.pause` column: a MinionPause, or nothing for a row another version wrote.
function readMinionPause(raw: string | null): MinionPause | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<MinionPause> | null;
    if (!p || !isMinionPauseCode(p.code) || typeof p.at !== "string") return undefined;
    return { code: p.code, at: p.at, ...(typeof p.detail === "string" && p.detail ? { detail: p.detail } : {}) };
  } catch {
    return undefined;
  }
}

// A queued report write, back into a shape. Only this process writes the column, so the
// check is a guard against a hand-edited or half-written blob, not a full validation — the
// cloud's readers validate the merged report again on the way out.
function parseReportWrite(raw: string): TaskReportsWrite | undefined {
  try {
    const w = JSON.parse(raw) as Partial<TaskReportsWrite> | null;
    if (typeof w?.sessionId !== "string" || typeof w.generatedAt !== "string" || typeof w.session !== "object" || !w.session)
      return undefined;
    return w as TaskReportsWrite;
  } catch {
    return undefined;
  }
}

// A `session_findings` row as SQLite hands it back.
type FindingRow = {
  id: string;
  sessionId: string;
  status: string;
  kind: string;
  title: string;
  context: string;
  evidence: string;
  acceptanceCriteria: string;
  suggestedFix: string | null;
  target: string | null;
  createdAt: string;
  updatedAt: string;
};
const FINDING_COLUMNS =
  "id, session_id as sessionId, status, kind, title, context, evidence, acceptance_criteria as acceptanceCriteria, suggested_fix as suggestedFix, target, created_at as createdAt, updated_at as updatedAt";

// The JSON blobs back into shapes, tolerant like readUsage: a hand-edited row degrades to an
// empty list or no target rather than breaking the session's pane.
function readLines(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readTarget(raw: string | null): FindingTarget | undefined {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseFindingTarget(v);
}

function toFinding(r: FindingRow): AgentFinding {
  const target = readTarget(r.target);
  return {
    id: r.id,
    sessionId: r.sessionId,
    status: r.status === "filed" || r.status === "dismissed" ? r.status : "open",
    // An unknown word from an older or hand-edited row reads as the most generic kind.
    kind: isFindingKind(r.kind) ? r.kind : "tech-debt",
    title: r.title,
    context: r.context,
    evidence: readLines(r.evidence),
    acceptanceCriteria: readLines(r.acceptanceCriteria),
    ...(r.suggestedFix ? { suggestedFix: r.suggestedFix } : {}),
    ...(target ? { target } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

@Injectable()
export class RegistryService {
  private db: Database.Database;
  // Fires once per enqueued card report, so the cloud drain wakes without the supervisor
  // knowing it exists (CloudSyncService already depends on the supervisor — the reverse
  // would be circular) and without a new `events$` type, which would reach the UI socket.
  private reportQueued = new Subject<void>();
  reportQueued$ = this.reportQueued.asObservable();

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
    // Additive migration: preview commands, then the cloud workspace id (for the «ШІ-команда»
    // workspace scope), all arrived after the initial schema.
    for (const col of ["preview_command", "api_command", "workspace_id"]) {
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
    // Additive migration: per-project documentation folders arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN doc_folders TEXT NOT NULL DEFAULT '[]'`);
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
    // Additive migration: a per-project default launch model arrived after the initial
    // schema (mirrors cloud projects.default_model).
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN default_model TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: the reasoning half of default_model arrived after the initial
    // schema (mirrors cloud projects.default_effort).
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN default_effort TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: «Обовʼязкова документація» arrived after the initial schema
    // (mirrors cloud projects.docs_required). 0/1, default off like the cloud column.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN docs_required INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    // Additive migration: the documentation policy's per-kind rules (mirrors cloud
    // projects.docs_policy). JSON text; '{}' reads as core's DEFAULT_DOCS_POLICY.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN docs_policy TEXT NOT NULL DEFAULT '{}'`);
    } catch {
      /* column already exists */
    }
    // Data migration (2026-10-05): the `ask` rule — a finish-sheet checkbox — is gone; a kind
    // stored with it is written where it applies (`optional`), like the cloud migration
    // 20261005100000. Policy values are the only strings that can read `"ask"`.
    this.db.exec(`UPDATE projects SET docs_policy = replace(docs_policy, '"ask"', '"optional"') WHERE docs_policy LIKE '%"ask"%'`);
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
    // Additive migration: the session's lifetime token/money total. One JSON blob rather
    // than five columns — it is read whole, written whole, and never aggregated in SQL.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN usage TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: the reasoning effort omp runs the session at. Launch config for a
    // backlog row (`omp --thinking`) and live state for a running one (`set_thinking_level`),
    // which is why it is one column rather than a field of the task draft only.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN effort TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: per-user agent runtime preference (omp vs claude-code) cached
    // alongside the Supabase session so the api knows which backend to spawn without a
    // cloud round trip.
    try {
      this.db.exec(`ALTER TABLE auth_session ADD COLUMN agent_runtime TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: per-user agent communication language, cached alongside the
    // Supabase session so the launch path can inject the language directive without a cloud
    // round trip.
    try {
      this.db.exec(`ALTER TABLE auth_session ADD COLUMN agent_language TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: the runtime an agent session was launched with. Persisted so the
    // board can display it and resume knows which backend to use.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN runtime TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: a durable flag that this session's branch already has an open pull
    // request. Distinct from `status = in_review`, which a follow-up turn clobbers; this
    // remembers that a PR EXISTS so the finish sheet keeps offering «Закоміти» and later turns
    // settle the card back on review rather than `done`.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN pr_opened INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    // Additive migration: a native session (docs/specs/2026-10-05-native-sessions.md) runs its
    // harness as its own TUI in a pty and Kermanych only observes it. Fixed at creation.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN native INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    // Additive migration: a «Глибокий аналіз» session (docs/specs/2026-10-08-deep-analysis-task.md)
    // opened with the deep-analysis prompt. Fixed at creation, like `native`.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN deep_analysis INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    // Additive migration: an agent waiting for a slot (docs/specs/2026-10-21-machine-resource-profile.md,
    // decision 5). `pending_prompt` is the message it will be sent (text only); `slot_queued_at`
    // the enqueue time in ms, so a restart re-enqueues in the original FIFO order.
    for (const col of ["pending_prompt TEXT", "slot_queued_at INTEGER"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // Additive migration: a «Посіпака» run (docs/specs/2026-10-23-minion-auto-run.md). `minion`
    // is fixed at creation, like `native`; `minion_result` is the JSON MinionResult of the run so
    // far, rewritten whenever a turn of it ends differently.
    for (const col of ["minion INTEGER NOT NULL DEFAULT 0", "minion_result TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // The first index in this schema: listSessions(projectId) filters on project_id on
    // every board render and every supervisor lookup.
    this.db.exec(`CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id)`);
    // Durable queue of cloud status pushes. `task_id` is the PRIMARY KEY, so an UPSERT
    // collapses a burst of changes into the newest one. No FK: the tasks live in Postgres.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS status_outbox (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
    );
    // Durable queue of card report writes (ReportOutboxRow). `write` is a JSON
    // TaskReportsWrite; one row per card, coalesced on enqueue.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS report_outbox (task_id TEXT PRIMARY KEY, write TEXT NOT NULL, queued_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
    );
    // Per-user Jira API tokens, THIS machine only — the localRepoPath rule for secrets:
    // the cloud carries the integration's address, never a credential. Keyed by (site,
    // user) so one machine shared across sites or accounts keeps them apart.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS jira_tokens (site_url TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, api_token TEXT NOT NULL, PRIMARY KEY (site_url, user_id))`,
    );
    // Additive migration: the token's own Jira identity, learned from /myself when the
    // token is validated. Kept beside it because «is this worklog mine?» is a question
    // about the STORED token, and asking Jira again on every dialog open would be a
    // round trip for an answer that cannot change while the token does not.
    try {
      this.db.exec(`ALTER TABLE jira_tokens ADD COLUMN account_id TEXT`);
    } catch {
      /* column already exists */
    }
    // Per-user Linear API keys, THIS machine only — the Jira-token precedent. Keyed by
    // (org, user) so one machine shared across orgs or accounts keeps them apart. The
    // account_id column holds the token's own Linear viewer id, learned on validation.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS linear_tokens (org_url_key TEXT NOT NULL, user_id TEXT NOT NULL, api_key TEXT NOT NULL, account_id TEXT, PRIMARY KEY (org_url_key, user_id))`,
    );
    // Per-user Slack bot + app-level tokens, THIS machine only — the Jira/Linear custody
    // rule. Keyed by the KERMANYCH workspace (not the Slack team) because one Slack app is
    // bound to exactly one workspace; the team/bot identity rides along, learned from
    // `auth.test` on validation, so event routing never needs a Slack round trip.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS slack_tokens (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, bot_token TEXT NOT NULL, app_token TEXT NOT NULL, team_id TEXT NOT NULL, team_name TEXT NOT NULL, bot_user_id TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id))`,
    );
    // Per-user Slack USER tokens (release notes posted as the member), THIS machine only —
    // the same custody rule, keyed the same way: one Slack app per Kermanych workspace.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS slack_user_tokens (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, access_token TEXT NOT NULL, client_id TEXT NOT NULL, team_id TEXT NOT NULL, team_name TEXT NOT NULL, slack_user_id TEXT NOT NULL, slack_user_name TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id))`,
    );
    // Additive migration: the rotating token's refresh token and expiry (SlackUserTokenRow).
    for (const col of ["refresh_token TEXT", "expires_at INTEGER"]) {
      try {
        this.db.exec(`ALTER TABLE slack_user_tokens ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // «Знахідки» (docs/specs/2026-10-13-agent-findings.md): problems a session's agent reported
    // outside its task, waiting here — on the machine whose operator will sign whatever they
    // become — until that operator files or dismisses them. Owned by the session: removed with
    // it and with its project. `evidence` / `acceptance_criteria` are JSON string arrays,
    // `target` the JSON FindingTarget of a filed finding.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_findings (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', kind TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL, evidence TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, suggested_fix TEXT, target TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS session_findings_session_idx ON session_findings (session_id)`);
    // The machine resource profile's consent and operator overrides
    // (docs/specs/2026-10-21-machine-resource-profile.md, decision 3). Single-row like
    // auth_session, and never synced: the same user's second machine has its own hardware.
    // `overrides` is a JSON Partial<ResourceLimits> holding only the keys the operator changed.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS machine_resources (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL, decision TEXT, overrides TEXT NOT NULL DEFAULT '{}')`,
    );
    // «Посіпака» on this machine (docs/specs/2026-10-23-minion-auto-run.md, decisions 6 and 8):
    // never synced, like machine_resources — whether a machine may work alone depends on that
    // machine. `minion_settings` is single-row: the cap, the pause (JSON MinionPause, NULL while
    // it works) and the consecutive failures. `minion_projects` lists the projects activated here.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS minion_settings (id INTEGER PRIMARY KEY CHECK (id = 1), cap INTEGER NOT NULL, pause TEXT, failures INTEGER NOT NULL DEFAULT 0)`,
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS minion_projects (project_id TEXT PRIMARY KEY, activated_at TEXT NOT NULL)`);
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
        `SELECT id, name, local_repo_path as localRepoPath, workspace_id as workspaceId, color, preview_command as previewCommand, api_command as apiCommand, carry_files as carryFiles, doc_folders as docFolders, docs_required as docsRequired, docs_policy as docsPolicy, default_branch as defaultBranch, default_model as defaultModel, default_effort as defaultEffort, conventions, created_at as createdAt FROM projects ORDER BY created_at`,
      )
      .all() as (Omit<Project, "carryFiles" | "docFolders" | "docsRequired" | "docsPolicy"> & { carryFiles: string; docFolders: string; docsRequired: number; docsPolicy: string })[];
    // An unbound project stores NULL/"" for its path; hand callers a plain "" so a
    // `!project.localRepoPath` check is all the launch path ever needs.
    return rows.map((r) => ({ ...r, localRepoPath: r.localRepoPath ?? "", workspaceId: r.workspaceId ?? undefined, carryFiles: JSON.parse(r.carryFiles) as string[], docFolders: JSON.parse(r.docFolders) as string[], docsRequired: r.docsRequired === 1, docsPolicy: docsPolicy(JSON.parse(r.docsPolicy)), color: r.color ?? undefined, defaultBranch: r.defaultBranch ?? undefined, defaultModel: r.defaultModel ?? undefined, defaultEffort: r.defaultEffort ?? undefined, conventions: r.conventions ?? undefined }));
  }

  // Local project rows MIRROR cloud projects, so the id always comes from the caller —
  // never randomUUID. A cloud refresh omits localRepoPath, and the CASE below keeps this
  // machine's existing binding instead of wiping it (design D1).
  upsertProject(p: Omit<Project, "createdAt" | "localRepoPath"> & { localRepoPath?: string; createdAt?: string }): Project {
    const row: Project = {
      ...p,
      localRepoPath: p.localRepoPath ?? "",
      carryFiles: p.carryFiles ?? [".env"],
      docFolders: p.docFolders ?? [],
      docsRequired: p.docsRequired ?? false,
      docsPolicy: docsPolicy(p.docsPolicy),
      createdAt: p.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, local_repo_path, workspace_id, color, preview_command, api_command, carry_files, doc_folders, docs_required, docs_policy, default_branch, default_model, default_effort, conventions, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           local_repo_path = CASE WHEN excluded.local_repo_path = '' THEN projects.local_repo_path ELSE excluded.local_repo_path END,
           workspace_id = CASE WHEN excluded.workspace_id IS NULL THEN projects.workspace_id ELSE excluded.workspace_id END,
           color = excluded.color,
           preview_command = excluded.preview_command,
           api_command = excluded.api_command,
           carry_files = excluded.carry_files,
           doc_folders = excluded.doc_folders,
           docs_required = excluded.docs_required,
           docs_policy = excluded.docs_policy,
           default_branch = excluded.default_branch,
           default_model = excluded.default_model,
           default_effort = excluded.default_effort,
           conventions = excluded.conventions`,
      )
      .run(row.id, row.name, row.localRepoPath, row.workspaceId || null, row.color || null, row.previewCommand ?? null, row.apiCommand ?? null, JSON.stringify(row.carryFiles), JSON.stringify(row.docFolders), row.docsRequired ? 1 : 0, JSON.stringify(row.docsPolicy), row.defaultBranch || null, row.defaultModel || null, row.defaultEffort || null, row.conventions || null, row.createdAt);
    // Re-read: the CASE may have kept a binding (and the original created_at) the caller
    // never sent, so the in-memory `row` is not the truth.
    return this.listProjects().find((x) => x.id === row.id)!;
  }

  patchProject(id: string, patch: { name?: string; localRepoPath?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; docFolders?: string[]; docsRequired?: boolean; docsPolicy?: DocsPolicy; defaultBranch?: string; defaultModel?: string; defaultEffort?: ThinkingLevel | ""; conventions?: string }): Project {
    const cur = this.listProjects().find((p) => p.id === id);
    if (!cur) throw new Error("project not found");
    const next = { ...cur, ...patch, color: (patch.color ?? cur.color) || undefined, docsRequired: patch.docsRequired ?? cur.docsRequired, docsPolicy: docsPolicy(patch.docsPolicy ?? cur.docsPolicy), defaultBranch: (patch.defaultBranch ?? cur.defaultBranch) || undefined, defaultModel: (patch.defaultModel ?? cur.defaultModel) || undefined, defaultEffort: (patch.defaultEffort ?? cur.defaultEffort) || undefined, conventions: (patch.conventions ?? cur.conventions) || undefined };
    this.db
      .prepare(`UPDATE projects SET name=?, local_repo_path=?, color=?, preview_command=?, api_command=?, carry_files=?, doc_folders=?, docs_required=?, docs_policy=?, default_branch=?, default_model=?, default_effort=?, conventions=? WHERE id=?`)
      .run(next.name, next.localRepoPath, next.color || null, next.previewCommand ?? null, next.apiCommand ?? null, JSON.stringify(next.carryFiles ?? [".env"]), JSON.stringify(next.docFolders ?? []), next.docsRequired ? 1 : 0, JSON.stringify(next.docsPolicy), next.defaultBranch || null, next.defaultModel || null, next.defaultEffort || null, next.conventions || null, id);
    return next;
  }

  // ── Jira tokens ──────────────────────────────────────────────────────────────

  // `accountId` is absent for a token stored before it was recorded; JiraService
  // backfills it from /myself rather than treating the gap as «not me».
  getJiraToken(
    siteUrl: string,
    userId: string,
  ): { email: string; apiToken: string; accountId?: string } | undefined {
    const row = this.db
      .prepare(`SELECT email, api_token as apiToken, account_id as accountId FROM jira_tokens WHERE site_url = ? AND user_id = ?`)
      .get(siteUrl, userId) as { email: string; apiToken: string; accountId: string | null } | undefined;
    if (!row) return undefined;
    const out: { email: string; apiToken: string; accountId?: string } = {
      email: row.email,
      apiToken: row.apiToken,
    };
    if (row.accountId) out.accountId = row.accountId;
    return out;
  }

  setJiraToken(siteUrl: string, userId: string, email: string, apiToken: string, accountId?: string): void {
    this.db
      .prepare(
        `INSERT INTO jira_tokens (site_url, user_id, email, api_token, account_id) VALUES (?,?,?,?,?)
         ON CONFLICT(site_url, user_id) DO UPDATE SET email = excluded.email, api_token = excluded.api_token, account_id = excluded.account_id`,
      )
      .run(siteUrl, userId, email, apiToken, accountId ?? null);
  }

  // The backfill path: a token stored before account_id existed keeps its row and gains
  // the identity on the first call that needs it.
  setJiraAccountId(siteUrl: string, userId: string, accountId: string): void {
    this.db
      .prepare(`UPDATE jira_tokens SET account_id = ? WHERE site_url = ? AND user_id = ?`)
      .run(accountId, siteUrl, userId);
  }

  deleteJiraToken(siteUrl: string, userId: string): void {
    this.db.prepare(`DELETE FROM jira_tokens WHERE site_url = ? AND user_id = ?`).run(siteUrl, userId);
  }

  // ── Linear tokens ─────────────────────────────────────────────────────────────

  // `accountId` is absent for a token stored before it was recorded; LinearService
  // backfills it from `viewer` rather than treating the gap as «not me».
  getLinearToken(orgUrlKey: string, userId: string): { apiKey: string; accountId?: string } | undefined {
    const row = this.db
      .prepare(`SELECT api_key as apiKey, account_id as accountId FROM linear_tokens WHERE org_url_key = ? AND user_id = ?`)
      .get(orgUrlKey, userId) as { apiKey: string; accountId: string | null } | undefined;
    if (!row) return undefined;
    const out: { apiKey: string; accountId?: string } = { apiKey: row.apiKey };
    if (row.accountId) out.accountId = row.accountId;
    return out;
  }

  setLinearToken(orgUrlKey: string, userId: string, apiKey: string, accountId?: string): void {
    this.db
      .prepare(
        `INSERT INTO linear_tokens (org_url_key, user_id, api_key, account_id) VALUES (?,?,?,?)
         ON CONFLICT(org_url_key, user_id) DO UPDATE SET api_key = excluded.api_key, account_id = excluded.account_id`,
      )
      .run(orgUrlKey, userId, apiKey, accountId ?? null);
  }

  // The backfill path: a token stored before account_id existed keeps its row and gains
  // the identity on the first call that needs it.
  setLinearAccountId(orgUrlKey: string, userId: string, accountId: string): void {
    this.db
      .prepare(`UPDATE linear_tokens SET account_id = ? WHERE org_url_key = ? AND user_id = ?`)
      .run(accountId, orgUrlKey, userId);
  }

  deleteLinearToken(orgUrlKey: string, userId: string): void {
    this.db.prepare(`DELETE FROM linear_tokens WHERE org_url_key = ? AND user_id = ?`).run(orgUrlKey, userId);
  }

  // ── Slack tokens ──────────────────────────────────────────────────────────────

  getSlackToken(workspaceId: string, userId: string): SlackTokenRow | undefined {
    return this.db
      .prepare(`SELECT ${SLACK_TOKEN_COLUMNS} FROM slack_tokens WHERE workspace_id = ? AND user_id = ?`)
      .get(workspaceId, userId) as SlackTokenRow | undefined;
  }

  setSlackToken(userId: string, row: SlackTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO slack_tokens (workspace_id, user_id, bot_token, app_token, team_id, team_name, bot_user_id) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET bot_token = excluded.bot_token, app_token = excluded.app_token,
           team_id = excluded.team_id, team_name = excluded.team_name, bot_user_id = excluded.bot_user_id`,
      )
      .run(row.workspaceId, userId, row.botToken, row.appToken, row.teamId, row.teamName, row.botUserId);
  }

  deleteSlackToken(workspaceId: string, userId: string): void {
    this.db.prepare(`DELETE FROM slack_tokens WHERE workspace_id = ? AND user_id = ?`).run(workspaceId, userId);
  }

  // Every workspace this user hosts the bot for on this machine — SlackService opens one
  // Socket Mode connection per distinct app token among them.
  listSlackTokens(userId: string): SlackTokenRow[] {
    return this.db
      .prepare(`SELECT ${SLACK_TOKEN_COLUMNS} FROM slack_tokens WHERE user_id = ? ORDER BY workspace_id`)
      .all(userId) as SlackTokenRow[];
  }

  getSlackUserToken(workspaceId: string, userId: string): SlackUserTokenRow | undefined {
    return this.db
      .prepare(`SELECT ${SLACK_USER_TOKEN_COLUMNS} FROM slack_user_tokens WHERE workspace_id = ? AND user_id = ?`)
      .get(workspaceId, userId) as SlackUserTokenRow | undefined;
  }

  setSlackUserToken(userId: string, row: SlackUserTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO slack_user_tokens (workspace_id, user_id, access_token, refresh_token, expires_at, client_id, team_id, team_name, slack_user_id, slack_user_name) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, client_id = excluded.client_id,
           team_id = excluded.team_id, team_name = excluded.team_name, slack_user_id = excluded.slack_user_id,
           slack_user_name = excluded.slack_user_name`,
      )
      .run(
        row.workspaceId,
        userId,
        row.accessToken,
        row.refreshToken,
        row.expiresAt,
        row.clientId,
        row.teamId,
        row.teamName,
        row.slackUserId,
        row.slackUserName,
      );
  }

  deleteSlackUserToken(workspaceId: string, userId: string): void {
    this.db.prepare(`DELETE FROM slack_user_tokens WHERE workspace_id = ? AND user_id = ?`).run(workspaceId, userId);
  }

  removeProject(id: string): void {
    this.db.prepare(`DELETE FROM session_findings WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM minion_projects WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  listSessions(projectId?: string): Session[] {
    const sql = `SELECT id, project_id as projectId, task_id as taskId, name, task, worktree_path as worktreePath, branch, worktree, base_branch as baseBranch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, parent_session_id as parentSessionId, kind, model, prefix, platform, runtime, native, deep_analysis, minion, minion_result, effort, status, pr_opened as prOpened, archived, usage, pending_prompt, created_at as createdAt, last_activity_at as lastActivityAt, (SELECT COUNT(*) FROM session_findings f WHERE f.session_id = sessions.id AND f.status = 'open') as open_findings FROM sessions`;
    const rows = (
      projectId
        ? this.db.prepare(sql + ` WHERE project_id = ? ORDER BY created_at`).all(projectId)
        : this.db.prepare(sql + ` ORDER BY created_at`).all()
    ) as (Omit<Session, "archived" | "worktree" | "usage" | "effort" | "runtime" | "prOpened" | "native" | "deepAnalysis" | "minion" | "minionResult" | "openFindings" | "pendingPrompt"> & { archived: number; worktree: number; usage: string | null; effort: string | null; runtime: string | null; prOpened: number; native: number; deep_analysis: number; minion: number; minion_result: string | null; open_findings: number; pending_prompt: string | null })[];
    // SQLite stores the flag as 0/1; hand callers a real boolean. `effort` is validated rather
    // than cast: a row written by an older build (or by hand) must degrade to "not known" —
    // typing an unknown word as a ThinkingLevel would send it straight back into omp's argv.
    // Same for `runtime`: guard with isNativeHarness (the superset — a native `codex` row is
    // valid) so invalid values degrade to undefined.
    // `native` and `deep_analysis` are 0/1 flags too, surfaced only when set so an ordinary row
    // stays as it was; `open_findings` likewise appears only when something waits.
    // `pending_prompt` likewise appears only while a message waits for a slot.
    // `minion` likewise; `minion_result` is validated like `effort`, so a hand-edited row degrades.
    return rows.map(({ native, deep_analysis, minion, minion_result, open_findings, pending_prompt, ...r }) => {
      const minionResult = readMinionColumn(minion_result);
      return { ...r, ...(native ? { native: true } : {}), ...(deep_analysis ? { deepAnalysis: true } : {}), ...(minion ? { minion: true } : {}), ...(minionResult ? { minionResult } : {}), ...(open_findings ? { openFindings: open_findings } : {}), ...(pending_prompt !== null ? { pendingPrompt: pending_prompt } : {}), archived: r.archived !== 0, worktree: r.worktree !== 0, prOpened: r.prOpened !== 0, taskId: r.taskId ?? undefined, model: r.model ?? undefined, prefix: r.prefix ?? undefined, platform: r.platform ?? undefined, runtime: isNativeHarness(r.runtime) ? r.runtime : undefined, effort: isThinkingLevel(r.effort) ? r.effort : undefined, usage: readUsage(r.usage) };
    });
  }

  createSession(
    s: Omit<Session, "id" | "createdAt" | "status" | "worktree" | "baseBranch" | "lastActivityAt" | "kind" | "parentSessionId" | "usage"> & {
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
        `INSERT INTO sessions (id, project_id, task_id, name, task, worktree_path, branch, worktree, base_branch, omp_session_id, omp_session_file, parent_session_id, kind, model, prefix, platform, runtime, native, deep_analysis, minion, effort, status, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        row.runtime ?? null,
        row.native ? 1 : 0,
        row.deepAnalysis ? 1 : 0,
        row.minion ? 1 : 0,
        row.effort ?? null,
        row.status,
        row.createdAt,
        row.lastActivityAt,
      );
    return row;
  }

  // `usage` is deliberately absent from the patch type: `addUsage` is its only writer, so a
  // whole-row UPDATE built from a stale read can never roll a session's spend backwards.
  updateSession(id: string, patch: Partial<Omit<Session, "usage">>): Session {
    const cur = this.listSessions().find((s) => s.id === id);
    if (!cur) throw new Error("session not found");
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE sessions SET project_id=?, task_id=?, name=?, task=?, worktree_path=?, branch=?, worktree=?, base_branch=?, omp_session_id=?, omp_session_file=?, kind=?, model=?, prefix=?, platform=?, runtime=?, effort=?, status=?, pr_opened=?, archived=?, minion_result=? WHERE id=?`,
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
        next.runtime ?? null,
        next.effort ?? null,
        next.status,
        next.prOpened ? 1 : 0,
        next.archived ? 1 : 0,
        next.minionResult ? JSON.stringify(next.minionResult) : null,
        id,
      );
    return next;
  }

  // Bump the session's activity clock. A targeted write (no read-modify-write)
  // because it runs on the high-frequency agent-event path.
  touchSession(id: string): void {
    this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  // The slot queue's durable half (docs/specs/2026-10-21-machine-resource-profile.md, decision 5).
  // Targeted writes, like touchSession: updateSession never touches these columns, so a whole-row
  // update from a stale read cannot drop a waiting message. `undefined` clears both.
  setPendingPrompt(id: string, text: string | undefined, queuedAt?: number): void {
    this.db
      .prepare(`UPDATE sessions SET pending_prompt = ?, slot_queued_at = ? WHERE id = ?`)
      .run(text ?? null, text === undefined ? null : (queuedAt ?? Date.now()), id);
  }

  // When each session holding a pending prompt was queued (ms), for re-enqueueing in order.
  slotQueuedAt(): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT id, slot_queued_at FROM sessions WHERE slot_queued_at IS NOT NULL`)
      .all() as { id: string; slot_queued_at: number }[];
    return new Map(rows.map((r) => [r.id, r.slot_queued_at]));
  }

  // Fold one turn's accounting into the session's lifetime total and hand back the new total.
  // A targeted read-modify-write on the one column (like touchSession, this runs on the
  // agent-event path), and the ONLY writer of `usage` — see updateSession.
  addUsage(id: string, u: Usage): Usage {
    const row = this.db.prepare(`SELECT usage FROM sessions WHERE id = ?`).get(id) as { usage: string | null } | undefined;
    if (!row) throw new Error("session not found");
    const cur = readUsage(row.usage);
    const next: Usage = {
      input: (cur?.input ?? 0) + u.input,
      output: (cur?.output ?? 0) + u.output,
      cacheRead: (cur?.cacheRead ?? 0) + u.cacheRead,
      cacheWrite: (cur?.cacheWrite ?? 0) + u.cacheWrite,
      cost: (cur?.cost ?? 0) + u.cost,
    };
    this.db.prepare(`UPDATE sessions SET usage = ? WHERE id = ?`).run(JSON.stringify(next), id);
    return next;
  }

  // A native session's lifetime total, read whole from the harness's own session file after
  // every turn. Absolute, not a delta: the file is the source of truth, so re-reading it
  // never double counts. The second writer of `usage`, and like addUsage a targeted write.
  setUsage(id: string, u: Usage): Usage {
    const res = this.db.prepare(`UPDATE sessions SET usage = ? WHERE id = ?`).run(JSON.stringify(u), id);
    if (!res.changes) throw new Error("session not found");
    return u;
  }

  removeSession(id: string): void {
    this.db.prepare(`DELETE FROM session_findings WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ── Findings (docs/specs/2026-10-13-agent-findings.md) ───────────────────────────

  addFinding(sessionId: string, report: FindingReport): AgentFinding {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO session_findings (id, session_id, status, kind, title, context, evidence, acceptance_criteria, suggested_fix, target, created_at, updated_at) VALUES (?,?,'open',?,?,?,?,?,?,NULL,?,?)`,
      )
      .run(
        id,
        sessionId,
        report.kind,
        report.title,
        report.context,
        JSON.stringify(report.evidence),
        JSON.stringify(report.acceptanceCriteria),
        report.suggestedFix ?? null,
        now,
        now,
      );
    return { ...report, id, sessionId, status: "open", createdAt: now, updatedAt: now };
  }

  // Creation order — the order the agent reported them in. `rowid` breaks ties within one
  // millisecond, which a burst of parallel tool calls produces.
  listFindings(sessionId: string): AgentFinding[] {
    const rows = this.db
      .prepare(`SELECT ${FINDING_COLUMNS} FROM session_findings WHERE session_id = ? ORDER BY created_at, rowid`)
      .all(sessionId) as FindingRow[];
    return rows.map(toFinding);
  }

  countOpenFindings(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM session_findings WHERE session_id = ? AND status = 'open'`)
      .get(sessionId) as { n: number };
    return row.n;
  }

  // The operator's decision on an open finding. Only `open` moves: a filed finding already
  // points at its card or issue, and a dismissed one stays dismissed (no undo in this change).
  // A filed finding needs its target; a dismissed one carries none.
  resolveFinding(
    sessionId: string,
    id: string,
    next: { status: "filed"; target: FindingTarget } | { status: "dismissed" },
  ): AgentFinding {
    const row = this.db
      .prepare(`SELECT ${FINDING_COLUMNS} FROM session_findings WHERE id = ? AND session_id = ?`)
      .get(id, sessionId) as FindingRow | undefined;
    if (!row) throw new Error("finding not found");
    if (row.status !== "open") throw new Error("finding is not open");
    const now = new Date().toISOString();
    const target = next.status === "filed" ? JSON.stringify(next.target) : null;
    this.db
      .prepare(`UPDATE session_findings SET status = ?, target = ?, updated_at = ? WHERE id = ?`)
      .run(next.status, target, now, id);
    return toFinding({ ...row, status: next.status, target, updatedAt: now });
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

  // Queue a card report write, folded into whatever is still pending for that card
  // (combineReportWrites: the same session's reads and skills accumulate, another session's
  // newer write replaces the row). A fresh `queued_at` and zeroed `attempts`: the merged row
  // is a new delivery, for the same reason enqueueTaskStatus resets its counter. The version
  // must also strictly grow, or two enqueues in one millisecond would share it and a drop of
  // the first would retire the second unsent.
  enqueueTaskReport(taskId: string, write: TaskReportsWrite): void {
    const prev = this.db.prepare(`SELECT write, queued_at as queuedAt FROM report_outbox WHERE task_id = ?`).get(taskId) as
      | { write: string; queuedAt: string }
      | undefined;
    const older = prev ? parseReportWrite(prev.write) : undefined;
    const merged = older ? combineReportWrites(older, write) : write;
    let queuedAt = new Date().toISOString();
    if (prev && queuedAt <= prev.queuedAt) queuedAt = new Date(Date.parse(prev.queuedAt) + 1).toISOString();
    this.db
      .prepare(
        `INSERT INTO report_outbox (task_id, write, queued_at, attempts, last_error) VALUES (?,?,?,0,NULL)
         ON CONFLICT(task_id) DO UPDATE SET write = excluded.write, queued_at = excluded.queued_at, attempts = 0, last_error = NULL`,
      )
      .run(taskId, JSON.stringify(merged), queuedAt);
    this.reportQueued.next();
  }

  // Oldest first, like listOutbox. A row whose JSON no longer parses can never be delivered,
  // and kept it would hold the retry timer at its backoff forever — so it is dropped here.
  listReportOutbox(): ReportOutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT task_id as taskId, write, queued_at as queuedAt, attempts, last_error as lastError FROM report_outbox ORDER BY queued_at`,
      )
      .all() as { taskId: string; write: string; queuedAt: string; attempts: number; lastError: string | null }[];
    const out: ReportOutboxRow[] = [];
    for (const r of rows) {
      const write = parseReportWrite(r.write);
      if (!write) {
        this.dropReportOutbox(r.taskId, r.queuedAt);
        continue;
      }
      out.push({ taskId: r.taskId, write, queuedAt: r.queuedAt, attempts: r.attempts, lastError: r.lastError ?? undefined });
    }
    return out;
  }

  // Retire the version just delivered — scoped like dropOutbox, so a write enqueued (and
  // coalesced onto this card's row) while the delivery was in flight survives for the next pass.
  dropReportOutbox(taskId: string, queuedAt: string): void {
    this.db.prepare(`DELETE FROM report_outbox WHERE task_id = ? AND queued_at = ?`).run(taskId, queuedAt);
  }

  // Charge a failure to the version that failed, as bumpOutboxAttempt does.
  bumpReportOutboxAttempt(taskId: string, queuedAt: string, error: string): void {
    this.db
      .prepare(`UPDATE report_outbox SET attempts = attempts + 1, last_error = ? WHERE task_id = ? AND queued_at = ?`)
      .run(error, taskId, queuedAt);
  }

  getAuthSession(): AuthSessionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id as userId, access_token as accessToken, expires_at as expiresAt, github_username as githubUsername, agent_runtime as agentRuntime, agent_language as agentLanguage FROM auth_session WHERE id = 1`,
      )
      .get() as (AuthSessionRow & { agentRuntime: string | null; agentLanguage: string | null }) | undefined;
    if (!row) return undefined;
    return {
      ...row,
      expiresAt: row.expiresAt ?? undefined,
      githubUsername: row.githubUsername ?? undefined,
      agentRuntime: isAgentRuntime(row.agentRuntime) ? row.agentRuntime : undefined,
      agentLanguage: isAgentLanguage(row.agentLanguage) ? row.agentLanguage : undefined,
    };
  }

  setAuthSession(row: AuthSessionRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO auth_session (id, user_id, access_token, expires_at, github_username, agent_runtime, agent_language) VALUES (1,?,?,?,?,?,?)`,
      )
      .run(row.userId, row.accessToken, row.expiresAt ?? null, row.githubUsername ?? null, row.agentRuntime ?? null, row.agentLanguage ?? null);
  }

  clearAuthSession(): void {
    this.db.prepare(`DELETE FROM auth_session WHERE id = 1`).run();
  }

  getMachineResources(): MachineResourcesRow | undefined {
    const row = this.db.prepare(`SELECT fingerprint, decision, overrides FROM machine_resources WHERE id = 1`).get() as
      | { fingerprint: string; decision: string | null; overrides: string }
      | undefined;
    if (!row) return undefined;
    return {
      fingerprint: row.fingerprint,
      decision: row.decision === "applied" || row.decision === "declined" ? row.decision : null,
      overrides: row.overrides,
    };
  }

  setMachineResources(row: MachineResourcesRow): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO machine_resources (id, fingerprint, decision, overrides) VALUES (1,?,?,?)`)
      .run(row.fingerprint, row.decision, row.overrides);
  }

  // No row yet reads as the defaults: cap 1, working, no failures.
  getMinionSettings(): MinionSettingsRow {
    const row = this.db.prepare(`SELECT cap, pause, failures FROM minion_settings WHERE id = 1`).get() as
      | { cap: number; pause: string | null; failures: number }
      | undefined;
    const pause = readMinionPause(row?.pause ?? null);
    return { cap: clampMinionCap(row?.cap) ?? MINION_CAP_DEFAULT, ...(pause ? { pause } : {}), failures: row?.failures ?? 0 };
  }

  setMinionSettings(row: MinionSettingsRow): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO minion_settings (id, cap, pause, failures) VALUES (1,?,?,?)`)
      .run(row.cap, row.pause ? JSON.stringify(row.pause) : null, row.failures);
  }

  // The projects «Посіпака» is activated for on this machine, in activation order.
  listMinionProjects(): string[] {
    const rows = this.db.prepare(`SELECT project_id FROM minion_projects ORDER BY activated_at, project_id`).all() as { project_id: string }[];
    return rows.map((r) => r.project_id);
  }

  setMinionProject(projectId: string, active: boolean): void {
    if (active) this.db.prepare(`INSERT OR IGNORE INTO minion_projects (project_id, activated_at) VALUES (?,?)`).run(projectId, new Date().toISOString());
    else this.db.prepare(`DELETE FROM minion_projects WHERE project_id = ?`).run(projectId);
  }
}
