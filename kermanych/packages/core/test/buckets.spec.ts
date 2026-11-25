import { describe, it, expect } from "vitest";
import type { Session } from "../src/types";
import { bucketOf, isTracked } from "../src/buckets";

// Minimal session rows: only the fields the bucket rule reads.
function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: "p1",
    name: over.id,
    task: "",
    worktreePath: "",
    branch: "",
    worktree: false,
    kind: "agent",
    status: "thinking",
    createdAt: "2026-08-27T10:00:00.000Z",
    ...over,
  } as Session;
}

// The resolver both readers pass: a lookup over the sessions that exist.
function resolver(...rows: Session[]) {
  const byId = new Map(rows.map((s) => [s.id, s]));
  return (id: string) => byId.get(id);
}

describe("bucketOf", () => {
  it("files a session by its own state, completed first", () => {
    const live = session({ id: "a", status: "thinking" });
    const backlog = session({ id: "b", status: "backlog", kind: "task" });
    const merged = session({ id: "c", status: "merged" });
    const aside = session({ id: "d", status: "done", archived: true });
    const find = resolver(live, backlog, merged, aside);
    expect(bucketOf(live, find)).toBe("agents");
    expect(bucketOf(backlog, find)).toBe("tasks");
    expect(bucketOf(merged, find)).toBe("completed");
    expect(bucketOf(aside, find)).toBe("completed");
  });

  // Everything an agent can be between launch and close-out is one tab: settled, stopped,
  // pushed for review, crashed, conflicted. A pushed PR in particular must never read as
  // completed, or the cards somebody still has to review are the ones nobody sees.
  it("files every unclosed agent state under agents", () => {
    const states = ["queued", "thinking", "tool", "waiting_input", "done", "stopped", "in_review", "error", "conflict"] as const;
    const rows = states.map((status) => session({ id: status, status }));
    const find = resolver(...rows);
    for (const s of rows) expect(bucketOf(s, find)).toBe("agents");
  });

  it("lets the archive flag win over any agent state", () => {
    const crashed = session({ id: "a", status: "error", archived: true });
    expect(bucketOf(crashed, resolver(crashed))).toBe("completed");
  });

  // A fork is filed by its parent: archived or still running, it stays beside the agent it
  // hangs off rather than in another tab.
  it("keeps an archived fork with its live parent", () => {
    const parent = session({ id: "p", status: "waiting_input" });
    const fork = session({ id: "f", status: "done", kind: "discussion", parentSessionId: "p", archived: true });
    expect(bucketOf(fork, resolver(parent, fork))).toBe("agents");
  });

  it("follows the parent into Завершені while still running", () => {
    const parent = session({ id: "p", status: "merged" });
    const fork = session({ id: "f", status: "thinking", kind: "review", parentSessionId: "p" });
    expect(bucketOf(fork, resolver(parent, fork))).toBe("completed");
  });

  // A fork outlives its parent only if a delete raced the socket update; it must still be
  // reachable in some bucket rather than dropping out of every list.
  it("falls back to its own status when the parent is gone", () => {
    const fork = session({ id: "f", status: "stopped", kind: "discussion", parentSessionId: "p", archived: true });
    expect(bucketOf(fork, resolver(fork))).toBe("completed");
  });
});

// The sessions the sidebar's mark counts and the phone of «Пульт» lists
// (docs/specs/2026-11-24-mobile-remote-control.md → «Which sessions the phone lists»).
describe("isTracked", () => {
  it("tracks the agents bucket and nothing else", () => {
    const live = session({ id: "a", status: "waiting_input" });
    const backlog = session({ id: "b", status: "backlog", kind: "task" });
    const merged = session({ id: "c", status: "merged" });
    const aside = session({ id: "d", status: "error", archived: true });
    const find = resolver(live, backlog, merged, aside);
    expect(isTracked(live, find)).toBe(true);
    expect(isTracked(backlog, find)).toBe(false);
    expect(isTracked(merged, find)).toBe(false);
    expect(isTracked(aside, find)).toBe(false);
  });

  it("never tracks a chat", () => {
    const chat = session({ id: "c", status: "waiting_input", kind: "chat" });
    expect(isTracked(chat, resolver(chat))).toBe(false);
  });

  it("follows a fork's parent", () => {
    const parent = session({ id: "p", status: "merged" });
    const fork = session({ id: "f", status: "waiting_input", kind: "discussion", parentSessionId: "p" });
    expect(isTracked(fork, resolver(parent, fork))).toBe(false);
  });
});
