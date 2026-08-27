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
export function scopedProjectIds(scope: ScopeInput, cloudProjects: CloudProject[]): string[] {
  if (!scope.workspaceId) return cloudProjects.map((p) => p.id);
  return cloudProjects.filter((p) => p.workspaceId === scope.workspaceId).map((p) => p.id);
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
