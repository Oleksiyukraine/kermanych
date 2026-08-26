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

// A quota window's spend. Zero here is a real statement — the provider says the window is
// untouched — so unlike `usd` this never returns the empty string; but a spent tenth of a
// percent must not read as `0%`, so it gets the same floor marker money does.
export function percent(n: number): string {
  if (n >= 1) return `${Math.round(n)}%`;
  return n > 0 ? '<1%' : '0%';
}

// A plan window's name, short enough to sit under the account name: `5г`, `7д`, `міс`. The
// id comes from the provider (`5h`, `7d`, `monthly`), so parse the shape rather than
// enumerate the providers — an unknown window still renders, under its own id.
export function planWindow(id: string): string {
  const m = /^(\d+)([hdw])$/i.exec(id);
  if (m) return `${m[1]}${{ h: 'г', d: 'д', w: 'тиж' }[m[2]!.toLowerCase()]}`;
  if (/^month(ly)?$/i.test(id)) return 'міс';
  return id;
}

// Every token the provider billed for: fresh input, output and both cache lanes. Cache
// reads are cheap, not free, and a long agent re-reads its whole context every turn —
// leaving them out would understate what it consumed by an order of magnitude.
export function usageTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}
