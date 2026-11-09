// apps/api/src/registry/registry.service.ts
import { Injectable, Optional } from "@nestjs/common";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { Subject } from "rxjs";
import { isThinkingLevel, isNativeHarness, isAgentLanguage, isSkillImprovementLevel, DEFAULT_SKILL_IMPROVEMENT_LEVEL, isFindingKind, isPlatform, parseFindingTarget, docsPolicy, combineReportWrites, readMinionResult, isMinionPauseCode, clampMinionCap, MINION_CAP_DEFAULT, isDevicePlatform, ACTIVE_STATUSES, validateScheduleSpec, SCHEDULE_RUNS_KEEP, SCHEDULE_SLIPS_KEEP, ACTIVITY_SPAN_KINDS, analyticsSessionClass } from "@kermanych/core";
import type { AgentFinding, DeviceChoice, DocsPolicy, FindingReport, FindingTarget, MinionPause, MinionResult, NativeSettings, Platform, Project, ResourceDecision, Session, SessionDevice, SessionStatus, ThinkingLevel, Usage, AgentLanguage, SkillImprovementLevel, TaskReportsWrite, TesterSettings, ScheduledTask, ScheduleRun, ScheduleRunReason, ScheduleRunStatus, ScheduleRunTrigger, ScheduleSlip, ActivitySpanKind, ActivitySpanRow, AnalyticsFindingRow, AnalyticsImportState, AnalyticsInput, AnalyticsSessionClass, AnalyticsSessionRow, UsageHourRow } from "@kermanych/core";

// «Аналітика» (docs/specs/2026-11-07-developer-analytics.md): one UTC hour of one session's spend
// on one model, as a writer hands it over — the registry stamps the session's project and class.
export type UsageHourEntry = Pick<UsageHourRow, "hour" | "model" | "calls" | "modelMs" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;
// Who wrote a ledger row: live recording, or the one-time history import (decision 6).
export type LedgerSource = "live" | "import";
export type AnalyticsMeta = {
  ledgerStartedAt: string;
  import: AnalyticsImportState;
  // What the finished import read, for the measurement decision 6 asks for.
  importStats?: { ms: number; files: number; bytes: number };
};
type AnalyticsMetaDbRow = {
  ledger_started_at: string;
  import_state: string;
  import_done: number;
  import_total: number;
  import_ms: number | null;
  import_files: number | null;
  import_bytes: number | null;
};
type UsageHourDbRow = {
  hour: string;
  session_id: string;
  model: string;
  project_id: string;
  session_class: string;
  cost_known: number;
  calls: number;
  model_ms: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
};
type LedgerOwnerDbRow = { project_id: string; kind: string; tester: number; minion: number; design_dir: string | null; synergy: number; schedule_id: string | null };

// The flags of a `sessions` row → core's «тип сесії».
function ledgerClass(r: LedgerOwnerDbRow): AnalyticsSessionClass {
  return analyticsSessionClass({
    kind: r.kind as Session["kind"],
    ...(r.tester ? { tester: true } : {}),
    ...(r.minion ? { minion: true } : {}),
    ...(r.design_dir ? { designDir: r.design_dir } : {}),
    ...(r.synergy ? { synergy: {} } : {}),
    ...(r.schedule_id ? { schedule: { id: r.schedule_id, name: "" } } : {}),
  });
}

// The cached Supabase session. Lives in SQLite so a restarted api still knows who
// its user is without a cloud round trip.
export type AuthSessionRow = {
  userId: string;
  accessToken: string;
  expiresAt?: string;
  githubUsername?: string;
  agentLanguage?: AgentLanguage;
  // The operator's skill improvement level (profiles.skill_improvement_level), cached so the
  // improve_skill gate and the reflection step need no cloud read. Unknown (never hydrated) =
  // undefined, which counts as DEFAULT_SKILL_IMPROVEMENT_LEVEL.
  skillImprovementLevel?: SkillImprovementLevel;
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

// A stored scheduled task: everything of ScheduledTask but what the service computes on each
// read (`nextAt`, `running`).
export type ScheduleRow = Omit<ScheduledTask, "nextAt" | "running">;

type ScheduleDbRow = {
  id: string;
  name: string;
  kind: string;
  prompt: string;
  project_id: string | null;
  skills: string;
  model: string | null;
  spec: string;
  time_zone: string;
  enabled: number;
  armed_at: string;
  created_at: string;
  updated_at: string;
};

function readScheduleRow(r: ScheduleDbRow): ScheduleRow | undefined {
  if (r.kind !== "reminder" && r.kind !== "agent") return undefined;
  let spec: unknown;
  let skills: unknown;
  try {
    spec = JSON.parse(r.spec);
    skills = JSON.parse(r.skills);
  } catch {
    return undefined;
  }
  const schedule = validateScheduleSpec(spec);
  if ("error" in schedule) return undefined;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    prompt: r.prompt,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    skills: Array.isArray(skills) ? skills.filter((s): s is string => typeof s === "string") : [],
    ...(r.model ? { model: r.model } : {}),
    schedule,
    timeZone: r.time_zone,
    enabled: r.enabled !== 0,
    armedAt: r.armed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const RUN_COLUMNS = "id, schedule_id, scheduled_for, run_trigger, status, reason, detail, started_at, ended_at, session_id, summary";
type RunDbRow = {
  id: string;
  schedule_id: string;
  scheduled_for: string | null;
  run_trigger: string;
  status: string;
  reason: string | null;
  detail: string | null;
  started_at: string;
  ended_at: string | null;
  session_id: string | null;
  summary: string | null;
};

function readRunRow(r: RunDbRow): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    ...(r.scheduled_for ? { scheduledFor: r.scheduled_for } : {}),
    trigger: r.run_trigger as ScheduleRunTrigger,
    status: r.status as ScheduleRunStatus,
    ...(r.reason ? { reason: r.reason as ScheduleRunReason } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    startedAt: r.started_at,
    ...(r.ended_at ? { endedAt: r.ended_at } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.summary !== null ? { summary: r.summary } : {}),
  };
}

const SLIP_COLUMNS = "id, kind, schedule_id, schedule_name, at, scheduled_for, text, body, run_id, session_id, project_id, status, reason, late, seen, snoozed_until";
type SlipDbRow = {
  id: string;
  kind: string;
  schedule_id: string;
  schedule_name: string;
  at: string;
  scheduled_for: string | null;
  text: string;
  body: string | null;
  run_id: string | null;
  session_id: string | null;
  project_id: string | null;
  status: string | null;
  reason: string | null;
  late: number;
  seen: number;
  snoozed_until: string | null;
};

function readSlipRow(r: SlipDbRow): ScheduleSlip {
  return {
    id: r.id,
    kind: r.kind === "run" ? "run" : "reminder",
    scheduleId: r.schedule_id,
    scheduleName: r.schedule_name,
    at: r.at,
    ...(r.scheduled_for ? { scheduledFor: r.scheduled_for } : {}),
    text: r.text,
    ...(r.body !== null ? { body: r.body } : {}),
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.project_id ? { projectId: r.project_id } : {}),
    ...(r.status ? { status: r.status as ScheduleRunStatus } : {}),
    ...(r.reason ? { reason: r.reason as ScheduleRunReason } : {}),
    late: r.late !== 0,
    seen: r.seen !== 0,
    ...(r.snoozed_until ? { snoozedUntil: r.snoozed_until } : {}),
  };
}

