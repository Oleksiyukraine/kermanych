import { describe, expect, test } from "vitest";
import {
  catchUpWindowMs,
  describeSchedule,
  dueOccurrence,
  formatZonedWall,
  latestOccurrence,
  nextOccurrences,
  resolveWhen,
  validateScheduleDraft,
  validateSchedulePatch,
  validateScheduleSpec,
  validateScheduleWhen,
  zonedInstant,
  type ScheduleSpec,
} from "../src/schedules";

const KYIV = "Europe/Kyiv";
const iso = (ds: Date[]): string[] => ds.map((d) => d.toISOString());
const at = (s: string): Date => new Date(s);

describe("zonedInstant — DST «compatible»", () => {
  test("an ordinary wall time maps through the zone's offset", () => {
    expect(zonedInstant("2026-11-06", "19:00", KYIV).toISOString()).toBe("2026-11-06T17:00:00.000Z");
    expect(zonedInstant("2026-07-01", "19:00", KYIV).toISOString()).toBe("2026-07-01T16:00:00.000Z");
  });

  // Kyiv springs forward on 2026-03-29: 03:00 EET becomes 04:00 EEST, so 03:30 never happens.
  test("a wall time inside the spring gap moves forward by the gap", () => {
    expect(zonedInstant("2026-03-29", "03:30", KYIV).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(formatZonedWall(zonedInstant("2026-03-29", "03:30", KYIV), KYIV)).toBe("2026-03-29T04:30");
  });

  // Kyiv falls back on 2026-10-25: 04:00 EEST becomes 03:00 EET, so 03:30 happens twice.
  test("a wall time inside the doubled autumn hour takes its first instant", () => {
    expect(zonedInstant("2026-10-25", "03:30", KYIV).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  test("a daily time keeps its wall clock across both changes", () => {
    const daily: ScheduleSpec = { type: "daily", time: "03:30" };
    expect(iso(nextOccurrences(daily, KYIV, at("2026-03-27T12:00:00Z"), 4))).toEqual([
      "2026-03-28T01:30:00.000Z",
      "2026-03-29T01:30:00.000Z", // the gap: 04:30 EEST
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
    expect(iso(nextOccurrences(daily, KYIV, at("2026-10-23T12:00:00Z"), 3))).toEqual([
      "2026-10-24T00:30:00.000Z",
      "2026-10-25T00:30:00.000Z", // the first 03:30
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  test("every hour does not fire twice on the spring-gap instant", () => {
    const hourly: ScheduleSpec = { type: "hourly", every: 1, minute: 30 };
    const day = nextOccurrences(hourly, KYIV, at("2026-03-28T21:00:00Z"), 30).filter((d) => formatZonedWall(d, KYIV).startsWith("2026-03-29"));
    expect(day).toHaveLength(23);
    expect(new Set(iso(day)).size).toBe(23);
  });
});

describe("nextOccurrences", () => {
  test("weekdays skip the weekend", () => {
    // 2026-11-06 is a Friday; 12:00 local is past its 09:00.
    expect(iso(nextOccurrences({ type: "weekdays", time: "09:00" }, KYIV, at("2026-11-06T10:00:00Z"), 3))).toEqual([
      "2026-11-09T07:00:00.000Z",
      "2026-11-10T07:00:00.000Z",
      "2026-11-11T07:00:00.000Z",
    ]);
  });

  test("weekly fires on each chosen day", () => {
    expect(iso(nextOccurrences({ type: "weekly", days: [1, 4], time: "10:00" }, "UTC", at("2026-11-06T00:00:00Z"), 4))).toEqual([
      "2026-11-09T10:00:00.000Z",
      "2026-11-12T10:00:00.000Z",
      "2026-11-16T10:00:00.000Z",
      "2026-11-19T10:00:00.000Z",
    ]);
  });

  test("the 31st is clamped to the month's last day", () => {
    expect(iso(nextOccurrences({ type: "monthly", day: 31, time: "09:00" }, "UTC", at("2027-01-31T10:00:00Z"), 3))).toEqual([
      "2027-02-28T09:00:00.000Z",
      "2027-03-31T09:00:00.000Z",
      "2027-04-30T09:00:00.000Z",
    ]);
    expect(iso(nextOccurrences({ type: "monthly", day: 31, time: "09:00" }, "UTC", at("2028-02-01T00:00:00Z"), 1))).toEqual([
      "2028-02-29T09:00:00.000Z",
    ]);
  });

  test("every 5 hours counts from local midnight in a +05:30 zone, then restarts the next day", () => {
    // 23:30 local on 2026-11-06.
    const out = nextOccurrences({ type: "hourly", every: 5, minute: 0 }, "Asia/Kolkata", at("2026-11-06T18:00:00Z"), 6);
    expect(out.map((d) => formatZonedWall(d, "Asia/Kolkata"))).toEqual([
      "2026-11-07T00:00",
      "2026-11-07T05:00",
      "2026-11-07T10:00",
      "2026-11-07T15:00",
      "2026-11-07T20:00",
      "2026-11-08T00:00",
    ]);
    expect(out[0].toISOString()).toBe("2026-11-06T18:30:00.000Z");
  });

  test("once fires only strictly after `after`", () => {
    const once: ScheduleSpec = { type: "once", at: "2026-11-07T19:00" };
    expect(iso(nextOccurrences(once, KYIV, at("2026-11-06T00:00:00Z"), 3))).toEqual(["2026-11-07T17:00:00.000Z"]);
    expect(nextOccurrences(once, KYIV, at("2026-11-07T17:00:00Z"), 3)).toEqual([]);
  });
});

describe("latestOccurrence", () => {
  test("is inclusive of its bound", () => {
    const daily: ScheduleSpec = { type: "daily", time: "19:00" };
    expect(latestOccurrence(daily, KYIV, at("2026-11-06T16:59:00Z"))?.toISOString()).toBe("2026-11-05T17:00:00.000Z");
    expect(latestOccurrence(daily, KYIV, at("2026-11-06T17:00:00Z"))?.toISOString()).toBe("2026-11-06T17:00:00.000Z");
  });

  test("monthly looks back across a short month; once before its time has none", () => {
    expect(latestOccurrence({ type: "monthly", day: 31, time: "09:00" }, "UTC", at("2027-03-15T00:00:00Z"))?.toISOString()).toBe(
      "2027-02-28T09:00:00.000Z",
    );
    expect(latestOccurrence({ type: "once", at: "2026-11-07T19:00" }, KYIV, at("2026-11-07T16:59:00Z"))).toBeUndefined();
  });
});

describe("catchUpWindowMs", () => {
  const h = 3_600_000;
  test("half the period, clamped to 2–12 h", () => {
    expect(catchUpWindowMs({ type: "hourly", every: 1, minute: 0 })).toBe(2 * h);
    expect(catchUpWindowMs({ type: "hourly", every: 6, minute: 0 })).toBe(3 * h);
    expect(catchUpWindowMs({ type: "hourly", every: 12, minute: 0 })).toBe(6 * h);
    expect(catchUpWindowMs({ type: "daily", time: "19:00" })).toBe(12 * h);
    expect(catchUpWindowMs({ type: "weekly", days: [1], time: "19:00" })).toBe(12 * h);
    expect(catchUpWindowMs({ type: "monthly", day: 1, time: "19:00" })).toBe(12 * h);
    expect(catchUpWindowMs({ type: "once", at: "2026-11-07T19:00" })).toBe(12 * h);
  });
});

describe("dueOccurrence — decision 8", () => {
  const agent = {
    kind: "agent" as const,
    schedule: { type: "daily", time: "19:00" } as ScheduleSpec,
    timeZone: KYIV,
    armedAt: "2026-11-01T00:00:00.000Z",
    enabled: true,
  };
  const yesterday = at("2026-11-05T17:00:00Z");

  test("on time", () => {
    expect(dueOccurrence(agent, yesterday, at("2026-11-06T17:01:00Z"))).toEqual({ at: at("2026-11-06T17:00:00Z"), late: false, fire: "run" });
  });

  test("an agent task inside the window runs late", () => {
    expect(dueOccurrence(agent, yesterday, at("2026-11-06T23:00:00Z"))).toEqual({ at: at("2026-11-06T17:00:00Z"), late: true, fire: "run" });
  });

  test("an agent task past the window is missed", () => {
    expect(dueOccurrence(agent, yesterday, at("2026-11-07T06:00:00Z"))).toEqual({ at: at("2026-11-06T17:00:00Z"), late: true, fire: "missed" });
  });

  test("a reminder always lands, marked late", () => {
    expect(dueOccurrence({ ...agent, kind: "reminder" }, yesterday, at("2026-11-07T06:00:00Z"))).toEqual({
      at: at("2026-11-06T17:00:00Z"),
      late: true,
      fire: "run",
    });
  });

  test("only the latest of several missed occurrences", () => {
    expect(dueOccurrence(agent, yesterday, at("2026-11-09T17:02:00Z"))?.at.toISOString()).toBe("2026-11-09T17:00:00.000Z");
  });

  test("never at or before armedAt", () => {
    expect(dueOccurrence({ ...agent, armedAt: "2026-11-06T17:30:00.000Z" }, undefined, at("2026-11-06T18:00:00Z"))).toBeUndefined();
    expect(dueOccurrence({ ...agent, armedAt: "2026-11-06T17:00:00.000Z" }, undefined, at("2026-11-06T17:01:00Z"))).toBeUndefined();
  });

  test("never at or before the last claimed occurrence", () => {
    expect(dueOccurrence(agent, at("2026-11-06T17:00:00Z"), at("2026-11-06T17:01:00Z"))).toBeUndefined();
  });

  test("a disabled task is never due", () => {
    expect(dueOccurrence({ ...agent, enabled: false }, yesterday, at("2026-11-06T17:01:00Z"))).toBeUndefined();
  });
});

describe("resolveWhen and the wall-clock print", () => {
  test("«через N хв» becomes a once at that wall minute, rounded up", () => {
    expect(resolveWhen({ type: "in", minutes: 2 }, at("2026-11-06T16:42:30Z"), KYIV)).toEqual({ type: "once", at: "2026-11-06T18:45" });
    expect(resolveWhen({ type: "in", minutes: 2 }, at("2026-11-06T16:42:00Z"), KYIV)).toEqual({ type: "once", at: "2026-11-06T18:44" });
  });

  test("a spec passes through", () => {
    const daily: ScheduleSpec = { type: "daily", time: "19:00" };
    expect(resolveWhen(daily, at("2026-11-06T16:42:00Z"), KYIV)).toBe(daily);
  });

  test("the offset is printed for ЦУК's «now»", () => {
    expect(formatZonedWall(at("2026-11-06T16:42:00Z"), KYIV, true)).toBe("2026-11-06T18:42+02:00");
    expect(formatZonedWall(at("2026-11-06T16:42:00Z"), "Asia/Kolkata", true)).toBe("2026-11-06T22:12+05:30");
    expect(formatZonedWall(at("2026-11-06T16:42:00Z"), "America/New_York", true)).toBe("2026-11-06T11:42-05:00");
  });
});

describe("describeSchedule", () => {
  test.each<[ScheduleSpec, string, string]>([
    [{ type: "daily", time: "19:00" }, "щодня о 19:00", "daily at 19:00"],
    [{ type: "daily", time: "11:00" }, "щодня об 11:00", "daily at 11:00"],
    [{ type: "weekdays", time: "09:00" }, "по буднях о 09:00", "on weekdays at 09:00"],
    [{ type: "weekly", days: [1, 4], time: "10:00" }, "щопонеділка й щочетверга о 10:00", "every Monday and Thursday at 10:00"],
    [{ type: "weekly", days: [1, 3, 5], time: "10:00" }, "щопонеділка, щосереди й щоп'ятниці о 10:00", "every Monday, Wednesday and Friday at 10:00"],
    [{ type: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" }, "по буднях о 09:00", "on weekdays at 09:00"],
    [{ type: "monthly", day: 31, time: "09:00" }, "щомісяця 31-го о 09:00", "monthly on the 31st at 09:00"],
    [{ type: "monthly", day: 12, time: "09:00" }, "щомісяця 12-го о 09:00", "monthly on the 12th at 09:00"],
    [{ type: "hourly", every: 2, minute: 0 }, "кожні 2 год о :00", "every 2 h at :00"],
    [{ type: "hourly", every: 1, minute: 30 }, "щогодини о :30", "every hour at :30"],
    [{ type: "once", at: "2026-11-07T19:00" }, "7 листопада 2026 о 19:00", "7 November 2026 at 19:00"],
  ])("%j", (spec, uk, en) => {
    expect(describeSchedule(spec, "uk")).toBe(uk);
    expect(describeSchedule(spec, "en")).toBe(en);
  });
});

describe("validators", () => {
  const refused = (code: string) => ({ error: { code } });

  test("specs are normalised", () => {
    expect(validateScheduleSpec({ type: "daily", time: "9:05" })).toEqual({ type: "daily", time: "09:05" });
    expect(validateScheduleSpec({ type: "weekly", days: [4, 1, 4], time: "10:00" })).toEqual({ type: "weekly", days: [1, 4], time: "10:00" });
    expect(validateScheduleSpec({ type: "hourly", every: 3 })).toEqual({ type: "hourly", every: 3, minute: 0 });
    expect(validateScheduleSpec({ type: "once", at: "2026-11-07 19:00" })).toEqual({ type: "once", at: "2026-11-07T19:00" });
  });

  test.each<[unknown, string]>([
    [null, "schedule_when_invalid"],
    [{ type: "cron", expr: "* * * * *" }, "schedule_type_invalid"],
    [{ type: "daily", time: "24:00" }, "schedule_time_invalid"],
    [{ type: "daily" }, "schedule_time_invalid"],
    [{ type: "weekly", days: [], time: "10:00" }, "schedule_days_invalid"],
    [{ type: "weekly", days: [0], time: "10:00" }, "schedule_days_invalid"],
    [{ type: "monthly", day: 32, time: "10:00" }, "schedule_day_invalid"],
    [{ type: "hourly", every: 13, minute: 0 }, "schedule_every_invalid"],
    [{ type: "hourly", every: 2, minute: 60 }, "schedule_time_invalid"],
    [{ type: "once", at: "2026-02-30T10:00" }, "schedule_at_invalid"],
  ])("spec %j → %s", (raw, expected) => {
    expect(validateScheduleSpec(raw)).toMatchObject(refused(expected));
  });

  test("«через» is 1 minute to a week", () => {
    expect(validateScheduleWhen({ type: "in", minutes: "15" })).toEqual({ type: "in", minutes: 15 });
    expect(validateScheduleWhen({ type: "in", minutes: 0 })).toMatchObject(refused("schedule_in_invalid"));
    expect(validateScheduleWhen({ type: "in", minutes: 10081 })).toMatchObject(refused("schedule_in_invalid"));
  });

  const draft = { name: "Вітаміни", kind: "reminder", prompt: "випити вітаміни", schedule: { type: "daily", time: "19:00" }, timeZone: KYIV };

  test("a reminder draft", () => {
    expect(validateScheduleDraft(draft)).toEqual(draft);
  });

  test("an agent draft keeps its project, skills and model", () => {
    expect(validateScheduleDraft({ ...draft, kind: "agent", projectId: "p1", skills: [" report ", "report"], model: "opus" })).toEqual({
      ...draft,
      kind: "agent",
      projectId: "p1",
      skills: ["report"],
      model: "opus",
    });
  });

  test.each<[Record<string, unknown>, string]>([
    [{ name: " " }, "schedule_name_missing"],
    [{ name: "н".repeat(61) }, "schedule_name_too_long"],
    [{ kind: "cron" }, "schedule_type_invalid"],
    [{ prompt: "" }, "schedule_text_missing"],
    [{ projectId: "p1" }, "schedule_agent_only"],
    [{ skills: ["report"] }, "schedule_agent_only"],
    [{ model: "opus" }, "schedule_agent_only"],
    [{ skills: "report" }, "field_not_string_list"],
    [{ schedule: undefined }, "schedule_when_invalid"],
    [{ timeZone: "Mars/Olympus" }, "schedule_timezone_invalid"],
  ])("draft with %j → %s", (patch, expected) => {
    expect(validateScheduleDraft({ ...draft, ...patch })).toMatchObject(refused(expected));
  });

  test("a patch is checked against the task's kind", () => {
    expect(validateSchedulePatch({ projectId: "p1" }, "reminder")).toMatchObject(refused("schedule_agent_only"));
    expect(validateSchedulePatch({ projectId: null, model: null, enabled: false }, "agent")).toEqual({ projectId: null, model: null, enabled: false });
    expect(validateSchedulePatch({ schedule: { type: "weekdays", time: "8:00" } }, "reminder")).toEqual({ schedule: { type: "weekdays", time: "08:00" } });
  });
});
