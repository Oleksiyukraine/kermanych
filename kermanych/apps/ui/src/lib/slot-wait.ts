import type { Session } from '@kermanych/core';

type Tr = (key: string, named?: Record<string, unknown>) => string;

// A session waiting for an agent slot stays `queued` (spec decision 5), which everywhere else
// reads «Запускаю…». Every status surface asks this first so the card, the panel and the
// status row say the same thing. The queue position is shown only when someone is ahead.
export function slotWaitLabel(s: Pick<Session, 'slotWait'>, t: Tr): string | undefined {
  const w = s.slotWait;
  if (!w) return undefined;
  const base = t('agents.slotWait.waiting', { running: w.running, limit: w.limit });
  return w.position > 1 ? `${base} · ${t('agents.slotWait.position', { position: w.position })}` : base;
}
