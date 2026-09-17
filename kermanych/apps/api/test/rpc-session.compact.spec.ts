// kermanych/apps/api/test/rpc-session.compact.spec.ts
// Compaction reaches omp through the `compact` RPC command — a contract with a foreign process.
// A fake `omp` answers real frames and records what it was sent, so the frame shape (and the
// optional `customInstructions`) is asserted against the actual command path, not a mock of our
// own wrapper.
import { afterAll, beforeAll, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcSession } from "../src/rpc/rpc-session";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-rpc-compact-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Answers every command frame it is sent: `success` reflects the `ok` flag, and the whole frame
// is appended to `frames` so the test can read what the wrapper actually put on the wire.
function fakeOmp(name: string, frames: string, ok: boolean): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `import { writeFileSync, appendFileSync } from "node:fs";\n` +
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
      `      : { type: "response", id: f.id, command: f.type, success: false, error: "Nothing to compact" }\n` +
      `    ) + "\\n");\n` +
      `  }\n` +
      `});\n` +
      `setInterval(()=>{},1000);\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

const sentFrames = (frames: string): Record<string, unknown>[] =>
  readFileSync(frames, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

test("compact() sends the bare command frame and resolves once acknowledged", async () => {
  const frames = join(dir, "c1.jsonl");
  const rpc = new RpcSession({ cwd: dir, ompPath: fakeOmp("compact-ok.mjs", frames, true) });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.compact();
  await rpc.stop();
  const sent = sentFrames(frames);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "compact" });
  // No instructions means the field is omitted, not sent empty.
  expect(sent[0]).not.toHaveProperty("customInstructions");
});

test("compact(instructions) forwards them as customInstructions", async () => {
  const frames = join(dir, "c2.jsonl");
  const rpc = new RpcSession({ cwd: dir, ompPath: fakeOmp("compact-args.mjs", frames, true) });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.compact("keep the auth decisions");
  await rpc.stop();
  const sent = sentFrames(frames);
  expect(sent[0]).toMatchObject({ type: "compact", customInstructions: "keep the auth decisions" });
});

test("compact() rejects with omp's own reason when the child refuses", async () => {
  const rpc = new RpcSession({ cwd: dir, ompPath: fakeOmp("compact-fail.mjs", join(dir, "c3.jsonl"), false) });
  rpc.onExit(() => {});
  await rpc.start();
  await expect(rpc.compact()).rejects.toThrow(/Nothing to compact/);
  await rpc.stop();
});
