// apps/api/src/minion/minion.service.ts
// «Посіпака» on this machine (docs/specs/2026-10-23-minion-auto-run.md): the poll that takes the
// signed-in author's own auto-run cards, one at a time up to the cap, and the machine-level
// policy around it — activation per project, the cap, the consecutive failures and the pause,
// the provider preflight, and keep-awake. How one run works and ends (the verdict, the docs and
// PR turns, the time cap) is the supervisor's: it owns the session; this service only starts
// runs (SupervisorService.launchMinion) and counts how they end (minionResult$).
//
// Dependency direction: MinionService → { SupervisorService, RegistryService, AuthService,
// RuntimeCheckService }. The supervisor never knows this service; its state reaches the socket
// through the supervisor's `events$` like every other event.
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { claimMinionTask, listMinionCandidates, releaseLaunchClaim, type Task } from "@kermanych/cloud";
import { clampMinionCap, MINION_FAILURE_LIMIT, MINION_POLL_MS, MINION_PREFLIGHT_TTL_MS, type AgentRuntimeKind, type MinionPause, type MinionState } from "@kermanych/core";
import { RegistryService, type MinionSettingsRow } from "../registry/registry.service";
import { SupervisorService, type MinionRunResult } from "../supervisor/supervisor.service";
import { AuthService } from "../auth/auth.service";
import { RuntimeCheckService, type RuntimeCheck } from "../runtime/runtime-check.service";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { keepAwake } from "./keep-awake";
import { AuthFailure } from "../runtime/auth-failure";

