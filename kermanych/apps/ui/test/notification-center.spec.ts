import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { SkillImprovementChange } from '@kermanych/cloud';
import type { SkillImprovement, SkillImprovementEntry } from '@kermanych/core';
import { useNotificationCenter } from '../src/stores/notification-center';

// ЦУК's «Центр сповіщень» (docs/specs/2026-11-04-skill-self-improvement.md). What a consumer would
// notice going wrong: a toast for every old record at sign-in, a change that arrives twice and
// toasts twice, a toast whose «Переглянути» opens nothing, a mark that claims «seen» after the
// cloud refused it, and a rollback that touches the wrong copy or leaves the records «applied».
const listSkillImprovementEntries = vi.fn<(client: unknown) => Promise<SkillImprovementEntry[]>>();
const markSkillImprovementsSeen = vi.fn<(client: unknown, ids: readonly string[]) => Promise<void>>();
const listAppliedSkillImprovements = vi.fn<(client: unknown, name: string) => Promise<SkillImprovement[]>>();
const getSkillImprovement = vi.fn<(client: unknown, id: string) => Promise<SkillImprovement | undefined>>();
const getAiSkill = vi.fn();
const upsertAiSkill = vi.fn();
const deleteAiSkill = vi.fn();
const setSkillImprovementState = vi.fn();
const unbind = vi.fn();
let onChange: ((c: SkillImprovementChange) => void) | undefined;
const order: string[] = [];

vi.mock('@kermanych/cloud', () => ({
  listSkillImprovementEntries: (c: unknown) => {
    order.push('read');
    return listSkillImprovementEntries(c);
  },
  markSkillImprovementsSeen: (c: unknown, ids: readonly string[]) => markSkillImprovementsSeen(c, ids),
  listAppliedSkillImprovements: (c: unknown, n: string) => listAppliedSkillImprovements(c, n),
  getSkillImprovement: (c: unknown, id: string) => getSkillImprovement(c, id),
  getAiSkill: (...a: unknown[]) => getAiSkill(...a),
  upsertAiSkill: (...a: unknown[]) => upsertAiSkill(...a),
  deleteAiSkill: (...a: unknown[]) => deleteAiSkill(...a),
  setSkillImprovementState: (...a: unknown[]) => setSkillImprovementState(...a),
  subscribeSkillImprovements: (_c: unknown, _uid: string, cb: (c: SkillImprovementChange) => void) => {
    order.push('bind');
    onChange = cb;
    return unbind;
  },
}));
const auth = reactive<{ user: { id: string } | null; client: object }>({ user: { id: 'u1' }, client: {} });
vi.mock('../src/stores/auth', () => ({ useAuth: () => auth }));
const notify = vi.fn();
vi.mock('../src/stores/orchestrator', () => ({ useOrchestrator: () => ({ notify }) }));
const show = vi.fn();
vi.mock('../src/stores/assistant-overlay', () => ({ useAssistantOverlay: () => ({ show }) }));
// This machine's app updates, the column's other kind: none here, so these tests see skills only.
vi.mock('../src/stores/app-update', () => ({
  useAppUpdate: () => ({ updates: [], unseenUpdates: 0, markUpdatesSeen: vi.fn() }),
}));
vi.mock('../src/lib/preview', () => ({ IS_PREVIEW: false, PREVIEW_USER_ID: 'preview' }));
vi.mock('../src/boot/i18n', () => ({
  globalTr: { t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k) },
}));

function entry(id: string, over: Partial<SkillImprovementEntry> = {}): SkillImprovementEntry {
  return {
    id,
    skillName: 'qa-tester',
    summary: `summary ${id}`,
    sessionName: 'Додати онбординг',
    state: 'applied',
    createdAt: `2026-11-04T10:00:0${id.slice(1)}Z`,
    ...over,
  };
}

function record(id: string, over: Partial<SkillImprovement> = {}): SkillImprovement {
  return {
    ...entry(id),
    userId: 'u1',
    sessionId: 's1',
    reason: 'r',
    beforeBody: 'v0',
    edits: [{ find: 'v0', replace: 'v1' }],
    createdCopy: false,
    teamScope: 'default',
    stateAt: '2026-11-04T10:00:00Z',
    ...over,
  };
}

const settle = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

async function started(rows: SkillImprovementEntry[]) {
  listSkillImprovementEntries.mockResolvedValue(rows);
  const store = useNotificationCenter();
  store.start();
  await settle();
  return store;
}

