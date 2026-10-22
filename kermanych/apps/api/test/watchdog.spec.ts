import { beforeEach, describe, expect, it } from "vitest";
import type { MachineAlert, MachineHardware, MemoryPressure, ResourceLimits } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import { MachineResourcesService } from "../src/machine/machine-resources.service";
import { WatchdogService, type ProcRow } from "../src/machine/watchdog.service";

const MIB = 1024 ** 2;
const MAC48: MachineHardware = { ramBytes: 48 * 1024 ** 3, cores: 14, perfCores: 10, platform: "darwin" };

const proc = (pid: number, ppid: number, mib: number, command = `cmd-${pid}`): ProcRow => ({ pid, ppid, rssBytes: mib * MIB, command });

// The agent (pid 100) as it was when it became ready: an MCP server (npx → node) and a worker.
const AT_READY: ProcRow[] = [proc(1, 0, 10, "launchd"), proc(100, 1, 300, "omp --mode rpc"), proc(101, 100, 50, "npx mcp"), proc(102, 101, 80, "node mcp"), proc(110, 100, 40, "__omp_worker_1")];

let table: ProcRow[] | undefined;
let level: MemoryPressure | null;
let clock: number;
let alerts: MachineAlert[];
let signals: [number, NodeJS.Signals | 0][];
let alive: Set<number>;
let pending: (() => void)[];

function setup(overrides?: Partial<ResourceLimits>, decision: "applied" | "declined" = "applied") {
  const resources = new MachineResourcesService(new RegistryService(":memory:"));
  resources.detect = () => MAC48;
  resources.update({ decision, overrides });
  const wd = new WatchdogService(resources);
  wd.readPs = async () => table;
  wd.readPressure = async () => level;
  wd.now = () => clock;
  wd.signal = (pid, sig) => {
    signals.push([pid, sig]);
    return alive.has(pid);
  };
  wd.later = (fn) => {
    pending.push(fn);
  };
  wd.events$.subscribe((a) => alerts.push(a));
  return wd;
}

// `track` reads its baseline asynchronously.
const settle = () => new Promise<void>((r) => setImmediate(r));

async function tracked(overrides?: Partial<ResourceLimits>) {
  const wd = setup(overrides);
  table = AT_READY;
  wd.track("s1", "Сесія 1", 100);
  await settle();
  return wd;
}

async function sampleAt(wd: WatchdogService, l: MemoryPressure, at = clock) {
  level = l;
  clock = at;
  await wd.sample();
}

const sigterms = () => signals.filter(([, s]) => s === "SIGTERM").map(([p]) => p);

beforeEach(() => {
  table = [];
  level = 1;
  clock = 1_000_000;
  alerts = [];
  signals = [];
  alive = new Set();
  pending = [];
});

describe("victim choice", () => {
  it("never picks what the agent ran when it became ready, nor what those processes start later", async () => {
    const wd = await tracked();
    // The MCP server grows huge and starts another child; the one command is small.
    table = [...AT_READY.map((p) => (p.pid === 102 ? { ...p, rssBytes: 6000 * MIB } : p)), proc(103, 102, 3000), proc(200, 100, 20, "ls -la")];
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    expect(signals).toEqual([]);
    expect(alerts[0]).toMatchObject({ level: "warn", sessionId: "s1", pid: 200, command: "ls -la", killed: false });
    // Nothing of the agent's own reaches 1 GiB, so the critical notice blames no session.
    expect(alerts[1]).toMatchObject({ level: "critical", killed: false });
    expect(alerts[1].sessionId).toBeUndefined();
  });

  it("kills a command subtree of at least 1 GiB as a whole, and spares a smaller one", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 100, "npm test"), proc(201, 200, 400, "vitest worker"), proc(300, 100, 900, "node -e big")];
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    // 900 MiB alone is below the threshold; npm test with its worker is 500 MiB; so nothing yet.
    expect(signals).toEqual([]);

    const wd2 = await tracked();
    table = [...AT_READY, proc(200, 100, 100, "npm test"), proc(201, 200, 1000, "vitest worker"), proc(300, 100, 900, "node -e big")];
    await sampleAt(wd2, 4);
    await sampleAt(wd2, 4);
    expect(sigterms().sort()).toEqual([200, 201]);
    expect(alerts.at(-1)).toMatchObject({ level: "critical", sessionId: "s1", sessionName: "Сесія 1", pid: 200, rssBytes: 1100 * MIB, killed: true });
  });

  it("SIGKILLs only the processes still alive after the grace period", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 100, "npm test"), proc(201, 200, 2000, "vitest worker")];
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    alive = new Set([201]);
    pending.forEach((fn) => fn());
    expect(signals.filter(([, s]) => s === "SIGKILL")).toEqual([[201, "SIGKILL"]]);
  });
});

