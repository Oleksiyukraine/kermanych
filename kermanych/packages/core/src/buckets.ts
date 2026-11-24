// Which «Агенти» tab a session belongs to, and whether it is work the operator tracks. One rule,
// every reader: the tab counts, the list under the tabs (apps/ui AgentsPage), the agent map's
// chips, the sidebar's attention marks — and the phone of «Пульт», which lists exactly the
// sessions the sidebar's mark counts (docs/specs/2026-11-24-mobile-remote-control.md → «Which
// sessions the phone lists»). Two copies of it would drift, and a count that disagrees with the
// list it counts is worse than no count; so it lives here, where the api and the ui both read it.
// Pure: no clock, no storage.
import type { Session } from "./types";

// The three buckets. Every non-chat session lands in exactly one, so a tally over them
// accounts for the whole project. The lifecycle they trace:
//   tasks      — backlog, not yet launched: a card, no agent behind it yet
//   agents     — an agent exists: working, blocked on the operator, finished but not closed
//                out (no PR merged, not retired), stopped, crashed or conflicted
//   completed  — finished, or set aside by the operator: the history
// «Агенти» used to be three buckets (Активні / Очікують / Помилки). They were one thing seen
// at three moments — each has a worktree, a branch and the same card controls — so the split
// is gone; the card's status dot says which moment, and the list puts the agents that need a
// human first (apps/ui lib/agents-board.ts byAgentsOrder). Spec: docs/specs/2026-10-29-agents-tab-and-focus-mode.md.
export type Bucket = "agents" | "completed" | "tasks";

// A FORK — a discussion or review branch — is bucketed by the agent it was forked off, not
// by its own status. It is not a unit of work: it owns no branch and no worktree, cascades
// with its parent on delete, and pours its conclusion back into it on merge. Its own row can
// say otherwise — archived under a live parent, still running under a merged one — and on its
// own status it would then sit in another tab than the agent it hangs off, which is the one
// place it means anything.
//
// `parent` resolves a session by id. A fork whose parent is gone falls back to its own
// status rather than vanishing from every bucket.
export function bucketOf(s: Session, parent: (id: string) => Session | undefined): Bucket {
  const owner = (s.parentSessionId ? parent(s.parentSessionId) : undefined) ?? s;
  // Finished and operator-archived sessions are both «done with» — one bucket for both.
  if (owner.archived || owner.status === "merged") return "completed";
  if (owner.status === "backlog") return "tasks";
  return "agents";
}

// Whether a session is work the operator tracks. Chats are the operator's own conversations,
// not work to track, and anything `bucketOf` files as completed or as a backlog card is out:
// archived and merged work (with the forks that hang off it) needs nothing.
export function isTracked(s: Session, parent: (id: string) => Session | undefined): boolean {
  if (s.kind === "chat") return false;
  const bucket = bucketOf(s, parent);
  return bucket !== "completed" && bucket !== "tasks";
}
