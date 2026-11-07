// «Аналітика» (docs/specs/2026-11-07-developer-analytics.md): the page's decisions that can be
// wrong, as pure functions — apps/ui has no component tests (scope.ts:1-3), so the scope rule,
// the «інші» fold, the delta and the shaping of every figure live here and are covered by
// test/analytics.spec.ts. Every number arrives in the core `AnalyticsReport`; this module only
// picks which of it to draw and how it reads.
import type { CloudProject } from '@kermanych/cloud';
import type { AnalyticsMetric, AnalyticsReport, AnalyticsSeries } from '@kermanych/core';
import { sessionScopedProjectIds, type ScopeInput } from './scope';
import { usd } from './format';
import type { TimeLabel } from './time';

// ── Scope (decision 3) ─────────────────────────────────────────────────────────

/**
 * The `projectIds` the report is asked for. A project selection is that project; a workspace
 * selection is its projects that are ON THIS MACHINE (`localProjectIds`, the registry's rows),
 * by the same workspace rule the Агенти page uses (lib/scope.ts `sessionScopedProjectIds`, cloud
 * list once read, the cached map before); nothing selected is `undefined` — every project on
 * this machine, local-only ones included. Unlike Агенти, «nothing» is a real scope here, not a
 * blank invitation: the ledger is this machine's, and «everything» is its natural total.
 *
 * A workspace with none of its projects here is `[]`, which the api answers with an empty
 * report — never widened to «everything».
 */
export function analyticsProjectIds(
  scope: ScopeInput,
  cloud: { projects: CloudProject[]; listRead: boolean },
  projectWorkspace: Record<string, string>,
  localProjectIds: readonly string[],
): string[] | undefined {
  if (scope.projectId) return [scope.projectId];
  if (!scope.workspaceId) return undefined;
  const local = new Set(localProjectIds);
  return sessionScopedProjectIds({ workspaceId: scope.workspaceId }, cloud, projectWorkspace).filter((id) =>
    local.has(id),
  );
}

// ── «Динаміка» (decision 8.3) ──────────────────────────────────────────────────

export const ANALYTICS_METRICS = ['cost', 'tokens', 'workingMs'] as const;
export type AnalyticsMetricKey = (typeof ANALYTICS_METRICS)[number];

export function isAnalyticsMetricKey(v: string): v is AnalyticsMetricKey {
  return (ANALYTICS_METRICS as readonly string[]).includes(v);
}

/** Up to this many series keep their own colour; the rest fold into «інші». */
export const ANALYTICS_MAX_SERIES = 8;
/** The folded series' key — cannot collide with a model id, a project uuid or a session class. */
export const ANALYTICS_OTHERS = '@others';

export type FoldedSeries = {
  key: string;
  /** One value per bucket, in the report's `buckets` order. */
  values: number[];
  /** The report series this one stands for: itself, or every series folded into «інші». */
  members: string[];
};

function total(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum;
}

/** One series as the bars draw it: a folded series, named, coloured, and on or off in the legend. */
export type AnalyticsBarSeries = { key: string; label: string; color: string; values: number[]; off: boolean };

/**
 * The series one metric draws: ranked by that metric's total over the period, the top
 * `max` kept, the rest summed bucket by bucket into «інші». Ranked per metric because the
 * biggest spender is not the longest runner — a fold by cost would hide the model that did
 * most of the hours. A series with nothing in this metric is dropped: a legend key for a
 * zero is a key that toggles nothing. Ties break on the key, so the order holds between polls.
 */
export function foldSeries(
  series: readonly AnalyticsSeries[],
  metric: AnalyticsMetricKey,
  max: number = ANALYTICS_MAX_SERIES,
): FoldedSeries[] {
  const ranked = series
    .map((s) => ({ key: s.key, values: s[metric], sum: total(s[metric]) }))
    .filter((s) => s.sum > 0)
    .sort((a, b) => b.sum - a.sum || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const kept: FoldedSeries[] = ranked.slice(0, max).map((s) => ({ key: s.key, values: [...s.values], members: [s.key] }));
  const rest = ranked.slice(max);
  if (!rest.length) return kept;
  const values = rest[0]!.values.map(() => 0);
  for (const s of rest) s.values.forEach((v, i) => (values[i] = (values[i] ?? 0) + v));
  kept.push({ key: ANALYTICS_OTHERS, values, members: rest.map((s) => s.key) });
  return kept;
}

// The categorical palette of components/capacity/CapacityChart.vue, token-derived so it holds
// on both canvases: the three status hues first, then mixes so neighbours never share a hue.
// Eight entries — exactly ANALYTICS_MAX_SERIES — and «інші» keeps the muted swatch, so a folded
// remainder never reads as one more model.
export const ANALYTICS_PALETTE = [
  'var(--k-accent)',
  'var(--k-success)',
  'var(--k-warning)',
  'color-mix(in srgb, var(--k-accent) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-success) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-warning) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-accent) 50%, var(--k-success))',
  'color-mix(in srgb, var(--k-warning) 50%, var(--k-success))',
] as const;
export const ANALYTICS_OTHERS_COLOR = 'var(--k-muted)';

export function seriesColor(key: string, index: number): string {
  return key === ANALYTICS_OTHERS ? ANALYTICS_OTHERS_COLOR : ANALYTICS_PALETTE[index % ANALYTICS_PALETTE.length]!;
}

/**
 * The top of the Y axis: the tallest bar rounded up to 1, 2 or 5 × 10ⁿ in the metric's own
 * unit — dollars, tokens, and for agent time hours (minutes below an hour), so the half-way
 * tick reads «1 год», not «1 год 23 хв». Never 0: an empty plot still needs a scale.
 */
export function axisMax(max: number, metric: AnalyticsMetricKey): number {
  const unit = metric === 'workingMs' ? (max >= 3_600_000 ? 3_600_000 : 60_000) : 1;
  const v = max / unit;
  if (!(v > 0)) return unit;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 5, 10].find((m) => m * mag >= v - 1e-9)!;
  // Dollar and token axes below one unit keep their fraction; time does not go below a minute.
  return Math.max(step * mag * unit, metric === 'workingMs' ? unit : 0);
}

