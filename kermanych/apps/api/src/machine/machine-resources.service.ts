// The machine resource profile (docs/specs/2026-10-21-machine-resource-profile.md): what this
// machine is, which limits apply to it, whether the operator agreed, and how those limits reach
// an agent at spawn (omp overlay, claude env, nice, system-prompt paragraph). The table itself
// is the pure `profileFor` in @kermanych/core; this service owns the hardware reads, the
// single-row storage and the operator's own config that outranks the profile (decision 10).
import { Injectable, Logger } from "@nestjs/common";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir, setPriority, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import {
  AGENT_NICE,
  hardwareFingerprint,
  machineTier,
  parseLimitsPatch,
  profileFor,
  resourcesPromptParagraph,
  type LimitOverride,
  type MachineHardware,
  type MachineResources,
  type MemoryPressure,
  type ResourceDecision,
  type ResourceLimits,
  type ResourcesUpdate,
} from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";

// `sysctl` answers from the kernel at once; a wedged one must not hold up api start or a tick.
const SYSCTL_TIMEOUT_MS = 2_000;
// Same bound as the skills overlay's `omp config get`: it reads files, so a slow one is wedged.
const OMP_CONFIG_TIMEOUT_MS = 5_000;
const OMP_CONFIG_MAX_BYTES = 1 << 16;
// The settings pane re-reads the snapshot while open (for the pressure level), and each omp
// read of the machine-wide config is a ~0.5 s process. The operator's files change rarely.
const OVERRIDES_TTL_MS = 10_000;

// The omp settings the per-session overlay sets, and the profile value each one carries.
const OMP_KEYS = {
  "task.maxConcurrency": "subagents",
  "bash.autoBackground.enabled": "background",
} as const satisfies Record<string, keyof ResourceLimits>;
type OmpKey = keyof typeof OMP_KEYS;
type OmpValues = Record<OmpKey, unknown>;

// The claude variables Kermanych sets, by the limit they carry. A settings `env` entry replaces
// the process environment, so any value there wins over Kermanych's.
const CLAUDE_KEYS = {
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "subagents",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "background",
} as const satisfies Record<string, keyof ResourceLimits>;

const OMP_GLOBAL_LABEL = "~/.omp/agent/config.yml";
const CLAUDE_USER_LABEL = "~/.claude/settings.json";
const CLAUDE_MANAGED_PATH =
  process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";

// Per-session omp overlays live beside the skills overlays, under the same test override.
export function resourcesRoot(): string {
  return join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "resources");
}

// Synchronous because `hardware()` is: it runs once at start and on «Визначити заново», and
// `sysctl` returns at once. Intel Macs and other platforms have no performance level, so the
// logical count stands in (the core table halves it for test workers).
function detectHardware(): MachineHardware {
  const cores = availableParallelism();
  let perfCores = cores;
  if (process.platform === "darwin") {
    try {
      const n = Number(
        execFileSync("sysctl", ["-n", "hw.perflevel0.physicalcpu"], {
          encoding: "utf8",
          timeout: SYSCTL_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
      if (Number.isInteger(n) && n > 0 && n <= cores) perfCores = n;
    } catch {
      /* no perflevel on this Mac */
    }
  }
  return { ramBytes: totalmem(), cores, perfCores, platform: process.platform };
}

function readSysctl(name: string): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  execFile("sysctl", ["-n", name], { timeout: SYSCTL_TIMEOUT_MS }, (err, stdout) => resolve(err ? undefined : String(stdout).trim()));
  return promise;
}

// One `omp config get <key> --json` value, or undefined when it could not be read. Never
// rejects: the caller treats an unknown value as "do not overlay this key".
function readOmpConfigValue(key: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  let settled = false;
  const finish = (value: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const child = spawn("omp", ["config", "get", key, "--json"], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(undefined);
  }, OMP_CONFIG_TIMEOUT_MS);
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (b: Buffer) => {
    if (size >= OMP_CONFIG_MAX_BYTES) return;
    size += b.length;
    chunks.push(b);
  });
  child.on("error", () => finish(undefined));
  child.on("close", (code) => {
    if (code !== 0) return finish(undefined);
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      finish(parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : undefined);
    } catch {
      finish(undefined);
    }
  });
  return promise;
}

// The `env` block of a claude settings file; undefined when the file is missing or unreadable.
async function readClaudeSettingsEnv(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const env = parsed && typeof parsed === "object" && "env" in parsed ? parsed.env : undefined;
    if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
    // A JSON object: every key is a string, every value JSON.
    const entries: Record<string, unknown> = { ...env };
    return entries;
  } catch {
    return undefined;
  }
}

// Scalars only, JSON-encoded like the skills overlay: a JSON number or boolean is valid YAML.
function renderLimitsOverlay(values: Partial<Pick<ResourceLimits, "subagents" | "background">>): string {
  let out = "";
  if (values.subagents !== undefined) out += `task:\n  maxConcurrency: ${JSON.stringify(values.subagents)}\n`;
  if (values.background !== undefined) out += `bash:\n  autoBackground:\n    enabled: ${JSON.stringify(values.background)}\n`;
  return out;
}

