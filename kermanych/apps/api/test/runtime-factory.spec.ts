import { describe, it, expect } from "vitest";
import { createRuntime, type AgentRuntime } from "../src/runtime/agent-runtime";

const REQUIRED_METHODS: (keyof AgentRuntime)[] = [
  "start", "isAlive", "prompt", "followUp", "steer", "answerUi",
  "getState", "switchSession", "setModel", "setThinkingLevel",
  "getAllMessages", "stop", "onEvent", "onExit",
];

describe("createRuntime", () => {
  it("returns an omp runtime exposing the full AgentRuntime surface", () => {
    const rt = createRuntime("omp", { cwd: "/tmp/x" });
    for (const m of REQUIRED_METHODS) {
      expect(typeof (rt as unknown as Record<string, unknown>)[m]).toBe("function");
    }
    expect(rt.isAlive()).toBe(false); // not started
  });

  it("throws a clear error for claude-code until its adapter lands", () => {
    expect(() => createRuntime("claude-code", { cwd: "/tmp/x" })).toThrow(/claude-code runtime not wired/i);
  });
});
