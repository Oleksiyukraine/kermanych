import { expect, test } from "vitest";
import { taskStatusFromSession, isTerminalTaskStatus } from "../src/status";
import type { TaskStatus } from "../src/types";

const ALL: TaskStatus[] = [
  "backlog", "queued", "thinking", "tool", "waiting_input",
  "done", "error", "stopped", "merged", "conflict",
];

test("taskStatusFromSession is the identity map today", () => {
  for (const status of ALL) {
    expect(taskStatusFromSession({ status })).toBe(status);
  }
});

test("taskStatusFromSession ignores everything except status", () => {
  expect(taskStatusFromSession({ status: "thinking", contextPercent: 42 } as { status: TaskStatus })).toBe("thinking");
});

test("isTerminalTaskStatus marks exactly the five end states", () => {
  expect(ALL.filter(isTerminalTaskStatus)).toEqual(["done", "error", "stopped", "merged", "conflict"]);
});

test("isTerminalTaskStatus rejects the active and backlog states", () => {
  for (const status of ["backlog", "queued", "thinking", "tool", "waiting_input"] as TaskStatus[]) {
    expect(isTerminalTaskStatus(status)).toBe(false);
  }
});
