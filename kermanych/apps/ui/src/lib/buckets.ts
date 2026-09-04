// apps/ui/src/lib/buckets.ts
// Which sidebar bucket a session belongs to. One rule, two readers: the sidebar tallies it
// (MainLayout) and the board filters by it (WorkspacePage) — two copies of it would drift,
// and a count that disagrees with the list it counts is worse than no count.
import type { Session } from '@kermanych/core';

// The five buckets. Every non-chat session lands in exactly one, so a tally over them
// accounts for the whole project. The lifecycle they trace:
//   tasks      — backlog, not yet launched
//   active     — an agent is working or is blocked on the operator
//   waiting    — the agent finished but the task is not closed out (not merged, no PR yet)
//   completed  — merged, or set aside by the operator (the old «Відкладені»)
//   errors     — a merge failure, a conflict, or any other error that needs a human
export type Bucket = 'active' | 'waiting' | 'completed' | 'errors' | 'tasks';

// The agent finished on its own but the work is not closed out — it is waiting for a merge
// or a review. `in_review` sits here rather than in «Завершені»: a pushed PR is exactly the
// «not merged» case this bucket is named for, and filing it as completed would hide the very
// cards somebody still has to review. `stopped` sits here too: an interrupted run is settled
// but undecided, not done.
const WAITING: readonly Session['status'][] = ['done', 'in_review', 'stopped'];

// Needs a human before it can move: a failed merge, a conflict, or a crashed run.
const ERRORS: readonly Session['status'][] = ['error', 'conflict'];

// A FORK — a discussion or review branch — is bucketed by the agent it was forked off, not
// by its own status. It is not a unit of work: it owns no branch and no worktree, cascades
// with its parent on delete, and pours its conclusion back into it on merge. It is also
// `done` from the moment it exists (supervisor.branchSession settles the forked conversation
// immediately), so its own status would file every fresh branch under «Очікують» — away from
// the live agent it hangs off, which is the one place it means anything.
//
// `parent` resolves a session by id. A fork whose parent is gone falls back to its own
// status rather than vanishing from every bucket.
export function bucketOf(
  s: Session,
  parent: (id: string) => Session | undefined,
): Bucket {
  const owner = (s.parentSessionId ? parent(s.parentSessionId) : undefined) ?? s;
  // Merged and operator-archived sessions are both «done with» — one bucket for both.
  if (owner.archived || owner.status === 'merged') return 'completed';
  if (owner.status === 'backlog') return 'tasks';
  if (ERRORS.includes(owner.status)) return 'errors';
  if (WAITING.includes(owner.status)) return 'waiting';
  return 'active';
}
