import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ManagementChatReply } from '@kermanych/core';
import { useManagementChat, type MgmtChatEntry } from '../src/stores/management-chat';

// The ticket executor, stated as behaviour. It is the half of «create a ticket from the chat»
// that decides whether anything is written and WHOSE queue it lands in, and every one of its
// refusals exists because the alternative is a card the operator never sees:
//
//   * the wrong project puts the work in front of a team that does not own it;
//   * an unresolvable assignee silently files into nobody's queue.
//
// Jira tickets are not executed here at all: the api's Jira tools write them during the turn,
// and this file only checks that the browser reports those writes and refreshes its board.
//
// The transcript line is the app's own account of what happened — the model is told never to
// claim a write succeeded — so each test asserts the line as well as the write.
const managementChat = vi.fn();
const jiraTokenStatus = vi.fn();
const createTask = vi.fn();
const loadMembers = vi.fn();
const jiraLoadBoard = vi.fn();

const members = [
  { workspaceId: 'w1', userId: 'u-olya', role: 'developer', addedAt: '', profile: { id: 'u-olya', githubUsername: 'olya', displayName: 'Оля Петренко' } },
  { workspaceId: 'w1', userId: 'u-andrii', role: 'owner', addedAt: '', profile: { id: 'u-andrii', githubUsername: 'andrii', displayName: 'Андрій Чесноков' } },
];

const jiraState = {
  integration: null as { id: string; siteUrl: string; projectKey: string; boardName: string } | null | undefined,
  tokenPresent: false,
  // The active board's mirror. Non-empty means the Jira view already loaded it, so `send`
  // does not load it again before the turn.
  issues: [] as unknown[],
};

vi.mock('../src/lib/api', () => ({
  api: {
    managementChat: (ask: unknown) => managementChat(ask),
    resetManagementChat: vi.fn(),
    jiraTokenStatus: (site: string) => jiraTokenStatus(site),
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
    get integrations() {
      return jiraState.integration ? [jiraState.integration] : [];
    },
    get active() {
      return jiraState.integration ?? null;
    },
    get activeId() {
      return jiraState.integration?.id ?? null;
    },
    get tokenPresent() {
      return jiraState.tokenPresent;
    },
    get issues() {
      return jiraState.issues;
    },
    loadBoard: () => jiraLoadBoard(),
    fetchWorklogs: vi.fn(async () => []),
    probe: vi.fn(),
  }),
}));
vi.mock('../src/stores/risks', () => ({
  useRisks: () => ({ byWorkspace: { w1: [] }, load: vi.fn(), create: vi.fn(), save: vi.fn() }),
}));
vi.mock('../src/stores/release-notes', () => ({
  useReleaseNotes: () => ({ generate: vi.fn(), byWorkspace: { w1: [] }, load: vi.fn() }),
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
  return { text: 'Готую тікет.', actions, rejected: [], notices: [], jiraChanges: [], ms: 10 };
}

// The result lines the app wrote this turn — never the model's prose. Takes the entries rather
// than the store, so the helper is typed by the store's own exported entry type.
function results(entries: readonly MgmtChatEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'result' ? [e.text] : []));
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const m of [managementChat, jiraTokenStatus, createTask, loadMembers, jiraLoadBoard]) m.mockReset();
  jiraState.integration = null;
  jiraState.tokenPresent = false;
  jiraState.issues = [];
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

  // `tasks` has no attachment storage, so a file cannot ride onto a native card at all. The
  // card is still worth filing — the text is the valuable part — but the operator asked for a
  // ticket WITH the file, and a silent drop is indistinguishable from an upload that failed.
  it('files the card and states that the named files cannot ride on this board', async () => {
    managementChat.mockResolvedValue(
      reply([{ kind: 'ticket.create', project: 'Kermanych UI', ticket: TICKET, attachments: ['screen.png'] }]),
    );
    createTask.mockImplementation((input: Record<string, unknown>) => ({ ...input, id: 't1' }));

    const store = useManagementChat();
    await store.send('створи тікет і прикріпи скріншот', 'management-home', [
      { name: 'screen.png', mimeType: 'image/png', data: 'QUJD' },
    ]);

    const lines = results(store.entries);
    expect(lines[0]).toContain('створено');
    expect(lines[1]).toContain('Дошка воркспейсу не має вкладень');
    expect(lines[1]).toContain('«screen.png»');
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
    const line = results(store.entries)[0] ?? '';
    expect(line).toContain('Історія змін рахунку» не створено');
    expect(line).toContain('1) Чи бачить історію клієнт');
    expect(line).toContain('2) Чи потрібен експорт');
    // `warn`, not `info`: this is work that did not happen.
    expect(store.entries.find((e) => e.kind === 'result')).toMatchObject({ level: 'warn' });
  });
});

// Jira writes happen server-side, during the turn, through the api's Jira tools; the reply
// lists them in `jiraChanges`. The browser executes nothing — it owes the operator two things:
// each write said in the app's own voice and locale, and a board that shows it.
describe('Jira writes the assistant made during the turn', () => {
  it('prints each change in the operator\'s locale and reloads the Jira board', async () => {
    jiraState.integration = { id: 'i1', siteUrl: 'https://acme.atlassian.net', projectKey: 'KRM', boardName: 'Kermanych board' };
    jiraState.tokenPresent = true;
    jiraState.issues = [{ key: 'KRM-9' }];
    managementChat.mockResolvedValue({
      ...reply([]),
      jiraChanges: [
        { text: 'fallback 1', code: 'jira_issue_created', params: { key: 'KRM-12', summary: 'Export invoices' } },
        { text: 'fallback 2', code: 'jira_issue_transitioned', params: { key: 'KRM-9', status: 'Done' } },
      ],
    });

    const store = useManagementChat();
    await store.send('створи тікет у Jira і закрий KRM-9', 'management-home');

    // Localized from the code, in order — not the server's fallback text.
    expect(results(store.entries)).toEqual(['Jira: створено KRM-12 — Export invoices', 'Jira: KRM-9 → Done']);
    expect(store.entries.filter((e) => e.kind === 'result')).toEqual([
      expect.objectContaining({ level: 'info' }),
      expect.objectContaining({ level: 'info' }),
    ]);
    // The mirror was already loaded before the turn, so this one reload is the refresh.
    expect(jiraLoadBoard).toHaveBeenCalledTimes(1);
  });
});

// The context is what lets the model name an assignee and know the second board exists at all.
// A turn that sent neither would have it guessing profile uuids and offering Jira blind. The
// board list carries only which boards exist and whether this machine may write to them: the
// assistant reads the tickets themselves live through the api's Jira tools.
describe('the ticket context on the ask', () => {
  it('carries the roster and the Jira board list with every turn', async () => {
    jiraState.integration = { id: 'i1', siteUrl: 'https://acme.atlassian.net', projectKey: 'KRM', boardName: 'Kermanych board' };
    jiraState.tokenPresent = true;
    managementChat.mockResolvedValue(reply([]));

    const store = useManagementChat();
    await store.send('що на дошці?', 'management-home');

    const ask = managementChat.mock.calls[0]?.[0] as { context: Record<string, unknown> };
    expect(ask.context.members).toEqual([
      { name: 'olya', role: 'developer' },
      { name: 'andrii', role: 'owner' },
    ]);
    expect(ask.context.jira).toEqual([{ projectKey: 'KRM', boardName: 'Kermanych board', canWrite: true }]);
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
