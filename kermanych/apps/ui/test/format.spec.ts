import { describe, expect, it } from 'vitest';
import { hours, percent, planWindow, tokens, usageTokens, usd } from '../src/lib/format';

describe('tokens', () => {
  it('keeps small counts exact', () => {
    expect(tokens(0)).toBe('0');
    expect(tokens(840)).toBe('840');
    expect(tokens(999)).toBe('999');
  });

  it('switches to k at a thousand and drops a trailing .0', () => {
    expect(tokens(1000)).toBe('1k');
    expect(tokens(1840)).toBe('1.8k');
    expect(tokens(12_300)).toBe('12.3k');
  });

  it('drops the decimal once a tenth of a thousand is noise', () => {
    expect(tokens(99_900)).toBe('99.9k');
    expect(tokens(142_000)).toBe('142k');
  });

  // The card must never read `1240k`: a long agent's cache reads pass a million routinely.
  it('hops to millions before the k tier reaches four digits', () => {
    expect(tokens(999_499)).toBe('999k');
    expect(tokens(999_500)).toBe('1M');
    expect(tokens(1_240_000)).toBe('1.2M');
    expect(tokens(12_500_000)).toBe('12.5M');
  });
});

describe('usd', () => {
  it('renders nothing when nothing was spent', () => {
    expect(usd(0)).toBe('');
  });

  // The load-bearing rule: real spend must never be rounded down into a claim that the
  // work was free, and an unspent zero must never be dressed up as a figure.
  it('marks sub-cent spend as under a cent instead of $0.00', () => {
    expect(usd(0.0001)).toBe('<$0.01');
    expect(usd(0.004)).toBe('<$0.01');
  });

  it('rounds to cents from half a cent up', () => {
    expect(usd(0.005)).toBe('$0.01');
    expect(usd(3.183)).toBe('$3.18');
    expect(usd(12)).toBe('$12.00');
  });
});

// The plan figures under the account name. Unlike `usd`, a zero here is a real statement —
// the provider says the window is untouched — but a spent tenth of a percent must not be
// rounded down into that same zero.
describe('percent', () => {
  it('keeps an untouched window at 0%', () => {
    expect(percent(0)).toBe('0%');
  });

  it('marks sub-percent spend as under a percent', () => {
    expect(percent(0.4)).toBe('<1%');
    expect(percent(0.999)).toBe('<1%');
  });

  it('rounds to whole percent from one up', () => {
    expect(percent(1)).toBe('1%');
    expect(percent(57.4)).toBe('57%');
    expect(percent(99.6)).toBe('100%');
  });
});

// Window ids come from the provider, so the shape is parsed rather than enumerated: a
// window Kermanych has never seen still renders instead of blanking the row.
describe('planWindow', () => {
  it('shortens the hour/day/week windows providers actually meter', () => {
    expect(planWindow('5h')).toEqual({ key: 'common.unit.hours', params: { n: 5 } });
    expect(planWindow('7d')).toEqual({ key: 'common.unit.days', params: { n: 7 } });
    expect(planWindow('30d')).toEqual({ key: 'common.unit.days', params: { n: 30 } });
    expect(planWindow('2w')).toEqual({ key: 'common.unit.weeks', params: { n: 2 } });
  });

  it('names the monthly bucket', () => {
    expect(planWindow('monthly')).toEqual({ key: 'common.unit.monthly', params: { n: 0 } });
    expect(planWindow('month')).toEqual({ key: 'common.unit.monthly', params: { n: 0 } });
  });

  it('falls back to the provider id it cannot parse', () => {
    expect(planWindow('primary')).toEqual({ text: 'primary' });
    expect(planWindow('')).toEqual({ text: '' });
  });
});

describe('usageTokens', () => {
  // Cache lanes are billed, so they count: an agent that re-reads a big context every
  // turn spends most of its tokens there, and omitting them would understate it tenfold.
  it('sums every billed lane', () => {
    expect(usageTokens({ input: 18_400, output: 9_200, cacheRead: 1_240_000, cacheWrite: 62_000, cost: 3.18 })).toBe(1_329_600);
  });

  it('is zero for a counted-but-idle session', () => {
    expect(usageTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBe(0);
  });
});

describe('hours', () => {
  it('prints whole hours bare and fractions to one decimal', () => {
    expect(hours(0)).toBe('0');
    expect(hours(3600)).toBe('1');
    expect(hours(5400)).toBe('1.5');
    expect(hours(28800)).toBe('8');
    expect(hours(100)).toBe('0');
  });
});
