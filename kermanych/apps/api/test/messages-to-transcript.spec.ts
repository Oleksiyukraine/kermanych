import { expect, test } from "vitest";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";

// Every fixture in this file is CONSTRUCTED from omp's documented frame shapes, not recorded
// from a live omp run. The `usage` / `duration` / `model` fields in particular are the shape
// the live `message_end` frame carries; whether omp's converted `get_messages_page` history
// preserves them could not be verified, which is why the mapper no-ops when they are absent.
const entriesOf = (messages: unknown[]) => messagesToTranscript(messages).entries;

test("maps assistant reasoning before text, preserving in-message order", () => {
  const out = entriesOf([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "weigh options" },
        { type: "text", text: "Here is the answer." },
      ],
    },
  ]);
  expect(out).toEqual([
    { kind: "assistant_thinking", id: "h1", at: 1, text: "weigh options" },
    { kind: "assistant_text", id: "h2", at: 1, text: "Here is the answer." },
  ]);
});

test("skips empty/whitespace reasoning parts", () => {
  const out = entriesOf([
    { role: "assistant", content: [{ type: "thinking", thinking: "  " }, { type: "text", text: "x" }] },
  ]);
  expect(out).toEqual([{ kind: "assistant_text", id: "h1", at: 1, text: "x" }]);
});

test("prefers the message timestamp over the ordering counter", () => {
  const out = entriesOf([{ role: "user", timestamp: 1_700_000_000_000, content: [{ type: "text", text: "hi" }] }]);
  expect(out).toEqual([{ kind: "user_text", id: "h1", at: 1_700_000_000_000, text: "hi" }]);
});

test("rebuilds the turn accounting and the reasoning duration when history preserves them", () => {
  const out = entriesOf([
    {
      role: "assistant", model: "claude-opus-4-8", duration: 12_000,
      usage: { input: 3, output: 44, cacheRead: 1, cacheWrite: 2, cost: { total: 0.31 } },
      content: [{ type: "thinking", thinking: "weigh options" }, { type: "text", text: "done" }],
    },
  ]);
  expect(out).toEqual([
    { kind: "assistant_thinking", id: "h1", at: 1, text: "weigh options", ms: 12_000, tokens: 44 },
    { kind: "assistant_text", id: "h2", at: 1, text: "done" },
    { kind: "turn", id: "h3", at: 1, model: "claude-opus-4-8", ms: 12_000, usage: { input: 3, output: 44, cacheRead: 1, cacheWrite: 2, cost: 0.31 } },
  ]);
});

test("emits no turn entry when history carries no accounting, rather than a zero-cost one", () => {
  const out = entriesOf([{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
  expect(out).toEqual([{ kind: "assistant_text", id: "h1", at: 1, text: "done" }]);
});

test("collapses a tool call and its result into one entry with target, stat and detail", () => {
  const out = entriesOf([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] },
    {
      role: "toolResult", toolName: "read", isError: false,
      details: { totalLines: 2, displayContent: { text: "one\ntwo", lineNumbers: [1, 2] } },
      content: [{ type: "text", text: "" }],
    },
  ]);
  expect(out).toEqual([
    { kind: "user_text", id: "h1", at: 1, text: "hi" },
    {
      kind: "tool", id: "h2", at: 2, tool: "read", status: "ok", target: "src/a.ts", stat: "2 ln", count: 2,
      detail: { lines: [{ t: "ctx", n: "1", text: "one" }, { t: "ctx", n: "2", text: "two" }], totalLines: 2 },
    },
  ]);
});

test("returns the unclamped lines keyed by the entry id, so a rehydrated row can be expanded", () => {
  const text = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
  const { entries, full } = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "seq 30" } }] },
    { role: "toolResult", toolName: "bash", isError: false, details: { wallTimeMs: 5 }, content: [{ type: "text", text }] },
  ]);
  const row = entries[0] as Extract<(typeof entries)[number], { kind: "tool" }>;
  expect(row.id).toBe("h1");
  expect(row.detail!.lines).toHaveLength(10);
  expect(row.detail!.totalLines).toBe(32);
  // Same key the entry carries — the expand endpoint looks it up by the row's id.
  expect(full.get("h1")).toHaveLength(32);
});

