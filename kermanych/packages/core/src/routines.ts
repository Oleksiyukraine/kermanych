// Routines — scheduled tasks of a workspace or one of its projects
// (docs/specs/2026-10-16-routines.md). The vocabulary lives in core because three parties must
// agree on it: the browser builds and validates a routine, the cloud stores it as jsonb, and the
// api decides when it is due and what a run does. Two copies of the schedule math would drift
// into a routine the screen says runs at 9:00 and the api runs at 10:00.
//
// Reference: Claude Desktop's local scheduled tasks (the api checks every minute while the app
// is open; one catch-up run for the most recent miss within seven days) with the definition
// stored where Claude's cloud routines keep theirs — in a shared account, here the workspace.
import { isReleaseGrouping, type ReleaseGrouping, type ReleaseSource } from "./release-notes";

// ── schedule ──────────────────────────────────────────────────────────────────

// When a routine runs. Every time of day is a wall-clock `HH:MM` in the routine's own IANA time
// zone (stored beside the schedule), so «щопонеділка о 10:00» stays 10:00 across a DST change.
//   manual   — never on its own; only «Run now»
//   once     — one date and time; the routine switches itself off after it fires
//   hourly   — every hour at `minute`
//   daily    — every day at `time`
//   weekdays — Monday to Friday at `time`
//   weekly   — on the listed days (0 = Sunday … 6 = Saturday) at `time`
//   monthly  — on day `day` of every month at `time`; a shorter month runs on its last day
export type RoutineSchedule =
  | { kind: "manual" }
  | { kind: "once"; date: string; time: string }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; day: number; time: string };

export const ROUTINE_SCHEDULE_KINDS = ["manual", "once", "hourly", "daily", "weekdays", "weekly", "monthly"] as const;
export type RoutineScheduleKind = (typeof ROUTINE_SCHEDULE_KINDS)[number];

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

// The Slack channel a run's document is posted to, as the author: a channel their own Slack
// account is a member of (picked through the release-notes OAuth connection). `teamId` is the
// Slack workspace the author's token must belong to when the run posts.
export type RoutineSlackTarget = { teamId: string; channelId: string; channelName: string };

// ── runs ──────────────────────────────────────────────────────────────────────

// `succeeded` for a project prompt means the agent STARTED — what it did is in «Агенти», the way a
// green Claude routine run means the session started, not that the task in the prompt succeeded.
export const ROUTINE_RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

// `catch_up` is a scheduled run that started late because the machine was off or the app closed.
export const ROUTINE_RUN_TRIGGERS = ["schedule", "catch_up", "manual"] as const;
export type RoutineRunTrigger = (typeof ROUTINE_RUN_TRIGGERS)[number];

// Why a run was skipped or failed without an api error code of its own. The ui words them.
export const ROUTINE_RUN_REASONS = ["routine_previous_running", "routine_slack_failed"] as const;
export type RoutineRunReason = (typeof ROUTINE_RUN_REASONS)[number];

// Limits, shared by the editor and the validator.
export const ROUTINE_NAME_MAX = 120;
export const ROUTINE_PROMPT_MAX = 20_000;
export const ROUTINE_PERIOD_MAX_DAYS = 92;

// A missed occurrence older than this is dropped instead of caught up.
export const ROUTINE_CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;
// A scheduled run that starts later than this after its time is labelled a catch-up.
export const ROUTINE_LATE_MS = 5 * 60 * 1000;

// ── validation ────────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isRoutineTime(v: unknown): v is string {
  return typeof v === "string" && TIME_RE.test(v);
}

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

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// Why a routine is not valid: a stable `code` the editor words in the interface language
// (`management.routines.invalid.<code>`), and an English sentence for every other reader — a
// test, a log, a build that does not know the code.
export const ROUTINE_INVALID_CODES = [
  "name_missing",
  "name_too_long",
  "timezone_unknown",
  "prompt_empty",
  "prompt_too_long",
  "projects_missing",
  "branch_missing",
  "project_twice",
  "project_scope",
  "period_range",
  "group_by",
  "action_unknown",
  "once_date",
  "time_format",
  "hourly_minute",
  "weekly_days",
  "monthly_day",
  "schedule_unknown",
  "slack_incomplete",
  "slack_agent",
] as const;
export type RoutineInvalidCode = (typeof ROUTINE_INVALID_CODES)[number];
export type RoutineInvalid = { code: RoutineInvalidCode; error: string };

