// @vitest-environment happy-dom
// vue-i18n's dev build records a performance measure per `t()` and never clears it; the
// buffer reached a million entries and Vue's per-render `clearMeasures` scan froze the app.
import { describe, it, expect, beforeEach } from 'vitest';
import { dropIntlifyMeasures } from '../src/lib/dev-perf';

function timed(name: string): void {
  performance.mark('s');
  performance.mark('e');
  performance.measure(name, 's', 'e');
}

describe('dropIntlifyMeasures', () => {
  beforeEach(() => {
    performance.clearMeasures();
    performance.clearMarks();
  });

  it('keeps the timeline free of intlify measures however many translations run', () => {
    dropIntlifyMeasures(performance);
    for (let i = 0; i < 50; i++) {
      timed('intlify message resolve');
      timed('intlify message compilation');
      timed('intlify message evaluation');
    }
    expect(performance.getEntriesByType('measure').filter((e) => e.name.startsWith('intlify ')).length).toBe(0);
  });

  it('leaves every other measure in the timeline', () => {
    dropIntlifyMeasures(performance);
    timed('<KLogBlock> patch');
    timed('<KLogBlock> patch');
    expect(performance.getEntriesByName('<KLogBlock> patch', 'measure').length).toBe(2);
  });
});
