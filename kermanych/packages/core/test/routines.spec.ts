import { describe, expect, it } from "vitest";
import {
  dueOccurrence,
  latestOccurrence,
  nextOccurrence,
  releaseRangeFor,
  routineLocalDate,
  zonedInstant,
  ROUTINE_CATCH_UP_MS,
  type RoutineSchedule,
} from "../src/routine-schedule";
import { validateRoutine } from "../src/routines";

const KYIV = "Europe/Kyiv";
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);

describe("zonedInstant", () => {
  it("names the instant of a wall-clock time on both sides of a DST change", () => {
    expect(iso(zonedInstant(2026, 10, 16, 10, 0, KYIV))).toBe("2026-10-16T07:00:00.000Z");
    expect(iso(zonedInstant(2026, 11, 2, 10, 0, KYIV))).toBe("2026-11-02T08:00:00.000Z");
  });

  it("moves a time inside the spring-forward gap forward by the gap", () => {
    // 2026-03-29 03:00 → 04:00 in Kyiv: 03:30 never happens and becomes 04:30 (+3).
    expect(iso(zonedInstant(2026, 3, 29, 3, 30, KYIV))).toBe("2026-03-29T01:30:00.000Z");
  });

  it("takes the first of an autumn time that happens twice", () => {
    // 2026-10-25 04:00 → 03:00 in Kyiv: 03:30 happens at +3 and again at +2.
    expect(iso(zonedInstant(2026, 10, 25, 3, 30, KYIV))).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("occurrences", () => {
  const monday10: RoutineSchedule = { kind: "weekly", days: [1], time: "10:00" };

  it("weekly: the last Monday before a Friday, and the next one", () => {
    const friday = at("2026-10-16T12:00:00Z");
    expect(iso(latestOccurrence(monday10, KYIV, friday))).toBe("2026-10-12T07:00:00.000Z");
    expect(iso(nextOccurrence(monday10, KYIV, friday))).toBe("2026-10-19T07:00:00.000Z");
  });

  it("keeps the wall-clock time across the autumn DST change", () => {
    expect(iso(nextOccurrence(monday10, KYIV, at("2026-10-23T00:00:00Z")))).toBe("2026-10-26T08:00:00.000Z");
  });

  it("an occurrence exactly at now is the latest, and not the next", () => {
    const now = at("2026-10-12T07:00:00Z");
    expect(iso(latestOccurrence(monday10, KYIV, now))).toBe("2026-10-12T07:00:00.000Z");
    expect(iso(nextOccurrence(monday10, KYIV, now))).toBe("2026-10-19T07:00:00.000Z");
  });

  it("weekdays skip the weekend", () => {
    const s: RoutineSchedule = { kind: "weekdays", time: "09:00" };
    expect(iso(latestOccurrence(s, KYIV, at("2026-10-18T12:00:00Z")))).toBe("2026-10-16T06:00:00.000Z");
    expect(iso(nextOccurrence(s, KYIV, at("2026-10-16T12:00:00Z")))).toBe("2026-10-19T06:00:00.000Z");
  });

  it("monthly on the 31st runs on the last day of a shorter month", () => {
    const s: RoutineSchedule = { kind: "monthly", day: 31, time: "10:00" };
    expect(iso(nextOccurrence(s, KYIV, at("2026-11-01T00:00:00Z")))).toBe("2026-11-30T08:00:00.000Z");
    expect(iso(latestOccurrence(s, KYIV, at("2026-11-15T00:00:00Z")))).toBe("2026-10-31T08:00:00.000Z");
  });

  it("hourly counts the minute on the zone's own clock", () => {
    const s: RoutineSchedule = { kind: "hourly", minute: 15 };
    expect(iso(latestOccurrence(s, KYIV, at("2026-10-16T12:10:00Z")))).toBe("2026-10-16T11:15:00.000Z");
    // India is +5:30, so its :15 is :45 in UTC.
    expect(iso(latestOccurrence(s, "Asia/Kolkata", at("2026-10-16T12:10:00Z")))).toBe("2026-10-16T11:45:00.000Z");
    expect(iso(nextOccurrence(s, "Asia/Kolkata", at("2026-10-16T12:10:00Z")))).toBe("2026-10-16T12:45:00.000Z");
  });

  it("once has a single occurrence; manual has none", () => {
    const s: RoutineSchedule = { kind: "once", date: "2026-10-20", time: "18:30" };
    expect(latestOccurrence(s, KYIV, at("2026-10-16T00:00:00Z"))).toBeUndefined();
    expect(iso(nextOccurrence(s, KYIV, at("2026-10-16T00:00:00Z")))).toBe("2026-10-20T15:30:00.000Z");
    expect(nextOccurrence(s, KYIV, at("2026-10-21T00:00:00Z"))).toBeUndefined();
    expect(latestOccurrence({ kind: "manual" }, KYIV, Date.now())).toBeUndefined();
    expect(nextOccurrence({ kind: "manual" }, KYIV, Date.now())).toBeUndefined();
  });
});

describe("dueOccurrence", () => {
  const daily: RoutineSchedule = { kind: "daily", time: "09:00" };
  const created = at("2026-10-01T00:00:00Z");

  it("is due on time as a scheduled run", () => {
    expect(dueOccurrence(daily, KYIV, created, at("2026-10-16T06:00:30Z"))).toEqual({
      at: at("2026-10-16T06:00:00Z"),
      trigger: "schedule",
    });
  });

  it("catches up only the most recent missed occurrence", () => {
    // The app was closed from Monday to Friday afternoon: one run, for Friday 09:00.
    expect(dueOccurrence(daily, KYIV, created, at("2026-10-16T14:00:00Z"))).toEqual({
      at: at("2026-10-16T06:00:00Z"),
      trigger: "catch_up",
    });
  });

  it("never fires a time from before the schedule was armed", () => {
    // Saved at 10:00 on the 16th: the 09:00 of that day is history, not a missed run.
    expect(dueOccurrence(daily, KYIV, at("2026-10-16T07:00:00Z"), at("2026-10-16T07:01:00Z"))).toBeUndefined();
  });

  it("drops an occurrence older than the catch-up window", () => {
    const weekly: RoutineSchedule = { kind: "weekly", days: [1], time: "10:00" };
    const monday = at("2026-10-05T07:00:00Z");
    expect(dueOccurrence(weekly, KYIV, created, monday + ROUTINE_CATCH_UP_MS - 60_000)?.at).toBe(monday);
    expect(dueOccurrence(weekly, KYIV, created, monday + ROUTINE_CATCH_UP_MS + 60_000)?.at).not.toBe(monday);
  });
});

describe("release range", () => {
  it("is the last N days ending on the run's day in the routine's zone", () => {
    // 23:30 UTC on the 1st of March is already the 2nd in Kyiv.
    const date = routineLocalDate(at("2026-03-01T23:30:00Z"), KYIV);
    expect(date).toBe("2026-03-02");
    expect(releaseRangeFor(date, 7)).toEqual({ rangeFrom: "2026-02-24", rangeTo: "2026-03-02" });
    expect(releaseRangeFor("2026-10-16", 1)).toEqual({ rangeFrom: "2026-10-16", rangeTo: "2026-10-16" });
  });
});

describe("validateRoutine", () => {
  const base = {
    name: "  Weekly release notes ",
    timezone: KYIV,
    action: { kind: "release_notes", sources: [{ projectId: "p1", branch: "main" }], periodDays: 7 },
    schedule: { kind: "weekly", days: [5, 1, 1], time: "10:00" },
  };

  it("normalises a valid routine", () => {
    expect(validateRoutine(base)).toEqual({
      routine: {
        name: "Weekly release notes",
        runner: "local",
        timezone: KYIV,
        action: { kind: "release_notes", sources: [{ projectId: "p1", branch: "main" }], periodDays: 7, groupBy: "topic" },
        schedule: { kind: "weekly", days: [1, 5], time: "10:00" },
      },
    });
  });

  it("holds a project routine to its own project", () => {
    const r = validateRoutine({ ...base, projectId: "p2" });
    expect(r).toMatchObject({ code: "project_scope" });
  });

  it("refuses Slack for an agent session", () => {
    const r = validateRoutine({
      ...base,
      projectId: "p1",
      action: { kind: "prompt", prompt: "Update dependencies" },
      slack: { teamId: "T1", channelId: "C1", channelName: "dev" },
    });
    expect(r).toMatchObject({ code: "slack_agent" });
  });

  it("refuses an unknown zone, a bad time and an empty prompt", () => {
    expect(validateRoutine({ ...base, timezone: "Mars/Olympus" })).toMatchObject({ code: "timezone_unknown" });
    expect(validateRoutine({ ...base, schedule: { kind: "daily", time: "24:00" } })).toMatchObject({ code: "time_format" });
    expect(validateRoutine({ ...base, action: { kind: "prompt", prompt: "  " } })).toMatchObject({ code: "prompt_empty" });
  });
});