function bad(code: RoutineInvalidCode, error: string): RoutineInvalid {
  return { code, error };
}

// The schedule as stored, or the reason it cannot be.
export function parseRoutineSchedule(v: unknown): { schedule: RoutineSchedule } | RoutineInvalid {
  const s = (v ?? {}) as Record<string, unknown>;
  const badTime = bad("time_format", "the time must be HH:MM");
  switch (s.kind) {
    case "manual":
      return { schedule: { kind: "manual" } };
    case "once":
      if (typeof s.date !== "string" || !DATE_RE.test(s.date)) return bad("once_date", "once needs a YYYY-MM-DD date");
      if (!isRoutineTime(s.time)) return badTime;
      return { schedule: { kind: "once", date: s.date, time: s.time } };
    case "hourly":
      if (!isInt(s.minute, 0, 59)) return bad("hourly_minute", "hourly needs a minute from 0 to 59");
      return { schedule: { kind: "hourly", minute: s.minute } };
    case "daily":
    case "weekdays":
      if (!isRoutineTime(s.time)) return badTime;
      return { schedule: { kind: s.kind, time: s.time } };
    case "weekly": {
      if (!isRoutineTime(s.time)) return badTime;
      const days = Array.isArray(s.days) ? s.days : [];
      if (days.length === 0 || !days.every((d) => isInt(d, 0, 6))) return bad("weekly_days", "weekly needs at least one day (0–6)");
      return { schedule: { kind: "weekly", days: [...new Set(days as number[])].sort((a, b) => a - b), time: s.time } };
    }
    case "monthly":
      if (!isRoutineTime(s.time)) return badTime;
      if (!isInt(s.day, 1, 31)) return bad("monthly_day", "monthly needs a day from 1 to 31");
      return { schedule: { kind: "monthly", day: s.day, time: s.time } };
    default:
      return bad("schedule_unknown", `unknown schedule (${ROUTINE_SCHEDULE_KINDS.join(" | ")})`);
  }
}

// The action as stored, checked against its scope: a project-scoped release note reads exactly
// that project.
export function parseRoutineAction(v: unknown, projectId: string | undefined): { action: RoutineAction } | RoutineInvalid {
  const a = (v ?? {}) as Record<string, unknown>;
  if (a.kind === "prompt") {
    const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
    if (!prompt) return bad("prompt_empty", "the prompt is empty");
    if (prompt.length > ROUTINE_PROMPT_MAX)
      return bad("prompt_too_long", `the prompt is longer than ${ROUTINE_PROMPT_MAX} characters`);
    return { action: { kind: "prompt", prompt, ...(projectId && a.hideFromBoard === true ? { hideFromBoard: true } : {}) } };
  }
  if (a.kind === "release_notes") {
    const raw = Array.isArray(a.sources) ? a.sources : [];
    const sources: ReleaseSource[] = [];
    for (const r of raw) {
      const src = (r ?? {}) as Record<string, unknown>;
      const id = typeof src.projectId === "string" ? src.projectId.trim() : "";
      const branch = typeof src.branch === "string" ? src.branch.trim() : "";
      if (!id || !branch) return bad("branch_missing", "every project needs a branch");
      if (sources.some((s) => s.projectId === id)) return bad("project_twice", "a project is listed twice");
      sources.push({ projectId: id, branch });
    }
    if (sources.length === 0) return bad("projects_missing", "pick at least one project");
    if (projectId && (sources.length !== 1 || sources[0]!.projectId !== projectId))
      return bad("project_scope", "a project routine writes release notes for that project only");
    if (!isInt(a.periodDays, 1, ROUTINE_PERIOD_MAX_DAYS))
      return bad("period_range", `the period must be 1 to ${ROUTINE_PERIOD_MAX_DAYS} days`);
    const groupBy = a.groupBy ?? "topic";
    if (!isReleaseGrouping(groupBy)) return bad("group_by", "unknown release-notes layout");
    return { action: { kind: "release_notes", sources, periodDays: a.periodDays, groupBy } };
  }
  return bad("action_unknown", `unknown action (${ROUTINE_ACTION_KINDS.join(" | ")})`);
}

