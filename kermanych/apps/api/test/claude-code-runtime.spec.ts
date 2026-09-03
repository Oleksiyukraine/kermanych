import { describe, it, expect, vi } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code-runtime";
import type { RpcEvent } from "@kermanych/core";

// A fake Query: yields a scripted script, records interrupt(), and exposes the input iterable
// the runtime pushed into (so we can assert prompt/follow-up were enqueued).
function fakeQuery(script: SDKMessage[]) {
  const calls = { interrupts: 0, sent: [] as SDKUserMessage[], model: undefined as string | undefined };
  const queryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: unknown }) => {
    (async () => { for await (const m of params.prompt) calls.sent.push(m); })();
    const gen = (async function* () { for (const m of script) yield m; })() as AsyncGenerator<SDKMessage, void> & Record<string, unknown>;
    gen.interrupt = async () => { calls.interrupts++; return undefined; };
    gen.setModel = async (model?: string) => { calls.model = model; };
    gen.setPermissionMode = async () => {};
    gen.supportedModels = async () => [];
    gen.getContextUsage = async () => ({ percent: 42 });
    gen.initializationResult = async () => ({ session_id: "sess-1", model: "claude-opus-4-8" });
    return gen;
  };
  return { queryFn, calls };
}

describe("ClaudeCodeRuntime", () => {
  it("emits ready on init and forwards mapped events, then agent_end", async () => {
    const script: SDKMessage[] = [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-8" } as unknown as SDKMessage,
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } } as unknown as SDKMessage,
      { type: "result", subtype: "success", duration_ms: 5, modelUsage: {} } as unknown as SDKMessage,
    ];
    const { queryFn } = fakeQuery(script);
    const rt = new ClaudeCodeRuntime({ cwd: "/tmp/x" }, queryFn as never);
    const events: RpcEvent[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.start();
    rt.prompt("do it");
    await vi.waitFor(() => expect(events.some((e) => e.type === "agent_end")).toBe(true));
    expect(events[0]).toEqual({ type: "ready", protocolVersion: 2 });
    expect(events).toContainEqual({ type: "message_update", assistantMessageEvent: { type: "text", delta: "hi" } });
  });

  it("steer interrupts then enqueues", async () => {
    const { queryFn, calls } = fakeQuery([{ type: "system", subtype: "init" } as unknown as SDKMessage]);
    const rt = new ClaudeCodeRuntime({ cwd: "/tmp/x" }, queryFn as never);
    rt.onEvent(() => {});
    await rt.start();
    rt.steer("stop, do this instead");
    await vi.waitFor(() => expect(calls.interrupts).toBe(1));
    await vi.waitFor(() => expect(calls.sent.some((m) => JSON.stringify(m).includes("stop, do this instead"))).toBe(true));
  });

  it("stop() closes the input queue cleanly: no spurious value, no warn, clean exit", async () => {
    // A parked fake: yields init, then blocks reading the prompt stream between turns.
    // This is the state stop() hits when the SDK consumer is idle between user turns.
    const received: SDKUserMessage[] = [];
    const queryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: unknown }) => {
      const gen = (async function* () {
        yield { type: "system", subtype: "init" } as unknown as SDKMessage;
        for await (const m of params.prompt) received.push(m);
      })() as AsyncGenerator<SDKMessage, void> & Record<string, unknown>;
      gen.interrupt = async () => undefined;
      return gen;
    };
    const rt = new ClaudeCodeRuntime({ cwd: "/tmp/x" }, queryFn as never);
    const events: RpcEvent[] = [];
    const exits: { code: number | null; reason: string }[] = [];
    rt.onEvent((e) => events.push(e));
    rt.onExit((code, reason) => exits.push({ code, reason }));
    await rt.start();
    await rt.stop();
    await vi.waitFor(() => expect(exits.length).toBe(1));
    expect(exits[0].code).toBe(0); // clean exit, not the error (null) path
    expect(received).toEqual([]); // close() must NOT push a bogus undefined into the prompt stream
    expect(events.some((e) => e.type === "notice" && e.level === "warn")).toBe(false);
  });
});
