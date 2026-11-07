// «Задачі за розкладом» (docs/specs/2026-11-06-scheduled-tasks.md): reminders and agent runs the
// operator sets from ЦУК, personal and machine-local (decision 1).
//
// This module owns what the api, the UI and ЦУК agree on: the task and its schedule, the run and
// slip records, the refusals, and the occurrence math the scheduler fires by. Pure, like
// findings.ts and minion.ts — no clock, no storage; every function takes `now` when it needs one.
//
// Time zone math is `Intl` only. A schedule is a WALL-CLOCK time in the task's IANA zone
// («Defaults not raised»): «щодня о 19:00» stays 19:00 across a daylight-saving change. A wall
// time inside a spring-forward gap moves forward by the gap, a wall time inside a doubled autumn
// hour takes its first instant — Temporal's «compatible» disambiguation.
//
// The due rule is decision 8: only the latest occurrence ever fires; an agent task catches it up
// only inside half its period clamped to 2–12 h, past that it is «Пропущено»; a reminder always
// lands, marked late. Nothing at or before `armedAt` fires («Editing never fires the past»).

import type { Locale, ManagementRejection } from "./i18n-codes";

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** Decision 3: a reminder (no model, a slip) or an analysis run of an agent. */
export type ScheduleKind = "reminder" | "agent";
export const SCHEDULE_KINDS = ["reminder", "agent"] as const satisfies readonly ScheduleKind[];

/** ISO weekday, Monday = 1. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Wall-clock times are "HH:MM" (24 h) in the task's IANA `timeZone`.
export type ScheduleSpec =
  // A local wall date-time "YYYY-MM-DDTHH:MM". A «once» task switches itself off after it fires.
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  // Monday to Friday.
  | { type: "weekdays"; time: string }
  // `days` non-empty, unique, sorted.
  | { type: "weekly"; days: Weekday[]; time: string }
  // 1..31, clamped to the month's last day («31-го» fires on 28/29 February, 30 April).
  | { type: "monthly"; day: number; time: string }
  // Every 1..12 hours, at the local hours h with h % every === 0 (counted from 00:MM each day).
  | { type: "hourly"; every: number; minute: number };
export type ScheduleType = ScheduleSpec["type"];
export const SCHEDULE_TYPES = ["once", "daily", "weekdays", "weekly", "monthly", "hourly"] as const satisfies readonly ScheduleType[];

// What ЦУК may send: a spec, or «через N хв» — relative, so the EXECUTOR resolves it to a «once»
// at the moment it runs the action (a card clicked ten minutes later still means «from now»).
export type ScheduleWhen = ScheduleSpec | { type: "in"; minutes: number };

export const SCHEDULE_NAME_MAX = 60;
/** «через N хв» up to a week; longer is a date. */
export const SCHEDULE_IN_MAX_MINUTES = 7 * 24 * 60;
export const SCHEDULE_EVERY_MAX = 12;

export type ScheduledTask = {
  id: string;
  name: string;
  kind: ScheduleKind;
  // The reminder text, or the agent's task.
  prompt: string;
  // Agent only. Absent = no project: a one-shot child, not a session (decision 9).
  projectId?: string;
  // Agent only ([] for reminders): skill names, resolved when the run starts.
  skills: string[];
  // Agent only: a pinned model; absent = the project's default (or the backend's).
  model?: string;
  schedule: ScheduleSpec;
  timeZone: string;
  enabled: boolean;
  // ISO instant: occurrences at or before it never fire (creation, edit, resume).
  armedAt: string;
  createdAt: string;
  updatedAt: string;
  // ISO instant, computed by the api on every read; absent when disabled or nothing is ahead.
  nextAt?: string;
  // A run of this task is in flight.
  running: boolean;
};

export type ScheduleDraft = {
  name: string;
  kind: ScheduleKind;
  prompt: string;
  projectId?: string;
  skills?: string[];
  model?: string;
  schedule: ScheduleSpec;
  timeZone: string;
};

