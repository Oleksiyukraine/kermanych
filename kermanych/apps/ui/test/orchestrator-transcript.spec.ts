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

  it('applies a falsy count, ms and stat instead of treating them as absent', () => {
    const next = applyTranscriptUpdate(pending, {
      type: 'transcript_update', sessionId: 's1', id: 'c1', status: 'ok',
      stat: '0 збігів', count: 0, ms: 0,
    });
    expect(next[0]).toMatchObject({ status: 'ok', stat: '0 збігів', count: 0, ms: 0 });
    // `'0 збігів'` is truthy; only an empty stat distinguishes "present and falsy" from
    // "omitted", and the patch must still overwrite the previous value with it.
    const cleared = applyTranscriptUpdate(next, {
      type: 'transcript_update', sessionId: 's1', id: 'c1', status: 'ok', stat: '',
    });
    expect(cleared[0]).toMatchObject({ stat: '' });
  });

  it('adopts the improved target the result reported', () => {
    const next = applyTranscriptUpdate(pending, {
      type: 'transcript_update', sessionId: 's1', id: 'c1', status: 'ok',
      target: 'src/lib/tip.ts', stat: '+7 \u22125',
    });
    expect(next[0]).toMatchObject({ target: 'src/lib/tip.ts', stat: '+7 \u22125' });
  });

  it('keeps the call-time target when the patch omits one', () => {
    const next = applyTranscriptUpdate(pending, { type: 'transcript_update', sessionId: 's1', id: 'c1', status: 'ok' });
    expect(next[0]).toMatchObject({ target: 'lib/tip.ts' });
  });

  it('keeps fields a later status-only update omits', () => {
    // `detail` is the heaviest of them: a rebuild that forgets to spread the prior entry
    // would silently empty the expanded card, so it is pinned here too.
    const done: TranscriptEntry[] = [
      {
        kind: 'tool', id: 'c1', at: 1, tool: 'edit', status: 'ok', stat: '+7 \u22125', count: 12, ms: 40,
        detail: { lines: [{ t: 'add', n: '28', text: 'x' }], totalLines: 31 },
      },
    ];
    const next = applyTranscriptUpdate(done, { type: 'transcript_update', sessionId: 's1', id: 'c1', status: 'error' });
    expect(next[0]).toMatchObject({ status: 'error', stat: '+7 \u22125', count: 12, ms: 40 });
    expect(next[0]?.kind === 'tool' ? next[0].detail : undefined).toEqual({
      lines: [{ t: 'add', n: '28', text: 'x' }], totalLines: 31,
    });
  });
});
