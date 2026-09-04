import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ManagementChatAsk, ManagementChatReply } from '@kermanych/core';
import { useManagementChat } from '../src/stores/management-chat';

// The assistant's capacity block is built in the browser from the same mirror the screen
// reads, and only when there is a Jira board to read. Two facts, two tests.
const managementChat = vi.fn();
const fetchWorklogs = vi.fn();
const loadBoard = vi.fn();

const jiraState = {
  integration: null as { id: string; siteUrl: string; projectKey: string; boardName: string } | null | undefined,
  issues: [] as unknown[],
};

vi.mock('../src/lib/api', () => ({
  api: { managementChat: (ask: unknown) => managementChat(ask), resetManagementChat: vi.fn(), jiraTokenStatus: vi.fn() },
}));
vi.mock('../src/stores/orchestrator', () => ({ useOrchestrator: () => ({ selectedWorkspaceId: 'w1', notify: vi.fn() }) }));
vi.mock('../src/stores/projects', () => ({
  useProjects: () => ({ projects: [], members: { w1: [] }, workspaceById: new Map([['w1', { id: 'w1', name: 'Acme' }]]), loadMembers: vi.fn() }),
}));
vi.mock('../src/stores/board', () => ({ useBoard: () => ({ createTask: vi.fn() }) }));
vi.mock('../src/stores/jira', () => ({
  useJira: () => ({
    get integration() {
      return jiraState.integration;
    },
    get issues() {
      return jiraState.issues;
    },
    tokenPresent: false,
    assignable: [],
    probe: vi.fn(),
    loadAssignable: vi.fn(async () => []),
    loadBoard: () => loadBoard(),
    fetchWorklogs: (range: unknown) => fetchWorklogs(range),
    upsert: vi.fn(),
  }),
}));
vi.mock('../src/stores/risks', () => ({ useRisks: () => ({ byWorkspace: { w1: [] }, load: vi.fn(), create: vi.fn(), save: vi.fn() }) }));
vi.mock('../src/stores/release-notes', () => ({ useReleaseNotes: () => ({ generate: vi.fn() }) }));

const reply: ManagementChatReply = { text: 'ok', actions: [], rejected: [], notices: [], ms: 1 };

const issue = (over: Record<string, unknown>) => ({
  integrationId: 'i1', workspaceId: 'w1', issueId: '1', key: 'KAN-1', summary: 's', descriptionHtml: '',
  typeName: '', typeIcon: '', priorityName: '', priorityIcon: '', labels: [],
  originalEstimate: '', timeSpent: '', remainingEstimate: '',
  originalEstimateSeconds: 0, timeSpentSeconds: 0, remainingEstimateSeconds: 0,
  startDate: '', dueDate: '', statusId: '1', statusName: 'To Do', statusCategory: 'new',
  jiraUpdatedAt: '', updatedAt: '', ...over,
});

describe('management chat — capacity digest', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    managementChat.mockReset().mockResolvedValue(reply);
    fetchWorklogs.mockReset().mockResolvedValue([]);
    loadBoard.mockReset();
    jiraState.integration = null;
    jiraState.issues = [];
  });

  it('sends no capacity without a Jira board', async () => {
    await useManagementChat().send('capacity?', 'management-capacity');
    const ask = managementChat.mock.calls[0]![0] as ManagementChatAsk;
    expect('capacity' in ask.context).toBe(false);
    expect(fetchWorklogs).not.toHaveBeenCalled();
  });

  it('sends a weekly digest built from the mirror when there is one', async () => {
    jiraState.integration = { id: 'i1', siteUrl: 'https://x.atlassian.net', projectKey: 'KAN', boardName: 'KAN board' };
    jiraState.issues = [
      issue({ assigneeAccountId: 'acc1', assigneeName: 'Andrii', remainingEstimateSeconds: 8 * 3600, startDate: '2099-01-04', dueDate: '2099-01-05' }),
    ];
    await useManagementChat().send('capacity?', 'management-capacity');
    const ask = managementChat.mock.calls[0]![0] as ManagementChatAsk;
    expect(loadBoard).not.toHaveBeenCalled(); // issues were already there
    expect(fetchWorklogs).toHaveBeenCalledTimes(1);
    const c = ask.context.capacity!;
    expect(c.hoursPerDay).toBe(8);
    expect(c.team).toHaveLength(8);
    expect(c.persons.map((p) => p.name)).toEqual(['Andrii']);
    expect(c.persons[0]!.openIssues).toBe(0); // starts and ends in 2099: wholly outside the window, unflagged
  });

  it('loads the board first when nothing is mirrored yet, and survives a failed read', async () => {
    jiraState.integration = { id: 'i1', siteUrl: 'https://x.atlassian.net', projectKey: 'KAN', boardName: 'KAN board' };
    fetchWorklogs.mockRejectedValueOnce(new Error('offline'));
    await useManagementChat().send('capacity?', 'management-capacity');
    expect(loadBoard).toHaveBeenCalledTimes(1);
    const ask = managementChat.mock.calls[0]![0] as ManagementChatAsk;
    expect('capacity' in ask.context).toBe(false);
  });
});
