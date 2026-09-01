// apps/api/src/models/models.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import type { ModelOption } from "@kermanych/core";
import { mapOmpModels } from "./omp-models";

// The catalog is a local sqlite-backed read of what omp itself was built with: it changes
// only when omp is updated or `omp models refresh` runs, so five minutes is still a current
// answer — and the picker is opened on every task form. Failures are cached under the same
// TTL: a machine without `omp` on PATH must not fork a doomed 126 MB process per render.
const TTL_MS = 300_000;
// No network at all here (~0.6-1.2 s cold, faster warm), so ten seconds is a wedged process,
// not a slow one — and it matches the usage reader rather than inventing a second budget.
const TIMEOUT_MS = 10_000;
// ~26 fat entries (cost table, input modalities, thinking ladder) is tens of kilobytes.
// Anything past this is a broken omp streaming at us, and the truncated buffer simply fails
// to parse.
const MAX_BYTES = 1 << 20;

@Injectable()
export class ModelsService {
  private readonly log = new Logger(ModelsService.name);
  private cached: { at: number; value: ModelOption[] } | undefined;
  private inFlight: Promise<ModelOption[]> | undefined;

  // Never rejects: a missing binary, a wedged process or a payload from a future omp all
  // degrade to `[]`. The picker then falls back to the session's stored model as its only
  // option instead of an error — the column is free-form TEXT, so a launch still works.
  list(): Promise<ModelOption[]> {
    const cached = this.cached;
    if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);
    if (this.inFlight) return this.inFlight;
    const run = this.load();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    return run;
  }

  // omp addresses a model as provider + id (`set_model`), while a session row stores the id
  // alone — often the operator alias it was launched with. An id present under two providers
  // resolves to the catalog's FIRST entry, which is omp's own precedence order (the order its
  // `--model` matcher resolves in); a caller that already knows the provider — the UI always
  // does, it got it from GET /models — never reaches this path.
  async provider(modelId: string): Promise<string | undefined> {
    return (await this.list()).find((m) => m.id === modelId)?.provider;
  }

  private async load(): Promise<ModelOption[]> {
    const at = Date.now();
    const value = mapOmpModels(await this.readOmp());
    this.cached = { at, value };
    return value;
  }

  // The same `omp` the supervisor drives (rpc/rpc-session.ts) — resolved off PATH, so the
  // models offered are exactly the ones a spawned session can run, credentials included:
  // omp lists only the providers it holds keys for.
  private readOmp(): Promise<unknown> {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    let settled = false;
    const finish = (value: unknown, why?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (why) this.log.debug(`model catalog unavailable: ${why}`);
      resolve(value);
    };
    const child = spawn("omp", ["models", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined, `omp models timed out after ${TIMEOUT_MS} ms`);
    }, TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (b: Buffer) => {
      if (size >= MAX_BYTES) return;
      size += b.length;
      chunks.push(b);
    });
    // No omp on PATH is the ordinary state of a fresh machine, not an error worth a stack.
    child.on("error", (err) => finish(undefined, err.message));
    child.on("close", (code) => {
      if (code !== 0) return finish(undefined, `omp models exited with ${code}`);
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        finish(undefined, `unreadable omp models payload: ${(err as Error).message}`);
      }
    });
    return promise;
  }
}
