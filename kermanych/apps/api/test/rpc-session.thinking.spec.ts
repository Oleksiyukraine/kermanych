// kermanych/apps/api/test/rpc-session.thinking.spec.ts
// Reasoning effort has two wires into omp — the `--thinking` launch flag and the
// `set_thinking_level` command — and both are contracts with a foreign process. A fake `omp`
// records its argv and answers real frames, so the flag and the frame shape are asserted
// against the actual spawn/command path rather than a mock of our own wrapper.
import { afterAll, beforeAll, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcSession } from "../src/rpc/rpc-session";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-rpc-thinking-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Writes its argv to `out`, then answers every command frame it is sent: `success` reflects
// the `ok` flag, and the whole frame is appended to `frames` so the test can read what the
// wrapper actually put on the wire.
function fakeOmp(name: string, out: string, frames: string, ok: boolean): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `import { writeFileSync, appendFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n` +
      `writeFileSync(${JSON.stringify(frames)}, "");\n` +
      `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");\n` +
      `let buf = "";\n` +
      `process.stdin.on("data", (b) => {\n` +
      `  buf += b.toString();\n` +
      `  const lines = buf.split("\\n"); buf = lines.pop() ?? "";\n` +
      `  for (const line of lines) {\n` +
      `    if (!line.trim()) continue;\n` +
      `    const f = JSON.parse(line);\n` +
      `    if (f.type === "negotiate_protocol") continue;\n` +
      `    appendFileSync(${JSON.stringify(frames)}, line + "\\n");\n` +
      `    process.stdout.write(JSON.stringify(${ok}\n` +
      `      ? { type: "response", id: f.id, command: f.type, success: true }\n` +
      `      : { type: "response", id: f.id, command: f.type, success: false, error: "thinking level not supported by provider" }\n` +
      `    ) + "\\n");\n` +
      `  }\n` +
      `});\n` +
      `setInterval(()=>{},1000);\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

// --model straddles the push, so a `--thinking` that drifted to the wrong side of it would
// change this array rather than compare equal wherever it sits.
test("the launch effort becomes --thinking, right after --model", async () => {
  const out = join(dir, "argv.json");
  const rpc = new RpcSession({
    cwd: dir, ompPath: fakeOmp("thinking.mjs", out, join(dir, "f1.jsonl"), true), model: "opus-5", thinking: "xhigh", tools: ["read"],
  });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
    "--mode", "rpc", "--cwd", dir, "--model", "opus-5", "--thinking", "xhigh", "--tools", "read",
  ]);
});

test("no effort means no --thinking", async () => {
  const out = join(dir, "argv2.json");
  const rpc = new RpcSession({ cwd: dir, ompPath: fakeOmp("no-thinking.mjs", out, join(dir, "f2.jsonl"), true), model: "opus-5" });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--mode", "rpc", "--cwd", dir, "--model", "opus-5"]);
});

test("setThinkingLevel sends omp's documented frame and resolves once acknowledged", async () => {
  const frames = join(dir, "f3.jsonl");
  const rpc = new RpcSession({ cwd: dir, ompPath: fakeOmp("set-ok.mjs", join(dir, "argv3.json"), frames, true) });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.setThinkingLevel("max");
  await rpc.stop();
  const sent = readFileSync(frames, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "set_thinking_level", level: "max" });
});

// The refusal has to travel: the api only writes the row after this resolves, so swallowing
// the error here would leave the composer showing a level the agent is not running at.
test("setThinkingLevel rejects with omp's own reason when the child refuses", async () => {
  const rpc = new RpcSession({ cwd: dir, ompPath: fakeOmp("set-fail.mjs", join(dir, "argv4.json"), join(dir, "f4.jsonl"), false) });
  rpc.onExit(() => {});
  await rpc.start();
  await expect(rpc.setThinkingLevel("max")).rejects.toThrow(/thinking level not supported by provider/);
  await rpc.stop();
});
