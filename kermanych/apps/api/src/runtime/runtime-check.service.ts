// apps/api/src/runtime/runtime-check.service.ts
// "Is this agent backend actually usable on this machine?"
//
// The operator picks a backend in onboarding or profile settings, and until now nothing
// verified the choice. A machine whose claude is signed out (or whose platform binary never
// installed) accepted the preference happily and then produced sessions that could not answer.
// This asks the backend a question it can only answer if it is installed AND authenticated —
// its model catalog — and reports the cause in the same vocabulary a failed launch uses, so the
// UI has one set of messages for "you cannot start" and "you just stopped".
//
// Deliberately NOT ModelsService.list(): that never rejects (it degrades to `[]` so a picker
// always renders), which is exactly the swallowing this check exists to undo.
import { Injectable, Logger } from "@nestjs/common";
import type { AgentRuntimeKind, ModelOption } from "@kermanych/core";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeRuntime } from "./claude-code-runtime";
import { mapOmpModels } from "../models/omp-models";
import { authFailureCode } from "./auth-failure";

// A probe spawns a child and asks it one question. The real failures answer in milliseconds;
// this bound is for a wedged child, so the operator gets a verdict rather than a spinner.
const PROBE_TIMEOUT_MS = 10_000;

export type RuntimeCheck = { ok: true } | { ok: false; code?: string; reason?: string };

@Injectable()
export class RuntimeCheckService {
  private readonly log = new Logger(RuntimeCheckService.name);

  // Seams, so the tests never spawn a real child. Each must REJECT on failure — the rejection
  // carries the cause this service classifies.
  claudeProbe: () => Promise<ModelInfo[]> = () => ClaudeCodeRuntime.supportedModels();
  ompProbe: () => Promise<ModelOption[]> = async () => mapOmpModels(await readOmpCatalog());
  probeTimeoutMs = PROBE_TIMEOUT_MS;

  async check(runtime: AgentRuntimeKind): Promise<RuntimeCheck> {
    try {
      // Only the COUNT matters here — the two backends' catalogs have different shapes and this
      // check never reads a field of either, so they are normalised at the seam.
      const probe: Promise<readonly unknown[]> =
        runtime === "claude-code" ? this.claudeProbe() : this.ompProbe();
      const models = await this.withTimeout(probe);
      // An answer listing nothing is its own failure: the backend runs but holds no provider
      // credentials, so a session launched on it would have no model to run.
      if (models.length === 0) return { ok: false, reason: `${runtime} listed no models` };
      return { ok: true };
    } catch (err) {
      const reason = (err as Error).message ?? `${runtime} did not answer`;
      this.log.warn(`runtime check failed for ${runtime}: ${reason}`);
      const code = authFailureCode(reason);
      // A classified cause travels as a code the UI localizes; anything else keeps its raw
      // prose, because a wrong instruction is worse than an unfamiliar sentence.
      return code ? { ok: false, code } : { ok: false, reason };
    }
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`backend did not answer within ${this.probeTimeoutMs}ms`)),
        this.probeTimeoutMs,
      );
    });
    return Promise.race([work, bound]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }
}

// `omp models --json`, but REJECTING on failure rather than degrading — the mirror image of
// ModelsService.readOmp(), which must never reject because a picker depends on it.
async function readOmpCatalog(): Promise<unknown> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("omp", ["models", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString("utf8"); });
    child.on("error", (e: Error) => reject(new Error(`spawn omp ${(e as { code?: string }).code ?? e.message}`)));
    child.on("exit", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch { reject(new Error("omp models returned unparseable JSON")); }
        return;
      }
      reject(new Error(`omp child exited (code ${code}) before completing request: ${err.trim()}`));
    });
  });
}