@Injectable()
export class MinionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  // Single flight: a poll in progress absorbs every kick into one more pass after it.
  private polling?: Promise<void>;
  private again = false;
  // The last runtime preflight, trusted for MINION_PREFLIGHT_TTL_MS (decision 9).
  private preflight?: { runtime: AgentRuntimeKind; at: number; check: RuntimeCheck };
  // What the last poll saw; memory-only, like the poll itself.
  private waiting = 0;
  private lastPollAt?: string;
  private pollError?: string;
  // The running count last told to keep-awake and the UI.
  private running = 0;

  constructor(
    private registry: RegistryService,
    private supervisor: SupervisorService,
    private auth: AuthService,
    private runtimeCheck: RuntimeCheckService,
  ) {
    this.supervisor.minionResult$.subscribe((r) => this.onResult(r));
    // A minion session that starts, settles or goes away moves the running count.
    this.supervisor.events$.subscribe((e) => {
      if ((e.type === "session_update" && e.session.minion) || e.type === "session_removed") this.onSessions();
    });
  }

  // The first poll comes with the first tick, not at boot: a launch needs the api listening, or
  // its agent gets no `kermanych` MCP server and so no `report_outcome`.
  onModuleInit(): void {
    this.running = this.supervisor.minionRunning();
    if (this.running) keepAwake()?.(true);
    this.timer = setInterval(() => this.kick(), MINION_POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  state(): MinionState {
    const s = this.registry.getMinionSettings();
    return {
      cap: s.cap,
      ...(s.pause ? { pause: s.pause } : {}),
      failures: s.failures,
      running: this.supervisor.minionRunning(),
      waiting: this.waiting,
      projects: this.registry.listMinionProjects(),
      ...(this.lastPollAt ? { lastPollAt: this.lastPollAt } : {}),
      ...(this.pollError ? { pollError: this.pollError } : {}),
    };
  }

  // `PUT /api/minion`. `paused: true` is the operator's pause; `paused: false` resumes from any
  // pause, forgets the failures and the preflight verdict, and polls at once, as a new cap does.
  update(patch: { cap?: number; paused?: boolean }): MinionState {
    const s = this.registry.getMinionSettings();
    const next: MinionSettingsRow = { ...s };
    if (patch.cap !== undefined) {
      const cap = clampMinionCap(patch.cap);
      if (cap === undefined) throw new Error(`invalid cap ${JSON.stringify(patch.cap)}`);
      next.cap = cap;
    }
    if (patch.paused === true && !s.pause) next.pause = { code: "operator", at: new Date().toISOString() };
    if (patch.paused === false) {
      delete next.pause;
      next.failures = 0;
      this.preflight = undefined;
    }
    this.save(next);
    if (patch.cap !== undefined || patch.paused === false) this.kick();
    return this.state();
  }

  // `PUT /api/minion/projects/:id`. Activation needs this machine's binding (decision 6);
  // deactivating takes no new cards and leaves a run in progress alone.
  setProject(projectId: string, active: boolean): MinionState {
    const project = this.registry.listProjects().find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    if (active && !project.localRepoPath) throw new Error("project not bound");
    this.registry.setMinionProject(projectId, active);
    this.emit();
    if (active) this.kick();
    return this.state();
  }

  kick(): void {
    void this.poll();
  }

  poll(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.polling = (async () => {
      try {
        do {
          this.again = false;
          await this.pollOnce().catch((err: unknown) => {
            console.warn(`[minion] poll failed: ${(err as Error).message}`);
            this.pollError = (err as Error).message;
            this.emit();
          });
        } while (this.again);
      } finally {
        this.polling = undefined;
      }
    })();
    return this.polling;
  }

  // One pass: take at most one card. Nothing is claimed while the minion is paused, at its cap,
  // without a free agent slot (or while an operator session waits for one), signed out, or
  // when the provider preflight fails. The listing runs even then, so the strip's «у черзі»
  // stays current while a run fills the cap or the minion is paused.
  private async pollOnce(): Promise<void> {
    const projects = this.activeProjects();
    if (!projects.length) return;
    const user = this.auth.current();
    if (!user) {
      this.pollError = "not signed in";
      this.emit();
      return;
    }
    const client = this.auth.cloudClient();
    let candidates: Task[];
    try {
      candidates = await listMinionCandidates(client, projects, user.userId);
    } catch (err) {
      this.pollError = (err as Error).message;
      this.emit();
      return;
    }
    this.waiting = candidates.length;
    this.lastPollAt = new Date().toISOString();
    this.pollError = undefined;
    // A card this machine already runs (its status push has not landed yet) is not taken again.
    const eligible = candidates.filter((t) => !this.supervisor.runsTask(t.id));
    if (!eligible.length || !this.mayStart()) return this.emit();

    const check = await this.preflightCheck();
    if (!check.ok) {
      if (check.code?.endsWith("_not_authenticated")) this.pause({ code: "signed_out", at: new Date().toISOString(), detail: check.code });
      else {
        this.pollError = check.code ?? check.reason ?? "the agent runtime is not usable";
        this.emit();
      }
      return;
    }

    for (const card of eligible) {
      // The listing and the preflight took a while: the operator may have started an agent or
      // paused the minion meanwhile.
      if (!this.mayStart()) break;
      // Zero rows: another machine of the same user, or the operator's own ▶, got there first.
      const won = await claimMinionTask(client, card.id, user.userId);
      if (!won) continue;
      try {
        await this.supervisor.launchMinion(won, user.userId);
      } catch (err) {
        const message = (err as Error).message;
        console.warn(`[minion] launch of card ${card.id} failed: ${message}`);
        // Back to the backlog first, then the assignee it had (decision 7's two-step release).
        await releaseLaunchClaim(client, card.id, { status: "backlog", assigneeId: card.assigneeId }).catch((e: unknown) =>
          console.warn(`[minion] could not release the claim on card ${card.id}: ${(e as Error).message}`),
        );
        // A child that refused to start signed out pauses at once, as a run that dies signed out
        // does.
        const signedOut = err instanceof AuthFailure && err.code !== "claude_binary_missing";
        this.countFailure(`«${card.title}»: ${message}`, signedOut);
      }
      break;
    }
    this.emit();
  }

  // Projects activated here AND bound here: a binding may have gone since the activation.
  private activeProjects(): string[] {
    const bound = new Set(this.registry.listProjects().filter((p) => p.localRepoPath).map((p) => p.id));
    return this.registry.listMinionProjects().filter((id) => bound.has(id));
  }

  private mayStart(): boolean {
    const s = this.registry.getMinionSettings();
    return !s.pause && this.supervisor.minionRunning() < s.cap && this.supervisor.minionSlotFree();
  }

  private async preflightCheck(): Promise<RuntimeCheck> {
    // The signed-in user's runtime, resolved exactly as the supervisor resolves it for a launch.
    const runtime = resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime);
    const now = Date.now();
    const cached = this.preflight;
    if (cached && cached.runtime === runtime && now - cached.at < MINION_PREFLIGHT_TTL_MS) return cached.check;
    const check = await this.runtimeCheck.check(runtime);
    this.preflight = { runtime, at: now, check };
    return check;
  }

  // How a run ended, counted (decision 9): a PR or the agent's own needs_decision resets the
  // failures, a failure adds one, an operator's stop does neither.
  private onResult(r: MinionRunResult): void {
    if (r.effect === "failure") this.countFailure(`«${r.title}»: ${r.result.reason ?? r.result.code ?? r.result.outcome}`, r.signedOut);
    else if (r.effect === "success") {
      const s = this.registry.getMinionSettings();
      if (s.failures) this.save({ ...s, failures: 0 });
    }
  }

  // MINION_FAILURE_LIMIT in a row pause the minion until the operator resumes it. A run that
  // died signed out pauses it at once, with that reason — unless the operator paused it.
  private countFailure(detail: string, signedOut = false): void {
    const s = this.registry.getMinionSettings();
    const failures = s.failures + 1;
    const at = new Date().toISOString();
    let pause = s.pause;
    if (signedOut && pause?.code !== "operator") pause = { code: "signed_out", at, detail };
    else if (!pause && failures >= MINION_FAILURE_LIMIT) pause = { code: "failures", at, detail };
    this.save({ cap: s.cap, failures, ...(pause ? { pause } : {}) });
  }

  // A pause the operator set stays the operator's; any other is replaced by the newer cause.
  private pause(p: MinionPause): void {
    const s = this.registry.getMinionSettings();
    if (s.pause?.code === "operator") return;
    this.save({ ...s, pause: p });
  }

  private save(row: MinionSettingsRow): void {
    this.registry.setMinionSettings(row);
    this.emit();
  }

  // The running count moved: keep-awake follows it, the UI hears it, and a run that ended frees
  // room for the next card.
  private onSessions(): void {
    const running = this.supervisor.minionRunning();
    if (running === this.running) return;
    const fewer = running < this.running;
    this.running = running;
    keepAwake()?.(running > 0);
    this.emit();
    if (fewer) this.kick();
  }

  private emit(): void {
    this.supervisor.publish({ type: "minion_update", state: this.state() });
  }
}
