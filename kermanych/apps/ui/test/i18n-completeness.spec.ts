import { describe, it, expect } from 'vitest';
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
});
