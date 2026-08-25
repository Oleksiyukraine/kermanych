import { describe, expect, it, afterEach } from 'vitest';
import { DEFAULT_THEME, STORAGE_KEY, readTheme, theme, toggleTheme, writeTheme } from '../src/lib/theme';

// The theme survives a reload through localStorage, so the two failure modes
// that matter are a value the app no longer ships (a hand-edited key, or one
// written by an older build) and a store that throws instead of answering
// (private windows, embedded webviews). Neither may leave the shell unthemed.
describe('readTheme', () => {
  it('returns the stored theme', () => {
    expect(readTheme({ getItem: () => 'light' })).toBe('light');
    expect(readTheme({ getItem: () => 'dark' })).toBe('dark');
  });

  it('reads the namespaced key', () => {
    const seen: string[] = [];
    readTheme({
      getItem: (k) => {
        seen.push(k);
        return null;
      },
    });
    expect(seen).toEqual([STORAGE_KEY]);
  });

  it('falls back to the default for a missing or unknown value', () => {
    expect(readTheme({ getItem: () => null })).toBe(DEFAULT_THEME);
    expect(readTheme({ getItem: () => 'solarized' })).toBe(DEFAULT_THEME);
    expect(readTheme({ getItem: () => '' })).toBe(DEFAULT_THEME);
    expect(readTheme(null)).toBe(DEFAULT_THEME);
  });

  it('falls back to the default when the store throws', () => {
    expect(
      readTheme({
        getItem: () => {
          throw new DOMException('denied');
        },
      }),
    ).toBe(DEFAULT_THEME);
  });
});

describe('writeTheme', () => {
  it('persists under the namespaced key', () => {
    const written: Array<[string, string]> = [];
    writeTheme({ setItem: (k, v) => void written.push([k, v]) }, 'light');
    expect(written).toEqual([[STORAGE_KEY, 'light']]);
  });

  it('swallows a store that refuses to write', () => {
    expect(() =>
      writeTheme(
        {
          setItem: () => {
            throw new DOMException('quota');
          },
        },
        'light',
      ),
    ).not.toThrow();
  });
});

describe('toggleTheme', () => {
  const initial = theme.value;
  afterEach(() => {
    theme.value = initial;
  });

  it('moves between the two themes and back', () => {
    theme.value = 'dark';
    toggleTheme();
    expect(theme.value).toBe('light');
    toggleTheme();
    expect(theme.value).toBe('dark');
  });
});
