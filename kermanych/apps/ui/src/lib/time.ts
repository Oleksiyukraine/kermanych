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
