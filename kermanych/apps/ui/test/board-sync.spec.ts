import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Task, TaskChange, TaskVersion } from '@kermanych/cloud';
import { useBoard } from '../src/stores/board';

// The board's reconcile reads `id, updated_at` and only the rows that moved, and the report
// blobs reach a card only while a screen holds it (spec 2026-11-03-board-egress-and-lag). What a
// consumer would notice going wrong: a card someone deleted that never leaves, a card that
// vanishes right after it was created, a checklist that blinks out on a status push or never
// catches up, and a stale read that rolls a card back.
const listTasks = vi.fn<(client: unknown, projectIds: string[]) => Promise<Task[]>>();
const listTaskVersions = vi.fn<(client: unknown, projectIds: string[]) => Promise<TaskVersion[]>>();
const listTasksByIds = vi.fn<(client: unknown, ids: readonly string[]) => Promise<Task[]>>();
const getTask = vi.fn<(client: unknown, id: string) => Promise<Task | undefined>>();
let onChange: ((c: TaskChange) => void) | undefined;

vi.mock('@kermanych/cloud', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listTasks: (c: unknown, p: string[]) => listTasks(c, p),
  listTaskVersions: (c: unknown, p: string[]) => listTaskVersions(c, p),
  listTasksByIds: (c: unknown, ids: readonly string[]) => listTasksByIds(c, ids),
  getTask: (c: unknown, id: string) => getTask(c, id),
  subscribeTasks: (_c: unknown, _p: string[], cb: (c: TaskChange) => void) => {
    onChange = cb;
    return () => {};
  },
}));
vi.mock('../src/stores/auth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, ready: Promise.resolve(), client: {} }),
}));
vi.mock('../src/stores/projects', () => ({ useProjects: () => ({ projects: [{ id: 'p1' }], load: vi.fn() }) }));
vi.mock('../src/stores/orchestrator', () => ({ useOrchestrator: () => ({ notify: vi.fn() }) }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));

function card(id: string, at: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'p1',
    title: id,
    status: 'backlog',
    worktree: true,
    hidden: false,
    deepAnalysis: false,
    design: false,
    autoRun: false,
    createdAt: `2026-11-01T00:00:0${id.slice(1)}.000Z`,
    updatedAt: at,
    ...over,
  };
}
const T0 = '2026-11-03T10:00:00.000000+00:00';
const T1 = '2026-11-03T10:01:00.000000+00:00';
const T2 = '2026-11-03T10:02:00.000000+00:00';
const versions = (...rows: Task[]): TaskVersion[] => rows.map((t) => ({ id: t.id, updatedAt: t.updatedAt }));
const checklist = (text: string) => ({ generatedAt: T0, items: [{ id: 'q1', text, checked: false }] });
const settle = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

describe('board reconcile', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const m of [listTasks, listTaskVersions, listTasksByIds, getTask]) m.mockReset();
    onChange = undefined;
  });

  it('reads the full list once; a quiet reconcile reads only versions and writes nothing', async () => {
    const board = useBoard();
    const rows = [card('t1', T0), card('t2', T0)];
    listTasks.mockResolvedValue(rows);
    await board.load();
    const before = board.tasks;

    listTaskVersions.mockResolvedValue(versions(...rows));
    await board.load();

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(listTasksByIds).not.toHaveBeenCalled();
    expect(board.tasks).toBe(before);
  });

  it('refetches only moved and new cards and drops the ones the cloud no longer returns', async () => {
    const board = useBoard();
    listTasks.mockResolvedValue([card('t1', T0), card('t2', T0), card('t3', T0)]);
    await board.load();

    const moved = card('t1', T1, { status: 'thinking' });
    const fresh = card('t4', T1);
    listTaskVersions.mockResolvedValue(versions(moved, card('t3', T0), fresh));
    listTasksByIds.mockResolvedValue([moved, fresh]);
    await board.load();

    expect(listTasksByIds).toHaveBeenCalledWith({}, ['t1', 't4']);
    expect(board.tasks.map((t) => [t.id, t.status])).toEqual([
      ['t1', 'thinking'],
      ['t3', 'backlog'],
      ['t4', 'backlog'],
    ]);
  });

  it('keeps a card Realtime delivered while the versions were being read', async () => {
    const board = useBoard();
    listTasks.mockResolvedValue([card('t1', T0)]);
    await board.subscribe({ intervalMs: 3_600_000 });
    listTaskVersions.mockImplementation(async () => {
      onChange?.({ kind: 'upsert', task: card('t9', T1) });
      return versions(card('t1', T0));
    });

    await board.load();

    expect(board.tasks.map((t) => t.id)).toEqual(['t1', 't9']);
    board.unsubscribe();
  });

  it('never lets an older read replace a newer row', async () => {
    const board = useBoard();
    listTasks.mockResolvedValue([card('t1', T0)]);
    await board.subscribe({ intervalMs: 3_600_000 });
    onChange?.({ kind: 'upsert', task: card('t1', T2, { status: 'done' }) });
    listTaskVersions.mockResolvedValue(versions(card('t1', T1)));
    listTasksByIds.mockResolvedValue([card('t1', T1, { status: 'thinking' })]);

    await board.load();

    expect(board.tasks[0]!.status).toBe('done');
    board.unsubscribe();
  });
});

describe('board card details', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const m of [listTasks, listTaskVersions, listTasksByIds, getTask]) m.mockReset();
    onChange = undefined;
  });

  it('a held card reads its checklist, keeps it across a status push and re-reads it when the row moved', async () => {
    const board = useBoard();
    listTasks.mockResolvedValue([card('t1', T0)]);
    await board.subscribe({ intervalMs: 3_600_000 });
    expect(board.detailsLoaded('t1')).toBe(false);

    getTask.mockResolvedValueOnce(card('t1', T0, { qaChecklist: checklist('first') }));
    const release = board.holdDetails('t1');
    await settle();
    expect(board.detailsLoaded('t1')).toBe(true);
    expect(board.tasks[0]!.qaChecklist?.items[0]!.text).toBe('first');

    // A teammate's write arrives as a light row: the checklist stays on screen meanwhile…
    const pending = Promise.withResolvers<Task>();
    getTask.mockImplementationOnce(() => pending.promise);
    onChange?.({ kind: 'upsert', task: card('t1', T1, { status: 'in_review' }) });
    expect(board.tasks[0]!.status).toBe('in_review');
    expect(board.tasks[0]!.qaChecklist?.items[0]!.text).toBe('first');

    // …and the full row that moved it replaces it.
    pending.resolve(card('t1', T1, { status: 'in_review', qaChecklist: checklist('second') }));
    await settle();
    expect(board.tasks[0]!.qaChecklist?.items[0]!.text).toBe('second');
    expect(getTask).toHaveBeenCalledTimes(2);

    // Released: the next change of the row costs no full read.
    release();
    onChange?.({ kind: 'upsert', task: card('t1', T2, { status: 'done' }) });
    await settle();
    expect(getTask).toHaveBeenCalledTimes(2);
    board.unsubscribe();
  });

  it('holding a card the board has not read yet reads it once the card arrives', async () => {
    const board = useBoard();
    listTasks.mockResolvedValue([]);
    await board.subscribe({ intervalMs: 3_600_000 });
    board.holdDetails('t1');
    expect(getTask).not.toHaveBeenCalled();

    getTask.mockResolvedValueOnce(card('t1', T0, { qaChecklist: checklist('late') }));
    onChange?.({ kind: 'upsert', task: card('t1', T0) });
    await settle();

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(board.tasks[0]!.qaChecklist?.items[0]!.text).toBe('late');
    board.unsubscribe();
  });
});
