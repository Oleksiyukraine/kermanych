// apps/api/src/preview/preview.service.ts
// The live preview of a session (docs/specs/2026-11-03-session-browser-preview.md): run the
// branch's app from the session directory, as its own `.kermanych/preview.json` says, so the
// operator and the agent see the work in progress in the session browser.
//
// The api owns the state (decision 7). A record exists from the moment a start begins, so a
// second start while one is in flight returns the current state; every change goes out on
// `changes$`, which the supervisor relays to the UI as `preview_update` and folds into its
// snapshot. Nothing restarts by itself: a crash stops the rest and stays red until the next start.
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Observable, Subject } from "rxjs";
import {
  PREVIEW_CONFIG_PATH,
  PREVIEW_DIR_VAR,
  PREVIEW_SETUP_STEP,
  expandPreviewEnv,
  parsePreviewConfig,
  platformHasBrowser,
  previewPortVar,
  type PreviewConfig,
  type PreviewConfigStatus,
  type PreviewInfo,
  type PreviewLogLine,
  type PreviewLogs,
  type PreviewPort,
  type PreviewState,
} from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { browserHost } from "../browser/browser-host";

// The waits of decision 3 and the stop of decision 7. Mutable so specs can shorten them; the
// api never changes them.
export type PreviewOptions = {
  // `$TMPDIR/kermanych-preview`: one `PREVIEW_DIR` per session below it.
  root: string;
  setupMs: number;
  readyMs: number;
  // SIGTERM → SIGKILL on a stop.
  killGraceMs: number;
  // The same on api shutdown, shorter: the desktop app awaits it on quit.
  shutdownGraceMs: number;
  // How often a service's port is tried while it starts.
  pollMs: number;
};

export type PreviewChange = { sessionId: string; state: PreviewState | null };

// Lines kept per step (decision 7), and how many end a `failed` error.
const LOG_LINES = 2000;
const ERROR_TAIL_LINES = 10;

// Colours and cursor moves of dev servers' output: CSI, OSC, and the two-byte escapes.
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// The page a dev server says it serves; it may ignore PORT (decision 3, readiness).
const BANNER_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g;

type Proc = {
  step: string;
  child: ChildProcess;
  exited: Promise<void>;
  done: boolean;
  // Why it ended, for a `failed` error: "exited with code 1", "could not start: …".
  reason: string;
  code: number | null;
  signal: string | null;
  // Ports its output announced (the `open` service only).
  banner: Set<number> | null;
};

type Run = {
  run: number;
  projectId: string;
  state: PreviewState;
  procs: Proc[];
  // Insertion order is start order: the logs panel's tabs.
  logs: Map<string, PreviewLogLine[]>;
  // Set once Kermanych stops it (◼, restart, crash of a sibling, shutdown): exits are ours then.
  halted: boolean;
  // Rejects the start in flight: a step exited or the run was halted.
  abort: (err: Error) => void;
  aborted: Promise<never>;
  // The halt in progress or done: halt runs once per run.
  stopped?: Promise<void>;
};

// A start that did not get to running, at `step`.
class StepFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class PreviewService implements OnModuleInit, OnModuleDestroy {
  readonly opts: PreviewOptions = {
    root: join(tmpdir(), "kermanych-preview"),
    setupMs: 20 * 60_000,
    readyMs: 5 * 60_000,
    killGraceMs: 5_000,
    shutdownGraceMs: 2_000,
    pollMs: 250,
  };
  private runs = new Map<string, Run>();
  private runCounter = 0;
  // Log cursor: grows for the life of the api, across sessions and runs.
  private seq = 0;
  private changes = new Subject<PreviewChange>();
  readonly changes$: Observable<PreviewChange> = this.changes.asObservable();

  constructor(private registry: RegistryService) {}

