import { expect, test } from "vitest";
import { reduceRpcEvents, type ToolEntry } from "../src/supervisor/transcript-reducer";
import type { RpcEvent } from "@kermanych/core";

const at = (n: number) => 1_700_000_000_000 + n;

test("a tool call plus its result become one entry carrying stat and clamped detail", () => {
  const events: RpcEvent[] = [
    { type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "a/b/probe.txt" }, intent: "Reading probe file" },
    {
      type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false,
      result: { content: [{ type: "text", text: "ignored" }], details: { totalLines: 3, fileSize: 17, displayContent: { text: "alpha\nbeta\ngamma", lineNumbers: [1, 2, 3] } } },
    },
  ];
  const { entries, full } = reduceRpcEvents(events, { now: at });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "tool", id: "c1", tool: "read", status: "ok",
    intent: "Reading probe file", target: "b/probe.txt", stat: "3 ln", count: 3,
  });
  expect(full.get("c1")).toHaveLength(3);
});

test("a preview longer than the tool budget is clamped while the cache keeps everything", () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const { entries, full } = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "seq 40" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text }], details: { wallTimeMs: 21 } } },
    ],
    { now: at },
  );
  const entry = entries[0] as Extract<(typeof entries)[number], { kind: "tool" }>;
  expect(entry.detail!.lines).toHaveLength(10);
  expect(entry.detail!.totalLines).toBe(42);
  expect(full.get("c1")).toHaveLength(42);
});

test("an errored tool keeps its detail and flips status", () => {
  const { entries } = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "false" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "c1", isError: true, result: { content: [{ type: "text", text: "boom" }], details: { wallTimeMs: 4, exitCode: 1 } } },
    ],
    { now: at },
  );
  expect(entries[0]).toMatchObject({ status: "error", stat: "exit 1 · 4 ms" });
});

test("assistant message_end yields thinking, text and a non-rendering turn entry", () => {
  const { entries } = reduceRpcEvents(
    [
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weigh" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } },
      {
        type: "message_end",
        message: {
          role: "assistant", model: "claude-opus-4-8", duration: 5_877,
          usage: { input: 2, output: 228, cacheRead: 0, cacheWrite: 31_472, cost: { total: 0.2024 } },
        },
      },
    ],
    { now: at },
  );
  expect(entries.map((e) => e.kind)).toEqual(["assistant_thinking", "assistant_text", "turn"]);
  expect(entries[0]).toMatchObject({ ms: 5_877 });
  expect(entries[2]).toMatchObject({ kind: "turn", model: "claude-opus-4-8", usage: { cost: 0.2024, cacheWrite: 31_472 } });
});

test("a toolResult message_end does not duplicate the tool entry", () => {
  const { entries } = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "a.ts" } },
      { type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text: "x" }], details: { totalLines: 1 } } },
      { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", details: { totalLines: 1 } } },
    ],
    { now: at },
  );
  expect(entries.filter((e) => e.kind === "tool")).toHaveLength(1);
});

test("notice frames become notice entries instead of vanishing", () => {
  const { entries } = reduceRpcEvents([{ type: "notice", message: "context is getting full" }], { now: at });
  expect(entries[0]).toMatchObject({ kind: "notice", level: "info", text: "context is getting full" });
});

// How the live service actually drives the reducer: one event per call, with the caller
// owning the buffers and the start-time map.
test("start and end frames arriving in separate calls keep the call-time target and the wall time", () => {
  const startedAt = new Map<string, number>();
  let tick = 0;
  const now = () => at(++tick);
  const opened = reduceRpcEvents(
    [{ type: "tool_execution_start", toolName: "grep", toolCallId: "c1", args: { pattern: "def", path: "hello.py" } }],
    { now, startedAt },
  );
  expect(opened.entries[0]).toMatchObject({ kind: "tool", id: "c1", status: "pending", target: "/def/ hello.py" });

  const closed = reduceRpcEvents(
    [{ type: "tool_execution_end", toolName: "grep", toolCallId: "c1", isError: false, result: { content: [], details: { matchCount: 2, fileCount: 1 } } }],
    { now, startedAt },
  );
  const patch = closed.entries[0] as ToolEntry;
  expect(patch).toMatchObject({ kind: "tool", id: "c1", status: "ok", stat: "2 збігів / 1 ф", ms: 1 });
  // The end frame carries no args; inventing a target here would clobber the pattern.
  expect(patch.target).toBeUndefined();
});

test("the assistant buffers survive across calls and come back emptied", () => {
  const first = reduceRpcEvents([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "half " } }], { now: at });
  expect(first).toMatchObject({ entries: [], textBuf: "half " });
  const second = reduceRpcEvents([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }], { now: at, textBuf: first.textBuf });
  const ended = reduceRpcEvents([{ type: "message_end", message: { role: "assistant" } }], { now: at, textBuf: second.textBuf });
  expect(ended.entries[0]).toMatchObject({ kind: "assistant_text", text: "half done" });
  expect(ended.textBuf).toBe("");
});
