import { describe, expect, test } from "vitest";
import {
  combineReportWrites,
  mergeTaskReports,
  readDocsReport,
  readSessionReport,
  taskReportsWrite,
  type ReportSource,
  type TaskReports,
  type TaskReportsWrite,
} from "../src/task-reports";
import type { TranscriptEntry } from "../src/types";

const session: ReportSource = {
  id: "s1",
  runtime: "omp",
  model: "claude-opus-5-5",
  effort: "high",
  branch: "feature/x",
  baseBranch: "dev",
  worktree: true,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
  ompSessionId: "01a1",
};

const facts = { runtime: "omp", native: false, branch: "feature/x", worktree: true } as const;

function write(over: Partial<TaskReportsWrite>): TaskReportsWrite {
  return { sessionId: "s1", generatedAt: "2026-10-12T10:00:00.000Z", session: facts, ...over };
}

describe("taskReportsWrite", () => {
  test("carries only documentation paths, read and changed", () => {
    const entries = [
      { kind: "tool", id: "1", at: 1, tool: "read", status: "ok", target: "docs/a.md:1-20" },
      { kind: "tool", id: "2", at: 2, tool: "read", status: "ok", target: "src/app.ts" },
      { kind: "tool", id: "3", at: 3, tool: "skill", status: "ok", target: "task-spec" },
    ] as TranscriptEntry[];
    const w = taskReportsWrite({
      session,
      at: "t",
      entries,
      changedFiles: [
        { path: "README.md", added: 3, removed: 1 },
        { path: "src/app.ts", added: 9, removed: 0 },
      ],
    });
    expect(w.read).toEqual(["docs/a.md"]);
    expect(w.skills).toEqual(["task-spec"]);
    expect(w.changed).toEqual([{ path: "README.md", added: 3, removed: 1 }]);
    expect(w.session).toMatchObject({ runtime: "omp", native: false, branch: "feature/x", baseBranch: "dev", providerSessionId: "01a1" });
  });

  test("without a transcript or a listing it says nothing about the lists", () => {
    const w = taskReportsWrite({ session: { ...session, runtime: undefined }, at: "t" });
    expect("read" in w || "skills" in w || "changed" in w).toBe(false);
    expect(w.session.runtime).toBe("omp");
  });
});

describe("mergeTaskReports", () => {
  const card: TaskReports = {
    docs: { sessionId: "s1", generatedAt: "2026-10-12T09:00:00.000Z", read: ["docs/a.md"], changed: [{ path: "docs/old.md", added: 1, removed: 0 }] },
    session: { sessionId: "s1", generatedAt: "2026-10-12T09:00:00.000Z", ...facts, skills: ["task-spec"] },
  };

  test("the same session's reads and skills accumulate, its changed list is replaced", () => {
    const next = mergeTaskReports(card, write({ read: ["README.md", "docs/a.md"], skills: ["librarian"], changed: [{ path: "docs/new.md", added: 2, removed: 0 }] }));
    expect(next?.docs?.read).toEqual(["docs/a.md", "README.md"]);
    expect(next?.docs?.changed).toEqual([{ path: "docs/new.md", added: 2, removed: 0 }]);
    expect(next?.session?.skills).toEqual(["task-spec", "librarian"]);
  });

  test("a write with no lists keeps the card's lists", () => {
    const next = mergeTaskReports(card, write({ session: { ...facts, model: "m2" } }));
    expect(next?.docs?.read).toEqual(["docs/a.md"]);
    expect(next?.docs?.changed).toEqual([{ path: "docs/old.md", added: 1, removed: 0 }]);
    expect(next?.session).toMatchObject({ skills: ["task-spec"], model: "m2" });
  });

  test("an older report of another session is replaced, never merged", () => {
    const next = mergeTaskReports(card, write({ sessionId: "s2", read: ["docs/b.md"] }));
    expect(next?.docs).toMatchObject({ sessionId: "s2", read: ["docs/b.md"], changed: [] });
    expect(next?.session?.skills).toEqual([]);
  });

  test("a write older than another session's report is dropped", () => {
    expect(mergeTaskReports(card, write({ sessionId: "s0", generatedAt: "2026-10-12T08:00:00.000Z" }))).toBeUndefined();
  });
});

describe("combineReportWrites", () => {
  test("a later write without lists keeps the queued lists", () => {
    const turn = write({ read: ["docs/a.md"], skills: ["task-spec"], changed: [{ path: "docs/a.md", added: 1, removed: 0 }] });
    const finish = write({ generatedAt: "2026-10-12T11:00:00.000Z", changed: [{ path: "docs/a.md", added: 4, removed: 0 }] });
    expect(combineReportWrites(turn, finish)).toEqual({
      sessionId: "s1",
      generatedAt: "2026-10-12T11:00:00.000Z",
      read: ["docs/a.md"],
      skills: ["task-spec"],
      changed: [{ path: "docs/a.md", added: 4, removed: 0 }],
      session: facts,
    });
  });

  test("between two sessions the newer write wins whole", () => {
    const old = write({ read: ["docs/a.md"] });
    const relaunch = write({ sessionId: "s2", generatedAt: "2026-10-12T12:00:00.000Z" });
    expect(combineReportWrites(old, relaunch)).toBe(relaunch);
    expect(combineReportWrites(relaunch, old)).toBe(relaunch);
  });
});

describe("reading a stored report", () => {
  test("a docs report keeps its well-formed rows and drops the rest", () => {
    expect(readDocsReport({})).toBeUndefined();
    expect(readDocsReport({ generatedAt: "t", read: ["a.md"] })).toBeUndefined();
    expect(
      readDocsReport({ sessionId: "s1", generatedAt: "t", read: ["a.md", 3, ""], changed: [{ path: "b.md", added: 2 }, { added: 1 }, "c.md"] }),
    ).toEqual({ sessionId: "s1", generatedAt: "t", read: ["a.md"], changed: [{ path: "b.md", added: 2, removed: 0 }] });
  });

  test("a session report needs a known runtime and drops unknown values", () => {
    expect(readSessionReport({ sessionId: "s1", generatedAt: "t", runtime: "codex", branch: "b" })).toBeUndefined();
    expect(
      readSessionReport({ sessionId: "s1", generatedAt: "t", runtime: "claude-code", branch: "b", effort: "turbo", usage: { input: 1 }, skills: ["x", null] }),
    ).toEqual({ sessionId: "s1", generatedAt: "t", runtime: "claude-code", native: false, branch: "b", worktree: true, skills: ["x"] });
  });
});
