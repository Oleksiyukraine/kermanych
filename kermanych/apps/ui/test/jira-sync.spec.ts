import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useJira } from '../src/stores/jira';

// «Синхронізувати» on the Jira board. The 30 s tick is an incremental poll behind a shared
// lease, so it is exactly the wrong thing for a human who just moved tickets in Jira and
// wants them here NOW: the lease may hand the poll to another client, and an incremental
// poll never re-reads the board's column layout. This button is the deliberate act — full
// sweep, no lease — and these tests are that difference stated as behaviour.
const jiraSync = vi.fn();
const jiraTokenStatus = vi.fn();
const listJiraColumns = vi.fn();
const listJiraIssues = vi.fn();
const notify = vi.fn();

vi.mock('../src/lib/api', () => ({
  api: {
    jiraSync: (workspaceId: string, full?: boolean) => jiraSync(workspaceId, full),
    jiraTokenStatus: (site: string) => jiraTokenStatus(site),
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
  listJiraIntegrations: vi.fn(),
  getJiraIntegrationById: vi.fn(),
  listJiraColumns: (client: unknown, integrationId: string) => listJiraColumns(client, integrationId),
  listJiraIssues: (client: unknown, integrationId: string) => listJiraIssues(client, integrationId),
  listJiraIssueChildren: vi.fn(),
  listJiraWorklogsBetween: vi.fn(),
  subscribeJiraIssues: vi.fn(() => () => {}),
}));

const integration = {
  id: 'i1',
  workspaceId: 'w1',
  siteUrl: 'https://acme.atlassian.net',
  boardId: 7,
  boardName: 'KAN board',
  projectKey: 'KAN',
};

// The mirror as it stands AFTER the sweep: one column more and one ticket more than the
// board had before the click.
const swept = {
  columns: [
    { integrationId: 'i1', workspaceId: 'w1', position: 0, name: 'To Do', statusIds: ['1'] },
    { integrationId: 'i1', workspaceId: 'w1', position: 1, name: 'Review', statusIds: ['4'] },
  ],
  issues: [{ integrationId: 'i1', workspaceId: 'w1', issueId: '9', key: 'KAN-9', statusId: '4' }],
};

function board() {
  const store = useJira();
  // The state open() would have installed: a connected workspace with one active board and
  // this machine's token.
  store.integrations = [integration] as never;
  store.activeId = 'i1';
  store.tokenPresent = true;
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  jiraSync.mockReset().mockResolvedValue({ synced: true });
  jiraTokenStatus.mockReset().mockResolvedValue({ present: true, email: 'me@acme.io' });
  listJiraColumns.mockReset().mockResolvedValue(swept.columns);
  listJiraIssues.mockReset().mockResolvedValue(swept.issues);
  notify.mockReset();
});

describe('jira syncNow', () => {
  it('runs a full sweep and re-reads the mirror, columns included', async () => {
    const store = board();

    await store.syncNow();

    // `full` is the whole point: the api bypasses the shared lease for it, so the click
    // cannot be swallowed by another open board holding the poll.
    expect(jiraSync).toHaveBeenCalledWith('i1', true);
    // jira_columns has no realtime channel — without this reload a relayout would stay
    // invisible until the view is reopened.
    expect(store.columns.map((c) => c.name)).toEqual(['To Do', 'Review']);
    expect(store.issues.map((i) => i.key)).toEqual(['KAN-9']);
    expect(store.syncing).toBe(false);
    expect(notify).toHaveBeenCalledWith('Дошку синхронізовано з Jira', 'info');
  });

  it('holds the board in the syncing state until the sweep answers', async () => {
    const gate = Promise.withResolvers<{ synced: boolean }>();
    jiraSync.mockReturnValue(gate.promise);
    const store = board();

    const run = store.syncNow();
    expect(store.syncing).toBe(true); // the button's disabled/«Синхронізація…» state

    gate.resolve({ synced: true });
    await run;
    expect(store.syncing).toBe(false);
  });

  it('does not start a second poll while one is in flight', async () => {
    const store = board();
    store.syncing = true; // the tick is mid-poll

    await store.syncNow();

    expect(jiraSync).not.toHaveBeenCalled();
    expect(store.syncing).toBe(true); // and the running poll's spinner is left alone
  });

  it('refuses for a read-only member instead of calling Jira unsigned', async () => {
    const store = board();
    store.tokenPresent = false;

    await store.syncNow();

    expect(jiraSync).not.toHaveBeenCalled();
  });

  it('drops the board to read-only and reports when the token is dead', async () => {
    jiraSync.mockRejectedValue(new Error('jira token invalid'));
    const store = board();

    await store.syncNow();

    expect(store.tokenPresent).toBe(false);
    expect(notify).toHaveBeenCalledWith('Синхронізація не вдалася: jira token invalid', 'error');
    expect(store.syncing).toBe(false);
  });

  it('reports a failed sweep and leaves the mirror alone', async () => {
    jiraSync.mockRejectedValue(new Error('jira: 503 service unavailable'));
    const store = board();

    await store.syncNow();

    expect(store.tokenPresent).toBe(true); // not a token problem — stay actionable
    expect(listJiraIssues).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'Синхронізація не вдалася: jira: 503 service unavailable',
      'error',
    );
  });
});

