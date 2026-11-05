// apps/ui/src/lib/buckets.ts
// Which «Агенти» tab a session belongs to. One rule, every reader: the tab counts, the list
// under the tabs (AgentsPage), the agent map's chips — two copies of it would drift, and a
// count that disagrees with the list it counts is worse than no count.
import type { Session } from '@kermanych/core';

// The three buckets. Every non-chat session lands in exactly one, so a tally over them
// accounts for the whole project. The lifecycle they trace:
//   tasks      — backlog, not yet launched: a card, no agent behind it yet
//   agents     — an agent exists: working, blocked on the operator, finished but not closed
//                out (no PR merged, not retired), stopped, crashed or conflicted
//   completed  — finished, or set aside by the operator: the history
// «Агенти» used to be three buckets (Активні / Очікують / Помилки). They were one thing seen
// at three moments — each has a worktree, a branch and the same card controls — so the split
// is gone; the card's status dot says which moment, and the list puts the agents that need a
// human first (lib/agents-board.ts byAgentsOrder). Spec: docs/specs/2026-10-29-agents-tab-and-focus-mode.md.
export type Bucket = 'agents' | 'completed' | 'tasks';

// The tabs, in the order they are drawn.
export const BUCKETS: readonly Bucket[] = ['agents', 'completed', 'tasks'];

// A FORK — a discussion or review branch — is bucketed by the agent it was forked off, not
// by its own status. It is not a unit of work: it owns no branch and no worktree, cascades
// with its parent on delete, and pours its conclusion back into it on merge. Its own row can
// say otherwise — archived under a live parent, still running under a merged one — and on its
// own status it would then sit in another tab than the agent it hangs off, which is the one
// place it means anything.
//
// `parent` resolves a session by id. A fork whose parent is gone falls back to its own
// status rather than vanishing from every bucket.
export function bucketOf(
  s: Session,
  parent: (id: string) => Session | undefined,
): Bucket {
  const owner = (s.parentSessionId ? parent(s.parentSessionId) : undefined) ?? s;
  // Finished and operator-archived sessions are both «done with» — one bucket for both.
  if (owner.archived || owner.status === 'merged') return 'completed';
  if (owner.status === 'backlog') return 'tasks';
  return 'agents';
}

// A stored bucket from before the merge — `kermanych.selection`, the map's chips — read as
// today's. The three retired names all mean «an agent exists», so they all become `agents`;
// anything else unknown reads as nothing.
const RETIRED: Readonly<Record<string, Bucket>> = { active: 'agents', waiting: 'agents', errors: 'agents' };
export function readBucket(raw: unknown): Bucket | undefined {
  if (typeof raw !== 'string') return undefined;
  // Own keys only: the raw value comes from storage, and `toString` must not resolve.
  return BUCKETS.find((b) => b === raw) ?? (Object.hasOwn(RETIRED, raw) ? RETIRED[raw] : undefined);
}
