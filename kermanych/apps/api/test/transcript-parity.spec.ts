import { expect, test } from "vitest";
import { reduceRpcEvents, type ToolEntry } from "../src/supervisor/transcript-reducer";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";
import type { RpcEvent } from "@kermanych/core";

// `id` and `at` are allowed to differ — history has no toolCallId and no wall clock.
const visible = (e: ToolEntry) => ({ kind: e.kind, tool: e.tool, status: e.status, target: e.target, stat: e.stat, count: e.count, detail: e.detail });
const firstTool = (entries: readonly unknown[]) => entries[0] as ToolEntry;

// The same grep call, once as a live frame pair and once as omp history messages.
const details = { matchCount: 1, fileCount: 1, fileMatches: [{ path: "a/hello.py", count: 1 }], truncated: false, displayContent: "*1\u2502def hi():" };

test("live and rehydrated paths agree on the visible fields of a tool entry", () => {
  const live = firstTool(
    reduceRpcEvents(
      [
        { type: "tool_execution_start", toolName: "grep", toolCallId: "c1", args: { pattern: "def", path: "hello.py" } },
        { type: "tool_execution_end", toolName: "grep", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text: "" }], details } },
      ] as RpcEvent[],
      { now: (n) => n },
    ).entries,
  );

  const history = firstTool(
    messagesToTranscript([
      { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "def", path: "hello.py" } }] },
      { role: "toolResult", toolName: "grep", isError: false, details, content: [{ type: "text", text: "" }] },
    ]).entries,
  );

  expect(visible(history)).toEqual(visible(live));
  expect(visible(live)).toMatchObject({ target: "/def/ hello.py", stat: { key: "chat.toolStat.matches", params: { matches: 1, files: 1, truncated: false } }, count: 1 });
});

test("an edit keeps the same target and diff detail on both paths", () => {
  const editDetails = { path: "apps/ui/src/lib/tip.ts", diff: " 10|before\n-11|gone\n+11|added" };
  const live = firstTool(
    reduceRpcEvents(
      [
        { type: "tool_execution_start", toolName: "edit", toolCallId: "c9", args: {} },
        { type: "tool_execution_end", toolName: "edit", toolCallId: "c9", isError: false, result: { content: [], details: editDetails } },
      ] as RpcEvent[],
      { now: (n) => n },
    ).entries,
  );

  const history = firstTool(
    messagesToTranscript([
      { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: {} }] },
      { role: "toolResult", toolName: "edit", isError: false, details: editDetails, content: [] },
    ]).entries,
  );

  expect(visible(history)).toEqual(visible(live));
  // `edit` is the one tool whose result frame carries an authoritative repo-relative path.
  expect(visible(live)).toMatchObject({ target: "lib/tip.ts", stat: "+1 \u22121" });
});

test("a non-text result block costs neither path a phantom line", () => {
  // omp may interleave an image block between text blocks; only the text is output.
  const content = [{ type: "text", text: "a" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "b" }];
  const live = firstTool(
    reduceRpcEvents(
      [
        { type: "tool_execution_start", toolName: "read", toolCallId: "c3", args: { path: "a.ts" } },
        { type: "tool_execution_end", toolName: "read", toolCallId: "c3", isError: false, result: { content } },
      ] as RpcEvent[],
      { now: (n) => n },
    ).entries,
  );

  const history = firstTool(
    messagesToTranscript([
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolName: "read", isError: false, content },
    ]).entries,
  );

  expect(visible(history)).toEqual(visible(live));
  expect(live.detail).toEqual({ lines: [{ t: "ctx", text: "a" }, { t: "ctx", text: "b" }], totalLines: 2 });
});

test("a bash failure agrees on the command header, status, stat and clamped detail across both paths", () => {
  const bashDetails = { wallTimeMs: 1_200, exitCode: 2 };
  const text = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
  // Driven the way the service drives it: one frame per call, sharing the caller-owned maps.
  const startedAt = new Map<string, number>();
  const pendingArgs = new Map<string, Record<string, unknown>>();
  let tick = 0;
  const now = () => ++tick;
  const opened = firstTool(
    reduceRpcEvents(
      [{ type: "tool_execution_start", toolName: "bash", toolCallId: "c2", args: { command: "make test" } }] as RpcEvent[],
      { now, startedAt, pendingArgs },
    ).entries,
  );
  const patch = firstTool(
    reduceRpcEvents(
      [{ type: "tool_execution_end", toolName: "bash", toolCallId: "c2", isError: true, result: { content: [{ type: "text", text }], details: bashDetails } }] as RpcEvent[],
      { now, startedAt, pendingArgs },
    ).entries,
  );
  // R2: the end frame patch derives its target from the very args retained for the call, so
  // it can only ever restate the call-time one — `finishTool` applying it clobbers nothing.
  expect(patch.target).toBe(opened.target);

  // Compose the row the way `finishTool` does — this is what the operator actually sees.
  const composed: ToolEntry = { ...opened, status: patch.status, stat: patch.stat, count: patch.count, ms: patch.ms, detail: patch.detail };

  const history = firstTool(
    messagesToTranscript([
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "make test" } }] },
      { role: "toolResult", toolName: "bash", isError: true, details: bashDetails, content: [{ type: "text", text }] },
    ]).entries,
  );

  expect(visible(history)).toEqual(visible(composed));
  expect(visible(composed)).toMatchObject({ status: "error", target: "make test", stat: "exit 2 · 1.2 с", count: 1_200 });
  // The command is the point of opening a bash card: it must survive into the detail on both paths.
  expect(composed.detail!.lines[0]).toEqual({ t: "head", text: "$ make test" });
  expect(history.detail!.lines[0]).toEqual({ t: "head", text: "$ make test" });
  expect(composed.detail!.lines).toHaveLength(10);
  expect(composed.detail!.totalLines).toBe(32);
});
