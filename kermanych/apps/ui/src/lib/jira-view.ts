// apps/ui/src/lib/jira-view.ts
// The Jira board's decisions that are worth a test, kept out of the .vue files (the
// tasks-view.ts rule): column grouping, the drag→transition decision, and the launch
// dialog's preselection. Pure functions over cloud types — no store, no I/O.
import type { JiraColumn, JiraIssue } from '@kermanych/cloud';
import type { Project } from '@kermanych/core';

// The transition shape GET /jira/issues/.../transitions returns (the Jira wire shape,
// passed through by the api).
export type JiraTransitionView = {
  id: string;
  name: string;
  to: { id: string; name: string; statusCategory: { key: string } };
};

// Cards grouped the way Jira's own board groups them: an issue belongs to the first
// column whose status set holds its status. An issue mapped to NO column is invisible —
// that is Jira's rule too (an unmapped status does not render on the board), and the
// mirror's promise is «точна копія».
//
// Subtasks stay on the board like any other card only if their status maps; Jira kanban
// boards show subtasks as cards, so no special-casing here.
export function issuesByColumn(
  columns: readonly JiraColumn[],
  issues: readonly JiraIssue[],
): Record<number, JiraIssue[]> {
  const out: Record<number, JiraIssue[]> = {};
  for (const col of columns) out[col.position] = [];
  for (const issue of issues) {
    const col = columns.find((c) => c.statusIds.includes(issue.statusId));
    if (col) out[col.position]!.push(issue);
  }
  // Jira orders a column by rank; the mirror carries no rank, so newest activity first —
  // the same «що рухається — вгорі» the native board's stale logic implies.
  for (const col of columns) out[col.position]!.sort((a, b) => b.jiraUpdatedAt.localeCompare(a.jiraUpdatedAt));
  return out;
}

// What dropping a card on `column` should do, given the transitions Jira offers this
// issue right now:
//   none — Jira's workflow forbids the move; the card snaps back with that sentence.
//   auto — exactly one way in: transition immediately, no dialog.
//   pick — the column holds several statuses reachable from here: ask which.
export type DropDecision =
  | { kind: 'none' }
  | { kind: 'auto'; transition: JiraTransitionView }
  | { kind: 'pick'; options: JiraTransitionView[] };

export function transitionChoiceForDrop(
  column: JiraColumn,
  transitions: readonly JiraTransitionView[],
): DropDecision {
  const into = transitions.filter((t) => column.statusIds.includes(t.to.id));
  // Two transitions can land in the SAME status (Jira allows parallel arrows); offering
  // both would be asking the user a question with one answer twice.
  const byStatus = new Map<string, JiraTransitionView>();
  for (const t of into) if (!byStatus.has(t.to.id)) byStatus.set(t.to.id, t);
  const options = [...byStatus.values()];
  if (options.length === 0) return { kind: 'none' };
  if (options.length === 1) return { kind: 'auto', transition: options[0]! };
  return { kind: 'pick', options };
}

// The launch dialog's two preselections.
//
// Project: the ticket's remembered binding wins (a relaunch must not re-ask), then the
// sidebar's currently selected project (the user's declared context), then the only
// project there is. `undefined` means the picker starts empty and the user must choose.
//
// Status: the agreed rule — a ticket already in Jira's In-Progress category is NOT
// moved, so `askStatus` is false and no transition travels with the launch. Otherwise
// the picker is shown, preselected to the first transition into In-Progress.
export type LaunchDefaults = {
  projectId?: string;
  askStatus: boolean;
  transitionId?: string;
};

export function launchDefaults(
  issue: JiraIssue,
  sidebarProjectId: string | null,
  projects: readonly Pick<Project, 'id'>[],
  transitions: readonly JiraTransitionView[],
): LaunchDefaults {
  const out: LaunchDefaults = { askStatus: issue.statusCategory !== 'indeterminate' };

  const known = (id: string | undefined | null) => (id && projects.some((p) => p.id === id) ? id : undefined);
  const projectId =
    known(issue.kermanychProjectId) ?? known(sidebarProjectId) ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (projectId) out.projectId = projectId;

  if (out.askStatus) {
    const inProgress = transitions.find((t) => t.to.statusCategory.key === 'indeterminate');
    if (inProgress) out.transitionId = inProgress.id;
  }
  return out;
}

// The dialog's subtask list: direct children, board-mapped or not — a subtask hidden
// from the columns must still be reachable from its parent.
export function subtasksOf(issues: readonly JiraIssue[], parentKey: string): JiraIssue[] {
  return issues.filter((i) => i.parentKey === parentKey);
}