// `null` clears an optional field.
export type SchedulePatch = {
  name?: string;
  prompt?: string;
  projectId?: string | null;
  skills?: string[];
  model?: string | null;
  schedule?: ScheduleSpec;
  enabled?: boolean;
};

export type ScheduleRunTrigger = "schedule" | "catch-up" | "manual";
export type ScheduleRunStatus = "running" | "done" | "skipped" | "failed";
export type ScheduleRunReason =
  | "overlap" // the previous run of the task is still going
  | "missed" // past the catch-up window (decision 8)
  | "not_signed_in" // a project run needs the operator's JWT
  | "project_unbound" // the project has no repository on this machine
  | "project_missing" // the project is gone
  | "skill_missing" // a named skill no longer resolves
  | "launch_failed"
  | "run_failed"
  | "timeout"; // «Посіпака»'s time cap

// One firing. «Запустити зараз» has no `scheduledFor` («Exactly once»: the claim is the unique
// `(schedule_id, scheduled_for)` pair).
export type ScheduleRun = {
  id: string;
  scheduleId: string;
  scheduledFor?: string;
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  reason?: ScheduleRunReason;
  detail?: string;
  startedAt: string;
  endedAt?: string;
  // A project run's session (decision 5).
  sessionId?: string;
  // The first line of the run's final answer.
  summary?: string;
};

// A local «Центр сповіщень» entry (decision 6): a reminder fired, or a run ended / skipped / failed.
export type ScheduleSlipKind = "reminder" | "run";
export type ScheduleSlip = {
  id: string;
  kind: ScheduleSlipKind;
  scheduleId: string;
  scheduleName: string;
  // When the slip was written, or re-fired by a snooze.
  at: string;
  // The occurrence it is about.
  scheduledFor?: string;
  // The reminder text | the first line of the run's answer | the reason sentence.
  text: string;
  // A one-shot run's full answer (no project, decision 9).
  body?: string;
  runId?: string;
  sessionId?: string;
  projectId?: string;
  status?: ScheduleRunStatus;
  reason?: ScheduleRunReason;
  // Caught up late, or a missed reminder.
  late: boolean;
  seen: boolean;
  snoozedUntil?: string;
};

export const SCHEDULE_RUNS_KEEP = 50; // per task
export const SCHEDULE_SLIPS_KEEP = 200;
export const SCHEDULE_TICK_MS = 60_000;
/** Later than this after its occurrence = «із запізненням» / a missed reminder. */
export const SCHEDULE_ON_TIME_MS = 5 * 60_000;

/** What the menu-bar icon needs (decision 4): `active` = at least one enabled task. */
export type ScheduleTrayState = { active: boolean; next?: { name: string; at: string } };

// ── Wall-clock ⇄ instant (Intl only) ───────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Wall = { y: number; m: number; d: number; h: number; mi: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The instant's wall clock in `timeZone`, to the second, as if it were UTC. Shared with analytics.ts (not in the barrel). */
export function wallMs(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

/** UTC offset of `timeZone` at the instant, in ms (Kyiv in summer: +3 h). */
function offsetAt(ms: number, timeZone: string): number {
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  return wallMs(whole, timeZone) - whole;
}

function wallOf(ms: number, timeZone: string): Wall {
  const w = new Date(wallMs(ms, timeZone));
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes() };
}

// The «compatible» rule. Read as UTC, the wall time is off the real instant by the zone's offset;
// the offsets a day either side are the only two that can apply around one transition. A
// candidate is real when the zone agrees with its offset there: two real ones = a doubled hour
// (take the earlier instant), none = a gap (read it with the offset from before the gap, which
// lands after the gap by its length).
function wallToMs(y: number, m: number, d: number, h: number, mi: number, timeZone: string): number {
  const local = Date.UTC(y, m - 1, d, h, mi);
  const before = offsetAt(local - DAY, timeZone);
  const after = offsetAt(local + DAY, timeZone);
  const real = [local - before, local - after].filter((t) => offsetAt(t, timeZone) === local - t);
  if (real.length > 0) return Math.min(...real);
  return local - before;
}

