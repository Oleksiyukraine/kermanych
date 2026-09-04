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
