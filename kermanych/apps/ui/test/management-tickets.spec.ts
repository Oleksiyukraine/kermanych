import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ManagementChatReply } from '@kermanych/core';
import { useManagementChat, type MgmtChatEntry } from '../src/stores/management-chat';

// The ticket executor, stated as behaviour. It is the half of «create a ticket from the chat»
// that decides whether anything is written and WHOSE queue it lands in, and every one of its
// refusals exists because the alternative is a card the operator never sees:
//
//   * the wrong project puts the work in front of a team that does not own it;
//   * an unresolvable assignee silently files into nobody's queue;
//   * a Jira ask answered on the native board files onto a board the operator did not name;
//   * an unsigned Jira call cannot create anything at all, so «створено» would be a lie.
//
// The transcript line is the app's own account of what happened — the model is told never to
// claim a write succeeded — so each test asserts the line as well as the write.
const managementChat = vi.fn();
const jiraCreateIssue = vi.fn();
const jiraEditorOptions = vi.fn();
const jiraAssignableUsers = vi.fn();
const jiraTokenStatus = vi.fn();
const createTask = vi.fn();
const loadMembers = vi.fn();
const jiraUpsert = vi.fn();
const jiraLoadAssignable = vi.fn();
const jiraUploadAttachment = vi.fn();

const members = [
  { workspaceId: 'w1', userId: 'u-olya', role: 'developer', addedAt: '', profile: { id: 'u-olya', githubUsername: 'olya', displayName: 'Оля Петренко' } },
  { workspaceId: 'w1', userId: 'u-andrii', role: 'owner', addedAt: '', profile: { id: 'u-andrii', githubUsername: 'andrii', displayName: 'Андрій Чесноков' } },
];

const jiraState = {
  integration: null as { id: string; siteUrl: string; projectKey: string; boardName: string } | null | undefined,
  tokenPresent: false,
  // Jira's OWN assignable users. Deliberately disjoint from `members` in the tests that use
  // it: a Jira seat is not a Kermanych account, and treating the two as one list is the bug
  // this file's Jira assignee tests exist for.
  assignable: [] as { accountId: string; displayName: string }[],
};

vi.mock('../src/lib/api', () => ({
  api: {
    managementChat: (ask: unknown) => managementChat(ask),
    resetManagementChat: vi.fn(),
    jiraCreateIssue: (ws: string, draft: unknown) => jiraCreateIssue(ws, draft),
    jiraEditorOptions: (ws: string) => jiraEditorOptions(ws),
    jiraAssignableUsers: (ws: string, q: string) => jiraAssignableUsers(ws, q),
    jiraTokenStatus: (site: string) => jiraTokenStatus(site),
    jiraUploadAttachment: (ws: string, key: string, filename: string, data: string, mimeType: string) =>
      jiraUploadAttachment(ws, key, filename, data, mimeType),
  },
}));
vi.mock('../src/stores/orchestrator', () => ({
  useOrchestrator: () => ({ selectedWorkspaceId: 'w1', notify: vi.fn() }),
}));
vi.mock('../src/stores/projects', () => ({
  useProjects: () => ({
    projects: [
      { id: 'p1', name: 'Kermanych UI', workspaceId: 'w1' },
      { id: 'p2', name: 'Kermanych API', workspaceId: 'w1' },
      { id: 'p9', name: 'Чужий', workspaceId: 'w2' },
    ],
    members: { w1: members },
    workspaceById: new Map([['w1', { id: 'w1', name: 'Acme' }]]),
    loadMembers: (ws: string) => loadMembers(ws),
  }),
}));
vi.mock('../src/stores/board', () => ({
  useBoard: () => ({ createTask: (input: unknown) => createTask(input) }),
}));
vi.mock('../src/stores/jira', () => ({
  useJira: () => ({
    get integration() {
      return jiraState.integration;
    },
    get tokenPresent() {
      return jiraState.tokenPresent;
    },
    get assignable() {
      return jiraState.assignable;
    },
    probe: vi.fn(),
    loadAssignable: (ws: string) => jiraLoadAssignable(ws),
    upsert: (issue: unknown) => jiraUpsert(issue),
  }),
}));
vi.mock('../src/stores/risks', () => ({
  useRisks: () => ({ byWorkspace: { w1: [] }, load: vi.fn(), create: vi.fn(), save: vi.fn() }),
}));
vi.mock('../src/stores/release-notes', () => ({
  useReleaseNotes: () => ({ generate: vi.fn() }),
}));

