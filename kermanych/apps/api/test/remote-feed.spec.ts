// What the phone of «Пульт» hears (docs/specs/2026-11-24-mobile-remote-control.md → Whitelist, «live
// updates»): only the sessions the sidebar's mark counts, only their status and transcript events,
// in the phone's projection.
import { describe, expect, it } from "vitest";
import type { ServerEvent, Session } from "@kermanych/core";
import { listedSessions, RemoteFeed } from "../src/remote/remote-feed";

function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: "p1",
    name: over.id,
    task: "",
    worktreePath: "/secret",
    branch: "b",
    worktree: true,
    kind: "agent",
    status: "thinking",
    createdAt: "2026-11-24T09:00:00.000Z",
    lastActivityAt: "2026-11-24T10:00:00.000Z",
    ...over,
  } as Session;
}

function feedOver(rows: { current: Session[] }) {
  return new RemoteFeed({
    sessions: () => rows.current,
    projects: () => [
      { id: "p1", name: "Shop", color: "#f00" },
      { id: "p2", name: "Empty" },
    ],
  });
}

describe("listedSessions", () => {
  it("lists tracked work, «needs you» first, then the latest activity", () => {
    const rows = [
      session({ id: "a", lastActivityAt: "2026-11-24T10:00:00.000Z" }),
      session({ id: "b", status: "error", lastActivityAt: "2026-11-24T08:00:00.000Z" }),
      session({ id: "c", lastActivityAt: "2026-11-24T11:00:00.000Z" }),
      session({ id: "chat", kind: "chat" }),
      session({ id: "merged", status: "merged" }),
      session({ id: "fork", kind: "discussion", parentSessionId: "merged" }),
      session({ id: "card", kind: "task", status: "backlog" }),
    ];
    expect(listedSessions(rows).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });
});

describe("RemoteFeed", () => {
  it("lists the projects that have listed sessions, without paths", () => {
    const rows = { current: [session({ id: "a" })] };
    const list = feedOver(rows).list();
    expect(list.projects).toEqual([{ id: "p1", name: "Shop", color: "#f00" }]);
    expect(list.sessions[0]).not.toHaveProperty("worktreePath");
  });

  it("forwards a listed session's update, and drops what is not the phone's", () => {
    const rows = { current: [session({ id: "a" }), session({ id: "chat", kind: "chat" })] };
    const feed = feedOver(rows);
    feed.list();
    const next = session({ id: "a", status: "waiting_input" });
    rows.current = [next, rows.current[1]!];
    expect(feed.map({ type: "session_update", session: next })).toEqual([{ type: "session", session: expect.objectContaining({ id: "a", status: "waiting_input" }) }]);
    expect(feed.map({ type: "session_update", session: rows.current[1]! })).toEqual([]);
    for (const e of [
      { type: "preview_update", sessionId: "a", state: null },
      { type: "subagents_update", sessionId: "a", subagents: [] },
      { type: "minion_update", state: {} },
      { type: "git_clone", state: {} },
    ] as unknown as ServerEvent[])
      expect(feed.map(e)).toEqual([]);
  });

  it("carries transcript events of listed sessions only", () => {
    const rows = { current: [session({ id: "a" }), session({ id: "chat", kind: "chat" })] };
    const feed = feedOver(rows);
    feed.list();
    const entry = { kind: "assistant_text", id: "t", at: 1, text: "hi" } as const;
    expect(feed.map({ type: "transcript_append", sessionId: "a", entry })).toEqual([{ type: "transcript_append", sessionId: "a", entry }]);
    expect(feed.map({ type: "transcript_append", sessionId: "chat", entry })).toEqual([]);
    expect(feed.map({ type: "transcript_reset", sessionId: "chat", entries: [] })).toEqual([]);
    expect(feed.map({ type: "transcript_update", sessionId: "a", id: "t", status: "ok" })).toEqual([{ type: "transcript_update", sessionId: "a", id: "t", status: "ok" }]);
  });

  it("says a session left when it is archived, and takes its forks with a merged parent", () => {
    const parent = session({ id: "p" });
    const fork = session({ id: "f", kind: "discussion", parentSessionId: "p" });
    const rows = { current: [parent, fork] };
    const feed = feedOver(rows);
    expect(feed.list().sessions.map((s) => s.id).sort()).toEqual(["f", "p"]);
    const merged = { ...parent, status: "merged" as const };
    rows.current = [merged, fork];
    expect(feed.map({ type: "session_update", session: merged })).toEqual([
      { type: "session_removed", sessionId: "p" },
      { type: "session_removed", sessionId: "f" },
    ]);
    expect(feed.isListed("f")).toBe(false);
    // Transcript events of a session that left are not the phone's any more.
    expect(feed.map({ type: "transcript_reset", sessionId: "f", entries: [] })).toEqual([]);
  });

  it("announces a session entering the list, and its removal once", () => {
    const rows = { current: [] as Session[] };
    const feed = feedOver(rows);
    feed.list();
    const fresh = session({ id: "n", status: "queued" });
    rows.current = [fresh];
    expect(feed.map({ type: "session_update", session: fresh })).toEqual([{ type: "session", session: expect.objectContaining({ id: "n" }) }]);
    expect(feed.map({ type: "session_removed", sessionId: "n" })).toEqual([{ type: "session_removed", sessionId: "n" }]);
    expect(feed.map({ type: "session_removed", sessionId: "n" })).toEqual([]);
  });

  it("re-sends the list when a project changes", () => {
    const rows = { current: [session({ id: "a" })] };
    const feed = feedOver(rows);
    const out = feed.map({ type: "project_removed", projectId: "p2" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "list", sessions: [expect.objectContaining({ id: "a" })] });
  });
});
