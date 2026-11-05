import { describe, it, expect, vi } from "vitest";
import { RuntimeCheckService } from "../src/runtime/runtime-check.service";

// The preflight behind "is omp actually usable on this machine?". It exists so the operator
// learns omp is broken up front, rather than after creating a chat that can never answer. It answers with the same cause codes a failed launch carries, so
// the UI reuses one set of messages for both moments.
describe("RuntimeCheckService", () => {
  // An unrecognised failure still reports NOT ok — the backend demonstrably did not answer —
  // but carries no code, so the UI shows the raw reason instead of a wrong instruction.
  it("reports not-ok without a code for a failure it cannot classify", async () => {
    const svc = new RuntimeCheckService();
    svc.ompProbe = async () => {
      throw new Error("503 upstream unavailable");
    };

    expect(await svc.check()).toEqual({ ok: false, reason: "503 upstream unavailable" });
  });

  it("reports ok for an omp whose catalog answers", async () => {
    const svc = new RuntimeCheckService();
    svc.ompProbe = async () => [{ id: "gpt-5", name: "gpt-5", provider: "openai", efforts: [] }];

    expect(await svc.check()).toEqual({ ok: true });
  });

  it("names a signed-out omp", async () => {
    const svc = new RuntimeCheckService();
    svc.ompProbe = async () => {
      throw new Error("omp child exited (code 1) before completing request: run `omp login`");
    };

    expect(await svc.check()).toEqual({ ok: false, code: "omp_not_authenticated" });
  });

  // An empty catalog is a real failure mode distinct from a throw: omp answers, but lists no
  // model, which means it holds no provider credentials — a signed-out omp.
  it("treats an empty omp catalog as a signed-out omp", async () => {
    const svc = new RuntimeCheckService();
    svc.ompProbe = async () => [];

    expect(await svc.check()).toEqual({ ok: false, code: "omp_not_authenticated" });
  });

  it("does not let the probe hang forever", async () => {
    vi.useFakeTimers();
    try {
      const svc = new RuntimeCheckService();
      svc.probeTimeoutMs = 1_000;
      svc.ompProbe = () => new Promise(() => {}); // never settles

      const pending = svc.check();
      await vi.advanceTimersByTimeAsync(1_100);

      expect(await pending).toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
