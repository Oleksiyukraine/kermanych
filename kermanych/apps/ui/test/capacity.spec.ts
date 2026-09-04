import { describe, expect, it } from 'vitest';
import {
  businessDays,
  capacityPeriods,
  defaultGranularity,
  eachDay,
  isBusinessDay,
  normalizeRange,
  presetRange,
  weekMonday,
} from '../src/lib/capacity';

// 2026-09-04 is a Friday; 2026-09-05/06 the weekend; 2026-08-31 the Monday of that week.
const TODAY = '2026-09-04';

describe('calendar primitives', () => {
  it('knows the working week', () => {
    expect(isBusinessDay('2026-09-04')).toBe(true);
    expect(isBusinessDay('2026-09-05')).toBe(false);
    expect(isBusinessDay('2026-09-06')).toBe(false);
    expect(isBusinessDay('2026-09-07')).toBe(true);
  });

  it('lists days inclusively and refuses a malformed bound instead of looping', () => {
    expect(eachDay('2026-09-03', '2026-09-05')).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
    expect(eachDay('2026-09-05', '2026-09-03')).toEqual([]);
    expect(eachDay('nope', '2026-09-03')).toEqual([]);
  });

  it('counts business days across a weekend', () => {
    expect(businessDays('2026-09-04', '2026-09-08')).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });

  it('finds the Monday of a week', () => {
    expect(weekMonday('2026-09-04')).toBe('2026-08-31');
    expect(weekMonday('2026-08-31')).toBe('2026-08-31');
    expect(weekMonday('2026-09-06')).toBe('2026-08-31');
  });

  it('swaps a reversed range and picks day buckets up to a month', () => {
    expect(normalizeRange({ from: '2026-09-10', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-10' });
    expect(defaultGranularity({ from: '2026-09-01', to: '2026-10-01' })).toBe('day'); // 31 days
    expect(defaultGranularity({ from: '2026-09-01', to: '2026-10-02' })).toBe('week'); // 32 days
  });
});

describe('presetRange', () => {
  it('resolves every preset against today', () => {
    expect(presetRange('thisWeek', TODAY)).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(presetRange('nextWeek', TODAY)).toEqual({ from: '2026-09-07', to: '2026-09-13' });
    expect(presetRange('next2Weeks', TODAY)).toEqual({ from: '2026-09-04', to: '2026-09-17' });
    expect(presetRange('thisMonth', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('nextMonth', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('last2Weeks', TODAY)).toEqual({ from: '2026-08-21', to: '2026-09-03' });
  });
});

describe('capacityPeriods', () => {
  it('makes one period per day with weekend capacity 0 and marks the past', () => {
    const p = capacityPeriods({ from: '2026-09-03', to: '2026-09-06' }, 'day', TODAY);
    expect(p.map((x) => x.key)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
    expect(p.map((x) => x.businessDays)).toEqual([1, 1, 0, 0]);
    expect(p.map((x) => x.past)).toEqual([true, false, false, false]);
  });

  it('rolls days into Monday-keyed weeks and credits only the business days inside the range', () => {
    const p = capacityPeriods({ from: '2026-09-03', to: '2026-09-15' }, 'week', TODAY);
    expect(p.map((x) => x.key)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
    expect(p[0]).toEqual({ key: '2026-08-31', from: '2026-09-03', to: '2026-09-06', businessDays: 2, past: false });
    expect(p[1]!.businessDays).toBe(5);
    expect(p[2]).toEqual({ key: '2026-09-14', from: '2026-09-14', to: '2026-09-15', businessDays: 2, past: false });
  });
});
