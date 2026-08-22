// Relative "time ago" for the agents board, Ukrainian abbreviations. Pure:
// takes the target ISO timestamp and the current epoch millis (supplied by
// useNow), so the caller owns the ticking and the function stays testable.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const delta = Math.max(0, nowMs - then);
  if (delta < MIN) return 'щойно';
  if (delta < HOUR) return `${Math.floor(delta / MIN)} хв тому`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} год тому`;
  return `${Math.floor(delta / DAY)} дн тому`;
}

// The house duration form for a measured span, shared by every component that prints one:
// the collapsed block summary, the status row and the reasoning chip. Whole seconds below a
// minute, then whole minutes; a sub-second span gets a floor marker, because `0 с` would
// claim the work took no time at all. One function on purpose — the chip used to stop at
// seconds and printed `думав 127 с` beside a summary reading `роздуми 2 хв`.
export function dur(ms: number): string {
  if (ms < 1000) return '<1 с';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.round(s / 60)} хв`;
}
