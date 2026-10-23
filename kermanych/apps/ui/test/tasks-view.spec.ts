import { describe, expect, it } from 'vitest';
import type { Task } from '@kermanych/cloud';
import {
  autoRunSwitchLocked,
  boardTasks,
  canAllowAutoRun,
  canAssignTask,
  canRunTask,
  cardModesFromCard,
  myBacklogTasks,
  taskInsertFromDraft,
  taskPatchFromDraft,
  withAutoRun,
  withDeepAnalysis,
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
    deepAnalysis: false,
    autoRun: false,
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
  deepAnalysis: false,
  autoRun: false,
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
      deepAnalysis: false,
      autoRun: false,
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
      { name: 'T', task: 'body', prefix: 'fix', worktree: true, hidden: false, deepAnalysis: false, autoRun: false },
      'p1',
      ME,
    );
    expect(Object.keys(insert).sort()).toEqual(
      ['assigneeId', 'autoRun', 'deepAnalysis', 'description', 'hidden', 'prefix', 'projectId', 'title', 'worktree'].sort(),
    );
  });
});

describe('taskPatchFromDraft', () => {
  it('sends every editable field, so clearing one clears the column', () => {
    expect(taskPatchFromDraft({ ...draft, platform: undefined }, false)).toEqual({
      title: 'Add login',
      description: 'wire GitHub OAuth',
      model: 'opus-5',
      effort: 'high',
      prefix: 'feature',
      platform: '',
      worktree: true,
      hidden: false,
      deepAnalysis: false,
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
    expect(taskPatchFromDraft({ ...draft, hidden: true }, false).hidden).toBe(true);
    expect(taskPatchFromDraft({ ...draft, hidden: false }, false).hidden).toBe(false);
  });
});

// «Глибокий аналіз» is a card field the launch reads, and the launcher is the only place it is
// edited: it travels on both writes, so a backlog card can be switched either way.
describe('deepAnalysis on a launcher draft', () => {
  it('sends deepAnalysis:true on create, so whoever launches the card gets the interview', () => {
    expect(taskInsertFromDraft({ ...draft, deepAnalysis: true }, 'p1', ME).deepAnalysis).toBe(true);
  });

  it('sends deepAnalysis on every patch, in both directions', () => {
    expect(taskPatchFromDraft({ ...draft, deepAnalysis: true }, false).deepAnalysis).toBe(true);
    expect(taskPatchFromDraft({ ...draft, deepAnalysis: false }, false).deepAnalysis).toBe(false);
  });
});

// «Дозволити автовиконання» (docs/specs/2026-10-23-minion-auto-run.md, decision 3): a card field
// on both writes, never together with «Глибокий аналіз», and switched on only by the author.
describe('autoRun on a launcher draft', () => {
  it('sends autoRun on create, and on a patch only when the form changed it', () => {
    expect(taskInsertFromDraft({ ...draft, autoRun: true }, 'p1', ME).autoRun).toBe(true);
    expect(taskPatchFromDraft({ ...draft, autoRun: true }, false).autoRun).toBe(true);
    expect(taskPatchFromDraft({ ...draft, autoRun: false }, true).autoRun).toBe(false);
    // Untouched: a stale copy must neither undo the author's switch nor be refused by the guard.
    expect(taskPatchFromDraft({ ...draft, autoRun: false }, false)).not.toHaveProperty('autoRun');
    expect(taskPatchFromDraft({ ...draft, autoRun: true }, true)).not.toHaveProperty('autoRun');
  });

  it('never writes autoRun beside deepAnalysis', () => {
    const both = { ...draft, deepAnalysis: true, autoRun: true };
    expect(taskInsertFromDraft(both, 'p1', ME)).toMatchObject({ deepAnalysis: true, autoRun: false });
    expect(taskPatchFromDraft(both, true)).toMatchObject({ deepAnalysis: true, autoRun: false });
  });

  it('checking one mode clears the other; unchecking leaves the other alone', () => {
    expect(withAutoRun({ deepAnalysis: true, autoRun: false }, true)).toEqual({ deepAnalysis: false, autoRun: true });
    expect(withDeepAnalysis({ deepAnalysis: false, autoRun: true }, true)).toEqual({ deepAnalysis: true, autoRun: false });
    expect(withAutoRun({ deepAnalysis: false, autoRun: true }, false)).toEqual({ deepAnalysis: false, autoRun: false });
    expect(withDeepAnalysis({ deepAnalysis: true, autoRun: false }, false)).toEqual({ deepAnalysis: false, autoRun: false });
  });

  it('reads the pair from a card, and seeds a new one from the menu', () => {
    expect(cardModesFromCard(task({ id: 'a', autoRun: true }))).toEqual({ deepAnalysis: false, autoRun: true });
    expect(cardModesFromCard(task({ id: 'b', deepAnalysis: true, autoRun: true }))).toEqual({ deepAnalysis: true, autoRun: false });
    expect(cardModesFromCard(undefined, true)).toEqual({ deepAnalysis: true, autoRun: false });
    expect(cardModesFromCard(undefined)).toEqual({ deepAnalysis: false, autoRun: false });
  });

  it('lets only the author switch it on, and anyone switch it off', () => {
    const mine = task({ id: 'a', createdBy: ME });
    const theirs = task({ id: 'b', createdBy: OTHER, autoRun: true });
    expect(canAllowAutoRun(undefined, ME)).toBe(true);
    expect(canAllowAutoRun(mine, ME)).toBe(true);
    expect(canAllowAutoRun(theirs, ME)).toBe(false);
    expect(canAllowAutoRun(task({ id: 'c' }), ME)).toBe(false);
    expect(autoRunSwitchLocked(false, theirs, ME)).toBe(true);
    expect(autoRunSwitchLocked(true, theirs, ME)).toBe(false);
    expect(autoRunSwitchLocked(false, mine, ME)).toBe(false);
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
