// apps/api/src/pr-loop/pr-loop.service.ts
// «Петля після ПР» (docs/specs/2026-11-23-pr-feedback-loop.md): every PR_LOOP_TICK_MS the api reads
// the CI and the review comments of each watched session's pull request (decision 11), shows them
// as a PrLoopState and, in auto mode, hands a ready round to the agent (decisions 3–9). The rules
// are core's (planRound, ciSummary, isTrustedAuthor, …); this service fetches, normalises, keeps
// the bookkeeping in the local registry (pr_loop, pr_loop_seen) and publishes `pr_loop_update`.
//
// The first sight of a PR is a baseline: comments already there are recorded as seen and a CI
// result already finished on the head as reported, so nothing old reaches the agent on rollout.
//
// Dependency direction: PrLoopService → { RegistryService, SupervisorService }. The supervisor
// never knows this service: a round goes in through supervisor.sendLoopFeedback, an operator's
// message comes back on its operatorPrompt$, and this service's events reach the socket through
// supervisor.publish, like MinionService's and ScheduleService's.
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  ACTIVE_STATUSES,
  baseSyncBlock,
  checkRunState,
  ciSummary,
  commentKey,
  commitStatusState,
  emptyPrLoopCi,
  isLoopNoise,
  isTrustedAuthor,
  mergeableOf,
  planRound,
  prFeedbackPrompt,
  PR_LOOP_TICK_MS,
  reviewDecision,
  type PrLoopCheck,
  type PrLoopCi,
  type PrLoopComment,
  type PrLoopPhase,
  type PrLoopSettings,
  type PrLoopState,
  type PrLoopUnavailable,
  type Project,
  type Session,
} from "@kermanych/core";
import { RegistryService, type PrLoopRow } from "../registry/registry.service";
import { SupervisorService, type GithubPrSource } from "../supervisor/supervisor.service";
import { GithubClient, GithubEtagCache, GithubHttpError, githubFailure, type GithubPull } from "../github/github-client";

// The first tick waits for the api to listen, like ScheduleService's.
export const PR_LOOP_START_DELAY_MS = 5_000;

// What the last evaluation read of a session's PR: the manual pass sends from it, so the operator
// passes what the status line showed.
type Snapshot = {
  pr: { number: number; url: string; state: "open" | "merged" | "closed" };
  headSha: string;
  branch: string;
  base: string;
  checks: PrLoopCheck[];
  ci: PrLoopCi;
  comments: PrLoopComment[];
};

// Decision 11: an agent session that opened a PR, not retired, its tree still there (or working
// in place), in a project bound on this machine.
function watchedProject(s: Session, projects: Project[]): Project | undefined {
  if (s.kind !== "agent" || !s.prOpened || s.status === "merged" || (s.worktree && !s.worktreePath)) return undefined;
  const g = projects.find((p) => p.id === s.projectId);
  return g?.localRepoPath ? g : undefined;
}

// The state without `checkedAt`, for «did it change».
function fingerprint(s: PrLoopState): string {
  const { checkedAt: _, ...rest } = s;
  return JSON.stringify(rest);
}

export class PrLoopRefusal extends Error {}