/** The instant of a wall date-time ("YYYY-MM-DD", "HH:MM") in `timeZone` (DST «compatible»). */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(wallToMs(y, m, d, h, mi, timeZone));
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The instant's wall clock in `timeZone` as "YYYY-MM-DDTHH:MM", with the zone's offset
 * ("+02:00") appended when `withOffset` — the shape ЦУК's context prints («now», a row's «next»).
 */
export function formatZonedWall(at: Date, timeZone: string, withOffset = false): string {
  const w = wallOf(at.getTime(), timeZone);
  const s = `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
  if (!withOffset) return s;
  const off = Math.round(offsetAt(at.getTime(), timeZone) / MINUTE);
  const abs = Math.abs(off);
  return `${s}${off < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Whether `Intl` knows the IANA zone. */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v.trim() === "") return false;
  try {
    formatter(v);
    return true;
  } catch {
    return false;
  }
}

// ── Occurrences ────────────────────────────────────────────────────────────

function hm(time: string): [number, number] {
  const [h, mi] = time.split(":").map(Number);
  return [h, mi];
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isoWeekday(y: number, m: number, d: number): Weekday {
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (js === 0 ? 7 : js) as Weekday;
}

/** The calendar day `k` days from y-m-d. */
function shiftDay(y: number, m: number, d: number, k: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + k));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function onceMs(at: string, timeZone: string): number {
  const [date, time] = at.split("T");
  return zonedInstant(date, time, timeZone).getTime();
}

/** One local day's occurrences of a daily-grained spec, ascending, deduplicated. */
function dayOccurrences(spec: ScheduleSpec, y: number, m: number, d: number, timeZone: string): number[] {
  let walls: [number, number][] = [];
  switch (spec.type) {
    case "daily":
      walls = [hm(spec.time)];
      break;
    case "weekdays":
      if (isoWeekday(y, m, d) <= 5) walls = [hm(spec.time)];
      break;
    case "weekly":
      if (spec.days.includes(isoWeekday(y, m, d))) walls = [hm(spec.time)];
      break;
    case "monthly":
      if (d === Math.min(spec.day, daysInMonth(y, m))) walls = [hm(spec.time)];
      break;
    case "hourly":
      for (let h = 0; h < 24; h += spec.every) walls.push([h, spec.minute]);
      break;
    case "once":
      break;
  }
  // A gap can push one wall time onto the next one's instant (every hour, 03:30 → 04:30).
  const out = [...new Set(walls.map(([h, mi]) => wallToMs(y, m, d, h, mi, timeZone)))];
  return out.sort((a, b) => a - b);
}

// Every non-once spec fires at least once a month, and a monthly one is stepped by months: these
// caps only bound a malformed spec, they are never reached by a valid one.
const MAX_DAYS = 400;
const MAX_MONTHS = 24;

/** The next `n` occurrences strictly after `after`, ascending. */
export function nextOccurrences(spec: ScheduleSpec, timeZone: string, after: Date, n: number): Date[] {
  const from = after.getTime();
  const out: number[] = [];
  if (n <= 0) return [];
  if (spec.type === "once") {
    const t = onceMs(spec.at, timeZone);
    return t > from ? [new Date(t)] : [];
  }
  const w = wallOf(from, timeZone);
  if (spec.type === "monthly") {
    // From the previous month: a DST shift never moves an occurrence across more than a day.
    for (let k = -1; k < MAX_MONTHS && out.length < n; k++) {
      const first = new Date(Date.UTC(w.y, w.m - 1 + k, 1));
      const y = first.getUTCFullYear();
      const m = first.getUTCMonth() + 1;
      for (const t of dayOccurrences(spec, y, m, Math.min(spec.day, daysInMonth(y, m)), timeZone)) {
        if (t > from && out.length < n) out.push(t);
      }
    }
    return out.map((t) => new Date(t));
  }
  for (let k = -1; k < MAX_DAYS && out.length < n; k++) {
    const [y, m, d] = shiftDay(w.y, w.m, w.d, k);
    for (const t of dayOccurrences(spec, y, m, d, timeZone)) {
      if (t > from && (out.length === 0 || t > out[out.length - 1]) && out.length < n) out.push(t);
    }
  }
  return out.map((t) => new Date(t));
}

