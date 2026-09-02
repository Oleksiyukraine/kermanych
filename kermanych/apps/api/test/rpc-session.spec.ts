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

test("command() rejects when a ready child never answers (wedged RPC)", async () => {
  // Emits `ready` (so start() resolves) then goes deaf — ignores every command. getState()
  // must reject via the timeout instead of hanging forever.
  const omp = fakeOmp(
    "deaf.mjs",
    `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");setInterval(()=>{},1000);`,
  );
  const rpc = new RpcSession({ cwd: dir, ompPath: omp, commandTimeoutMs: 200 });
  rpc.onExit(() => {});
  await rpc.start();
  await expect(rpc.getState()).rejects.toThrow(/did not respond|200ms/);
  await rpc.stop();
});

test("one undecodable frame yields exactly one warning notice and the stream keeps flowing", async () => {
  // Opens a chunk sequence, then interleaves a different one so the reassembler throws.
  // Without a reset it would stay mid-sequence and reject the three deltas that follow,
  // turning one loss into a notice per frame for the rest of the session.
  const omp = fakeOmp(
    "poisoned-chunk.mjs",
    `const w=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");` +
      `w({type:"ready",protocolVersion:2});` +
      `setTimeout(()=>{` +
      `w({type:"rpc_chunk",chunkId:"c1",index:0,count:2,byteLength:10,data:"AA"});` +
      `w({type:"rpc_chunk",chunkId:"c2",index:0,count:2,byteLength:10,data:"BB"});` +
      `w({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"a"}});` +
      `w({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"b"}});` +
      `w({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"c"}});` +
      `},40);` +
      `setInterval(()=>{},1000);`,
  );
  const rpc = new RpcSession({ cwd: dir, ompPath: omp });
  rpc.onExit(() => {});
  const notices: { message?: string; level?: string }[] = [];
  let deltas = 0;
  // Subscribe before start() so no frame is missed, but bound the wait only after the child is
  // up: a window opened before spawn would also cover spawn time and could expire early on a
  // loaded machine. The bound exists so a poisoned reassembler reports counts instead of
  // timing the suite out.
  let settle = () => {};
  const settled = new Promise<void>((res) => {
    settle = res;
  });
  rpc.onEvent((e) => {
    if (e.type === "notice") notices.push(e as { message?: string; level?: string });
    if (e.type === "message_update" && ++deltas === 3) settle();
  });
  await rpc.start();
  const bail = setTimeout(settle, 600);
  await settled;
  clearTimeout(bail);
  await rpc.stop();

  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ level: "warn", message: "втрачено кадр від omp" });
  expect(rpc.droppedFrames).toBe(1);
  expect(deltas).toBe(3);
});

test("isAlive() reports dead the instant stop() is called, before the child has exited", async () => {
  // A child that ignores stdin EOF and lingers, so the process is provably still up when we
  // check. Without the synchronous `stopping` flag isAlive() would keep reporting true across
  // the whole SIGTERM/SIGKILL window — the gap where a send coinciding with a reap would be
  // written to the dying child's ended stdin and silently lost.
  const omp = fakeOmp(
    "lingers.mjs",
    `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");` +
      `process.stdin.resume();setInterval(()=>{},1000);`,
  );
  const rpc = new RpcSession({ cwd: dir, ompPath: omp });
  rpc.onExit(() => {});
  await rpc.start();
  expect(rpc.isAlive()).toBe(true);

  const stopped = rpc.stop(); // NOT awaited: the child lingers, so isAlive() must flip now
  expect(rpc.isAlive()).toBe(false);

  await stopped; // let the SIGTERM escalation reap the lingering child
  expect(rpc.isAlive()).toBe(false);
});