// The ticket as the assistant is required to write it: English text, and the interface labels
// it quotes left in the language the product shows them in.
const TICKET = {
  title: 'Customer sees the change history of an invoice',
  context: 'Accounting cannot show a client when the amount changed.',
  userFlow: ['Opens an invoice', 'Switches to «Історія»'],
  acceptanceCriteria: ['The invoice card has an «Історія» tab', 'Every entry shows the author and the date'],
};

// One assistant turn carrying exactly the actions under test.
function reply(actions: ManagementChatReply['actions']): ManagementChatReply {
  return { text: 'Готую тікет.', actions, rejected: [], notices: [], ms: 10 };
}

// The result lines the app wrote this turn — never the model's prose. Takes the entries rather
// than the store, so the helper is typed by the store's own exported entry type.
function results(entries: readonly MgmtChatEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'result' ? [e.text] : []));
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const m of [managementChat, jiraCreateIssue, jiraEditorOptions, jiraAssignableUsers, jiraTokenStatus, createTask, loadMembers, jiraUpsert, jiraLoadAssignable, jiraUploadAttachment])
    m.mockReset();
  jiraState.integration = null;
  jiraState.tokenPresent = false;
  jiraState.assignable = [];
  // The store's own contract: cached, workspace-scoped, and degrading to an empty list.
  jiraLoadAssignable.mockImplementation(async () => jiraState.assignable);
});

describe('ticket.create on the default board', () => {
  it('files the card with the body the app composed and the assignee it resolved', async () => {
    managementChat.mockResolvedValue(
      reply([
        { kind: 'ticket.create', project: 'Kermanych UI', assignee: 'Оля', prefix: 'feature', platform: 'web', ticket: TICKET },
      ]),
    );
    createTask.mockImplementation((input: Record<string, unknown>) => ({ ...input, id: 't1' }));

    const store = useManagementChat();
    await store.send('створи тікет про історію змін', 'management-home');

    // The project name resolved to its id, the display name to the uuid the row carries, and
    // the description is the RENDERED ticket — not the model's prose, which is why the
    // headings are here at all.
    expect(createTask).toHaveBeenCalledTimes(1);
    const input = createTask.mock.calls[0]?.[0] as Record<string, string>;
    expect(input.projectId).toBe('p1');
    expect(input.assigneeId).toBe('u-olya');
    expect(input.prefix).toBe('feature');
    expect(input.platform).toBe('web');
    expect(input.title).toBe(TICKET.title);
    expect(input.description).toContain('## Context');
    expect(input.description).toContain('## User flow');
    expect(input.description).toContain('- [ ] The invoice card has an «Історія» tab');
    // `status` is never sent: Postgres defaults it to backlog, and the line says where the
    // card actually is.
    expect(input.status).toBeUndefined();
    expect(results(store.entries)).toEqual([expect.stringContaining('Тікет «Customer sees the change history of an invoice» створено')]);
    expect(results(store.entries)[0]).toContain('Kermanych UI');
  });

  it('leaves the card unassigned when the ticket named nobody', async () => {
    managementChat.mockResolvedValue(reply([{ kind: 'ticket.create', project: 'Kermanych API', ticket: TICKET }]));
    createTask.mockImplementation((input: Record<string, unknown>) => ({ ...input, id: 't1' }));

    const store = useManagementChat();
    await store.send('створи тікет', 'management-home');

    expect((createTask.mock.calls[0]?.[0] as Record<string, unknown>).assigneeId).toBeUndefined();
    expect(results(store.entries)[0]).toContain('без виконавця');
  });

  // The candidates are named in the refusal, so the operator answers in one message instead of
  // guessing which list the assistant was reading.
  it('refuses the ticket when the project is not in this workspace', async () => {
    managementChat.mockResolvedValue(reply([{ kind: 'ticket.create', project: 'Чужий', ticket: TICKET }]));

    const store = useManagementChat();
    await store.send('створи тікет', 'management-home');

    expect(createTask).not.toHaveBeenCalled();
    expect(results(store.entries)[0]).toContain('немає проєкту «Чужий»');
    expect(results(store.entries)[0]).toContain('Kermanych UI, Kermanych API');
  });

  // The one failure the operator would not notice: «створи тікет на Олю» has exactly one right
  // outcome, and a card that lands in nobody's queue is not it.
  it('refuses the ticket rather than filing it unassigned when the assignee is unknown', async () => {
    managementChat.mockResolvedValue(
      reply([{ kind: 'ticket.create', project: 'Kermanych UI', assignee: 'Марія', ticket: TICKET }]),
    );

    const store = useManagementChat();
    await store.send('створи тікет на Марію', 'management-home');

    expect(createTask).not.toHaveBeenCalled();
    expect(results(store.entries)[0]).toContain('немає «Марія»');
    expect(results(store.entries)[0]).toContain('olya, andrii');
  });

  // `createTask` reports its own failure through a toast and answers `undefined`; the
  // transcript still has to say the ticket did not land, because it was asked for here.
  it('says the ticket did not land when the board refused the row', async () => {
    managementChat.mockResolvedValue(reply([{ kind: 'ticket.create', project: 'Kermanych UI', ticket: TICKET }]));
    createTask.mockResolvedValue(undefined);

    const store = useManagementChat();
    await store.send('створи тікет', 'management-home');

    expect(results(store.entries)[0]).toContain('Не вдалося створити тікет');
  });
});