test("marks failed results as error and reduces them with the paired call's arguments", () => {
  const out = entriesOf([
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "false" } }] },
    { role: "toolResult", toolName: "bash", isError: true, details: { wallTimeMs: 4, exitCode: 1 }, content: [{ type: "text", text: "" }] },
  ]);
  expect(out).toEqual([
    {
      kind: "tool", id: "h1", at: 1, tool: "bash", status: "error", target: "false", stat: "exit 1 · 4 ms", count: 4,
      // The result frame has no args of its own; they are carried over from the paired toolCall.
      detail: { lines: [{ t: "head", text: "$ false" }, { t: "head", text: "wall 4 ms · exit 1" }], totalLines: 2 },
    },
  ]);
});

test("pairs parallel same-name calls FIFO when history carries no call ids", () => {
  const out = entriesOf([
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", name: "read", arguments: { path: "b.ts" } },
      ],
    },
    { role: "toolResult", toolName: "read", isError: false, details: { totalLines: 1, displayContent: { text: "A", lineNumbers: [1] } }, content: [] },
    { role: "toolResult", toolName: "read", isError: false, details: { totalLines: 1, displayContent: { text: "B", lineNumbers: [1] } }, content: [] },
  ]);
  expect(out).toEqual([
    { kind: "tool", id: "h1", at: 1, tool: "read", status: "ok", target: "a.ts", stat: "1 ln", count: 1, detail: { lines: [{ t: "ctx", n: "1", text: "A" }], totalLines: 1 } },
    { kind: "tool", id: "h2", at: 1, tool: "read", status: "ok", target: "b.ts", stat: "1 ln", count: 1, detail: { lines: [{ t: "ctx", n: "1", text: "B" }], totalLines: 1 } },
  ]);
});

test("pairs parallel calls by id, so results returning out of order keep their own rows", () => {
  const out = entriesOf([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "toolu_a", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "toolu_b", name: "read", arguments: { path: "b.ts" } },
      ],
    },
    // omp returns whichever call finished first; FIFO by tool name would hand B's lines to A.
    { role: "toolResult", toolCallId: "toolu_b", toolName: "read", isError: false, details: { totalLines: 1, displayContent: { text: "B", lineNumbers: [1] } }, content: [] },
    { role: "toolResult", toolCallId: "toolu_a", toolName: "read", isError: false, details: { totalLines: 1, displayContent: { text: "A", lineNumbers: [1] } }, content: [] },
  ]);
  expect(out).toEqual([
    { kind: "tool", id: "h1", at: 1, tool: "read", status: "ok", target: "a.ts", stat: "1 ln", count: 1, detail: { lines: [{ t: "ctx", n: "1", text: "A" }], totalLines: 1 } },
    { kind: "tool", id: "h2", at: 1, tool: "read", status: "ok", target: "b.ts", stat: "1 ln", count: 1, detail: { lines: [{ t: "ctx", n: "1", text: "B" }], totalLines: 1 } },
  ]);
});

test("derives a pending call's target from its arguments and keeps the intent", () => {
  const out = entriesOf([
    { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "foo" }, intent: "searching" }] },
  ]);
  expect(out).toEqual([{ kind: "tool", id: "h1", at: 1, tool: "grep", status: "pending", intent: "searching", target: "/foo/" }]);
});

test("keeps an unmatched result as its own done entry", () => {
  const out = entriesOf([
    { role: "toolResult", toolName: "bash", isError: false, details: { wallTimeMs: 2 }, content: [{ type: "text", text: "orphan" }] },
  ]);
  expect(out).toEqual([
    {
      kind: "tool", id: "h1", at: 1, tool: "bash", status: "ok", stat: "2 ms", count: 2,
      detail: { lines: [{ t: "head", text: "$ " }, { t: "ctx", text: "orphan" }, { t: "head", text: "wall 2 ms" }], totalLines: 3 },
    },
  ]);
});
