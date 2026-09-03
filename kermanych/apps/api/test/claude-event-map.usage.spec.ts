import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { initClaudeMapState, mapSdkMessage } from "../src/runtime/claude-event-map";
import {
  agentById,
  ASSIGNED_BLOCK_HEADER,
  assignedBlock,
  renderInstruction,
  type RpcEvent,
} from "@kermanych/core";

// A single query() lifetime, driven the way the runtime drives it.
function run(msgs: SDKMessage[]): RpcEvent[] {
  const st = initClaudeMapState();
  return msgs.flatMap((m) => mapSdkMessage(m, st));
}

// The one frame that carries accounting to the UI.
function usageOf(out: RpcEvent[]): unknown {
  const end = out.find((e) => e.type === "message_end") as
    | { type: "message_end"; message: { usage?: unknown } }
    | undefined;
  return end?.message.usage;
}

const result = (extra: Record<string, unknown>): SDKMessage =>
  ({ type: "result", subtype: "success", ...extra } as unknown as SDKMessage);

describe("claude per-session usage accounting", () => {
  it("maps a single model's per-model usage onto the Usage shape", () => {
    const out = run([
      result({
        model: "claude-opus-4-8",
        duration_ms: 900,
        modelUsage: {
          "claude-opus-4-8": {
            inputTokens: 12,
            outputTokens: 34,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 2,
            costUSD: 0.25,
          },
        },
      }),
    ]);
    expect(usageOf(out)).toEqual({
      input: 12,
      output: 34,
      cacheRead: 5,
      cacheWrite: 2,
      cost: { total: 0.25 },
    });
  });

  it("sums every model in modelUsage into one accounting shape", () => {
    const out = run([
      result({
        modelUsage: {
          "claude-opus-4-8": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 1,
            costUSD: 0.5,
          },
          "claude-haiku-4": {
            inputTokens: 4,
            outputTokens: 6,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 7,
            costUSD: 0.05,
          },
        },
      }),
    ]);
    expect(usageOf(out)).toEqual({
      input: 14,
      output: 26,
      cacheRead: 5,
      cacheWrite: 8,
      // The cost total is the running spend the SDK reports per model (costUSD ==
      // total_cost_usd's per-model breakdown), summed here into a single figure.
      cost: { total: 0.55 },
    });
  });

  it("defaults every missing per-model field to zero rather than NaN/undefined", () => {
    const out = run([
      result({
        modelUsage: {
          "claude-opus-4-8": { inputTokens: 7 }, // output/cache/cost all absent
        },
      }),
    ]);
    expect(usageOf(out)).toEqual({
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    });
  });

  it("emits a zeroed Usage when a result carries no modelUsage at all", () => {
    const out = run([result({ duration_ms: 5 })]);
    expect(usageOf(out)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    });
  });
});

describe("assigned skills reach a claude launch through the opening prompt", () => {
  // Backend-neutral: the supervisor builds every launch prompt as
  // `renderInstruction(agent, vars) + assignedBlockFor(...)` (supervisor.service.ts), so the
  // claude adapter receives its skills inline in that prompt with no runtime-specific path.
  // This is a focused unit test of that assembly, not a full supervisor launch.
  const defs = [
    { name: "kermanych-session", description: "d", body: "How isolation works." },
    { name: "kermanych-pull-request", description: "d", body: "How to open a PR." },
  ];

  it("appends the assigned-skills block, header and bodies, to the instruction", () => {
    const prompt =
      renderInstruction(agentById("promote")!, { branch: "feature/x" }) + assignedBlock(defs);
    expect(prompt).toContain(ASSIGNED_BLOCK_HEADER);
    expect(prompt).toContain("### kermanych-session\nHow isolation works.");
    expect(prompt).toContain("### kermanych-pull-request\nHow to open a PR.");
    // The block trails the instruction rather than replacing it.
    expect(prompt.indexOf(ASSIGNED_BLOCK_HEADER)).toBeGreaterThan(
      prompt.indexOf("feature/x"),
    );
  });

  it("adds nothing when a role has no assigned skills", () => {
    const prompt = renderInstruction(agentById("promote")!, { branch: "feature/x" }) + assignedBlock([]);
    expect(prompt).not.toContain(ASSIGNED_BLOCK_HEADER);
  });
});
