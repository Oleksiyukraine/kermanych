import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineHardware } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import { MachineResourcesService } from "../src/machine/machine-resources.service";

const GIB = 1024 ** 3;
// 48 GB, 14 cores (10 performance): the «strong» row — 5 agents, 6 subagents, background on,
// 4 test workers.
const MAC48: MachineHardware = { ramBytes: 48 * GIB, cores: 14, perfCores: 10, platform: "darwin" };
const MAC16: MachineHardware = { ramBytes: 16 * GIB, cores: 8, perfCores: 4, platform: "darwin" };

const OMP_DEFAULTS: Record<string, unknown> = { "task.maxConcurrency": 32, "bash.autoBackground.enabled": true };

type OmpCall = { key: string; cwd: string; isolated: boolean };

// A service over an in-memory registry with every machine read faked: the given hardware, no
// claude settings, pressure "1", and omp answering its defaults in the isolated read and
// `ompByCwd[cwd]` (falling back to the defaults) everywhere else.
function make(registry: RegistryService, hw: MachineHardware, ompByCwd: Record<string, Record<string, unknown>> = {}) {
  const svc = new MachineResourcesService(registry);
  const ompCalls: OmpCall[] = [];
  svc.detect = () => hw;
  svc.readSysctl = async () => "1";
  svc.readClaudeEnv = async () => undefined;
  svc.readOmpValue = async (key, cwd, env) => {
    const isolated = env?.PI_CODING_AGENT_DIR !== undefined;
    ompCalls.push({ key, cwd, isolated });
    return isolated ? OMP_DEFAULTS[key] : (ompByCwd[cwd]?.[key] ?? OMP_DEFAULTS[key]);
  };
  return { svc, ompCalls };
}

const SLOTS = { running: 0, waiting: 0 };

describe("consent and fingerprint", () => {
  it("asks for consent while no decision is stored, and limits nothing", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    const r = await svc.snapshot(SLOTS);
    expect(r.decision).toBeNull();
    expect(r.askConsent).toBe(true);
    expect(svc.active()).toBeNull();
  });

  it("applies the profile after «Застосувати» and asks again once the hardware differs", async () => {
    const registry = new RegistryService(":memory:");
    const { svc } = make(registry, MAC48);
    svc.update({ decision: "applied" });
    expect((await svc.snapshot(SLOTS)).askConsent).toBe(false);
    expect(svc.active()).toMatchObject({ agents: 5, subagents: 6, background: true, testWorkers: 4 });

    // The same database on a different machine (a restore from backup): the popup is due, and
    // the agreed limits follow the new machine's profile meanwhile.
    const { svc: moved } = make(registry, MAC16);
    const r = await moved.snapshot(SLOTS);
    expect(r.askConsent).toBe(true);
    expect(r.decision).toBe("applied");
    expect(moved.active()).toMatchObject({ agents: 2, subagents: 2, background: false });
  });

  it("limits nothing after «Не зараз» and does not ask again on the same hardware", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    svc.update({ decision: "declined" });
    expect((await svc.snapshot(SLOTS)).askConsent).toBe(false);
    expect(svc.active()).toBeNull();
    expect(svc.claudeEnv()).toBeUndefined();
    expect(svc.promptParagraph()).toBeUndefined();
    expect(await svc.ompOverlay("/repo")).toBeUndefined();
  });

  it("redetect clears the decision but keeps the overrides", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    svc.update({ decision: "applied", overrides: { agents: 2 } });
    svc.redetect();
    const r = await svc.snapshot(SLOTS);
    expect(r.decision).toBeNull();
    expect(r.askConsent).toBe(true);
    expect(r.overrides).toEqual({ agents: 2 });
    expect(svc.active()).toBeNull();
  });

  it("tells every subscriber about each change", () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    const seen: string[] = [];
    svc.onChange(() => seen.push("a"));
    svc.onChange(() => seen.push("b"));
    svc.update({ decision: "applied" });
    svc.redetect();
    expect(seen).toEqual(["a", "b", "a", "b"]);
  });
});

describe("overrides", () => {
  it("lays the operator's values over the profile and resets back to it", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    // subagents 6 equals the profile, so it is not an override.
    svc.update({ decision: "applied", overrides: { agents: 2, subagents: 6, watchdogAction: "notify" } });
    let r = await svc.snapshot(SLOTS);
    expect(r.overrides).toEqual({ agents: 2, watchdogAction: "notify" });
    expect(r.effective).toEqual({ ...r.profile, agents: 2, watchdogAction: "notify" });
    expect(svc.active()?.agents).toBe(2);

    svc.update({ overrides: null });
    r = await svc.snapshot(SLOTS);
    expect(r.overrides).toEqual({});
    expect(r.effective).toEqual(r.profile);
    expect(r.decision).toBe("applied");
  });

  it("a later save replaces the stored overrides rather than adding to them", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    svc.update({ overrides: { agents: 2 } });
    svc.update({ overrides: { testWorkers: 1 } });
    expect((await svc.snapshot(SLOTS)).overrides).toEqual({ testWorkers: 1 });
  });

  it("keeps each valid key of a stored row and drops the rest", async () => {
    const registry = new RegistryService(":memory:");
    const { svc } = make(registry, MAC48);
    registry.setMachineResources({ fingerprint: "x", decision: "applied", overrides: JSON.stringify({ agents: 3, subagents: 0, bogus: 1 }) });
    expect((await svc.snapshot(SLOTS)).overrides).toEqual({ agents: 3 });
    registry.setMachineResources({ fingerprint: "x", decision: "applied", overrides: "not json" });
    expect((await svc.snapshot(SLOTS)).overrides).toEqual({});
  });
});