describe('notification center', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    order.length = 0;
    onChange = undefined;
    auth.user = { id: 'u1' };
  });

  it('binds Realtime before the first read, lists newest first and raises no toast for old records', async () => {
    const store = await started([entry('i2'), entry('i1', { seenAt: '2026-11-04T11:00:00Z' })]);
    expect(order).toEqual(['bind', 'read']);
    expect(store.phase).toBe('ready');
    expect(store.items.map((i) => i.entry.id)).toEqual(['i2', 'i1']);
    expect(store.unread).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a new change joins the top and toasts once; its «Переглянути» opens the entry and marks it seen', async () => {
    const store = await started([entry('i1')]);
    markSkillImprovementsSeen.mockResolvedValue();
    onChange!({ kind: 'insert', entry: entry('i3') });
    onChange!({ kind: 'insert', entry: entry('i3') });
    expect(store.items.map((i) => i.entry.id)).toEqual(['i3', 'i1']);
    expect(notify).toHaveBeenCalledTimes(1);
    const [text, kind, , action] = notify.mock.calls[0]!;
    expect(text).toContain('qa-tester');
    expect(kind).toBe('info');

    action.run();
    expect(store.openId).toBe('i3');
    expect(show).toHaveBeenCalled();
    await settle();
    expect(markSkillImprovementsSeen).toHaveBeenCalledWith(auth.client, ['i3']);
    expect(store.items[0]!.entry.seenAt).toBeTruthy();
  });

  it('a change made on another machine updates the entry in place without a toast', async () => {
    const store = await started([entry('i1')]);
    onChange!({ kind: 'update', entry: entry('i1', { state: 'rolled_back' }) });
    expect(store.items[0]!.entry.state).toBe('rolled_back');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a mark the cloud refused leaves the entries new', async () => {
    const store = await started([entry('i2'), entry('i1')]);
    markSkillImprovementsSeen.mockRejectedValue(new Error('offline'));
    await expect(store.markAllSeen()).rejects.toThrow('offline');
    expect(store.unread).toBe(2);
  });

  it('signing out empties the column and drops the binding', async () => {
    const store = await started([entry('i1')]);
    auth.user = null;
    await nextTick();
    await settle();
    expect(store.items).toEqual([]);
    expect(unbind).toHaveBeenCalled();
  });

  describe('rollback', () => {
    it('rolling back the change that made the copy deletes the copy and settles every later change', async () => {
      const store = await started([entry('i2'), entry('i1')]);
      const a = record('i1', { createdCopy: true });
      const b = record('i2', { beforeBody: 'v1', edits: [{ find: 'v1', replace: 'v2' }] });
      getSkillImprovement.mockResolvedValue(a);
      listAppliedSkillImprovements.mockResolvedValue([a, b]);
      getAiSkill.mockResolvedValue({ body: 'v2', description: 'd' });

      const planned = await store.planRollback('i1');
      expect(planned.plan.later).toBe(1);
      await store.applyRollback(planned);

      expect(deleteAiSkill).toHaveBeenCalledWith(auth.client, { scope: 'user', id: 'u1' }, 'qa-tester');
      expect(upsertAiSkill).not.toHaveBeenCalled();
      expect(setSkillImprovementState).toHaveBeenCalledWith(auth.client, ['i1', 'i2'], 'rolled_back');
      expect(store.items.map((i) => i.entry.state)).toEqual(['rolled_back', 'rolled_back']);
    });

    it('rolling back a later change restores the text before it into the personal copy', async () => {
      const store = await started([entry('i2'), entry('i1')]);
      const a = record('i1', { createdCopy: true });
      const b = record('i2', { beforeBody: 'v1', edits: [{ find: 'v1', replace: 'v2' }] });
      getSkillImprovement.mockResolvedValue(b);
      listAppliedSkillImprovements.mockResolvedValue([a, b]);
      getAiSkill.mockResolvedValue({ body: 'v2', description: 'how we test' });

      await store.applyRollback(await store.planRollback('i2'));

      expect(upsertAiSkill).toHaveBeenCalledWith(auth.client, {
        owner: { scope: 'user', id: 'u1' },
        name: 'qa-tester',
        description: 'how we test',
        body: 'v1',
        enabled: true,
      });
      expect(setSkillImprovementState).toHaveBeenCalledWith(auth.client, ['i2'], 'rolled_back');
      expect(store.items.map((i) => i.entry.state)).toEqual(['rolled_back', 'applied']);
    });
  });
});
