// apps/api/test/child-ledger.spec.ts
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChildLedger, processStarted } from "../src/runtime/child-ledger";

// Real processes, because the ledger's whole job is telling a live, recorded process from a dead
// or reused pid: `sleep` children in their own groups, the way omp and preview steps are spawned.
let dir: string;
const spawned: ChildProcess[] = [];

function group(): ChildProcess {
  const c = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  spawned.push(c);
  return c;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-ledger-"));
});
afterEach(() => {
  for (const c of spawned.splice(0)) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "kmq-ledger-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, owner: { pid: number; started: string }, children: { pid: number; started: string; label: string }[]) =>
  writeFileSync(join(dir, name), JSON.stringify({ owner, children }));

it("stops the recorded groups of an api that is gone, and forgets its file", async () => {
  const orphan = group();
  const started = await processStarted(orphan.pid!);
  write("dead.json", { pid: process.pid + 100_000, started: "Thu Jan  1 00:00:00 1970" }, [{ pid: orphan.pid!, started, label: "omp" }]);

  await new ChildLedger(dir, processStarted, 200).sweep();

  await vi.waitFor(() => expect(alive(orphan.pid!)).toBe(false), { timeout: 3_000 });
  expect(existsSync(join(dir, "dead.json"))).toBe(false);
});

it("leaves the children of an api that still runs", async () => {
  const owner = group();
  const child = group();
  write("live.json", { pid: owner.pid!, started: await processStarted(owner.pid!) }, [
    { pid: child.pid!, started: await processStarted(child.pid!), label: "omp" },
  ]);

  await new ChildLedger(dir, processStarted, 200).sweep();

  expect(alive(child.pid!)).toBe(true);
  expect(existsSync(join(dir, "live.json"))).toBe(true);
});

// After a reboot the recorded pid can belong to somebody else's program: its start time differs.
it("never signals a pid whose start time no longer matches the record", async () => {
  const stranger = group();
  write("dead.json", { pid: process.pid + 100_000, started: "x" }, [{ pid: stranger.pid!, started: "Thu Jan  1 00:00:00 1970", label: "omp" }]);

  await new ChildLedger(dir, processStarted, 200).sweep();

  expect(alive(stranger.pid!)).toBe(true);
});

// `ps` lays lstart out by the caller's locale. Two apis on one machine often run under different
// ones (the Electron app's LANG, a terminal's `pnpm dev:api`), so a start time read under one must
// still match when read under the other.
async function underLocale<T>(locale: string, fn: () => Promise<T>): Promise<T> {
  const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
  process.env.LC_ALL = locale;
  process.env.LANG = locale;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

it("keeps the file of a live api that wrote it under another locale", async () => {
  const owner = group();
  const child = group();
  await underLocale("uk_UA.UTF-8", async () =>
    write("live.json", { pid: owner.pid!, started: await processStarted(owner.pid!) }, [
      { pid: child.pid!, started: await processStarted(child.pid!), label: "omp" },
    ]),
  );

  await underLocale("en_NZ.UTF-8", () => new ChildLedger(dir, processStarted, 200).sweep());

  expect(alive(child.pid!)).toBe(true);
  expect(existsSync(join(dir, "live.json"))).toBe(true);
});

it("stops the groups of a dead api that wrote them under another locale", async () => {
  const orphan = group();
  const started = await underLocale("uk_UA.UTF-8", () => processStarted(orphan.pid!));
  write("dead.json", { pid: process.pid + 100_000, started: "Thu Jan  1 00:00:00 1970" }, [{ pid: orphan.pid!, started, label: "omp" }]);

  await underLocale("en_NZ.UTF-8", () => new ChildLedger(dir, processStarted, 200).sweep());

  await vi.waitFor(() => expect(alive(orphan.pid!)).toBe(false), { timeout: 3_000 });
});

// Files written before start times were read in the C locale carry the owner's own layout, which
// no longer compares. While that pid runs the file stays: it may be a live, older api.
it("keeps a file in an older locale layout while its owner pid runs", async () => {
  const owner = group();
  write("old.json", { pid: owner.pid!, started: "Tue 17 Nov 12:24:59 2026" }, []);

  await new ChildLedger(dir, processStarted, 200).sweep();

  expect(existsSync(join(dir, "old.json"))).toBe(true);
});

it("forgets the file of an api whose pid now belongs to another process", async () => {
  const stranger = group();
  write("reused.json", { pid: stranger.pid!, started: "Thu Jan  1 00:00:00 1970" }, []);

  await new ChildLedger(dir, processStarted, 200).sweep();

  expect(existsSync(join(dir, "reused.json"))).toBe(false);
});

it("writes a child down once its start time is known and drops it when it exits", async () => {
  const ledger = new ChildLedger(dir, processStarted, 200);
  await ledger.open();
  const file = join(dir, `${process.pid}.json`);
  const c = group();

  ledger.add(c.pid!, "preview web");
  await vi.waitFor(() => expect(JSON.parse(readFileSync(file, "utf8")).children).toEqual([{ pid: c.pid, started: expect.any(String), label: "preview web" }]));

  ledger.remove(c.pid!);
  expect(JSON.parse(readFileSync(file, "utf8")).children).toEqual([]);
});
