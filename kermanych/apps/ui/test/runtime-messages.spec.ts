import { describe, it, expect } from 'vitest';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';

// The exact keys MainLayout/SettingsPage build at runtime (`errors.runtime_${code}`) from the
// codes the preflight and a failed launch return. A typo in either half would leave the
// operator with a generic fallback and no command to run — invisible to every other test.
const CODES = ['claude_not_authenticated', 'claude_binary_missing', 'omp_not_authenticated', 'omp_binary_missing'];

describe('runtime failure messages resolve', () => {
  it.each(CODES)('errors.runtime_%s names a fix in both locales', (code) => {
    for (const [name, loc] of [['uk', uk], ['en', en]] as const) {
      const msg = (loc.errors as Record<string, string>)[`runtime_${code}`];
      expect(msg, `${name}: runtime_${code}`).toBeTruthy();
      // Every one of these must tell the operator a command to run — that is the whole point.
      expect(msg, `${name}: runtime_${code} names no command`).toMatch(/login|pnpm install|PATH/);
    }
  });

  it.each(CODES)('notices.%s exists for a mid-session death in both locales', (code) => {
    for (const [name, loc] of [['uk', uk], ['en', en]] as const) {
      expect((loc.notices as Record<string, string>)[code], `${name}: notices.${code}`).toBeTruthy();
    }
  });
});
