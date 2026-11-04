import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { listPlaneIntegrations } from '@kermanych/cloud';
import { usePlane } from '../src/stores/plane';

// «Синхронізувати» on the Plane board, and the store's workspace-switch contract. The 30 s
// tick is an incremental poll behind a shared lease; the button is the deliberate act — full
// sweep, no lease — and these tests are that difference stated as behaviour. Plane adds one
// answer Jira has not: a sweep cut short by the 60-requests-a-minute limit, which is news,
// not a failure.
const planeSync = vi.fn();
const planeTokenStatus = vi.fn();
const planeEditorOptions = vi.fn();
const planeAssignableUsers = vi.fn();
const listPlaneColumns = vi.fn();
const listPlaneIssues = vi.fn();
const notify = vi.fn();

vi.mock('../src/lib/api', () => ({
  api: {
    planeSync: (integrationId: string, full?: boolean) => planeSync(integrationId, full),
    planeTokenStatus: (site: string, workspace: string) => planeTokenStatus(site, workspace),
    planeEditorOptions: (integrationId: string) => planeEditorOptions(integrationId),
    planeAssignableUsers: (integrationId: string, q: string) => planeAssignableUsers(integrationId, q),
  },
}));
vi.mock('../src/stores/auth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, client: {} }),
}));
vi.mock('../src/stores/orchestrator', () => ({
  useOrchestrator: () => ({ notify }),
}));
vi.mock('../src/lib/preview', () => ({ IS_PREVIEW: false, PREVIEW_USER_ID: 'preview' }));
vi.mock('@kermanych/cloud', () => ({
  listPlaneIntegrations: vi.fn(),
  listPlaneColumns: (client: unknown, integrationId: string) => listPlaneColumns(client, integrationId),
  listPlaneIssues: (client: unknown, integrationId: string) => listPlaneIssues(client, integrationId),
  listPlaneIssueChildren: vi.fn(),
  listPlaneWorklogsBetween: vi.fn(),
  subscribePlaneIssues: vi.fn(() => () => {}),
}));

const integration = {
  id: 'i1',
  workspaceId: 'w1',
  siteUrl: 'https://app.plane.so',
  workspaceSlug: 'my-team',
  projectId: 'p-uuid',
  projectIdentifier: 'WEB',
  projectName: 'Website',
};

// The mirror as it stands AFTER the sweep: one column more and one ticket more.
const swept = {
  columns: [
    { integrationId: 'i1', workspaceId: 'w1', position: 0, name: 'Todo', stateIds: ['s1'], stateGroup: 'unstarted', color: '' },
    { integrationId: 'i1', workspaceId: 'w1', position: 1, name: 'Review', stateIds: ['s4'], stateGroup: 'started', color: '' },
  ],
  issues: [{ integrationId: 'i1', workspaceId: 'w1', issueId: '9', key: 'WEB-9', statusId: 's4' }],
};

function board() {
  const store = usePlane();
  // The state open() would have installed: a connected workspace with one active project and
  // this machine's token.
  store.integrations = [integration] as never;
  store.activeId = 'i1';
  store.tokenPresent = true;
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  planeSync.mockReset().mockResolvedValue({ synced: true });
  planeTokenStatus.mockReset().mockResolvedValue({ present: true, displayName: 'Andrii' });
  planeEditorOptions.mockReset().mockResolvedValue({ labels: [] });
  planeAssignableUsers.mockReset().mockResolvedValue([]);
  listPlaneColumns.mockReset().mockResolvedValue(swept.columns);
  listPlaneIssues.mockReset().mockResolvedValue(swept.issues);
  notify.mockReset();
});

describe('plane syncNow', () => {
  it('runs a full sweep and re-reads the mirror, columns included', async () => {
    const store = board();

    await store.syncNow();

    // `full` bypasses the shared lease, so the click cannot be swallowed by another client.
    expect(planeSync).toHaveBeenCalledWith('i1', true);
    // plane_columns has no realtime channel — without this reload new states stay invisible.
    expect(store.columns.map((c) => c.name)).toEqual(['Todo', 'Review']);
    expect(store.issues.map((i) => i.key)).toEqual(['WEB-9']);
    expect(store.syncing).toBe(false);
    expect(notify).toHaveBeenCalledWith('Дошку синхронізовано з Plane', 'info');
  });

  // The api stops a sweep at Plane's 60-a-minute limit and says so; what it wrote is real,
  // and the tick finishes the rest — an info, not «Синхронізація не вдалася».
  it('reports a rate-limited sweep as news, keeps the token and still reloads', async () => {
    planeSync.mockResolvedValue({ synced: false, rateLimited: true });
    const store = board();

    await store.syncNow();

    expect(store.tokenPresent).toBe(true);
    expect(store.issues.map((i) => i.key)).toEqual(['WEB-9']);
    expect(notify).toHaveBeenCalledWith(
      'Досягнуто ліміту запитів Plane — решта підтягнеться з наступною синхронізацією',
      'info',
    );
  });

  it('does not start a second poll while one is in flight', async () => {
    const store = board();
    store.syncing = true; // the tick is mid-poll

    await store.syncNow();

    expect(planeSync).not.toHaveBeenCalled();
    expect(store.syncing).toBe(true);
  });

  it('refuses for a read-only member instead of calling Plane unsigned', async () => {
    const store = board();
    store.tokenPresent = false;

    await store.syncNow();

    expect(planeSync).not.toHaveBeenCalled();
  });

  it('drops the board to read-only and reports when the token is dead', async () => {
    planeSync.mockRejectedValue(new Error('plane token invalid'));
    const store = board();

    await store.syncNow();

    expect(store.tokenPresent).toBe(false);
    expect(notify).toHaveBeenCalledWith('Синхронізація не вдалася: plane token invalid', 'error');
    expect(store.syncing).toBe(false);
  });
});

