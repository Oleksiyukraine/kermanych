// apps/api/src/usage/usage.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import type { SubscriptionUsage } from "@kermanych/core";
import { mapOmpUsage } from "./omp-usage";

// The plan figures move only when an agent spends, and every reader is a sidebar chip, so a
// minute-old answer is a current answer. The TTL is what keeps a 126 MB binary from being
// spawned per client per render — and it caches FAILURES too: a machine without `omp` on
// PATH must not fork a doomed process for every poll.
const TTL_MS = 60_000;
// `omp usage` is one HTTPS round trip behind its own cache (~0.4 s cold). Ten seconds is a
// dead network, not a slow one.
const TIMEOUT_MS = 10_000;
// The payload is a few kilobytes. Anything past this is a broken omp streaming at us, and
// the truncated buffer simply fails to parse.
const MAX_BYTES = 1 << 20;

@Injectable()
export class UsageService {
  private readonly log = new Logger(UsageService.name);
  private cached: { at: number; value: SubscriptionUsage } | undefined;
  private inFlight: Promise<SubscriptionUsage> | undefined;

  // Never rejects: a missing binary, a dead network or a payload from a future omp all
  // degrade to `providers: []`, which the UI renders as no figure at all.
  subscription(): Promise<SubscriptionUsage> {
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

  private async load(): Promise<SubscriptionUsage> {
    const at = Date.now();
    const value = mapOmpUsage(await this.readOmp(), at);
    this.cached = { at, value };
    return value;
  }

  // The same `omp` the supervisor drives (rpc/rpc-session.ts) — resolved off PATH, so a
  // machine that can start an agent can also read its plan; no second knob to configure.
  private readOmp(): Promise<unknown> {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    let settled = false;
    const finish = (value: unknown, why?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (why) this.log.debug(`plan usage unavailable: ${why}`);
      resolve(value);
    };
    const child = spawn("omp", ["usage", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined, `omp usage timed out after ${TIMEOUT_MS} ms`);
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
      if (code !== 0) return finish(undefined, `omp usage exited with ${code}`);
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        finish(undefined, `unreadable omp usage payload: ${(err as Error).message}`);
      }
    });
    return promise;
  }
}
