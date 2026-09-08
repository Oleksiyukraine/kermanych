// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ManagementChatReply } from '@kermanych/core';
import { useHomeTodo } from '../src/stores/home-todo';
import { useManagementChat, type MgmtChatEntry } from '../src/stores/management-chat';
import { readTodo } from '../src/lib/home-todo';

// The todo.create executor, stated as behaviour. The action is the Home overview's one
// write verb, and three facts carry it:
//
//   * the rows land in the SAME store HomeTodoWidget renders — the tile shows them without
//     a refetch — and in localStorage, so they survive a reload;
//   * the model's text is plain text: markup it writes is escaped into literal characters,
//     never rendered formatting;
//   * the transcript line quotes what landed, because the list has no codes and the tile
//     may be scrolled out of view when the notice prints.
const managementChat = vi.fn();

vi.mock('../src/lib/api', () => ({
  api: { managementChat: (ask: unknown) => managementChat(ask), resetManagementChat: vi.fn() },
}));
vi.mock('../src/stores/orchestrator', () => ({
  useOrchestrator: () => ({ selectedWorkspaceId: 'w1', notify: vi.fn() }),
}));
vi.mock('../src/stores/projects', () => ({
  useProjects: () => ({
    projects: [],
    members: { w1: [] },
    workspaceById: new Map([['w1', { id: 'w1', name: 'Acme' }]]),
    loadMembers: vi.fn(),
  }),
}));
vi.mock('../src/stores/board', () => ({ useBoard: () => ({ createTask: vi.fn() }) }));
vi.mock('../src/stores/jira', () => ({
  useJira: () => ({
    integration: null,
    tokenPresent: false,
    assignable: [],
    probe: vi.fn(),
    loadAssignable: vi.fn(),
    upsert: vi.fn(),
  }),
}));
vi.mock('../src/stores/risks', () => ({
  useRisks: () => ({ byWorkspace: { w1: [] }, load: vi.fn(), create: vi.fn(), save: vi.fn(), remove: vi.fn() }),
}));
vi.mock('../src/stores/release-notes', () => ({ useReleaseNotes: () => ({ generate: vi.fn(), byWorkspace: { w1: [] }, load: vi.fn() }) }));

function reply(actions: ManagementChatReply['actions']): ManagementChatReply {
  return { text: 'Додаю.', actions, rejected: [], notices: [], ms: 10 };
}

function results(entries: readonly MgmtChatEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'result' ? [e.text] : []));
}

beforeEach(() => {
  setActivePinia(createPinia());
  managementChat.mockReset();
  localStorage.clear();
});

describe('todo.create', () => {
  it('appends the items to the shared tile store, persists them and says what landed', async () => {
    managementChat.mockResolvedValue(
      reply([
        {
          kind: 'todo.create',
          items: [
            { text: 'подзвонити Олі', kind: 'check' },
            { text: 'крок один', kind: 'number' },
          ],
        },
      ]),
    );
    const chat = useManagementChat();
    await chat.send('додай у to-do', 'management-home');

    // The reactive copy the tile renders…
    const list = useHomeTodo().listFor('w1');
    expect(list.map((it) => ({ html: it.html, kind: it.kind, done: it.done }))).toEqual([
      { html: 'подзвонити Олі', kind: 'check', done: false },
      { html: 'крок один', kind: 'number', done: false },
    ]);
    // …and the persisted one a reload reads.
    expect(readTodo('w1').map((it) => it.html)).toEqual(['подзвонити Олі', 'крок один']);
    // The transcript quotes what landed, pluralized.
    expect(results(chat.entries).join(' ')).toContain('«подзвонити Олі», «крок один»');
  });

  it('escapes markup the model wrote — literal characters on the tile, never formatting', async () => {
    managementChat.mockResolvedValue(
      reply([{ kind: 'todo.create', items: [{ text: 'use <b>bold</b> & <img src=x>', kind: 'check' }] }]),
    );
    const chat = useManagementChat();
    await chat.send('додай', 'management-home');
    const row = useHomeTodo().listFor('w1')[0]!;
    expect(row.html).toBe('use &lt;b&gt;bold&lt;/b&gt; &amp; &lt;img src=x&gt;');
    expect(row.html).not.toContain('<');
  });

  it('appends after the rows the operator already has, never replacing them', async () => {
    const todos = useHomeTodo();
    todos.append('w1', [{ text: 'існуючий пункт', kind: 'check' }]);
    managementChat.mockResolvedValue(
      reply([{ kind: 'todo.create', items: [{ text: 'новий від асистента', kind: 'check' }] }]),
    );
    await useManagementChat().send('додай', 'management-home');
    expect(useHomeTodo().listFor('w1').map((it) => it.html)).toEqual(['існуючий пункт', 'новий від асистента']);
  });
});
