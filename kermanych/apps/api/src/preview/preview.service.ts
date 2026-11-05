// apps/api/src/preview/preview.service.ts
// The live preview of a session (docs/specs/2026-11-03-session-browser-preview.md): run the
// branch's app from the session directory, as its own `.kermanych/preview.json` says, so the
// operator and the agent see the work in progress in the session browser.
//
// The api owns the state (decision 7). A record exists from the moment a start begins, so a
// second start while one is in flight returns the current state; every change goes out on
// `changes$`, which the supervisor relays to the UI as `preview_update` and folds into its
// snapshot. Nothing restarts by itself: a crash stops the rest and stays red until the next start.
//
// A Mobile project's file has a `device` block (docs/specs/2026-11-03-mobile-device-preview.md):
// the run boots the session's device first (step `device`), then `setup`, the services and the
// platform's `install`, launches the app and follows it. The device itself is DeviceApi's; this
// service decides when it boots, shuts down and goes (decision 11).
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
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
  PREVIEW_DEVICE_STEP,
  PREVIEW_DIR_VAR,
  PREVIEW_INSTALL_STEP,
  PREVIEW_SETUP_STEP,
  expandPreviewEnv,
  parsePreviewConfig,
  platformHasBrowser,
  platformHasDevice,
  platformHasPreview,
  previewPlatforms,
  previewPortVar,
  type DeviceBase,
  type DevicePlatform,
  type DeviceRuntime,
  type Platform,
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
import { DEVICE_API, type DeviceApi } from "../device/device.contract";

// The waits of decision 3 and the stop of decision 7. Mutable so specs can shorten them; the
// api never changes them.
export type PreviewOptions = {
  // `$TMPDIR/kermanych-preview`: one `PREVIEW_DIR` per session below it.
  root: string;
  // `setup`, and a device's `install` (mobile decision 5: it must exit 0 within 20 min).
  setupMs: number;
  readyMs: number;
  // A `"device": true` service is ready once the app runs: a first native build is slow (mobile
  // decision 5).
  appReadyMs: number;
  // The app Kermanych launched itself must run within this.
  launchMs: number;
  // How often the app's liveness is checked while running (mobile decision 11).
  appPollMs: number;
  // SIGTERM → SIGKILL on a stop.
  killGraceMs: number;
  // The same on api shutdown, shorter: the desktop app awaits it on quit.
  shutdownGraceMs: number;
  // How often a service's port (or a device service's app) is tried while it starts.
  pollMs: number;
};

export type PreviewChange = { sessionId: string; state: PreviewState | null };

// POST /sessions/:id/preview/app and the agent's device_app.
export type PreviewAppAction = "launch" | "terminate" | "restart";

// `clean`: the app's data is cleared after the device boots, before anything installs or starts
// it — a «Тестувальник» run's clean start (docs/specs/2026-11-04-tester-mobile-device.md,
// decision 1). Meaningless without a device.
export type PreviewStartOptions = { restart?: boolean; platform?: DevicePlatform; base?: string; clean?: boolean };

