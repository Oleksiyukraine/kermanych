// kermanych/apps/api/test/rpc-session.subagents.spec.ts
// A fake `omp` that logs the commands it receives (to `<cwd>/cmds.log`) and speaks the
// subagent surface: it emits a `subagent_lifecycle` frame once subscribed and answers
// `get_subagents` / `get_subagent_messages`. This pins the real spawn path — the same wire
// RpcSession drives against a live omp — rather than a mock of RpcSession itself.
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcSession } from "../src/rpc/rpc-session";
import type { RpcEvent } from "@kermanych/core";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "kmq-rpc-sub-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// `String.fromCharCode(10)` is a newline the outer template literal cannot swallow: writing
// a literal "\n" here would have to survive two levels of escaping to reach the child's
// source. This keeps the fake's body free of backtick/newline escaping.
function fakeOmp(): string {
  const p = join(dir, "fake-omp.mjs");
  writeFileSync(p, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const NL = String.fromCharCode(10);
const args = process.argv.slice(2);
const ci = args.indexOf("--cwd");
const log = (ci >= 0 ? args[ci + 1] : process.cwd()) + "/cmds.log";
const send = (o) => process.stdout.write(JSON.stringify(o) + NL);
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let cmd;
  try { cmd = JSON.parse(s); } catch { return; }
  appendFileSync(log, s + NL);
  if (cmd.type === "set_subagent_subscription") {
    send({ type: "subagent_lifecycle", subagentId: "Task", index: 0, status: "running" });
  } else if (cmd.type === "get_subagents") {
    send({ id: cmd.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "Task", index: 0, status: "idle" }] } });
  } else if (cmd.type === "get_subagent_messages") {
    send({ id: cmd.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: "/x.jsonl", fromByte: 0, nextByte: 42, reset: false, entries: [], messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] } });
  }
});
rl.on("close", () => process.exit(0));
`);
  chmodSync(p, 0o755);
  return p;
}

function loggedCommands(cwd: string): Array<{ type: string; [k: string]: unknown }> {
  const log = join(cwd, "cmds.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("after ready: negotiates v2 THEN subscribes to subagent progress, and forwards lifecycle frames", async () => {
  const cwd = mkdtempSync(join(dir, "s-"));
  const rpc = new RpcSession({ cwd, ompPath: fakeOmp(), commandTimeoutMs: 5000 });
  const events: RpcEvent[] = [];
  rpc.onEvent((e) => events.push(e));
  rpc.onExit(() => {});
  await rpc.start();

  // The lifecycle frame only arrives because the subscription reached the child.
  await vi.waitFor(() => expect(events.some((e) => e.type === "subagent_lifecycle")).toBe(true));
  const life = events.find((e) => e.type === "subagent_lifecycle") as Extract<RpcEvent, { type: "subagent_lifecycle" }>;
  expect(life.subagentId).toBe("Task");

  const cmds = loggedCommands(cwd);
  const types = cmds.map((c) => c.type);
  expect(types).toContain("negotiate_protocol");
  expect(types).toContain("set_subagent_subscription");
  // Subscription must follow negotiation, never precede it.
  expect(types.indexOf("negotiate_protocol")).toBeLessThan(types.indexOf("set_subagent_subscription"));
  expect(cmds.find((c) => c.type === "set_subagent_subscription")?.level).toBe("progress");

  await rpc.stop();
});

test("getSubagents and getSubagentMessages return omp's registry snapshot and transcript page", async () => {
  const cwd = mkdtempSync(join(dir, "s-"));
  const rpc = new RpcSession({ cwd, ompPath: fakeOmp(), commandTimeoutMs: 5000 });
  rpc.onExit(() => {});
  await rpc.start();

  expect(await rpc.getSubagents()).toEqual([{ id: "Task", index: 0, status: "idle" }]);

  const page = await rpc.getSubagentMessages({ subagentId: "Task" });
  expect(page.nextByte).toBe(42);
  expect(page.reset).toBe(false);
  expect(page.messages).toHaveLength(1);

  await rpc.stop();
});

test('subagentSubscription "off" sends no subscription command', async () => {
  const cwd = mkdtempSync(join(dir, "s-"));
  const rpc = new RpcSession({ cwd, ompPath: fakeOmp(), subagentSubscription: "off", commandTimeoutMs: 5000 });
  rpc.onExit(() => {});
  await rpc.start();

  // Round-trip a command so the child has provably processed past negotiation before we read
  // the log — otherwise "no subscription yet" could just be a race with stdin.
  await rpc.getSubagents();

  const types = loggedCommands(cwd).map((c) => c.type);
  expect(types).toContain("negotiate_protocol");
  expect(types).not.toContain("set_subagent_subscription");

  await rpc.stop();
});
