import { describe, it, expect } from "vitest";
import { AGENT_RUNTIMES, isAgentRuntime, isNativeHarness, managedRuntime } from "../src/runtime";

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

describe("native harness", () => {
  it("codex is a native harness but never a managed backend", () => {
    expect(isNativeHarness("codex")).toBe(true);
    expect(isNativeHarness("claude-code")).toBe(true);
    expect(isNativeHarness("gpt")).toBe(false);
    expect(isAgentRuntime("codex")).toBe(false);
  });
  it("managedRuntime defaults to omp and refuses a native-only harness", () => {
    expect(managedRuntime(undefined)).toBe("omp");
    expect(managedRuntime("claude-code")).toBe("claude-code");
    expect(() => managedRuntime("codex")).toThrow(/native/);
  });
});
