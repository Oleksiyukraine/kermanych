// apps/api/test/runtime-resolve.spec.ts
import { describe, it, expect } from "vitest";
import { resolveRuntime } from "../src/runtime/resolve-runtime";

describe("resolveRuntime", () => {
  it("env override wins over cached preference", () => {
    expect(resolveRuntime("claude-code", "omp")).toBe("claude-code");
    expect(resolveRuntime("omp", "claude-code")).toBe("omp");
  });

  it("cached preference is used when env is absent", () => {
    expect(resolveRuntime(undefined, "claude-code")).toBe("claude-code");
    expect(resolveRuntime(undefined, "omp")).toBe("omp");
  });

  it("defaults to omp when both env and cached are absent", () => {
    expect(resolveRuntime(undefined, undefined)).toBe("omp");
  });

  it("ignores invalid env value and falls back to cached or omp", () => {
    expect(resolveRuntime("invalid-runtime", "claude-code")).toBe("claude-code");
    expect(resolveRuntime("invalid-runtime", undefined)).toBe("omp");
    expect(resolveRuntime("", "claude-code")).toBe("claude-code");
    expect(resolveRuntime("", undefined)).toBe("omp");
  });
});
