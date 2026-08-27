// kermanych/apps/api/test/rpc-session.config.spec.ts
// A fake `omp` that reports the argv it was launched with, so the flag order is asserted
// against the real spawn path rather than a mock.
import { afterAll, beforeAll, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcSession } from "../src/rpc/rpc-session";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-rpc-config-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function argvEchoOmp(out: string): string {
  const p = join(dir, "echo-argv.mjs");
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");\n` +
      `setInterval(()=>{},1000);\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

test("configPath becomes --config right after --cwd", async () => {
  const out = join(dir, "argv.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out), configPath: "/tmp/p1.config.yml" });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--config", "/tmp/p1.config.yml",
  ]);
});

test("no configPath means no --config", async () => {
  const out = join(dir, "argv2.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out) });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--mode", "rpc", "--cwd", dir]);
});
