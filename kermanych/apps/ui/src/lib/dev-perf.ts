// vue-i18n's development build times every `t()` with `performance.measure('intlify message
// resolve' | 'intlify message compilation' | 'intlify message evaluation', …)` and clears the
// marks but never the measures, so the window's performance timeline only grows: ~700 entries
// a second while agents stream, over a million after an hour. Quasar's dev entry also turns on
// `app.config.performance`, and Vue's `endMeasure` then calls `performance.clearMeasures(name)`
// after EVERY component render — a scan of that whole buffer. An hour in, each socket event
// cost ~240 ms of main thread and the app froze, worse the busier the log on screen.
//
// Production builds strip both, so this is installed in dev only (boot/i18n.ts). Each intlify
// measure is dropped the moment it is recorded, which keeps the buffer at Vue's own transient
// entries; anything else that measures is left alone.
const INTLIFY_PREFIX = 'intlify ';

export function dropIntlifyMeasures(perf: Performance): void {
  const measure = perf.measure.bind(perf);
  perf.measure = (name: string, startOrOptions?: string | PerformanceMeasureOptions, endMark?: string) => {
    const entry = measure(name, startOrOptions, endMark);
    if (name.startsWith(INTLIFY_PREFIX)) perf.clearMeasures(name);
    return entry;
  };
}
