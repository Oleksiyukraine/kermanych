import { expect, test } from "vitest";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";

test("maps assistant reasoning before text, preserving in-message order", () => {
  const out = messagesToTranscript([
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
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "thinking", thinking: "  " }, { type: "text", text: "x" }] },
  ]);
  expect(out).toEqual([{ kind: "assistant_text", id: "h1", at: 1, text: "x" }]);
});

test("prefers the message timestamp over the ordering counter", () => {
  const out = messagesToTranscript([{ role: "user", timestamp: 1_700_000_000_000, content: [{ type: "text", text: "hi" }] }]);
  expect(out).toEqual([{ kind: "user_text", id: "h1", at: 1_700_000_000_000, text: "hi" }]);
});

test("collapses a tool call and its result into one entry with target, stat and detail", () => {
  const out = messagesToTranscript([
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

test("marks failed results as error and keeps the call-time target", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "false" } }] },
    { role: "toolResult", toolName: "bash", isError: true, details: { wallTimeMs: 4, exitCode: 1 }, content: [{ type: "text", text: "" }] },
  ]);
  expect(out).toEqual([
    {
      kind: "tool", id: "h1", at: 1, tool: "bash", status: "error", target: "false", stat: "exit 1 · 4 ms", count: 4,
      // The result frame carries no args, so the command survives in `target`, not in the detail head.
      detail: { lines: [{ t: "head", text: "$ " }, { t: "head", text: "wall 4 ms · exit 1" }], totalLines: 2 },
    },
  ]);
});

test("pairs parallel same-name calls FIFO", () => {
  const out = messagesToTranscript([
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

test("derives a pending call's target from its arguments and keeps the intent", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "foo" }, intent: "searching" }] },
  ]);
  expect(out).toEqual([{ kind: "tool", id: "h1", at: 1, tool: "grep", status: "pending", intent: "searching", target: "/foo/" }]);
});

test("keeps an unmatched result as its own done entry", () => {
  const out = messagesToTranscript([
    { role: "toolResult", toolName: "bash", isError: false, details: { wallTimeMs: 2 }, content: [{ type: "text", text: "orphan" }] },
  ]);
  expect(out).toEqual([
    {
      kind: "tool", id: "h1", at: 1, tool: "bash", status: "ok", stat: "2 ms", count: 2,
      detail: { lines: [{ t: "head", text: "$ " }, { t: "ctx", text: "orphan" }, { t: "head", text: "wall 2 ms" }], totalLines: 3 },
    },
  ]);
});
