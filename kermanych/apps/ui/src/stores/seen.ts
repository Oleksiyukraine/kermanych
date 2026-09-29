// apps/ui/src/stores/seen.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Session } from '@kermanych/core';
import { isUnseen as unseenSince } from '../lib/attention';
import { useOrchestrator } from './orchestrator';

// Which finished sessions the operator has already looked at, so the sidebar can mark the
// ones with a result nobody has read (lib/attention.ts). Per machine, not per account: the
// sessions themselves live in this machine's registry, and their ids are UUIDs, so no two
// accounts ever share one.
//
//   seen      — session id → the `lastActivityAt` it had when the operator last viewed it
//   baseline  — when this machine first ran with the mark. Anything that last moved before
//               it counts as read, or the upgrade would light up every historic `done`.
const SEEN_KEY = 'kermanych.sessions.seen';
const BASELINE_KEY = 'kermanych.sessions.seenBaseline';

function readSeen(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, at] of Object.entries(parsed)) if (typeof at === 'string') out[id] = at;
    return out;
  } catch {
    // A corrupt entry is not worth a crash; the next markSeen overwrites it.
    return {};
  }
}

function readBaseline(): string {
  const stored = localStorage.getItem(BASELINE_KEY);
  if (stored && !Number.isNaN(Date.parse(stored))) return stored;
  const now = new Date().toISOString();
  try {
    localStorage.setItem(BASELINE_KEY, now);
  } catch {
    /* storage blocked: the baseline is simply re-taken on the next launch */
  }
  return now;
}

export const useSeen = defineStore('seen', () => {
  const store = useOrchestrator();
  const seen = ref<Record<string, string>>(readSeen());
  const baseline = readBaseline();

  // Record that the operator has looked at `id` as it stood at `at`. Never moves a mark
  // backwards, and drops marks for sessions that no longer exist while it writes — the map
  // would otherwise grow by one entry per agent ever run on this machine.
  function markSeen(id: string, at: string): void {
    const prev = seen.value[id];
    if (prev && Date.parse(prev) >= Date.parse(at)) return;
    const live = new Set(store.sessions.map((s) => s.id));
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(seen.value)) if (live.has(k)) next[k] = v;
    next[id] = at;
    seen.value = next;
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* storage full or blocked: the mark just won't survive a reload */
    }
  }

  function isUnseen(s: Session): boolean {
    return unseenSince(s.lastActivityAt, seen.value[s.id], baseline);
  }

  return { markSeen, isUnseen };
});
