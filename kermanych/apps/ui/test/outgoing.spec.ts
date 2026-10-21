// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ServerEvent, TranscriptEntry } from '@kermanych/core';
import { unsettledOutgoing, type OutgoingMessage } from '../src/lib/outgoing';
import { PENDING_TIMEOUT_MS } from '../src/stores/pending';
import { useOrchestrator } from '../src/stores/orchestrator';

const sendMessage = vi.fn();
let reduce: ((e: ServerEvent) => void) | undefined;
vi.mock('../src/lib/api', () => ({
  api: {
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    models: () => Promise.resolve([]),
  },
}));
vi.mock('../src/lib/socket', () => ({
  connectSocket: (fn: (e: ServerEvent) => void) => {
    reduce = fn;
    return {};
  },
}));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k } }));

function user(id: string, text: string, at: number): TranscriptEntry {
  return { kind: 'user_text', id, at, text };
}
function out(id: string, text: string, at: number): OutgoingMessage {
  return { id, text, images: [], at };
}

describe('unsettledOutgoing', () => {
  it('drops a bubble once the transcript holds the same text sent after it began', () => {
    expect(unsettledOutgoing([out('o1', 'привіт', 1000)], [user('e1', 'привіт', 1500)])).toEqual([]);
  });

  it('keeps a bubble an OLDER identical message in the history cannot settle', () => {
    const left = unsettledOutgoing([out('o1', 'так', 10_000)], [user('e0', 'так', 2_000)]);
    expect(left.map((m) => m.id)).toEqual(['o1']);
  });

  it('settles two identical messages one entry at a time, oldest first', () => {
    const list = [out('o1', 'далі', 1000), out('o2', 'далі', 1100)];
    expect(unsettledOutgoing(list, [user('e1', 'далі', 1200)]).map((m) => m.id)).toEqual(['o2']);
    expect(unsettledOutgoing(list, [user('e1', 'далі', 1200), user('e2', 'далі', 1300)])).toEqual([]);
  });
});

describe('orchestrator.sendMessage — the «надсилаю…» bubble', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessage.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('shows the bubble while the agent wakes and removes it when the real entry arrives', async () => {
    const store = useOrchestrator();
    store.connect();
    let answer!: () => void;
    sendMessage.mockReturnValue(new Promise<void>((r) => (answer = r)));

    const p = store.sendMessage('s1', 'зроби тести', 'prompt');
    expect(store.outgoing.s1?.map((m) => m.text)).toEqual(['зроби тести']);

    reduce!({ type: 'transcript_append', sessionId: 's1', entry: user('e1', 'зроби тести', Date.now()) });
    expect(store.outgoing.s1).toBeUndefined();
    answer();
    await p;
  });

  it('removes the bubble and rethrows when the send fails, so the caller can restore the text', async () => {
    const store = useOrchestrator();
    sendMessage.mockRejectedValue(new Error('omp не відповідає'));
    await expect(store.sendMessage('s1', 'текст', 'prompt')).rejects.toThrow('omp не відповідає');
    expect(store.outgoing.s1).toBeUndefined();
  });

  it('drops a bubble the transcript never confirms after the timeout', async () => {
    const store = useOrchestrator();
    sendMessage.mockResolvedValue(undefined);
    await store.sendMessage('s1', 'у TUI', 'prompt');
    expect(store.outgoing.s1).toHaveLength(1);
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS);
    expect(store.outgoing.s1).toBeUndefined();
  });
});
