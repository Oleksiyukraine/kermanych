// «Дослідження» — the read-only research sessions of the avatar's window
// (docs/specs/2026-11-16-research-mode.md). A research is a `kind: 'chat'` session; these are the
// rules the panel and its store share, kept pure so they are covered by test/research.spec.ts.
import { taskNameFromText } from '@kermanych/core';
import type { Project, Session } from '@kermanych/core';
import { sessionScopedProjectIds } from './scope';

type Scope = { workspaceId?: string | undefined; projectId?: string | undefined };

/**
 * The projects whose researches the panel lists: the whole workspace of the selection — a
 * research spans the workspace, so selecting one of its projects does not narrow the history.
 * A local-only project (no workspace) has only itself.
 */
export function researchScopeIds(
  scope: Scope,
  cloud: Parameters<typeof sessionScopedProjectIds>[1],
  projectWorkspace: Record<string, string>,
): string[] {
  if (scope.workspaceId) return sessionScopedProjectIds({ workspaceId: scope.workspaceId }, cloud, projectWorkspace);
  return scope.projectId ? [scope.projectId] : [];
}

/** The researches of those projects, archived ones hidden, the most recently active first. */
export function researchesIn(sessions: readonly Session[], projectIds: readonly string[]): Session[] {
  const inScope = new Set(projectIds);
  return sessions
    .filter((s) => s.kind === 'chat' && !s.archived && inScope.has(s.projectId))
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
}

/**
 * Where «Новий» starts a research: the selected project when it is bound on this machine,
 * else the open research's own project, else the first bound project of the scope. A research
 * runs in a checkout, so an unbound project never hosts one; `undefined` means none can.
 */
export function researchHomeProject(
  projects: readonly Project[],
  scopeIds: readonly string[],
  selectedProjectId: string | undefined,
  openProjectId: string | undefined,
): Project | undefined {
  const bound = (id: string | undefined) => projects.find((p) => p.id === id && p.localRepoPath !== '');
  return (
    bound(selectedProjectId) ??
    bound(openProjectId) ??
    scopeIds.map((id) => bound(id)).find((p): p is Project => !!p)
  );
}

// The server names a new research `дослідження N` (older rows: `чат N`); such a name says
// nothing, so the title falls back to the opening question.
const DEFAULT_NAME = /^(дослідження|чат) \d+$/;

/** A research's title: the operator's own name, else the first line of its opening question. */
export function researchTitle(s: Pick<Session, 'name' | 'task'>): string {
  const name = s.name?.trim() ?? '';
  if (name && !DEFAULT_NAME.test(name)) return name;
  return taskNameFromText(s.task) || name;
}

/** A turn of this research is running. */
export function researchRunning(s: Pick<Session, 'status'>): boolean {
  return s.status === 'thinking' || s.status === 'tool';
}
