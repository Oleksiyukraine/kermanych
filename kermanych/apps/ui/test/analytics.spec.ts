import { describe, expect, it } from 'vitest';
import type { CloudProject } from '@kermanych/cloud';
import type { AnalyticsSeries } from '@kermanych/core';
import { DEFAULT_DOCS_POLICY } from '@kermanych/core';
import {
  ANALYTICS_MAX_SERIES,
  ANALYTICS_OTHERS,
  ANALYTICS_OTHERS_COLOR,
  ANALYTICS_PALETTE,
  analyticsProjectIds,
  axisMax,
  duration,
  foldSeries,
  heatLevel,
  metricDelta,
  money,
  seriesColor,
  share,
} from '../src/lib/analytics';

function proj(id: string, workspaceId: string): CloudProject {
  return {
    id,
    name: id,
    workspaceId,
    carryFiles: ['.env'],
    envKeys: [],
    docFolders: [],
    docsRequired: false,
    docsPolicy: { ...DEFAULT_DOCS_POLICY },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function series(key: string, cost: number[], tokens: number[] = cost.map(() => 0), workingMs: number[] = cost.map(() => 0)): AnalyticsSeries {
  return { key, cost, tokens, workingMs };
}

describe('analyticsProjectIds (decision 3)', () => {
  const cloud = { projects: [proj('a', 'w1'), proj('b', 'w1'), proj('c', 'w2')], listRead: true };
  const local = ['a', 'c', 'local-only'];

  it('is everything on this machine — undefined — when nothing is selected', () => {
    expect(analyticsProjectIds({}, cloud, {}, local)).toBeUndefined();
  });

  it('is the selected project alone, local-only ones included', () => {
    expect(analyticsProjectIds({ workspaceId: 'w1', projectId: 'a' }, cloud, {}, local)).toEqual(['a']);
    expect(analyticsProjectIds({ projectId: 'local-only' }, cloud, {}, local)).toEqual(['local-only']);
  });

  it('is the workspace projects that are on this machine', () => {
    expect(analyticsProjectIds({ workspaceId: 'w1' }, cloud, {}, local)).toEqual(['a']);
  });

  it('reads the cached map while the cloud list is unread', () => {
    const unread = { projects: [], listRead: false };
    expect(analyticsProjectIds({ workspaceId: 'w2' }, unread, { a: 'w1', c: 'w2' }, local)).toEqual(['c']);
  });

  it('is empty, never everything, for a workspace with none of its projects here', () => {
    expect(analyticsProjectIds({ workspaceId: 'w1' }, cloud, {}, ['c'])).toEqual([]);
  });
});

describe('foldSeries (decision 8.3)', () => {
  it('keeps up to eight series, ranked by the metric total', () => {
    const input = [series('small', [1, 0]), series('big', [5, 5]), series('mid', [3, 1])];
    expect(foldSeries(input, 'cost').map((s) => s.key)).toEqual(['big', 'mid', 'small']);
  });

  it('folds everything past the eighth into «інші», summed bucket by bucket', () => {
    const input = Array.from({ length: 11 }, (_, i) => series(`m${i}`, [100 - i, 1]));
    const out = foldSeries(input, 'cost');
    expect(out).toHaveLength(ANALYTICS_MAX_SERIES + 1);
    expect(out.slice(0, ANALYTICS_MAX_SERIES).map((s) => s.key)).toEqual(input.slice(0, 8).map((s) => s.key));
    const others = out[ANALYTICS_MAX_SERIES]!;
    expect(others.key).toBe(ANALYTICS_OTHERS);
    expect(others.members).toEqual(['m8', 'm9', 'm10']);
    expect(others.values).toEqual([92 + 91 + 90, 3]);
  });

  it('does not fold exactly eight series', () => {
    const input = Array.from({ length: 8 }, (_, i) => series(`m${i}`, [i + 1]));
    expect(foldSeries(input, 'cost').some((s) => s.key === ANALYTICS_OTHERS)).toBe(false);
  });

  it('ranks by the chosen metric, not by cost', () => {
    const input = [series('pricey', [10], [1], [1_000]), series('long', [1], [1], [9_000_000])];
    expect(foldSeries(input, 'workingMs').map((s) => s.key)).toEqual(['long', 'pricey']);
  });

  it('drops a series with nothing in the metric and breaks ties on the key', () => {
    const input = [series('b', [2]), series('zero', [0]), series('a', [2])];
    expect(foldSeries(input, 'cost').map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('gives «інші» the muted swatch and the rest the palette', () => {
    expect(seriesColor(ANALYTICS_OTHERS, 8)).toBe(ANALYTICS_OTHERS_COLOR);
    expect(seriesColor('m0', 0)).toBe(ANALYTICS_PALETTE[0]);
  });
});

describe('metricDelta (decision 4)', () => {
  it('is null when the previous period has no data', () => {
    expect(metricDelta({ value: 5, previous: null })).toBeNull();
  });

  it('is null when the previous figure is 0 — a percentage of nothing is not a figure', () => {
    expect(metricDelta({ value: 5, previous: 0 })).toBeNull();
  });

  it('states the direction and the rounded percent', () => {
    expect(metricDelta({ value: 15, previous: 10 })).toEqual({ direction: 'up', percent: 50 });
    expect(metricDelta({ value: 0, previous: 4 })).toEqual({ direction: 'down', percent: 100 });
    expect(metricDelta({ value: 1001, previous: 1000 })).toEqual({ direction: 'flat', percent: 0 });
  });
});

describe('figures', () => {
  it('writes known spend of nothing as $0.00, not as the empty card form', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(12.5)).toBe('$12.50');
  });

  it('never prints a real share as 0%', () => {
    expect(share(0)).toBe('0%');
    expect(share(0.004)).toBe('<1%');
    expect(share(0.42)).toBe('42%');
  });

  it('sums durations into hours without turning them into days', () => {
    expect(duration(0)).toEqual({ key: 'common.time.minutes', params: { n: 0 } });
    expect(duration(90 * 60_000)).toEqual({ key: 'common.time.hoursMinutes', params: { n: 1, m: 30 } });
    expect(duration(52 * 3_600_000)).toEqual({ key: 'common.time.hours', params: { n: 52 } });
  });

  it('rounds the axis top to 1, 2 or 5 in the metric unit', () => {
    expect(axisMax(7.3, 'cost')).toBe(10);
    expect(axisMax(1_400, 'tokens')).toBe(2_000);
    expect(axisMax(3.2 * 3_600_000, 'workingMs')).toBe(5 * 3_600_000);
    expect(axisMax(0, 'cost')).toBe(1);
  });

  it('shades the heat map relative to the busiest hour', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(10, 10)).toBe(4);
  });
});