// A row written by another version may carry keys or values this one does not accept; each
// valid key survives on its own instead of the whole set being lost.
function parseOverrides(json: string): Partial<ResourceLimits> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<ResourceLimits> = {};
  for (const [key, value] of Object.entries(raw)) {
    const one = parseLimitsPatch({ [key]: value });
    if (one.ok) Object.assign(out, one.patch);
  }
  return out;
}

type Stored = { fingerprint: string; decision: ResourceDecision | null; overrides: Partial<ResourceLimits> };

@Injectable()
export class MachineResourcesService {
  private readonly log = new Logger(MachineResourcesService.name);
  private hw: MachineHardware | undefined;
  private listeners: (() => void)[] = [];
  private ompDefaultsRead: Promise<OmpValues | undefined> | undefined;
  private overridesCache: { at: number; value: Promise<MachineResources["overriddenBy"]> } | undefined;

  // Seams, so the tests never read the real machine or spawn omp.
  detect = (): MachineHardware => detectHardware();
  readSysctl = (name: string): Promise<string | undefined> => readSysctl(name);
  readOmpValue = (key: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<unknown> => readOmpConfigValue(key, cwd, env);
  readClaudeEnv = (path: string): Promise<Record<string, unknown> | undefined> => readClaudeSettingsEnv(path);

  constructor(private registry: RegistryService) {}

  hardware(): MachineHardware {
    return (this.hw ??= this.detect());
  }

  private stored(): Stored | undefined {
    const row = this.registry.getMachineResources();
    return row && { fingerprint: row.fingerprint, decision: row.decision, overrides: parseOverrides(row.overrides) };
  }

  private effective(overrides: Partial<ResourceLimits>): ResourceLimits {
    return { ...profileFor(this.hardware()), ...overrides };
  }

  // A hardware change after `applied` keeps limiting (with the new machine's profile) while the
  // popup asks again: the operator agreed to limits, not to one set of numbers.
  active(): ResourceLimits | null {
    const s = this.stored();
    return s?.decision === "applied" ? this.effective(s.overrides) : null;
  }

  async snapshot(slots: { running: number; waiting: number }): Promise<MachineResources> {
    const hardware = this.hardware();
    const profile = profileFor(hardware);
    const s = this.stored();
    const overrides = s?.overrides ?? {};
    const [pressure, overriddenBy] = await Promise.all([this.pressure(), this.overriddenBy()]);
    return {
      hardware,
      tier: machineTier(hardware.ramBytes),
      profile,
      overrides,
      effective: { ...profile, ...overrides },
      decision: s?.decision ?? null,
      askConsent: !s?.decision || s.fingerprint !== hardwareFingerprint(hardware),
      pressure,
      watchdogSupported: hardware.platform === "darwin",
      overriddenBy,
      running: slots.running,
      waiting: slots.waiting,
    };
  }

  // A decision is taken for THIS hardware, so it stamps the current fingerprint; an overrides-only
  // save keeps the old stamp, so a pending popup still shows. Overrides replace the stored set
  // (the settings pane sends all of them); a key equal to the profile is not an override, so a
  // later hardware change still moves it.
  update(u: ResourcesUpdate): void {
    const fingerprint = hardwareFingerprint(this.hardware());
    const cur = this.stored();
    let overrides = cur?.overrides ?? {};
    if (u.overrides === null) overrides = {};
    else if (u.overrides !== undefined) {
      const profile = profileFor(this.hardware());
      overrides = Object.fromEntries(
        Object.entries(u.overrides).filter(([k, v]) => v !== undefined && profile[k as keyof ResourceLimits] !== v),
      ) as Partial<ResourceLimits>;
    }
    this.registry.setMachineResources({
      fingerprint: u.decision ? fingerprint : (cur?.fingerprint ?? fingerprint),
      decision: u.decision ?? cur?.decision ?? null,
      overrides: JSON.stringify(overrides),
    });
    this.changed();
  }

  // «Визначити заново»: fresh hardware, no decision (the popup shows), overrides kept.
  redetect(): void {
    this.hw = this.detect();
    this.overridesCache = undefined;
    const cur = this.stored();
    this.registry.setMachineResources({
      fingerprint: hardwareFingerprint(this.hw),
      decision: null,
      overrides: JSON.stringify(cur?.overrides ?? {}),
    });
    this.changed();
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  // The save is already stored; a subscriber's failure must not turn it into an error response.
  private changed(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        this.log.warn(`resources change listener failed: ${(err as Error).message}`);
      }
    }
  }

