import { describe, expect, it } from 'vitest';
import { applyTranscriptUpdate } from '../src/stores/transcript-update';
import type { TranscriptEntry } from '@kermanych/core';

describe('applyTranscriptUpdate', () => {
  const pending: TranscriptEntry[] = [
    { kind: 'tool', id: 'c1', at: 1, tool: 'edit', status: 'pending', target: 'lib/tip.ts' },
  ];

  it('copies stat, count, ms and detail onto the matching tool entry', () => {
    const next = applyTranscriptUpdate(pending, {
      type: 'transcript_update', sessionId: 's1', id: 'c1', status: 'ok',
      stat: '+7 \u22125', count: 12, ms: 40,
      detail: { lines: [{ t: 'add', n: '28', text: 'x' }], totalLines: 31 },
    });
    const updated = next[0];
    expect(updated).toMatchObject({ status: 'ok', stat: '+7 \u22125', count: 12, ms: 40 });
    expect(updated?.kind === 'tool' ? updated.detail?.totalLines : undefined).toBe(31);
  });

  it('leaves the list untouched when no entry matches', () => {
    const next = applyTranscriptUpdate(pending, { type: 'transcript_update', sessionId: 's1', id: 'nope', status: 'ok' });
    expect(next).toBe(pending);
  });
});
