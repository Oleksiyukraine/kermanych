// The single seam between the local session vocabulary and the cloud task
// vocabulary. Today it is the identity map; if the two ever diverge, this file is
// the only place that changes.
import type { Session } from "@kermanych/core";
import type { TaskStatus } from "./types";

// A terminal task never moves again on its own: the board may stop showing a
// stale-age hint for it, and the outbox may drop pending pushes behind it.
// Mirrors the ACTIVE_STATUSES / NOTIFY_STATUSES convention in @kermanych/core.
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "error", "stopped", "merged", "conflict"];

export function taskStatusFromSession(s: Pick<Session, "status">): TaskStatus {
  return s.status;
}

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(s);
}
