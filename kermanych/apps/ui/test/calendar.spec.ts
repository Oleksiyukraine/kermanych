import { describe, expect, it } from 'vitest';
import {
  WEEKDAY_LABELS,
  formatIsoDate,
  isoParts,
  monthGrid,
  monthTitle,
  parseTypedDate,
  shiftDays,
  shiftMonths,
  todayIso,
} from '../src/lib/calendar';

// The register's date columns are calendar answers, so every case here is one a timezone
// could otherwise steal: a date at the edge of a month, a leap day, a value typed the way a
// Ukrainian keyboard types it.
describe('isoParts', () => {
  it('reads the triple out of a date column and a full timestamp', () => {
    expect(isoParts('2026-09-20')).toEqual({ year: 2026, month: 9, day: 20 });
    expect(isoParts('2026-09-20T23:30:00.000Z')).toEqual({ year: 2026, month: 9, day: 20 });
  });

  it('rejects a well-shaped impossibility', () => {
    expect(isoParts('2026-02-31')).toBeUndefined();
    expect(isoParts('2026-13-01')).toBeUndefined();
    expect(isoParts('2026-00-10')).toBeUndefined();
    expect(isoParts('20.09.2026')).toBeUndefined();
    expect(isoParts('')).toBeUndefined();
    expect(isoParts(undefined)).toBeUndefined();
  });

  it('accepts the leap day only in a leap year', () => {
    expect(isoParts('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(isoParts('2027-02-29')).toBeUndefined();
  });
});

describe('formatIsoDate', () => {
  it('prints the house format', () => {
    expect(formatIsoDate('2026-09-20')).toBe('20.09.2026');
    expect(formatIsoDate('2026-01-05')).toBe('05.01.2026');
  });

  it('prints nothing for nothing — a field is empty, it does not hold an em dash', () => {
    expect(formatIsoDate(undefined)).toBe('');
    expect(formatIsoDate('')).toBe('');
    expect(formatIsoDate('невідомо')).toBe('');
  });
});

describe('parseTypedDate', () => {
  it('takes the typed form, separator-agnostic', () => {
    expect(parseTypedDate('20.09.2026')).toBe('2026-09-20');
    expect(parseTypedDate('5.1.2026')).toBe('2026-01-05');
    expect(parseTypedDate('20/09/2026')).toBe('2026-09-20');
    expect(parseTypedDate(' 20-09-2026 ')).toBe('2026-09-20');
  });

  it('takes a pasted column value as it stands', () => {
    expect(parseTypedDate('2026-09-20')).toBe('2026-09-20');
  });

  it('holds back while the text is not a date yet', () => {
    expect(parseTypedDate('20.09')).toBeUndefined();
    expect(parseTypedDate('20.09.20')).toBeUndefined();
    expect(parseTypedDate('31.02.2026')).toBeUndefined();
    expect(parseTypedDate('')).toBeUndefined();
  });
});

describe('todayIso', () => {
  it('answers in the user’s own calendar, not in UTC', () => {
    // Local 09:00 — the same day everywhere the app runs.
    expect(todayIso(Date.parse('2026-01-05T09:00:00'))).toBe('2026-01-05');
  });
});

describe('shiftDays', () => {
  it('rolls over months and years', () => {
    expect(shiftDays('2026-09-20', 1)).toBe('2026-09-21');
    expect(shiftDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDays('2026-09-20', 7)).toBe('2026-09-27');
  });

  it('crosses a leap day without losing one', () => {
    expect(shiftDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('leaves an unparseable value alone', () => {
    expect(shiftDays('', 1)).toBe('');
  });
});

describe('shiftMonths', () => {
  it('steps whole months', () => {
    expect(shiftMonths('2026-09-20', 1)).toBe('2026-10-20');
    expect(shiftMonths('2026-09-20', -1)).toBe('2026-08-20');
    expect(shiftMonths('2026-12-20', 1)).toBe('2027-01-20');
    expect(shiftMonths('2026-01-20', -1)).toBe('2025-12-20');
    expect(shiftMonths('2026-09-20', 12)).toBe('2027-09-20');
  });

  it('clamps the day instead of skipping the month asked for', () => {
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(shiftMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonths('2026-05-31', 1)).toBe('2026-06-30');
  });
});

describe('monthGrid', () => {
  it('is always six Monday-first weeks', () => {
    expect(WEEKDAY_LABELS[0]).toBe('Пн');
    const grid = monthGrid(2026, 9);
    expect(grid).toHaveLength(42);
    // 1 September 2026 is a Tuesday, so the row opens on 31 August.
    expect(grid[0]).toEqual({ iso: '2026-08-31', day: 31, inMonth: false });
    expect(grid[1]).toEqual({ iso: '2026-09-01', day: 1, inMonth: true });
    expect(grid[41]?.iso).toBe('2026-10-11');
    expect(grid.filter((c) => c.inMonth)).toHaveLength(30);
  });

  it('keeps six rows for a month that starts on a Monday', () => {
    // 1 June 2026 is a Monday: no leading days, so the trailing week runs deep into July.
    const grid = monthGrid(2026, 6);
    expect(grid[0]).toEqual({ iso: '2026-06-01', day: 1, inMonth: true });
    expect(grid).toHaveLength(42);
    expect(grid[41]?.iso).toBe('2026-07-12');
  });

  it('handles a leap February', () => {
    const grid = monthGrid(2028, 2);
    expect(grid.filter((c) => c.inMonth)).toHaveLength(29);
    expect(grid.some((c) => c.iso === '2028-02-29')).toBe(true);
  });

  it('titles the month in the nominative', () => {
    expect(monthTitle(2026, 9)).toBe('Вересень 2026');
    expect(monthTitle(2026, 1)).toBe('Січень 2026');
  });
});
