// apps/api/test/rpc-session.spec.ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcSession } from "../src/rpc/rpc-session";

// A fake `omp --mode rpc` is a small node script pointed at via `ompPath`; it ignores
// the injected CLI flags and drives the exact lifecycle edge under test.
let dir: string;
function fakeOmp(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-rpc-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("onExit surfaces the exit code and stderr tail when the child dies after ready", async () => {
  const omp = fakeOmp(
    "ready-crash.mjs",
    `process.stderr.write("boom: simulated omp crash\\n");` +
      `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");` +
      `setTimeout(()=>process.exit(1),150);`,
  );
  const rpc = new RpcSession({ cwd: dir, ompPath: omp });
  const exited = new Promise<{ code: number | null; reason: string }>((res) => {
    rpc.onExit((code, reason) => res({ code, reason }));
  });
  await rpc.start(); // resolves on the `ready` frame, before the scheduled crash
  const { code, reason } = await exited;
  expect(code).toBe(1);
  expect(reason).toContain("code 1");
  expect(reason).toContain("boom: simulated omp crash");
});

test("start() rejects with the exit reason when the child exits before ready", async () => {
  const omp = fakeOmp("early-exit.mjs", `process.stderr.write("startup failure\\n");setTimeout(()=>process.exit(2),40);`);
  const rpc = new RpcSession({ cwd: dir, ompPath: omp });
  rpc.onExit(() => {});
  await expect(rpc.start()).rejects.toThrow(/startup failure|code 2/);
});
