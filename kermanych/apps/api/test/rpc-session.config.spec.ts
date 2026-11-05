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
      `if (process.env.KMQ_PROBE) writeFileSync(${JSON.stringify(out)} + ".env", process.env.KMQ_PROBE);\n` +
      `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");\n` +
      `setInterval(()=>{},1000);\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

// The other flags are carried on purpose: with only --mode/--cwd present the expected argv
// would be identical wherever the --config push sits, so the position would not be pinned at
// all. --model and --tools straddle it, so moving the push changes the array.
test("configPaths become --config right after --cwd", async () => {
  const out = join(dir, "argv.json");
  const rpc = new RpcSession({
    cwd: dir, ompPath: argvEchoOmp(out), configPaths: ["/tmp/p1.config.yml"], model: "m", tools: ["read"],
  });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--config", "/tmp/p1.config.yml", "--model", "m", "--tools", "read",
  ]);
});

test("no configPaths means no --config", async () => {
  const out = join(dir, "argv2.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out), model: "m", tools: ["read"] });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  // The remaining flags close up: nothing is left behind where --config would have been.
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--model", "m", "--tools", "read",
  ]);
});

// Both launch-time paths at once, with --model and --tools straddling them: the trigger
// package's `-e` sits immediately after --config, so a reordering of either push changes
// this array. Nothing else may appear — the skill library and the triggers between them add
// exactly two flags to a launch.
test("configPaths and extensionPath become --config then -e, ahead of every other flag", async () => {
  const out = join(dir, "argv3.json");
  const rpc = new RpcSession({
    cwd: dir, ompPath: argvEchoOmp(out), configPaths: ["/tmp/p1.config.yml"],
    extensionPath: "/tmp/triggers/s1", model: "m", tools: ["read", "grep"],
  });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--config", "/tmp/p1.config.yml", "-e", "/tmp/triggers/s1",
    "--model", "m", "--tools", "read,grep",
  ]);
});

test("no extensionPath means no -e", async () => {
  const out = join(dir, "argv4.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out), configPaths: ["/tmp/p1.config.yml"] });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--config", "/tmp/p1.config.yml",
  ]);
});

// The skill library and the machine resource limits are two overlays; omp takes the flag
// repeated and the later file wins, so their order is part of the contract.
test("several configPaths repeat --config in order", async () => {
  const out = join(dir, "argv5.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out), configPaths: ["/tmp/p1.config.yml", "/tmp/resources.yml"] });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--config", "/tmp/p1.config.yml", "--config", "/tmp/resources.yml",
  ]);
});

test("env reaches the child and onSpawn gets its pid before ready", async () => {
  const out = join(dir, "argv6.json");
  const pids: number[] = [];
  const rpc = new RpcSession({ cwd: dir, ompPath: argvEchoOmp(out), env: { KMQ_PROBE: "limited" }, onSpawn: (pid) => pids.push(pid) });
  rpc.onExit(() => {});
  const starting = rpc.start();
  // Synchronous with the spawn: the renice must land before the child starts its own children.
  expect(pids).toHaveLength(1);
  await starting;
  await rpc.stop();
  expect(pids[0]).toBeGreaterThan(0);
  expect(readFileSync(out + ".env", "utf8")).toBe("limited");
});
