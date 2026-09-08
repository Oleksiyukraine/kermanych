// apps/ui/src/lib/home-digest.ts
// The Home overview as data, pure — shared by the two consumers that must agree about it:
//
//   1. HomeTasksWidget renders `todayTaskGroups` (which tickets land on today's date, per
//      person);
//   2. the management chat (stores/management-chat.ts) sends `homeDigest` on every ask, so
//      the assistant is shown the SAME overview the operator is looking at — the tile
//      layout, the To-do list, today's tasks and the recent release notes. The capacity and
//      risks tiles are deliberately absent from the digest: the context already carries
//      their data in full (`capacity`, `risks`), and a second copy could disagree with it.
//
// Type-only imports on purpose: the file must stay loadable under bare vitest, which cannot
// resolve @kermanych/cloud's CJS dist (the lib/risk.ts rule).
import type {
  ManagementHome,
  ManagementHomeTaskGroup,
} from '@kermanych/core';
import type { JiraIssue, WorkspaceReleaseNote } from '@kermanych/cloud';
import type { TileLayout } from './dashboard';
import type { TodoItem } from './home-todo';
import { todoPlainText } from './home-todo';
import { UNASSIGNED } from './jira-view';

// A ticket is «for today» when it is still open and today falls in its planning window: due
// today, inside its start→due span, or overdue (past due but not done — still owed today). A
// ticket with no due date has no specific date to be assigned to, so it is not counted here.
export function isForToday(issue: JiraIssue, day: string): boolean {
  if (issue.statusCategory === 'done') return false;
  if (!issue.dueDate) return false;
  if (issue.dueDate <= day) return true; // due today or overdue
  return !!issue.startDate && issue.startDate <= day; // mid-window (started, not yet due)
}

export type TodayTask = { key: string; summary: string; overdue: boolean };
// `name` is '' for the unassigned bucket — the renderer supplies the localized label, the
// digest keeps the ManagementCapacityPerson convention (blank = unassigned).
export type TodayGroup = { id: string; name: string; tasks: TodayTask[] };

// Today's board, per developer: every open ticket whose calendar window includes today,
// grouped under its assignee. People first (busiest first), the unassigned bucket last —
// its tickets are a scheduling gap, not one person's day.
export function todayTaskGroups(issues: readonly JiraIssue[], day: string): TodayGroup[] {
  const byPerson: Record<string, TodayGroup> = {};
  for (const issue of issues) {
    if (!isForToday(issue, day)) continue;
    const id = issue.assigneeAccountId ?? issue.assigneeName ?? UNASSIGNED;
    const name = issue.assigneeName ?? (id === UNASSIGNED ? '' : id);
    (byPerson[id] ??= { id, name, tasks: [] }).tasks.push({
      key: issue.key,
      summary: issue.summary,
      overdue: issue.dueDate < day,
    });
  }
  return Object.values(byPerson).sort((a, b) => {
    if (a.id === UNASSIGNED) return 1;
    if (b.id === UNASSIGNED) return -1;
    return b.tasks.length - a.tasks.length || a.name.localeCompare(b.name);
  });
}

// The releases tile shows the five most recent notes; the digest mirrors the tile, not the
// whole store.
export const HOME_DIGEST_RELEASES = 5;

export function homeDigest(input: {
  layout: readonly TileLayout[];
  todo: readonly TodoItem[];
  groups: readonly TodayGroup[];
  notes: readonly WorkspaceReleaseNote[];
}): ManagementHome {
  const tasksToday: ManagementHomeTaskGroup[] = input.groups.map((g) => ({
    name: g.name,
    tasks: g.tasks.map((t) => ({ key: t.key, summary: t.summary, overdue: t.overdue })),
  }));
  return {
    tiles: input.layout.map((t) => ({ id: t.id, w: t.w, h: t.h })),
    todo: input.todo.map((it) => ({ text: todoPlainText(it.html), kind: it.kind, done: it.done })),
    tasksToday,
    releases: input.notes.slice(0, HOME_DIGEST_RELEASES).map((n) => ({
      title: n.title,
      projectName: n.projectName,
      createdAt: n.createdAt,
    })),
  };
}
