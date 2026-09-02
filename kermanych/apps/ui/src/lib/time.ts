// Relative "time ago" for the agents board. Pure: takes the target ISO timestamp and the
// current epoch millis (supplied by useNow), so the caller owns the ticking and the function
// stays testable. The prose itself is not built here — each producer returns a `{ key, params }`
// pair the caller renders through vue-i18n, so the abbreviations live in the catalog
// (`common.time.*`) and follow the active locale.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A catalog line and the numbers it interpolates. `n` is the primary count (also the plural
// choice at the callsite); a two-unit form carries its second number under its own name.
export type TimeLabel = { key: string; params: { n: number; m?: number; h?: number } };

// A vue-i18n `t` — either `useI18n().t` in a component or `globalTr.t` in a store. Kept
// structural so this pure module never imports the composer.
type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string;

// Render a label the producers below hand back. One place so every callsite passes the plural
// choice the same way; the messages are single-form (uk abbreviations do not inflect), so the
// choice is inert today and there only to keep the contract honest if a form ever splits.
export function renderTime(t: Translate, label: TimeLabel): string {
  return t(label.key, label.params, label.params.n);
}

export function relativeTime(iso: string, nowMs: number): TimeLabel {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return { key: 'common.time.unknown', params: { n: 0 } };
  const delta = Math.max(0, nowMs - then);
  if (delta < MIN) return { key: 'common.time.just', params: { n: 0 } };
  if (delta < HOUR) return { key: 'common.time.minutesAgo', params: { n: Math.floor(delta / MIN) } };
  if (delta < DAY) return { key: 'common.time.hoursAgo', params: { n: Math.floor(delta / HOUR) } };
  return { key: 'common.time.daysAgo', params: { n: Math.floor(delta / DAY) } };
}

// The house duration form for a measured span, shared by every component that prints one:
// the collapsed block summary, the status row and the reasoning chip. Whole seconds below a
// minute, then whole minutes; a sub-second span gets a floor marker, because `0 с` would
// claim the work took no time at all. One function on purpose — the chip used to stop at
// seconds and printed `думав 127 с` beside a summary reading `роздуми 2 хв`.
export function dur(ms: number): TimeLabel {
  if (ms < 1000) return { key: 'common.time.durShort', params: { n: 0 } };
  const s = Math.round(ms / 1000);
  return s < 60
    ? { key: 'common.time.seconds', params: { n: s } }
    : { key: 'common.time.minutes', params: { n: Math.round(s / 60) } };
}

// The wait until a future instant — the mirror of relativeTime, same abbreviations, same
// "caller owns the ticking" contract. Two units, because a plan window that resets in
// `1 дн 8 год` is a different plan from one resetting in `1 дн`, while seconds are noise at
// this scale. A past instant reads `зараз`: the reset has landed, the figure just has not
// been re-read yet.
export function until(iso: string, nowMs: number): TimeLabel {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return { key: 'common.time.unknown', params: { n: 0 } };
  const delta = then - nowMs;
  if (delta < MIN) return { key: 'common.time.now', params: { n: 0 } };
  if (delta < HOUR) return { key: 'common.time.minutes', params: { n: Math.floor(delta / MIN) } };
  if (delta < DAY) {
    const h = Math.floor(delta / HOUR);
    const m = Math.floor((delta % HOUR) / MIN);
    return m === 0
      ? { key: 'common.time.hours', params: { n: h } }
      : { key: 'common.time.hoursMinutes', params: { n: h, m } };
  }
  const d = Math.floor(delta / DAY);
  const h = Math.floor((delta % DAY) / HOUR);
  return h === 0
    ? { key: 'common.time.days', params: { n: d } }
    : { key: 'common.time.daysHours', params: { n: d, h } };
}
