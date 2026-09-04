// Team Capacity's arithmetic, pure. Two consumers read it and must agree number for number:
// pages/ManagementCapacityPage.vue (chart + table) and stores/management-chat.ts (the digest
// the assistant answers from). Everything a screen or a prompt line shows is derived here.
//
// The units are Jira's: `*Seconds` on issues, `seconds` on worklogs. The baseline is the
// one thing Jira does not have — DEFAULT_HOURS_PER_DAY per person per business day — and
// it is an option so a later per-member table can feed it without touching the maths.
//
// Dates are YYYY-MM-DD strings and go through lib/calendar.ts for arithmetic: a parsed
// `Date` of such a string is UTC midnight, which is yesterday for half of Europe.
import { isoOf, isoParts, shiftDays, shiftMonths, todayIso } from './calendar';
import type { JiraIssue, JiraStatusCategory, JiraWorklog } from '@kermanych/cloud';
import { UNASSIGNED } from './jira-view';

export const DEFAULT_HOURS_PER_DAY = 8;
// Up to a month reads day by day; longer than that a bar per day is noise, so weeks.
export const DAY_GRANULARITY_MAX_DAYS = 31;
// A guard on `eachDay`, not a product limit: a range that long would be a bug upstream.
const MAX_RANGE_DAYS = 366 * 3;

export type CapacityRange = { from: string; to: string };
export type CapacityGranularity = 'day' | 'week';