@Injectable()
export class PrLoopService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private startTimer?: NodeJS.Timeout;
  // Single flight, like ScheduleService.tick: a tick in progress absorbs every kick. A kick names
  // one session (a PR just opened) or all of them (the timer).
  private ticking?: Promise<void>;
  private queuedAll = false;
  private queuedIds = new Set<string>();
  private destroyed = false;
  // Per-session chain, so a tick, a manual pass and a resume of one session never interleave.
  private locks = new Map<string, Promise<unknown>>();
  // The latest published state of every watched session, and what it was built from.
  private states = new Map<string, PrLoopState>();
  private snapshots = new Map<string, Snapshot>();
  // A session whose PR is merged or closed is not polled again (decision 9) — until its stored PR
  // URL changes (the value is the URL it ended with).
  private ended = new Map<string, string>();
  // The sessions last seen with `prOpened`, so a newly opened PR is baselined at once.
  private prOpened = new Set<string>();
  private etags = new GithubEtagCache();
  // The clock; a test seam.
  now = (): number => Date.now();

  constructor(
    private registry: RegistryService,
    private supervisor: SupervisorService,
  ) {
    this.supervisor.operatorPrompt$.subscribe((id) => {
      if (!this.registry.getPrLoop(id)) return;
      this.registry.resetPrLoopRound(id);
      this.kick(id);
    });
    this.supervisor.events$.subscribe((e) => {
      if (e.type === "session_removed") {
        if (this.states.has(e.sessionId)) this.kick(e.sessionId);
        return;
      }
      if (e.type !== "session_update") return;
      const s = e.session;
      const fresh = s.prOpened && !this.prOpened.has(s.id);
      if (s.prOpened) this.prOpened.add(s.id);
      else this.prOpened.delete(s.id);
      if (fresh || (this.states.has(s.id) && s.status === "merged")) this.kick(s.id);
    });
  }

  onModuleInit(): void {
    for (const s of this.supervisor.mergedSessions()) if (s.prOpened) this.prOpened.add(s.id);
    this.timer = setInterval(() => this.kick(), PR_LOOP_TICK_MS);
    this.timer.unref();
    this.startTimer = setTimeout(() => this.kick(), PR_LOOP_START_DELAY_MS);
    this.startTimer.unref();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
  }

  // ── Reads and actions ──────────────────────────────────────────────────────────────────────

  list(): PrLoopState[] {
    return [...this.states.values()];
  }

  getSettings(projectId: string): PrLoopSettings {
    this.project(projectId);
    return this.registry.getPrLoopSettings(projectId);
  }

  setSettings(projectId: string, s: PrLoopSettings): PrLoopSettings {
    this.project(projectId);
    this.registry.setPrLoopSettings(projectId, s);
    for (const x of this.supervisor.mergedSessions()) if (x.projectId === projectId && this.states.has(x.id)) this.kick(x.id);
    return s;
  }

  // «Передати агенту» (decisions 3 and 8): the head's unreported CI failure, every fresh trusted
  // comment and the untrusted ones the operator picked, whatever the quiet window, the CI or the
  // round limit say. The operator's own act: it resets the counter and is not a loop turn.
  async send(id: string, keys: string[] = []): Promise<{ sent: true }> {
    return this.locked(id, async () => {
      const s = this.watched(id);
      if (ACTIVE_STATUSES.includes(s.status)) throw new PrLoopRefusal("the session is busy: wait for its turn to end");
      const snap = this.snapshots.get(id);
      const row = this.registry.getPrLoop(id);
      if (!snap || !row || snap.pr.state !== "open") throw new PrLoopRefusal("nothing to send");
      const seen = this.registry.listPrLoopSeen(id);
      const picked = new Set(keys);
      const comments = snap.comments.filter((c) => !seen.has(c.key) && (c.trusted || picked.has(c.key)));
      const ciFailure = snap.ci.state === "failure" && snap.headSha !== row.ciReportedSha;
      if (!comments.length && !ciFailure) throw new PrLoopRefusal("nothing to send");
      await this.supervisor.sendLoopFeedback(id, this.message(snap, ciFailure, comments), { loopTurn: false });
      this.registry.addPrLoopSeen(id, comments.map((c) => c.key));
      this.registry.setPrLoop({
        ...row,
        ...(ciFailure ? { ciReportedSha: snap.headSha } : {}),
        round: 0,
        lastSentAt: new Date(this.now()).toISOString(),
      });
      this.republish(id);
      return { sent: true as const };
    });
  }

  // «Продовжити петлю» (decision 8): the counter back to zero, and the session evaluated at once.
  async resume(id: string): Promise<PrLoopState> {
    return this.locked(id, async () => {
      const s = this.watched(id);
      this.registry.resetPrLoopRound(id);
      this.ended.delete(id);
      const g = watchedProject(s, this.registry.listProjects())!;
      await this.evaluate(s, g);
      return this.states.get(id)!;
    });
  }

  // ── The tick ───────────────────────────────────────────────────────────────────────────────

  // Evaluate one session soon, or every watched session.
  kick(id?: string): void {
    void this.tick(id);
  }

  tick(id?: string): Promise<void> {
    if (id) this.queuedIds.add(id);
    else this.queuedAll = true;
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        while ((this.queuedAll || this.queuedIds.size) && !this.destroyed) {
          const only = this.queuedAll ? undefined : new Set(this.queuedIds);
          this.queuedAll = false;
          this.queuedIds.clear();
          await this.tickOnce(only).catch((err: unknown) => console.warn(`[pr-loop] tick failed: ${(err as Error).message}`));
        }
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  private async tickOnce(only?: Set<string>): Promise<void> {
    const projects = this.registry.listProjects();
    const sessions = this.supervisor.mergedSessions();
    const watched = new Map<string, { s: Session; g: Project }>();
    for (const s of sessions) {
      const g = watchedProject(s, projects);
      if (g) watched.set(s.id, { s, g });
    }
    // A session that stopped being watched — removed, retired, its tree gone — leaves the UI.
    for (const id of [...this.states.keys()])
      if (!watched.has(id) && (!only || only.has(id))) {
        this.states.delete(id);
        this.snapshots.delete(id);
        this.ended.delete(id);
        this.supervisor.publish({ type: "pr_loop_update", sessionId: id, state: null });
      }
    for (const [id, { s, g }] of watched) {
      if (this.destroyed) return;
      if (only && !only.has(id)) continue;
      if (this.ended.has(id) && this.ended.get(id) === (s.prUrl ?? "")) continue;
      await this.locked(id, () => this.evaluate(s, g)).catch((err: unknown) =>
        console.warn(`[pr-loop] ${id}: ${(err as Error).message}`),
      );
    }
  }

  // One session: resolve its PR, read GitHub, apply the round rules, publish.
  private async evaluate(s: Session, g: Project): Promise<void> {
    const settings = this.registry.getPrLoopSettings(g.id);
    const src = await this.supervisor.githubPrSource(s, g.localRepoPath);
    let remoteRead: Promise<{ owner: string; repo: string } | null> | undefined;
    const remote = () => (remoteRead ??= src.remote());
    if (!src.stored && !(await remote())) return this.unavailable(s, settings, "not_github");
    if (!src.token) return this.unavailable(s, settings, "no_token");
    const gh = new GithubClient(src.token, this.etags);
    let snap: Snapshot | null;
    let reviewStates: { user: string; state: string }[];
    let mergeableState: string | null | undefined;
    try {
      const found = await this.resolvePull(gh, src, remote, s, g);
      if (!found) {
        this.snapshots.delete(s.id);
        return this.publishState(this.emptyState(s, settings, this.registry.getPrLoop(s.id)));
      }
      const { owner, repo, pull } = found;
      const n = pull.number;
      // A fine-grained token without «Checks: read» or «Commit statuses: read» gets a 403 on that
      // CI source alone; the PR, reviews and comments still read, so the loop goes on without it
      // (CI marked denied) instead of failing as no_access — a merged PR still shows as merged.
      const denied = <T>(read: Promise<T>): Promise<T | null> =>
        read.catch((err: unknown) => {
          if (err instanceof GithubHttpError && err.status === 403 && !err.rateLimited) return null;
          throw err;
        });
      const [runs, statuses, reviews, inline, conversation] = await Promise.all([
        denied(gh.checkRuns(owner, repo, pull.head.sha)),
        denied(gh.combinedStatus(owner, repo, pull.head.sha)),
        gh.reviews(owner, repo, n),
        gh.reviewComments(owner, repo, n),
        gh.issueComments(owner, repo, n),
      ]);
      const checks: PrLoopCheck[] = [
        ...(runs ?? []).map((r) => {
          const url = r.html_url ?? r.details_url;
          const started = r.started_at ?? r.created_at;
          return {
            name: r.name,
            state: checkRunState(r.status, r.conclusion),
            ...(url ? { url } : {}),
            ...(r.output?.summary ? { summary: r.output.summary } : {}),
            ...(started ? { startedAt: started } : {}),
          };
        }),
        ...(statuses ?? []).map((st) => ({
          name: st.context,
          state: commitStatusState(st.state),
          ...(st.target_url ? { url: st.target_url } : {}),
          ...(st.description ? { summary: st.description } : {}),
          startedAt: st.created_at,
        })),
      ];
      const comment = (
        kind: PrLoopComment["kind"],
        c: { id: number; user: { login: string; type?: string } | null; body: string | null; html_url: string; author_association?: string },
        createdAt: string,
        extra: { path?: string; line?: number } = {},
      ): PrLoopComment => ({
        key: commentKey(kind, c.id),
        kind,
        id: c.id,
        author: c.user?.login ?? "ghost",
        trusted: isTrustedAuthor(c.author_association, c.user?.type),
        body: c.body ?? "",
        url: c.html_url,
        createdAt,
        ...extra,
      });
      const comments = [
        ...inline.map((c) => {
          const line = c.line ?? c.original_line;
          return comment("inline", c, c.created_at, { ...(c.path ? { path: c.path } : {}), ...(line ? { line } : {}) });
        }),
        // A review still being written (PENDING) has no submitted_at and is nobody's feedback yet.
        ...reviews.filter((r) => r.submitted_at).map((r) => comment("review", r, r.submitted_at!)),
        ...conversation.map((c) => comment("conversation", c, c.created_at)),
      ].filter((c) => !isLoopNoise(c.body));
      reviewStates = reviews.map((r) => ({ user: r.user?.login ?? "", state: r.state }));
      mergeableState = pull.mergeable_state;
      snap = {
        pr: { number: n, url: pull.html_url, state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open" },
        headSha: pull.head.sha,
        branch: s.branch,
        base: this.supervisor.syncBase(s, g),
        checks,
        ci: { ...ciSummary(checks, this.now()), ...(runs && statuses ? {} : { checksDenied: true as const }) },
        comments,
      };
    } catch (err) {
      return this.unavailable(s, settings, githubFailure(err));
    }
    this.snapshots.set(s.id, snap);

    let row = this.registry.getPrLoop(s.id);
    // The baseline (decision 11): the first sight of this PR sends nothing.
    if (!row?.baselined || row.prNumber !== snap.pr.number) {
      if (row && row.prNumber !== snap.pr.number) this.registry.deletePrLoop(s.id);
      this.registry.addPrLoopSeen(s.id, snap.comments.map((c) => c.key));
      row = {
        sessionId: s.id,
        prNumber: snap.pr.number,
        headSha: snap.headSha,
        ...(snap.ci.state === "success" || snap.ci.state === "failure" ? { ciReportedSha: snap.headSha } : {}),
        round: 0,
        baselined: true,
      };
      this.registry.setPrLoop(row);
    } else if (row.headSha !== snap.headSha) {
      row = { ...row, headSha: snap.headSha };
      this.registry.setPrLoop(row);
    }

    const seen = this.registry.listPrLoopSeen(s.id);
    const fresh = snap.comments.filter((c) => c.trusted && !seen.has(c.key));
    const busy = ACTIVE_STATUSES.includes(s.status) || !!s.slotWait || !!s.pendingPrompt;
    const plan = planRound({
      now: this.now(),
      prState: snap.pr.state,
      mode: settings.mode,
      round: row.round,
      maxRounds: settings.maxRounds,
      ci: snap.ci,
      headSha: snap.headSha,
      ...(row.ciReportedSha ? { ciReportedSha: row.ciReportedSha } : {}),
      fresh,
      busy,
      loopTurn: s.loopTurn === true,
    });
    let phase: PrLoopPhase = plan.phase;
    if (plan.send) {
      try {
        await this.supervisor.sendLoopFeedback(s.id, this.message(snap, plan.ciFailure, fresh), { loopTurn: true });
        this.registry.addPrLoopSeen(s.id, fresh.map((c) => c.key));
        row = {
          ...row,
          ...(plan.ciFailure ? { ciReportedSha: snap.headSha } : {}),
          round: row.round + 1,
          lastSentAt: new Date(this.now()).toISOString(),
        };
        this.registry.setPrLoop(row);
      } catch (err) {
        // A native harness that is not idle after all (`native_busy`), or a session gone: the
        // round waits for the next tick.
        console.warn(`[pr-loop] ${s.id}: round not sent: ${(err as Error).message}`);
        phase = "busy";
      }
    }
    this.publishState(this.stateOf(s, settings, row, snap, reviewStates, mergeableState, phase));
    if (snap.pr.state !== "open") this.ended.set(s.id, s.prUrl ?? "");
  }

  // The session's PR (decision 11, as the merged-PR check finds it): the stored GitHub URL's —
  // unless it was closed without merging and the branch has an open one since — else the newest
  // open PR of the session's branch into its base, else its newest closed one. null: none.
  private async resolvePull(
    gh: GithubClient,
    src: GithubPrSource,
    remote: () => Promise<{ owner: string; repo: string } | null>,
    s: Session,
    g: Project,
  ): Promise<{ owner: string; repo: string; pull: GithubPull } | null> {
    let stored: { owner: string; repo: string; pull: GithubPull } | undefined;
    if (src.stored) {
      const pull = await gh.pull(src.stored.owner, src.stored.repo, src.stored.number);
      stored = { owner: src.stored.owner, repo: src.stored.repo, pull };
      if (pull.state === "open" || pull.merged_at) return stored;
    }
    const r = await remote();
    if (!r || !s.branch) return stored ?? null;
    const listed = await gh.pullsByHead(r.owner, r.repo, `${r.owner}:${s.branch}`, stored ? "open" : "all");
    const ours = this.supervisor.sessionPulls(s, g, listed).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const pick = ours.find((p) => p.state === "open") ?? ours[0];
    // A listing has no `mergeable_state`: the PR itself is read.
    if (pick) return { owner: r.owner, repo: r.repo, pull: await gh.pull(r.owner, r.repo, pick.number) };
    return stored ?? null;
  }

  private message(snap: Snapshot, ciFailure: boolean, comments: PrLoopComment[]): string {
    const text = prFeedbackPrompt({
      branch: snap.branch,
      pr: { number: snap.pr.number, url: snap.pr.url },
      failed: ciFailure ? snap.checks.filter((c) => c.state === "failure") : [],
      comments,
    });
    return snap.base ? `${text}\n\n${baseSyncBlock(snap.base)}` : text;
  }

  // ── State ──────────────────────────────────────────────────────────────────────────────────

  private emptyState(s: Session, settings: PrLoopSettings, row: PrLoopRow | undefined): PrLoopState {
    return {
      sessionId: s.id,
      ci: emptyPrLoopCi(),
      review: { decision: "none", pending: 0, untrusted: [] },
      mergeable: "unknown",
      loop: {
        mode: settings.mode,
        round: row?.round ?? 0,
        maxRounds: settings.maxRounds,
        phase: "idle",
        ...(row?.lastSentAt ? { lastSentAt: row.lastSentAt } : {}),
      },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private unavailable(s: Session, settings: PrLoopSettings, why: PrLoopUnavailable): void {
    this.snapshots.delete(s.id);
    this.publishState({ ...this.emptyState(s, settings, this.registry.getPrLoop(s.id)), unavailable: why });
  }

  private stateOf(
    s: Session,
    settings: PrLoopSettings,
    row: PrLoopRow,
    snap: Snapshot,
    reviews: { user: string; state: string }[],
    mergeableState: string | null | undefined,
    phase: PrLoopPhase,
  ): PrLoopState {
    const seen = this.registry.listPrLoopSeen(s.id);
    const unseen = snap.comments.filter((c) => !seen.has(c.key));
    return {
      sessionId: s.id,
      pr: snap.pr,
      ci: snap.ci,
      review: {
        decision: reviewDecision(reviews),
        pending: unseen.filter((c) => c.trusted).length,
        untrusted: unseen.filter((c) => !c.trusted).map((c) => ({ key: c.key, author: c.author, url: c.url })),
      },
      mergeable: mergeableOf(mergeableState),
      loop: {
        mode: settings.mode,
        round: row.round,
        maxRounds: settings.maxRounds,
        phase,
        ...(row.lastSentAt ? { lastSentAt: row.lastSentAt } : {}),
      },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  // After a manual pass: the counts and the round change at once, the phase is the agent's turn.
  private republish(id: string): void {
    const prev = this.states.get(id);
    const snap = this.snapshots.get(id);
    const row = this.registry.getPrLoop(id);
    if (!prev || !snap || !row) return;
    const seen = this.registry.listPrLoopSeen(id);
    const unseen = snap.comments.filter((c) => !seen.has(c.key));
    this.publishState({
      ...prev,
      review: {
        ...prev.review,
        pending: unseen.filter((c) => c.trusted).length,
        untrusted: unseen.filter((c) => !c.trusted).map((c) => ({ key: c.key, author: c.author, url: c.url })),
      },
      loop: { ...prev.loop, round: row.round, phase: "busy", ...(row.lastSentAt ? { lastSentAt: row.lastSentAt } : {}) },
      checkedAt: new Date(this.now()).toISOString(),
    });
  }

  private publishState(state: PrLoopState): void {
    const prev = this.states.get(state.sessionId);
    this.states.set(state.sessionId, state);
    if (prev && fingerprint(prev) === fingerprint(state)) return;
    this.supervisor.publish({ type: "pr_loop_update", sessionId: state.sessionId, state });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────

  private project(projectId: string): Project {
    const g = this.registry.listProjects().find((p) => p.id === projectId);
    if (!g) throw new Error("project not found");
    return g;
  }

  // A session the loop watches now, or a refusal.
  private watched(id: string): Session {
    const s = this.supervisor.mergedSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    if (!watchedProject(s, this.registry.listProjects())) throw new PrLoopRefusal("the loop does not watch this session");
    return s;
  }

  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }
}
