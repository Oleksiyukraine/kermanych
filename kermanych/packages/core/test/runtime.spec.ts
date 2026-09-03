import { describe, it, expect } from "vitest";
import { AGENT_RUNTIMES, isAgentRuntime } from "../src/runtime";

describe("agent runtime kind", () => {
  it("lists exactly omp and claude-code", () => {
    expect([...AGENT_RUNTIMES]).toEqual(["omp", "claude-code"]);
  });
  it("accepts known kinds and rejects everything else", () => {
    expect(isAgentRuntime("omp")).toBe(true);
    expect(isAgentRuntime("claude-code")).toBe(true);
    expect(isAgentRuntime("gpt")).toBe(false);
    expect(isAgentRuntime(undefined)).toBe(false);
    expect(isAgentRuntime(null)).toBe(false);
    expect(isAgentRuntime(42)).toBe(false);
  });
});
