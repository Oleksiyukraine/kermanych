// The single seam between the local session vocabulary and the cloud task
// vocabulary: this file is the only place the two are allowed to differ.
import type { Session } from "@kermanych/core";
import type { TaskStatus } from "./types";

// A terminal task never moves again on its own: the board may stop showing a
// stale-age hint for it, and the outbox may drop pending pushes behind it.
// Mirrors the ACTIVE_STATUSES / NOTIFY_STATUSES convention in @kermanych/core.
// `in_review` belongs here: the branch is pushed and the card sits still until a human
// reviewer moves it, so age says nothing about it either.
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "in_review", "error", "stopped", "merged", "conflict"];

// The statuses a card holds while its machine drives it, with nobody owing it anything. Only
// these can go stale: `waiting_input` is legitimately quiet for hours, and `backlog` plus the
// end states do not move by definition. `tool` stays listed for rows written before
// taskStatusFromSession collapsed it, and by machines that still run an older build.
export const SELF_DRIVING_TASK_STATUSES: readonly TaskStatus[] = ["queued", "thinking", "tool"];

// How often a machine re-pushes an unchanged self-driving status. The board's stale hint reads
// the age of `updated_at`, and the coarse status below no longer moves on every tool call, so
// this is what keeps a live card fresh. Must stay well under the board's stale threshold (90 s).
export const TASK_STATUS_KEEPALIVE_MS = 45_000;

// `tool` is `thinking` on the card: both are «В роботі», and the flip between them happens on
// every tool call — two cloud writes, each sent to every subscribed client by Realtime. The
// session keeps the fine status locally.
export function taskStatusFromSession(s: Pick<Session, "status">): TaskStatus {
  return s.status === "tool" ? "thinking" : s.status;
}

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(s);
}