export function parseRoutineSlack(v: unknown): { slack: RoutineSlackTarget | undefined } | RoutineInvalid {
  if (v === undefined || v === null) return { slack: undefined };
  const s = v as Record<string, unknown>;
  const teamId = typeof s.teamId === "string" ? s.teamId.trim() : "";
  const channelId = typeof s.channelId === "string" ? s.channelId.trim() : "";
  const channelName = typeof s.channelName === "string" ? s.channelName.trim() : "";
  if (!teamId || !channelId || !channelName) return bad("slack_incomplete", "the Slack channel is incomplete");
  return { slack: { teamId, channelId, channelName } };
}

// One routine as the editor submits it.
export type RoutineDraft = {
  name: string;
  projectId?: string;
  action: unknown;
  schedule: unknown;
  timezone: string;
  slack?: unknown;
};

export type ValidRoutine = {
  name: string;
  projectId?: string;
  action: RoutineAction;
  schedule: RoutineSchedule;
  timezone: string;
  slack?: RoutineSlackTarget;
};

// The first problem of a draft, or the routine as it is stored.
export function validateRoutine(d: RoutineDraft): { routine: ValidRoutine } | RoutineInvalid {
  const name = d.name.trim();
  if (!name) return bad("name_missing", "the routine needs a name");
  if (name.length > ROUTINE_NAME_MAX) return bad("name_too_long", `the name is longer than ${ROUTINE_NAME_MAX} characters`);
  if (!isTimeZone(d.timezone)) return bad("timezone_unknown", `unknown time zone «${d.timezone}»`);
  const projectId = d.projectId?.trim() || undefined;
  const action = parseRoutineAction(d.action, projectId);
  if ("error" in action) return action;
  const schedule = parseRoutineSchedule(d.schedule);
  if ("error" in schedule) return schedule;
  const slack = parseRoutineSlack(d.slack);
  if ("error" in slack) return slack;
  // A project prompt's result is an agent session, not a text there is anything to post.
  if (slack.slack && projectId && action.action.kind === "prompt")
    return bad("slack_agent", "an agent session has no document to post to Slack");
  return {
    routine: {
      name,
      ...(projectId ? { projectId } : {}),
      action: action.action,
      schedule: schedule.schedule,
      timezone: d.timezone,
      ...(slack.slack ? { slack: slack.slack } : {}),
    },
  };
}

// ── time zones ────────────────────────────────────────────────────────────────
// No date library: Intl knows every IANA zone, and two helpers on top of it are all the math
// needs. `wallClock` reads an instant as the zone shows it; `zonedInstant` finds the instant a
// wall-clock time names.

type Wall = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

