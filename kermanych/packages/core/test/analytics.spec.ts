import { describe, expect, test } from "vitest";
import {
  analyticsReport,
  type ActivitySpanKind,
  type ActivitySpanRow,
  type AnalyticsInput,
  type AnalyticsSessionRow,
  type UsageHourRow,
} from "../src/analytics";

const KYIV = "Europe/Kyiv";
const MIN = 60_000;
const HOUR = 60 * MIN;
// A Saturday, 12:00 in Kyiv (EET, +2).
const NOW = new Date("2026-11-07T10:00:00.000Z");

const input = (over: Partial<AnalyticsInput> = {}): AnalyticsInput => ({
  period: "7d",
  timeZone: KYIV,
  now: NOW,
  usage: [],
  spans: [],
  sessions: [],
  findings: [],
  import: { state: "done", done: 0, total: 0 },
  ...over,
});

const usage = (hour: string, over: Partial<UsageHourRow> = {}): UsageHourRow => ({
  hour,
  sessionId: "s1",
  projectId: "p1",
  model: "m1",
  sessionClass: "agent",
  costKnown: true,
  calls: 1,
  modelMs: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  ...over,
});

const span = (kind: ActivitySpanKind, startedAt: string, endedAt: string, over: Partial<ActivitySpanRow> = {}): ActivitySpanRow => ({
  sessionId: "s1",
  projectId: "p1",
  kind,
  startedAt,
  endedAt,
  ...over,
});

const session = (id: string, createdAt: string, over: Partial<AnalyticsSessionRow> = {}): AnalyticsSessionRow => ({
  id,
  projectId: "p1",
  name: id,
  kind: "agent",
  sessionClass: "agent",
  status: "done",
  createdAt,
  prOpened: false,
  noHistory: false,
  lifetimeCost: 0,
  ...over,
});

