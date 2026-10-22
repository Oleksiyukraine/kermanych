// The machine resource profile (docs/specs/2026-10-21-machine-resource-profile.md): how
// much agent work this machine can carry at once, derived from its RAM and cores. One pure
// table shared by the api (which enforces it) and the UI (which shows and edits it).

export type MachineHardware = {
  ramBytes: number;
  // Logical cores (`os.availableParallelism()`).
  cores: number;
  // Performance cores (`hw.perflevel0.physicalcpu` on Apple silicon); `cores` where the
  // platform does not split them.
  perfCores: number;
  // `process.platform`. The watchdog reads macOS memory pressure only.
  platform: string;
};

export const MACHINE_TIERS = ["minimal", "basic", "medium", "strong", "max"] as const;
export type MachineTier = (typeof MACHINE_TIERS)[number];

// What the watchdog does at critical pressure: kill the heaviest command an agent started,
// or only tell the operator.
export type WatchdogAction = "kill" | "notify";

export type ResourceLimits = {
  // Agent sessions (`kind: "agent"`) whose turn runs at once; the rest wait for a slot.
  agents: number;
  // Subagents one session may run in parallel (omp `task.maxConcurrency`, claude
  // `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).
  subagents: number;
  // Background commands that outlive a tool call (omp `bash.autoBackground.enabled`, claude
  // `run_in_background`). `false` turns them off.
  background: boolean;
  // Test-runner workers the system prompt asks the agent to use.
  testWorkers: number;
  // Run every agent process tree at nice `AGENT_NICE`.
  lowerPriority: boolean;
  watchdog: boolean;
  watchdogAction: WatchdogAction;
};

export const RESOURCE_LIMIT_KEYS = [
  "agents",
  "subagents",
  "background",
  "testWorkers",
  "lowerPriority",
  "watchdog",
  "watchdogAction",
] as const satisfies readonly (keyof ResourceLimits)[];

export type ResourceDecision = "applied" | "declined";

// macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical.
export type MemoryPressure = 1 | 2 | 4;

export const AGENT_NICE = 10;

// The smallest subtree the watchdog may kill: below this, an agent is not what fills memory.
export const WATCHDOG_MIN_BYTES = 1024 ** 3;

const GIB = 1024 ** 3;

type TierRow = { tier: MachineTier; maxGib: number; agents: number; subagents: number; background: boolean; workers: number };

// RAM picks the row. `workers` is the ceiling; half the performance cores can lower it.
const TIERS: readonly TierRow[] = [
  { tier: "minimal", maxGib: 8, agents: 1, subagents: 1, background: false, workers: 1 },
  { tier: "basic", maxGib: 16, agents: 2, subagents: 2, background: false, workers: 2 },
  { tier: "medium", maxGib: 32, agents: 3, subagents: 4, background: true, workers: 2 },
  { tier: "strong", maxGib: 64, agents: 5, subagents: 6, background: true, workers: 4 },
  { tier: "max", maxGib: Infinity, agents: 8, subagents: 8, background: true, workers: 6 },
];

// Installed RAM is a whole number of GiB (48 GiB = 51539607552 bytes); rounding absorbs a
// platform that reports a little less than installed.
function tierRow(ramBytes: number): TierRow {
  const gib = Math.round(ramBytes / GIB);
  return TIERS.find((t) => gib <= t.maxGib) ?? TIERS[TIERS.length - 1];
}

export function machineTier(ramBytes: number): MachineTier {
  return tierRow(ramBytes).tier;
}

export function profileFor(hw: Pick<MachineHardware, "ramBytes" | "perfCores">): ResourceLimits {
  const row = tierRow(hw.ramBytes);
  const coreCap = Math.max(1, Math.floor(hw.perfCores / 2));
  return {
    agents: row.agents,
    subagents: row.subagents,
    background: row.background,
    testWorkers: row.tier === "strong" || row.tier === "max" ? Math.min(row.workers, coreCap) : row.workers,
    lowerPriority: true,
    watchdog: true,
    watchdogAction: "kill",
  };
}

// What the consent popup compares: a different machine (or a RAM upgrade) asks again.
export function hardwareFingerprint(hw: Pick<MachineHardware, "ramBytes" | "cores" | "perfCores">): string {
  return `${hw.ramBytes}:${hw.cores}:${hw.perfCores}`;
}

const MAX_COUNT = 64;

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_COUNT;
}

// Validates an operator patch. Returns the clean patch, or the name of the first bad key.
export function parseLimitsPatch(x: unknown): { ok: true; patch: Partial<ResourceLimits> } | { ok: false; key: string } {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, key: "overrides" };
  const patch: Partial<ResourceLimits> = {};
  for (const [key, value] of Object.entries(x)) {
    switch (key) {
      case "agents":
      case "subagents":
      case "testWorkers":
        if (!isCount(value)) return { ok: false, key };
        patch[key] = value;
        break;
      case "background":
      case "lowerPriority":
      case "watchdog":
        if (typeof value !== "boolean") return { ok: false, key };
        patch[key] = value;
        break;
      case "watchdogAction":
        if (value !== "kill" && value !== "notify") return { ok: false, key };
        patch[key] = value;
        break;
      default:
        return { ok: false, key };
    }
  }
  return { ok: true, patch };
}

// Where an in-agent limit is overridden by the operator's own config (decision 10): the file
// and the value it sets.
export type LimitOverride = { source: string; value: string };

export type MachineResources = {
  hardware: MachineHardware;
  tier: MachineTier;
  profile: ResourceLimits;
  overrides: Partial<ResourceLimits>;
  effective: ResourceLimits;
  decision: ResourceDecision | null;
  // The consent popup is due: no decision on this machine, or the hardware changed since it.
  askConsent: boolean;
  // Current pressure, or null where the platform does not expose it.
  pressure: MemoryPressure | null;
  watchdogSupported: boolean;
  overriddenBy: { subagents?: LimitOverride[]; background?: LimitOverride[] };
  // Agent slots in use and sessions waiting for one.
  running: number;
  waiting: number;
};

export type ResourcesUpdate = {
  decision?: ResourceDecision;
  // `null` clears every override (back to the profile).
  overrides?: Partial<ResourceLimits> | null;
};

// A watchdog finding pushed to the UI as `machine_alert`. Without `sessionId` the pressure is
// not coming from an agent command.
export type MachineAlert = {
  id: string;
  level: "warn" | "critical";
  sessionId?: string;
  sessionName?: string;
  command?: string;
  pid?: number;
  rssBytes?: number;
  // The watchdog already killed it (critical + action "kill").
  killed: boolean;
  at: number;
};

// The paragraph every agent's system prompt gets while limits apply. Model-facing, so it is
// English like `agentLanguageDirective`.
export function resourcesPromptParagraph(limits: Pick<ResourceLimits, "testWorkers">, ramBytes: number): string {
  const gib = Math.round(ramBytes / GIB);
  const n = limits.testWorkers;
  return [
    `This machine has ${gib} GB of RAM and is shared with other agents.`,
    `Run test runners with at most ${n} worker${n === 1 ? "" : "s"} (for jest or vitest: --maxWorkers=${n}).`,
    "Never run two test runs at the same time, never use watch mode, and stop any dev server you start once you no longer need it.",
  ].join(" ");
}