/** The latest occurrence at or before `atOrBefore`, if any. */
export function latestOccurrence(spec: ScheduleSpec, timeZone: string, atOrBefore: Date): Date | undefined {
  const until = atOrBefore.getTime();
  if (spec.type === "once") {
    const t = onceMs(spec.at, timeZone);
    return t <= until ? new Date(t) : undefined;
  }
  const w = wallOf(until, timeZone);
  const best = (ts: number[]): number | undefined => {
    const fit = ts.filter((t) => t <= until);
    return fit.length > 0 ? fit[fit.length - 1] : undefined;
  };
  if (spec.type === "monthly") {
    for (let k = 1; k > -MAX_MONTHS; k--) {
      const first = new Date(Date.UTC(w.y, w.m - 1 + k, 1));
      const y = first.getUTCFullYear();
      const m = first.getUTCMonth() + 1;
      const t = best(dayOccurrences(spec, y, m, Math.min(spec.day, daysInMonth(y, m)), timeZone));
      if (t !== undefined) return new Date(t);
    }
    return undefined;
  }
  // From the next local day back: a later day's occurrences are never earlier than this one's.
  for (let k = 1; k > -MAX_DAYS; k--) {
    const [y, m, d] = shiftDay(w.y, w.m, w.d, k);
    const t = best(dayOccurrences(spec, y, m, d, timeZone));
    if (t !== undefined) return new Date(t);
  }
  return undefined;
}

/**
 * Decision 8's catch-up window: half the period, clamped to 2–12 h. Every daily-or-slower spec
 * (its shortest gap is a day) gets 12 h; «once» and «monthly» too. Only «every N hours» is
 * shorter.
 */
export function catchUpWindowMs(spec: ScheduleSpec): number {
  if (spec.type !== "hourly") return 12 * HOUR;
  return Math.min(12 * HOUR, Math.max(2 * HOUR, (spec.every * HOUR) / 2));
}

export type ScheduleDue = { at: Date; late: boolean; fire: "run" | "missed" };

/**
 * Decision 8: what the tick does for one task now. `lastFor` is the latest `scheduledFor`
 * already claimed for the task (any status). Only the LATEST occurrence ≤ now is considered —
 * however many were slept through, one fires (or one «Пропущено» is written).
 */
export function dueOccurrence(
  task: Pick<ScheduledTask, "kind" | "schedule" | "timeZone" | "armedAt" | "enabled">,
  lastFor: Date | undefined,
  now: Date,
): ScheduleDue | undefined {
  if (!task.enabled) return undefined;
  const at = latestOccurrence(task.schedule, task.timeZone, now);
  if (at === undefined) return undefined;
  if (at.getTime() <= Date.parse(task.armedAt)) return undefined;
  if (lastFor !== undefined && at.getTime() <= lastFor.getTime()) return undefined;
  const lag = now.getTime() - at.getTime();
  const late = lag > SCHEDULE_ON_TIME_MS;
  if (task.kind === "reminder") return { at, late, fire: "run" };
  return { at, late, fire: lag <= catchUpWindowMs(task.schedule) ? "run" : "missed" };
}

/** «через N хв» → the «once» at that wall minute (rounded up), resolved when the action runs. */
export function resolveWhen(when: ScheduleWhen, now: Date, timeZone: string): ScheduleSpec {
  if (when.type !== "in") return when;
  const ms = Math.ceil((now.getTime() + when.minutes * MINUTE) / MINUTE) * MINUTE;
  return { type: "once", at: formatZonedWall(new Date(ms), timeZone) };
}

