import { describe, expect, it } from 'vitest';
import type { Session } from '@kermanych/core';
import { planBacklogPublication } from '../src/lib/publish-backlog';

const ME = 'u-me';

function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: 'p1',
    name: over.id,
    task: 'do it',
    worktreePath: '',
    branch: '',
    worktree: true,
    kind: 'task',
    status: 'backlog',
    createdAt: '2026-08-30T10:00:00.000Z',
    lastActivityAt: '2026-08-30T10:00:00.000Z',
    ...over,
  } as Session;
}

describe('planBacklogPublication', () => {
  it('publishes a local backlog row under its own id so a repeat pass collides', () => {
    const row = session({ id: 's-1', name: 'Add login', task: 'wire OAuth', baseBranch: 'develop', model: 'opus-5', prefix: 'fix' });

    const plan = planBacklogPublication([row], new Set(['p1']), ME);

    expect(plan.stranded).toEqual([]);
    expect(plan.publish).toEqual([
      {
        sessionId: 's-1',
        insert: {
          id: 's-1',
          projectId: 'p1',
          title: 'Add login',
          description: 'wire OAuth',
          model: 'opus-5',
          prefix: 'fix',
          worktree: true,
          branch: 'develop',
          assigneeId: ME,
        },
      },
    ]);
  });

  // A project that lives only on this machine cannot host a card: tasks_insert_member
  // checks membership through project_id. Those rows stay put and are shown as such.
  it('strands rows whose project is not in the cloud', () => {
    const local = session({ id: 's-2', projectId: 'p-local' });
    const plan = planBacklogPublication([local], new Set(['p1']), ME);
    expect(plan.publish).toEqual([]);
    expect(plan.stranded.map((s) => s.id)).toEqual(['s-2']);
  });

  it('ignores everything that is not a local backlog task', () => {
    const rows = [
      session({ id: 'a', status: 'thinking', kind: 'agent' }),
      session({ id: 'b', kind: 'chat', status: 'done' }),
      session({ id: 'c', status: 'backlog', kind: 'task', archived: true }),
    ];
    const plan = planBacklogPublication(rows, new Set(['p1']), ME);
    expect(plan.publish).toEqual([]);
    expect(plan.stranded).toEqual([]);
  });
});
