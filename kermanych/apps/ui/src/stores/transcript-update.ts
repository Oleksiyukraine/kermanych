// apps/ui/src/stores/transcript-update.ts
import type { ServerEvent, TranscriptEntry } from '@kermanych/core';

type Update = Extract<ServerEvent, { type: 'transcript_update' }>;

// Patch the finished tool entry in place. Returns the SAME array when nothing
// matched, so the store can skip a pointless reactive write.
export function applyTranscriptUpdate(list: TranscriptEntry[], e: Update): TranscriptEntry[] {
  let hit = false;
  const next = list.map((x) => {
    if (x.kind !== 'tool' || x.id !== e.id) return x;
    hit = true;
    return {
      ...x,
      status: e.status,
      ...(e.stat === undefined ? {} : { stat: e.stat }),
      ...(e.count === undefined ? {} : { count: e.count }),
      ...(e.ms === undefined ? {} : { ms: e.ms }),
      ...(e.detail === undefined ? {} : { detail: e.detail }),
    };
  });
  return hit ? next : list;
}
