// The memory watchdog (docs/specs/2026-10-21-machine-resource-profile.md, decision 7). macOS
// only, and only while the operator applied the profile. Under memory pressure it looks for the
// heaviest command an agent started after it became ready, warns once per episode, and at
// sustained critical pressure kills that command — never the agent, never what the agent had
// already started when it became ready (MCP servers, workers, the Python kernel).
//
// Blind spot, by construction: a process that detached from its agent (`setsid`, a daemon, a
// parent that became launchd) is in no agent tree, so the watchdog cannot see it.
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Subject } from "rxjs";
import { WATCHDOG_MIN_BYTES, type MachineAlert, type MemoryPressure } from "@kermanych/core";
import { MachineResourcesService } from "./machine-resources.service";

const SAMPLE_MS = 5_000;
const KILL_COOLDOWN_MS = 30_000;
const KILL_GRACE_MS = 3_000;
const PS_TIMEOUT_MS = 5_000;
const COMMAND_CHARS = 120;

export type ProcRow = { pid: number; ppid: number; rssBytes: number; command: string };

// A command an agent started after it became ready: the child of the agent, and everything
// below it.
type Candidate = { sessionId: string; sessionName: string; pid: number; command: string; pids: number[]; rssBytes: number };

type Tracked = {
  sessionName: string;
  pid: number;
  // The agent's descendants when it became ready. Undefined until the snapshot was read (a
  // failed read is retried each sample): without it the watchdog cannot tell this agent's MCP
  // servers from its commands, so the session offers no candidates at all.
  baseline?: Set<number>;
  // Baseline reads started for this entry; only the newest one may land.
  reads: number;
};

function readProcessTable(): Promise<ProcRow[] | undefined> {
  const { promise, resolve } = Promise.withResolvers<ProcRow[] | undefined>();
  execFile("ps", ["-axo", "pid=,ppid=,rss=,command="], { timeout: PS_TIMEOUT_MS, maxBuffer: 1 << 24 }, (err, stdout) => {
    if (err) return resolve(undefined);
    const rows: ProcRow[] = [];
    for (const line of String(stdout).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      // `ps` reports RSS in KiB.
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024, command: m[4] });
    }
    resolve(rows);
  });
  return promise;
}

function childrenByParent(procs: readonly ProcRow[]): Map<number, ProcRow[]> {
  const out = new Map<number, ProcRow[]>();
  for (const p of procs) {
    const list = out.get(p.ppid);
    if (list) list.push(p);
    else out.set(p.ppid, [p]);
  }
  return out;
}

// Every process below `root` (not `root` itself). The visited set guards a table read while
// pids were being reused.
function descendants(root: number, children: Map<number, ProcRow[]>): ProcRow[] {
  const out: ProcRow[] = [];
  const seen = new Set<number>([root]);
  const stack = [root];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const c of children.get(id) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      stack.push(c.pid);
    }
  }
  return out;
}

