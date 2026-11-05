import { describe, expect, it } from "vitest";
import { hardwareFingerprint, machineTier, parseLimitsPatch, profileFor } from "../src/machine-profile";

const GIB = 1024 ** 3;

describe("machine profile", () => {
  // The tier boundaries are inclusive: a machine at exactly 16 GB is «Базова», not «Середня».
  it("picks the tier by RAM with inclusive upper bounds", () => {
    expect(machineTier(8 * GIB)).toBe("minimal");
    expect(machineTier(16 * GIB)).toBe("basic");
    expect(machineTier(24 * GIB)).toBe("medium");
    expect(machineTier(32 * GIB)).toBe("medium");
    expect(machineTier(48 * GIB)).toBe("strong");
    expect(machineTier(64 * GIB)).toBe("strong");
    expect(machineTier(96 * GIB)).toBe("max");
  });

  // A platform that reports a little under the installed RAM must not fall a tier.
  it("rounds reported RAM to whole GiB before picking the tier", () => {
    expect(machineTier(16 * GIB - 200 * 1024 ** 2)).toBe("basic");
  });

  it("gives the table's limits", () => {
    expect(profileFor({ ramBytes: 16 * GIB, perfCores: 8 })).toEqual({
      agents: 2, subagents: 2, background: false, testWorkers: 2,
      lowerPriority: true, watchdog: true, watchdogAction: "kill",
    });
    expect(profileFor({ ramBytes: 32 * GIB, perfCores: 8 })).toMatchObject({ agents: 3, subagents: 4, background: true, testWorkers: 2 });
  });

  // Strong machines cap test workers by half the performance cores, never below one.
  it("caps test workers by half the performance cores on the upper tiers", () => {
    expect(profileFor({ ramBytes: 48 * GIB, perfCores: 10 }).testWorkers).toBe(4);
    expect(profileFor({ ramBytes: 48 * GIB, perfCores: 4 }).testWorkers).toBe(2);
    expect(profileFor({ ramBytes: 128 * GIB, perfCores: 16 }).testWorkers).toBe(6);
    expect(profileFor({ ramBytes: 128 * GIB, perfCores: 1 }).testWorkers).toBe(1);
  });

  it("changes the fingerprint when RAM or cores change", () => {
    const a = hardwareFingerprint({ ramBytes: 16 * GIB, cores: 8, perfCores: 4 });
    expect(hardwareFingerprint({ ramBytes: 32 * GIB, cores: 8, perfCores: 4 })).not.toBe(a);
    expect(hardwareFingerprint({ ramBytes: 16 * GIB, cores: 10, perfCores: 4 })).not.toBe(a);
  });

  it("accepts a valid patch and names the first bad key", () => {
    expect(parseLimitsPatch({ agents: 3, background: false, watchdogAction: "notify" })).toEqual({
      ok: true, patch: { agents: 3, background: false, watchdogAction: "notify" },
    });
    expect(parseLimitsPatch({ agents: 0 })).toEqual({ ok: false, key: "agents" });
    expect(parseLimitsPatch({ subagents: 2.5 })).toEqual({ ok: false, key: "subagents" });
    expect(parseLimitsPatch({ watchdog: "yes" })).toEqual({ ok: false, key: "watchdog" });
    expect(parseLimitsPatch({ nice: 5 })).toEqual({ ok: false, key: "nice" });
    expect(parseLimitsPatch(null)).toEqual({ ok: false, key: "overrides" });
  });
});
