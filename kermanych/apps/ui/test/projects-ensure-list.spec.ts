import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { CloudProject, Workspace } from '@kermanych/cloud';
import { useProjects } from '../src/stores/projects';

// A run whose cold-start cloud read failed (the machine woke without a network) used to keep
// that failure for its whole life: the session's project never resolved to a workspace, so
// «Створити задачу» from a finding opened with empty, dead project and assignee pickers.
const listProjects = vi.fn<(client: unknown) => Promise<CloudProject[]>>();
const listWorkspaces = vi.fn<(client: unknown) => Promise<Workspace[]>>();

vi.mock('@kermanych/cloud', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listProjects: (c: unknown) => listProjects(c),
  listWorkspaces: (c: unknown) => listWorkspaces(c),
}));
vi.mock('../src/stores/auth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, ready: Promise.resolve(), client: {} }),
}));
vi.mock('../src/stores/orchestrator', () => ({
  useOrchestrator: () => ({ projectWorkspace: {}, setProjectWorkspaces: vi.fn(), notify: vi.fn() }),
}));
vi.mock('../src/lib/api', () => ({ api: { syncProjects: vi.fn(async () => undefined) } }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));

const ws: Workspace = { id: 'w1', name: 'FS', ownerId: 'u1' } as Workspace;
const be = { id: 'p1', name: 'BE', workspaceId: 'w1' } as CloudProject;

describe('projects.ensureList', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listProjects.mockReset();
    listWorkspaces.mockReset();
    listWorkspaces.mockResolvedValue([ws]);
  });

  it('re-reads a list the cold start failed to read', async () => {
    const projects = useProjects();
    listProjects.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await projects.load();
    expect(projects.offlineError).toBe('Failed to fetch');
    expect(projects.byId.has('p1')).toBe(false);

    listProjects.mockResolvedValueOnce([be]);
    await projects.ensureList();
    expect(projects.byId.get('p1')?.workspaceId).toBe('w1');
    expect(projects.listRead).toBe(true);
    expect(projects.offlineError).toBeNull();
  });

  it('joins a read already in flight and does not read a list it holds', async () => {
    const projects = useProjects();
    const { promise, resolve } = Promise.withResolvers<CloudProject[]>();
    listProjects.mockReturnValueOnce(promise);
    const first = projects.load();
    const joined = projects.ensureList();
    resolve([be]);
    await Promise.all([first, joined]);
    expect(listProjects).toHaveBeenCalledTimes(1);

    await projects.ensureList();
    expect(listProjects).toHaveBeenCalledTimes(1);
  });
});
