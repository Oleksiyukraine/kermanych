import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_COLUMNS,
  DEFAULT_LAYOUT,
  TILE_MAX_H,
  TILE_MIN_H,
  TILE_MIN_W,
  clampHeight,
  clampWidth,
  mergeLayout,
  reorder,
  resizeTile,
  type TileLayout,
} from '../src/lib/dashboard';

const ids = (layout: readonly TileLayout[]): string[] => layout.map((t) => t.id);

describe('dashboard clamps', () => {
  it('holds width inside [MIN, columns] and rounds', () => {
    expect(clampWidth(0)).toBe(TILE_MIN_W);
    expect(clampWidth(99)).toBe(DASHBOARD_COLUMNS);
    expect(clampWidth(2.4)).toBe(2);
    expect(clampWidth(2.6)).toBe(3);
  });

  it('holds height inside [MIN, MAX] and rounds', () => {
    expect(clampHeight(0)).toBe(TILE_MIN_H);
    expect(clampHeight(99)).toBe(TILE_MAX_H);
    expect(clampHeight(1.6)).toBe(2);
  });
});

describe('reorder', () => {
  const base = mergeLayout(null); // capacity, tasks, risks, releases, todo

  it('moves a tile to the target position and shifts the rest', () => {
    expect(ids(reorder(base, 'releases', 'capacity'))).toEqual([
      'releases',
      'capacity',
      'tasks',
      'risks',
      'todo',
    ]);
  });

  it('moving down lands the tile after the target', () => {
    expect(ids(reorder(base, 'capacity', 'risks'))).toEqual([
      'tasks',
      'risks',
      'capacity',
      'releases',
      'todo',
    ]);
  });

  it('is a copy no-op when source and target are the same', () => {
    const out = reorder(base, 'risks', 'risks');
    expect(ids(out)).toEqual(ids(base));
    expect(out).not.toBe(base);
  });
});

describe('resizeTile', () => {
  const base = mergeLayout(null);

  it('resizes only the named tile and clamps', () => {
    const out = resizeTile(base, 'capacity', 99, 99);
    const cap = out.find((t) => t.id === 'capacity')!;
    expect(cap.w).toBe(DASHBOARD_COLUMNS);
    expect(cap.h).toBe(TILE_MAX_H);
    // Every other tile is untouched.
    expect(out.filter((t) => t.id !== 'capacity')).toEqual(
      base.filter((t) => t.id !== 'capacity'),
    );
  });
});

describe('mergeLayout', () => {
  it('returns the default layout for a missing or non-array blob', () => {
    expect(mergeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(mergeLayout('nonsense')).toEqual(DEFAULT_LAYOUT);
    expect(mergeLayout({})).toEqual(DEFAULT_LAYOUT);
  });

  it('keeps a saved order and clamps saved sizes', () => {
    const saved = [
      { id: 'releases', w: 4, h: 3 },
      { id: 'risks', w: 99, h: 0 },
    ];
    const out = mergeLayout(saved);
    // Saved ids come first, in their saved order and size; the rest follow in default order.
    expect(ids(out)).toEqual(['releases', 'risks', 'capacity', 'tasks', 'todo']);
    expect(out[0]).toEqual({ id: 'releases', w: 4, h: 3 });
    expect(out[1]).toEqual({ id: 'risks', w: DASHBOARD_COLUMNS, h: TILE_MIN_H });
  });

  it('drops unknown and duplicate ids and falls back to default size for junk', () => {
    const saved = [
      { id: 'ghost', w: 2, h: 2 },
      { id: 'tasks' },
      { id: 'tasks', w: 3, h: 3 },
      { id: 'capacity', w: 'wide', h: null },
    ];
    const out = mergeLayout(saved);
    expect(ids(out)).toEqual(['tasks', 'capacity', 'risks', 'releases', 'todo']);
    // First `tasks` had no size → default; the duplicate is ignored.
    expect(out[0]).toEqual({ id: 'tasks', w: 2, h: 2 });
    // Non-numeric sizes fall back to the default for that widget.
    expect(out[1]).toEqual({ id: 'capacity', w: 2, h: 2 });
  });
});
