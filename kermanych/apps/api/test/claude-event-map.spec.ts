import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { initClaudeMapState, mapSdkMessage } from "../src/runtime/claude-event-map";
import type { RpcEvent } from "@kermanych/core";

function run(msgs: SDKMessage[]): RpcEvent[] {
  const st = initClaudeMapState();
  return msgs.flatMap((m) => mapSdkMessage(m, st));
}
const textDelta = (t: string): SDKMessage =>
  ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } } as unknown as SDKMessage);

describe("claude event map", () => {
  it("turns system/init into a ready frame", () => {
    expect(run([{ type: "system", subtype: "init" } as unknown as SDKMessage]))
      .toEqual([{ type: "ready", protocolVersion: 2 }]);
  });

  it("streams text deltas as message_update after a message_start", () => {
    const out = run([textDelta("Hel"), textDelta("lo")]);
    expect(out[0]).toEqual({ type: "message_start" });
    expect(out.slice(1)).toEqual([
      { type: "message_update", assistantMessageEvent: { type: "text", delta: "Hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text", delta: "lo" } },
    ]);
  });

  it("pairs a tool_use with its tool_result by id", () => {
    const assistant = { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "tu_1", name: "read", input: { path: "a.ts" } },
    ] } } as unknown as SDKMessage;
    const user = { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false },
    ] } } as unknown as SDKMessage;
    const out = run([assistant, user]);
    expect(out).toContainEqual({ type: "tool_execution_start", toolName: "read", toolCallId: "tu_1", args: { path: "a.ts" } });
    expect(out).toContainEqual({ type: "tool_execution_end", toolName: "read", toolCallId: "tu_1", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
  });

  it("closes a turn on result with usage then agent_end", () => {
    const result = { type: "result", subtype: "success", duration_ms: 1200, modelUsage: {
      "claude-opus-4-8": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, costUSD: 0.5 },
    } } as unknown as SDKMessage;
    const out = run([result]);
    expect(out[0]).toEqual({ type: "message_end", message: {
      model: "claude-opus-4-8", duration: 1200,
      usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 1, cost: { total: 0.5 } },
    } });
    expect(out[1]).toEqual({ type: "agent_end", isTerminal: true });
  });
});
