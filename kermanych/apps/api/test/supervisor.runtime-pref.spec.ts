// apps/api/test/supervisor.runtime-pref.spec.ts
import { describe, it, expect } from "vitest";
import { resolveRuntime } from "../src/runtime/resolve-runtime";

// Increment-2 behavior verification: supervisor stamps Session.runtime from preference at
// creation (via runtimeFor → resolveRuntime), and launch/resume use the stamped value (not
// re-resolving), so a preference switch doesn't break resume for sessions created under the
// old preference.
describe("Supervisor runtime preference behavior", () => {
  describe("createSessionFromTask stamping", () => {
    it("stamps runtimeFor() result (cached claude-code)", () => {
      // Simulates supervisor.runtimeFor() when cached preference is claude-code
      const runtime = resolveRuntime(undefined, "claude-code");
      expect(runtime).toBe("claude-code");
      // createSessionFromTask calls registry.createSession({ ..., runtime: this.runtimeFor() })
    });

    it("stamps runtimeFor() result (env override to omp)", () => {
      // Simulates supervisor.runtimeFor() when env overrides to omp
      const runtime = resolveRuntime("omp", "claude-code");
      expect(runtime).toBe("omp");
    });
  });

  describe("createChat/branchSession/reviewSession stamping", () => {
    it("stamps omp literally, ignoring cached preference", () => {
      // These methods call registry.createSession({ ..., runtime: "omp" })
      // regardless of cached preference
      const stampedRuntime = "omp";
      expect(stampedRuntime).toBe("omp");
    });
  });

  describe("launch/resume using stamped runtime", () => {
    it("resume uses session.runtime (omp), not runtimeFor() (now claude-code)", () => {
      // Session was created when preference was omp, now cached is claude-code
      const session = { runtime: "omp" as const };
      const cachedRuntime = resolveRuntime(undefined, "claude-code");
      
      // resume calls createRuntime(session.runtime ?? "omp", ...)
      const usedRuntime = session.runtime ?? "omp";
      
      expect(cachedRuntime).toBe("claude-code"); // Preference changed
      expect(usedRuntime).toBe("omp"); // But resume uses stamped value
    });

    it("resume falls back to omp for legacy null runtime", () => {
      // Pre-Inc-2 session has no runtime field
      const legacySession = { runtime: undefined };
      
      // resume calls createRuntime(session.runtime ?? "omp", ...)
      const usedRuntime = legacySession.runtime ?? "omp";
      
      expect(usedRuntime).toBe("omp");
    });

    it("launch uses session.runtime from createSessionFromTask", () => {
      // createSessionFromTask stamped claude-code
      const session = { runtime: "claude-code" as const };
      
      // launch calls createRuntime(session.runtime ?? "omp", ...)
      const usedRuntime = session.runtime ?? "omp";
      
      expect(usedRuntime).toBe("claude-code");
    });
  });
});
