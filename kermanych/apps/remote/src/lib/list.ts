// The list's order (spec → «grouped by project, «needs you» first»), pure so test/list.spec.ts can
// pin it. Within a project: sessions that need the operator — a question (`waiting_input`) above a
// failure (`error` / `conflict`) — then the working ones, then the rest; each tier newest first.
// Projects follow their most urgent session, so a project with a question sits on top.

import type { RemoteProject, RemoteSession, SessionStatus } from "@kermanych/core";

/** 0 asks, 1 failed, 2 works, 3 everything else. */
export type Tier = 0 | 1 | 2 | 3;

export function tierOf(status: SessionStatus): Tier {
  if (status === "waiting_input") return 0;
  if (status === "error" || status === "conflict") return 1;
  if (status === "queued" || status === "thinking" || status === "tool") return 2;
  return 3;
}

/** The «потребує уваги» mark: the operator owes the session something. */
export function needsAttention(status: SessionStatus): boolean {
  return tierOf(status) <= 1;
}

function activityOf(s: RemoteSession): number {
  const at = Date.parse(s.lastActivityAt);
  return Number.isNaN(at) ? 0 : at;
}

export function compareSessions(a: RemoteSession, b: RemoteSession): number {
  return tierOf(a.status) - tierOf(b.status) || activityOf(b) - activityOf(a) || a.id.localeCompare(b.id);
}

export type SessionGroup = {
  /** The project id; sessions of a project the list does not name are kept under their own id. */
  id: string;
  /** `undefined` when the project is not in the list — the screen words it «Без проєкту». */
  name: string | undefined;
  color?: string;
  sessions: RemoteSession[];
};

export function groupSessions(sessions: readonly RemoteSession[], projects: readonly RemoteProject[]): SessionGroup[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const groups = new Map<string, SessionGroup>();
  for (const s of [...sessions].sort(compareSessions)) {
    let g = groups.get(s.projectId);
    if (!g) {
      const p = byId.get(s.projectId);
      g = { id: s.projectId, name: p?.name, ...(p?.color ? { color: p.color } : {}), sessions: [] };
      groups.set(s.projectId, g);
    }
    g.sessions.push(s);
  }
  // Each group's first session is its most urgent one (sorted above): order groups by it, and
  // by name when two projects tie, so the order does not jump between two equal updates.
  return [...groups.values()].sort(
    (a, b) => compareSessions(a.sessions[0], b.sessions[0]) || (a.name ?? "").localeCompare(b.name ?? ""),
  );
}
