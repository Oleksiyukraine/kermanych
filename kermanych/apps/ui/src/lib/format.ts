import type { Usage } from '@kermanych/core';

// How this app shapes machine figures. One module, because the same fact has to read the
// same at every zoom level: the spend on an agent card, in the panel's status row and in a
// collapsed block footer used to be three hand-copied expressions that had already drifted
// (`1.8k tok` in the composer vs `1.8k ток` in the log).

// Token magnitude, scaled to fit a card line: `840`, `1.8k`, `142k`, `1.2M`. The unit word
// stays with the caller (`ток`, `токенів`) so each strip keeps its own wording; the decimal
// is dropped once the figure is large enough that a tenth of the unit is noise. Millions is
// not a hypothetical tier — an agent re-reads its whole context every turn, so cache reads
// pass a million within an ordinary session, and `1240k` is a number nobody parses at a
// glance. The tier hops at 999_500 rather than 1_000_000 so nothing ever prints as `1000k`.
export function tokens(n: number): string {
  if (n < 1000) return `${n}`;
  const scaled = n < 999_500 ? n / 1000 : n / 1_000_000;
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${n < 999_500 ? 'k' : 'M'}`;
}

// Money. Sub-cent spend is real spend, so it reads `<$0.01` rather than a `$0.00` that
// would assert the work was free; nothing spent — or nothing known — yields the empty
// string, so a `·`-joined strip drops the field instead of printing a figure it cannot
// stand behind. Every caller relies on that empty string, so do not "tidy" it into `$0.00`.
export function usd(n: number): string {
  if (n >= 0.005) return `$${n.toFixed(2)}`;
  return n > 0 ? '<$0.01' : '';
}

// Every token the provider billed for: fresh input, output and both cache lanes. Cache
// reads are cheap, not free, and a long agent re-reads its whole context every turn —
// leaving them out would understate what it consumed by an order of magnitude.
export function usageTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}
