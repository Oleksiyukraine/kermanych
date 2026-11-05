// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ServerEvent, Session, SessionStatus } from '@kermanych/core';
import { useOrchestrator } from '../src/stores/orchestrator';

let reduce: ((e: ServerEvent) => void) | undefined;
vi.mock('../src/lib/api', () => ({ api: { models: () => Promise.resolve([]) } }));
vi.mock('../src/lib/socket', () => ({
  connectSocket: (fn: (e: ServerEvent) => void) => {
    reduce = fn;
    return {};
  },
}));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k } }));

function session(id: string, status: SessionStatus): Session {
  return {
    id, projectId: 'p1', name: id, task: '', worktreePath: '', branch: `feat/${id}`,
    worktree: true, kind: 'agent', status,
  } as Session;
}

function update(id: string, status: SessionStatus): void {
  reduce!({ type: 'session_update', session: session(id, status) });
}

describe('orchestrator — a completed session closes its chat', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('clears the selection when the open session becomes merged', () => {
    const store = useOrchestrator();
    store.connect();
    update('s1', 'done');
    store.selectSession('s1');

    update('s1', 'merged');
    expect(store.selectedSessionId).toBeUndefined();
  });

  it('keeps another open chat when a different session completes', () => {
    const store = useOrchestrator();
    store.connect();
    update('s1', 'done');
    update('s2', 'thinking');
    store.selectSession('s2');

    update('s1', 'merged');
    expect(store.selectedSessionId).toBe('s2');
  });

  it('lets an already merged session be opened and stay open on a later update', () => {
    const store = useOrchestrator();
    store.connect();
    update('s1', 'merged');
    store.selectSession('s1');

    update('s1', 'merged');
    expect(store.selectedSessionId).toBe('s1');
  });
});