// The `projects.device_choice` column: only the keys of a DeviceChoice with the right types, so a
// row another version wrote reads as the defaults rather than as a bad choice.
function readDeviceChoice(raw: string | null): DeviceChoice {
  if (!raw) return {};
  try {
    const c = JSON.parse(raw) as Record<string, unknown> | null;
    if (!c || typeof c !== "object") return {};
    return {
      ...(isDevicePlatform(c.platform) ? { platform: c.platform } : {}),
      ...(typeof c.ios === "string" && c.ios ? { ios: c.ios } : {}),
      ...(typeof c.android === "string" && c.android ? { android: c.android } : {}),
    };
  } catch {
    return {};
  }
}

// The `sessions.device` column: a SessionDevice, or null for none or a malformed blob.
function readSessionDevice(raw: string | null): SessionDevice | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown> | null;
    if (!d || !isDevicePlatform(d.platform) || typeof d.base !== "string" || typeof d.id !== "string" || !d.id) return null;
    return { platform: d.platform, base: d.base, baseName: typeof d.baseName === "string" ? d.baseName : d.base, id: d.id };
  } catch {
    return null;
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
    // Additive migration: the cloud workspace id (for the «ШІ-команда» workspace scope), then the
    // project platform (docs/specs/2026-11-03-session-browser-preview.md, decision 9; NULL = «Не
    // визначено»), arrived after the initial schema. An older DB also carries `preview_command` /
    // `api_command`: unused since the preview config moved into the repository (decision 10), and
    // left in place — the registry has no DROP precedent.
    for (const col of ["workspace_id", "platform"]) {
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
    // so "Start" can spawn them later with the same settings the operator chose. An older DB
    // also has `sessions.platform`, unused since the platform moved to the project.
    for (const col of ["model", "prefix"]) {
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
    // Additive migration, now unused: the per-user runtime preference once cached here. The
    // column stays so an older api can still open this database.
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
    // Additive migration: the cached skill improvement level
    // (docs/specs/2026-11-06-skill-improvement-reflection.md); NULL = not yet known. It replaced
    // the on/off `skill_improvement` column: a cached «off» carries over, then the old column goes.
    try {
      this.db.exec(`ALTER TABLE auth_session ADD COLUMN skill_improvement_level TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`UPDATE auth_session SET skill_improvement_level = 'off' WHERE skill_improvement = 0 AND skill_improvement_level IS NULL`);
      this.db.exec(`ALTER TABLE auth_session DROP COLUMN skill_improvement`);
    } catch {
      /* the old column is already gone, or never existed */
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
    // Additive migration: the pull request's URL, stored with `pr_opened`, so the merged-PR check
    // (docs/specs/2026-10-26-pr-merged-close-prompt.md) asks GitHub about exactly that PR.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN pr_url TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: when `pr_opened` was first set, for «Аналітика»'s «PR відкрито»
    // (docs/specs/2026-11-07-developer-analytics.md, decision 5). NULL on older rows until the
    // history import dates them from the harness file (decision 6).
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN pr_opened_at TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: the card's estimate as the launch read it, for «Оцінка vs факт»
    // (docs/specs/2026-11-09-task-estimate.md, decision 3). Fixed at creation; NULL = not estimated.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN estimate_minutes INTEGER`);
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
    // Additive migration: a «Дизайн» session (docs/specs/2026-10-29-design-tab.md) carries the
    // folder it writes its design into. Stamped once at creation, like `deep_analysis`.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN design_dir TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: a «Синергія» session (docs/specs/2026-11-06-synergy.md) carries its
    // marker and the start path of «Змінити сторінку». Unlike `design_dir` the marker is cleared
    // again by «Імплементувати» (updateSession writes both columns).
    for (const col of ["synergy INTEGER NOT NULL DEFAULT 0", "synergy_page TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
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
    // is set at creation, or later by `/minion` (docs/specs/2026-11-09-minion-takeover.md), and
    // never cleared; `minion_result` is the JSON MinionResult of the run so
    // far, rewritten whenever a turn of it ends differently; `finding_kind` is the card's finding
    // kind for a run of a finding card (decision 14), fixed at creation too.
    for (const col of ["minion INTEGER NOT NULL DEFAULT 0", "minion_result TEXT", "finding_kind TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // Additive migration: the mobile device preview (docs/specs/2026-11-03-mobile-device-preview.md,
    // decisions 4 and 6). `projects.device_choice` is this machine's JSON DeviceChoice (base device
    // and platform), `sessions.device` the JSON SessionDevice of the session's clone. Both are local
    // only: device ids mean nothing on another machine, so no cloud path reads or writes them, and
    // upsertProject's ON CONFLICT list leaves `device_choice` alone.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN device_choice TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN device TEXT`);
    } catch {
      /* column already exists */
    }
    // Additive migration: a «Тестувальник» run (docs/specs/2026-11-04-qa-tester-agent.md,
    // decision 1), a `review` child fixed as such at creation, like `minion`.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN tester INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    // Additive migration: a scheduled run's session (docs/specs/2026-11-06-scheduled-tasks.md,
    // decision 5) carries its task's id and name for the «Розклад · <назва>» badge, fixed at
    // creation like `minion`. The name is a copy: the session outlives a renamed or deleted task.
    for (const col of ["schedule_id TEXT", "schedule_name TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    this.retireManagedClaude();
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
    // Per-user Plane API keys, THIS machine only — the Jira/Linear custody rule. Keyed by
    // (site, Plane workspace, user): some Plane editions scope a key to one workspace, so a
    // machine whose member works in two Plane workspaces on one site keeps both apart. The
    // key's own Plane identity (/users/me/) rides along, learned on validation.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS plane_tokens (site_url TEXT NOT NULL, workspace_slug TEXT NOT NULL, user_id TEXT NOT NULL, api_token TEXT NOT NULL, plane_user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', PRIMARY KEY (site_url, workspace_slug, user_id))`,
    );
    // Per-user OpenAI API keys for the voice conversation (docs/specs/2026-11-02-voice-conversation.md),
    // THIS machine only — the Jira/Linear custody rule.
    this.db.exec(`CREATE TABLE IF NOT EXISTS voice_keys (user_id TEXT PRIMARY KEY, api_key TEXT NOT NULL)`);
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
    // Native sessions' launch preferences (core NativeSettings), single-row and machine-local
    // like the two above: how a TUI is drawn is this machine's operator's choice.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS native_settings (id INTEGER PRIMARY KEY CHECK (id = 1), claude_full_screen INTEGER NOT NULL DEFAULT 0)`,
    );
    // «Тестувальник» settings (docs/specs/2026-11-04-qa-tester-agent.md, decision 4): per project,
    // THIS machine only and never synced — the Jira/Linear custody rule, passwords in plaintext.
    this.db.exec(`CREATE TABLE IF NOT EXISTS tester_settings (project_id TEXT PRIMARY KEY, login_path TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tester_accounts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, login TEXT NOT NULL, password TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL)`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS tester_accounts_project_idx ON tester_accounts (project_id)`);
    // Scheduled tasks (docs/specs/2026-11-06-scheduled-tasks.md, decision 1): personal and
    // machine-local, never synced. `spec` is the JSON ScheduleSpec, `skills` a JSON name list.
    // A run is claimed by its insert: UNIQUE (schedule_id, scheduled_for) is what makes an
    // occurrence fire exactly once across ticks and restarts; a manual run has no
    // `scheduled_for`, and SQLite lets NULLs repeat under a UNIQUE key. `run_trigger`, not
    // `trigger`, which is an SQL keyword.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, project_id TEXT, skills TEXT NOT NULL DEFAULT '[]', model TEXT, spec TEXT NOT NULL, time_zone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, armed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, scheduled_for TEXT, run_trigger TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, detail TEXT, started_at TEXT NOT NULL, ended_at TEXT, session_id TEXT, summary TEXT, UNIQUE (schedule_id, scheduled_for))`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schedule_slips (id TEXT PRIMARY KEY, kind TEXT NOT NULL, schedule_id TEXT NOT NULL, schedule_name TEXT NOT NULL, at TEXT NOT NULL, scheduled_for TEXT, text TEXT NOT NULL, body TEXT, run_id TEXT, session_id TEXT, project_id TEXT, status TEXT, reason TEXT, late INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0, snoozed_until TEXT)`,
    );
    // «Аналітика»'s local ledger (docs/specs/2026-11-07-developer-analytics.md, decision 5):
    // personal, machine-local, never synced. No FK to `sessions` on purpose — the money was spent,
    // so the rows outlive a deleted session (removeSession leaves them); removeProject takes them.
    // `usage_hours` is spend per UTC hour; the session's project and class are copied in at write
    // time for the same reason. `source` keeps the live rows apart from the history import's: the
    // import replaces its own rows per session (a crash mid-import then re-runs without double
    // counting), a native session's live rows are rebuilt from its file after every turn, and the
    // two never overlap in time (live ≥ ledger_started_at > import).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_hours (hour TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live', project_id TEXT NOT NULL, session_class TEXT NOT NULL, cost_known INTEGER NOT NULL, calls INTEGER NOT NULL DEFAULT 0, model_ms INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (hour, session_id, model, source))`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS usage_hours_hour_idx ON usage_hours (hour)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS usage_hours_session_idx ON usage_hours (session_id)`);
    // A span opens when a session's coarse status enters its kind and closes when it leaves;
    // `ended_at` NULL = still open (closed at start after a crash, see closeDanglingSpans).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS activity_spans (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, source TEXT NOT NULL DEFAULT 'live')`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS activity_spans_started_idx ON activity_spans (started_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS activity_spans_session_idx ON activity_spans (session_id)`);
    // Single-row like machine_resources. `ledger_started_at` is written once, by the first start
    // with this schema — before any live write can happen — and never moved: it is the line
    // between what the history import may count and what live recording already does.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS analytics_meta (id INTEGER PRIMARY KEY CHECK (id = 1), ledger_started_at TEXT NOT NULL, import_state TEXT NOT NULL DEFAULT 'pending', import_done INTEGER NOT NULL DEFAULT 0, import_total INTEGER NOT NULL DEFAULT 0, import_ms INTEGER, import_files INTEGER, import_bytes INTEGER)`,
    );
    this.db.prepare(`INSERT OR IGNORE INTO analytics_meta (id, ledger_started_at) VALUES (1, ?)`).run(new Date().toISOString());
  }

  // Managed claude-code sessions are gone (docs/specs/2026-11-05-remove-managed-claude-code.md,
  // decision 9). A managed row stamped `claude-code` loses its slot-queue entry and stops if it
  // was running; a plain agent or chat row becomes a native claude session (its claude session
  // id resumes in the TUI); any other such row (design, «Посіпака», «Тестувальник», review, …)
  // is archived. Runs on every start; a second run changes nothing.
  private retireManagedClaude(): void {
    const active = ACTIVE_STATUSES.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sessions SET pending_prompt = NULL, slot_queued_at = NULL, status = CASE WHEN status IN (${active}) THEN 'stopped' ELSE status END
           WHERE runtime = 'claude-code' AND native = 0`,
        )
        .run(...ACTIVE_STATUSES);
      this.db
        .prepare(
          `UPDATE sessions SET native = 1
           WHERE runtime = 'claude-code' AND native = 0 AND kind IN ('agent','chat') AND design_dir IS NULL AND minion = 0 AND tester = 0`,
        )
        .run();
      this.db.prepare(`UPDATE sessions SET archived = 1 WHERE runtime = 'claude-code' AND native = 0`).run();
    })();
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
        `SELECT id, name, local_repo_path as localRepoPath, workspace_id as workspaceId, color, platform, carry_files as carryFiles, doc_folders as docFolders, docs_required as docsRequired, docs_policy as docsPolicy, default_branch as defaultBranch, default_model as defaultModel, default_effort as defaultEffort, conventions, created_at as createdAt FROM projects ORDER BY created_at`,
      )
      .all() as (Omit<Project, "carryFiles" | "docFolders" | "docsRequired" | "docsPolicy" | "platform"> & { carryFiles: string; docFolders: string; docsRequired: number; docsPolicy: string; platform: string | null })[];
    // An unbound project stores NULL/"" for its path; hand callers a plain "" so a
    // `!project.localRepoPath` check is all the launch path ever needs. An unknown platform (a
    // newer build's value) reads as «Не визначено», like NULL.
    return rows.map(({ platform, ...r }) => ({ ...r, ...(isPlatform(platform) ? { platform } : {}), localRepoPath: r.localRepoPath ?? "", workspaceId: r.workspaceId ?? undefined, carryFiles: JSON.parse(r.carryFiles) as string[], docFolders: JSON.parse(r.docFolders) as string[], docsRequired: r.docsRequired === 1, docsPolicy: docsPolicy(JSON.parse(r.docsPolicy)), color: r.color ?? undefined, defaultBranch: r.defaultBranch ?? undefined, defaultModel: r.defaultModel ?? undefined, defaultEffort: r.defaultEffort ?? undefined, conventions: r.conventions ?? undefined }));
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
        `INSERT INTO projects (id, name, local_repo_path, workspace_id, color, platform, carry_files, doc_folders, docs_required, docs_policy, default_branch, default_model, default_effort, conventions, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           local_repo_path = CASE WHEN excluded.local_repo_path = '' THEN projects.local_repo_path ELSE excluded.local_repo_path END,
           workspace_id = CASE WHEN excluded.workspace_id IS NULL THEN projects.workspace_id ELSE excluded.workspace_id END,
           color = excluded.color,
           platform = excluded.platform,
           carry_files = excluded.carry_files,
           doc_folders = excluded.doc_folders,
           docs_required = excluded.docs_required,
           docs_policy = excluded.docs_policy,
           default_branch = excluded.default_branch,
           default_model = excluded.default_model,
           default_effort = excluded.default_effort,
           conventions = excluded.conventions`,
      )
      .run(row.id, row.name, row.localRepoPath, row.workspaceId || null, row.color || null, row.platform ?? null, JSON.stringify(row.carryFiles), JSON.stringify(row.docFolders), row.docsRequired ? 1 : 0, JSON.stringify(row.docsPolicy), row.defaultBranch || null, row.defaultModel || null, row.defaultEffort || null, row.conventions || null, row.createdAt);
    // Re-read: the CASE may have kept a binding (and the original created_at) the caller
    // never sent, so the in-memory `row` is not the truth.
    return this.listProjects().find((x) => x.id === row.id)!;
  }

  // `platform: null` clears it (the cloud row has none); absent keeps it.
  patchProject(id: string, patch: { name?: string; localRepoPath?: string; color?: string; platform?: Platform | null; carryFiles?: string[]; docFolders?: string[]; docsRequired?: boolean; docsPolicy?: DocsPolicy; defaultBranch?: string; defaultModel?: string; defaultEffort?: ThinkingLevel | ""; conventions?: string }): Project {
    const cur = this.listProjects().find((p) => p.id === id);
    if (!cur) throw new Error("project not found");
    const next: Project = { ...cur, ...patch, platform: patch.platform === undefined ? cur.platform : (patch.platform ?? undefined), color: (patch.color ?? cur.color) || undefined, docsRequired: patch.docsRequired ?? cur.docsRequired, docsPolicy: docsPolicy(patch.docsPolicy ?? cur.docsPolicy), defaultBranch: (patch.defaultBranch ?? cur.defaultBranch) || undefined, defaultModel: (patch.defaultModel ?? cur.defaultModel) || undefined, defaultEffort: (patch.defaultEffort ?? cur.defaultEffort) || undefined, conventions: (patch.conventions ?? cur.conventions) || undefined };
    this.db
      .prepare(`UPDATE projects SET name=?, local_repo_path=?, color=?, platform=?, carry_files=?, doc_folders=?, docs_required=?, docs_policy=?, default_branch=?, default_model=?, default_effort=?, conventions=? WHERE id=?`)
      .run(next.name, next.localRepoPath, next.color || null, next.platform ?? null, JSON.stringify(next.carryFiles ?? [".env"]), JSON.stringify(next.docFolders ?? []), next.docsRequired ? 1 : 0, JSON.stringify(next.docsPolicy), next.defaultBranch || null, next.defaultModel || null, next.defaultEffort || null, next.conventions || null, id);
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

  // ── Plane tokens ──────────────────────────────────────────────────────────────

  // The identity is recorded at validation (PlaneService checks /users/me/ before storing),
  // so unlike Jira/Linear there is no pre-identity row to backfill.
  getPlaneToken(
    siteUrl: string,
    workspaceSlug: string,
    userId: string,
  ): { apiToken: string; planeUserId: string; displayName: string } | undefined {
    return this.db
      .prepare(
        `SELECT api_token as apiToken, plane_user_id as planeUserId, display_name as displayName FROM plane_tokens WHERE site_url = ? AND workspace_slug = ? AND user_id = ?`,
      )
      .get(siteUrl, workspaceSlug, userId) as { apiToken: string; planeUserId: string; displayName: string } | undefined;
  }

  setPlaneToken(
    siteUrl: string,
    workspaceSlug: string,
    userId: string,
    apiToken: string,
    planeUserId: string,
    displayName: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO plane_tokens (site_url, workspace_slug, user_id, api_token, plane_user_id, display_name) VALUES (?,?,?,?,?,?)
         ON CONFLICT(site_url, workspace_slug, user_id) DO UPDATE SET api_token = excluded.api_token, plane_user_id = excluded.plane_user_id, display_name = excluded.display_name`,
      )
      .run(siteUrl, workspaceSlug, userId, apiToken, planeUserId, displayName);
  }

  deletePlaneToken(siteUrl: string, workspaceSlug: string, userId: string): void {
    this.db
      .prepare(`DELETE FROM plane_tokens WHERE site_url = ? AND workspace_slug = ? AND user_id = ?`)
      .run(siteUrl, workspaceSlug, userId);
  }

  // ── Voice (OpenAI) keys ──────────────────────────────────────────────────────

  getVoiceKey(userId: string): string | undefined {
    const row = this.db.prepare(`SELECT api_key as apiKey FROM voice_keys WHERE user_id = ?`).get(userId) as { apiKey: string } | undefined;
    return row?.apiKey;
  }

  setVoiceKey(userId: string, apiKey: string): void {
    this.db
      .prepare(`INSERT INTO voice_keys (user_id, api_key) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET api_key = excluded.api_key`)
      .run(userId, apiKey);
  }

  deleteVoiceKey(userId: string): void {
    this.db.prepare(`DELETE FROM voice_keys WHERE user_id = ?`).run(userId);
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
    // The «Аналітика» ledger goes with a removed project (decision 5), unlike a deleted session.
    this.db.prepare(`DELETE FROM usage_hours WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM activity_spans WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM minion_projects WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM tester_settings WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM tester_accounts WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  listSessions(projectId?: string): Session[] {
    const sql = `SELECT id, project_id as projectId, task_id as taskId, name, task, worktree_path as worktreePath, branch, worktree, base_branch as baseBranch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, parent_session_id as parentSessionId, kind, model, prefix, runtime, native, deep_analysis, design_dir, synergy, synergy_page, minion, minion_result, finding_kind, tester, schedule_id, schedule_name, effort, status, pr_opened as prOpened, pr_url, pr_opened_at, archived, usage, pending_prompt, created_at as createdAt, last_activity_at as lastActivityAt, (SELECT COUNT(*) FROM session_findings f WHERE f.session_id = sessions.id AND f.status = 'open') as open_findings FROM sessions`;
    const rows = (
      projectId
        ? this.db.prepare(sql + ` WHERE project_id = ? ORDER BY created_at`).all(projectId)
        : this.db.prepare(sql + ` ORDER BY created_at`).all()
    ) as (Omit<Session, "archived" | "worktree" | "usage" | "effort" | "runtime" | "prOpened" | "prUrl" | "prOpenedAt" | "native" | "deepAnalysis" | "designDir" | "synergy" | "minion" | "minionResult" | "findingKind" | "tester" | "schedule" | "openFindings" | "pendingPrompt"> & { archived: number; worktree: number; usage: string | null; effort: string | null; runtime: string | null; prOpened: number; pr_url: string | null; pr_opened_at: string | null; native: number; deep_analysis: number; design_dir: string | null; synergy: number; synergy_page: string | null; minion: number; minion_result: string | null; finding_kind: string | null; tester: number; schedule_id: string | null; schedule_name: string | null; open_findings: number; pending_prompt: string | null })[];
    // SQLite stores the flag as 0/1; hand callers a real boolean. `effort` is validated rather
    // than cast: a row written by an older build (or by hand) must degrade to "not known" —
    // typing an unknown word as a ThinkingLevel would send it straight back into omp's argv.
    // Same for `runtime`: guard with isNativeHarness (the superset — a native `codex` row is
    // valid) so invalid values degrade to undefined.
    // `native` and `deep_analysis` are 0/1 flags too, surfaced only when set so an ordinary row
    // stays as it was; `open_findings` likewise appears only when something waits.
    // `pending_prompt` likewise appears only while a message waits for a slot; `pr_url` only once
    // a PR URL was stored.
    // `minion` likewise; `minion_result` and `finding_kind` are validated like `effort`, so a
    // hand-edited row degrades.
    // `design_dir` likewise appears only on a design session, `tester` only on a tester run,
    // `synergy` (with its start path, when there is one) only on a «Синергія» session, and
    // `schedule` only on a scheduled run's session (docs/specs/2026-11-06-scheduled-tasks.md).
    return rows.map(({ native, deep_analysis, design_dir, synergy, synergy_page, minion, minion_result, finding_kind, tester, schedule_id, schedule_name, open_findings, pending_prompt, pr_url, pr_opened_at, ...r }) => {
      const minionResult = readMinionColumn(minion_result);
      return { ...r, ...(native ? { native: true } : {}), ...(deep_analysis ? { deepAnalysis: true } : {}), ...(design_dir ? { designDir: design_dir } : {}), ...(synergy ? { synergy: synergy_page ? { page: synergy_page } : {} } : {}), ...(minion ? { minion: true } : {}), ...(minionResult ? { minionResult } : {}), ...(isFindingKind(finding_kind) ? { findingKind: finding_kind } : {}), ...(tester ? { tester: true } : {}), ...(schedule_id ? { schedule: { id: schedule_id, name: schedule_name ?? "" } } : {}), ...(open_findings ? { openFindings: open_findings } : {}), ...(pending_prompt !== null ? { pendingPrompt: pending_prompt } : {}), ...(pr_url ? { prUrl: pr_url } : {}), ...(pr_opened_at ? { prOpenedAt: pr_opened_at } : {}), archived: r.archived !== 0, worktree: r.worktree !== 0, prOpened: r.prOpened !== 0, taskId: r.taskId ?? undefined, model: r.model ?? undefined, prefix: r.prefix ?? undefined, runtime: isNativeHarness(r.runtime) ? r.runtime : undefined, effort: isThinkingLevel(r.effort) ? r.effort : undefined, usage: readUsage(r.usage) };
    });
  }

  createSession(
    s: Omit<Session, "id" | "createdAt" | "status" | "worktree" | "baseBranch" | "lastActivityAt" | "kind" | "parentSessionId" | "usage"> & {
      status?: SessionStatus; worktree?: boolean; baseBranch?: string;
      kind?: Session["kind"]; parentSessionId?: string;
      // Written to the row for «Аналітика» only; not part of Session (nothing else reads it).
      estimateMinutes?: number;
    },
  ): Session {
    const { estimateMinutes, ...fields } = s;
    const createdAt = new Date().toISOString();
    const row: Session = {
      ...fields,
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
        `INSERT INTO sessions (id, project_id, task_id, name, task, worktree_path, branch, worktree, base_branch, omp_session_id, omp_session_file, parent_session_id, kind, model, prefix, runtime, native, deep_analysis, design_dir, synergy, synergy_page, minion, finding_kind, tester, schedule_id, schedule_name, effort, status, created_at, last_activity_at, estimate_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        row.runtime ?? null,
        row.native ? 1 : 0,
        row.deepAnalysis ? 1 : 0,
        row.designDir ?? null,
        row.synergy ? 1 : 0,
        row.synergy?.page ?? null,
        row.minion ? 1 : 0,
        row.findingKind ?? null,
        row.tester ? 1 : 0,
        row.schedule?.id ?? null,
        row.schedule?.name ?? null,
        row.effort ?? null,
        row.status,
        row.createdAt,
        row.lastActivityAt,
        estimateMinutes ?? null,
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
        `UPDATE sessions SET project_id=?, task_id=?, name=?, task=?, worktree_path=?, branch=?, worktree=?, base_branch=?, omp_session_id=?, omp_session_file=?, kind=?, model=?, prefix=?, runtime=?, effort=?, status=?, pr_opened=?, pr_url=?, pr_opened_at=?, archived=?, minion=?, minion_result=?, synergy=?, synergy_page=? WHERE id=?`,
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
        next.runtime ?? null,
        next.effort ?? null,
        next.status,
        next.prOpened ? 1 : 0,
        next.prUrl || null,
        next.prOpenedAt ?? null,
        next.archived ? 1 : 0,
        next.minion ? 1 : 0,
        next.minionResult ? JSON.stringify(next.minionResult) : null,
        next.synergy ? 1 : 0,
        next.synergy?.page ?? null,
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

  // The «Аналітика» ledger (usage_hours, activity_spans) stays: the money was spent
  // (docs/specs/2026-11-07-developer-analytics.md, decision 5).
  removeSession(id: string): void {
    this.db.prepare(`DELETE FROM session_findings WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ── «Аналітика» ledger (docs/specs/2026-11-07-developer-analytics.md, decision 5) ──────

  // The session's project and «тип сесії», copied onto each ledger row at write time so the
  // row still reads right after the session is deleted. Undefined for a row already gone.
  private ledgerOwner(sessionId: string): { projectId: string; sessionClass: AnalyticsSessionClass } | undefined {
    const r = this.db
      .prepare(`SELECT project_id, kind, tester, minion, design_dir, synergy, schedule_id FROM sessions WHERE id = ?`)
      .get(sessionId) as LedgerOwnerDbRow | undefined;
    return r ? { projectId: r.project_id, sessionClass: ledgerClass(r) } : undefined;
  }

  // One live turn of a managed session, folded into its UTC hour (upsert +=). Like addUsage a
  // targeted write on the agent-event path.
  addUsageHour(sessionId: string, e: UsageHourEntry, costKnown: boolean): void {
    const owner = this.ledgerOwner(sessionId);
    if (!owner) return;
    this.db
      .prepare(
        `INSERT INTO usage_hours (hour, session_id, model, source, project_id, session_class, cost_known, calls, model_ms, input, output, cache_read, cache_write, cost)
         VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, session_id, model, source) DO UPDATE SET calls = calls + excluded.calls, model_ms = model_ms + excluded.model_ms,
           input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
           cache_write = cache_write + excluded.cache_write, cost = cost + excluded.cost`,
      )
      .run(e.hour, sessionId, e.model, owner.projectId, owner.sessionClass, costKnown ? 1 : 0, e.calls, e.modelMs, e.input, e.output, e.cacheRead, e.cacheWrite, e.cost);
  }

  // Every `source` row of one session, replaced whole: a native session's live rows rebuilt from
  // its file after a turn (absolute, like setUsage, so a re-read never double counts).
  replaceUsageHours(sessionId: string, source: LedgerSource, entries: UsageHourEntry[], costKnown: boolean): void {
    const owner = this.ledgerOwner(sessionId);
    if (!owner) return;
    this.db.transaction(() => this.writeUsageHours(sessionId, owner, source, entries, costKnown))();
  }

  private writeUsageHours(
    sessionId: string,
    owner: { projectId: string; sessionClass: AnalyticsSessionClass },
    source: LedgerSource,
    entries: UsageHourEntry[],
    costKnown: boolean,
  ): void {
    this.db.prepare(`DELETE FROM usage_hours WHERE session_id = ? AND source = ?`).run(sessionId, source);
    const insert = this.db.prepare(
      `INSERT INTO usage_hours (hour, session_id, model, source, project_id, session_class, cost_known, calls, model_ms, input, output, cache_read, cache_write, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries)
      insert.run(e.hour, sessionId, e.model, source, owner.projectId, owner.sessionClass, costKnown ? 1 : 0, e.calls, e.modelMs, e.input, e.output, e.cacheRead, e.cacheWrite, e.cost);
  }

  openSpan(sessionId: string, projectId: string, kind: ActivitySpanKind, startedAt: string): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO activity_spans (id, session_id, project_id, kind, started_at, ended_at, source) VALUES (?, ?, ?, ?, ?, NULL, 'live')`)
      .run(id, sessionId, projectId, kind, startedAt);
    return id;
  }

  closeSpan(id: string, endedAt: string): void {
    this.db.prepare(`UPDATE activity_spans SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(endedAt, id);
  }

  // At start, after a crash: a span still open was left by the previous process. It closes at its
  // session's last activity — the last moment anything was known to happen — or at `now` when the
  // row is gone; never before it began. Returns how many were closed.
  closeDanglingSpans(now: string): number {
    return this.db
      .prepare(
        `UPDATE activity_spans SET ended_at = MAX(started_at, COALESCE((SELECT last_activity_at FROM sessions s WHERE s.id = activity_spans.session_id), ?)) WHERE ended_at IS NULL`,
      )
      .run(now).changes;
  }

  // Decision 5: ledger rows older than `before` (400 days, the caller's clock) go at start.
  pruneAnalytics(before: string): void {
    this.db.prepare(`DELETE FROM usage_hours WHERE hour < ?`).run(before);
    this.db.prepare(`DELETE FROM activity_spans WHERE COALESCE(ended_at, started_at) < ?`).run(before);
  }

  analyticsMeta(): AnalyticsMeta {
    const r = this.db
      .prepare(`SELECT ledger_started_at, import_state, import_done, import_total, import_ms, import_files, import_bytes FROM analytics_meta WHERE id = 1`)
      .get() as AnalyticsMetaDbRow;
    const state = r.import_state === "running" || r.import_state === "done" ? r.import_state : "pending";
    return {
      ledgerStartedAt: r.ledger_started_at,
      import: { state, done: r.import_done, total: r.import_total },
      ...(r.import_ms !== null ? { importStats: { ms: r.import_ms, files: r.import_files ?? 0, bytes: r.import_bytes ?? 0 } } : {}),
    };
  }

  setAnalyticsImport(state: AnalyticsImportState, stats?: { ms: number; files: number; bytes: number }): void {
    this.db
      .prepare(`UPDATE analytics_meta SET import_state = ?, import_done = ?, import_total = ?, import_ms = COALESCE(?, import_ms), import_files = COALESCE(?, import_files), import_bytes = COALESCE(?, import_bytes) WHERE id = 1`)
      .run(state.state, state.done, state.total, stats?.ms ?? null, stats?.files ?? null, stats?.bytes ?? null);
  }

  // One session of the history import (decision 6), atomically: its imported usage and spans
  // replace whatever an interrupted earlier run wrote, `pr_opened_at` is filled only where still
  // unknown, and the progress counter moves in the same transaction — a crash leaves either all
  // of it or none, so the re-run never double counts.
  applyImport(sessionId: string, data: { usage: UsageHourEntry[]; working: { startedAt: string; endedAt: string }[]; prOpenedAt?: string }, costKnown: boolean, progress: AnalyticsImportState): void {
    const owner = this.ledgerOwner(sessionId);
    this.db.transaction(() => {
      if (owner) {
        this.writeUsageHours(sessionId, owner, "import", data.usage, costKnown);
        this.db.prepare(`DELETE FROM activity_spans WHERE session_id = ? AND source = 'import'`).run(sessionId);
        const insert = this.db.prepare(
          `INSERT INTO activity_spans (id, session_id, project_id, kind, started_at, ended_at, source) VALUES (?, ?, ?, 'working', ?, ?, 'import')`,
        );
        for (const s of data.working) insert.run(randomUUID(), sessionId, owner.projectId, s.startedAt, s.endedAt);
        if (data.prOpenedAt) this.db.prepare(`UPDATE sessions SET pr_opened_at = ? WHERE id = ? AND pr_opened_at IS NULL`).run(data.prOpenedAt, sessionId);
      }
      this.setAnalyticsImport(progress);
    })();
  }

  // What `analyticsReport` aggregates, for the projects in scope (undefined = every project on
  // this machine). Usage and spans from `since` on (the caller passes a bound safely before the
  // previous period's start; the aggregation clips); a span still open reads as ending `now`.
  // Sessions and findings of the scope whole: the session figures look at any age, and
  // `lifetimeCost` sums every known-cost row of the session for «вартість PR».
  analyticsRows(projectIds: string[] | undefined, since: string, now: string): Pick<AnalyticsInput, "usage" | "spans" | "sessions" | "findings"> {
    const scope = (col: string) => (projectIds ? ` AND ${col} IN (SELECT value FROM json_each(?))` : "");
    const args = projectIds ? [JSON.stringify(projectIds)] : [];
    const usage = (
      this.db
        .prepare(
          `SELECT hour, session_id, model, MAX(project_id) AS project_id, MAX(session_class) AS session_class, MAX(cost_known) AS cost_known, SUM(calls) AS calls, SUM(model_ms) AS model_ms, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(cost) AS cost
           FROM usage_hours WHERE hour >= ?${scope("project_id")} GROUP BY hour, session_id, model`,
        )
        .all(since, ...args) as UsageHourDbRow[]
    ).map(
      (r): UsageHourRow => ({
        hour: r.hour,
        sessionId: r.session_id,
        projectId: r.project_id,
        model: r.model,
        sessionClass: r.session_class as AnalyticsSessionClass,
        costKnown: r.cost_known !== 0,
        calls: r.calls,
        modelMs: r.model_ms,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
        cost: r.cost,
      }),
    );
    const spans = (
      this.db
        .prepare(
          `SELECT session_id, project_id, kind, started_at, COALESCE(ended_at, ?) AS ended_at FROM activity_spans
           WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)${scope("project_id")}`,
        )
        .all(now, now, since, ...args) as { session_id: string; project_id: string; kind: string; started_at: string; ended_at: string }[]
    )
      .filter((r) => (ACTIVITY_SPAN_KINDS as readonly string[]).includes(r.kind))
      .map((r): ActivitySpanRow => ({ sessionId: r.session_id, projectId: r.project_id, kind: r.kind as ActivitySpanKind, startedAt: r.started_at, endedAt: r.ended_at }));
    const sessions = (
      this.db
        .prepare(
          `SELECT id, project_id, name, kind, tester, minion, design_dir, synergy, schedule_id, status, created_at, pr_opened, pr_opened_at, minion_result, parent_session_id, estimate_minutes,
             EXISTS (SELECT 1 FROM usage_hours u WHERE u.session_id = sessions.id) AS has_usage,
             (SELECT COALESCE(SUM(cost), 0) FROM usage_hours u WHERE u.session_id = sessions.id AND u.cost_known = 1) AS lifetime_cost
           FROM sessions WHERE 1 = 1${scope("project_id")}`,
        )
        .all(...args) as (LedgerOwnerDbRow & { id: string; name: string; status: SessionStatus; created_at: string; pr_opened: number; pr_opened_at: string | null; minion_result: string | null; parent_session_id: string | null; estimate_minutes: number | null; has_usage: number; lifetime_cost: number })[]
    ).map((r): AnalyticsSessionRow => {
      const minionOutcome = readMinionColumn(r.minion_result)?.outcome;
      return {
        id: r.id,
        projectId: r.project_id,
        name: r.name,
        kind: r.kind as Session["kind"],
        sessionClass: ledgerClass(r),
        status: r.status,
        createdAt: r.created_at,
        prOpened: r.pr_opened !== 0,
        ...(r.pr_opened_at ? { prOpenedAt: r.pr_opened_at } : {}),
        ...(minionOutcome ? { minionOutcome } : {}),
        ...(r.parent_session_id ? { parentSessionId: r.parent_session_id } : {}),
        ...(r.estimate_minutes ? { estimateMinutes: r.estimate_minutes } : {}),
        noHistory: r.has_usage === 0,
        lifetimeCost: r.lifetime_cost,
      };
    });
    const findings = (
      this.db
        .prepare(`SELECT f.kind, f.status, f.created_at FROM session_findings f JOIN sessions s ON s.id = f.session_id WHERE f.created_at >= ?${scope("s.project_id")}`)
        .all(since, ...args) as { kind: string; status: string; created_at: string }[]
    ).map(
      (r): AnalyticsFindingRow => ({
        kind: isFindingKind(r.kind) ? r.kind : "tech-debt",
        status: r.status === "filed" || r.status === "dismissed" ? r.status : "open",
        createdAt: r.created_at,
      }),
    );
    return { usage, spans, sessions, findings };
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
        `SELECT user_id as userId, access_token as accessToken, expires_at as expiresAt, github_username as githubUsername, agent_language as agentLanguage, skill_improvement_level as skillImprovementLevel FROM auth_session WHERE id = 1`,
      )
      .get() as (Omit<AuthSessionRow, "skillImprovementLevel"> & { agentLanguage: string | null; skillImprovementLevel: string | null }) | undefined;
    if (!row) return undefined;
    const { skillImprovementLevel, ...rest } = row;
    return {
      ...rest,
      ...(isSkillImprovementLevel(skillImprovementLevel) ? { skillImprovementLevel } : {}),
      expiresAt: row.expiresAt ?? undefined,
      githubUsername: row.githubUsername ?? undefined,
      agentLanguage: isAgentLanguage(row.agentLanguage) ? row.agentLanguage : undefined,
    };
  }

  setAuthSession(row: AuthSessionRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO auth_session (id, user_id, access_token, expires_at, github_username, agent_language, skill_improvement_level) VALUES (1,?,?,?,?,?,?)`,
      )
      .run(row.userId, row.accessToken, row.expiresAt ?? null, row.githubUsername ?? null, row.agentLanguage ?? null, row.skillImprovementLevel ?? null);
  }

  /** The operator's skill improvement level as the gates read it: unknown counts as the cloud default. */
  skillImprovementLevel(): SkillImprovementLevel {
    return this.getAuthSession()?.skillImprovementLevel ?? DEFAULT_SKILL_IMPROVEMENT_LEVEL;
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

  // No row yet reads as the defaults: claude inline, its history searchable.
  getNativeSettings(): NativeSettings {
    const row = this.db.prepare(`SELECT claude_full_screen FROM native_settings WHERE id = 1`).get() as
      | { claude_full_screen: number }
      | undefined;
    return { claudeFullScreen: row?.claude_full_screen === 1 };
  }

  setNativeSettings(s: NativeSettings): void {
    this.db.prepare(`INSERT OR REPLACE INTO native_settings (id, claude_full_screen) VALUES (1,?)`).run(s.claudeFullScreen ? 1 : 0);
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

  // ── The mobile device preview (local only, decisions 4 and 6) ────────────────

  // An unknown project or a row without a choice reads as {} (the defaults).
  getDeviceChoice(projectId: string): DeviceChoice {
    const row = this.db.prepare(`SELECT device_choice FROM projects WHERE id = ?`).get(projectId) as { device_choice: string | null } | undefined;
    return readDeviceChoice(row?.device_choice ?? null);
  }

  setDeviceChoice(projectId: string, choice: DeviceChoice): void {
    this.db.prepare(`UPDATE projects SET device_choice = ? WHERE id = ?`).run(JSON.stringify(choice), projectId);
  }

  getSessionDevice(sessionId: string): SessionDevice | null {
    const row = this.db.prepare(`SELECT device FROM sessions WHERE id = ?`).get(sessionId) as { device: string | null } | undefined;
    return readSessionDevice(row?.device ?? null);
  }

  // `null` forgets the clone (it was deleted).
  setSessionDevice(sessionId: string, device: SessionDevice | null): void {
    this.db.prepare(`UPDATE sessions SET device = ? WHERE id = ?`).run(device ? JSON.stringify(device) : null, sessionId);
  }

  // ── «Тестувальник» settings (docs/specs/2026-11-04-qa-tester-agent.md, decision 4) ──────────

  // No row yet reads as empty settings.
  getTesterSettings(projectId: string): TesterSettings {
    const s = this.db.prepare(`SELECT login_path, notes FROM tester_settings WHERE project_id = ?`).get(projectId) as
      | { login_path: string; notes: string }
      | undefined;
    const accounts = this.db
      .prepare(`SELECT id, name, login, password, note FROM tester_accounts WHERE project_id = ? ORDER BY position, rowid`)
      .all(projectId) as TesterSettings["accounts"];
    return { loginPath: s?.login_path ?? "", notes: s?.notes ?? "", accounts };
  }

  // Replaces the settings and the whole account list in one transaction; accounts keep the
  // given order. Ids must be assigned by the caller.
  setTesterSettings(projectId: string, settings: TesterSettings): void {
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT OR REPLACE INTO tester_settings (project_id, login_path, notes) VALUES (?,?,?)`)
        .run(projectId, settings.loginPath, settings.notes);
      this.db.prepare(`DELETE FROM tester_accounts WHERE project_id = ?`).run(projectId);
      const insert = this.db.prepare(`INSERT INTO tester_accounts (id, project_id, name, login, password, note, position) VALUES (?,?,?,?,?,?,?)`);
      settings.accounts.forEach((a, i) => insert.run(a.id, projectId, a.name, a.login, a.password, a.note, i));
    })();
  }

  // ── Scheduled tasks (docs/specs/2026-11-06-scheduled-tasks.md) ──────────────────────────────

  // Every stored task, oldest first. A row whose spec this build cannot read is left out rather
  // than fired on a guess.
  listSchedules(): ScheduleRow[] {
    const rows = this.db
      .prepare(`SELECT id, name, kind, prompt, project_id, skills, model, spec, time_zone, enabled, armed_at, created_at, updated_at FROM schedules ORDER BY created_at, id`)
      .all() as ScheduleDbRow[];
    return rows.map(readScheduleRow).filter((r): r is ScheduleRow => r !== undefined);
  }

  getSchedule(id: string): ScheduleRow | undefined {
    const row = this.db
      .prepare(`SELECT id, name, kind, prompt, project_id, skills, model, spec, time_zone, enabled, armed_at, created_at, updated_at FROM schedules WHERE id = ?`)
      .get(id) as ScheduleDbRow | undefined;
    return row ? readScheduleRow(row) : undefined;
  }

  // Insert or replace the whole row: the service always writes a task it has just built.
  putSchedule(t: ScheduleRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO schedules (id, name, kind, prompt, project_id, skills, model, spec, time_zone, enabled, armed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(t.id, t.name, t.kind, t.prompt, t.projectId ?? null, JSON.stringify(t.skills), t.model ?? null, JSON.stringify(t.schedule), t.timeZone, t.enabled ? 1 : 0, t.armedAt, t.createdAt, t.updatedAt);
  }

  // The task goes with its run history (decision 7: «its history goes with it»). Its slips stay:
  // they are notifications already delivered, and each one carries the task's name.
  deleteSchedule(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM schedule_runs WHERE schedule_id = ?`).run(id);
      this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
    })();
  }

  // The switch alone, for a «once» that has fired: the rest of the row may have been edited since
  // the caller read it, and a deleted task must stay deleted.
  disableSchedule(id: string, updatedAt: string): void {
    this.db.prepare(`UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?`).run(updatedAt, id);
  }

  // The claim: `false` when this (schedule_id, scheduled_for) is already taken — by an earlier
  // tick, or by the same occurrence before a restart.
  claimScheduleRun(run: ScheduleRun): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO schedule_runs (id, schedule_id, scheduled_for, run_trigger, status, reason, detail, started_at, ended_at, session_id, summary) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(run.id, run.scheduleId, run.scheduledFor ?? null, run.trigger, run.status, run.reason ?? null, run.detail ?? null, run.startedAt, run.endedAt ?? null, run.sessionId ?? null, run.summary ?? null);
    if (r.changes === 1) this.pruneScheduleRuns(run.scheduleId);
    return r.changes === 1;
  }

  updateScheduleRun(id: string, patch: Partial<Omit<ScheduleRun, "id" | "scheduleId">>): ScheduleRun | undefined {
    const cur = this.getScheduleRun(id);
    if (!cur) return undefined;
    const next: ScheduleRun = { ...cur, ...patch };
    this.db
      .prepare(`UPDATE schedule_runs SET status=?, reason=?, detail=?, ended_at=?, session_id=?, summary=? WHERE id=?`)
      .run(next.status, next.reason ?? null, next.detail ?? null, next.endedAt ?? null, next.sessionId ?? null, next.summary ?? null, id);
    return next;
  }

  getScheduleRun(id: string): ScheduleRun | undefined {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM schedule_runs WHERE id = ?`).get(id) as RunDbRow | undefined;
    return row ? readRunRow(row) : undefined;
  }

  // Newest first.
  listScheduleRuns(scheduleId: string): ScheduleRun[] {
    const rows = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC`).all(scheduleId) as RunDbRow[];
    return rows.map(readRunRow);
  }

  // Every run still in flight, on any task.
  listRunningScheduleRuns(): ScheduleRun[] {
    const rows = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM schedule_runs WHERE status = 'running' ORDER BY started_at`).all() as RunDbRow[];
    return rows.map(readRunRow);
  }

  // The latest occurrence already claimed for the task, whatever became of it (decision 8's
  // `lastFor`). ISO instants from toISOString sort as text.
  lastScheduledFor(scheduleId: string): string | undefined {
    const row = this.db.prepare(`SELECT MAX(scheduled_for) AS last FROM schedule_runs WHERE schedule_id = ?`).get(scheduleId) as { last: string | null } | undefined;
    return row?.last ?? undefined;
  }

  // Retention: the newest SCHEDULE_RUNS_KEEP runs of a task. A run in flight is never dropped,
  // nor the run holding the latest `scheduled_for`: it is the claim lastScheduledFor dedupes
  // against, and manual runs alone can push it out of the newest by start time.
  private pruneScheduleRuns(scheduleId: string): void {
    this.db
      .prepare(
        `DELETE FROM schedule_runs WHERE schedule_id = ? AND status != 'running'
           AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)
           AND (scheduled_for IS NULL OR scheduled_for != (SELECT MAX(scheduled_for) FROM schedule_runs WHERE schedule_id = ?))`,
      )
      .run(scheduleId, scheduleId, SCHEDULE_RUNS_KEEP, scheduleId);
  }

  // A new slip, then retention: the newest SCHEDULE_SLIPS_KEEP.
  putScheduleSlip(s: ScheduleSlip): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO schedule_slips (id, kind, schedule_id, schedule_name, at, scheduled_for, text, body, run_id, session_id, project_id, status, reason, late, seen, snoozed_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.kind,
        s.scheduleId,
        s.scheduleName,
        s.at,
        s.scheduledFor ?? null,
        s.text,
        s.body ?? null,
        s.runId ?? null,
        s.sessionId ?? null,
        s.projectId ?? null,
        s.status ?? null,
        s.reason ?? null,
        s.late ? 1 : 0,
        s.seen ? 1 : 0,
        s.snoozedUntil ?? null,
      );
    this.db
      .prepare(`DELETE FROM schedule_slips WHERE id NOT IN (SELECT id FROM schedule_slips ORDER BY at DESC, rowid DESC LIMIT ?)`)
      .run(SCHEDULE_SLIPS_KEEP);
  }

  getScheduleSlip(id: string): ScheduleSlip | undefined {
    const row = this.db.prepare(`SELECT ${SLIP_COLUMNS} FROM schedule_slips WHERE id = ?`).get(id) as SlipDbRow | undefined;
    return row ? readSlipRow(row) : undefined;
  }

  // Newest first, snoozed ones included: the service decides what a reader sees.
  listScheduleSlips(): ScheduleSlip[] {
    const rows = this.db.prepare(`SELECT ${SLIP_COLUMNS} FROM schedule_slips ORDER BY at DESC, rowid DESC`).all() as SlipDbRow[];
    return rows.map(readSlipRow);
  }

  // `ids` absent = every slip.
  markScheduleSlipsSeen(ids?: readonly string[]): void {
    if (!ids) {
      this.db.prepare(`UPDATE schedule_slips SET seen = 1`).run();
      return;
    }
    const mark = this.db.prepare(`UPDATE schedule_slips SET seen = 1 WHERE id = ?`);
    this.db.transaction(() => ids.forEach((id) => mark.run(id)))();
  }

  // A snooze hides the slip until `until`; the re-fire clears it with a new `at`, unseen.
  snoozeScheduleSlip(id: string, until: string): boolean {
    return this.db.prepare(`UPDATE schedule_slips SET snoozed_until = ? WHERE id = ?`).run(until, id).changes === 1;
  }

  refireScheduleSlip(id: string, at: string): ScheduleSlip | undefined {
    this.db.prepare(`UPDATE schedule_slips SET snoozed_until = NULL, at = ?, seen = 0 WHERE id = ?`).run(at, id);
    return this.getScheduleSlip(id);
  }

  // Snoozed slips whose time has come.
  dueSnoozedScheduleSlips(now: string): ScheduleSlip[] {
    const rows = this.db.prepare(`SELECT ${SLIP_COLUMNS} FROM schedule_slips WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? ORDER BY snoozed_until`).all(now) as SlipDbRow[];
    return rows.map(readSlipRow);
  }
}