  // The per-session `--config` overlay (decision 6) with only the keys the operator left at omp's
  // default in this cwd (decision 10). Any unreadable value leaves its key out: writing it blind
  // could replace the operator's own setting. Never rejects.
  async ompOverlay(cwd: string): Promise<string | undefined> {
    const limits = this.active();
    if (!limits) return undefined;
    try {
      // An unbound project has no repo; reading in the api's own cwd would pick up the
      // Kermanych checkout's project config (the skills overlay's rule).
      const [defaults, current] = await Promise.all([this.ompDefaults(), this.readOmpKeys(cwd || homedir())]);
      if (!defaults) return undefined;
      const values: Partial<Pick<ResourceLimits, "subagents" | "background">> = {};
      for (const key of Object.keys(OMP_KEYS) as OmpKey[]) {
        if (defaults[key] === undefined || current[key] !== defaults[key]) continue;
        const limit = OMP_KEYS[key];
        (values as Record<string, unknown>)[limit] = limits[limit];
      }
      const text = renderLimitsOverlay(values);
      if (!text) return undefined;
      const path = join(resourcesRoot(), `${createHash("sha1").update(cwd).digest("hex")}.config.yml`);
      await mkdir(resourcesRoot(), { recursive: true });
      await writeFile(path, text, "utf8");
      return path;
    } catch (err) {
      this.log.warn(`resources overlay for ${cwd} not written: ${(err as Error).message}`);
      return undefined;
    }
  }

  claudeEnv(): Record<string, string> | undefined {
    const limits = this.active();
    if (!limits) return undefined;
    const env: Record<string, string> = { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(limits.subagents) };
    if (!limits.background) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    return env;
  }

  promptParagraph(): string | undefined {
    const limits = this.active();
    return limits ? resourcesPromptParagraph(limits, this.hardware().ramBytes) : undefined;
  }

  // A process that already exited, or one this user does not own, simply keeps its priority.
  renice(pid: number): void {
    if (!this.active()?.lowerPriority) return;
    try {
      setPriority(pid, AGENT_NICE);
    } catch {
      /* gone or not ours */
    }
  }

  async pressure(): Promise<MemoryPressure | null> {
    if (this.hardware().platform !== "darwin") return null;
    const level = Number(await this.readSysctl("kern.memorystatus_vm_pressure_level"));
    return level === 1 || level === 2 || level === 4 ? level : null;
  }

  private async readOmpKeys(cwd: string, env?: NodeJS.ProcessEnv): Promise<OmpValues> {
    const keys = Object.keys(OMP_KEYS) as OmpKey[];
    const values = await Promise.all(keys.map((k) => this.readOmpValue(k, cwd, env)));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as OmpValues;
  }

  // omp's own defaults: the same command with no global layer (an empty agent dir) and no
  // project layer (an empty cwd). Once per process; a failed read is retried next time.
  private ompDefaults(): Promise<OmpValues | undefined> {
    this.ompDefaultsRead ??= this.readOmpDefaults().then((v) => {
      if (!v) this.ompDefaultsRead = undefined;
      return v;
    });
    return this.ompDefaultsRead;
  }

  private async readOmpDefaults(): Promise<OmpValues | undefined> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "kermanych-omp-defaults-"));
      // A profile or an explicit config-file list would bring the operator's config back in.
      const { OMP_PROFILE: _omp, PI_PROFILE: _pi, PI_CONFIG_FILES: _files, ...env } = process.env;
      const values = await this.readOmpKeys(dir, { ...env, PI_CODING_AGENT_DIR: join(dir, "agent") });
      return Object.values(values).some((v) => v === undefined) ? undefined : values;
    } catch {
      return undefined;
    } finally {
      // omp creates its agent database in the empty agent dir.
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private overriddenBy(): Promise<MachineResources["overriddenBy"]> {
    const now = Date.now();
    if (!this.overridesCache || now - this.overridesCache.at >= OVERRIDES_TTL_MS) {
      this.overridesCache = { at: now, value: this.readOverriddenBy() };
    }
    return this.overridesCache.value;
  }

  // The machine-wide sources only (decision 10, «Display»): the omp global layer read with no
  // project (cwd = home), and the claude user and managed settings files.
  private async readOverriddenBy(): Promise<MachineResources["overriddenBy"]> {
    const out: MachineResources["overriddenBy"] = {};
    const add = (limit: "subagents" | "background", o: LimitOverride): void => {
      (out[limit] ??= []).push(o);
    };
    const [defaults, global, user, managed] = await Promise.all([
      this.ompDefaults(),
      this.readOmpKeys(homedir()),
      this.readClaudeEnv(join(homedir(), ".claude", "settings.json")),
      this.readClaudeEnv(CLAUDE_MANAGED_PATH),
    ]);
    if (defaults) {
      for (const key of Object.keys(OMP_KEYS) as OmpKey[]) {
        const v = global[key];
        if (v !== undefined && v !== defaults[key]) add(OMP_KEYS[key], { source: OMP_GLOBAL_LABEL, value: `${key} = ${String(v)}` });
      }
    }
    for (const [env, source] of [
      [user, CLAUDE_USER_LABEL],
      [managed, CLAUDE_MANAGED_PATH],
    ] as const) {
      if (!env) continue;
      for (const name of Object.keys(CLAUDE_KEYS) as (keyof typeof CLAUDE_KEYS)[]) {
        if (env[name] !== undefined) add(CLAUDE_KEYS[name], { source, value: `${name} = ${String(env[name])}` });
      }
    }
    return out;
  }
}
