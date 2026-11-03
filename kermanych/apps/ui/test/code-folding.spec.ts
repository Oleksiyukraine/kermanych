import { describe, expect, it } from 'vitest';
import {
  bracketRegions,
  foldStyle,
  indentRegions,
  splitHighlightedLines,
  visibleLines,
} from '../src/lib/code-folding';

const lines = (s: string) => s.split('\n');

describe('foldStyle', () => {
  it('folds C-family and JSON by brackets, YAML and Python by indentation', () => {
    expect(foldStyle('package.json')).toBe('brackets');
    expect(foldStyle('src/main.ts')).toBe('brackets');
    expect(foldStyle('.github/workflows/ci.yml')).toBe('indent');
    expect(foldStyle('scripts/gen.py')).toBe('indent');
    expect(foldStyle('README.md')).toBeNull();
    expect(foldStyle('.npmrc')).toBeNull();
  });
});

describe('bracketRegions', () => {
  const json = lines(`{
  "name": "kermanych",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "kermanych" }
  },
  "list": [
    1,
    2,
  ]
}`);
  const r = bracketRegions(json);

  it('finds each multi-line block, start to end, with its bracket columns', () => {
    expect(r.get(0)).toMatchObject({ start: 0, end: 10, open: '{', openCol: 0, closeCol: 0 });
    expect(r.get(3)).toMatchObject({ start: 3, end: 5, open: '{', openCol: 14, closeCol: 2 });
    expect(r.get(6)).toMatchObject({ start: 6, end: 9, open: '[' });
    expect(r.has(4)).toBe(false); // one-line block: nothing to fold
  });

  it('counts direct children, a trailing comma included', () => {
    expect(r.get(0)!.items).toBe(4);
    expect(r.get(3)!.items).toBe(1);
    expect(r.get(6)!.items).toBe(2);
  });

  it('skips brackets inside strings and comments', () => {
    const r2 = bracketRegions(lines(`const a = {
  s: "}{",
  t: '[',
  // }
  /* {
  } */
  u: \`
  }\`,
};`));
    expect(r2.get(0)).toMatchObject({ start: 0, end: 8, items: 3 });
    expect(r2.size).toBe(1);
  });

  it('keeps the inner block when two open on one line and close together', () => {
    const r3 = bracketRegions(lines(`foo({
  a: 1,
});`));
    expect(r3.get(0)).toMatchObject({ open: '{', end: 2 });
  });
});

describe('indentRegions', () => {
  it('folds a key over its deeper lines, ending on the last line with text', () => {
    const r = indentRegions(lines(`name: ci
on:
  push:
    branches: [dev]

  pull_request: {}

jobs: {}`));
    expect(r.get(1)).toEqual({ start: 1, end: 5 });
    expect(r.get(2)).toEqual({ start: 2, end: 3 });
    expect(r.has(0)).toBe(false);
    expect(r.has(7)).toBe(false);
  });
});

describe('visibleLines', () => {
  it('drops the lines of a folded block, keeping its first line', () => {
    const r = bracketRegions(lines('{\n  "a": {\n    "b": 1\n  }\n}'));
    expect(visibleLines(5, r, new Set())).toEqual([0, 1, 2, 3, 4]);
    expect(visibleLines(5, r, new Set([1]))).toEqual([0, 1, 4]);
    expect(visibleLines(5, r, new Set([0, 1]))).toEqual([0]);
  });
});

describe('splitHighlightedLines', () => {
  it('closes spans at each line end and reopens them on the next line', () => {
    const html = 'a<span class="c">/* x\ny */</span>b\nc';
    expect(splitHighlightedLines(html)).toEqual([
      'a<span class="c">/* x</span>',
      '<span class="c">y */</span>b',
      'c',
    ]);
  });
});