describe('jira.ticket.create on the mirrored board', () => {
  const integration = { id: 'i1', siteUrl: 'https://acme.atlassian.net', projectKey: 'KRM', boardName: 'Kermanych board' };

  it('creates the issue through the local api and shows it without waiting for a sync', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraEditorOptions.mockResolvedValue({
      issueTypes: [
        { id: '10001', name: 'Task', subtask: false },
        { id: '10002', name: 'Story', subtask: false },
      ],
      priorities: [
        { id: '2', name: 'High' },
        { id: '3', name: 'Medium' },
      ],
    });
    jiraAssignableUsers.mockResolvedValue([{ accountId: 'acc-1', displayName: 'Olya Petrenko' }]);
    jiraCreateIssue.mockResolvedValue({ key: 'KRM-214', summary: TICKET.title, issueId: '10500' });
    managementChat.mockResolvedValue(
      reply([
        {
          kind: 'jira.ticket.create',
          ticket: TICKET,
          issueType: 'story',
          priority: 'high',
          labels: ['billing'],
          assignee: 'Olya Petrenko',
        },
      ]),
    );

    const store = useManagementChat();
    await store.send('створи тікет у Jira', 'management-home');

    // The names the model was allowed to state, turned into the ids Jira's API wants — the
    // mirror keeps no ids, which is why the editor options are read at all.
    const draft = jiraCreateIssue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(jiraCreateIssue).toHaveBeenCalledWith('w1', expect.anything());
    expect(draft.issueTypeId).toBe('10002');
    expect(draft.priorityId).toBe('2');
    expect(draft.assigneeAccountId).toBe('acc-1');
    expect(draft.labels).toEqual(['billing']);
    expect(draft.summary).toBe(TICKET.title);
    expect(draft.description).toContain('## Acceptance criteria');
    // Same rendered body as a native card: one renderer, so a ticket does not read
    // differently depending on which board it landed on.
    expect(draft.description).toContain('## Context');
    expect(jiraUpsert).toHaveBeenCalledWith(expect.objectContaining({ key: 'KRM-214' }));
    expect(results(store.entries)[0]).toContain('Тікет KRM-214');
    expect(results(store.entries)[0]).toContain('Kermanych board');
  });

  // An unnamed type is not an error: the Jira project's own default applies, and the two extra
  // Jira calls the lookup costs are not spent.
  it('skips the editor-options lookup when neither a type nor a priority was named', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraCreateIssue.mockResolvedValue({ key: 'KRM-215', summary: TICKET.title, issueId: '10501' });
    managementChat.mockResolvedValue(reply([{ kind: 'jira.ticket.create', ticket: TICKET }]));

    const store = useManagementChat();
    await store.send('створи тікет у Jira', 'management-home');

    expect(jiraEditorOptions).not.toHaveBeenCalled();
    expect(jiraAssignableUsers).not.toHaveBeenCalled();
    const draft = jiraCreateIssue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(draft.issueTypeId).toBeUndefined();
    expect(draft.assigneeAccountId).toBeUndefined();
  });

  it('names the types the board does have instead of creating the wrong one', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraEditorOptions.mockResolvedValue({
      issueTypes: [{ id: '10001', name: 'Task', subtask: false }],
      priorities: [{ id: '3', name: 'Medium' }],
    });
    managementChat.mockResolvedValue(reply([{ kind: 'jira.ticket.create', ticket: TICKET, issueType: 'Epic' }]));

    const store = useManagementChat();
    await store.send('створи епік у Jira', 'management-home');

    expect(jiraCreateIssue).not.toHaveBeenCalled();
    expect(results(store.entries)[0]).toContain('немає типу «Epic»');
    expect(results(store.entries)[0]).toContain('Task');
  });

  // The operator named Jira. Filing on the native board instead would put the ticket on a
  // board they did not ask for, and they would not find it where they looked.
  it('refuses instead of falling back to the native board when Jira is not connected', async () => {
    jiraState.integration = null;
    managementChat.mockResolvedValue(reply([{ kind: 'jira.ticket.create', ticket: TICKET }]));

    const store = useManagementChat();
    await store.send('створи тікет у Jira', 'management-home');

    expect(jiraCreateIssue).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(results(store.entries)[0]).toContain('не підключено дошку Jira');
  });

  // Every Jira write is signed with this operator's own token from the local registry, so a
  // member without one cannot create anything — and must be told where the token lives.
  it('refuses when this machine holds no personal Jira token', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = false;
    managementChat.mockResolvedValue(reply([{ kind: 'jira.ticket.create', ticket: TICKET }]));

    const store = useManagementChat();
    await store.send('створи тікет у Jira', 'management-home');

    expect(jiraCreateIssue).not.toHaveBeenCalled();
    expect(results(store.entries)[0]).toContain('Немає особистого токена Jira');
    expect(results(store.entries)[0]).toContain('Integrations');
  });

  it('reports a Jira refusal verbatim, because each one has a different fix', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraCreateIssue.mockRejectedValue(new Error('Field "customfield_10010" is required'));
    managementChat.mockResolvedValue(reply([{ kind: 'jira.ticket.create', ticket: TICKET }]));

    const store = useManagementChat();
    await store.send('створи тікет у Jira', 'management-home');

    expect(results(store.entries)[0]).toContain('customfield_10010');
  });

  // THE reported bug, as behaviour. A Jira assignee is an Atlassian account: «Maryna Koval»
  // has a Jira seat and no Kermanych account, so she is in Jira's picker and in no roster.
  // The chat used to refuse her («немає в команді воркспейсу») while the same ticket filed by
  // hand offered her, because the prompt only ever carried the workspace roster.
  it('assigns a Jira user who is not a workspace member at all', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraState.assignable = [
      { accountId: 'acc-maryna', displayName: 'Maryna Koval' },
      { accountId: 'acc-olya', displayName: 'Olya Petrenko' },
    ];
    jiraAssignableUsers.mockResolvedValue([{ accountId: 'acc-maryna', displayName: 'Maryna Koval' }]);
    jiraCreateIssue.mockResolvedValue({ key: 'KRM-216', summary: TICKET.title, issueId: '10502' });
    managementChat.mockResolvedValue(
      reply([{ kind: 'jira.ticket.create', ticket: TICKET, assignee: 'Maryna Koval' }]),
    );

    const store = useManagementChat();
    await store.send('створи тікет у Jira на Maryna Koval', 'management-home');

    // Resolved against JIRA, not the roster — `members` has no Maryna and that is irrelevant.
    expect(jiraAssignableUsers).toHaveBeenCalledWith('w1', 'Maryna Koval');
    const draft = jiraCreateIssue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(draft.assigneeAccountId).toBe('acc-maryna');
    expect(results(store.entries)[0]).toContain('Тікет KRM-216');
    // And the workspace board was never touched: the operator named Jira.
    expect(createTask).not.toHaveBeenCalled();
  });

  // The other half of the fix: the model can only name a Jira assignee if it is SHOWN Jira's
  // list. Without this the assistant had nothing but the roster and refused in prose before
  // any action reached the executor above — which is why the executor's own resolution was
  // already correct and the bug still happened.
  it('sends Jira\u2019s own assignable names in the turn context, separately from the roster', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraState.assignable = [
      { accountId: 'acc-maryna', displayName: 'Maryna Koval' },
      { accountId: 'acc-olya', displayName: 'Olya Petrenko' },
    ];
    managementChat.mockResolvedValue(reply([]));

    const store = useManagementChat();
    await store.send('кого можна поставити в Jira?', 'management-home');

    expect(jiraLoadAssignable).toHaveBeenCalledWith('w1');
    const ask = managementChat.mock.calls[0]?.[0] as { context: { jira?: { assignees: string[] }; members: { name: string }[] } };
    expect(ask.context.jira?.assignees).toEqual(['Maryna Koval', 'Olya Petrenko']);
    // Two distinct lists, never merged: the roster is still the native board's answer.
    expect(ask.context.members.map((m) => m.name)).toEqual(['olya', 'andrii']);
  });

  // An unreadable list must not become «nobody is assignable»: the board is still writable and
  // an unnamed assignee is a normal ticket, so the turn goes out with an empty list the prompt
  // describes as unavailable rather than losing the whole ticket.
  it('still files the ticket when Jira\u2019s assignable list could not be read', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraLoadAssignable.mockResolvedValue([]);
    jiraCreateIssue.mockResolvedValue({ key: 'KRM-217', summary: TICKET.title, issueId: '10503' });
    managementChat.mockResolvedValue(reply([{ kind: 'jira.ticket.create', ticket: TICKET }]));

    const store = useManagementChat();
    await store.send('створи тікет у Jira', 'management-home');

    const ask = managementChat.mock.calls[0]?.[0] as { context: { jira?: { assignees: string[]; canWrite: boolean } } };
    expect(ask.context.jira?.assignees).toEqual([]);
    expect(ask.context.jira?.canWrite).toBe(true);
    expect(results(store.entries)[0]).toContain('Тікет KRM-217');
  });

  // The one refusal that survives: Jira itself does not know the name. It names who IS
  // assignable, because a refusal that only states a negative leaves the operator no move.
  it('refuses a name Jira does not know and lists who can be assigned instead', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraState.assignable = [
      { accountId: 'acc-maryna', displayName: 'Maryna Koval' },
      { accountId: 'acc-olya', displayName: 'Olya Petrenko' },
    ];
    jiraAssignableUsers.mockResolvedValue([]);
    managementChat.mockResolvedValue(
      reply([{ kind: 'jira.ticket.create', ticket: TICKET, assignee: 'Хтось Невідомий' }]),
    );

    const store = useManagementChat();
    await store.send('створи тікет у Jira на Когось', 'management-home');

    expect(jiraCreateIssue).not.toHaveBeenCalled();
    const line = results(store.entries)[0]!;
    expect(line).toContain('Jira не знає виконавця «Хтось Невідомий»');
    expect(line).toContain('Maryna Koval');
    expect(line).toContain('Olya Petrenko');
  });

  // The «attach it somewhere» half of attachments: the model names the operator's own
  // files, the browser resolves each name back to the payload it already holds and uploads
  // it onto the issue it just created. Bytes never come from the model.
  it('uploads the named operator files onto the created issue', async () => {
    jiraState.integration = integration;
    jiraState.tokenPresent = true;
    jiraCreateIssue.mockResolvedValue({ key: 'KRM-218', summary: TICKET.title, issueId: '10502' });
    jiraUploadAttachment.mockResolvedValue({ key: 'KRM-218' });
    managementChat.mockResolvedValue(
      reply([{ kind: 'jira.ticket.create', ticket: TICKET, attachments: ['звіт.pdf', 'чужий.pdf'] }]),
    );

    const store = useManagementChat();
    await store.send('створи тікет у Jira і прикріпи звіт', 'management-home', [
      { name: 'звіт.pdf', mimeType: 'application/pdf', data: 'QUJD' },
    ]);

    // The turn carried the file to the api (context for the model)…
    const ask = managementChat.mock.calls[0]?.[0] as { attachments?: unknown };
    expect(ask.attachments).toEqual([{ name: 'звіт.pdf', mimeType: 'application/pdf', data: 'QUJD' }]);
    // …and its bubble echoes the name without the payload.
    const user = store.entries.find((e) => e.kind === 'user');
    expect(user && 'files' in user ? user.files : undefined).toEqual([{ name: 'звіт.pdf' }]);
    // The named file lands on the issue; the invented name is refused per file, not per ticket.
    expect(jiraUploadAttachment).toHaveBeenCalledTimes(1);
    expect(jiraUploadAttachment).toHaveBeenCalledWith('w1', 'KRM-218', 'звіт.pdf', 'QUJD', 'application/pdf');
    const lines = results(store.entries);
    expect(lines[0]).toContain('Тікет KRM-218');
    expect(lines[1]).toContain('Файл «звіт.pdf» прикріплено до KRM-218');
    expect(lines[2]).toContain('«чужий.pdf» не долучали');
  });
});

