// Routines — scheduled tasks of a workspace or one of its projects
// (docs/specs/2026-10-16-routines.md): what a routine does, where it runs, and its validation.
// The vocabulary lives in core because three parties must agree on it: the browser builds and
// validates a routine, the cloud stores it as jsonb, and the runners decide when it is due and
// what a run does. The schedule half — the math both runners share — is ./routine-schedule.
import { isReleaseGrouping, type ReleaseGrouping, type ReleaseSource } from "./release-notes";
import {
  isIntBetween,
  parseRoutineSchedule,
  routineInvalid,
  type RoutineInvalid,
  type RoutineSchedule,
} from "./routine-schedule";

// ── action ────────────────────────────────────────────────────────────────────

// What a run does. The scope (workspace, or one project — `projectId` on the row) decides how a
// prompt is run:
//   prompt, project scope   — a task card with the prompt, launched as an agent session there
//                             (`hideFromBoard` is the launcher's «Приховати з дошки»);
//   prompt, workspace scope — a read-only one-shot over every repository of the workspace,
//                             whose answer is the run's report;
//   release_notes           — a note over `sources` for the last `periodDays` days up to and
//                             including the run's day; project scope means one source, that
//                             project.
export type RoutineAction =
  | { kind: "prompt"; prompt: string; hideFromBoard?: boolean }
  | { kind: "release_notes"; sources: ReleaseSource[]; periodDays: number; groupBy: ReleaseGrouping };

export const ROUTINE_ACTION_KINDS = ["prompt", "release_notes"] as const;
export type RoutineActionKind = (typeof ROUTINE_ACTION_KINDS)[number];

// The Slack channel a run's document is posted to. A local routine posts as its author, to a
// channel their own Slack account is a member of (the release-notes OAuth connection); a cloud
// routine posts as the workspace's Slack bot, to a channel the bot was invited to. `teamId` is
// the Slack workspace the posting token must belong to.
export type RoutineSlackTarget = { teamId: string; channelId: string; channelName: string };

// Where a routine runs.
//   local — the author's own api, while Kermanych is open and signed in there: their checkouts,
//           their Slack account, their agent plan. A project prompt launches its agent.
//   cloud — the workspace's cloud runner (supabase/functions/routines-runner), whether or not
//           anybody is online: the code is read from GitHub, the model is the workspace's
//           Anthropic API key (billed per use), Slack posts come from the workspace's bot. A
//           project prompt only files its card — an agent needs a checkout, which the cloud has
//           not got — and the card waits in the author's «Задачі».
export const ROUTINE_RUNNERS = ["local", "cloud"] as const;
export type RoutineRunner = (typeof ROUTINE_RUNNERS)[number];

// ── runs ──────────────────────────────────────────────────────────────────────

// `succeeded` for a project prompt means the agent STARTED — what it did is in «Агенти», the way a
// green Claude routine run means the session started, not that the task in the prompt succeeded.
export const ROUTINE_RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

// `catch_up` is a scheduled run that started late because the machine was off or the app closed.
export const ROUTINE_RUN_TRIGGERS = ["schedule", "catch_up", "manual"] as const;
export type RoutineRunTrigger = (typeof ROUTINE_RUN_TRIGGERS)[number];

// Why a run was skipped or failed without an api error code of its own. The ui words them.
export const ROUTINE_RUN_REASONS = [
  "routine_previous_running",
  "routine_slack_failed",
  // the cloud runner (supabase/functions/routines-runner):
  "routine_cloud_timeout",
  "routine_cloud_unconfigured",
  "routine_github_remote",
  "routine_github_failed",
  "routine_model_failed",
] as const;
export type RoutineRunReason = (typeof ROUTINE_RUN_REASONS)[number];

// Limits, shared by the editor and the validator.
export const ROUTINE_NAME_MAX = 120;
export const ROUTINE_PROMPT_MAX = 20_000;
export const ROUTINE_PERIOD_MAX_DAYS = 92;

// A real IANA zone, as Intl understands it. `Intl.DateTimeFormat` throws a RangeError for an
// unknown zone, which is exactly the check.
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || !v.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

