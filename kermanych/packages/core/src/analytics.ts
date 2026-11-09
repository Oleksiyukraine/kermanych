// «Аналітика» (docs/specs/2026-11-07-developer-analytics.md): the developer's own analytics of
// the agent work run on this machine — personal and machine-local (decision 1).
//
// This module owns what the api and the UI agree on: the period vocabulary, the ledger rows the
// registry hands over, and the report the page draws. Pure, like schedules.ts — no clock, no
// storage; `analyticsReport` takes `now` and the rows. Time zone math is `Intl` only.

import { FINDING_KINDS, FINDING_STATUSES, type FindingKind, type FindingStatus } from "./findings";
import { MINION_OUTCOMES, type MinionOutcome } from "./minion";
import { wallMs, zonedInstant } from "./schedules";
import type { Session, SessionStatus } from "./types";

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** Decision 4: each period ends now; its first day starts at local midnight. */
export const ANALYTICS_PERIODS = ["7d", "30d", "90d", "12m"] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const ANALYTICS_DEFAULT_PERIOD: AnalyticsPeriod = "7d";
/** Calendar days each period spans, today included. */
export const ANALYTICS_PERIOD_DAYS: Record<AnalyticsPeriod, number> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 };

export function isAnalyticsPeriod(v: unknown): v is AnalyticsPeriod {
  return typeof v === "string" && (ANALYTICS_PERIODS as readonly string[]).includes(v);
}

/**
 * What a session is, for the «тип сесії» split (decision 8.3). The stamped flags win over
 * `kind`: a Тестувальник is a `review` child, a Посіпака run, a design or a synergy session is
 * an `agent`, a scheduled run is whichever kind it launched as.
 */
export const ANALYTICS_SESSION_CLASSES = [
  "agent",
  "chat",
  "discussion",
  "review",
  "tester",
  "minion",
  "design",
  "synergy",
  "schedule",
  "task",
] as const;
export type AnalyticsSessionClass = (typeof ANALYTICS_SESSION_CLASSES)[number];

export function analyticsSessionClass(
  s: Pick<Session, "kind" | "tester" | "minion" | "designDir" | "synergy" | "schedule">,
): AnalyticsSessionClass {
  if (s.tester) return "tester";
  if (s.minion) return "minion";
  if (s.designDir) return "design";
  if (s.synergy) return "synergy";
  if (s.schedule) return "schedule";
  return s.kind;
}

/** Decision 5: the three kinds of `activity_spans`. */
export const ACTIVITY_SPAN_KINDS = ["working", "waiting", "queued"] as const;
export type ActivitySpanKind = (typeof ACTIVITY_SPAN_KINDS)[number];

/** The coarse status a span kind covers; `undefined` for statuses no span records. */
export function activitySpanKind(status: SessionStatus): ActivitySpanKind | undefined {
  if (status === "thinking" || status === "tool") return "working";
  if (status === "waiting_input") return "waiting";
  if (status === "queued") return "queued";
  return undefined;
}

/** Decision 8.3: the «Динаміка» split. */
export const ANALYTICS_SPLITS = ["model", "project", "class"] as const;
export type AnalyticsSplit = (typeof ANALYTICS_SPLITS)[number];

/** Decision 8.5: where the agent sessions created in the period are now. */
export const ANALYTICS_OUTCOMES = ["pr", "finished", "active", "stopped", "error", "conflict"] as const;
export type AnalyticsOutcome = (typeof ANALYTICS_OUTCOMES)[number];

// ── Ledger rows (what the registry reads, what the aggregation takes) ───────