describe("analyticsReport — period and buckets in the zone", () => {
  // Kyiv falls back on 2026-10-25: 04:00 EEST becomes 03:00 EET, so that day is 25 hours long.
  test("30 days: day buckets at local midnight across the Kyiv DST change", () => {
    const r = analyticsReport(
      input({
        period: "30d",
        // 23:30 EET on 2026-10-25 — still the DST day, not the next one.
        usage: [usage("2026-10-25T21:00:00.000Z", { cost: 1, input: 10 })],
      }),
    );
    expect(r.granularity).toBe("day");
    expect(r.from).toBe("2026-10-08T21:00:00.000Z");
    expect(r.previousFrom).toBe("2026-09-08T21:00:00.000Z");
    expect(r.to).toBe(NOW.toISOString());
    expect(r.dynamics.buckets).toHaveLength(30);
    expect(r.dynamics.buckets[16]).toBe("2026-10-24T21:00:00.000Z");
    expect(r.dynamics.buckets[17]).toBe("2026-10-25T22:00:00.000Z");
    expect(r.dynamics.buckets[29]).toBe("2026-11-06T22:00:00.000Z");
    const cost = r.dynamics.series.model[0].cost;
    expect(cost[16]).toBe(1);
    expect(cost.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test("12 months: the first bucket starts at `from` mid-week, the rest at local Monday midnight", () => {
    const r = analyticsReport(input({ period: "12m" }));
    expect(r.granularity).toBe("week");
    // 2025-11-08 is a Saturday.
    expect(r.dynamics.buckets[0]).toBe("2025-11-07T22:00:00.000Z");
    expect(r.dynamics.buckets[1]).toBe("2025-11-09T22:00:00.000Z");
    // Monday 2026-03-30 is in summer time (+3).
    expect(r.dynamics.buckets).toContain("2026-03-29T21:00:00.000Z");
    expect(r.dynamics.buckets.at(-1)).toBe("2026-11-01T22:00:00.000Z");
    expect(r.dynamics.buckets).toHaveLength(53);
  });
});

describe("analyticsReport — agent time", () => {
  test("a working span is clipped to the period and split at midnight, in the bars and the heat map", () => {
    const r = analyticsReport(
      input({
        spans: [
          // Sat 23:00 → Sun 01:30 local: the part before the period's first midnight is dropped.
          span("working", "2026-10-31T21:00:00.000Z", "2026-10-31T23:30:00.000Z"),
          // Mon 23:00 → Tue 01:00 local.
          span("working", "2026-11-02T21:00:00.000Z", "2026-11-02T23:00:00.000Z"),
          // Sat 11:00 → 13:00 local: the part after now is dropped.
          span("working", "2026-11-07T09:00:00.000Z", "2026-11-07T11:00:00.000Z"),
        ],
      }),
    );
    expect(r.tiles.workingMs.value).toBe(4.5 * HOUR);
    expect(r.dynamics.series.project).toHaveLength(1);
    expect(r.dynamics.series.project[0].workingMs).toEqual([1.5 * HOUR, HOUR, HOUR, 0, 0, 0, HOUR]);
    expect(r.rhythm[6][0]).toBe(HOUR);
    expect(r.rhythm[6][1]).toBe(0.5 * HOUR);
    expect(r.rhythm[6][23]).toBe(0);
    expect(r.rhythm[0][23]).toBe(HOUR);
    expect(r.rhythm[1][0]).toBe(HOUR);
    expect(r.rhythm[5][11]).toBe(HOUR);
    expect(r.rhythm.flat().reduce((a, b) => a + b, 0)).toBe(4.5 * HOUR);
  });

  test("overlapping agents count once in the wall time: parallelism", () => {
    const r = analyticsReport(
      input({
        spans: [
          span("working", "2026-11-03T10:00:00.000Z", "2026-11-03T12:00:00.000Z", { sessionId: "a" }),
          span("working", "2026-11-03T11:00:00.000Z", "2026-11-03T13:00:00.000Z", { sessionId: "b" }),
          span("working", "2026-11-03T15:00:00.000Z", "2026-11-03T16:00:00.000Z", { sessionId: "c" }),
        ],
      }),
    );
    expect(r.tiles.workingMs.value).toBe(5 * HOUR);
    expect(r.tiles.parallelism).toBe(5 / 4);
  });

  test("no work: parallelism is null", () => {
    expect(analyticsReport(input()).tiles.parallelism).toBeNull();
  });

  test("the wait median takes full durations of waits ended in the period; an even count averages the middles", () => {
    const r = analyticsReport(
      input({
        spans: [
          span("waiting", "2026-11-03T10:00:00.000Z", "2026-11-03T10:01:00.000Z"),
          span("waiting", "2026-11-03T11:00:00.000Z", "2026-11-03T11:03:00.000Z"),
          span("waiting", "2026-11-03T12:00:00.000Z", "2026-11-03T12:10:00.000Z"),
          // Starts 10 min before the period: the median counts all 20 min, the total only 10.
          span("waiting", "2026-10-31T21:50:00.000Z", "2026-10-31T22:10:00.000Z"),
          // Ended before the period: out of the median.
          span("waiting", "2026-10-30T10:00:00.000Z", "2026-10-30T11:40:00.000Z"),
        ],
      }),
    );
    expect(r.tiles.waitMedianMs).toBe(6.5 * MIN);
    expect(r.tiles.waitingMs.value).toBe(24 * MIN);
    expect(r.tiles.waitingMs.previous).toBe(100 * MIN + 10 * MIN);
  });
});

describe("analyticsReport — previous period", () => {
  test("a previous period without data gives null, not 0", () => {
    const r = analyticsReport(
      input({
        usage: [usage("2026-11-03T10:00:00.000Z", { cost: 2, input: 5 })],
        spans: [span("working", "2026-11-03T10:00:00.000Z", "2026-11-03T11:00:00.000Z")],
        sessions: [session("s1", "2026-11-03T09:00:00.000Z", { prOpened: true, prOpenedAt: "2026-11-04T09:00:00.000Z" })],
      }),
    );
    expect(r.tiles.cost).toEqual({ value: 2, previous: null });
    expect(r.tiles.tokens).toEqual({ value: 5, previous: null });
    expect(r.tiles.workingMs).toEqual({ value: HOUR, previous: null });
    expect(r.tiles.waitingMs).toEqual({ value: 0, previous: null });
    expect(r.tiles.sessions).toEqual({ value: 1, previous: null });
    expect(r.tiles.prs).toEqual({ value: 1, previous: null });
  });

  test("a previous period with data of the source gives its figure, 0 included", () => {
    const r = analyticsReport(
      input({
        // Unpriced spend only: the dollars compare with 0, the tokens with 40.
        usage: [usage("2026-10-28T10:00:00.000Z", { costKnown: false, cost: 9, output: 40 })],
        sessions: [session("old", "2026-10-28T09:00:00.000Z")],
      }),
    );
    expect(r.tiles.cost).toEqual({ value: 0, previous: 0 });
    expect(r.tiles.tokens).toEqual({ value: 0, previous: 40 });
    expect(r.tiles.sessions).toEqual({ value: 0, previous: 1 });
    expect(r.tiles.prs.previous).toBeNull();
  });
});

describe("analyticsReport — unknown cost", () => {
  test("unpriced spend stays out of the dollars and is counted in unpricedTokens", () => {
    const r = analyticsReport(
      input({
        usage: [
          usage("2026-11-03T10:00:00.000Z", { cost: 2, calls: 4, input: 60, cacheRead: 40 }),
          usage("2026-11-03T11:00:00.000Z", { costKnown: false, cost: 5, calls: 6, output: 50 }),
        ],
        sessions: [session("s1", "2026-11-03T09:00:00.000Z")],
      }),
    );
    expect(r.tiles.cost.value).toBe(2);
    expect(r.tiles.tokens.value).toBe(150);
    expect(r.tiles.cacheShare).toBe(0.4);
    expect(r.coverage.unpricedTokens).toBe(50);
    expect(r.models).toEqual([
      { model: "m1", calls: 10, tokens: 150, cacheShare: 0.4, cost: 2, costKnown: false, costPerCall: 0.5, meanModelMs: null },
    ]);
    expect(r.topSessions).toEqual([
      { sessionId: "s1", projectId: "p1", name: "s1", sessionClass: "agent", cost: 2, tokens: 150, costKnown: false },
    ]);
  });
});

describe("analyticsReport — outcomes", () => {
  test("agent sessions of the period by where they are now, and PRs reworked after opening", () => {
    const at = "2026-11-02T09:00:00.000Z";
    const r = analyticsReport(
      input({
        sessions: [
          session("reworked", at, { prOpened: true, prOpenedAt: "2026-11-03T09:00:00.000Z", lifetimeCost: 3 }),
          session("clean", at, { prOpened: true, prOpenedAt: "2026-11-03T09:00:00.000Z", lifetimeCost: 5 }),
          session("review", at, { status: "in_review" }),
          session("merged", at, { status: "merged" }),
          session("thinking", at, { status: "thinking" }),
          session("done", at, { status: "done" }),
          session("stopped", at, { status: "stopped" }),
          session("error", at, { status: "error" }),
          session("conflict", at, { status: "conflict" }),
          session("chat", at, { kind: "chat", sessionClass: "chat", status: "merged" }),
          session("before", "2026-10-20T09:00:00.000Z", { status: "merged" }),
        ],
        spans: [
          span("working", "2026-11-03T10:00:00.000Z", "2026-11-03T11:00:00.000Z", { sessionId: "reworked" }),
          span("working", "2026-11-03T07:00:00.000Z", "2026-11-03T08:00:00.000Z", { sessionId: "clean" }),
        ],
      }),
    );
    expect(r.outcomes).toEqual({
      counts: { pr: 3, finished: 1, active: 2, stopped: 1, error: 1, conflict: 1 },
      total: 9,
      prReworked: 1,
    });
    expect(r.tiles.costPerPr).toBe(4);
  });
});
