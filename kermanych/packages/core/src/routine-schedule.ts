// Routines — the schedule half of the vocabulary (docs/specs/2026-10-16-routines.md): what a
// schedule is, when it is due, and on which calendar day a run falls. Split from ./routines on
// purpose and kept free of imports: two runners share it — the author's local api (through
// @kermanych/core) and the cloud runner (supabase/functions/routines-runner), which is Deno and
// cannot import this package. The Edge Function gets a byte-for-byte copy in
// supabase/functions/_shared/, written by `node scripts/sync-edge-shared.mjs`, and
// apps/api/test/edge-mirrors.spec.ts fails when the copy is stale. Edit THIS file, then sync.
//
// Reference: Claude Desktop's local scheduled tasks (checked every minute; one catch-up run for
// the most recent miss within seven days).

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

// An integer within inclusive bounds — shared with ./routines, whose action validator counts days.
export function isIntBetween(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// Why a routine is not valid: a stable `code` the editor words in the interface language
// (`management.routines.invalid.<code>`), and an English sentence for every other reader — a
// test, a log, a build that does not know the code.
export const ROUTINE_INVALID_CODES = [
  "name_missing",
  "name_too_long",
  "timezone_unknown",
  "runner_unknown",
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

export function routineInvalid(code: RoutineInvalidCode, error: string): RoutineInvalid {
  return { code, error };
}

// The schedule as stored, or the reason it cannot be.
export function parseRoutineSchedule(v: unknown): { schedule: RoutineSchedule } | RoutineInvalid {
  const s = (v ?? {}) as Record<string, unknown>;
  const badTime = routineInvalid("time_format", "the time must be HH:MM");
  switch (s.kind) {
    case "manual":
      return { schedule: { kind: "manual" } };
    case "once":
      if (typeof s.date !== "string" || !DATE_RE.test(s.date)) return routineInvalid("once_date", "once needs a YYYY-MM-DD date");
      if (!isRoutineTime(s.time)) return badTime;
      return { schedule: { kind: "once", date: s.date, time: s.time } };
    case "hourly":
      if (!isIntBetween(s.minute, 0, 59)) return routineInvalid("hourly_minute", "hourly needs a minute from 0 to 59");
      return { schedule: { kind: "hourly", minute: s.minute } };
    case "daily":
    case "weekdays":
      if (!isRoutineTime(s.time)) return badTime;
      return { schedule: { kind: s.kind, time: s.time } };
    case "weekly": {
      if (!isRoutineTime(s.time)) return badTime;
      const days = Array.isArray(s.days) ? s.days : [];
      if (days.length === 0 || !days.every((d) => isIntBetween(d, 0, 6))) return routineInvalid("weekly_days", "weekly needs at least one day (0–6)");
      return { schedule: { kind: "weekly", days: [...new Set(days as number[])].sort((a, b) => a - b), time: s.time } };
    }
    case "monthly":
      if (!isRoutineTime(s.time)) return badTime;
      if (!isIntBetween(s.day, 1, 31)) return routineInvalid("monthly_day", "monthly needs a day from 1 to 31");
      return { schedule: { kind: "monthly", day: s.day, time: s.time } };
    default:
      return routineInvalid("schedule_unknown", `unknown schedule (${ROUTINE_SCHEDULE_KINDS.join(" | ")})`);
  }
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
