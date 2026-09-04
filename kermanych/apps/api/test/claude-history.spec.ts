import { describe, it, expect } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeHistoryToOmp } from "../src/runtime/claude-history";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";
import type { OmpMessage } from "../src/supervisor/messages-to-transcript";

// A minimal claude session transcript: a user prompt; an assistant turn with a thinking
// block, a text block and two tool_use blocks; then a following user turn carrying the two
// matching tool_result blocks — one success, one is_error.
function sm(type: SessionMessage["type"], message: unknown, i: number): SessionMessage {
  return { type, message, uuid: `u${i}`, session_id: "sess-1", parent_tool_use_id: null, parent_agent_id: null };
}

const script: SessionMessage[] = [
  sm("user", { role: "user", content: [{ type: "text", text: "grep for hi" }] }, 1),
  sm("system", { role: "system", content: "boundary" }, 2), // must be skipped
  sm(
    "assistant",
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me search", signature: "sig" },
        { type: "text", text: "Searching now." },
        { type: "tool_use", id: "call-a", name: "grep", input: { pattern: "hi" } },
        { type: "tool_use", id: "call-b", name: "read", input: { path: "a.ts" } },
      ],
      usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
    },
    3,
  ),
  sm(
    "user",
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-a", content: [{ type: "text", text: "1 match" }], is_error: false },
        { type: "tool_result", tool_use_id: "call-b", content: "boom", is_error: true },
      ],
    },
    4,
  ),
];

describe("claudeHistoryToOmp", () => {
  it("maps user/assistant/tool_result blocks onto the omp seam and skips system", () => {
    const out = claudeHistoryToOmp(script);

    // system dropped; user → assistant → two toolResult messages.
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);

    const user = out[0] as OmpMessage;
    expect(user.content).toEqual([{ type: "text", text: "grep for hi" }]);

    const asst = out[1] as OmpMessage;
    expect(asst.content).toEqual([
      { type: "thinking", thinking: "let me search" },
      { type: "text", text: "Searching now." },
      { type: "toolCall", id: "call-a", name: "grep", arguments: { pattern: "hi" } },
      { type: "toolCall", id: "call-b", name: "read", arguments: { path: "a.ts" } },
    ]);
    expect(asst.usage).toEqual({ input: 12, output: 34, cacheRead: 5, cacheWrite: 7 });

    const okResult = out[2] as OmpMessage;
    expect(okResult).toMatchObject({ role: "toolResult", toolCallId: "call-a", toolName: "grep", isError: false });
    expect(okResult.content).toEqual([{ type: "text", text: "1 match" }]);

    const errResult = out[3] as OmpMessage;
    expect(errResult).toMatchObject({ role: "toolResult", toolCallId: "call-b", toolName: "read", isError: true });
    expect(errResult.content).toEqual([{ type: "text", text: "boom" }]);
  });

  it("round-trips through messagesToTranscript: entries non-empty, tool call paired with its result", () => {
    const { entries } = messagesToTranscript(claudeHistoryToOmp(script));
    expect(entries.length).toBeGreaterThan(0);

    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("user_text");
    expect(kinds).toContain("assistant_thinking");
    expect(kinds).toContain("assistant_text");

    // Two tool rows, both completed (paired to their results), one failed.
    const tools = entries.filter((e) => e.kind === "tool") as Array<{ tool: string; status: string }>;
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.status !== "pending")).toBe(true);
    expect(tools.some((t) => t.tool === "grep" && t.status === "ok")).toBe(true);
    expect(tools.some((t) => t.tool === "read" && t.status === "error")).toBe(true);
  });
});
