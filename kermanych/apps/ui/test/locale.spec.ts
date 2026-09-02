// @vitest-environment happy-dom
// locale.ts reads/writes the global `localStorage` directly (unlike theme.ts,
// which injects the store), so this spec runs under a DOM environment that
// provides Web Storage.
import { describe, it, expect, beforeEach } from 'vitest';
import { readLocale, writeLocale } from '../src/lib/locale';

beforeEach(() => localStorage.clear());

describe('locale store', () => {
  it('defaults to uk when nothing is stored', () => {
    expect(readLocale()).toBe('uk');
  });
  it('round-trips a written locale through localStorage', () => {
    writeLocale('en');
    expect(readLocale()).toBe('en');
    expect(localStorage.getItem('kermanych.locale')).toBe('en');
  });
  it('falls back to uk for an unknown stored value', () => {
    localStorage.setItem('kermanych.locale', 'fr');
    expect(readLocale()).toBe('uk');
  });
});