// The action as stored, checked against its scope: a project-scoped release note reads exactly
// that project.
export function parseRoutineAction(v: unknown, projectId: string | undefined): { action: RoutineAction } | RoutineInvalid {
  const a = (v ?? {}) as Record<string, unknown>;
  if (a.kind === "prompt") {
    const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
    if (!prompt) return routineInvalid("prompt_empty", "the prompt is empty");
    if (prompt.length > ROUTINE_PROMPT_MAX)
      return routineInvalid("prompt_too_long", `the prompt is longer than ${ROUTINE_PROMPT_MAX} characters`);
    return { action: { kind: "prompt", prompt, ...(projectId && a.hideFromBoard === true ? { hideFromBoard: true } : {}) } };
  }
  if (a.kind === "release_notes") {
    const raw = Array.isArray(a.sources) ? a.sources : [];
    const sources: ReleaseSource[] = [];
    for (const r of raw) {
      const src = (r ?? {}) as Record<string, unknown>;
      const id = typeof src.projectId === "string" ? src.projectId.trim() : "";
      const branch = typeof src.branch === "string" ? src.branch.trim() : "";
      if (!id || !branch) return routineInvalid("branch_missing", "every project needs a branch");
      if (sources.some((s) => s.projectId === id)) return routineInvalid("project_twice", "a project is listed twice");
      sources.push({ projectId: id, branch });
    }
    if (sources.length === 0) return routineInvalid("projects_missing", "pick at least one project");
    if (projectId && (sources.length !== 1 || sources[0]!.projectId !== projectId))
      return routineInvalid("project_scope", "a project routine writes release notes for that project only");
    if (!isIntBetween(a.periodDays, 1, ROUTINE_PERIOD_MAX_DAYS))
      return routineInvalid("period_range", `the period must be 1 to ${ROUTINE_PERIOD_MAX_DAYS} days`);
    const groupBy = a.groupBy ?? "topic";
    if (!isReleaseGrouping(groupBy)) return routineInvalid("group_by", "unknown release-notes layout");
    return { action: { kind: "release_notes", sources, periodDays: a.periodDays, groupBy } };
  }
  return routineInvalid("action_unknown", `unknown action (${ROUTINE_ACTION_KINDS.join(" | ")})`);
}

export function parseRoutineSlack(v: unknown): { slack: RoutineSlackTarget | undefined } | RoutineInvalid {
  if (v === undefined || v === null) return { slack: undefined };
  const s = v as Record<string, unknown>;
  const teamId = typeof s.teamId === "string" ? s.teamId.trim() : "";
  const channelId = typeof s.channelId === "string" ? s.channelId.trim() : "";
  const channelName = typeof s.channelName === "string" ? s.channelName.trim() : "";
  if (!teamId || !channelId || !channelName) return routineInvalid("slack_incomplete", "the Slack channel is incomplete");
  return { slack: { teamId, channelId, channelName } };
}

// One routine as the editor submits it.
export type RoutineDraft = {
  name: string;
  projectId?: string;
  runner?: unknown;
  action: unknown;
  schedule: unknown;
  timezone: string;
  slack?: unknown;
};

export type ValidRoutine = {
  name: string;
  projectId?: string;
  runner: RoutineRunner;
  action: RoutineAction;
  schedule: RoutineSchedule;
  timezone: string;
  slack?: RoutineSlackTarget;
};

// The first problem of a draft, or the routine as it is stored.
export function validateRoutine(d: RoutineDraft): { routine: ValidRoutine } | RoutineInvalid {
  const name = d.name.trim();
  if (!name) return routineInvalid("name_missing", "the routine needs a name");
  if (name.length > ROUTINE_NAME_MAX) return routineInvalid("name_too_long", `the name is longer than ${ROUTINE_NAME_MAX} characters`);
  if (!isTimeZone(d.timezone)) return routineInvalid("timezone_unknown", `unknown time zone «${d.timezone}»`);
  const runner = d.runner ?? "local";
  if (!(ROUTINE_RUNNERS as readonly unknown[]).includes(runner))
    return routineInvalid("runner_unknown", `unknown runner (${ROUTINE_RUNNERS.join(" | ")})`);
  const projectId = d.projectId?.trim() || undefined;
  const action = parseRoutineAction(d.action, projectId);
  if ("error" in action) return action;
  const schedule = parseRoutineSchedule(d.schedule);
  if ("error" in schedule) return schedule;
  const slack = parseRoutineSlack(d.slack);
  if ("error" in slack) return slack;
  // A project prompt's result is an agent session (or, in the cloud, a card), not a text there
  // is anything to post.
  if (slack.slack && projectId && action.action.kind === "prompt")
    return routineInvalid("slack_agent", "an agent session has no document to post to Slack");
  return {
    routine: {
      name,
      ...(projectId ? { projectId } : {}),
      runner: runner as RoutineRunner,
      action: action.action,
      schedule: schedule.schedule,
      timezone: d.timezone,
      ...(slack.slack ? { slack: slack.slack } : {}),
    },
  };
}
