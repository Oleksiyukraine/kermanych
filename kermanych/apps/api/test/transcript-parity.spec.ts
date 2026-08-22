import { expect, test } from "vitest";
import { reduceRpcEvents, type ToolEntry } from "../src/supervisor/transcript-reducer";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";
import type { RpcEvent } from "@kermanych/core";

// `id` and `at` are allowed to differ — history has no toolCallId and no wall clock.
const visible = (e: ToolEntry) => ({ kind: e.kind, tool: e.tool, status: e.status, target: e.target, stat: e.stat, count: e.count, detail: e.detail });

// The same grep call, once as a live frame pair and once as omp history messages.
const details = { matchCount: 1, fileCount: 1, fileMatches: [{ path: "a/hello.py", count: 1 }], truncated: false, displayContent: "*1\u2502def hi():" };

test("live and rehydrated paths agree on the visible fields of a tool entry", () => {
  const live = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "grep", toolCallId: "c1", args: { pattern: "def", path: "hello.py" } },
      { type: "tool_execution_end", toolName: "grep", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text: "" }], details } },
    ] as RpcEvent[],
    { now: (n) => n },
  ).entries[0] as ToolEntry;

  const history = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "def", path: "hello.py" } }] },
    { role: "toolResult", toolName: "grep", isError: false, details, content: [{ type: "text", text: "" }] },
  ])[0] as ToolEntry;

  expect(visible(history)).toEqual(visible(live));
  expect(visible(live)).toMatchObject({ target: "/def/ hello.py", stat: "1 збігів / 1 ф", count: 1 });
});

test("an edit keeps the same target and diff detail on both paths", () => {
  const editDetails = { path: "apps/ui/src/lib/tip.ts", diff: " 10|before\n-11|gone\n+11|added" };
  const live = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "edit", toolCallId: "c9", args: {} },
      { type: "tool_execution_end", toolName: "edit", toolCallId: "c9", isError: false, result: { content: [], details: editDetails } },
    ] as RpcEvent[],
    { now: (n) => n },
  ).entries[0] as ToolEntry;

  const history = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: {} }] },
    { role: "toolResult", toolName: "edit", isError: false, details: editDetails, content: [] },
  ])[0] as ToolEntry;

  expect(visible(history)).toEqual(visible(live));
  // `edit` is the one tool whose result frame carries an authoritative repo-relative path.
  expect(visible(live)).toMatchObject({ target: "lib/tip.ts", stat: "+1 \u22121" });
});

test("a bash failure agrees on status, stat and clamped detail across both paths", () => {
  const bashDetails = { wallTimeMs: 1_200, exitCode: 2 };
  const text = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
  const live = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c2", args: { command: "make test" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "c2", isError: true, result: { content: [{ type: "text", text }], details: bashDetails } },
    ] as RpcEvent[],
    { now: (n) => n },
  ).entries[0] as ToolEntry;

  const history = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "make test" } }] },
    { role: "toolResult", toolName: "bash", isError: true, details: bashDetails, content: [{ type: "text", text }] },
  ])[0] as ToolEntry;

  expect(visible(history)).toEqual(visible(live));
  expect(visible(live)).toMatchObject({ status: "error", target: "make test", stat: "exit 2 · 1.2 с", count: 1_200 });
  expect(live.detail!.lines).toHaveLength(10);
  expect(live.detail!.totalLines).toBe(32);
});