  // Orphans: a session deleted while the api was down, and the `<id>.sqlite` files of the old
  // preview. The directory is shared by every Kermanych on the machine, so only the api on the
  // machine's own registry sweeps it: one on a custom `KERMANYCH_DB` (preview mode, Kermanych
  // previewing itself, a test) knows none of the real sessions and would delete their running
  // previews' directories.
  onModuleInit(): void {
    if (process.env.KERMANYCH_DB) return;
    void this.sweep().catch((err: unknown) => console.warn(`[preview] sweep of ${this.opts.root} failed: ${(err as Error).message}`));
  }

  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.opts.root);
    } catch {
      return;
    }
    const ids = new Set(this.registry.listSessions().map((s) => s.id));
    for (const name of names) {
      if (ids.has(name.replace(/\.sqlite$/, ""))) continue;
      await rm(join(this.opts.root, name), { recursive: true, force: true });
    }
  }

  // Leaves no child behind on quit: SIGTERM, then SIGKILL after a short grace.
  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.runs.values()].map((r) => this.halt(r, this.opts.shutdownGraceMs)));
  }

  state(id: string): PreviewState | null {
    return this.runs.get(id)?.state ?? null;
  }

  states(): Record<string, PreviewState> {
    return Object.fromEntries([...this.runs].map(([id, r]) => [id, r.state]));
  }

  urlOf(id: string): string | undefined {
    const s = this.state(id);
    return s?.phase === "running" ? s.url : undefined;
  }

  // GET /sessions/:id/preview: the file is read again on every call, so an agent's edit shows.
  info(id: string): PreviewInfo {
    const { dir } = this.resolve(id);
    return { state: this.state(id), config: readConfig(dir).status };
  }

  // Returns at once (normally `starting`); the run goes on in the background.
  start(id: string, opts: { restart?: boolean } = {}): PreviewState {
    const { projectId, dir } = this.resolve(id);
    const read = readConfig(dir);
    if (read.status.kind === "missing") throw new Error(`${PREVIEW_CONFIG_PATH} is missing in the session directory`);
    if (read.status.kind === "invalid") throw new Error(`${PREVIEW_CONFIG_PATH} is invalid: ${read.status.error}`);
    const config = read.config!;
    const cur = this.runs.get(id);
    if (cur && !cur.halted && (cur.state.phase === "starting" || cur.state.phase === "running") && !opts.restart) return cur.state;
    // A restart waits for the old processes: they share PREVIEW_DIR (its database, say).
    const previous = cur ? this.halt(cur) : Promise.resolve();
    const { promise: aborted, reject: abort } = Promise.withResolvers<never>();
    aborted.catch(() => {});
    const run: Run = {
      run: ++this.runCounter,
      projectId,
      state: { phase: "starting", step: config.setup ? PREVIEW_SETUP_STEP : config.services[0]!.name, services: [] },
      procs: [],
      logs: new Map(),
      halted: false,
      abort,
      aborted,
    };
    this.runs.set(id, run);
    this.publish(id, run.state);
    void this.execute(id, run, config, dir, previous);
    return run.state;
  }

  // ◼. A crashed or failed preview keeps its state: nothing of it runs any more.
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    const phase = run.state.phase;
    const done = this.halt(run);
    if (phase === "starting" || phase === "running") this.update(id, run, { phase: "stopped" });
    await done;
  }

  // The session was finished: its worktree is about to go, and PREVIEW_DIR with it.
  async retire(id: string): Promise<void> {
    await this.stop(id);
    await rm(join(this.opts.root, id), { recursive: true, force: true }).catch(() => {});
  }

  // The session was deleted: nothing of its preview is left, the UI is told `null`.
  async forget(id: string): Promise<void> {
    await this.retire(id);
    if (this.runs.delete(id)) this.publish(id, null);
  }

  // The project became back-end or mobile (decision 9): its previews stop.
  async stopProject(projectId: string): Promise<void> {
    await Promise.all([...this.runs].filter(([, r]) => r.projectId === projectId).map(([id]) => this.stop(id)));
  }

  // Resolves once the preview is no longer starting, or after `ms` with whatever it is then.
  settled(id: string, ms: number): Promise<PreviewState | null> {
    const cur = this.state(id);
    if (cur?.phase !== "starting" || ms <= 0) return Promise.resolve(cur);
    const { promise, resolve } = Promise.withResolvers<PreviewState | null>();
    const sub = this.changes$.subscribe((e) => {
      if (e.sessionId !== id || e.state?.phase === "starting") return;
      clearTimeout(timer);
      sub.unsubscribe();
      resolve(e.state);
    });
    const timer = setTimeout(() => {
      sub.unsubscribe();
      resolve(this.state(id));
    }, ms);
    return promise;
  }

  // GET /sessions/:id/preview/logs: `step`'s lines after `since`.
  logs(id: string, step: string, since: number): PreviewLogs {
    const run = this.runs.get(id);
    if (!run) return { run: 0, steps: [], lines: [], next: since };
    const lines = (run.logs.get(step) ?? []).filter((l) => l.seq > since);
    return { run: run.run, steps: [...run.logs.keys()], lines, next: lines.length ? lines[lines.length - 1]!.seq : since };
  }

  // The last `n` lines of `step`, for the agent's tools.
  tail(id: string, step: string, n: number): string[] {
    return (this.runs.get(id)?.logs.get(step) ?? []).slice(-n).map((l) => l.text);
  }

  steps(id: string): string[] {
    return [...(this.runs.get(id)?.logs.keys() ?? [])];
  }

  // Decisions 2 and 8: only an agent session, of a project with a browser, with a directory.
  private resolve(id: string): { projectId: string; dir: string } {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    if (s.kind !== "agent") throw new Error(`only agent sessions have a live preview (this is a ${s.kind})`);
    const project = this.registry.listProjects().find((p) => p.id === s.projectId);
    if (!project) throw new Error("project not found");
    if (!platformHasBrowser(project.platform)) throw new Error(`a ${project.platform} project has no live preview`);
    if (s.worktree && !s.worktreePath) throw new Error("this session is finished: it has no worktree to preview");
    const dir = s.worktreePath || project.localRepoPath;
    if (!dir) throw new Error("project not bound");
    return { projectId: s.projectId, dir };
  }

  private publish(id: string, state: PreviewState | null): void {
    this.changes.next({ sessionId: id, state });
  }

  // Only the session's current run speaks: a replaced one is silent.
  private update(id: string, run: Run, state: PreviewState): void {
    if (this.runs.get(id) !== run) return;
    run.state = state;
    this.publish(id, state);
  }

  private async execute(id: string, run: Run, config: PreviewConfig, dir: string, previous: Promise<void>): Promise<void> {
    let step = run.state.phase === "starting" ? run.state.step : "";
    try {
      await previous;
      const ports = await freePorts(config.services.length);
      if (run.halted) return;
      const services: PreviewPort[] = config.services.map((svc, i) => ({ name: svc.name, port: ports[i]! }));
      const previewDir = join(this.opts.root, id);
      await mkdir(previewDir, { recursive: true });
      if (run.halted) return;
      const vars: Record<string, string> = { [PREVIEW_DIR_VAR]: previewDir };
      for (const p of services) vars[previewPortVar(p.name)] = String(p.port);

      if (config.setup) {
        step = PREVIEW_SETUP_STEP;
        this.update(id, run, { phase: "starting", step, services });
        const proc = this.spawnStep(run, step, config.setup, dir, vars, false);
        await this.waitSetup(run, proc);
      }
      let url = "";
      for (const [i, svc] of config.services.entries()) {
        if (run.halted) return;
        step = svc.name;
        this.update(id, run, { phase: "starting", step, services });
        const own: Record<string, string> = { ...vars, PORT: String(ports[i]) };
        const env: Record<string, string> = { ...own };
        for (const [k, v] of Object.entries(svc.env)) env[k] = expandPreviewEnv(v, own);
        const proc = this.spawnStep(run, step, svc.command, dir, env, svc.open, id);
        const port = await this.waitReady(run, proc, ports[i]!);
        if (svc.open) url = `http://localhost:${port}`;
      }
      if (run.halted) return;
      this.update(id, run, { phase: "running", url, services });
      // The session page goes to the preview (decision 6). A standalone api has no host.
      const host = browserHost();
      if (host)
        void Promise.resolve()
          .then(() => host.openPreview({ sessionId: id, projectId: run.projectId }, url))
          .catch((err: unknown) => console.warn(`[preview] could not open ${url} for session ${id}: ${(err as Error).message}`));
    } catch (err) {
      if (run.halted) return; // stopped mid-start: not a failure
      const failed = err instanceof StepFailure ? err.step : step;
      const reason = (err as Error)?.message ?? String(err);
      const tail = (run.logs.get(failed) ?? []).slice(-ERROR_TAIL_LINES).map((l) => l.text);
      void this.halt(run);
      this.update(id, run, { phase: "failed", step: failed, error: tail.length ? `${reason}\n${tail.join("\n")}` : reason });
    }
  }

  // `setup` must exit 0 in time.
  private async waitSetup(run: Run, proc: Proc): Promise<void> {
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new StepFailure(proc.step, `did not finish within ${minutes(this.opts.setupMs)}`)), this.opts.setupMs);
    try {
      await Promise.race([proc.exited, run.aborted, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (proc.code !== 0) throw new StepFailure(proc.step, proc.reason);
  }

  // A service is ready when its PORT accepts; the `open` one also when a port its output
  // announced accepts. Resolves with the port that did.
  private async waitReady(run: Run, proc: Proc, port: number): Promise<number> {
    const deadline = Date.now() + this.opts.readyMs;
    for (;;) {
      if (await accepts(port)) return port;
      for (const p of proc.banner ?? []) if (p !== port && (await accepts(p))) return p;
      if (Date.now() > deadline)
        throw new StepFailure(proc.step, `not ready within ${minutes(this.opts.readyMs)}: nothing accepted a connection on port ${port}`);
      await Promise.race([sleep(this.opts.pollMs), run.aborted]);
    }
  }

  // `detached`: each step leads its own process group, so a stop reaches the whole tree
  // (sh → pnpm → vite), not just the shell. `sessionId` is given for a service, whose exit
  // after ready is a crash.
  private spawnStep(run: Run, step: string, command: string, cwd: string, env: Record<string, string>, open: boolean, sessionId?: string): Proc {
    run.logs.set(step, []);
    const child = spawn("sh", ["-c", command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    const proc: Proc = { step, child, exited, done: false, reason: "", code: null, signal: null, banner: open ? new Set() : null };
    run.procs.push(proc);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      let partial = "";
      stream.on("data", (chunk: string) => {
        const parts = (partial + chunk).split(/\r\n|\n|\r/);
        partial = parts.pop() ?? "";
        for (const line of parts) this.logLine(run, proc, line);
      });
      stream.on("end", () => {
        if (partial) this.logLine(run, proc, partial);
        partial = "";
      });
    }
    const end = (code: number | null, signal: string | null, reason: string) => {
      if (proc.done) return;
      proc.done = true;
      proc.code = code;
      proc.signal = signal;
      proc.reason = reason;
      resolve();
      if (run.halted) return;
      if (sessionId === undefined) return; // setup: waitSetup reads the code
      if (run.state.phase === "running") {
        void this.halt(run);
        this.update(sessionId, run, { phase: "crashed", step, code, signal });
      } else run.abort(new StepFailure(step, `${reason} before the preview was running`));
    };
    child.once("error", (err) => end(null, null, `could not start: ${err.message}`));
    // The last output may still be in the pipes at `exit`: wait for `close`, but not on a
    // grandchild that keeps them open.
    child.once("exit", (code, signal) => {
      const settle = () => end(code, signal, code !== null ? `exited with code ${code}` : `was killed by ${signal}`);
      const t = setTimeout(settle, 200);
      child.once("close", () => {
        clearTimeout(t);
        settle();
      });
    });
    return proc;
  }

  private logLine(run: Run, proc: Proc, raw: string): void {
    const text = raw.replace(ANSI_RE, "");
    const lines = run.logs.get(proc.step);
    if (!lines) return;
    lines.push({ seq: ++this.seq, text });
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
    if (proc.banner) for (const m of text.matchAll(BANNER_RE)) proc.banner.add(Number(m[1]));
  }

  // Every step's group: SIGTERM, then SIGKILL after the grace. Resolves when all have exited.
  // Once per run: a later call (shutdown after a crash) must not signal process groups whose
  // ids the system may have handed out again.
  private halt(run: Run, graceMs = this.opts.killGraceMs): Promise<void> {
    if (run.stopped) return run.stopped;
    run.halted = true;
    run.abort(new Error("stopped"));
    run.stopped = Promise.all(run.procs.map((p) => stopProc(p, graceMs))).then(() => {});
    return run.stopped;
  }
}

type ConfigRead = { status: PreviewConfigStatus; config?: PreviewConfig };

function readConfig(dir: string): ConfigRead {
  let text: string;
  try {
    text = readFileSync(join(dir, PREVIEW_CONFIG_PATH), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: { kind: "missing" } };
    return { status: { kind: "invalid", error: `cannot read the file: ${(err as Error).message}` } };
  }
  const parsed = parsePreviewConfig(text);
  if (!parsed.ok) return { status: { kind: "invalid", error: parsed.error } };
  return { status: { kind: "ok", services: parsed.config.services.map((s) => s.name) }, config: parsed.config };
}

// `signal` 0 only asks whether any member of the group is left.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal); // negative pid → the whole process group
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The whole group, not only its leader: `sh` may die of the SIGTERM while the dev server under
// it ignores it, and an exited leader may leave workers behind.
async function stopProc(p: Proc, graceMs: number): Promise<void> {
  signalGroup(p.child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (signalGroup(p.child, 0) && Date.now() < deadline) await sleep(50);
  signalGroup(p.child, "SIGKILL");
  if (!p.done) await p.exited;
}

// Distinct free ports, one per service, all known before anything starts (`PORT_<NAME>` goes to
// every step).
async function freePorts(n: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < n) ports.add(await freePort());
  return [...ports];
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    srv.close(() => resolve(port));
  });
  return promise;
}

// IPv4 first, then IPv6: a dev server bound to `localhost` may listen on ::1 only.
async function accepts(port: number): Promise<boolean> {
  return (await acceptsOn(port, "127.0.0.1")) || (await acceptsOn(port, "::1"));
}

function acceptsOn(port: number, host: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const sock = connect({ port, host });
  const done = (ok: boolean) => {
    sock.destroy();
    resolve(ok);
  };
  sock.setTimeout(1000, () => done(false));
  sock.once("connect", () => done(true));
  sock.once("error", () => done(false));
  return promise;
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}
