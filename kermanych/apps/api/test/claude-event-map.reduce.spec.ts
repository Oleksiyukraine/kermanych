import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { initClaudeMapState, mapSdkMessage } from "../src/runtime/claude-event-map";
import { reduceRpcEvents } from "../src/supervisor/transcript-reducer";
import type { RpcEvent } from "@kermanych/core";

// Regression guard for findings 1 and 2: the map must emit `text_delta` deltas (so the
// reducer accumulates assistant text) and an assistant-role message_end (so the reducer
// records a turn with summed usage). Feeding the map through the reducer is the path that
// would have caught both bugs — a map-only test never touches the reducer's contract.
describe("claude event map -> transcript reducer", () => {
  it("accumulates streamed text and records a turn with summed usage", () => {
    const script: SDKMessage[] = [
      { type: "system", subtype: "init" } as unknown as SDKMessage,
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } } } as unknown as SDKMessage,
      { type: "result", subtype: "success", duration_ms: 1200, modelUsage: {
        "claude-opus-4-8": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, costUSD: 0.5 },
      } } as unknown as SDKMessage,
    ];

    const st = initClaudeMapState();
    const events: RpcEvent[] = script.flatMap((m) => mapSdkMessage(m, st));

    let n = 0;
    const { entries } = reduceRpcEvents(events, { now: () => ++n });

    const text = entries.find((e) => e.kind === "assistant_text");
    expect(text).toBeDefined();
    expect(text && "text" in text ? text.text : undefined).toBe("hello");

    const turn = entries.find((e) => e.kind === "turn");
    expect(turn).toBeDefined();
    expect(turn && "usage" in turn ? turn.usage : undefined).toEqual({
      input: 10, output: 20, cacheRead: 3, cacheWrite: 1, cost: 0.5,
    });
  });
});
