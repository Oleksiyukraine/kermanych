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

test("maps user text, tool calls, and tool results", () => {
  const out = messagesToTranscript([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "Read", arguments: { path: "a.ts" } }] },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "ok" }] },
  ]);
  expect(out).toEqual([
    { kind: "user_text", text: "hi", images: undefined },
    { kind: "tool_call", tool: "Read", summary: "a.ts" },
    { kind: "tool_result", tool: "Read", ok: true, summary: "ok" },
  ]);
});
