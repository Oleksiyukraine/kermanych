// apps/api/src/runtime/runtime-check.service.ts
// "Is omp actually usable on this machine?"
//
// Kermanych's headless AI functions and «Керманич» sessions all run on omp. This asks omp a
// question it can only answer if it is installed AND authenticated — its model catalog, which
// lists only providers it holds credentials for, so an empty one IS a signed-out omp — and
// reports the cause in the same vocabulary a failed launch uses, so the UI has one set of
// messages for "you cannot start" and "you just stopped". The UI also polls it to keep the
// top bar's «AI login required» pill current.
//
// Deliberately NOT ModelsService.list(): that never rejects (it degrades to `[]` so a picker
// always renders), which is exactly the swallowing this check exists to undo.
import { Injectable, Logger } from "@nestjs/common";
import type { ModelOption } from "@kermanych/core";
import { mapOmpModels } from "../models/omp-models";
import { AuthFailure, authFailureCode } from "./auth-failure";

// A probe spawns a child and asks it one question. The real failures answer in milliseconds;
// this bound is for a wedged child, so the operator gets a verdict rather than a spinner.
const PROBE_TIMEOUT_MS = 10_000;

export type RuntimeCheck = { ok: true } | { ok: false; code?: string; reason?: string };

@Injectable()
export class RuntimeCheckService {
  private readonly log = new Logger(RuntimeCheckService.name);

  // A seam, so the tests never spawn a real child. It must REJECT on failure — the rejection
  // carries the cause this service classifies: an AuthFailure's code, or its message.
  ompProbe: () => Promise<ModelOption[]> = async () => mapOmpModels(await readOmpCatalog());
  probeTimeoutMs = PROBE_TIMEOUT_MS;

  async check(): Promise<RuntimeCheck> {
    try {
      const models = await this.withTimeout(this.ompProbe());
      // An empty catalog means no provider credentials at all — signed out.
      if (models.length === 0) return { ok: false, code: "omp_not_authenticated" };
      return { ok: true };
    } catch (err) {
      const reason = (err as Error).message ?? "omp did not answer";
      this.log.warn(`runtime check failed for omp: ${reason}`);
      const code = err instanceof AuthFailure ? err.code : authFailureCode(reason);
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