// ── Words (the card, the list, ЦУК's digest) ───────────────────────────────

const UK_EVERY_DAY: Record<Weekday, string> = {
  1: "щопонеділка",
  2: "щовівторка",
  3: "щосереди",
  4: "щочетверга",
  5: "щоп'ятниці",
  6: "щосуботи",
  7: "щонеділі",
};
const EN_DAY: Record<Weekday, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};
const UK_MONTH_OF = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const EN_MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function joinList(items: string[], and: string): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

// «о 19:00», but «об 11:00» / «об 01:00» — the numeral starts with a vowel («одинадцятій»).
function ukAt(time: string): string {
  const h = Number(time.slice(0, 2));
  return `${h === 1 || h === 11 ? "об" : "о"} ${time}`;
}

function enOrdinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** The schedule in words: «щодня о 19:00», «щопонеділка й щочетверга о 10:00», «every 2 h at :00». */
export function describeSchedule(spec: ScheduleSpec, locale: Locale): string {
  const uk = locale === "uk";
  switch (spec.type) {
    case "once": {
      const [date, time] = spec.at.split("T");
      const [y, m, d] = date.split("-").map(Number);
      return uk ? `${d} ${UK_MONTH_OF[m - 1]} ${y} ${ukAt(time)}` : `${d} ${EN_MONTH[m - 1]} ${y} at ${time}`;
    }
    case "daily":
      return uk ? `щодня ${ukAt(spec.time)}` : `daily at ${spec.time}`;
    case "weekdays":
      return uk ? `по буднях ${ukAt(spec.time)}` : `on weekdays at ${spec.time}`;
    case "weekly": {
      // The same set said the short way: Mon–Fri is «по буднях», all seven «щодня».
      const days = [...new Set(spec.days)].sort((a, b) => a - b);
      if (days.length === 7) return describeSchedule({ type: "daily", time: spec.time }, locale);
      if (days.join() === "1,2,3,4,5") return describeSchedule({ type: "weekdays", time: spec.time }, locale);
      return uk
        ? `${joinList(days.map((d) => UK_EVERY_DAY[d]), "й")} ${ukAt(spec.time)}`
        : `every ${joinList(days.map((d) => EN_DAY[d]), "and")} at ${spec.time}`;
    }
    case "monthly":
      return uk ? `щомісяця ${spec.day}-го ${ukAt(spec.time)}` : `monthly on the ${enOrdinal(spec.day)} at ${spec.time}`;
    case "hourly": {
      const minute = `:${pad(spec.minute)}`;
      if (spec.every === 1) return uk ? `щогодини о ${minute}` : `every hour at ${minute}`;
      return uk ? `кожні ${spec.every} год о ${minute}` : `every ${spec.every} h at ${minute}`;
    }
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

type Refusal = { error: ManagementRejection };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function shown(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
}

function int(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

// "9:00" and "09:00" both mean nine; the stored form is always "HH:MM".
function wallTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
  if (m === null) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? `${pad(h)}:${pad(mi)}` : undefined;
}

function wallDateTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}:\d{2})$/.exec(v.trim()) : null;
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const time = wallTime(m[4]);
  if (time === undefined || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${time}`;
}

function timeOf(o: Record<string, unknown>): string | Refusal {
  const time = wallTime(o.time);
  if (time === undefined)
    return { error: { text: `час має бути у форматі ГГ:ХХ, а не ${shown(o.time)}`, code: "schedule_time_invalid", params: { value: shown(o.time) } } };
  return time;
}

/** One schedule as it arrives over the wire → the stored shape (times "HH:MM", days sorted). */
export function validateScheduleSpec(raw: unknown): ScheduleSpec | Refusal {
  if (!isObj(raw))
    return { error: { text: `розклад має бути об'єктом, а не ${shown(raw)}`, code: "schedule_when_invalid", params: { value: shown(raw) } } };
  const type = str(raw.type) ?? "";
  switch (type) {
    case "once": {
      const at = wallDateTime(raw.at);
      if (at === undefined)
        return {
          error: { text: `дата й час мають бути у форматі РРРР-ММ-ДДTГГ:ХХ, а не ${shown(raw.at)}`, code: "schedule_at_invalid", params: { value: shown(raw.at) } },
        };
      return { type, at };
    }
    case "daily":
    case "weekdays": {
      const time = timeOf(raw);
      if (typeof time !== "string") return time;
      return { type, time };
    }
    case "weekly": {
      const days = Array.isArray(raw.days) ? raw.days.map(int) : [];
      if (days.length === 0 || days.some((d) => d === undefined || d < 1 || d > 7))
        return { error: { text: "дні тижня мають бути непорожнім списком чисел 1–7 (понеділок = 1)", code: "schedule_days_invalid" } };
      const time = timeOf(raw);
      if (typeof time !== "string") return time;
      return { type, days: [...new Set(days as Weekday[])].sort((a, b) => a - b), time };
    }
    case "monthly": {
      const day = int(raw.day);
      if (day === undefined || day < 1 || day > 31)
        return { error: { text: "день місяця має бути числом від 1 до 31", code: "schedule_day_invalid" } };
      const time = timeOf(raw);
      if (typeof time !== "string") return time;
      return { type, day, time };
    }
    case "hourly": {
      const every = int(raw.every);
      if (every === undefined || every < 1 || every > SCHEDULE_EVERY_MAX)
        return { error: { text: `інтервал має бути цілим числом годин від 1 до ${SCHEDULE_EVERY_MAX}`, code: "schedule_every_invalid" } };
      const minute = raw.minute === undefined ? 0 : int(raw.minute);
      if (minute === undefined || minute < 0 || minute > 59)
        return { error: { text: `хвилина має бути числом від 0 до 59, а не ${shown(raw.minute)}`, code: "schedule_time_invalid", params: { value: shown(raw.minute) } } };
      return { type, every, minute };
    }
    default:
      return { error: { text: `невідомий тип ${shown(raw.type)}`, code: "schedule_type_invalid", params: { value: shown(raw.type) } } };
  }
}

