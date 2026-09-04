import { describe, expect, it } from 'vitest';
import type { Task } from '@kermanych/cloud';
import {
  boardTasks,
  canAssignTask,
  canRunTask,
  myBacklogTasks,
  taskInsertFromDraft,
  taskPatchFromDraft,
  type LauncherDraft,
} from '../src/lib/tasks-view';

const ME = 'u-me';
const OTHER = 'u-other';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    projectId: 'p1',
    title: over.id,
    status: 'backlog',
    worktree: true,
    hidden: false,
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    ...over,
  } as Task;
}

const draft: LauncherDraft = {
  name: '  Add login  ',
  task: '  wire GitHub OAuth  ',
  model: 'opus-5',
  effort: 'high',
  prefix: 'feature',
  platform: 'backend',
  worktree: true,
  hidden: false,
  baseBranch: 'develop',
};

describe('taskInsertFromDraft', () => {
  // The launcher's vocabulary and the board's columns differ in two places, and both used
  // to be resolved by hand at the call site: `name`/`task` are `title`/`description`, and
  // the base branch is `tasks.branch` (the board labels that field «Базова гілка»).
  it('maps the launcher draft onto a card assigned to its author', () => {
    expect(taskInsertFromDraft(draft, 'p1', ME)).toEqual({
      projectId: 'p1',
      title: 'Add login',
      description: 'wire GitHub OAuth',
      model: 'opus-5',
      effort: 'high',
      prefix: 'feature',
      platform: 'backend',
      worktree: true,
      hidden: false,
      branch: 'develop',
      assigneeId: ME,
    });
  });

  // An in-place run has no fork base to record, and a blank one must not become the string
  // "undefined" or an empty column value the API would later read as a branch name.
  it('drops the base branch for an in-place card', () => {
    const insert = taskInsertFromDraft({ ...draft, worktree: false }, 'p1', ME);
    expect(insert.worktree).toBe(false);
    expect('branch' in insert).toBe(false);
  });

  it('omits absent optional params instead of sending undefined keys', () => {
    const insert = taskInsertFromDraft(
      { name: 'T', task: 'body', prefix: 'fix', worktree: true, hidden: false },
      'p1',
      ME,
    );
    expect(Object.keys(insert).sort()).toEqual(
      ['assigneeId', 'description', 'hidden', 'prefix', 'projectId', 'title', 'worktree'].sort(),
    );
  });
});

describe('taskPatchFromDraft', () => {
  it('sends every editable field, so clearing one clears the column', () => {
    expect(taskPatchFromDraft({ ...draft, platform: undefined })).toEqual({
      title: 'Add login',
      description: 'wire GitHub OAuth',
      model: 'opus-5',
      effort: 'high',
      prefix: 'feature',
      platform: '',
      worktree: true,
      hidden: false,
      branch: 'develop',
    });
  });
});

// «Приховати» is a board-visibility flag, so it travels on both writes — the launcher is
// the only editor a hidden card has, and a patch that omitted the key could never un-hide
// one.
describe('hidden on a launcher draft', () => {
  it('sends hidden:true on create, so the card is off the board from birth', () => {
    expect(taskInsertFromDraft({ ...draft, hidden: true }, 'p1', ME).hidden).toBe(true);
  });

  it('sends hidden on every patch, in both directions', () => {
    expect(taskPatchFromDraft({ ...draft, hidden: true }).hidden).toBe(true);
    expect(taskPatchFromDraft({ ...draft, hidden: false }).hidden).toBe(false);
  });
});

describe('myBacklogTasks', () => {
  it('keeps only my backlog cards, and only in scope', () => {
    const mine = task({ id: 'a', assigneeId: ME });
    const theirs = task({ id: 'b', assigneeId: OTHER });
    const unclaimed = task({ id: 'c' });
    const running = task({ id: 'd', assigneeId: ME, status: 'thinking' });
    const elsewhere = task({ id: 'e', assigneeId: ME, projectId: 'p9' });

    const rows = myBacklogTasks([mine, theirs, unclaimed, running, elsewhere], ME, ['p1']);

    expect(rows.map((t) => t.id)).toEqual(['a']);
  });

  // The whole contract of «приховати»: off the team board, still in my own list. If this
  // ever filtered, the flag would silently discard work instead of quietening it — and the
  // sidebar badge, which calls this same function, would agree with the wrong list.
  it('keeps a hidden card — the flag is the board\'s business, not the inbox\'s', () => {
    const rows = myBacklogTasks([task({ id: 'a', assigneeId: ME, hidden: true })], ME, ['p1']);
    expect(rows.map((t) => t.id)).toEqual(['a']);
  });

  it('is empty for a signed-out reader rather than showing everyone', () => {
    expect(myBacklogTasks([task({ id: 'a', assigneeId: ME })], '', ['p1'])).toEqual([]);
  });
});

describe('boardTasks', () => {
  // The kanban's whole guest list. Order is preserved — the columns rely on listTasks'
  // `created_at` ascending — and the two exclusions are the card's own properties, not the
  // operator's filters, which is why they are decided before filterTasks runs.
  it('drops hidden cards and Jira shadows, keeps everything else in order', () => {
    const plain = task({ id: 'a', assigneeId: ME });
    const hidden = task({ id: 'b', assigneeId: ME, hidden: true });
    const shadow = task({ id: 'c', jiraKey: 'KAN-42' });
    const theirs = task({ id: 'd', assigneeId: OTHER });

    expect(boardTasks([plain, hidden, shadow, theirs]).map((t) => t.id)).toEqual(['a', 'd']);
  });

  // A hidden card that is RUNNING is still hidden: the flag is about the board, not about
  // the backlog column, so a launched errand does not reappear as a «в роботі» card.
  it('hides a hidden card in every status, not just backlog', () => {
    const running = task({ id: 'a', assigneeId: ME, hidden: true, status: 'thinking' });
    expect(boardTasks([running])).toEqual([]);
  });
});

describe('canRunTask', () => {
  // Mirrors supervisor.service.ts («task assigned to someone else») so the button is grey
  // BEFORE the POST instead of explaining itself in a toast afterwards.
  it('allows an unclaimed card and my own, refuses somebody else’s', () => {
    expect(canRunTask(task({ id: 'a' }), ME)).toBe(true);
    expect(canRunTask(task({ id: 'b', assigneeId: ME }), ME)).toBe(true);
    expect(canRunTask(task({ id: 'c', assigneeId: OTHER }), ME)).toBe(false);
  });
});

describe('canAssignTask', () => {
  // Mirrors tasks_guard rule 2b: `null -> X` open, `X -> anything` only X or the owner.
  it('follows the database rule, including the owner hatch', () => {
    expect(canAssignTask(task({ id: 'a' }), ME, false)).toBe(true);
    expect(canAssignTask(task({ id: 'b', assigneeId: ME }), ME, false)).toBe(true);
    expect(canAssignTask(task({ id: 'c', assigneeId: OTHER }), ME, false)).toBe(false);
    expect(canAssignTask(task({ id: 'd', assigneeId: OTHER }), ME, true)).toBe(true);
  });
});