export function wallClock(ms: number, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const year = parts.year!;
  const month = parts.month!;
  const day = parts.day!;
  return {
    year,
    month,
    day,
    hour: parts.hour!,
    minute: parts.minute!,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

// The zone's offset at an instant, in ms (Kyiv in summer: +3 h).
function offsetAt(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  const seconds = new Date(ms).getUTCSeconds();
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, seconds) - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time names in a zone, resolved the way Temporal's «compatible» mode
// does: a time inside a spring-forward gap (it never happens) moves forward by the gap, and an
// autumn time that happens twice takes its first occurrence. A zone changes its offset at most
// once around any given day, so the offsets a day before and a day after are the only two that
// can name the time.
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const DAY = 24 * 60 * 60 * 1000;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const early = offsetAt(guess - DAY, tz);
  const late = offsetAt(guess + DAY, tz);
  const byEarly = guess - early;
  const byLate = guess - late;
  const earlyHolds = offsetAt(byEarly, tz) === early;
  const lateHolds = offsetAt(byLate, tz) === late;
  if (earlyHolds && lateHolds) return Math.min(byEarly, byLate);
  if (lateHolds) return byLate;
  return byEarly;
}

// ── occurrences ───────────────────────────────────────────────────────────────

function hm(time: string): [number, number] {
  const [h, m] = time.split(":");
  return [Number(h), Number(m)];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Does a calendar day carry an occurrence of a day-based schedule?
function dayMatches(s: RoutineSchedule, year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  switch (s.kind) {
    case "daily":
      return true;
    case "weekdays":
      return weekday >= 1 && weekday <= 5;
    case "weekly":
      return s.days.includes(weekday);
    case "monthly":
      return day === Math.min(s.day, daysInMonth(year, month));
    default:
      return false;
  }
}

// Calendar arithmetic on a date, independent of any zone.
function shiftDate(year: number, month: number, day: number, by: number): [number, number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + by));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

// A month holds every monthly occurrence, so 62 days in either direction always finds one.
const SCAN_DAYS = 62;

// The latest occurrence at or before `now`, or undefined (manual; once in the future).
export function latestOccurrence(s: RoutineSchedule, tz: string, now: number): number | undefined {
  if (s.kind === "manual") return undefined;
  if (s.kind === "once") {
    const [y, mo, d] = s.date.split("-").map(Number) as [number, number, number];
    const at = zonedInstant(y, mo, d, ...hm(s.time), tz);
    return at <= now ? at : undefined;
  }
  const w = wallClock(now, tz);
  if (s.kind === "hourly") {
    const at = zonedInstant(w.year, w.month, w.day, w.hour, s.minute, tz);
    return at <= now ? at : at - 60 * 60 * 1000;
  }
  const [h, m] = hm(s.time);
  for (let back = 0; back <= SCAN_DAYS; back++) {
    const [y, mo, d] = shiftDate(w.year, w.month, w.day, -back);
    if (!dayMatches(s, y, mo, d)) continue;
    const at = zonedInstant(y, mo, d, h, m, tz);
    if (at <= now) return at;
  }
  return undefined;
}

// The first occurrence strictly after `after` — what the screen shows as «next run».
export function nextOccurrence(s: RoutineSchedule, tz: string, after: number): number | undefined {
  if (s.kind === "manual") return undefined;
  if (s.kind === "once") {
    const [y, mo, d] = s.date.split("-").map(Number) as [number, number, number];
    const at = zonedInstant(y, mo, d, ...hm(s.time), tz);
    return at > after ? at : undefined;
  }
  const w = wallClock(after, tz);
  if (s.kind === "hourly") {
    const at = zonedInstant(w.year, w.month, w.day, w.hour, s.minute, tz);
    return at > after ? at : at + 60 * 60 * 1000;
  }
  const [h, m] = hm(s.time);
  for (let fwd = 0; fwd <= SCAN_DAYS; fwd++) {
    const [y, mo, d] = shiftDate(w.year, w.month, w.day, fwd);
    if (!dayMatches(s, y, mo, d)) continue;
    const at = zonedInstant(y, mo, d, h, m, tz);
    if (at > after) return at;
  }
  return undefined;
}

// Is a run due now? The latest occurrence counts only when it is newer than the moment the
// schedule was armed (created, changed or re-enabled — the database stamps `armed_at`) and no
// older than the catch-up window. Older misses are dropped: a daily routine closed for a week runs
// once, not seven times.
export function dueOccurrence(
  s: RoutineSchedule,
  tz: string,
  armedAt: number,
  now: number,
): { at: number; trigger: "schedule" | "catch_up" } | undefined {
  const at = latestOccurrence(s, tz, now);
  if (at === undefined || at <= armedAt || now - at > ROUTINE_CATCH_UP_MS) return undefined;
  return { at, trigger: now - at > ROUTINE_LATE_MS ? "catch_up" : "schedule" };
}

// The calendar day an instant falls on in the routine's zone, YYYY-MM-DD.
export function routineLocalDate(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

// The inclusive release-notes range for a run on `date`: the last `periodDays` days, ending on it.
export function releaseRangeFor(date: string, periodDays: number): { rangeFrom: string; rangeTo: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [fy, fm, fd] = shiftDate(y, m, d, -(periodDays - 1));
  return { rangeFrom: `${fy}-${String(fm).padStart(2, "0")}-${String(fd).padStart(2, "0")}`, rangeTo: date };
}