@Injectable()
export class WatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly alerts = new Subject<MachineAlert>();
  readonly events$ = this.alerts.asObservable();
  private tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;
  // Pressure episode state: an episode starts above level 1 and ends when it returns to 1.
  private warned = false;
  // Consecutive level-4 samples; the second one acts.
  private criticalRun = 0;
  // The "nothing of ours to kill" notice, once per critical run.
  private criticalNotified = false;
  private lastKillAt = -Infinity;

  // Seams, so the tests drive time, the process table, pressure and signals.
  now = (): number => Date.now();
  readPs = (): Promise<ProcRow[] | undefined> => readProcessTable();
  readPressure = (): Promise<MemoryPressure | null> => this.resources.pressure();
  // false when the process is gone (or not ours); signal 0 probes liveness.
  signal = (pid: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  later = (fn: () => void, ms: number): void => {
    setTimeout(fn, ms).unref();
  };

  constructor(private resources: MachineResourcesService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
    // The interval must not keep a shutting-down api alive.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Called again for the same child once it is really initialised (claude after its system
  // init, a native TUI after its first hook): the MCP servers it started by then join the
  // baseline. The previous baseline stays in force until the new one is read. A new pid is a
  // new child, so its entry replaces the old one.
  track(sessionId: string, sessionName: string, pid: number): void {
    const cur = this.tracked.get(sessionId);
    const entry: Tracked = cur?.pid === pid ? cur : { sessionName, pid, reads: 0 };
    entry.sessionName = sessionName;
    this.tracked.set(sessionId, entry);
    void this.takeBaseline(sessionId, entry);
  }

  // Only the latest read for the latest entry lands: an older `ps` that finishes after a newer
  // one would put back a baseline missing the processes the newer one saw.
  private async takeBaseline(sessionId: string, entry: Tracked): Promise<void> {
    const read = ++entry.reads;
    const procs = await this.readPs();
    if (procs && this.tracked.get(sessionId) === entry && entry.reads === read) {
      entry.baseline = new Set(descendants(entry.pid, childrenByParent(procs)).map((p) => p.pid));
    }
  }

  untrack(sessionId: string): void {
    this.tracked.delete(sessionId);
  }

  // The operator just switched lower priority on: running agents and whatever they already
  // started get it now, not only on their next spawn. `renice` itself checks the setting.
  reniceTracked(): void {
    void this.readPs().then((procs) => {
      const children = procs ? childrenByParent(procs) : new Map<number, ProcRow[]>();
      for (const t of this.tracked.values()) {
        this.resources.renice(t.pid);
        for (const p of descendants(t.pid, children)) this.resources.renice(p.pid);
      }
    });
  }

  // «Зупинити команду» from a warn notice. Re-checked against a fresh table: the pid must still
  // be a candidate of that session, so a stale notice cannot kill a reused pid or an MCP server.
  // The kill is announced like the watchdog's own, so the agent learns why its command died.
  async kill(sessionId: string, pid: number): Promise<boolean> {
    const procs = await this.readPs();
    if (!procs) return false;
    const target = this.candidates(procs).find((c) => c.sessionId === sessionId && c.pid === pid);
    if (!target) return false;
    this.terminate(target.pids);
    this.emit("warn", target, true);
    return true;
  }

  // One tick. Public so the tests drive it.
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      await this.sampleOnce();
    } finally {
      this.sampling = false;
    }
  }

  private async sampleOnce(): Promise<void> {
    if (this.resources.hardware().platform !== "darwin") return;
    // A baseline whose `ps` read failed at track time is retried here, late rather than never:
    // until it exists the session offers no candidates. Taken even while the watchdog is off,
    // so switching it on later finds the baseline nearest to the child's start.
    const missing = [...this.tracked.values()].filter((t) => !t.baseline);
    const atRetry = missing.length > 0 ? await this.readPs() : undefined;
    if (atRetry) {
      const children = childrenByParent(atRetry);
      for (const t of missing) {
        // Newer than any read still in flight for this entry, so that one is dropped.
        t.reads += 1;
        t.baseline = new Set(descendants(t.pid, children).map((p) => p.pid));
      }
    }
    const limits = this.resources.active();
    if (!limits?.watchdog) {
      this.endEpisode();
      return;
    }
    const level = await this.readPressure();
    if (level === null) return;
    if (level === 1) {
      this.endEpisode();
      return;
    }
    if (level === 4) this.criticalRun += 1;
    else {
      this.criticalRun = 0;
      this.criticalNotified = false;
    }
    const critical = this.criticalRun >= 2;
    if (this.warned && !critical) return;

    const procs = await this.readPs();
    if (!procs) return;
    const heaviest = this.candidates(procs).reduce<Candidate | undefined>((a, c) => (!a || c.rssBytes > a.rssBytes ? c : a), undefined);
    if (!this.warned) {
      this.warned = true;
      this.emit("warn", heaviest, false);
    }
    if (!critical) return;

    const victim = heaviest && heaviest.rssBytes >= WATCHDOG_MIN_BYTES ? heaviest : undefined;
    if (victim && limits.watchdogAction === "kill") {
      if (this.now() - this.lastKillAt < KILL_COOLDOWN_MS) return;
      this.lastKillAt = this.now();
      this.terminate(victim.pids);
      this.emit("critical", victim, true);
      // The kill was this run's notice; «agents are not the cause» right after it would
      // contradict it while the freed memory is still being reclaimed.
      this.criticalNotified = true;
      return;
    }
    if (this.criticalNotified) return;
    this.criticalNotified = true;
    this.emit("critical", victim, false);
  }

  private endEpisode(): void {
    this.warned = false;
    this.criticalRun = 0;
    this.criticalNotified = false;
  }

  // A child of an agent that is not in its baseline is a command; a baseline process keeps its
  // whole subtree out (an MCP server spawning its own child later is still the MCP server).
  private candidates(procs: readonly ProcRow[]): Candidate[] {
    const children = childrenByParent(procs);
    const out: Candidate[] = [];
    for (const [sessionId, t] of this.tracked) {
      if (!t.baseline) continue;
      for (const root of children.get(t.pid) ?? []) {
        if (t.baseline.has(root.pid)) continue;
        const below = descendants(root.pid, children);
        out.push({
          sessionId,
          sessionName: t.sessionName,
          pid: root.pid,
          command: root.command.slice(0, COMMAND_CHARS),
          pids: [root.pid, ...below.map((p) => p.pid)],
          rssBytes: below.reduce((sum, p) => sum + p.rssBytes, root.rssBytes),
        });
      }
    }
    return out;
  }

  // Every pid, not just the root: a test runner's workers would otherwise outlive it.
  private terminate(pids: readonly number[]): void {
    for (const pid of pids) this.signal(pid, "SIGTERM");
    this.later(() => {
      for (const pid of pids) if (this.signal(pid, 0)) this.signal(pid, "SIGKILL");
    }, KILL_GRACE_MS);
  }

  private emit(level: MachineAlert["level"], c: Candidate | undefined, killed: boolean): void {
    this.alerts.next({
      id: randomUUID(),
      level,
      ...(c && { sessionId: c.sessionId, sessionName: c.sessionName, command: c.command, pid: c.pid, rssBytes: c.rssBytes }),
      killed,
      at: this.now(),
    });
  }
}
