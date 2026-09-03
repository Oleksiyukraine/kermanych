import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useReleaseNotes } from '../src/stores/release-notes';

// A release-notes generation belongs to the STORE, not to the screen that started it: the
// operator presses «Згенерувати», walks to another section, and the document still has to
// arrive. These tests are that promise stated as behaviour — every one of them runs with no
// component mounted at all, which is exactly the situation the old page-owned promise could
// not survive.
const generateReleaseNotes = vi.fn();
const createWorkspaceReleaseNote = vi.fn();
const notify = vi.fn();

vi.mock('../src/lib/api', () => ({
  api: { generateReleaseNotes: (ask: unknown) => generateReleaseNotes(ask) },
}));
vi.mock('../src/stores/auth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, client: {}, ready: Promise.resolve() }),
}));
vi.mock('../src/stores/orchestrator', () => ({
  useOrchestrator: () => ({ notify }),
}));
vi.mock('@kermanych/cloud', () => ({
  createWorkspaceReleaseNote: (client: unknown, input: unknown) =>
    createWorkspaceReleaseNote(client, input),
  listWorkspaceReleaseNotes: vi.fn(),
  patchWorkspaceReleaseNote: vi.fn(),
}));

const ask = {
  workspaceId: 'w1',
  workspaceName: 'Acme',
  projectId: 'p1',
  projectName: 'Web',
  branch: 'main',
  rangeFrom: '2026-08-01',
  rangeTo: '2026-08-31',
};

// The cloud echoes an insert back as a stored row; only the columns the screen reads matter.
function stored(client: unknown, input: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'n1',
    workspaceId: 'w1',
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...input,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  generateReleaseNotes.mockReset();
  createWorkspaceReleaseNote.mockReset();
  notify.mockReset();
});

describe('release notes generation', () => {
  it('shows the job the moment it starts and stores the note when it finishes', async () => {
    const gate = Promise.withResolvers<unknown>();
    generateReleaseNotes.mockReturnValue(gate.promise);
    createWorkspaceReleaseNote.mockImplementation(stored);

    const store = useReleaseNotes();
    const run = store.generate(ask);

    // Before anything is awaited: the row the history renders in place of the blocking
    // modal, carrying what was asked for so the list says which project is being written.
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({
      workspaceId: 'w1',
      projectName: 'Web',
      branch: 'main',
      rangeFrom: '2026-08-01',
      rangeTo: '2026-08-31',
      error: null,
    });
    expect(store.jobs[0]?.startedAt).toBeGreaterThan(0);

    gate.resolve({ title: 'Реліз 12', markdown: '# Реліз 12', commitCount: 7 });
    await run;

    // The note landed in the workspace with nothing on screen to receive it, and the
    // placeholder is gone because the real row replaced it.
    expect(store.jobs).toHaveLength(0);
    expect((store.byWorkspace.w1 ?? []).map((n) => n.title)).toEqual(['Реліз 12']);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Реліз 12'));
  });

  // The form closes on submit, so pressing the button twice is a normal way to ask «did that
  // go through?» — and each press would otherwise spend a model turn on the same document.
  it('collapses an identical ask onto the run already in flight', () => {
    generateReleaseNotes.mockReturnValue(Promise.withResolvers<never>().promise);
    const store = useReleaseNotes();
    void store.generate(ask);
    void store.generate(ask);
    void store.generate({ ...ask, branch: 'release/2' });

    expect(generateReleaseNotes).toHaveBeenCalledTimes(2);
    expect(store.jobs.map((j) => j.branch)).toEqual(['main', 'release/2']);
  });

  it('keeps the failed job on the list with the reason attached', async () => {
    generateReleaseNotes.mockRejectedValue(new Error('project not bound'));
    const store = useReleaseNotes();
    await store.generate(ask);

    // A toast is gone four seconds later and the person it was meant for was on another
    // screen: the row is what is still there when they come back.
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]?.error).toBe('project not bound');
    expect(store.byWorkspace.w1).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('project not bound'), 'error');
  });

  // A document written by the model but refused by the cloud is not a release note anybody
  // else can read, so the job fails rather than reporting a success nobody can open.
  it('fails the job when the note cannot reach the workspace', async () => {
    generateReleaseNotes.mockResolvedValue({ title: 'Реліз 12', markdown: '#', commitCount: 3 });
    createWorkspaceReleaseNote.mockRejectedValue(new Error('row-level security'));
    const store = useReleaseNotes();
    await store.generate(ask);

    expect(store.jobs[0]?.error).toBe('row-level security');
    expect(store.byWorkspace.w1).toBeUndefined();
  });

  it('retries a failed job with the same parameters and drops the row on success', async () => {
    generateReleaseNotes.mockRejectedValueOnce(new Error('omp not found'));
    createWorkspaceReleaseNote.mockImplementation(stored);
    const store = useReleaseNotes();
    await store.generate(ask);
    const failed = store.jobs[0]?.id ?? '';

    generateReleaseNotes.mockResolvedValueOnce({
      title: 'Реліз 12',
      markdown: '# Реліз 12',
      commitCount: 7,
    });
    await store.retry(failed);

    expect(generateReleaseNotes).toHaveBeenLastCalledWith({
      projectId: 'p1',
      workspaceName: 'Acme',
      branch: 'main',
      rangeFrom: '2026-08-01',
      rangeTo: '2026-08-31',
      locale: 'uk',
    });
    expect(store.jobs).toHaveLength(0);
    expect((store.byWorkspace.w1 ?? []).map((n) => n.title)).toEqual(['Реліз 12']);
  });

  it('dismisses a failed job and refuses to retry a running one', async () => {
    generateReleaseNotes.mockRejectedValue(new Error('boom'));
    const store = useReleaseNotes();
    await store.generate(ask);
    store.dismissJob(store.jobs[0]?.id ?? '');
    expect(store.jobs).toHaveLength(0);

    // Only a failed row can be re-run: a job still writing has nothing to retry, and a
    // second omp child for the same ask is exactly what the guard above exists to prevent.
    generateReleaseNotes.mockReturnValue(Promise.withResolvers<never>().promise);
    void store.generate(ask);
    await store.retry(store.jobs[0]?.id ?? '');
    expect(generateReleaseNotes).toHaveBeenCalledTimes(2);
    expect(store.jobs).toHaveLength(1);
  });
});
