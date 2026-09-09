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