/** One `usage_hours` row: spend of one session on one model within one UTC hour. */
export type UsageHourRow = {
  /** ISO instant of the UTC hour's start, e.g. `2026-11-07T14:00:00.000Z`. */
  hour: string;
  sessionId: string;
  projectId: string;
  model: string;
  sessionClass: AnalyticsSessionClass;
  /** False for native claude / codex: their files carry no cost (decision 7). */
  costKnown: boolean;
  calls: number;
  modelMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

/** One `activity_spans` row. The reader closes a still-open span at `now`. */
export type ActivitySpanRow = {
  sessionId: string;
  projectId: string;
  kind: ActivitySpanKind;
  startedAt: string;
  endedAt: string;
};

/** A session row as the aggregation needs it — every session of the scope, any age. */
export type AnalyticsSessionRow = {
  id: string;
  projectId: string;
  name: string;
  kind: Session["kind"];
  sessionClass: AnalyticsSessionClass;
  status: SessionStatus;
  createdAt: string;
  prOpened: boolean;
  prOpenedAt?: string;
  minionOutcome?: MinionOutcome;
  /** The session it was forked from — for a Тестувальник run, the doer whose task it tested. */
  parentSessionId?: string;
  /** The card's estimate as the launch stamped it (docs/specs/2026-11-09-task-estimate.md). */
  estimateMinutes?: number;
  /** Neither a usage row nor a readable harness file: spend unknown (decision 6). */
  noHistory: boolean;
  /**
   * Known cost over ALL the session's `usage_hours` rows, any hour (0 without any): the «PR
   * відкрито» tile's cost per PR is the lifetime spend of those sessions (decision 8.2), which the
   * period-limited `usage` cannot add up.
   */
  lifetimeCost: number;
};

export type AnalyticsFindingRow = { kind: FindingKind; status: FindingStatus; createdAt: string };

/** Decision 6: the one-time history import. */
export type AnalyticsImportState = { state: "pending" | "running" | "done"; done: number; total: number };

export type AnalyticsInput = {
  period: AnalyticsPeriod;
  /** IANA zone the day boundaries, the weekday and the hour of the heat map are in. */
  timeZone: string;
  now: Date;
  usage: UsageHourRow[];
  spans: ActivitySpanRow[];
  sessions: AnalyticsSessionRow[];
  findings: AnalyticsFindingRow[];
  /** When live recording began: waiting/queued figures start here (decision 6). */
  ledgerStartedAt?: string;
  import: AnalyticsImportState;
};

// ── The report ──────────────────────────────────────────────────────────────

/** A figure and the same figure over the previous period; `previous` is null when that period holds no data of the figure's source. */
export type AnalyticsMetric = { value: number; previous: number | null };

export type AnalyticsSeries = {
  /** model id, project id, or an AnalyticsSessionClass — by the split it belongs to. */
  key: string;
  /** One value per bucket, in `buckets` order. Dollars of known cost. */
  cost: number[];
  /** input + output + cacheRead + cacheWrite. */
  tokens: number[];
  workingMs: number[];
};

export type AnalyticsModelRow = {
  model: string;
  calls: number;
  tokens: number;
  /** cacheRead / (input + cacheRead); null when both are 0. */
  cacheShare: number | null;
  /** Known cost only. */
  cost: number;
  /** False when some of the model's spend has no price. */
  costKnown: boolean;
  /** cost / calls over priced calls; null without priced calls. */
  costPerCall: number | null;
  /** modelMs / calls; null when no call reported a duration. */
  meanModelMs: number | null;
};

export type AnalyticsProjectRow = {
  projectId: string;
  sessions: number;
  prs: number;
  cost: number;
  workingMs: number;
  waitingMs: number;
};

export type AnalyticsTopSession = {
  sessionId: string;
  projectId: string;
  /** Absent when the session row is gone: «видалена сесія». */
  name?: string;
  sessionClass: AnalyticsSessionClass;
  cost: number;
  tokens: number;
  costKnown: boolean;
};

export type AnalyticsReport = {
  period: AnalyticsPeriod;
  timeZone: string;
  /** ISO instants: [from, to) is the period, [previousFrom, from) the one it is compared with. */
  from: string;
  to: string;
  previousFrom: string;
  granularity: "day" | "week";
  coverage: {
    ledgerStartedAt?: string;
    import: AnalyticsImportState;
    /** Sessions of the period with no spend history at all. */
    sessionsWithoutHistory: number;
    /** Tokens in the period whose cost is unknown (native claude / codex). */
    unpricedTokens: number;
  };
  tiles: {
    cost: AnalyticsMetric;
    tokens: AnalyticsMetric;
    cacheShare: number | null;
    workingMs: AnalyticsMetric;
    /** working sum ÷ wall time with at least one agent working; null without work. */
    parallelism: number | null;
    waitingMs: AnalyticsMetric;
    /** Median duration of the waiting spans that ended in the period; null without any. */
    waitMedianMs: number | null;
    sessions: AnalyticsMetric;
    prs: AnalyticsMetric;
    /** Lifetime known cost of the period's PR sessions ÷ their count; null without PRs. */
    costPerPr: number | null;
    /**
     * Median of `prOpenedAt − createdAt` over the period's PR sessions (the same ones `prs`
     * counts); a negative pair is left out. Null without any.
     */
    prLeadMedianMs: number | null;
  };
  dynamics: {
    /** ISO instant each bucket starts at (local midnight, or local Monday midnight by week). */
    buckets: string[];
    series: Record<AnalyticsSplit, AnalyticsSeries[]>;
    /**
     * «Час до PR» by the bucket its PR was opened in: the median of `prOpenedAt − createdAt` and
     * how many PRs it is over (negative pairs left out, as `tiles.prLeadMedianMs`). Its own
     * buckets: by day for 7 days, by week above — one or two PRs a day make a daily median noise.
     */
    prLead: { granularity: "day" | "week"; buckets: string[]; medianMs: (number | null)[]; counts: number[] };
  };
  /**
   * «Оцінка vs факт» (docs/specs/2026-11-09-task-estimate.md, decision 5), over the PRs the
   * «Час до PR» figures use: how many there are, how many carried an estimate at launch, and,
   * over those, the median estimate, the median time to PR and the median of each PR's
   * `estimate ÷ time to PR` (above 1: faster than estimated). The medians are null without an
   * estimated PR.
   */
  estimate: {
    prs: number;
    estimated: number;
    estimateMedianMs: number | null;
    leadMedianMs: number | null;
    ratioMedian: number | null;
  };
  /** [weekday Monday = 0][local hour 0–23] → working ms. */
  rhythm: number[][];
  outcomes: { counts: Record<AnalyticsOutcome, number>; total: number; prReworked: number };
  models: AnalyticsModelRow[];
  projects: AnalyticsProjectRow[];
  topSessions: AnalyticsTopSession[];
  minion: Record<MinionOutcome, number>;
  /**
   * Тестувальник runs started in the period, and the tasks they tested: distinct doers, so a
   * task checked twice counts once. Verdicts live in the cloud checklist and are not read here.
   */
  tester: { runs: number; tasks: number };
  findings: { byKind: Record<FindingKind, number>; byStatus: Record<FindingStatus, number> };
};

// ── The aggregation ─────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Decision 4: bars by day up to 31 days (`DAY_GRANULARITY_MAX_DAYS` of the UI's lib/capacity.ts), by week above. */
const DAY_GRANULARITY_MAX_DAYS = 31;
const TOP_SESSIONS = 10;

type Range = [number, number];
type Span = ActivitySpanRow & { s: number; e: number };
type Bars = { cost: number[]; tokens: number[]; workingMs: number[] };

const tokensOf = (r: UsageHourRow): number => r.input + r.output + r.cacheRead + r.cacheWrite;
const knownCost = (r: UsageHourRow): number => (r.costKnown ? r.cost : 0);
const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);
const zeros = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const cacheShareOf = (input: number, cacheRead: number): number | null =>
  input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null;

