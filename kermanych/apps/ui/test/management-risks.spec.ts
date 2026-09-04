import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ManagementChatReply } from '@kermanych/core';
import type { WorkspaceRisk } from '@kermanych/cloud';
import { useManagementChat, type MgmtChatEntry } from '../src/stores/management-chat';

// The risk executor, stated as behaviour — specifically its destructive half.
//
// `risk.delete` is the only action on this surface with no undo behind it: the row goes and
// `workspace_risk_events` cascades away with it. That puts weight on three things this file
// pins down, because each has a failure mode that is silent rather than loud:
//
//   * a code that is not in the register must delete NOTHING and say so. Postgres answers a
//     delete that matched no row exactly as it answers one that matched, so an unresolved
//     code would otherwise be reported as a successful deletion of nothing;
//   * the transcript line has to carry what the risk WAS, because after the call there is no
//     register row left to read it from;
//   * a refusal — and the likely one here is the owner-only RLS policy, since every other
//     write on this table is member-level — must surface verbatim, not as «не вдалося».
const managementChat = vi.fn();
const riskRemove = vi.fn();
const riskSave = vi.fn();
const riskCreate = vi.fn();

function risk(code: string, event: string): WorkspaceRisk {
  return {
    id: `id-${code}`,
    workspaceId: 'w1',
    code,
    kind: 'threat',
    category: 'external',
    cause: 'причина',
    event,
    consequence: 'наслідок',
    probability: 4,
    impact: 5,
    exposure: 20,
    response: 'reduce',
    responseActions: 'план',
    earlyWarning: '',
    status: 'open',
    closureNote: '',
    raisedAt: '2026-08-30T00:00:00.000Z',
    lastReviewedAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

const register = [risk('R-001', 'тестовий рядок'), risk('R-012', 'постачальник зірве строк')];

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
  useRisks: () => ({
    byWorkspace: { w1: register },
    load: vi.fn(),
    create: (ws: string, input: unknown) => riskCreate(ws, input),
    save: (ws: string, id: string, patch: unknown) => riskSave(ws, id, patch),
    remove: (ws: string, id: string) => riskRemove(ws, id),
  }),
}));
vi.mock('../src/stores/release-notes', () => ({ useReleaseNotes: () => ({ generate: vi.fn() }) }));

function reply(actions: ManagementChatReply['actions']): ManagementChatReply {
  return { text: 'Готово.', actions, rejected: [], notices: [], ms: 10 };
}

function results(entries: readonly MgmtChatEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'result' ? [e.text] : []));
}

beforeEach(() => {
  setActivePinia(createPinia());
  for (const m of [managementChat, riskRemove, riskSave, riskCreate]) m.mockReset();
});

describe('risk.delete', () => {
  it('removes the row the code names and says what was lost', async () => {
    managementChat.mockResolvedValue(reply([{ kind: 'risk.delete', code: 'R-001' }]));
    riskRemove.mockResolvedValue(undefined);

    const store = useManagementChat();
    await store.send('видали R-001', 'management-risks');

    // Resolved to the row's uuid, not the operator-facing code: the register code is what a
    // model can honestly name, the uuid is what the table deletes by.
    expect(riskRemove).toHaveBeenCalledTimes(1);
    expect(riskRemove).toHaveBeenCalledWith('w1', 'id-R-001');
    const [line] = results(store.entries);
    expect(line).toContain('R-001');
    // The statement, not just the code — the register row that held it is gone.
    expect(line).toContain('тестовий рядок');
  });

  // A code nobody filed is the case where a silent success would be worst: the operator reads
  // «видалено» and believes a row left the register that is still sitting in it.
  it('deletes nothing when the code is not in this register', async () => {
    managementChat.mockResolvedValue(reply([{ kind: 'risk.delete', code: 'R-999' }]));

    const store = useManagementChat();
    await store.send('видали R-999', 'management-risks');

    expect(riskRemove).not.toHaveBeenCalled();
    expect(results(store.entries)[0]).toContain('R-999');
    expect(results(store.entries)[0]).toContain('нічого не змінено');
  });

  // Delete is owner-only while select/insert/update on this table are member-level, so this
  // is the refusal a legitimate member actually hits. It has to arrive as the reason, because
  // «ask the owner» and «try again» are different next actions.
  it('reports the refusal verbatim and leaves the register alone', async () => {
    managementChat.mockResolvedValue(reply([{ kind: 'risk.delete', code: 'R-012' }]));
    riskRemove.mockRejectedValue(new Error('new row violates row-level security policy'));

    const store = useManagementChat();
    await store.send('видали R-012', 'management-risks');

    const [line] = results(store.entries);
    expect(line).toContain('R-012');
    expect(line).toContain('row-level security');
  });

  // One refused action must not swallow the ones after it — the batch contract the executor
  // is written to. A delete that fails still has to let the update behind it land.
  it('does not stop the actions that follow it', async () => {
    managementChat.mockResolvedValue(
      reply([
        { kind: 'risk.delete', code: 'R-999' },
        { kind: 'risk.update', code: 'R-012', patch: { probability: 2 } },
      ]),
    );
    riskSave.mockResolvedValue(risk('R-012', 'постачальник зірве строк'));

    const store = useManagementChat();
    await store.send('прибери одне, онови інше', 'management-risks');

    expect(riskSave).toHaveBeenCalledWith('w1', 'id-R-012', { probability: 2 });
    expect(results(store.entries)).toHaveLength(2);
  });
});