// Lines kept per step (decision 7), and how many end a `failed` error.
const LOG_LINES = 2000;
const ERROR_TAIL_LINES = 10;
// How long an app action waits for the app to show the expected liveness.
const APP_ACTION_MS = 10_000;

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
  id: string;
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
  // The file has a `device` block: the run owns the session's device (mobile decision 11).
  mobile: boolean;
  // Hands a halt to the device's boot in flight.
  ctrl: AbortController;
  // Known once the device step has picked them.
  platform?: DevicePlatform;
  base?: string;
  app?: string;
  runtime?: DeviceRuntime;
  stopAppLogs?: () => void;
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
    appReadyMs: 20 * 60_000,
    launchMs: 60_000,
    appPollMs: 1_000,
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

  constructor(
    private registry: RegistryService,
    @Inject(DEVICE_API) private device: DeviceApi,
  ) {
    // The simulator or emulator went away by itself: «впало: device» (mobile decision 11).
    this.device.exits$.subscribe(({ sessionId, reason }) => this.deviceExited(sessionId, reason));
  }

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

  // Leaves no child behind on quit: SIGTERM, then SIGKILL after a short grace. Devices shut
  // down; their clones stay (mobile decision 11, «Kermanych quits»).
  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.runs.values()].map((r) => this.halt(r, this.opts.shutdownGraceMs)));
  }

  state(id: string): PreviewState | null {
    return this.runs.get(id)?.state ?? null;
  }

  states(): Record<string, PreviewState> {
    return Object.fromEntries([...this.runs].map(([id, r]) => [id, r.state]));
  }

  // The page of a running web preview; a device preview has none.
  urlOf(id: string): string | undefined {
    const s = this.state(id);
    return s?.phase === "running" ? (s.url ?? undefined) : undefined;
  }

  // GET /sessions/:id/preview: the file is read again on every call, so an agent's edit shows.
  info(id: string): PreviewInfo {
    const { dir, platform } = this.resolve(id);
    return { state: this.state(id), config: readConfig(dir, platform).status };
  }

  // The directory the preview runs from, refused with the preview's own messages (not an agent
  // session, a project without a preview, a finished session). The session's «Змінні» edit its
  // `.env` (docs/specs/2026-11-04-session-env-and-tester-preview-gate.md, decision 2).
  dirOf(id: string): string {
    return this.resolve(id).dir;
  }

  // The platforms the session's file configures, for the device row (GET /sessions/:id/device):
  // empty when the session has no preview or its file is missing, invalid or not a device one.
  platformsOf(id: string): DevicePlatform[] {
    try {
      const { dir, platform } = this.resolve(id);
      const status = readConfig(dir, platform).status;
      return status.kind === "ok" ? status.platforms : [];
    } catch {
      return [];
    }
  }

  // Returns at once (normally `starting`); the run goes on in the background. `platform` and
  // `base` (a base device id) pick the device explicitly: the choice becomes the project's
  // default, and a different base re-clones (mobile decision 6), which acts as a restart.
  start(id: string, opts: PreviewStartOptions = {}): PreviewState {
    const { projectId, dir, platform } = this.resolve(id);
    const read = readConfig(dir, platform);
    if (read.status.kind === "missing") throw new Error(`${PREVIEW_CONFIG_PATH} is missing in the session directory`);
    if (read.status.kind === "invalid") throw new Error(`${PREVIEW_CONFIG_PATH} is invalid: ${read.status.error}`);
    const config = read.config!;
    const platforms = previewPlatforms(config);
    if ((opts.platform || opts.base) && !config.device) throw new Error("a platform or a base device is only for a preview with a device");
    if (opts.platform && !platforms.includes(opts.platform))
      throw new Error(`the "device" block of ${PREVIEW_CONFIG_PATH} has no ${opts.platform} app (it has: ${platforms.join(", ")})`);
    const cur = this.runs.get(id);
    const switching = !!cur && ((!!opts.platform && opts.platform !== cur.platform) || (!!opts.base && opts.base !== cur.base));
    if (cur && !cur.halted && (cur.state.phase === "starting" || cur.state.phase === "running") && !opts.restart && !switching) return cur.state;
    // A restart waits for the old processes: they share PREVIEW_DIR (its database, say). ↻
    // keeps the device running (mobile decision 11) unless the file no longer has one.
    const previous = cur ? this.halt(cur, this.opts.killGraceMs, !!config.device) : Promise.resolve();
    const { promise: aborted, reject: abort } = Promise.withResolvers<never>();
    aborted.catch(() => {});
    const first = config.device ? PREVIEW_DEVICE_STEP : config.setup ? PREVIEW_SETUP_STEP : config.services[0]!.name;
    const run: Run = {
      id,
      run: ++this.runCounter,
      projectId,
      state: { phase: "starting", step: first, services: [] },
      procs: [],
      logs: new Map(),
      halted: false,
      abort,
      aborted,
      mobile: !!config.device,
      ctrl: new AbortController(),
    };
    this.runs.set(id, run);
    this.publish(id, run.state);
    void this.execute(id, run, config, dir, previous, opts);
    return run.state;
  }

  // ◼. A crashed or failed preview keeps its state: nothing of it runs any more. The device
  // shuts down and keeps its clone (mobile decision 11).
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    const phase = run.state.phase;
    const done = this.halt(run);
    if (phase === "starting" || phase === "running") this.update(id, run, { phase: "stopped" });
    await done;
  }

  // The session was finished: its worktree is about to go, and PREVIEW_DIR with it. Its
  // device's clone goes too (mobile decision 4), even when no run of this api booted it: the
  // clone may be from an earlier one.
  async retire(id: string): Promise<void> {
    await this.stop(id);
    await this.device.remove(id).catch((err: unknown) => console.warn(`[preview] could not remove the device of session ${id}: ${(err as Error).message}`));
    await rm(join(this.opts.root, id), { recursive: true, force: true }).catch(() => {});
  }

  // The session was deleted: nothing of its preview is left, the UI is told `null`.
  async forget(id: string): Promise<void> {
    await this.retire(id);
    if (this.runs.delete(id)) this.publish(id, null);
  }

  // The project's platform changed (decision 9; mobile decision 8): a run whose kind no longer
  // fits stops — a web preview on a back-end or Mobile project, a device on a non-Mobile one.
  async stopUnfit(projectId: string, platform: Platform | null | undefined): Promise<void> {
    const unfit = (r: Run) => r.projectId === projectId && !(r.mobile ? platformHasDevice(platform) : platformHasBrowser(platform));
    await Promise.all([...this.runs].filter(([, r]) => unfit(r)).map(([id]) => this.stop(id)));
  }

  // «Запустити застосунок» and the agent's device_app: the file's app on the running device.
  // Answers once the app shows the expected liveness (or after a short wait, with what it is).
  async app(id: string, action: PreviewAppAction): Promise<PreviewState> {
    const run = this.runs.get(id);
    if (!run?.mobile) throw new Error("this session's preview has no device");
    if (run.halted || run.state.phase !== "running" || !run.app) throw new Error("the device preview is not running: start it first");
    const app = run.app;
    if (action !== "launch") await this.device.terminate(id, app);
    if (action !== "terminate") await this.device.launch(id, app);
    const want = action !== "terminate";
    const deadline = Date.now() + APP_ACTION_MS;
    while ((await this.device.appRunning(id, app)) !== want && Date.now() < deadline && !run.halted) await sleep(this.opts.pollMs);
    await this.refreshApp(id, run);
    return run.state;
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

  // Decisions 2 and 8: only an agent session, of a project with a browser or a device
  // (mobile decision 8), with a directory.
  private resolve(id: string): { projectId: string; dir: string; platform: Platform | undefined } {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    if (s.kind !== "agent") throw new Error(`only agent sessions have a live preview (this is a ${s.kind})`);
    const project = this.registry.listProjects().find((p) => p.id === s.projectId);
    if (!project) throw new Error("project not found");
    if (!platformHasPreview(project.platform)) throw new Error(`a ${project.platform} project has no live preview`);
    if (s.worktree && !s.worktreePath) throw new Error("this session is finished: it has no worktree to preview");
    const dir = s.worktreePath || project.localRepoPath;
    if (!dir) throw new Error("project not bound");
    return { projectId: s.projectId, dir, platform: project.platform ?? undefined };
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

  private async execute(id: string, run: Run, config: PreviewConfig, dir: string, previous: Promise<void>, opts: PreviewStartOptions): Promise<void> {
    let step = run.state.phase === "starting" ? run.state.step : "";
    // From the device's boot on, every `starting` carries it: the screen shows during `setup`.
    const starting = (at: string, services: PreviewPort[]) => {
      step = at;
      this.update(id, run, run.runtime ? { phase: "starting", step, services, device: run.runtime } : { phase: "starting", step, services });
    };
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

      if (config.device) {
        starting(PREVIEW_DEVICE_STEP, services);
        run.logs.set(PREVIEW_DEVICE_STEP, []);
        const base = await this.guard(run, this.pickBase(id, run, config, opts));
        run.platform = base.platform;
        run.base = base.id;
        const app = config.device[base.platform]!.app;
        run.app = app;
        const runtime = await this.guard(run, this.device.ensure(id, base, (line) => this.log(run, PREVIEW_DEVICE_STEP, line), run.ctrl.signal));
        if (run.halted) return;
        run.runtime = runtime;
        vars.DEVICE_ID = runtime.serial;
        vars.DEVICE_PLATFORM = runtime.platform;
        if (runtime.platform === "android") vars.ANDROID_SERIAL = runtime.serial;
        // ↻ keeps the device, and with it the previous run's app: left running, it would make a
        // device service ready before the new build, and a launch would only bring the old one
        // to the front. On a fresh boot nothing runs and this is a no-op.
        await this.guard(
          run,
          this.device.terminate(id, app).catch((err: unknown) => this.log(run, PREVIEW_DEVICE_STEP, `could not stop the previous ${app}: ${(err as Error).message}`)),
        );
        if (run.halted) return;
        // Before `setup`, the services and `install`: a `"device": true` service such as
        // `flutter run` exits with the app, so its data cannot be cleared under it.
        if (opts.clean) {
          this.log(run, PREVIEW_DEVICE_STEP, `clearing the data of ${app}`);
          const started = Date.now();
          await this.guard(run, this.device.clearApp(id, app)).catch((err: unknown) => {
            throw new StepFailure(PREVIEW_DEVICE_STEP, `could not clear the data of ${app}: ${(err as Error).message}`);
          });
          if (run.halted) return;
          this.log(run, PREVIEW_DEVICE_STEP, `cleared the data of ${app} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        }
        // The app's own log, from now on: a device service or `install` may start it.
        run.stopAppLogs = this.device.appLogs(id, app, (line) => this.log(run, PREVIEW_DEVICE_STEP, line));
        starting(PREVIEW_DEVICE_STEP, services);
      }

      if (config.setup) {
        starting(PREVIEW_SETUP_STEP, services);
        const proc = this.spawnStep(run, step, config.setup, dir, vars, false);
        await this.waitSetup(run, proc);
      }
      let url = "";
      for (const [i, svc] of config.services.entries()) {
        if (run.halted) return;
        starting(svc.name, services);
        const own: Record<string, string> = { ...vars, PORT: String(ports[i]) };
        const env: Record<string, string> = { ...own };
        for (const [k, v] of Object.entries(svc.env)) env[k] = expandPreviewEnv(v, own);
        const proc = this.spawnStep(run, step, svc.command, dir, env, svc.open, id);
        // A `"device": true` service installs and launches the app itself (mobile decision 5).
        if (svc.device) await this.waitApp(id, run, step, this.opts.appReadyMs);
        else {
          const port = await this.waitReady(run, proc, ports[i]!);
          if (svc.open) url = `http://localhost:${port}`;
        }
      }
      if (run.halted) return;

      if (config.device) {
        const target = config.device[run.platform!]!;
        if (target.install) {
          starting(PREVIEW_INSTALL_STEP, services);
          const proc = this.spawnStep(run, step, target.install, dir, vars, false);
          await this.waitSetup(run, proc);
        }
        starting(PREVIEW_DEVICE_STEP, services);
        if (!config.services.some((s) => s.device)) {
          this.log(run, PREVIEW_DEVICE_STEP, `launching ${target.app}`);
          await this.guard(run, this.device.launch(id, target.app));
        }
        await this.waitApp(id, run, PREVIEW_DEVICE_STEP, this.opts.launchMs);
        if (run.halted) return;
        this.update(id, run, { phase: "running", url: null, services, device: run.runtime!, app: "running" });
        void this.watchApp(id, run);
        return;
      }

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

  // The base device to boot (mobile decision 6). An explicit base or platform is the
  // operator's (or the agent's) choice and becomes the project's default; otherwise the device
  // service's `next`: the session's own clone first, so another session's choice never
  // re-clones this one.
  private async pickBase(id: string, run: Run, config: PreviewConfig, opts: PreviewStartOptions): Promise<DeviceBase> {
    const platforms = previewPlatforms(config);
    const clone = this.device.clone(id);
    let base: DeviceBase;
    if (opts.base) {
      const ofClone = !!clone && clone.base === opts.base && (!opts.platform || clone.platform === opts.platform);
      const found =
        (await this.device.bases()).find((b) => b.id === opts.base && (!opts.platform || b.platform === opts.platform)) ??
        // The session's own base, deleted since the clone was made: the clone does not need it
        // (mobile decision 4).
        (ofClone ? { platform: clone.platform, id: clone.base, name: clone.baseName, os: "" } : undefined);
      if (!found) throw new StepFailure(PREVIEW_DEVICE_STEP, `no base device ${opts.base}${opts.platform ? ` for ${opts.platform}` : ""} on this machine`);
      if (!platforms.includes(found.platform))
        throw new StepFailure(PREVIEW_DEVICE_STEP, `${found.name} is an ${found.platform} device, and the "device" block of ${PREVIEW_CONFIG_PATH} has no ${found.platform} app`);
      base = found;
    } else {
      // Restricting `platforms` to the asked one makes `next` that platform's choice or default.
      const asked = opts.platform ? [opts.platform] : platforms;
      const info = await this.device.info(id, run.projectId, asked);
      if (!info.next) {
        const why = asked.map((p) => {
          const tool = info.tools[p];
          if (tool && !tool.ok) return `${p}: ${tool.reason}`;
          return `${p}: no ${p === "ios" ? "iOS simulator" : "Android virtual device"} on this machine`;
        });
        throw new StepFailure(PREVIEW_DEVICE_STEP, `no device to run the app on (${why.join("; ")})`);
      }
      base = info.next.base;
    }
    // Only a change of this session's device is a new choice: naming the device it already has
    // must not reset the default another session picked meanwhile.
    const changed = !clone || clone.platform !== base.platform || clone.base !== base.id;
    if ((opts.platform || opts.base) && changed) {
      const choice = this.device.choice(run.projectId);
      this.device.setChoice(run.projectId, { ...choice, platform: base.platform, ...(opts.base ? { [base.platform]: base.id } : {}) });
    }
    this.log(run, PREVIEW_DEVICE_STEP, `device: ${base.name} (${base.platform}${base.os ? `, ${base.os}` : ""})`);
    return base;
  }

  // A device-side wait that a halt or a failed step ends at once. The promise left behind is
  // handled, so its late rejection is not an unhandled one.
  private guard<T>(run: Run, p: Promise<T>): Promise<T> {
    p.catch(() => {});
    return Promise.race([p, run.aborted]);
  }

  // The app's process runs on the device within `ms`, polled every `pollMs`.
  private async waitApp(id: string, run: Run, step: string, ms: number): Promise<void> {
    const app = run.app!;
    const deadline = Date.now() + ms;
    for (;;) {
      if (await this.guard(run, this.device.appRunning(id, app))) return;
      if (Date.now() > deadline) throw new StepFailure(step, `the app ${app} was not running on the device within ${minutes(ms)}`);
      await Promise.race([sleep(this.opts.pollMs), run.aborted]);
    }
  }

  // While running, every `appPollMs`: the app's exit is a state of its own, not a crash, and
  // a relaunch (the operator's, the agent's, a hot restart) brings it back (mobile decision 11).
  private async watchApp(id: string, run: Run): Promise<void> {
    while (!run.halted && run.state.phase === "running") {
      await Promise.race([sleep(this.opts.appPollMs), run.aborted]).catch(() => {});
      await this.refreshApp(id, run);
    }
  }

  private async refreshApp(id: string, run: Run): Promise<void> {
    if (run.halted || run.state.phase !== "running" || !run.app) return;
    let alive: boolean;
    try {
      alive = await this.device.appRunning(id, run.app);
    } catch {
      return; // the device itself went: exits$ says so
    }
    const state = run.state;
    if (run.halted || state.phase !== "running") return;
    const now = alive ? "running" : "exited";
    if (state.app === now) return;
    this.log(run, PREVIEW_DEVICE_STEP, alive ? `${run.app} is running again` : `${run.app} exited`);
    this.update(id, run, { ...state, app: now });
  }

  // The device's process ended by itself: a crash of the running preview, a failure of a start.
  private deviceExited(id: string, reason: string): void {
    const run = this.runs.get(id);
    if (!run || run.halted || !run.mobile) return;
    this.log(run, PREVIEW_DEVICE_STEP, `the device exited: ${reason}`);
    if (run.state.phase === "running") {
      void this.halt(run);
      this.update(id, run, { phase: "crashed", step: PREVIEW_DEVICE_STEP, code: null, signal: null });
    } else run.abort(new StepFailure(PREVIEW_DEVICE_STEP, `the device exited: ${reason}`));
  }

  // `setup` and `install` must exit 0 in time.
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
    const text = this.log(run, proc.step, raw);
    if (text !== undefined && proc.banner) for (const m of text.matchAll(BANNER_RE)) proc.banner.add(Number(m[1]));
  }

  // One line into `step`'s ring, without ANSI. Answers the line kept, if the step has a log.
  private log(run: Run, step: string, raw: string): string | undefined {
    const text = raw.replace(ANSI_RE, "");
    const lines = run.logs.get(step);
    if (!lines) return undefined;
    lines.push({ seq: ++this.seq, text });
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
    return text;
  }

  // Every step's group: SIGTERM, then SIGKILL after the grace. Resolves when all have exited.
  // Once per run: a later call (shutdown after a crash) must not signal process groups whose
  // ids the system may have handed out again. The device shuts down after them (◼, a crash, a
  // failed start, quit) unless `keepDevice` (↻: mobile decision 11).
  private halt(run: Run, graceMs = this.opts.killGraceMs, keepDevice = false): Promise<void> {
    if (run.stopped) return run.stopped;
    run.halted = true;
    run.abort(new Error("stopped"));
    run.ctrl.abort();
    run.stopAppLogs?.();
    const procs = Promise.all(run.procs.map((p) => stopProc(p, graceMs))).then(() => {});
    run.stopped =
      run.mobile && !keepDevice
        ? procs.then(() =>
            this.device.shutdown(run.id).catch((err: unknown) => console.warn(`[preview] could not shut down the device of session ${run.id}: ${(err as Error).message}`)),
          )
        : procs;
    return run.stopped;
  }
}


type ConfigRead = { status: PreviewConfigStatus; config?: PreviewConfig };

// The project's platform decides whether the file needs a `device` block (mobile decision 5).
function readConfig(dir: string, platform: Platform | undefined): ConfigRead {
  let text: string;
  try {
    text = readFileSync(join(dir, PREVIEW_CONFIG_PATH), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: { kind: "missing" } };
    return { status: { kind: "invalid", error: `cannot read the file: ${(err as Error).message}` } };
  }
  const parsed = parsePreviewConfig(text);
  if (!parsed.ok) return { status: { kind: "invalid", error: parsed.error } };
  const config = parsed.config;
  if (platformHasDevice(platform) && !config.device) return { status: { kind: "invalid", error: 'device: a Mobile project needs a "device" block naming its app' } };
  if (!platformHasDevice(platform) && config.device) return { status: { kind: "invalid", error: "device: works only in a project whose platform is Mobile" } };
  return { status: { kind: "ok", services: config.services.map((s) => s.name), platforms: previewPlatforms(config) }, config };
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
