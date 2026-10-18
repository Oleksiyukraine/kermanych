// @vitest-environment happy-dom
// A routine run of this machine reaches the window as a `routine_run` socket event
// (docs/specs/2026-10-16-routines.md): the Routines screen watches `lastRoutineRun` to refetch,
// and the end of a run is toasted wherever the operator is.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ServerEvent } from '@kermanych/core';

const socket = vi.hoisted(() => ({ reduce: undefined as undefined | ((e: ServerEvent) => void) }));
vi.mock('../src/lib/socket', () => ({
  connectSocket: (reduce: (e: ServerEvent) => void) => {
    socket.reduce = reduce;
    return {};
  },
}));
vi.mock('../src/lib/api', () => ({ api: { models: async () => [] } }));

import { useOrchestrator } from '../src/stores/orchestrator';

const event = (status: 'running' | 'succeeded' | 'failed'): ServerEvent => ({
  type: 'routine_run',
  workspaceId: 'w1',
  routineId: 'r1',
  routineName: 'Weekly notes',
  runId: 'x1',
  status,
});

beforeEach(() => {
  setActivePinia(createPinia());
  socket.reduce = undefined;
});

describe('routine_run events', () => {
  it('records a started run without a toast, and toasts its end', () => {
    const store = useOrchestrator();
    store.connect();
    socket.reduce!(event('running'));
    expect(store.lastRoutineRun?.status).toBe('running');
    expect(store.toasts).toEqual([]);

    socket.reduce!(event('succeeded'));
    expect(store.lastRoutineRun?.status).toBe('succeeded');
    expect(store.toasts).toEqual([expect.objectContaining({ kind: 'info', message: 'Рутина «Weekly notes» виконана' })]);
  });

  it('toasts a failed run as an error', () => {
    const store = useOrchestrator();
    store.connect();
    socket.reduce!(event('failed'));
    expect(store.toasts).toEqual([expect.objectContaining({ kind: 'error' })]);
  });
});