// The cross-area contract: Board/Integrations read `integration === undefined ||
// (loading && !issues.length)` as «not loaded for this workspace», so a workspace switch must
// clear the previous project before the probe answers, and a late answer must not land.
describe('plane workspace switch', () => {
  it('clears board state before the probe resolves and keeps loading through loadBoard', async () => {
    const store = board();
    store.issues = swept.issues as never;
    store.columns = swept.columns as never;
    const gate = Promise.withResolvers<unknown[]>();
    vi.mocked(listPlaneIntegrations).mockReturnValueOnce(gate.promise as never);

    const run = store.open('w2');
    expect(store.integration).toBeUndefined();
    expect(store.integrations).toEqual([]);
    expect(store.issues).toEqual([]);
    expect(store.columns).toEqual([]);
    expect(store.loading).toBe(true);

    gate.resolve([{ ...integration, id: 'i2', workspaceId: 'w2' }]);
    await run;
    expect(store.activeId).toBe('i2');
    // The token is asked for the project's own address AND Plane workspace.
    expect(planeTokenStatus).toHaveBeenCalledWith('https://app.plane.so', 'my-team');
    expect(store.loading).toBe(false);
    store.close();
  });

  it('ignores a late reply for the previous workspace', async () => {
    const store = usePlane();
    const old = Promise.withResolvers<unknown[]>();
    vi.mocked(listPlaneIntegrations)
      .mockReturnValueOnce(old.promise as never)
      .mockResolvedValueOnce([{ ...integration, id: 'i2', workspaceId: 'w2' }] as never);

    const first = store.probe('w1');
    await store.probe('w2');
    old.resolve([integration]);
    await first;

    expect(store.integrations.map((i) => i.id)).toEqual(['i2']);
    expect(store.activeId).toBe('i2');
    expect(store.loading).toBe(false);
  });

  // BoardPage leaves the Plane view when the new workspace reads «not loaded»; that unmount's
  // close() must not throw away the probe that decides whether the tab exists.
  it('keeps a probe in flight across close()', async () => {
    const store = usePlane();
    const gate = Promise.withResolvers<unknown[]>();
    vi.mocked(listPlaneIntegrations).mockReturnValueOnce(gate.promise as never);

    const run = store.probe('w2');
    store.close();
    expect(store.loading).toBe(true);
    gate.resolve([{ ...integration, id: 'i2', workspaceId: 'w2' }]);
    await run;

    expect(store.integration?.id).toBe('i2');
    expect(store.tokenKnown).toBe(true);
    expect(store.loading).toBe(false);
  });
});

// The editor lists cost several Plane calls; every dialog opened on one project shares one
// read, and a project switch must not hand the next project the previous one's labels.
describe('plane editorLists', () => {
  it('reads once per project and again after a switch', async () => {
    const store = board();
    store.integrations = [integration, { ...integration, id: 'i2', projectIdentifier: 'API' }] as never;

    await store.editorLists();
    await store.editorLists();
    expect(planeEditorOptions).toHaveBeenCalledTimes(1);

    await store.setActive('i2');
    await store.editorLists();
    expect(planeEditorOptions).toHaveBeenCalledTimes(2);
    expect(planeEditorOptions).toHaveBeenLastCalledWith('i2');
  });

  // A dropped connection must not pin the failure for the rest of the session.
  it('asks again after a failed read', async () => {
    planeEditorOptions.mockRejectedValueOnce(new Error('offline'));
    const store = board();

    await expect(store.editorLists()).rejects.toThrow('offline');
    await store.editorLists();
    expect(planeEditorOptions).toHaveBeenCalledTimes(2);
  });
});
