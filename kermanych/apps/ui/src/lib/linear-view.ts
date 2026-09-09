// apps/ui/src/lib/linear-view.ts
// The Linear board's decisions that are worth a test, kept out of the .vue files (the
// tasks-view.ts rule): column grouping, the drag→transition decision, and the launch
// dialog's preselection. Pure functions over cloud types — no store, no I/O. The Jira
// board's twin (lib/jira-view.ts) with Linear's shape: a workflow state per column, and
// no worklogs (Linear has none), so the datetime/worklog helpers are absent here.
import type { LinearColumn, LinearIssue } from '@kermanych/cloud';
import type { Project } from '@kermanych/core';

// The transition shape GET /linear/issues/.../transitions returns (the team's workflow
// states, shaped like a Jira transition with id === stateId, passed through by the api).
export type LinearTransitionView = {
  id: string;
  name: string;
  to: { id: string; name: string; statusCategory: { key: string } };
};

// The board's search box, matching the way every other list in the app filters
// (menu.ts's filterByQuery): tokens split on whitespace, EVERY token must appear
// somewhere in the card — so «sandbox андрій» finds the ticket about the sandbox that is
// also Andrii's, with the two words landing in different fields.
//
// The haystack is what a card actually shows: key, title, assignee, labels, priority.
// `descriptionMd` is deliberately NOT searched — a markdown body would match «*» or «#»
// on every ticket that carries any formatting.
//
// An empty query returns the input array itself, not a copy: this runs on every keystroke
// and the common case is «nothing typed yet».
export function filterIssues(issues: readonly LinearIssue[], query: string): readonly LinearIssue[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return issues;
  return issues.filter((i) => {
    const hay =
      `${i.key} ${i.title} ${i.assigneeName ?? ''} ${i.labels.join(' ')} ${i.priorityName}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

// The board's assignee filter, the search box's companion in the same bar.
//
// A person's identity here is their Linear user id, falling back to the name: a mirror row
// written before the id was stored still names a real, filterable person, and the name is
// then the only identity there is. `UNASSIGNED` cannot collide with either — Linear ids are
// opaque uuids and no display name starts with «@».
export const UNASSIGNED = '@unassigned';

export type LinearAssigneeOption = { id: string; name: string };

function assigneeIdOf(issue: LinearIssue): string | undefined {
  return issue.assigneeId ?? issue.assigneeName ?? undefined;
}

// The people the chip offers: everyone who actually holds a card on this board, deduped and
// sorted by name. Derived from the mirror rather than from Linear's assignable roster, so
// every row in the list is guaranteed to match at least one ticket, it costs no Linear call,
// and it works offline. Tickets with nobody on them contribute no option — the chip's own
// «Unassigned» row reaches those.
export function assigneeOptions(issues: readonly LinearIssue[]): LinearAssigneeOption[] {
  const byId = new Map<string, LinearAssigneeOption>();
  for (const issue of issues) {
    const id = assigneeIdOf(issue);
    if (id && !byId.has(id)) byId.set(id, { id, name: issue.assigneeName ?? id });
  }
  // localeCompare, not the default sort: «Олексій» must land after «Андрій» by the alphabet
  // the names are written in, not by code point.
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// `selected` is '' (anyone), UNASSIGNED, or a person's id from `assigneeOptions`. Like
// `filterIssues`, the «nothing picked» case returns the input array itself rather than a copy
// — it is the common one, and this recomputes whenever the board does.
export function filterByAssignee(issues: readonly LinearIssue[], selected: string): readonly LinearIssue[] {
  if (!selected) return issues;
  if (selected === UNASSIGNED) return issues.filter((i) => !assigneeIdOf(i));
  return issues.filter((i) => assigneeIdOf(i) === selected);
}

// Cards grouped the way Linear's own board groups them: an issue belongs to the first
// column whose state set holds its state. Each Linear column maps EXACTLY ONE workflow
// state, but the set shape is kept for parity with the Jira mirror. An issue mapped to NO
// column is invisible — that is Linear's rule too (an issue in an unshown state does not
// render on the board), and the mirror's promise is «точна копія».
export function issuesByColumn(
  columns: readonly LinearColumn[],
  issues: readonly LinearIssue[],
): Record<number, LinearIssue[]> {
  const out: Record<number, LinearIssue[]> = {};
  for (const col of columns) out[col.position] = [];
  for (const issue of issues) {
    const col = columns.find((c) => c.stateIds.includes(issue.stateId));
    if (col) out[col.position]!.push(issue);
  }
  // Linear orders a column by its own sort order; the mirror carries no rank, so newest
  // activity first — the same «що рухається — вгорі» the native board implies.
  for (const col of columns) out[col.position]!.sort((a, b) => b.linearUpdatedAt.localeCompare(a.linearUpdatedAt));
  return out;
}

// What dropping a card on `column` should do, given the transitions Linear offers this
// issue right now:
//   none — the column's state is unreachable; the card snaps back with that sentence.
//   auto — exactly one way in: transition immediately, no dialog.
//   pick — the column holds several states reachable from here: ask which.
// Every Linear column is single-state, so a drop always resolves to `auto` in practice; the
// `pick` path is kept for parity with the Jira mirror rather than pruned.
export type DropDecision =
  | { kind: 'none' }
  | { kind: 'auto'; transition: LinearTransitionView }
  | { kind: 'pick'; options: LinearTransitionView[] };

export function transitionChoiceForDrop(
  column: LinearColumn,
  transitions: readonly LinearTransitionView[],
): DropDecision {
  const into = transitions.filter((t) => column.stateIds.includes(t.to.id));
  // Two transitions can land in the SAME state; offering both would be asking the user a
  // question with one answer twice.
  const byState = new Map<string, LinearTransitionView>();
  for (const t of into) if (!byState.has(t.to.id)) byState.set(t.to.id, t);
  const options = [...byState.values()];
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
// Status: the agreed rule — a ticket already in Linear's started ("indeterminate")
// category is NOT moved, so `askStatus` is false and no transition travels with the launch.
// Otherwise the picker is shown, preselected to the first transition into a started state.
export type LaunchDefaults = {
  projectId?: string;
  askStatus: boolean;
  transitionId?: string;
};

export function launchDefaults(
  issue: LinearIssue,
  sidebarProjectId: string | null,
  projects: readonly Pick<Project, 'id'>[],
  transitions: readonly LinearTransitionView[],
): LaunchDefaults {
  const out: LaunchDefaults = { askStatus: issue.stateCategory !== 'indeterminate' };

  const known = (id: string | undefined | null) => (id && projects.some((p) => p.id === id) ? id : undefined);
  const projectId =
    known(issue.kermanychProjectId) ?? known(sidebarProjectId) ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (projectId) out.projectId = projectId;

  if (out.askStatus) {
    const started = transitions.find((t) => t.to.statusCategory.key === 'indeterminate');
    if (started) out.transitionId = started.id;
  }
  return out;
}

// The dialog's subtask list: direct children, board-mapped or not — a subtask hidden
// from the columns must still be reachable from its parent.
export function subtasksOf(issues: readonly LinearIssue[], parentKey: string): LinearIssue[] {
  return issues.filter((i) => i.parentKey === parentKey);
}

// ── planning dates ────────────────────────────────────────────────────────────

// Today as Linear spells a day, in the user's OWN calendar: «прострочено» is a statement
// about the day on their wall, so a UTC midnight must not make a card late an evening
// early.
export function todayIso(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// The card's date chip: what to show for a ticket's start/due pair, and whether it is
// late. Linear's own emphasis rule — a done/canceled ticket is never overdue, however long
// its due date has passed, because the work it was late for is finished.
export type LinearDateChip = { start: string; due: string; tone: 'plain' | 'soon' | 'overdue' };

export function dateChip(
  issue: Pick<LinearIssue, 'startDate' | 'dueDate' | 'stateCategory'>,
  today: string,
): LinearDateChip | undefined {
  // DD.MM: a card chip has room for a day and a month, and on a board the year is noise.
  // The full date stays readable in the ticket dialog.
  const start = issue.startDate ? `${issue.startDate.slice(8, 10)}.${issue.startDate.slice(5, 7)}` : '';
  const due = issue.dueDate ? `${issue.dueDate.slice(8, 10)}.${issue.dueDate.slice(5, 7)}` : '';
  if (!start && !due) return undefined;

  let tone: LinearDateChip['tone'] = 'plain';
  // Lexicographic on YYYY-MM-DD is chronological — no Date, no zone, no drift.
  if (issue.dueDate && issue.stateCategory !== 'done') {
    if (issue.dueDate < today) tone = 'overdue';
    else if (issue.dueDate === today) tone = 'soon';
  }
  return { start, due, tone };
}