// The cross-area contract: Management/Board/Home read `integration === undefined ||
// (loading && !issues.length)` as «not loaded for this workspace», so a workspace switch must
// clear the previous board before the probe answers, and a late answer must not land.
describe('jira workspace switch', () => {
  it('clears board state before the probe resolves and keeps loading through loadBoard', async () => {
    const { listJiraIntegrations } = await import('@kermanych/cloud');
    const store = board();
    store.issues = swept.issues as never;
    store.columns = swept.columns as never;
    const gate = Promise.withResolvers<unknown[]>();
    vi.mocked(listJiraIntegrations).mockReturnValueOnce(gate.promise as never);

    const run = store.open('w2');
    expect(store.integration).toBeUndefined();
    expect(store.integrations).toEqual([]);
    expect(store.issues).toEqual([]);
    expect(store.columns).toEqual([]);
    expect(store.loading).toBe(true);

    gate.resolve([{ ...integration, id: 'i2', workspaceId: 'w2' }]);
    await run;
    expect(store.activeId).toBe('i2');
    expect(store.loading).toBe(false);
    store.close();
  });

  it('ignores a late reply for the previous workspace', async () => {
    const { listJiraIntegrations } = await import('@kermanych/cloud');
    const store = useJira();
    const old = Promise.withResolvers<unknown[]>();
    vi.mocked(listJiraIntegrations)
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
  // BoardPage leaves the Jira view when the new workspace reads «not loaded»; that
  // unmount's close() must not throw away the probe that decides whether the tab exists.
  it('keeps a probe in flight across close()', async () => {
    const { listJiraIntegrations } = await import('@kermanych/cloud');
    const store = useJira();
    const gate = Promise.withResolvers<unknown[]>();
    vi.mocked(listJiraIntegrations).mockReturnValueOnce(gate.promise as never);

    const run = store.probe('w2');
    store.close();
    expect(store.loading).toBe(true);
    gate.resolve([{ ...integration, id: 'i2', workspaceId: 'w2' }]);
    await run;

    expect(store.integration?.id).toBe('i2');
    expect(store.tokenKnown).toBe(true);
    expect(store.loading).toBe(false);
  });

  // The Менеджмент chat probes while the board's open() is still asking: the shared probe
  // must not cost open() its board load and feed.
  it('still loads the board when a probe overlaps open()', async () => {
    const { listJiraIntegrations } = await import('@kermanych/cloud');
    const store = useJira();
    const gate = Promise.withResolvers<unknown[]>();
    vi.mocked(listJiraIntegrations).mockClear();
    vi.mocked(listJiraIntegrations).mockReturnValueOnce(gate.promise as never);

    const opening = store.open('w2');
    const probing = store.probe('w2');
    gate.resolve([{ ...integration, id: 'i2', workspaceId: 'w2' }]);
    await Promise.all([opening, probing]);

    expect(listJiraIntegrations).toHaveBeenCalledTimes(1);
    expect(store.columns).toEqual(swept.columns);
    expect(store.loading).toBe(false);
    store.close();
  });
});
