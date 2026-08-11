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
    { kind: "assistant_thinking", text: "weigh options" },
    { kind: "assistant_text", text: "Here is the answer." },
  ]);
});

test("skips empty/whitespace reasoning parts", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "thinking", thinking: "  " }, { type: "text", text: "x" }] },
  ]);
  expect(out).toEqual([{ kind: "assistant_text", text: "x" }]);
});

test("collapses a tool call and its result into one tool entry", () => {
  const out = messagesToTranscript([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "Read", arguments: { path: "a.ts" } }] },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "ok" }] },
  ]);
  expect(out).toEqual([
    { kind: "user_text", text: "hi", images: undefined },
    { kind: "tool", id: "h1", tool: "Read", status: "ok", summary: "a.ts\nok" },
  ]);
});

test("marks failed results as error", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "Bash", arguments: { command: "false" } }] },
    { role: "toolResult", toolName: "Bash", isError: true, content: [{ type: "text", text: "exit 1" }] },
  ]);
  expect(out).toEqual([{ kind: "tool", id: "h1", tool: "Bash", status: "error", summary: "false\nexit 1" }]);
});

test("pairs parallel same-name calls FIFO", () => {
  const out = messagesToTranscript([
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "Read", arguments: { path: "a.ts" } },
        { type: "toolCall", name: "Read", arguments: { path: "b.ts" } },
      ],
    },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "A" }] },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "B" }] },
  ]);
  expect(out).toEqual([
    { kind: "tool", id: "h1", tool: "Read", status: "ok", summary: "a.ts\nA" },
    { kind: "tool", id: "h2", tool: "Read", status: "ok", summary: "b.ts\nB" },
  ]);
});

test("falls back through pattern/query/intent for the call summary", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "foo" }, intent: "searching" }] },
  ]);
  expect(out).toEqual([{ kind: "tool", id: "h1", tool: "grep", status: "pending", summary: "foo" }]);
});

test("keeps an unmatched result as its own done entry", () => {
  const out = messagesToTranscript([
    { role: "toolResult", toolName: "Bash", isError: false, content: [{ type: "text", text: "orphan" }] },
  ]);
  expect(out).toEqual([{ kind: "tool", id: "h1", tool: "Bash", status: "ok", summary: "orphan" }]);
});
