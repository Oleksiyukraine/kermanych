// apps/ui/src/lib/buckets.ts
// Which sidebar bucket a session belongs to. One rule, two readers: the sidebar tallies it
// (MainLayout) and the board filters by it (WorkspacePage) — two copies of it would drift,
// and a count that disagrees with the list it counts is worse than no count.
import type { Session } from '@kermanych/core';

// The four buckets. Every non-chat session lands in exactly one, so a tally over them
// accounts for the whole project. error/conflict are Активні: they need attention.
export type Bucket = 'active' | 'tasks' | 'archived' | 'history';

// Settled lifecycle states — the agent is no longer working and is not waiting on anyone.
const HISTORY: readonly Session['status'][] = ['merged', 'done', 'stopped'];

// A FORK — a discussion or review branch — is bucketed by the agent it was forked off, not
// by its own status. It is not a unit of work: it owns no branch and no worktree, cascades
// with its parent on delete, and pours its conclusion back into it on merge. It is also
// `done` from the moment it exists (supervisor.branchSession settles the forked conversation
// immediately), so its own status would file every fresh branch under Історія — away from
// the live agent it hangs off, which is the one place it means anything.
//
// `parent` resolves a session by id. A fork whose parent is gone falls back to its own
// status rather than vanishing from every bucket.
export function bucketOf(
  s: Session,
  parent: (id: string) => Session | undefined,
): Bucket {
  const owner = (s.parentSessionId ? parent(s.parentSessionId) : undefined) ?? s;
  if (owner.archived) return 'archived';
  if (owner.status === 'backlog') return 'tasks';
  return HISTORY.includes(owner.status) ? 'history' : 'active';
}
