// kermanych/apps/api/test/rpc-session.follow-up.spec.ts
// A follow-up must reach an IDLE omp child as a turn. omp's bare `follow_up` command only
// queues, and an idle child (omp 18.8.4) never drains that queue — the message to a settled
// session went unanswered. `prompt` + `streamingBehavior: "followUp"` runs when idle and queues
// behind a running turn. A fake `omp` records the frames, so the wire shape is asserted against
// the real spawn/write path.
import { afterAll, beforeAll, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcSession } from "../src/rpc/rpc-session";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-rpc-follow-up-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Appends every frame except the startup handshake to `frames`, then answers `get_state`, so
// the test has a round trip to wait on before reading what was written ahead of it.
function fakeOmp(frames: string): string {
  const p = join(dir, "omp.mjs");
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
      `    if (f.type === "negotiate_protocol" || f.type === "set_subagent_subscription") continue;\n` +
      `    if (f.type === "get_state") { process.stdout.write(JSON.stringify({ type: "response", id: f.id, command: f.type, success: true, data: {} }) + "\\n"); continue; }\n` +
      `    appendFileSync(${JSON.stringify(frames)}, line + "\\n");\n` +
      `  }\n` +
      `});\n` +
      `setInterval(()=>{},1000);\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

test("followUp is a prompt that queues only behind a running turn", async () => {
  const frames = join(dir, "frames.jsonl");
  const rpc = new RpcSession({ cwd: dir, ompPath: fakeOmp(frames) });
  rpc.onExit(() => {});
  await rpc.start();
  rpc.followUp("Давай варіант А", [{ data: "aGk=", mimeType: "image/png" }]);
  await rpc.getState();
  await rpc.stop();
  const sent = readFileSync(frames, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "prompt",
    message: "Давай варіант А",
    streamingBehavior: "followUp",
    images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
  });
});
