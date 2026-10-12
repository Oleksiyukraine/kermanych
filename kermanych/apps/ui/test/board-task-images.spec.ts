import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Task, TaskPatch } from '@kermanych/cloud';
import { useBoard } from '../src/stores/board';

// The launcher puts the images its launch sent onto the card after the session started
// (spec 2026-10-12, decision 11). Two things a consumer would notice: a replace instead of an
// append loses the images uploaded from «Дошка», and a failed write that leaves its uploads
// behind fills the bucket with objects no card names. Neither may throw into the launcher.
const uploadTaskImages = vi.fn<(client: unknown, projectId: string, files: File[]) => Promise<string[]>>();
const patchTask = vi.fn<(client: unknown, id: string, patch: TaskPatch) => Promise<Task>>();
const remove = vi.fn<(paths: string[]) => Promise<unknown>>();
const notify = vi.fn();

vi.mock('@kermanych/cloud', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadTaskImages: (client: unknown, projectId: string, files: File[]) => uploadTaskImages(client, projectId, files),
  patchTask: (client: unknown, id: string, patch: TaskPatch) => patchTask(client, id, patch),
}));
vi.mock('../src/stores/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    ready: Promise.resolve(),
    client: { storage: { from: () => ({ remove: (paths: string[]) => remove(paths) }) } },
  }),
}));
vi.mock('../src/stores/projects', () => ({ useProjects: () => ({ projects: [], load: vi.fn() }) }));
vi.mock('../src/stores/orchestrator', () => ({ useOrchestrator: () => ({ notify }) }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));

const card: Task = {
  id: 't1',
  projectId: 'p1',
  title: 'Card',
  status: 'thinking',
  worktree: true,
  hidden: false,
  deepAnalysis: false,
  imagePaths: ['p1/from-board.png'],
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-12T09:00:00.000Z',
};
const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });

describe('board.addTaskImages', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    uploadTaskImages.mockReset();
    patchTask.mockReset();
    remove.mockReset().mockResolvedValue({});
    notify.mockReset();
  });

  it('appends the uploads to the images the card already holds, into its own project', async () => {
    const board = useBoard();
    board.tasks = [card];
    uploadTaskImages.mockResolvedValue(['p1/shot.png']);
    patchTask.mockImplementation(async (_c, _id, patch) => ({ ...card, imagePaths: patch.imagePaths ?? [] }));

    expect(await board.addTaskImages('t1', [file])).toBe(true);
    expect(uploadTaskImages).toHaveBeenCalledWith(expect.anything(), 'p1', [file]);
    expect(patchTask).toHaveBeenCalledWith(expect.anything(), 't1', {
      imagePaths: ['p1/from-board.png', 'p1/shot.png'],
    });
    expect(board.tasks[0]?.imagePaths).toEqual(['p1/from-board.png', 'p1/shot.png']);
  });

  it('a refused patch removes the just-uploaded objects, keeps the card as it was and says why', async () => {
    const board = useBoard();
    board.tasks = [card];
    uploadTaskImages.mockResolvedValue(['p1/shot.png']);
    patchTask.mockRejectedValue(new Error('permission denied'));

    expect(await board.addTaskImages('t1', [file])).toBe(false);
    expect(remove).toHaveBeenCalledWith(['p1/shot.png']);
    expect(board.tasks[0]?.imagePaths).toEqual(['p1/from-board.png']);
    expect(notify).toHaveBeenCalledWith('permission denied', 'error');
  });

  it('a failed upload writes nothing and resolves instead of throwing', async () => {
    const board = useBoard();
    board.tasks = [card];
    uploadTaskImages.mockRejectedValue(new Error('storage down'));

    expect(await board.addTaskImages('t1', [file])).toBe(false);
    expect(patchTask).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('storage down', 'error');
  });
});
