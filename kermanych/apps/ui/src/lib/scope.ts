// The board's and the sidebar's decisions, as pure functions. apps/ui has no
// component tests (see apps/ui/test/*.spec.ts — pure unit only), so anything that can
// be wrong lives here rather than inside a .vue file.
import type { CloudProject, Task, Workspace } from '@kermanych/cloud';

// The «Не призначено» option's value. '' already means "no filter" throughout the UI
// (KSelect renders the placeholder as <option value="">), so unassigned needs a
// sentinel that cannot collide with a uuid.
export const UNASSIGNED = '\u0000unassigned';

export type WorkspaceGroup = { workspace: Workspace; projects: CloudProject[] };

// A project selection always carries its workspace (stores/orchestrator keeps that
// invariant), so both fields being set is normal, not a conflict.
export type ScopeInput = { workspaceId?: string | undefined; projectId?: string | undefined };

export type TaskFilters = {
  scopedProjectIds: string[];
  projectFilter?: string | undefined;
  assigneeFilter?: string | undefined;
};

// Workspace order is the cloud's (created_at); project order inside a group is the
// cloud's too. A project whose workspace is absent from `workspaces` is DROPPED, not
// re-homed: RLS decides which workspaces this user sees, and inventing a group for one
// they cannot read would render a name that does not exist.
export function groupProjectsByWorkspace(
  workspaces: Workspace[],
  cloudProjects: CloudProject[],
): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const workspace of workspaces) groups.set(workspace.id, { workspace, projects: [] });
  for (const project of cloudProjects) groups.get(project.workspaceId)?.projects.push(project);
  return [...groups.values()];
}

// Pushed into stores/orchestrator so selectProject() can resolve a project's workspace
// without importing the projects store (which already depends on orchestrator).
export function projectWorkspaceMap(cloudProjects: CloudProject[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of cloudProjects) map[p.id] = p.workspaceId;
  return map;
}

// Scope stays at the WORKSPACE even when a project is selected: the project narrows
// the board through the «Проєкти» filter instead, which is what keeps that filter
// meaningful and lets the user widen back to the whole group in one click.
//
// The middle case is a LOCAL-ONLY project. It has no cloud row, so the projectId →
// workspaceId map has no entry for it and the selection carries no workspace. Reading
// that missing workspace as "nothing selected" answers the narrowest possible question
// with the widest possible answer — every task in every workspace the user can see —
// whereas the true answer is empty: no cloud task can belong to a project the cloud
// does not have. So an empty scope here is the exact answer, not a degraded one, and
// the board says why and offers publishing (see BoardPage.vue).
export function scopedProjectIds(scope: ScopeInput, cloudProjects: CloudProject[]): string[] {
  if (scope.workspaceId) {
    return cloudProjects.filter((p) => p.workspaceId === scope.workspaceId).map((p) => p.id);
  }
  if (scope.projectId) return [];
  return cloudProjects.map((p) => p.id);
}

// The same three levels for a surface whose rows are LOCAL sessions — the Агенти page. A
// local session exists with no cloud at all, which changes the answer at two of the three
// levels, so this delegates to `scopedProjectIds` where they agree and states where they do
// not, rather than either duplicating it or bending it.
//
// A PROJECT selection answers itself. Cloud and local share one project identity
// (stores/projects.publish() reuses the local id), so the selected id IS the scope. This is
// the case `scopedProjectIds` must never be asked here: its local-only branch returns `[]`,
// which is exact for cloud tasks — a project the cloud does not have can own none — and
// backwards for sessions, because a local-only project is precisely where a developer's own
// agents live. It is also why the project comes FIRST here and second there: on the board a
// project narrows through the «Проєкти» filter and the scope stays at the workspace, while
// here it is the whole question.
//
// A WORKSPACE selection is cloud knowledge, and the cloud list is its authority — but only
// once that list has been READ. Unread, an empty answer does not mean «this workspace holds
// no projects», it means «not known yet», and rendering it would hide every running agent
// from an operator who is merely offline. Unread, the answer therefore comes from
// `projectWorkspace`: the cached projectId → workspaceId map that stores/projects writes
// beside the cached workspaces, and that the sidebar's offline tree already places rows with.
//
// The gate switches the WHOLE collection, which is NOT what MainLayout.workspaceOf() does:
// that is a per-project merge with no `listRead` gate and may answer from the cloud for one
// project and from the cache for another. The two agree in every reachable state — load()
// assigns `listRead` and replaces the map from the same list in adjacent statements, and
// pushProjectWorkspace() merges the map on every single-project mutation — but they are
// different mechanisms, and only this one can say «not known yet» about the set as a whole.
//
// Nothing selected is `[]`, not everything: the page renders its blank invitation. The board
// wants the opposite for the same input, because its unscoped state is «Дошка команди».
export function sessionScopedProjectIds(
  scope: ScopeInput,
  cloud: { projects: CloudProject[]; listRead: boolean },
  projectWorkspace: Record<string, string>,
): string[] {
  if (scope.projectId) return [scope.projectId];
  const workspaceId = scope.workspaceId;
  if (!workspaceId) return [];
  if (cloud.listRead) return scopedProjectIds({ workspaceId }, cloud.projects);
  return Object.keys(projectWorkspace).filter((id) => projectWorkspace[id] === workspaceId);
}

// The three filters INTERSECT: scope, then project, then assignee.
export function filterTasks(tasks: Task[], filters: TaskFilters): Task[] {
  const inScope = new Set(filters.scopedProjectIds);
  const project = filters.projectFilter || undefined;
  const assignee = filters.assigneeFilter || undefined;
  return tasks.filter((t) => {
    if (!inScope.has(t.projectId)) return false;
    if (project && t.projectId !== project) return false;
    // This branch must stay BELOW the project filter. It returns rather than falls
    // through, so hoisting it would let «Не призначено» ignore the chosen project and
    // show unassigned tasks from the whole scope.
    if (assignee === UNASSIGNED) return !t.assigneeId;
    if (assignee && t.assigneeId !== assignee) return false;
    return true;
  });
}

// Drop validity, decided from the dragged id held in component state — NOT from
// dataTransfer, whose getData() is unreadable during `dragover` (protected mode
// exposes only the types). Membership is not checked here: the user only ever sees
// workspaces they belong to, and projects_update_member has the final say.
export function canDropProject(
  draggedProjectId: string | undefined,
  targetWorkspaceId: string,
  cloudProjects: CloudProject[],
): boolean {
  if (!draggedProjectId) return false;
  const project = cloudProjects.find((p) => p.id === draggedProjectId);
  if (!project) return false;
  return project.workspaceId !== targetWorkspaceId;
}