// ── Headline tiles (decision 8.2) ──────────────────────────────────────────────

export type MetricDelta = { direction: 'up' | 'down' | 'flat'; percent: number };

/**
 * The change against the previous period of the same length. Nothing — not «+∞%», not «0%» —
 * when that period holds no data (`previous` null) or its figure is 0: a percentage of nothing
 * is not a figure (decision 4, «nothing when the previous period has no data»).
 */
export function metricDelta(m: AnalyticsMetric): MetricDelta | null {
  if (m.previous === null || m.previous === 0) return null;
  const percent = Math.round(((m.value - m.previous) / Math.abs(m.previous)) * 100);
  return { direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat', percent: Math.abs(percent) };
}

/** The period holds nothing at all: the page says «Немає даних за цей період» (decision 7). */
export function reportIsEmpty(r: AnalyticsReport): boolean {
  const t = r.tiles;
  const figures = [t.cost.value, t.tokens.value, t.workingMs.value, t.waitingMs.value, t.sessions.value, t.prs.value];
  return (
    figures.every((v) => v === 0) &&
    r.coverage.unpricedTokens === 0 &&
    r.outcomes.total === 0 &&
    r.topSessions.length === 0 &&
    total(Object.values(r.minion)) === 0 &&
    total(Object.values(r.findings.byStatus)) === 0
  );
}

// ── Figures ────────────────────────────────────────────────────────────────────

/**
 * Dollars. lib/format `usd`, whose empty string for 0 is right on a card strip and wrong
 * here: a tile or a table cell of known spend that is nothing IS `$0.00`.
 */
export function money(n: number): string {
  return usd(n) || '$0.00';
}

/** A share 0–1 as a whole percent; a real but tiny share is `<1%`, never `0%`. */
export function share(n: number): string {
  const p = n * 100;
  if (p >= 1 || p === 0) return `${Math.round(p)}%`;
  return '<1%';
}

/** Паралельність, «×2,4» — one decimal in the operator's locale. */
export function parallelism(n: number, locale: string): string {
  return `×${n.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

/**
 * A summed duration — agent time over a week reaches tens of hours, past what lib/time `dur`
 * (seconds, then minutes) is built for. Same catalog keys (`common.time.*`), rendered through
 * lib/time `renderTime`: seconds, minutes, then hours with their minutes while those still
 * matter (under 10 h), whole hours above. No days: «2 дн» of working time would read as
 * calendar days, which is not what was summed.
 */
export function duration(ms: number): TimeLabel {
  if (ms <= 0) return { key: 'common.time.minutes', params: { n: 0 } };
  if (ms < 1000) return { key: 'common.time.durShort', params: { n: 0 } };
  const s = Math.round(ms / 1000);
  if (s < 60) return { key: 'common.time.seconds', params: { n: s } };
  const min = Math.round(s / 60);
  if (min < 60) return { key: 'common.time.minutes', params: { n: min } };
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 10) return { key: 'common.time.hours', params: { n: Math.round(min / 60) } };
  return m === 0 ? { key: 'common.time.hours', params: { n: h } } : { key: 'common.time.hoursMinutes', params: { n: h, m } };
}

function zoneParts(iso: string, timeZone: string): { day: string; month: string; year: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(
    new Date(iso),
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: get('day'), month: get('month'), year: get('year') };
}

/**
 * A bucket's axis label in the report's zone: the day of month by day, `DD.MM` by week — the
 * CapacityChart form. The bucket start is an instant (local midnight in that zone), so it is
 * read back in the same zone; in UTC it would print the previous day east of Greenwich.
 */
export function bucketLabel(iso: string, timeZone: string, granularity: 'day' | 'week'): string {
  const p = zoneParts(iso, timeZone);
  return granularity === 'day' ? p.day : `${p.day}.${p.month}`;
}

/** The house date, `20.09.2026`, of an instant read in `timeZone`. */
export function zoneDate(iso: string, timeZone: string): string {
  const p = zoneParts(iso, timeZone);
  return `${p.day}.${p.month}.${p.year}`;
}

/** A date for a sentence, «7 листопада» / «7 November», in the operator's locale. */
export function longDate(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'long' }).format(new Date(iso));
}

// ── «Ритм тижня» (decision 8.4) ────────────────────────────────────────────────

/** Heat levels, as RiskMatrix's bands: 0 is an empty cell, 4 the busiest hour of the week. */
export const HEAT_LEVELS = 4;

export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(HEAT_LEVELS, Math.max(1, Math.ceil((value / max) * HEAT_LEVELS)));
}

export function rhythmMax(rhythm: readonly (readonly number[])[]): number {
  let max = 0;
  for (const row of rhythm) for (const v of row) if (v > max) max = v;
  return max;
}
