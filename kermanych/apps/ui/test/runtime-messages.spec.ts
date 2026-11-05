import { describe, it, expect } from 'vitest';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';
import type { MessageSchema } from '../src/i18n/schema';

// The exact keys MainLayout/SettingsPage build at runtime (`errors.runtime_${code}`) from the
// codes the preflight and a failed launch return. A typo in either half would leave the
// operator with a generic fallback and no command to run — invisible to every other test.
// `as const` types the lookups below against the message schema, so a key missing from it fails
// typecheck as well as the run.
const CODES = ['claude_not_authenticated', 'claude_binary_missing', 'omp_not_authenticated', 'omp_binary_missing'] as const;
const LOCALES: ReadonlyArray<readonly [string, MessageSchema]> = [['uk', uk], ['en', en]];

describe('runtime failure messages resolve', () => {
  it.each(CODES)('errors.runtime_%s names a fix in both locales', (code) => {
    for (const [name, loc] of LOCALES) {
      const msg = loc.errors[`runtime_${code}`];
      expect(msg, `${name}: runtime_${code}`).toBeTruthy();
      // Every one of these must tell the operator a command to run — that is the whole point.
      expect(msg, `${name}: runtime_${code} names no command`).toMatch(/login|pnpm install|PATH/);
    }
  });

  it.each(CODES)('notices.%s exists for a mid-session death in both locales', (code) => {
    for (const [name, loc] of LOCALES) {
      expect(loc.notices[code], `${name}: notices.${code}`).toBeTruthy();
    }
  });
});
