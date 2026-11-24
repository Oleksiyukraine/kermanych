import { describe, expect, it } from "vitest";
import type { RemoteProject, RemoteSession, SessionStatus } from "@kermanych/core";
import { compareSessions, groupSessions, needsAttention, tierOf } from "../src/lib/list";

function session(id: string, status: SessionStatus, minutesAgo: number, projectId = "p1"): RemoteSession {
  return {
    id,
    projectId,
    name: id,
    status,
    native: false,
    kind: "task",
    lastActivityAt: new Date(Date.UTC(2026, 10, 24, 12, 0) - minutesAgo * 60_000).toISOString(),
  };
}

const projects: RemoteProject[] = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta", color: "#ff0000" },
];

describe("tierOf / needsAttention", () => {
  it("ranks a question above a failure above work above the rest", () => {
    expect(tierOf("waiting_input")).toBe(0);
    expect(tierOf("error")).toBe(1);
    expect(tierOf("conflict")).toBe(1);
    expect(tierOf("queued")).toBe(2);
    expect(tierOf("thinking")).toBe(2);
    expect(tierOf("tool")).toBe(2);
    for (const s of ["done", "in_review", "stopped", "merged", "backlog"] as const) expect(tierOf(s)).toBe(3);
  });

  it("marks only questions and failures as needing the operator", () => {
    expect(needsAttention("waiting_input")).toBe(true);
    expect(needsAttention("error")).toBe(true);
    expect(needsAttention("conflict")).toBe(true);
    expect(needsAttention("thinking")).toBe(false);
    expect(needsAttention("done")).toBe(false);
  });
});

describe("compareSessions", () => {
  it("orders by tier, then newest activity first", () => {
    const list = [
      session("old-done", "done", 50),
      session("new-done", "done", 1),
      session("working", "thinking", 30),
      session("failed", "error", 40),
      session("asks", "waiting_input", 60),
      session("conflict", "conflict", 5),
    ];
    expect(list.sort(compareSessions).map((s) => s.id)).toEqual(["asks", "conflict", "failed", "working", "new-done", "old-done"]);
  });

  it("puts an unparsable time last within its tier", () => {
    const bad = { ...session("bad", "done", 0), lastActivityAt: "not a date" };
    expect([bad, session("ok", "done", 100)].sort(compareSessions).map((s) => s.id)).toEqual(["ok", "bad"]);
  });
});

describe("groupSessions", () => {
  it("groups by project and orders groups by their most urgent session", () => {
    const groups = groupSessions(
      [session("a1", "done", 1, "p1"), session("b1", "thinking", 10, "p2"), session("b2", "waiting_input", 20, "p2"), session("a2", "tool", 2, "p1")],
      projects,
    );
    expect(groups.map((g) => g.id)).toEqual(["p2", "p1"]);
    expect(groups[0]).toMatchObject({ name: "Beta", color: "#ff0000" });
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["b2", "b1"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["a2", "a1"]);
  });

  it("keeps sessions of an unknown project in a nameless group", () => {
    const groups = groupSessions([session("x", "done", 1, "gone")], projects);
    expect(groups).toEqual([{ id: "gone", name: undefined, sessions: [expect.objectContaining({ id: "x" })] }]);
  });

  it("returns no groups for no sessions and leaves the input untouched", () => {
    expect(groupSessions([], projects)).toEqual([]);
    const input = [session("late", "done", 1), session("first", "waiting_input", 9)];
    groupSessions(input, projects);
    expect(input.map((s) => s.id)).toEqual(["late", "first"]);
  });
});
