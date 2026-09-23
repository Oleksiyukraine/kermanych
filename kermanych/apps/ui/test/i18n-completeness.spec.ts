import { describe, it, expect } from 'vitest';
import { NOTICE_CODES, API_ERROR_CODES } from '@kermanych/core';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';

function keys(o: unknown, prefix = ''): string[] {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      keys(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

describe('i18n completeness', () => {
  it('en has exactly the uk key set', () => {
    expect(keys(en).sort()).toEqual(keys(uk).sort());
  });

  // The guarantee core's i18n-codes.ts documents ("extend by adding a member here AND its
  // uk/en message — the completeness test in the message catalogs fails otherwise") was not
  // actually enforced anywhere: the check above only compares the two locales to EACH OTHER,
  // so a code added to the union with no message in either locale passed silently and rendered
  // as its own raw fallback prose forever. These two pin the promise to the catalogs.
  const catalogue = (locale: typeof uk, group: 'notices' | 'errors'): Set<string> =>
    new Set(Object.keys((locale as unknown as Record<string, Record<string, unknown>>)[group] ?? {}));

  it.each([
    ['notices', NOTICE_CODES, 'notices'] as const,
    ['errors', API_ERROR_CODES, 'errors'] as const,
  ])('every %s code has a message in both locales', (_label, codes, group) => {
    const missingUk = codes.filter((c) => !catalogue(uk, group).has(c));
    const missingEn = codes.filter((c) => !catalogue(en, group).has(c));
    expect({ missingUk, missingEn }).toEqual({ missingUk: [], missingEn: [] });
  });
});
