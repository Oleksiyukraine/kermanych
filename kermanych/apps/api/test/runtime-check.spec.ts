import { describe, it, expect, vi } from "vitest";
import { RuntimeCheckService } from "../src/runtime/runtime-check.service";

// The preflight behind "is this backend actually usable on this machine?". It exists so the
// operator learns a backend is broken AT THE MOMENT THEY PICK IT, rather than after creating a
// chat that can never answer. It answers with the same cause codes a failed launch carries, so
// the UI reuses one set of messages for both moments.
describe("RuntimeCheckService", () => {
  it("reports ok for a claude backend whose catalog answers", async () => {
    const svc = new RuntimeCheckService();
    svc.claudeProbe = async () => [{ value: "sonnet" }] as never;

    expect(await svc.check("claude-code")).toEqual({ ok: true });
  });

  it("names a signed-out claude backend", async () => {
    const svc = new RuntimeCheckService();
    svc.claudeProbe = async () => {
      throw new Error("Claude Code process exited with code 1. stderr: Invalid API key · Please run /login");
    };

    expect(await svc.check("claude-code")).toEqual({ ok: false, code: "claude_not_authenticated" });
  });

  it("names a claude backend with no platform binary", async () => {
    const svc = new RuntimeCheckService();
    svc.claudeProbe = async () => {
      throw new Error("Claude Code native binary not found at /x/claude. Please ensure Claude Code is installed");
    };

    expect(await svc.check("claude-code")).toEqual({ ok: false, code: "claude_binary_missing" });
  });

  // An unrecognised failure still reports NOT ok — the backend demonstrably did not answer —
  // but carries no code, so the UI shows the raw reason instead of a wrong instruction.
  it("reports not-ok without a code for a failure it cannot classify", async () => {
    const svc = new RuntimeCheckService();
    svc.claudeProbe = async () => {
      throw new Error("503 upstream unavailable");
    };

    expect(await svc.check("claude-code")).toEqual({ ok: false, reason: "503 upstream unavailable" });
  });

  it("reports ok for an omp backend whose catalog answers", async () => {
    const svc = new RuntimeCheckService();
    svc.ompProbe = async () => [{ id: "gpt-5", name: "gpt-5", provider: "openai", efforts: [] }];

    expect(await svc.check("omp")).toEqual({ ok: true });
  });

  it("names a signed-out omp backend", async () => {
    const svc = new RuntimeCheckService();
    svc.ompProbe = async () => {
      throw new Error("omp child exited (code 1) before completing request: run `omp login`");
    };

    expect(await svc.check("omp")).toEqual({ ok: false, code: "omp_not_authenticated" });
  });

  // An empty catalog is a real failure mode distinct from a throw: omp answers, but lists no
  // model, which means it holds no provider credentials. A launch would then run nothing.
  it("treats an empty omp catalog as an unusable backend", async () => {
    const svc = new RuntimeCheckService();
    svc.ompProbe = async () => [];

    expect(await svc.check("omp")).toMatchObject({ ok: false });
  });

  it("does not let the probe hang forever", async () => {
    vi.useFakeTimers();
    try {
      const svc = new RuntimeCheckService();
      svc.probeTimeoutMs = 1_000;
      svc.claudeProbe = () => new Promise(() => {}); // never settles

      const pending = svc.check("claude-code");
      await vi.advanceTimersByTimeAsync(1_100);

      expect(await pending).toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
