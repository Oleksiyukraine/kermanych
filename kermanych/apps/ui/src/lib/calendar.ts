// Calendar arithmetic for KDateField, plus the two conversions between what a date column
// holds (`YYYY-MM-DD`) and what a Ukrainian keyboard types (`20.09.2026`).
//
// Every function here works on the Y-M-D TRIPLE, never on a parsed local `Date` of the
// string: `new Date('2026-09-20')` is UTC midnight, which prints as the 19th for half of
// Europe, and that is how a deadline lands a day early. Where arithmetic needs a real date
// object it is built and read through `Date.UTC` / `getUTC*`, where no zone exists to drift.
//
// Pure by design — apps/ui has no component tests, so the month grid, the roll-over and the
// clamping live here and are covered by test/calendar.spec.ts.

/** Monday-first, the Ukrainian week. The grid below is built in this order; the labels live
 *  in the catalog under `common.calendar.weekday.*` and the caller renders them. */
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// Nominative: the header stands alone («Вересень 2026»), it is not a date being read out.
// Keys, not words — the month name lives in the catalog (`common.calendar.month.*`) and
// follows the active locale.
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

// A leading `YYYY-MM-DD` — a full timestamp is accepted because `raisedAt`-style columns are
// read by the same formatter as the date-only ones.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
// What people type. Dots are the Ukrainian separator; slashes and dashes are accepted because
// a keyboard's numeric block makes `/` cheaper than `.` and nobody should have to care.
const TYPED_RE = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/;

/** Month is 1–12, the way it is written, not the way `Date` counts it. */
export type IsoParts = { year: number; month: number; day: number };

export type CalendarCell = {
  iso: string;
  day: number;
  /** False for the leading/trailing days that belong to the neighbouring months. */
  inMonth: boolean;
};

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function isoOf(p: IsoParts): string {
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The triple behind a date string, or `undefined` when there is none. Rejects a
 * well-shaped impossibility — `2026-02-31` matches the pattern and is not a day.
 */
export function isoParts(value: string | undefined): IsoParts | undefined {
  const m = value ? ISO_RE.exec(value) : null;
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

/** The house date format, `20.09.2026`. Empty string for anything unparseable — a FIELD
 *  shows nothing when it holds nothing; the em dash belongs to read-only cells. */
export function formatIsoDate(value: string | undefined): string {
  const p = isoParts(value);
  return p ? `${pad(p.day)}.${pad(p.month)}.${p.year}` : '';
}

/**
 * A typed date as ISO, or `undefined` while it is not a date yet. Both directions are
 * accepted (`20.09.2026` and `2026-09-20`) so a pasted column value is not rejected by the
 * field that displays the other form.
 */
export function parseTypedDate(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const typed = TYPED_RE.exec(text);
  if (typed) {
    const iso = isoOf({ year: Number(typed[3]), month: Number(typed[2]), day: Number(typed[1]) });
    return isoParts(iso) ? iso : undefined;
  }
  const p = isoParts(text);
  return p ? isoOf(p) : undefined;
}

/** Today in the user's OWN calendar, as the same `YYYY-MM-DD` the columns hold. */
export function todayIso(nowMs: number): string {
  const d = new Date(nowMs);
  return isoOf({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
}

/** `iso` moved by whole days, rolling over months and years. Invalid input is returned
 *  unchanged: the caller's model is not this function's to repair. */
export function shiftDays(iso: string, days: number): string {
  const p = isoParts(iso);
  if (!p) return iso;
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return isoOf({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
}

/**
 * `iso` moved by whole months, with the day CLAMPED to the target month's length: 31 January
 * plus one month is 28 February, not 3 March. Rolling over would silently skip the month the
 * user asked for, which on a month-stepping calendar is the one thing they were watching.
 */
export function shiftMonths(iso: string, months: number): string {
  const p = isoParts(iso);
  if (!p) return iso;
  const zero = p.month - 1 + months;
  const year = p.year + Math.floor(zero / 12);
  const month = ((zero % 12) + 12) % 12 + 1;
  return isoOf({ year, month, day: Math.min(p.day, daysInMonth(year, month)) });
}

/** The catalog key of a month's nominative name; the caller pairs it with the year through
 *  `common.calendar.monthTitle`. Month is 1–12, the way it is written. */
export function monthNameKey(month: number): string {
  return `common.calendar.month.${MONTH_KEYS[month - 1]}`;
}

/**
 * The six-week grid a month is drawn on: 42 cells, Monday first, the neighbouring months
 * filling both ends. Always six rows — a grid that grows and shrinks with the month makes
 * the popup jump between February and August, and the footer move with it.
 */
export function monthGrid(year: number, month: number): CalendarCell[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  // getUTCDay() is Sunday-first (0); shift it into a Monday-first offset.
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    const cellMonth = d.getUTCMonth() + 1;
    cells.push({
      iso: isoOf({ year: d.getUTCFullYear(), month: cellMonth, day: d.getUTCDate() }),
      day: d.getUTCDate(),
      inMonth: cellMonth === month && d.getUTCFullYear() === year,
    });
  }
  return cells;
}