describe("omp overlay", () => {
  let home: string;
  const prevHome = process.env.KERMANYCH_SKILLS_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kermanych-resources-"));
    process.env.KERMANYCH_SKILLS_HOME = home;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.KERMANYCH_SKILLS_HOME;
    else process.env.KERMANYCH_SKILLS_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it("writes both limits where the operator set neither", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    svc.update({ decision: "applied", overrides: { background: false } });
    const path = await svc.ompOverlay("/repo");
    expect(path?.startsWith(join(home, "resources"))).toBe(true);
    expect(await readFile(path!, "utf8")).toBe("task:\n  maxConcurrency: 6\nbash:\n  autoBackground:\n    enabled: false\n");
  });

  it("leaves out a key the operator's global or project config sets", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48, { "/repo": { "task.maxConcurrency": 12 } });
    svc.update({ decision: "applied" });
    const path = await svc.ompOverlay("/repo");
    expect(await readFile(path!, "utf8")).toBe("bash:\n  autoBackground:\n    enabled: true\n");
  });

  it("writes nothing when the operator set both keys", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48, {
      "/repo": { "task.maxConcurrency": 12, "bash.autoBackground.enabled": false },
    });
    svc.update({ decision: "applied" });
    expect(await svc.ompOverlay("/repo")).toBeUndefined();
  });

  it("leaves out a key whose value omp could not report", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    const read = svc.readOmpValue;
    svc.readOmpValue = async (key, cwd, env) => (env === undefined && key === "bash.autoBackground.enabled" ? undefined : read(key, cwd, env));
    svc.update({ decision: "applied" });
    const path = await svc.ompOverlay("/repo");
    expect(await readFile(path!, "utf8")).toBe("task:\n  maxConcurrency: 6\n");
  });

  it("reads omp's defaults once per process, and nothing at all while inactive", async () => {
    const { svc, ompCalls } = make(new RegistryService(":memory:"), MAC48);
    expect(await svc.ompOverlay("/repo")).toBeUndefined();
    expect(ompCalls).toEqual([]);

    svc.update({ decision: "applied" });
    await svc.ompOverlay("/a");
    await svc.ompOverlay("/b");
    expect(ompCalls.filter((c) => c.isolated)).toHaveLength(2);
    expect(ompCalls.filter((c) => !c.isolated).map((c) => c.cwd)).toEqual(["/a", "/a", "/b", "/b"]);
  });

  it("reads omp's defaults with no profile or config-file list from the api's environment", async () => {
    const saved = { OMP_PROFILE: process.env.OMP_PROFILE, PI_PROFILE: process.env.PI_PROFILE, PI_CONFIG_FILES: process.env.PI_CONFIG_FILES };
    Object.assign(process.env, { OMP_PROFILE: "work", PI_PROFILE: "work", PI_CONFIG_FILES: "/home/me/omp.yml" });
    try {
      const { svc } = make(new RegistryService(":memory:"), MAC48);
      const envs: NodeJS.ProcessEnv[] = [];
      const read = svc.readOmpValue;
      svc.readOmpValue = async (key, cwd, env) => {
        if (env) envs.push(env);
        return read(key, cwd, env);
      };
      svc.update({ decision: "applied" });
      await svc.ompOverlay("/repo");
      expect(envs).toHaveLength(2);
      for (const env of envs) {
        expect(env).not.toHaveProperty("OMP_PROFILE");
        expect(env).not.toHaveProperty("PI_PROFILE");
        expect(env).not.toHaveProperty("PI_CONFIG_FILES");
        expect(env.PI_CODING_AGENT_DIR).toMatch(/kermanych-omp-defaults-.*\/agent$/);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("claude env, prompt and snapshot", () => {
  it("disables background tasks only when the limits turn them off", () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48);
    svc.update({ decision: "applied" });
    expect(svc.claudeEnv()).toEqual({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "6" });
    svc.update({ overrides: { background: false, subagents: 2 } });
    expect(svc.claudeEnv()).toEqual({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
    expect(svc.promptParagraph()).toContain("--maxWorkers=4");
  });

  it("reports pressure, slots and the machine-wide sources that override in-agent limits", async () => {
    const { svc } = make(new RegistryService(":memory:"), MAC48, { [homedir()]: { "task.maxConcurrency": 12 } });
    svc.readSysctl = async (name) => (name === "kern.memorystatus_vm_pressure_level" ? "4" : undefined);
    svc.readClaudeEnv = async (path) => (path === join(homedir(), ".claude", "settings.json") ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } : undefined);
    const r = await svc.snapshot({ running: 2, waiting: 1 });
    expect(r).toMatchObject({ tier: "strong", pressure: 4, watchdogSupported: true, running: 2, waiting: 1 });
    expect(r.overriddenBy).toEqual({
      subagents: [{ source: "~/.omp/agent/config.yml", value: "task.maxConcurrency = 12" }],
      background: [{ source: "~/.claude/settings.json", value: "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = 1" }],
    });
  });

  it("has no pressure and no watchdog off macOS", async () => {
    const { svc } = make(new RegistryService(":memory:"), { ...MAC48, platform: "linux" });
    svc.readSysctl = async () => "4";
    const r = await svc.snapshot(SLOTS);
    expect(r.pressure).toBeNull();
    expect(r.watchdogSupported).toBe(false);
  });
});
