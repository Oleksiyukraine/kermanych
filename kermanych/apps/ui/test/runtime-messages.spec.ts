import { describe, it, expect } from 'vitest';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';

// The exact keys MainLayout/SettingsPage build at runtime (`errors.runtime_${code}`) from the
// codes the preflight and a failed launch return. A typo in either half would leave the
// operator with a generic fallback and no command to run — invisible to every other test.
const CODES = ['claude_not_authenticated', 'claude_binary_missing', 'omp_not_authenticated', 'omp_binary_missing'];

// The catalog nests groups (`errors.image.*`, `errors.file.*`), so it is not a flat
// Record<string, string>: index every leaf by its dotted path, the way vue-i18n resolves it.
function flatten(node: object, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') Object.assign(out, flatten(value, path));
    else out[path] = value;
  }
  return out;
}

const LOCALES = [['uk', flatten(uk)], ['en', flatten(en)]] as const;

describe('runtime failure messages resolve', () => {
  it.each(CODES)('errors.runtime_%s names a fix in both locales', (code) => {
    for (const [name, messages] of LOCALES) {
      const msg = messages[`errors.runtime_${code}`];
      expect(msg, `${name}: runtime_${code}`).toBeTruthy();
      // Every one of these must tell the operator a command to run — that is the whole point.
      expect(msg, `${name}: runtime_${code} names no command`).toMatch(/login|pnpm install|PATH/);
    }
  });

  it.each(CODES)('notices.%s exists for a mid-session death in both locales', (code) => {
    for (const [name, messages] of LOCALES) {
      expect(messages[`notices.${code}`], `${name}: notices.${code}`).toBeTruthy();
    }
  });
});