// 0 = Monday … 6 = Sunday, the Ukrainian week (WEEKDAY_KEYS in lib/calendar.ts).
function weekday(iso: string): number {
  const p = isoParts(iso);
  if (!p) return 0;
  return (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
}

export function isBusinessDay(iso: string): boolean {
  return weekday(iso) < 5;
}

/** Every day from `from` to `to`, inclusive. Empty for a reversed or malformed pair —
 *  `shiftDays` returns a malformed input unchanged, which would loop forever. */
export function eachDay(from: string, to: string): string[] {
  if (!isoParts(from) || !isoParts(to)) return [];
  const out: string[] = [];
  for (let d = from; d <= to && out.length < MAX_RANGE_DAYS; d = shiftDays(d, 1)) out.push(d);
  return out;
}

export function businessDays(from: string, to: string): string[] {
  return eachDay(from, to).filter(isBusinessDay);
}

export function weekMonday(iso: string): string {
  return shiftDays(iso, -weekday(iso));
}

export function normalizeRange(r: CapacityRange): CapacityRange {
  return r.from <= r.to ? r : { from: r.to, to: r.from };
}

export function defaultGranularity(r: CapacityRange): CapacityGranularity {
  return eachDay(r.from, r.to).length <= DAY_GRANULARITY_MAX_DAYS ? 'day' : 'week';
}

export const CAPACITY_PRESETS = ['thisWeek', 'nextWeek', 'next2Weeks', 'thisMonth', 'nextMonth', 'last2Weeks'] as const;
export type CapacityPreset = (typeof CAPACITY_PRESETS)[number];

/** The toolbar's presets, resolved against the operator's own today. */
export function presetRange(preset: CapacityPreset, today: string): CapacityRange {
  const monday = weekMonday(today);
  // `today` comes from todayIso() and is always well-formed; the fallback only keeps the
  // function total.
  const p = isoParts(today) ?? { year: 1970, month: 1, day: 1 };
  const monthStart = isoOf({ year: p.year, month: p.month, day: 1 });
  const lastOfMonth = (first: string) => shiftDays(shiftMonths(first, 1), -1);
  switch (preset) {
    case 'thisWeek':
      return { from: monday, to: shiftDays(monday, 6) };
    case 'nextWeek':
      return { from: shiftDays(monday, 7), to: shiftDays(monday, 13) };
    case 'next2Weeks':
      return { from: today, to: shiftDays(today, 13) };
    case 'thisMonth':
      return { from: monthStart, to: lastOfMonth(monthStart) };
    case 'nextMonth': {
      const next = shiftMonths(monthStart, 1);
      return { from: next, to: lastOfMonth(next) };
    }
    case 'last2Weeks':
      return { from: shiftDays(today, -14), to: shiftDays(today, -1) };
  }
}

export type CapacityPeriod = {
  // The day itself, or the week's Monday — what the digest and the chart key on.
  key: string;
  from: string;
  to: string;
  // Business days of this period INSIDE the range: a range starting on Thursday credits
  // its first week two days, not five.
  businessDays: number;
  // Wholly before today — the chart draws these as logged time, the rest as plan.
  past: boolean;
};

export function capacityPeriods(range: CapacityRange, granularity: CapacityGranularity, today: string): CapacityPeriod[] {
  const days = eachDay(range.from, range.to);
  if (granularity === 'day')
    return days.map((d) => ({ key: d, from: d, to: d, businessDays: isBusinessDay(d) ? 1 : 0, past: d < today }));
  const weeks = new Map<string, string[]>();
  for (const d of days) {
    const k = weekMonday(d);
    const list = weeks.get(k);
    if (list) list.push(d);
    else weeks.set(k, [d]);
  }
  return [...weeks].map(([key, ds]) => ({
    key,
    from: ds[0]!,
    to: ds[ds.length - 1]!,
    businessDays: ds.filter(isBusinessDay).length,
    past: ds[ds.length - 1]! < today,
  }));
}

// Re-exported so the page and the store import one module for "capacity today".
export { todayIso };

export type CapacityFlag = 'overdue' | 'unscheduled' | 'unestimated';

/** What is left to do on an issue. Jira keeps `remaining` itself once anything is logged;
 *  before that it may be blank, so original − spent is the fallback, floored at zero. */
export function remainingSeconds(issue: JiraIssue): number {
  if (issue.remainingEstimateSeconds > 0) return issue.remainingEstimateSeconds;
  return Math.max(issue.originalEstimateSeconds - issue.timeSpentSeconds, 0);
}

export type IssuePlan = { remaining: number; days: string[]; flag?: CapacityFlag };

/**
 * Where an open issue's remaining estimate lands on the calendar:
 *   - evenly over the business days from max(startDate, today) to dueDate;
 *   - a window with no business day (due on a weekend, start after due) collapses to the
 *     due date rather than vanishing;
 *   - overdue → all of it on today, which is what «overdue» looks like on a capacity chart;
 *   - no due date → nowhere (flag `unscheduled`): the screen counts these loudly, because
 *     undated estimated work is the main reason a capacity view under-reports;
 *   - nothing left → flag `unestimated`.
 */
export function planIssue(issue: JiraIssue, today: string): IssuePlan {
  const remaining = remainingSeconds(issue);
  if (remaining <= 0) return { remaining: 0, days: [], flag: 'unestimated' };
  if (!isoParts(issue.dueDate)) return { remaining, days: [], flag: 'unscheduled' };
  if (issue.dueDate < today) return { remaining, days: [today], flag: 'overdue' };
  const start = isoParts(issue.startDate) && issue.startDate > today ? issue.startDate : today;
  const days = businessDays(start, issue.dueDate);
  return { remaining, days: days.length ? days : [issue.dueDate] };
}

export type CapacityPerson = { id: string; name: string; avatar?: string };

export type CapacityCell = {
  capacitySeconds: number;
  plannedSeconds: number;
  loggedSeconds: number;
  // planned + logged — the bar.
  loadSeconds: number;
  // load / capacity; 0 when there is no capacity (weekend, unassigned bucket).
  utilization: number;
};

export type CapacityIssueRow = {
  key: string;
  summary: string;
  person: CapacityPerson;
  statusName: string;
  statusCategory: JiraStatusCategory;
  startDate: string;
  dueDate: string;
  remainingSeconds: number;
  originalSeconds: number;
  spentSeconds: number;
  // The part of the remaining estimate that lands inside the range.
  inRangeSeconds: number;
  flag?: CapacityFlag;
};

export type CapacityOptions = {
  range: CapacityRange;
  // Caller-supplied, as todayIso() everywhere else: the maths must be testable on a fixed day.
  today: string;
  hoursPerDay?: number;
  granularity?: CapacityGranularity;
  // An assignee's accountId (or UNASSIGNED): restrict the whole report to one person.
  person?: string;
};

export type CapacityReport = {
  range: CapacityRange;
  granularity: CapacityGranularity;
  hoursPerDay: number;
  periods: CapacityPeriod[];
  // Load descending, UNASSIGNED last.
  persons: CapacityPerson[];
  // person.id → one cell per period.
  cells: Record<string, CapacityCell[]>;
  // Per period, everybody.
  totals: CapacityCell[];
  // Whole range, everybody.
  summary: CapacityCell;
  // Open issues that land inside the range, plus every flagged one; flagged first, then by due.
  issues: CapacityIssueRow[];
  unscheduled: CapacityIssueRow[];
  overdue: CapacityIssueRow[];
};

function cellOf(capacity: number, planned: number, logged: number): CapacityCell {
  const load = Math.round(planned + logged);
  return {
    capacitySeconds: capacity,
    plannedSeconds: Math.round(planned),
    loggedSeconds: Math.round(logged),
    loadSeconds: load,
    utilization: capacity > 0 ? load / capacity : 0,
  };
}

export function sumCells(cells: readonly CapacityCell[]): CapacityCell {
  let cap = 0;
  let planned = 0;
  let logged = 0;
  for (const c of cells) {
    cap += c.capacitySeconds;
    planned += c.plannedSeconds;
    logged += c.loggedSeconds;
  }
  return cellOf(cap, planned, logged);
}

// A worklog's calendar day in the OPERATOR's zone: `startedAt` is an instant, and the day
// a person logged against is the day on their own wall calendar.
function localDay(instant: string): string {
  const ms = Date.parse(instant);
  return Number.isNaN(ms) ? '' : todayIso(ms);
}

export function capacityReport(
  issues: readonly JiraIssue[],
  worklogs: readonly JiraWorklog[],
  opts: CapacityOptions,
): CapacityReport {
  const range = normalizeRange(opts.range);
  const hoursPerDay = opts.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const granularity = opts.granularity ?? defaultGranularity(range);
  const periods = capacityPeriods(range, granularity, opts.today);
  const dayIndex = new Map<string, number>();
  periods.forEach((p, i) => {
    for (const d of eachDay(p.from, p.to)) dayIndex.set(d, i);
  });

  const persons = new Map<string, CapacityPerson>();
  const planned = new Map<string, number[]>();
  const logged = new Map<string, number[]>();
  const include = (id: string) => !opts.person || id === opts.person;
  const register = (id: string, name: string, avatar?: string) => {
    const known = persons.get(id);
    if (!known) persons.set(id, { id, name, ...(avatar ? { avatar } : {}) });
    else if (!known.name && name) known.name = name;
  };
  const add = (map: Map<string, number[]>, id: string, i: number, seconds: number) => {
    const arr = map.get(id) ?? periods.map(() => 0);
    arr[i] = (arr[i] ?? 0) + seconds;
    map.set(id, arr);
  };

  // Everyone assigned anything on the board is on the team: an assignee with nothing due
  // this fortnight still has the fortnight's capacity, and a team total that forgot them
  // would read as fuller than it is.
  for (const issue of issues) {
    if (issue.assigneeAccountId && include(issue.assigneeAccountId))
      register(issue.assigneeAccountId, issue.assigneeName ?? '', issue.assigneeAvatar);
  }

  const rows: CapacityIssueRow[] = [];
  for (const issue of issues) {
    if (issue.statusCategory === 'done') continue;
    const id = issue.assigneeAccountId || UNASSIGNED;
    if (!include(id)) continue;
    const plan = planIssue(issue, opts.today);
    let inRange = 0;
    if (plan.days.length) {
      const perDay = plan.remaining / plan.days.length;
      for (const d of plan.days) {
        const i = dayIndex.get(d);
        if (i === undefined) continue;
        add(planned, id, i, perDay);
        inRange += perDay;
      }
    }
    if (inRange === 0 && !plan.flag) continue;
    register(id, issue.assigneeName ?? '', issue.assigneeAvatar);
    rows.push({
      key: issue.key,
      summary: issue.summary,
      person: persons.get(id)!,
      statusName: issue.statusName,
      statusCategory: issue.statusCategory,
      startDate: issue.startDate,
      dueDate: issue.dueDate,
      remainingSeconds: plan.remaining,
      originalSeconds: issue.originalEstimateSeconds,
      spentSeconds: issue.timeSpentSeconds,
      inRangeSeconds: Math.round(inRange),
      ...(plan.flag ? { flag: plan.flag } : {}),
    });
  }

  for (const w of worklogs) {
    const id = w.authorAccountId || UNASSIGNED;
    if (!include(id)) continue;
    const i = dayIndex.get(localDay(w.startedAt));
    if (i === undefined) continue;
    register(id, w.authorName, w.authorAvatar);
    add(logged, id, i, w.seconds);
  }

  const capacityOf = (p: CapacityPeriod) => p.businessDays * hoursPerDay * 3600;
  const ids = [...persons.keys()];
  const withCapacity = ids.filter((id) => id !== UNASSIGNED).length;
  const cells: Record<string, CapacityCell[]> = {};
  for (const id of ids)
    cells[id] = periods.map((p, i) =>
      // The unassigned bucket is load with nobody's hours behind it.
      cellOf(id === UNASSIGNED ? 0 : capacityOf(p), planned.get(id)?.[i] ?? 0, logged.get(id)?.[i] ?? 0),
    );
  const totals = periods.map((p, i) =>
    cellOf(
      withCapacity * capacityOf(p),
      ids.reduce((s, id) => s + (planned.get(id)?.[i] ?? 0), 0),
      ids.reduce((s, id) => s + (logged.get(id)?.[i] ?? 0), 0),
    ),
  );

  const loadOf = (id: string) => sumCells(cells[id]!).loadSeconds;
  const sorted = ids
    .map((id) => persons.get(id)!)
    .sort(
      (a, b) =>
        Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED) ||
        loadOf(b.id) - loadOf(a.id) ||
        a.name.localeCompare(b.name),
    );
  rows.sort(
    (a, b) =>
      Number(!a.flag) - Number(!b.flag) ||
      (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') ||
      a.key.localeCompare(b.key),
  );

  return {
    range,
    granularity,
    hoursPerDay,
    periods,
    persons: sorted,
    cells,
    totals,
    summary: sumCells(totals),
    issues: rows,
    unscheduled: rows.filter((r) => r.flag === 'unscheduled'),
    overdue: rows.filter((r) => r.flag === 'overdue'),
  };
}