describe("pressure handling", () => {
  it("kills only on the second consecutive critical sample", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 2000, "node -e big")];
    await sampleAt(wd, 4);
    expect(signals).toEqual([]);
    await sampleAt(wd, 2);
    await sampleAt(wd, 4);
    expect(signals).toEqual([]);
    await sampleAt(wd, 4);
    expect(sigterms()).toEqual([200]);
  });

  it("waits out the 30 s cooldown before the next kill", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 2000, "first")];
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    expect(sigterms()).toEqual([200]);

    table = [...AT_READY, proc(300, 100, 2000, "second")];
    await sampleAt(wd, 4, clock + 10_000);
    await sampleAt(wd, 4, clock + 10_000);
    expect(sigterms()).toEqual([200]);
    await sampleAt(wd, 4, clock + 11_000);
    expect(sigterms()).toEqual([200, 300]);
  });

  it("warns once per episode, and again in the next one", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 500, "npm test")];
    await sampleAt(wd, 2);
    await sampleAt(wd, 2);
    await sampleAt(wd, 2);
    expect(alerts.map((a) => a.level)).toEqual(["warn"]);
    await sampleAt(wd, 1);
    await sampleAt(wd, 2);
    expect(alerts.map((a) => a.level)).toEqual(["warn", "warn"]);
    expect(signals).toEqual([]);
  });

  it("with action notify only tells, once per critical run", async () => {
    const wd = await tracked({ watchdogAction: "notify" });
    table = [...AT_READY, proc(200, 100, 3000, "node -e big")];
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    expect(signals).toEqual([]);
    expect(alerts.map((a) => [a.level, a.killed, a.sessionId])).toEqual([
      ["warn", false, "s1"],
      ["critical", false, "s1"],
    ]);
  });

  it("alerts without a session when no agent started anything", async () => {
    const wd = await tracked();
    table = AT_READY;
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    expect(alerts.map((a) => [a.level, a.killed, a.sessionId])).toEqual([
      ["warn", false, undefined],
      ["critical", false, undefined],
    ]);
    expect(signals).toEqual([]);
  });

  it("does nothing while the limits are declined or the watchdog is off", async () => {
    for (const wd of [setup(undefined, "declined"), setup({ watchdog: false })]) {
      table = AT_READY;
      wd.track("s1", "Сесія 1", 100);
      await settle();
      table = [...AT_READY, proc(200, 100, 3000)];
      await sampleAt(wd, 4);
      await sampleAt(wd, 4);
    }
    expect(alerts).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("after a kill, the rest of that critical run stays quiet", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 2000, "node -e big")];
    await sampleAt(wd, 4);
    await sampleAt(wd, 4);
    table = AT_READY;
    await sampleAt(wd, 4, clock + 5_000);
    await sampleAt(wd, 4, clock + 40_000);
    expect(alerts.map((a) => [a.level, a.killed])).toEqual([
      ["warn", false],
      ["critical", true],
    ]);
  });
});

describe("«Зупинити команду»", () => {
  it("kills a command of that session and refuses its MCP server or another session's", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 100, "npm test"), proc(201, 200, 100)];
    expect(await wd.kill("s1", 101)).toBe(false);
    expect(await wd.kill("s2", 200)).toBe(false);
    expect(signals).toEqual([]);

    expect(await wd.kill("s1", 200)).toBe(true);
    expect(sigterms().sort()).toEqual([200, 201]);
    expect(alerts).toEqual([expect.objectContaining({ sessionId: "s1", pid: 200, command: "npm test", killed: true })]);
  });

  it("forgets an untracked session", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(200, 100, 100, "npm test")];
    wd.untrack("s1");
    expect(await wd.kill("s1", 200)).toBe(false);
  });
});

describe("baseline", () => {
  it("re-tracking the same child adds what it started since to the baseline", async () => {
    const wd = await tracked();
    // claude's system init starts its MCP server after the first track.
    table = [...AT_READY, proc(120, 100, 50, "node late-mcp")];
    wd.track("s1", "Сесія 1", 100);
    await settle();
    table = [...AT_READY, proc(120, 100, 3000, "node late-mcp"), proc(200, 100, 100, "npm test")];
    expect(await wd.kill("s1", 120)).toBe(false);
    expect(await wd.kill("s1", 200)).toBe(true);
  });

  it("a new pid for the session replaces its old child", async () => {
    const wd = await tracked();
    table = [...AT_READY, proc(500, 1, 300, "omp --mode rpc"), proc(501, 500, 50, "npx mcp")];
    wd.track("s1", "Сесія 1", 500);
    await settle();
    table = [...AT_READY, proc(200, 100, 100, "orphan"), proc(500, 1, 300), proc(501, 500, 50), proc(600, 500, 100, "npm test")];
    expect(await wd.kill("s1", 200)).toBe(false);
    expect(await wd.kill("s1", 501)).toBe(false);
    expect(await wd.kill("s1", 600)).toBe(true);
  });

  it("retries a failed baseline read on the next sample, offering no candidates until then", async () => {
    const wd = setup();
    table = undefined;
    wd.track("s1", "Сесія 1", 100);
    await settle();
    table = [...AT_READY, proc(200, 100, 100, "npm test")];
    expect(await wd.kill("s1", 200)).toBe(false);

    table = AT_READY;
    await sampleAt(wd, 1);
    table = [...AT_READY, proc(200, 100, 100, "npm test")];
    expect(await wd.kill("s1", 101)).toBe(false);
    expect(await wd.kill("s1", 200)).toBe(true);
  });
});