// The requirement's second half: an assistant with open questions asks them AND files nothing,
// and the app says so in its own voice — a question buried in prose is a ticket the operator
// keeps waiting for.
describe('ticket.questions', () => {
  it('writes nothing and states that the ticket is waiting on answers', async () => {
    managementChat.mockResolvedValue(
      reply([
        {
          kind: 'ticket.questions',
          forTicket: 'Історія змін рахунку',
          questions: ['Чи бачить історію клієнт, чи лише бухгалтерія?', 'Чи потрібен експорт у файл?'],
        },
      ]),
    );

    const store = useManagementChat();
    await store.send('створи тікет про історію', 'management-home');

    expect(createTask).not.toHaveBeenCalled();
    expect(jiraCreateIssue).not.toHaveBeenCalled();
    const line = results(store.entries)[0] ?? '';
    expect(line).toContain('Історія змін рахунку» не створено');
    expect(line).toContain('1) Чи бачить історію клієнт');
    expect(line).toContain('2) Чи потрібен експорт');
    // `warn`, not `info`: this is work that did not happen.
    expect(store.entries.find((e) => e.kind === 'result')).toMatchObject({ level: 'warn' });
  });
});

// The context is what lets the model name an assignee and know the second board exists at all.
// A turn that sent neither would have it guessing profile uuids and offering Jira blind — and
// each board carries its OWN people, because a Jira seat and a Kermanych account are not the
// same thing.
describe('the ticket context on the ask', () => {
  it('carries both rosters and the Jira board with every turn', async () => {
    jiraState.integration = { id: 'i1', siteUrl: 'https://acme.atlassian.net', projectKey: 'KRM', boardName: 'Kermanych board' };
    jiraState.tokenPresent = true;
    jiraState.assignable = [{ accountId: 'acc-maryna', displayName: 'Maryna Koval' }];
    managementChat.mockResolvedValue(reply([]));

    const store = useManagementChat();
    await store.send('що на дошці?', 'management-home');

    const ask = managementChat.mock.calls[0]?.[0] as { context: Record<string, unknown> };
    expect(ask.context.members).toEqual([
      { name: 'olya', role: 'developer' },
      { name: 'andrii', role: 'owner' },
    ]);
    expect(ask.context.jira).toEqual({
      projectKey: 'KRM',
      boardName: 'Kermanych board',
      canWrite: true,
      assignees: ['Maryna Koval'],
    });
  });

  it('omits the Jira board entirely when the workspace has none', async () => {
    jiraState.integration = null;
    managementChat.mockResolvedValue(reply([]));

    const store = useManagementChat();
    await store.send('що на дошці?', 'management-home');

    const ask = managementChat.mock.calls[0]?.[0] as { context: Record<string, unknown> };
    expect(ask.context.jira).toBeUndefined();
    expect('jira' in ask.context).toBe(false);
  });
});
