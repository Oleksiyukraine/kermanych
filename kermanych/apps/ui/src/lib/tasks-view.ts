// The board's task decisions that are worth a test, kept out of the .vue files: the
// launcher-draft ↔ cloud-card mapping, the «Задачі» inbox filter, and the two permission
// mirrors. The permission functions duplicate rules that the API and tasks_guard() enforce
// for real — their job is to grey a control out before the refusal, never to be the
// refusal.
import type { Task, TaskInsert, TaskPatch } from '@kermanych/cloud';
import type { BranchPrefix, Platform, ThinkingLevel } from '@kermanych/core';

// The optional fields spell out `| undefined` because the launcher CLEARS a select by
// assigning undefined, and exactOptionalPropertyTypes refuses that against a bare `?:`.
export type LauncherDraft = {
  name: string;
  task: string;
  model?: string | undefined;
  effort?: ThinkingLevel | undefined;
  prefix: BranchPrefix;
  platform?: Platform | undefined;
  worktree: boolean;
  hidden: boolean;
  baseBranch?: string | undefined;
};

// Two renamings live here and nowhere else: name/task are the card's title/description,
// and the fork base is `tasks.branch` (the board labels that field «Базова гілка», and
// createSessionFromTask feeds it in as the base).
export function taskInsertFromDraft(
  draft: LauncherDraft,
  projectId: string,
  assigneeId: string,
): TaskInsert & { assigneeId: string } {
  const base = draft.worktree ? draft.baseBranch?.trim() : undefined;
  return {
    projectId,
    title: draft.name.trim(),
    description: draft.task.trim(),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    prefix: draft.prefix,
    ...(draft.platform ? { platform: draft.platform } : {}),
    worktree: draft.worktree,
    hidden: draft.hidden,
    ...(base ? { branch: base } : {}),
    assigneeId,
  };
}

// Unlike the insert, a patch sends every editable field: an absent key means «leave the
// column alone», so clearing the platform in the editor has to travel as an empty string,
// which toTaskRow turns into NULL.
export function taskPatchFromDraft(draft: LauncherDraft): TaskPatch {
  return {
    title: draft.name.trim(),
    description: draft.task.trim(),
    model: draft.model ?? '',
    effort: draft.effort ?? '',
    prefix: draft.prefix,
    platform: draft.platform ?? '',
    worktree: draft.worktree,
    hidden: draft.hidden,
    branch: (draft.worktree ? draft.baseBranch?.trim() : '') ?? '',
  };
}

// Which cards the team's kanban columns are allowed to render, before the operator's own
// scope/project/assignee narrowing (lib/scope.filterTasks) is applied. Two rules, both
// properties of the CARD rather than of the current selection — which is why they live
// here and not in `filterTasks`:
//
// - `!t.jiraKey`: a shadow task minted by a Jira-ticket launch belongs to the Jira view,
//   where the ticket card wears its status chip; the native columns must not show the same
//   work twice.
// - `!t.hidden`: its author checked «Приховати з дошки». The row is untouched everywhere
//   else — its assignee still works it from «Задачі», it still launches and still pushes
//   status — so THIS is the only place the flag is read.
//
// Neither is user-toggleable, and neither is authorization: a hidden card is still a
// project member's card, and the api launches it through the same getTask/claimTask path.
export function boardTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.jiraKey && !t.hidden);
}

// «Задачі» in Агенти is my inbox — the cards I have to work, including ones a colleague
// assigned to me. Unclaimed team cards live on Дошка, so they are deliberately absent.
// Deliberately blind to `hidden`: «приховати» takes a card off the TEAM board, and this is
// the assignee's own list — the one place a hidden card must stay reachable from, or the
// flag would delete work rather than quieten it.
// It filters WITHOUT sorting, so the rows keep the order they arrive in — listTasks' own
// `created_at` ascending — which is where the inbox's ordering is decided, not here.
export function myBacklogTasks(tasks: Task[], userId: string, scopedProjectIds: string[]): Task[] {
  if (!userId) return [];
  const inScope = new Set(scopedProjectIds);
  // `!t.jiraKey`: a shadow task minted by a Jira-ticket launch lives on the Jira view;
  // surfacing it here would offer the same work twice under two names.
  return tasks.filter(
    (t) => t.status === 'backlog' && !t.jiraKey && t.assigneeId === userId && inScope.has(t.projectId),
  );
}

// supervisor.createSessionFromTask refuses `task assigned to someone else`; this is the
// same question asked before the click.
export function canRunTask(task: Task, userId: string): boolean {
  return !task.assigneeId || task.assigneeId === userId;
}

// tasks_guard rule 2b: `null -> X` is open to any member, `X -> anything` belongs to X or
// to the workspace owner. Whether the card is ACTIVE is a separate question the callers
// already ask (an active card cannot be reassigned at all).
export function canAssignTask(task: Task, userId: string, isWorkspaceOwner: boolean): boolean {
  return !task.assigneeId || task.assigneeId === userId || isWorkspaceOwner;
}
