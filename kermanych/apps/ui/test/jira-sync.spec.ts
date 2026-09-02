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
  getJiraIntegration: vi.fn(),
  listJiraColumns: (client: unknown, integrationId: string) => listJiraColumns(client, integrationId),
  listJiraIssues: (client: unknown, integrationId: string) => listJiraIssues(client, integrationId),
  listJiraIssueChildren: vi.fn(),
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
  // The state open() would have installed: a connected workspace and this machine's token.
  store.integration = integration as never;
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

    await store.syncNow('w1');

    // `full` is the whole point: the api bypasses the shared lease for it, so the click
    // cannot be swallowed by another open board holding the poll.
    expect(jiraSync).toHaveBeenCalledWith('w1', true);
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

    expect(jiraSync).not.toHaveBeenCalled();
    expect(store.syncing).toBe(true); // and the running poll's spinner is left alone
  });

  it('refuses for a read-only member instead of calling Jira unsigned', async () => {
    const store = board();
    store.tokenPresent = false;

    await store.syncNow('w1');

    expect(jiraSync).not.toHaveBeenCalled();
  });

  it('drops the board to read-only and reports when the token is dead', async () => {
    jiraSync.mockRejectedValue(new Error('jira token invalid'));
    const store = board();

    await store.syncNow('w1');

    expect(store.tokenPresent).toBe(false);
    expect(notify).toHaveBeenCalledWith('Синхронізація не вдалася: jira token invalid', 'error');
    expect(store.syncing).toBe(false);
  });

  it('reports a failed sweep and leaves the mirror alone', async () => {
    jiraSync.mockRejectedValue(new Error('jira: 503 service unavailable'));
    const store = board();

    await store.syncNow('w1');

    expect(store.tokenPresent).toBe(true); // not a token problem — stay actionable
    expect(listJiraIssues).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'Синхронізація не вдалася: jira: 503 service unavailable',
      'error',
    );
  });
});
