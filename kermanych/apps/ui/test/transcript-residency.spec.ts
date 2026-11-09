// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, ref } from 'vue';
import type { ServerEvent, Session, TranscriptEntry } from '@kermanych/core';

// Which transcripts the orchestrator store keeps in memory: only the ones opened, at most
// TRANSCRIPT_CAP of them, never one on screen, and none of a session the api no longer has.

const history: Record<string, TranscriptEntry[]> = {};
const sendMessage = vi.fn();
let reduce: ((e: ServerEvent) => void) | undefined;
vi.mock('../src/lib/api', () => ({
  api: {
    loadTranscript: (id: string) => Promise.resolve(history[id] ?? []),
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

import { TRANSCRIPT_CAP, useOrchestrator } from '../src/stores/orchestrator';
import { useHeldTranscript } from '../src/composables/useHeldTranscript';

const text = (id: string, body: string, at = Date.now()): TranscriptEntry => ({ kind: 'assistant_text', id, at, text: body });
const session = (id: string) => ({ id, projectId: 'p1', name: id, task: '', worktreePath: '', branch: id, worktree: true, kind: 'agent', status: 'done' }) as Session;
const append = (sessionId: string, entry: TranscriptEntry) => reduce!({ type: 'transcript_append', sessionId, entry });
const ids = (n: number, prefix = 's') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function connected() {
  const store = useOrchestrator();
  store.connect();
  return store;
}

// The store is the active pinia's one, so this loads into whatever the test is looking at.
async function loadMany(list: string[]): Promise<void> {
  for (const id of list) await useOrchestrator().loadTranscript(id);
}

describe('orchestrator transcripts — only opened sessions are kept', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const k of Object.keys(history)) delete history[k];
    sendMessage.mockReset();
  });

  it('ignores an append for a session never opened, and opening it loads the whole history', async () => {
    const store = connected();
    history.s1 = [text('e0', 'раніше'), text('e1', 'щойно')];

    append('s1', text('e1', 'щойно'));
    expect(store.transcripts.s1).toBeUndefined();

    await store.loadTranscript('s1');
    expect(store.transcripts.s1?.map((e) => e.id)).toEqual(['e0', 'e1']);

    append('s1', text('e2', 'далі'));
    expect(store.transcripts.s1?.map((e) => e.id)).toEqual(['e0', 'e1', 'e2']);
  });

  it('still settles a «надсилаю…» bubble from the append of a session never opened', async () => {
    const store = connected();
    const { promise, resolve } = Promise.withResolvers<void>();
    sendMessage.mockReturnValue(promise);
    const sent = store.sendMessage('s1', 'зроби тести', 'prompt');

    reduce!({ type: 'transcript_append', sessionId: 's1', entry: { kind: 'user_text', id: 'u1', at: Date.now(), text: 'зроби тести' } });
    expect(store.outgoing.s1).toBeUndefined();
    expect(store.transcripts.s1).toBeUndefined();
    resolve();
    await sent;
  });

  it('a snapshot drops the transcripts and bubbles of sessions it no longer lists', async () => {
    const store = connected();
    await loadMany(['gone', 'kept']);
    sendMessage.mockReturnValue(Promise.withResolvers<void>().promise);
    void store.sendMessage('gone', 'привіт', 'prompt');

    reduce!({ type: 'snapshot', projects: [], sessions: [session('kept')], subagents: {}, previews: {} });

    expect(store.transcripts.gone).toBeUndefined();
    expect(store.outgoing.gone).toBeUndefined();
    expect(store.transcripts.kept).toEqual([]);
  });
});

describe('orchestrator transcripts — bounded residency', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('evicts the least recently used transcript past the cap', async () => {
    const store = connected();
    await loadMany(ids(TRANSCRIPT_CAP));
    // Output keeps s0 in use, so s1 is now the least recently used.
    append('s0', text('e1', 'ще працюю'));

    await store.loadTranscript('extra');

    expect(Object.keys(store.transcripts)).toHaveLength(TRANSCRIPT_CAP);
    expect(store.transcripts.s1).toBeUndefined();
    expect(store.transcripts.s0).toBeDefined();
    expect(store.transcripts.extra).toBeDefined();
  });

  it('never evicts a held transcript, and lets it go once released', async () => {
    const store = connected();
    await loadMany(ids(TRANSCRIPT_CAP));
    const release = store.holdTranscript('s0');

    await loadMany(ids(TRANSCRIPT_CAP, 'x'));
    expect(store.transcripts.s0).toBeDefined();
    expect(Object.keys(store.transcripts)).toHaveLength(TRANSCRIPT_CAP);

    // A second holder keeps it after the first lets go (twice: the release is idempotent).
    const again = store.holdTranscript('s0');
    release();
    release();
    await loadMany(ids(TRANSCRIPT_CAP, 'y'));
    expect(store.transcripts.s0).toBeDefined();

    again();
    await loadMany(ids(TRANSCRIPT_CAP, 'z'));
    expect(store.transcripts.s0).toBeUndefined();
  });

  it('useHeldTranscript follows the shown id and lets go when its scope ends', async () => {
    const store = connected();
    const shown = ref<string | undefined>('a');
    const scope = effectScope();
    scope.run(() => useHeldTranscript(() => shown.value));
    await loadMany(['a', 'b']);

    shown.value = 'b';
    await loadMany(ids(TRANSCRIPT_CAP));
    expect(store.transcripts.a).toBeUndefined();
    expect(store.transcripts.b).toBeDefined();

    scope.stop();
    await loadMany(ids(TRANSCRIPT_CAP, 'x'));
    expect(store.transcripts.b).toBeUndefined();
  });
});
