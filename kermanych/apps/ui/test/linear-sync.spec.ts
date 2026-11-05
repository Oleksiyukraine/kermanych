import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useLinear } from '../src/stores/linear';

// «Синхронізувати» on the Linear board. The 30 s tick is an incremental poll behind a
// shared lease, so it is the wrong thing for a human who just moved tickets in Linear and
// wants them here NOW: the lease may hand the poll to another client, and an incremental
// poll never re-reads the board's column layout. This button is the deliberate act — full
// sweep, no lease — and these tests are that difference stated as behaviour.
const linearSync = vi.fn();
const linearTokenStatus = vi.fn();
const listLinearColumns = vi.fn();
const listLinearIssues = vi.fn();
const notify = vi.fn();

vi.mock('../src/lib/api', () => ({
  api: {
    linearSync: (workspaceId: string, full?: boolean) => linearSync(workspaceId, full),
    linearTokenStatus: (org: string) => linearTokenStatus(org),
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
  getLinearIntegration: vi.fn(),
  listLinearColumns: (client: unknown, integrationId: string) => listLinearColumns(client, integrationId),
  listLinearIssues: (client: unknown, integrationId: string) => listLinearIssues(client, integrationId),
  listLinearIssueChildren: vi.fn(),
  subscribeLinearIssues: vi.fn(() => () => {}),
}));

const integration = {
  id: 'i1',
  workspaceId: 'w1',
  orgUrlKey: 'acme',
  teamKey: 'ENG',
  teamId: 'team-uuid',
  teamName: 'Engineering',
};

// The mirror as it stands AFTER the sweep: one column more and one ticket more than the
// board had before the click.
const swept = {
  columns: [
    { integrationId: 'i1', workspaceId: 'w1', position: 0, name: 'Todo', stateIds: ['1'] },
    { integrationId: 'i1', workspaceId: 'w1', position: 1, name: 'In Review', stateIds: ['4'] },
  ],
  issues: [{ integrationId: 'i1', workspaceId: 'w1', issueId: '9', key: 'ENG-9', stateId: '4' }],
};

function board() {
  const store = useLinear();
  // The state open() would have installed: a connected workspace and this machine's key.
  store.integration = integration as never;
  store.tokenPresent = true;
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  linearSync.mockReset().mockResolvedValue({ synced: true });
  linearTokenStatus.mockReset().mockResolvedValue({ present: true });
  listLinearColumns.mockReset().mockResolvedValue(swept.columns);
  listLinearIssues.mockReset().mockResolvedValue(swept.issues);
  notify.mockReset();
});

describe('linear syncNow', () => {
  it('runs a full sweep and re-reads the mirror, columns included', async () => {
    const store = board();

    await store.syncNow('w1');

    // `full` is the whole point: the api bypasses the shared lease for it, so the click
    // cannot be swallowed by another open board holding the poll.
    expect(linearSync).toHaveBeenCalledWith('w1', true);
    // linear_columns has no realtime channel — without this reload a relayout would stay
    // invisible until the view is reopened.
    expect(store.columns.map((c) => c.name)).toEqual(['Todo', 'In Review']);
    expect(store.issues.map((i) => i.key)).toEqual(['ENG-9']);
    expect(store.syncing).toBe(false);
    expect(notify).toHaveBeenCalledWith('Дошку синхронізовано з Linear', 'info');
  });

  it('holds the board in the syncing state until the sweep answers', async () => {
    const gate = Promise.withResolvers<{ synced: boolean }>();
    linearSync.mockReturnValue(gate.promise);
    const store = board();

    const run = store.syncNow('w1');
    expect(store.syncing).toBe(true); // the button's disabled/«Синхронізація…» state

    gate.resolve({ synced: true });
    await run;
    expect(store.syncing).toBe(false);
  });

  it('does not start a second poll while one is in flight', async () => {
    const store = board();
    store.syncing = true; // the tick is mid-poll

    await store.syncNow('w1');

    expect(linearSync).not.toHaveBeenCalled();
    expect(store.syncing).toBe(true); // and the running poll's spinner is left alone
  });

  it('refuses for a read-only member instead of calling Linear unsigned', async () => {
    const store = board();
    store.tokenPresent = false;

    await store.syncNow('w1');

    expect(linearSync).not.toHaveBeenCalled();
  });

  it('drops the board to read-only and reports when the token is dead', async () => {
    linearSync.mockRejectedValue(new Error('linear token invalid'));
    const store = board();

    await store.syncNow('w1');

    expect(store.tokenPresent).toBe(false);
    expect(notify).toHaveBeenCalledWith('Синхронізація не вдалася: linear token invalid', 'error');
    expect(store.syncing).toBe(false);
  });

  it('reports a failed sweep and leaves the mirror alone', async () => {
    linearSync.mockRejectedValue(new Error('linear: 503 service unavailable'));
    const store = board();

    await store.syncNow('w1');

    expect(store.tokenPresent).toBe(true); // not a token problem — stay actionable
    expect(listLinearIssues).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'Синхронізація не вдалася: linear: 503 service unavailable',
      'error',
    );
  });
});

