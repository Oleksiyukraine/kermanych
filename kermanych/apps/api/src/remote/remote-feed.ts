// apps/api/src/remote/remote-feed.ts
// Which sessions the phone of «Пульт» sees, and the live events it gets about them
// (docs/specs/2026-11-24-mobile-remote-control.md → Whitelist, «Which sessions the phone lists»).
//
// Listed: exactly the sessions the sidebar's attention mark counts — core `isTracked` over the
// same merged list the desktop draws (non-chat, not archived, not merged, not a backlog card; a
// fork follows its parent). Everything about them goes through core `toRemoteSession`: no paths,
// no env, no git.
//
// The feed turns `supervisor.events$` into the phone's `RemoteEvent`s: a session's update while
// listed, its removal (from the registry, or from the list — archived, merged, its parent
// merged), the transcript events of listed sessions, and the whole list again when a project
// changes. Every other event (previews, git, schedules, the minion, …) is not the phone's.
import { isTracked, toRemoteSession, type RemoteEvent, type RemoteList, type RemoteProject, type ServerEvent, type Session } from "@kermanych/core";

/** The listed sessions of `all`, «needs you» first, then the latest activity. */
export function listedSessions(all: readonly Session[]): Session[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  const parent = (id: string): Session | undefined => byId.get(id);
  return all.filter((s) => isTracked(s, parent)).sort((a, b) => needsYou(b) - needsYou(a) || b.lastActivityAt.localeCompare(a.lastActivityAt));
}

// The phone's «needs you» mark: a question, a failure, a conflict (spec → Context, the attention
// states the desktop already ranks).
function needsYou(s: Session): number {
  return s.status === "waiting_input" || s.status === "error" || s.status === "conflict" ? 1 : 0;
}

export type RemoteFeedSource = {
  /** Every session as the ui sees it (supervisor.mergedSessions). */
  sessions: () => Session[];
  projects: () => { id: string; name: string; color?: string }[];
};

export class RemoteFeed {
  // The listed sessions as the phone last heard of them, by id.
  private listed = new Map<string, Session>();

  constructor(private source: RemoteFeedSource) {}

  /** The whole list, as `GET /sessions` answers and the socket's first event carries. */
  list(): RemoteList {
    const sessions = listedSessions(this.source.sessions());
    this.listed = new Map(sessions.map((s) => [s.id, s]));
    const shown = new Set(sessions.map((s) => s.projectId));
    const projects: RemoteProject[] = this.source
      .projects()
      .filter((p) => shown.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, ...(p.color ? { color: p.color } : {}) }));
    return { projects, sessions: sessions.map(toRemoteSession) };
  }

  isListed(id: string): boolean {
    return this.listed.has(id);
  }

  /** The listed sessions as last seen: the keep-awake rule reads their statuses. */
  current(): Session[] {
    return [...this.listed.values()];
  }

  /** What the phone hears of one server event; nothing for an event that is not its business. */
  map(e: ServerEvent): RemoteEvent[] {
    switch (e.type) {
      case "session_update":
        return this.onSession(e.session);
      case "session_removed": {
        if (!this.listed.delete(e.sessionId)) return [];
        return [{ type: "session_removed", sessionId: e.sessionId }];
      }
      case "transcript_append":
      case "transcript_reset":
      case "transcript_update":
        return this.listed.has(e.sessionId) ? [e] : [];
      case "project_update":
      case "project_removed":
        return [{ type: "list", ...this.list() }];
      default:
        return [];
    }
  }

  // One session moved: the list is recomputed over every session, because a parent's move
  // carries its forks in or out of the list with it (core bucketOf). The updated session's own
  // row is the event's — the freshest there is.
  private onSession(updated: Session): RemoteEvent[] {
    const all = this.source.sessions().map((s) => (s.id === updated.id ? updated : s));
    if (!all.some((s) => s.id === updated.id)) all.push(updated);
    const next = new Map(listedSessions(all).map((s) => [s.id, s]));
    const out: RemoteEvent[] = [];
    for (const id of this.listed.keys()) if (!next.has(id)) out.push({ type: "session_removed", sessionId: id });
    for (const s of next.values()) if (s.id === updated.id || !this.listed.has(s.id)) out.push({ type: "session", session: toRemoteSession(s) });
    this.listed = next;
    return out;
  }
}
