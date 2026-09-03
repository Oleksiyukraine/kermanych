import { describe, it, expect } from "vitest";
import { toClaudeEffort, toClaudeThinking, fromClaudeEffort } from "../src/runtime/effort-map";

describe("effort mapping", () => {
  it("maps the omp ladder to claude effort (off disables, minimal->low, rest 1:1)", () => {
    expect(toClaudeEffort("off")).toBeNull();
    expect(toClaudeEffort("minimal")).toBe("low");
    expect(toClaudeEffort("low")).toBe("low");
    expect(toClaudeEffort("medium")).toBe("medium");
    expect(toClaudeEffort("high")).toBe("high");
    expect(toClaudeEffort("xhigh")).toBe("xhigh");
    expect(toClaudeEffort("max")).toBe("max");
  });
  it("disables thinking only for off", () => {
    expect(toClaudeThinking("off")).toEqual({ type: "disabled" });
    expect(toClaudeThinking("high")).toEqual({ type: "adaptive" });
  });
  it("reads claude effort back into the omp ladder (missing -> off)", () => {
    expect(fromClaudeEffort(undefined)).toBe("off");
    expect(fromClaudeEffort(null)).toBe("off");
    expect(fromClaudeEffort("medium")).toBe("medium");
    expect(fromClaudeEffort("max")).toBe("max");
  });
});
