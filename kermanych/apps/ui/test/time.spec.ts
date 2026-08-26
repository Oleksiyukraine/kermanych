import { describe, expect, it } from 'vitest';
import { dur, until } from '../src/lib/time';

// The reasoning chip, the collapsed block summary and the status row all print the same
// quantity through this one function, so a minute-scale reasoning cannot read `127 с` in
// the chip and `2 хв` in the summary one press away.
describe('dur', () => {
  it('floors a sub-second span instead of claiming no time passed', () => {
    expect(dur(0)).toBe('<1 с');
    expect(dur(999)).toBe('<1 с');
  });

  it('prints whole seconds below a minute', () => {
    expect(dur(1000)).toBe('1 с');
    expect(dur(8400)).toBe('8 с');
    expect(dur(59_000)).toBe('59 с');
  });

  it('switches to whole minutes at a minute', () => {
    expect(dur(60_000)).toBe('1 хв');
    expect(dur(127_000)).toBe('2 хв');
    expect(dur(600_000)).toBe('10 хв');
  });
});

// The countdown under the account name: how long the provider plan's window has left. Two
// units, because `1 дн` and `1 дн 7 год` are different answers to «чи вистачить на вечір».
describe('until', () => {
  const now = Date.UTC(2026, 7, 26, 12, 0, 0);
  const iso = (ms: number): string => new Date(now + ms).toISOString();

  it('collapses the last minute and any past instant to «зараз»', () => {
    expect(until(iso(59_000), now)).toBe('зараз');
    expect(until(iso(0), now)).toBe('зараз');
    expect(until(iso(-3_600_000), now)).toBe('зараз');
  });

  it('prints whole minutes below an hour', () => {
    expect(until(iso(60_000), now)).toBe('1 хв');
    expect(until(iso(14 * 60_000), now)).toBe('14 хв');
  });

  it('adds the odd minutes to the hours, and drops them when there are none', () => {
    expect(until(iso(4 * 3_600_000 + 14 * 60_000), now)).toBe('4 год 14 хв');
    expect(until(iso(3_600_000), now)).toBe('1 год');
  });

  it('adds the odd hours to the days, and drops them when there are none', () => {
    expect(until(iso(31 * 3_600_000), now)).toBe('1 дн 7 год');
    expect(until(iso(7 * 86_400_000), now)).toBe('7 дн');
  });

  it('reads «—» for an unparseable instant rather than throwing under a tooltip', () => {
    expect(until('not a date', now)).toBe('—');
  });
});