function clip(s: number, e: number, [a, b]: Range): Range | undefined {
  const lo = Math.max(s, a);
  const hi = Math.min(e, b);
  return hi > lo ? [lo, hi] : undefined;
}

/** Wall time with at least one range running: overlapping agents count once (паралельність). */
function unionMs(ranges: Range[]): number {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: Range | undefined;
  for (const [s, e] of sorted) {
    if (cur !== undefined && s <= cur[1]) cur[1] = Math.max(cur[1], e);
    else {
      if (cur !== undefined) total += cur[1] - cur[0];
      cur = [s, e];
    }
  }
  return cur === undefined ? total : total + cur[1] - cur[0];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// A local calendar day is numbered like a UTC one: floor(wall clock / DAY). Its midnight goes
// through `zonedInstant`, so a day across a DST change is 23 or 25 hours long.
function midnight(day: number, timeZone: string): number {
  return zonedInstant(new Date(day * DAY).toISOString().slice(0, 10), "00:00", timeZone).getTime();
}
/** Monday = 0. */
function weekdayOf(day: number): number {
  return (new Date(day * DAY).getUTCDay() + 6) % 7;
}

/** The last bucket starting at or before `t`; callers pass `t` within the period. */
function bucketIndex(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Calls `add(bucket, ms)` for each piece of a period-clipped range cut at bucket edges. */
function splitByBucket(starts: number[], to: number, [s, e]: Range, add: (i: number, ms: number) => void): void {
  for (let i = bucketIndex(starts, s); s < e; i++) {
    const end = Math.min(e, i + 1 < starts.length ? starts[i + 1] : to);
    add(i, end - s);
    s = end;
  }
}

/** Calls `add(weekday, hour, ms)` for each piece of a range cut at local hour boundaries. */
function splitByLocalHour(
  [s, e]: Range,
  timeZone: string,
  add: (weekday: number, hour: number, ms: number) => void,
): void {
  while (s < e) {
    // wallMs drops the milliseconds; put them back so the boundary lands on the hour exactly.
    const wall = wallMs(s, timeZone) + (((s % 1000) + 1000) % 1000);
    const end = Math.min(e, s + HOUR - (((wall % HOUR) + HOUR) % HOUR));
    add(weekdayOf(Math.floor(wall / DAY)), new Date(wall).getUTCHours(), end - s);
    s = end;
  }
}

function outcomeOf(s: AnalyticsSessionRow): AnalyticsOutcome {
  if (s.prOpened) return "pr";
  switch (s.status) {
    case "in_review":
      return "pr";
    case "merged":
      return "finished";
    case "queued":
    case "thinking":
    case "tool":
    case "waiting_input":
    case "done":
    case "backlog":
      return "active";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    case "conflict":
      return "conflict";
  }
}

/** Decision 8.3/8.6: dearest first; tokens, then agent time break ties, then the key for a stable order. */
function byWeight<T>(f: (x: T) => { cost: number; tokens: number; workingMs: number; key: string }) {
  return (a: T, b: T): number => {
    const x = f(a);
    const y = f(b);
    return y.cost - x.cost || y.tokens - x.tokens || y.workingMs - x.workingMs || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  };
}

/**
 * The page's whole report (decision 9) for `period` ending at `now`, compared with the period of
 * the same length before it. Rows outside both windows are ignored, so the reader may hand over
 * more than it needs.
 */
export function analyticsReport(input: AnalyticsInput): AnalyticsReport {
  const { period, timeZone } = input;
  const days = ANALYTICS_PERIOD_DAYS[period];
  const to = input.now.getTime();
  const fromDay = Math.floor(wallMs(to, timeZone) / DAY) - (days - 1);
  const from = midnight(fromDay, timeZone);
  const previousFrom = midnight(fromDay - days, timeZone);
  const cur: Range = [from, to];
  const prev: Range = [previousFrom, from];
  const inRange = (iso: string | undefined, [a, b]: Range): boolean => {
    if (iso === undefined) return false;
    const t = Date.parse(iso);
    return t >= a && t < b;
  };

  // Decision 4: the first bucket starts at `from`; by week the others start at local Monday midnight.
  const bucketStarts = (by: "day" | "week"): number[] => {
    const out = [from];
    for (let d = fromDay + 1; d < fromDay + days; d++) {
      if (by === "day" || weekdayOf(d) === 0) out.push(midnight(d, timeZone));
    }
    return out;
  };
  const granularity = days <= DAY_GRANULARITY_MAX_DAYS ? "day" : "week";
  const starts = bucketStarts(granularity);

  const usage = input.usage.filter((r) => inRange(r.hour, cur));
  const prevUsage = input.usage.filter((r) => inRange(r.hour, prev));
  const spans: Span[] = input.spans.map((r) => ({ ...r, s: Date.parse(r.startedAt), e: Date.parse(r.endedAt) }));
  const clipped = (kind: ActivitySpanKind, w: Range): { span: Span; r: Range }[] =>
    spans.flatMap((span) => {
      const r = span.kind === kind ? clip(span.s, span.e, w) : undefined;
      return r === undefined ? [] : [{ span, r }];
    });
  const working = clipped("working", cur);
  const waiting = clipped("waiting", cur);
  const prevWorking = clipped("working", prev);
  const prevWaiting = clipped("waiting", prev);
  const lengthOf = (xs: { r: Range }[]): number => sum(xs, ({ r }) => r[1] - r[0]);

  const created = input.sessions.filter((s) => inRange(s.createdAt, cur));
  const prevCreated = input.sessions.filter((s) => inRange(s.createdAt, prev));
  const prs = input.sessions.filter((s) => inRange(s.prOpenedAt, cur));
  const prevPrs = input.sessions.filter((s) => inRange(s.prOpenedAt, prev));
  const metric = (value: number, prevRows: readonly unknown[], previous: () => number): AnalyticsMetric => ({
    value,
    previous: prevRows.length === 0 ? null : previous(),
  });

  // «Час до PR»: each PR of the period with its way from the session's start. An imported PR
  // time before the session's own start is not a duration and is left out (honest figures only).
  const leads = prs.flatMap((s) => {
    const at = Date.parse(s.prOpenedAt as string);
    const ms = at - Date.parse(s.createdAt);
    return ms >= 0 ? [{ at, ms, estimateMinutes: s.estimateMinutes }] : [];
  });
  // «Оцінка vs факт»: a PR at the very moment of its launch has no ratio, so it needs a lead > 0.
  const estimated = leads.flatMap(({ ms, estimateMinutes }) =>
    estimateMinutes !== undefined && ms > 0 ? [{ ms, estimateMs: estimateMinutes * 60_000 }] : [],
  );
  const leadGranularity = days <= 7 ? "day" : "week";
  const leadStarts = leadGranularity === granularity ? starts : bucketStarts(leadGranularity);
  const leadByBucket: number[][] = leadStarts.map(() => []);
  for (const l of leads) leadByBucket[bucketIndex(leadStarts, l.at)]!.push(l.ms);

  const workingMs = lengthOf(working);
  const wallWorking = unionMs(working.map(({ r }) => r));

  // ── Dynamics ──
  // Spans carry no model or class: a span takes its session's class (the session row, else its
  // usage rows) and the model the session made the most calls with. A session with no usage row
  // has no model, so its agent time stays out of the model split rather than being guessed.
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  const usageClass = new Map<string, AnalyticsSessionClass>();
  const callsByModel = new Map<string, Map<string, number>>();
  for (const r of input.usage) {
    usageClass.set(r.sessionId, r.sessionClass);
    const m = callsByModel.get(r.sessionId) ?? new Map<string, number>();
    m.set(r.model, (m.get(r.model) ?? 0) + r.calls);
    callsByModel.set(r.sessionId, m);
  }
  const mainModel = (sessionId: string): string | undefined => {
    let best: [string, number] | undefined;
    for (const [model, calls] of callsByModel.get(sessionId) ?? []) {
      if (best === undefined || calls > best[1] || (calls === best[1] && model < best[0])) best = [model, calls];
    }
    return best?.[0];
  };
  const series: Record<AnalyticsSplit, Map<string, Bars>> = { model: new Map(), project: new Map(), class: new Map() };
  const bars = (split: AnalyticsSplit, key: string): Bars => {
    let b = series[split].get(key);
    if (b === undefined) {
      const z = (): number[] => starts.map(() => 0);
      b = { cost: z(), tokens: z(), workingMs: z() };
      series[split].set(key, b);
    }
    return b;
  };
  for (const r of usage) {
    const i = bucketIndex(starts, Date.parse(r.hour));
    for (const [split, key] of [["model", r.model], ["project", r.projectId], ["class", r.sessionClass]] as const) {
      const b = bars(split, key);
      b.cost[i] += knownCost(r);
      b.tokens[i] += tokensOf(r);
    }
  }
  const rhythm = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const { span, r } of working) {
    const model = mainModel(span.sessionId);
    const cls = sessionById.get(span.sessionId)?.sessionClass ?? usageClass.get(span.sessionId);
    const targets = [bars("project", span.projectId)];
    if (model !== undefined) targets.push(bars("model", model));
    if (cls !== undefined) targets.push(bars("class", cls));
    splitByBucket(starts, to, r, (i, ms) => {
      for (const b of targets) b.workingMs[i] += ms;
    });
    splitByLocalHour(r, timeZone, (wd, h, ms) => {
      rhythm[wd][h] += ms;
    });
  }
  const total = (b: Bars) => ({ cost: sum(b.cost, (x) => x), tokens: sum(b.tokens, (x) => x), workingMs: sum(b.workingMs, (x) => x) });
  const seriesOf = (split: AnalyticsSplit): AnalyticsSeries[] =>
    [...series[split]]
      .map(([key, b]) => ({ key, ...b, t: { key, ...total(b) } }))
      .sort(byWeight((x) => x.t))
      .map(({ key, cost, tokens, workingMs: w }) => ({ key, cost, tokens, workingMs: w }));

  // ── Outcomes ──
  const agents = created.filter((s) => s.kind === "agent");
  const counts = zeros(ANALYTICS_OUTCOMES);
  let prReworked = 0;
  const workingBySession = new Map<string, Span[]>();
  for (const sp of spans) {
    if (sp.kind !== "working") continue;
    const list = workingBySession.get(sp.sessionId);
    if (list === undefined) workingBySession.set(sp.sessionId, [sp]);
    else list.push(sp);
  }
  for (const s of agents) {
    const o = outcomeOf(s);
    counts[o]++;
    if (o !== "pr" || s.prOpenedAt === undefined) continue;
    const at = Date.parse(s.prOpenedAt);
    if ((workingBySession.get(s.id) ?? []).some((sp) => sp.e > Math.max(sp.s, at))) prReworked++;
  }

  // ── Models ──
  const byModel = new Map<string, UsageHourRow[]>();
  for (const r of usage) {
    const rows = byModel.get(r.model);
    if (rows === undefined) byModel.set(r.model, [r]);
    else rows.push(r);
  }
  const models: AnalyticsModelRow[] = [...byModel]
    .map(([model, rows]) => {
      const calls = sum(rows, (r) => r.calls);
      const priced = rows.filter((r) => r.costKnown);
      const pricedCalls = sum(priced, (r) => r.calls);
      const cost = sum(priced, (r) => r.cost);
      const modelMs = sum(rows, (r) => r.modelMs);
      return {
        model,
        calls,
        tokens: sum(rows, tokensOf),
        cacheShare: cacheShareOf(sum(rows, (r) => r.input), sum(rows, (r) => r.cacheRead)),
        cost,
        costKnown: priced.length === rows.length,
        costPerCall: pricedCalls > 0 ? cost / pricedCalls : null,
        meanModelMs: modelMs > 0 && calls > 0 ? modelMs / calls : null,
      };
    })
    .sort(byWeight((m) => ({ cost: m.cost, tokens: m.tokens, workingMs: 0, key: m.model })));

  // ── Projects ──
  const projectRows = new Map<string, AnalyticsProjectRow>();
  const project = (projectId: string): AnalyticsProjectRow => {
    let p = projectRows.get(projectId);
    if (p === undefined) {
      p = { projectId, sessions: 0, prs: 0, cost: 0, workingMs: 0, waitingMs: 0 };
      projectRows.set(projectId, p);
    }
    return p;
  };
  for (const r of usage) project(r.projectId).cost += knownCost(r);
  for (const { span, r } of working) project(span.projectId).workingMs += r[1] - r[0];
  for (const { span, r } of waiting) project(span.projectId).waitingMs += r[1] - r[0];
  for (const { span } of clipped("queued", cur)) project(span.projectId);
  for (const s of created) project(s.projectId).sessions++;
  for (const s of prs) project(s.projectId).prs++;
  const projects = [...projectRows.values()].sort(
    byWeight((p) => ({ cost: p.cost, tokens: 0, workingMs: p.workingMs, key: p.projectId })),
  );

  // ── Top sessions ──
  const bySession = new Map<string, AnalyticsTopSession>();
  for (const r of usage) {
    let t = bySession.get(r.sessionId);
    if (t === undefined) {
      const row = sessionById.get(r.sessionId);
      t = {
        sessionId: r.sessionId,
        projectId: row?.projectId ?? r.projectId,
        ...(row === undefined ? {} : { name: row.name }),
        sessionClass: row?.sessionClass ?? r.sessionClass,
        cost: 0,
        tokens: 0,
        costKnown: true,
      };
      bySession.set(r.sessionId, t);
    }
    t.cost += knownCost(r);
    t.tokens += tokensOf(r);
    if (!r.costKnown) t.costKnown = false;
  }
  const topSessions = [...bySession.values()]
    .sort(byWeight((t) => ({ cost: t.cost, tokens: t.tokens, workingMs: 0, key: t.sessionId })))
    .slice(0, TOP_SESSIONS);

  // ── Посіпака and findings ──
  const minion = zeros(MINION_OUTCOMES);
  for (const s of created) if (s.sessionClass === "minion" && s.minionOutcome !== undefined) minion[s.minionOutcome]++;
  const testerRuns = created.filter((s) => s.sessionClass === "tester");
  const tester = { runs: testerRuns.length, tasks: new Set(testerRuns.map((s) => s.parentSessionId ?? s.id)).size };
  const byKind = zeros(FINDING_KINDS);
  const byStatus = zeros(FINDING_STATUSES);
  for (const f of input.findings) {
    if (!inRange(f.createdAt, cur)) continue;
    byKind[f.kind]++;
    byStatus[f.status]++;
  }

  return {
    period,
    timeZone,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    previousFrom: new Date(previousFrom).toISOString(),
    granularity,
    coverage: {
      ...(input.ledgerStartedAt === undefined ? {} : { ledgerStartedAt: input.ledgerStartedAt }),
      import: input.import,
      sessionsWithoutHistory: created.filter((s) => s.noHistory).length,
      unpricedTokens: sum(
        usage.filter((r) => !r.costKnown),
        tokensOf,
      ),
    },
    tiles: {
      cost: metric(sum(usage, knownCost), prevUsage, () => sum(prevUsage, knownCost)),
      tokens: metric(sum(usage, tokensOf), prevUsage, () => sum(prevUsage, tokensOf)),
      cacheShare: cacheShareOf(sum(usage, (r) => r.input), sum(usage, (r) => r.cacheRead)),
      workingMs: metric(workingMs, prevWorking, () => lengthOf(prevWorking)),
      parallelism: wallWorking > 0 ? workingMs / wallWorking : null,
      waitingMs: metric(lengthOf(waiting), prevWaiting, () => lengthOf(prevWaiting)),
      waitMedianMs: median(spans.filter((s) => s.kind === "waiting" && s.e >= from && s.e < to).map((s) => s.e - s.s)),
      sessions: metric(created.length, prevCreated, () => prevCreated.length),
      prs: metric(prs.length, prevPrs, () => prevPrs.length),
      costPerPr: prs.length > 0 ? sum(prs, (s) => s.lifetimeCost) / prs.length : null,
      prLeadMedianMs: median(leads.map((l) => l.ms)),
    },
    dynamics: {
      buckets: starts.map((t) => new Date(t).toISOString()),
      series: { model: seriesOf("model"), project: seriesOf("project"), class: seriesOf("class") },
      prLead: {
        granularity: leadGranularity,
        buckets: leadStarts.map((t) => new Date(t).toISOString()),
        medianMs: leadByBucket.map(median),
        counts: leadByBucket.map((xs) => xs.length),
      },
    },
    rhythm,
    outcomes: { counts, total: agents.length, prReworked },
    models,
    projects,
    topSessions,
    minion,
    tester,
    estimate: {
      prs: leads.length,
      estimated: estimated.length,
      estimateMedianMs: median(estimated.map((e) => e.estimateMs)),
      leadMedianMs: median(estimated.map((e) => e.ms)),
      ratioMedian: median(estimated.map((e) => e.estimateMs / e.ms)),
    },
    findings: { byKind, byStatus },
  };
}