/** A spec or «через N хв» (ЦУК's `when`). */
export function validateScheduleWhen(raw: unknown): ScheduleWhen | Refusal {
  if (isObj(raw) && raw.type === "in") {
    const minutes = int(raw.minutes);
    if (minutes === undefined || minutes < 1 || minutes > SCHEDULE_IN_MAX_MINUTES)
      return { error: { text: `«через» має бути цілим числом хвилин від 1 до ${SCHEDULE_IN_MAX_MINUTES}`, code: "schedule_in_invalid" } };
    return { type: "in", minutes };
  }
  return validateScheduleSpec(raw);
}

/** Skill names: a list of non-empty strings, trimmed, each once. Existence is the api's check. */
export function validateScheduleSkills(raw: unknown): string[] | Refusal {
  if (!Array.isArray(raw))
    return { error: { text: "поле skills має бути списком рядків", code: "field_not_string_list", params: { field: "skills" } } };
  const out: string[] = [];
  for (const item of raw) {
    const name = str(item);
    if (name === undefined)
      return {
        error: {
          text: `поле skills має містити лише назви навичок, а не ${shown(item)}`,
          code: "field_list_not_all_strings",
          params: { field: "skills", value: shown(item) },
        },
      };
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function scheduleName(raw: unknown): string | Refusal {
  const name = str(raw);
  if (name === undefined) return { error: { text: "задача без назви", code: "schedule_name_missing" } };
  if (name.length > SCHEDULE_NAME_MAX)
    return { error: { text: `назва довша за ${SCHEDULE_NAME_MAX} символів`, code: "schedule_name_too_long", params: { max: SCHEDULE_NAME_MAX } } };
  return name;
}

export function scheduleAgentOnly(field: "project" | "skills" | "model"): Refusal {
  return { error: { text: `у нагадування не буває поля ${field} — лише в задачі агента`, code: "schedule_agent_only", params: { field } } };
}

function isRefusal(v: unknown): v is Refusal {
  return isObj(v) && "error" in v;
}

/** POST /schedules. Reminders carry no project, skills or model. */
export function validateScheduleDraft(raw: unknown): ScheduleDraft | Refusal {
  if (!isObj(raw)) return { error: { text: "задача має бути JSON-об'єктом", code: "action_not_object" } };
  const name = scheduleName(raw.name);
  if (isRefusal(name)) return name;
  const kind = raw.kind;
  if (kind !== "reminder" && kind !== "agent")
    return { error: { text: `невідомий тип ${shown(kind)}`, code: "schedule_type_invalid", params: { value: shown(kind) } } };
  const prompt = str(raw.prompt);
  if (prompt === undefined) return { error: { text: "задача без тексту", code: "schedule_text_missing" } };
  const projectId = str(raw.projectId);
  const model = str(raw.model);
  let skills: string[] = [];
  if (raw.skills !== undefined) {
    const s = validateScheduleSkills(raw.skills);
    if (isRefusal(s)) return s;
    skills = s;
  }
  if (kind === "reminder") {
    if (projectId !== undefined) return scheduleAgentOnly("project");
    if (skills.length > 0) return scheduleAgentOnly("skills");
    if (model !== undefined) return scheduleAgentOnly("model");
  }
  const schedule = validateScheduleSpec(raw.schedule);
  if (isRefusal(schedule)) return schedule;
  if (!isTimeZone(raw.timeZone))
    return { error: { text: `невідомий часовий пояс ${shown(raw.timeZone)}`, code: "schedule_timezone_invalid", params: { value: shown(raw.timeZone) } } };
  return {
    name,
    kind,
    prompt,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(kind === "agent" ? { skills } : {}),
    ...(model !== undefined ? { model } : {}),
    schedule,
    timeZone: raw.timeZone,
  };
}

/** PATCH /schedules/:id against the task's kind (which a patch never changes). */
export function validateSchedulePatch(raw: unknown, kind: ScheduleKind): SchedulePatch | Refusal {
  if (!isObj(raw)) return { error: { text: "зміна має бути JSON-об'єктом", code: "action_not_object" } };
  const out: SchedulePatch = {};
  if (raw.name !== undefined) {
    const name = scheduleName(raw.name);
    if (isRefusal(name)) return name;
    out.name = name;
  }
  if (raw.prompt !== undefined) {
    const prompt = str(raw.prompt);
    if (prompt === undefined) return { error: { text: "задача без тексту", code: "schedule_text_missing" } };
    out.prompt = prompt;
  }
  if (raw.projectId !== undefined) {
    const projectId = raw.projectId === null ? null : (str(raw.projectId) ?? null);
    if (projectId !== null && kind === "reminder") return scheduleAgentOnly("project");
    out.projectId = projectId;
  }
  if (raw.skills !== undefined) {
    const skills = validateScheduleSkills(raw.skills);
    if (isRefusal(skills)) return skills;
    if (skills.length > 0 && kind === "reminder") return scheduleAgentOnly("skills");
    out.skills = skills;
  }
  if (raw.model !== undefined) {
    const model = raw.model === null ? null : (str(raw.model) ?? null);
    if (model !== null && kind === "reminder") return scheduleAgentOnly("model");
    out.model = model;
  }
  if (raw.schedule !== undefined) {
    const schedule = validateScheduleSpec(raw.schedule);
    if (isRefusal(schedule)) return schedule;
    out.schedule = schedule;
  }
  if (raw.enabled !== undefined) out.enabled = raw.enabled === true;
  return out;
}
