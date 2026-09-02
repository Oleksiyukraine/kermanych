import { describe, expect, it } from 'vitest';
import { dur, until } from '../src/lib/time';

// The reasoning chip, the collapsed block summary and the status row all print the same
// quantity through this one function, so a minute-scale reasoning cannot read `127 с` in
// the chip and `2 хв` in the summary one press away.
describe('dur', () => {
  it('floors a sub-second span instead of claiming no time passed', () => {
    expect(dur(0)).toEqual({ key: 'common.time.durShort', params: { n: 0 } });
    expect(dur(999)).toEqual({ key: 'common.time.durShort', params: { n: 0 } });
  });

  it('prints whole seconds below a minute', () => {
    expect(dur(1000)).toEqual({ key: 'common.time.seconds', params: { n: 1 } });
    expect(dur(8400)).toEqual({ key: 'common.time.seconds', params: { n: 8 } });
    expect(dur(59_000)).toEqual({ key: 'common.time.seconds', params: { n: 59 } });
  });

  it('switches to whole minutes at a minute', () => {
    expect(dur(60_000)).toEqual({ key: 'common.time.minutes', params: { n: 1 } });
    expect(dur(127_000)).toEqual({ key: 'common.time.minutes', params: { n: 2 } });
    expect(dur(600_000)).toEqual({ key: 'common.time.minutes', params: { n: 10 } });
  });
});

// The countdown under the account name: how long the provider plan's window has left. Two
// units, because `1 дн` and `1 дн 7 год` are different answers to «чи вистачить на вечір».
describe('until', () => {
  const now = Date.UTC(2026, 7, 26, 12, 0, 0);
  const iso = (ms: number): string => new Date(now + ms).toISOString();

  it('collapses the last minute and any past instant to «зараз»', () => {
    expect(until(iso(59_000), now)).toEqual({ key: 'common.time.now', params: { n: 0 } });
    expect(until(iso(0), now)).toEqual({ key: 'common.time.now', params: { n: 0 } });
    expect(until(iso(-3_600_000), now)).toEqual({ key: 'common.time.now', params: { n: 0 } });
  });

  it('prints whole minutes below an hour', () => {
    expect(until(iso(60_000), now)).toEqual({ key: 'common.time.minutes', params: { n: 1 } });
    expect(until(iso(14 * 60_000), now)).toEqual({ key: 'common.time.minutes', params: { n: 14 } });
  });

  it('adds the odd minutes to the hours, and drops them when there are none', () => {
    expect(until(iso(4 * 3_600_000 + 14 * 60_000), now)).toEqual({ key: 'common.time.hoursMinutes', params: { n: 4, m: 14 } });
    expect(until(iso(3_600_000), now)).toEqual({ key: 'common.time.hours', params: { n: 1 } });
  });

  it('adds the odd hours to the days, and drops them when there are none', () => {
    expect(until(iso(31 * 3_600_000), now)).toEqual({ key: 'common.time.daysHours', params: { n: 1, h: 7 } });
    expect(until(iso(7 * 86_400_000), now)).toEqual({ key: 'common.time.days', params: { n: 7 } });
  });

  it('reads «—» for an unparseable instant rather than throwing under a tooltip', () => {
    expect(until('not a date', now)).toEqual({ key: 'common.time.unknown', params: { n: 0 } });
  });
});
