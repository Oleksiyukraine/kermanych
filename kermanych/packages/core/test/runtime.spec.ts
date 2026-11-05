import { describe, it, expect } from "vitest";
import { isAgentProvider, isNativeHarness, providerHarness } from "../src/runtime";

describe("native harness", () => {
  it("accepts the three harnesses and rejects everything else", () => {
    expect(isNativeHarness("omp")).toBe(true);
    expect(isNativeHarness("claude-code")).toBe(true);
    expect(isNativeHarness("codex")).toBe(true);
    expect(isNativeHarness("gpt")).toBe(false);
    expect(isNativeHarness(undefined)).toBe(false);
  });
});

describe("agent provider", () => {
  it("accepts the three providers and rejects everything else", () => {
    expect(isAgentProvider("omp")).toBe(true);
    expect(isAgentProvider("claude-code")).toBe(true);
    expect(isAgentProvider("codex")).toBe(true);
    expect(isAgentProvider("claude")).toBe(false);
    expect(isAgentProvider(null)).toBe(false);
    expect(isAgentProvider(42)).toBe(false);
  });
  // omp is «Керманич», never native omp; an unset provider launches «Керманич» as well.
  it("maps a provider to its default native harness", () => {
    expect(providerHarness("omp")).toBeUndefined();
    expect(providerHarness("claude-code")).toBe("claude-code");
    expect(providerHarness("codex")).toBe("codex");
    expect(providerHarness(null)).toBeUndefined();
    expect(providerHarness(undefined)).toBeUndefined();
  });
});