// The cross-area contract: Management/Board/Home read `integration === undefined ||
// (loading && !issues.length)` as «not loaded for this workspace», so a workspace switch must
// clear the previous board before the probe answers, and a late answer must not land.
describe('linear workspace switch', () => {
  it('clears board state before the probe resolves and keeps loading through loadBoard', async () => {
    const { getLinearIntegration } = await import('@kermanych/cloud');
    const store = board();
    store.issues = swept.issues as never;
    store.columns = swept.columns as never;
    const gate = Promise.withResolvers<unknown>();
    vi.mocked(getLinearIntegration).mockReturnValueOnce(gate.promise as never);

    const run = store.open('w2');
    expect(store.integration).toBeUndefined();
    expect(store.issues).toEqual([]);
    expect(store.columns).toEqual([]);
    expect(store.loading).toBe(true);

    gate.resolve({ ...integration, id: 'i2', workspaceId: 'w2' });
    await run;
    expect(store.integration?.id).toBe('i2');
    expect(store.loading).toBe(false);
    store.close();
  });

  it('ignores a late reply for the previous workspace', async () => {
    const { getLinearIntegration } = await import('@kermanych/cloud');
    const store = useLinear();
    const old = Promise.withResolvers<unknown>();
    vi.mocked(getLinearIntegration)
      .mockReturnValueOnce(old.promise as never)
      .mockResolvedValueOnce({ ...integration, id: 'i2', workspaceId: 'w2' } as never);

    const first = store.probe('w1');
    await store.probe('w2');
    old.resolve(integration);
    await first;

    expect(store.integration?.id).toBe('i2');
    expect(store.loading).toBe(false);
  });
  // BoardPage leaves the Linear view when the new workspace reads «not loaded»; that
  // unmount's close() must not throw away the probe that decides whether the tab exists.
  it('keeps a probe in flight across close()', async () => {
    const { getLinearIntegration } = await import('@kermanych/cloud');
    const store = useLinear();
    const gate = Promise.withResolvers<unknown>();
    vi.mocked(getLinearIntegration).mockReturnValueOnce(gate.promise as never);

    const run = store.probe('w2');
    store.close();
    expect(store.loading).toBe(true);
    gate.resolve({ ...integration, id: 'i2', workspaceId: 'w2' });
    await run;

    expect(store.integration?.id).toBe('i2');
    expect(store.tokenKnown).toBe(true);
    expect(store.loading).toBe(false);
  });

  // The Менеджмент chat probes while the board's open() is still asking: the shared probe
  // must not cost open() its board load and feed.
  it('still loads the board when a probe overlaps open()', async () => {
    const { getLinearIntegration } = await import('@kermanych/cloud');
    const store = useLinear();
    const gate = Promise.withResolvers<unknown>();
    vi.mocked(getLinearIntegration).mockClear();
    vi.mocked(getLinearIntegration).mockReturnValueOnce(gate.promise as never);

    const opening = store.open('w2');
    const probing = store.probe('w2');
    gate.resolve({ ...integration, id: 'i2', workspaceId: 'w2' });
    await Promise.all([opening, probing]);

    expect(getLinearIntegration).toHaveBeenCalledTimes(1);
    expect(store.columns).toEqual(swept.columns);
    expect(store.loading).toBe(false);
    store.close();
  });
});
