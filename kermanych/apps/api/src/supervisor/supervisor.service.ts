// apps/api/src/supervisor/supervisor.service.ts
import { GoneException, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Observable, Subject } from "rxjs";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService, type ChangedFile } from "../worktree/worktree.service";
import type { SplitDiff } from "../worktree/split-diff";
import { RpcSession } from "../rpc/rpc-session";
import { createRuntime, type AgentRuntime } from "../runtime/agent-runtime";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { messagesToTranscript } from "./messages-to-transcript";
import { reduceRpcEvents, toolRowMatches, type SkillLabel, type SkillSource } from "./transcript-reducer";
import { ToolDetailCache } from "./tool-detail-cache";
import { SkillsService, skillsRoot } from "../skills/skills.service";
import { copyCarryFiles } from "../env/carry-files";
import {
  PR_CONVENTIONS_FALLBACK,
  agentById,
  renderInstruction,
  expandHelpers,
  helperNotice,
  INITIAL_STATUS,
  isAgentRuntime,
  reduceStatus,
  ACTIVE_STATUSES,
  slugify,
  taskNameFromText,
  branchName,
  uniqueSlug,
  worktreeDir,
  BRANCH_PREFIXES,
  PLATFORMS,
  type BranchPrefix,
  type StatusState,
  type Project,
  type ImageInput,
  type RpcEvent,
  type RpcExtensionUIResponse,
  type ServerEvent,
  type Session,
  type TreeEntry,
  type FileContent,
  type ThinkingLevel,
  type ToolLine,
  type TranscriptEntry,
  type AgentRuntimeKind,
  type Notice,
} from "@kermanych/core";
import { claimTask, createTask, getTask, listProjects, patchTask, type CloudProject, type ProjectTrigger } from "@kermanych/cloud";
import { AuthService } from "../auth/auth.service";
import { ModelsService } from "../models/models.service";

type Live = {
  rpc: AgentRuntime;
  state: StatusState;
  transcript: TranscriptEntry[];
  live: Partial<Session>;
  textBuf: string;
  thinkBuf: string;
  // Tool start stamps and call args live across events: the wall time and the `$ <command>`
  // header of a call are only reducible once its end frame arrives, several calls later.
  toolStarted: Map<string, number>;
  toolArgs: Map<string, Record<string, unknown>>;
  // Whether the "which model is this child actually running" question has been settled for
  // this child (refreshState). One lookup per omp process, not one per two-second poll.
  modelResolved?: boolean;
  poll?: NodeJS.Timeout;
};

// Chat sessions run omp with a read-only tool subset: they explore and plan in the project
// dir without ever mutating it (git-free). Promotion to an agent later grants the full toolset.
const CHAT_TOOLS = ["read", "grep", "glob"];

// The longest message an operator trigger's pattern is run against. Operator patterns arrive
// from the CLOUD, so a project owner's regex executes synchronously on a MEMBER's api event
// loop — one person's pattern can cost another person's process. Backtracking gets expensive
// with subject length, so the subject is bounded rather than the pattern analysed. 16 KiB is
// ~2500 words: far longer than any message phrased AT Kermanych, which is what a trigger
// matches, and short of the pasted logs and files that make a message big. Same idiom and the
// same reasoning as CONFIG_MAX_BYTES in skills.service.ts.
const MATCH_MAX_CHARS = 1 << 14;

@Injectable()
export class SupervisorService implements OnModuleInit, OnModuleDestroy {
  private map = new Map<string, Live>();
  private resuming = new Map<string, Promise<Live>>();
  // One cache for every session, live or dormant: GET /sessions/:id/tools/:callId must
  // still serve a session whose omp child has already been torn down.
  private toolDetails = new ToolDetailCache();
  // name -> the badge a skill row shows. Written at launch from the materialised view,
  // read by the transcript reducers; dropped with the session.
  private skillLabels = new Map<string, Map<string, SkillLabel>>();
  private lastStamp = 0;
  private events = new Subject<ServerEvent>();
  events$: Observable<ServerEvent> = this.events.asObservable();

  // A finished session's omp child stays resident so a follow-up resumes instantly — but a
  // live `omp --mode rpc` process is by far the largest thing this service keeps alive (a big
  // run's child holds gigabytes), so a board of done agents nobody has touched is what runs a
  // machine out of application memory. `reapIdleChildren` stops the child of any finished
  // session (status "done") silent past this TTL; the Live — and
  // with it the rendered transcript — stays, and the next send respawns through `liveOrResume`
  // exactly as a dormant session does. The child is a pure latency cache over the session file
  // omp already persisted, so nothing is lost. Same tradeoff as ManagementChatService.IDLE_TTL_MS.
  private static readonly CHILD_IDLE_TTL_MS = 15 * 60_000;
  private reaper?: NodeJS.Timeout;

  constructor(
    private registry: RegistryService,
    private worktree: WorktreeService,
    private auth: AuthService,
    private skills: SkillsService,
    private models: ModelsService,
  ) {}

  // Lay out the project's skill library for one child and remember how to label its rows.
  // Never throws: a library failure must degrade to "no library", never to a failed launch.
  private async ompSkills(projectId: string, cwd: string, sessionId: string): Promise<string | undefined> {
    try {
      const { configPath, view, stale } = await this.skills.materialize(projectId, cwd);
      const labels = new Map<string, SkillLabel>();
      for (const v of view) {
        // A shadowed name means the agent will read the REPOSITORY's file, so the badge
        // says so and points at it.
        if (v.shadowedByRepo) labels.set(v.name, { stat: "репо", intent: v.shadowedByRepo });
        else {
          const stat = v.source === "default" ? "бібліотека" : "проєкт";
          // A degraded materialise may not have written this name's SKILL.md, and a link to a
          // file that is not there is worse than no link. The shadowed rows above keep theirs:
          // a repository path came from a scan that found the file.
          labels.set(v.name, stale ? { stat } : { stat, intent: join(skillsRoot(), projectId, v.name, "SKILL.md") });
        }
      }
      this.skillLabels.set(sessionId, labels);
      return configPath;
    } catch (err) {
      // The launch goes ahead without a library either way, but silence here would hide a
      // programming error (a missing dependency) as readily as an expected degradation
      // (offline cloud, invalid project id, EACCES on the skills root).
      console.warn(`[supervisor] no skill library for session ${sessionId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  // The session's TTSR trigger package, laid out for `-e`. Its own wrapper rather than a
  // second return value from ompSkills: the two degrade independently — a project can have a
  // library and no triggers, or triggers and an unreadable library — and neither may cost a
  // launch. `undefined` means "this child gets no rules".
  private async ompTriggers(projectId: string, cwd: string, sessionId: string): Promise<string | undefined> {
    try {
      return (await this.skills.materializeTriggers(projectId, sessionId, cwd)).packagePath;
    } catch (err) {
      console.warn(`[supervisor] no triggers for session ${sessionId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  // The block one agent's assigned skills add to its instruction — the ONE way any of the
  // four instruction sites gets it. Never throws, for the same reason as ompSkills: the
  // service degrades on its own for a library reason (offline cloud, unreadable repository
  // file) and throws for a caller error (an invalid project id), and neither may cost an
  // agent its run. An empty string appends nothing.
  private async assignedBlockFor(projectId: string, agentId: string, cwd: string): Promise<string> {
    try {
      return (await this.skills.assignedFor(projectId, agentId, cwd)).block;
    } catch (err) {
      console.warn(`[supervisor] no assigned skills for ${agentId}: ${(err as Error).message}`);
      return "";
    }
  }

  private skillSource = (sessionId: string): SkillSource => (name) => this.skillLabels.get(sessionId)?.get(name);

  onModuleInit(): void {
    // A minute is far finer than the 15-minute TTL, so a child is reaped within a minute of
    // crossing it. Unref'd: the janitor must never hold the app open — a clean quit runs
    // onModuleDestroy, which stops the children anyway. ManagementChatService sweeps on-use
    // instead of on a timer, but a finished agent nobody touches is exactly the case an
    // on-use sweep never reaches, so this one rides a timer.
    this.reaper = setInterval(() => this.reapIdleChildren(), 60_000);
    this.reaper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.reaper);
    for (const live of this.map.values()) {
      this.stopPoll(live);
      void live.rpc.stop();
    }
  }

  // Stop the resident omp child of every FINISHED session (status "done") that has been silent
  // past CHILD_IDLE_TTL_MS. The Live stays, so getTranscript still serves the rendered history
  // with no rehydrate; the next send respawns through liveOrResume, exactly as a dormant session
  // does. Only "done": the isAlive guard already skips stopped/merged/most errored children
  // (their child is gone), and stopping a still-live conflict/error child would make wireLive's
  // onExit wrongly flip the row to "error". "done" is the state a big finished run rests at — the
  // exact memory target. Idempotent (a reaped child reads !isAlive) and never mid-resume.
  private reapIdleChildren(now = Date.now()): void {
    const cutoff = now - SupervisorService.CHILD_IDLE_TTL_MS;
    for (const [id, l] of this.map) {
      if (!l.rpc.isAlive()) continue;
      if (l.live.status !== "done") continue;
      if (this.resuming.has(id)) continue;
      if ((l.live.lastEventAt ?? now) > cutoff) continue;
      this.stopPoll(l);
      void l.rpc.stop().catch(() => {});
    }
  }

  snapshot() {
    return {
      projects: this.registry.listProjects(),
      sessions: this.registry.listSessions().map((s) => this.merge(s)),
    };
  }

  private merge(s: Session): Session {
    const l: Partial<Session> = this.map.get(s.id)?.live ?? {};
    return { ...s, ...l, status: l.status ?? s.status };
  }
  private pushUpdate(id: string) {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (s) this.events.next({ type: "session_update", session: this.merge(s) });
  }

  // Every project lookup used to be an inline registry find plus a hand-rolled
  // throw (13 sites). These two helpers are that pair, and `boundProject` additionally
  // enforces Requirement 3: no local execution without a local binding.
  private project(projectId: string): Project {
    const project = this.registry.listProjects().find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    return project;
  }

  private boundProject(projectId: string): Project {
    const project = this.project(projectId);
    if (!project.localRepoPath) throw new Error("project not bound");
    return project;
  }

  async removeProject(id: string): Promise<void> {
    for (const s of this.registry.listSessions(id)) await this.deleteSession(s.id);
    this.registry.removeProject(id);
    this.events.next({ type: "project_removed", projectId: id });
  }

  async updateProject(id: string, patch: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; defaultModel?: string; defaultEffort?: ThinkingLevel | ""; conventions?: string }): Promise<Project> {
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("project name cannot be empty");
      patch = { ...patch, name };
    }
    const project = this.registry.patchProject(id, patch);
    this.events.next({ type: "project_update", project });
    return project;
  }

  // This machine's manual binding (Requirement 3). Kermanych never clones: the path must
  // already be a git repo, and each developer binds their own checkout.
  async bindProject(id: string, localRepoPath: string): Promise<Project> {
    const path = localRepoPath.trim();
    if (!path) throw new Error("local repo path cannot be empty");
    if (!(await this.worktree.isGitRepo(path))) throw new Error("local repo path is not a git repo");
    const project = this.registry.patchProject(id, { localRepoPath: path });
    this.events.next({ type: "project_update", project });
    return project;
  }

  // Refresh the offline config cache from cloud reads (design D1). `prune` is opt-in and
  // only the UI's full-list refresh passes it; even then a row that still owns local
  // sessions survives as an orphan, because dropping it would cascade-delete a
  // developer's worktrees over a transient RLS/network hiccup.
  async syncProjects(cloud: CloudProject[], prune = false): Promise<Project[]> {
    for (const c of cloud) {
      const project = this.registry.upsertProject({
        id: c.id,
        name: c.name,
        color: c.color,
        previewCommand: c.previewCommand,
        apiCommand: c.apiCommand,
        carryFiles: c.carryFiles,
        defaultBranch: c.defaultBranch,
        defaultModel: c.defaultModel,
        defaultEffort: c.defaultEffort,
        conventions: c.conventions,
      });
      this.events.next({ type: "project_update", project });
    }
    if (prune) {
      const known = new Set(cloud.map((c) => c.id));
      for (const p of this.registry.listProjects()) {
        if (known.has(p.id) || this.registry.listSessions(p.id).length) continue;
        this.registry.removeProject(p.id);
        this.events.next({ type: "project_removed", projectId: p.id });
      }
    }
    return this.registry.listProjects();
  }

  // Branch list for the bound repo, used by the project-settings default-branch picker and
  // the worktree fork-base picker in the UI.
  async projectBranches(projectId: string): Promise<{ branches: string[]; current: string; default: string | null }> {
    const project = this.boundProject(projectId);
    const [branches, current] = await Promise.all([
      this.worktree.listBranches(project.localRepoPath),
      this.worktree.currentBranch(project.localRepoPath),
    ]);
    return { branches, current, default: project.defaultBranch ?? null };
  }

  // Footer git pull for the bound project's current branch. Returns git's { ok, out } as-is
  // (a failed pull is not an exception — the UI shows the output either way); an unbound
  // project throws via boundProject and surfaces as a 400.
  async projectPull(projectId: string): Promise<{ ok: boolean; out: string }> {
    return this.worktree.pull(this.boundProject(projectId).localRepoPath);
  }

  // Launch a CLOUD task on this machine. The cloud decides who may run a task (assignee +
  // atomic claim) and owns the project config; SQLite owns where the repo lives locally.
  // From `registry.createSession` onward this is byte-for-byte the ordinary launch path, so
  // a task-born session behaves exactly like a locally created one — including offline.
  async createSessionFromTask(taskId: string, userId: string, images?: ImageInput[]): Promise<Session> {
    const client = this.auth.cloudClient();

    const task = await getTask(client, taskId);
    if (!task) throw new Error("task not found");
    if (task.assigneeId && task.assigneeId !== userId) throw new Error("task assigned to someone else");

    // A second launch of a running card mints a second worktree and a second omp child
    // bound to the same taskId; both would then mirror status for it and the board would
    // flap between them. Two checks, because neither alone is enough: the cloud status
    // covers a session running on ANOTHER machine, the local scan covers THIS one, whose
    // status push may not have landed yet. Terminal and backlog cards stay launchable —
    // retrying an errored or stopped task is the point of the board.
    if (ACTIVE_STATUSES.includes(task.status)) throw new Error("task is already running");
    const mine = this.registry.listSessions().some((s) => s.taskId === taskId && ACTIVE_STATUSES.includes(this.merge(s).status));
    if (mine) throw new Error("task is already running");
    // Did THIS call take the assignment? Only a claim we made may be rolled back below.
    let claimed = false;
    if (!task.assigneeId) {
      // Atomic self-assign (`update … where assignee_id is null`). A lost race is not a DB
      // error, it is zero updated rows — hence `undefined` rather than a throw.
      const won = await claimTask(client, taskId, userId);
      if (!won) throw new Error("task already claimed");
      claimed = true;
    }

    const local = this.registry.listProjects().find((p) => p.id === task.projectId);
    if (!local?.localRepoPath) throw new Error("project not bound");

    // D1: the local row is the binding AND the offline config cache. Refresh it while we
    // are demonstrably online, so the next launch of this project needs no network at all.
    const cloudProject = (await listProjects(client)).find((p) => p.id === task.projectId);
    const project = cloudProject
      ? this.registry.patchProject(local.id, {
          name: cloudProject.name,
          color: cloudProject.color,
          previewCommand: cloudProject.previewCommand,
          apiCommand: cloudProject.apiCommand,
          carryFiles: cloudProject.carryFiles,
          defaultBranch: cloudProject.defaultBranch,
          defaultModel: cloudProject.defaultModel,
          defaultEffort: cloudProject.defaultEffort,
          conventions: cloudProject.conventions,
        })
      : local;

    // The board stores launch params as free text; validate them against the local
    // vocabularies instead of casting, so a bad card cannot produce a bogus branch prefix.
    const prefix: BranchPrefix = (BRANCH_PREFIXES as readonly string[]).includes(task.prefix ?? "")
      ? (task.prefix as BranchPrefix)
      : "feature";
    const platform = (PLATFORMS as readonly string[]).includes(task.platform ?? "")
      ? (task.platform as Session["platform"])
      : undefined;

    // A shared card must never commandeer another developer's checkout, which is what the
    // hardcoded `true` here used to guarantee. The in-place option is personal, so it
    // survives exactly for the person who filed the card — for anybody else the card is
    // isolated, whatever it says.
    const inPlace = task.worktree === false && task.createdBy === userId;
    const worktree = !inPlace;

    const { branch, baseBranch } = await this.resolveLaunchParams(
      project,
      task.title,
      prefix,
      worktree,
      undefined,
      task.branch ?? project.defaultBranch,
    );
    const session = this.registry.createSession({
      projectId: project.id,
      taskId: task.id,
      name: task.title,
      task: task.description ?? task.title,
      worktreePath: "",
      branch,
      worktree,
      baseBranch,
      model: task.model,
      // Unvalidated, exactly like `model`: the board stores a free-text launch parameter and
      // omp is the only authority on what it accepts — clamping happens there, not here.
      effort: task.effort,
      prefix,
      platform,
      runtime: this.runtimeFor(),
    });
    try {
      return await this.launch(session, project, { images });
    } catch (err) {
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      // A launch that never started must not leave the card pinned to whoever failed to
      // start it — nobody else could then pick it up. Release ONLY a claim we just made;
      // a pre-existing assignment is somebody's deliberate state and stays. The cloud
      // status is still `backlog` here, so `tasks_guard()` permits the write.
      if (claimed)
        await patchTask(client, taskId, { assigneeId: null }).catch((e: unknown) =>
          console.warn(`[supervisor] could not release the claim on task ${taskId}: ${(e as Error).message}`),
        );
      throw err;
    }
  }


  // A quick chat: an instant, git-free omp conversation in the project dir with a read-only
  // tool subset. No branch, no worktree, no opening prompt — it spawns ready and the operator
  // sends the first message. It can later be promoted (forked) into a real agent, so a throwaway
  // exploration becomes real work without losing context.
  async createChat(projectId: string): Promise<Session> {
    const project = this.boundProject(projectId);
    const n = this.registry.listSessions(projectId).filter((s) => s.kind === "chat").length + 1;
    const session = this.registry.createSession({
      projectId, name: `чат ${n}`, task: "", worktreePath: "", branch: "",
      worktree: false, kind: "chat", status: "queued", runtime: "omp",
    });
    const configPath = await this.ompSkills(project.id, project.localRepoPath, session.id);
    const extensionPath = await this.ompTriggers(project.id, project.localRepoPath, session.id);
    const rpc = new RpcSession({ cwd: project.localRepoPath, tools: CHAT_TOOLS, ...(configPath ? { configPath } : {}), ...(extensionPath ? { extensionPath } : {}) });
    const live = this.wireLive(session.id, rpc, "queued");
    try {
      await rpc.start();
      // Let the startup event burst (ready/setWidget/available_commands) flow through onRpcEvent
      // first, then mark the chat idle-ready — otherwise those events reset live status to "queued".
      await this.refreshState(session.id);
      live.state = { status: "done" };
      live.live.status = "done";
      this.registry.updateSession(session.id, { status: "done" });
    } catch (err) {
      this.stopPoll(live);
      await rpc.stop().catch(() => {});
      this.map.delete(session.id);
      this.toolDetails.dropSession(session.id);
      this.skillLabels.delete(session.id);
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    this.pushUpdate(session.id);
    return this.merge(session);
  }

  // Mature a chat into a real agent IN PLACE: the same row — same id, same conversation, same
  // board entry — grows a branch and a worktree, forks its omp conversation into that worktree
  // with the full toolset, and is immediately told to build what was just discussed. One thing
  // that goes from "we're talking about it" to "it's being built"; there is no second row and
  // nothing to fill in, so the operator's click is the whole ceremony.
  async promoteChatToAgent(chatId: string, taskId: string): Promise<Session> {
    const chat = this.registry.listSessions().find((x) => x.id === chatId);
    if (!chat) throw new Error("session not found");
    if (chat.kind !== "chat") throw new Error("not a chat session");
    const project = this.boundProject(chat.projectId);

    let chatFile = chat.ompSessionFile;
    if (!chatFile) {
      await this.refreshState(chatId);
      chatFile = this.registry.listSessions().find((x) => x.id === chatId)?.ompSessionFile;
    }
    if (!chatFile)
      throw new Error("chat has no omp session yet — send a message before starting implementation");

    const live = this.map.get(chatId);
    if (live && (live.state.status === "thinking" || live.state.status === "tool"))
      throw new Error("wait for the chat to finish its turn before starting implementation");

    // Everything the launcher used to ask for is derived: the chat's opening message is the
    // task, its first line the name, and the rest are the project's defaults.
    const name = taskNameFromText(chat.task) || chat.name;
    const { branch, baseBranch } = await this.resolveLaunchParams(project, name, "feature", true, chatId);
    const block = await this.assignedBlockFor(chat.projectId, "promote", project.localRepoPath);
    const prompt = renderInstruction(agentById("promote")!, { branch }) + block;

    // The read-only child must die before the worktree one takes over this row's event stream.
    if (live) {
      this.stopPoll(live);
      await live.rpc.stop().catch(() => {});
      this.map.delete(chatId);
      this.toolDetails.dropSession(chatId);
      this.skillLabels.delete(chatId);
    }
    // The cloud identity arrives with the promotion: the caller mints the card — the UI on
    // the human path, the supervisor itself for a trigger-driven promotion — and hands the id
    // over here. It is stamped by the SAME write that turns the row into an agent, and still
    // BEFORE the launch, so a running agent always carries it and the board can see it. Not
    // earlier: CloudSyncService mirrors any session that carries a taskId, so a row that is
    // (or becomes) a chat again must not hold the link — otherwise every later chat turn
    // would flip an orphaned card to done/thinking on the shared board. A throw before this
    // point therefore never links the chat at all, and the catch below unlinks it again.
    const session = this.registry.updateSession(chatId, {
      taskId, name, kind: "agent", worktree: true, branch, baseBranch, worktreePath: "", prefix: "feature", status: "queued",
    });
    try {
      return await this.launch(session, project, { fork: chatFile, firstPrompt: prompt });
    } catch (err) {
      // Back to being a chat, and back to being unlinked: the row keeps its conversation, and
      // the next message resumes its read-only omp child through doResume.
      this.registry.updateSession(chatId, {
        taskId: undefined, name: chat.name, kind: "chat", worktree: false, branch: "", baseBranch: undefined,
        worktreePath: "", prefix: undefined, status: "done",
      });
      this.pushUpdate(chatId);
      throw err;
    }
  }

  // In-place guards + a de-duplicated branch name, shared by every birth path of an agent
  // (createSessionFromTask, promoteChatToAgent) and by attaching a worktree to an existing
  // session. excludeId keeps a session from colliding with or blocking itself.
  private async resolveLaunchParams(
    project: Project,
    name: string,
    prefix: BranchPrefix,
    worktree: boolean,
    excludeId?: string,
    requestedBase?: string,
  ): Promise<{ branch: string; baseBranch?: string }> {
    // Belt and braces: every caller already went through boundProject, but this is the last
    // point before git side effects, and an unbound path ("") would resolve to the api's cwd.
    if (!project.localRepoPath) throw new Error("project not bound");
    let baseBranch: string | undefined;
    if (!worktree) {
      if (await this.worktree.hasUncommitted(project.localRepoPath))
        throw new Error("project working tree must be clean to create an in-place (non-worktree) agent");
      // A pre-cutover backlog leftover never launched, so it never occupies the in-place slot.
      const activeInPlace = this.registry
        .listSessions(project.id)
        .some((s) => s.id !== excludeId && !s.worktree && s.kind !== "discussion" && s.kind !== "review" && s.status !== "merged" && s.status !== "backlog");
      if (activeInPlace)
        throw new Error("an in-place agent is already active in this project — finish or delete it first");
      baseBranch = await this.worktree.currentBranch(project.localRepoPath);
      if (!baseBranch) throw new Error("project has a detached HEAD — checkout a branch first");
    } else {
      // Worktree agents fork from the chosen base: explicit pick > project default > current HEAD.
      baseBranch = requestedBase ?? project.defaultBranch ?? undefined;
    }
    const existing = new Set(
      this.registry.listSessions(project.id).filter((s) => s.id !== excludeId).map((s) => s.branch).filter(Boolean),
    );
    const branch = uniqueSlug(branchName(slugify(name), prefix), existing);
    return { branch, baseBranch };
  }

  // Per-user preference (Inc 2): env override → cached cloud preference → omp.
  private runtimeFor(_session?: Session): AgentRuntimeKind {
    return resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime);
  }

  // Create the git isolation (worktree or in-place branch), spawn the omp child, and kick off
  // the first turn. `fork` seeds the child from a prior omp conversation (chat → agent) and
  // rehydrates its history; `firstPrompt` overrides the opening message sent (defaults to the
  // task), and an empty one lands the session idle — a forked agent that just continues the
  // chat. On failure it undoes any git side effects and rethrows; the caller owns the
  // registry-row rollback (remove vs return-to-backlog).
  private async launch(
    session: Session,
    project: Project,
    opts: { images?: ImageInput[]; fork?: string; firstPrompt?: string } = {},
  ): Promise<Session> {
    const { id, branch, worktree, baseBranch, task, model, effort } = session;
    if (!project.localRepoPath) throw new Error("project not bound");
    const { images, fork } = opts;
    const firstPrompt = opts.firstPrompt ?? task;
    let wtDir = "";
    let branchCreated = false;
    try {
      if (worktree) {
        wtDir = worktreeDir(id);
        await this.worktree.addWorktree(project.localRepoPath, wtDir, branch, baseBranch);
        branchCreated = true;
        await copyCarryFiles(project.localRepoPath, wtDir, project.carryFiles ?? [".env"]);
      } else {
        await this.worktree.createBranchHere(project.localRepoPath, branch);
        branchCreated = true;
      }
    } catch (err) {
      if (wtDir) await this.worktree.removeWorktree(project.localRepoPath, wtDir).catch(() => {});
      if (branchCreated) await this.worktree.removeBranch(project.localRepoPath, branch).catch(() => {});
      throw err;
    }
    const saved = worktree ? this.registry.updateSession(id, { worktreePath: wtDir }) : session;

    const cwd = worktree ? wtDir : project.localRepoPath;
    const configPath = await this.ompSkills(project.id, cwd, id);
    const extensionPath = await this.ompTriggers(project.id, cwd, id);
    const rpc = createRuntime(session.runtime ?? "omp", { cwd, model, ...(effort ? { thinking: effort } : {}), ...(fork ? { fork } : {}), ...(configPath ? { configPath } : {}), ...(extensionPath ? { extensionPath } : {}) });
    const live = this.wireLive(id, rpc, "queued");
    try {
      await rpc.start();
      // A forked child inherits the source conversation — surface its history before the turn.
      if (fork) {
        this.rehydrate(live, id, await rpc.getAllMessages());
        this.events.next({ type: "transcript_reset", sessionId: id, entries: live.transcript });
      }
      if (firstPrompt.trim()) {
        this.appendEntry(id, this.userEntry(firstPrompt, images));
        rpc.prompt(firstPrompt, images);
      } else {
        // No opening message (a forked agent continuing the chat) — sit idle, ready for input.
        live.live.status = "done";
        this.registry.updateSession(id, { status: "done" });
      }
    } catch (err) {
      this.stopPoll(live);
      await rpc.stop().catch(() => {});
      if (worktree) {
        await this.worktree.removeWorktree(project.localRepoPath, wtDir).catch(() => {});
      } else if (baseBranch) {
        await this.worktree.checkout(project.localRepoPath, baseBranch, { force: true }).catch(() => {});
      }
      await this.worktree.removeBranch(project.localRepoPath, branch).catch(() => {});
      this.map.delete(id);
      this.toolDetails.dropSession(id);
      this.skillLabels.delete(id);
      throw err;
    }
    this.pushUpdate(id);
    return this.merge(saved);
  }

  // Fork a discussion child off a parent's omp conversation (tip-level). The child
  // runs in the parent's directory with no git and no editing tools, so the parent's
  // context is never touched and both run in parallel.
  async branchSession(parentId: string): Promise<Session> {
    const s = this.registry.listSessions().find((x) => x.id === parentId);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.kind !== "agent") throw new Error("can only branch an agent session");

    let parentFile = s.ompSessionFile;
    if (!parentFile) {
      await this.refreshState(parentId);
      parentFile = this.registry.listSessions().find((x) => x.id === parentId)?.ompSessionFile;
    }
    if (!parentFile) throw new Error("agent has no omp session yet — send a first message before branching");

    const live = this.map.get(parentId);
    if (live && (live.state.status === "thinking" || live.state.status === "tool"))
      throw new Error("wait for the agent to finish its turn before branching");

    const cwd = s.worktreePath || g.localRepoPath;
    const child = this.registry.createSession({
      projectId: s.projectId,
      name: `гілка: ${s.name}`,
      task: "",
      worktreePath: "",
      branch: "",
      worktree: false,
      kind: "discussion",
      parentSessionId: parentId,
      runtime: "omp",
    });

    const configPath = await this.ompSkills(s.projectId, cwd, child.id);
    const extensionPath = await this.ompTriggers(s.projectId, cwd, child.id);
    const rpc = new RpcSession({ cwd, fork: parentFile, noTools: true, ...(configPath ? { configPath } : {}), ...(extensionPath ? { extensionPath } : {}) });
    const childLive = this.wireLive(child.id, rpc, "queued");
    try {
      await rpc.start();
      this.rehydrate(childLive, child.id, await rpc.getAllMessages());
      this.events.next({ type: "transcript_reset", sessionId: child.id, entries: childLive.transcript });
      await this.refreshState(child.id);
      childLive.live.status = "done";
      this.registry.updateSession(child.id, { status: "done" });
    } catch (err) {
      this.stopPoll(childLive);
      await rpc.stop().catch(() => {});
      this.map.delete(child.id);
      this.toolDetails.dropSession(child.id);
      this.skillLabels.delete(child.id);
      this.registry.removeSession(child.id);
      this.events.next({ type: "session_removed", sessionId: child.id });
      throw err;
    }
    this.pushUpdate(child.id);
    return this.merge(child);
  }

  // Request an INDEPENDENT reviewer for a finished agent: spawn a FRESH omp session
  // (no --fork, so no shared context) with a read-only tool subset in the doer's
  // worktree, seeded with the original task + the branch diff. It audits with fresh
  // eyes; its conclusion can be poured back into the doer via mergeDiscussion.
  async reviewSession(parentId: string): Promise<Session> {
    const s = this.registry.listSessions().find((x) => x.id === parentId);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.kind !== "agent") throw new Error("only agent sessions can be reviewed");

    const live = this.map.get(parentId);
    if (live && (live.state.status === "thinking" || live.state.status === "tool"))
      throw new Error("wait for the agent to finish its turn before requesting a review");

    const cwd = s.worktreePath || g.localRepoPath;
    const base = s.worktree ? await this.worktree.currentBranch(g.localRepoPath) : (s.baseBranch ?? "");
    const diff = await this.worktree.diff(cwd, base);
    if (!diff.trim()) throw new Error("nothing to review — the branch has no changes yet");

    const child = this.registry.createSession({
      projectId: s.projectId,
      name: `ревізія: ${s.name}`,
      task: s.task,
      worktreePath: "",
      branch: "",
      worktree: false,
      kind: "review",
      parentSessionId: parentId,
      runtime: "omp",
    });

    const block = await this.assignedBlockFor(s.projectId, "review", cwd);
    const prompt =
      renderInstruction(agentById("review")!, { task: s.task, base, branch: s.branch, diff }) + block;

    const configPath = await this.ompSkills(s.projectId, cwd, child.id);
    const extensionPath = await this.ompTriggers(s.projectId, cwd, child.id);
    const rpc = new RpcSession({ cwd, tools: ["read", "grep", "glob"], ...(configPath ? { configPath } : {}), ...(extensionPath ? { extensionPath } : {}) });
    const childLive = this.wireLive(child.id, rpc, "queued");
    try {
      await rpc.start();
      this.appendEntry(child.id, this.userEntry(prompt));
      rpc.prompt(prompt);
    } catch (err) {
      this.stopPoll(childLive);
      await rpc.stop().catch(() => {});
      this.map.delete(child.id);
      this.toolDetails.dropSession(child.id);
      this.skillLabels.delete(child.id);
      this.registry.removeSession(child.id);
      this.events.next({ type: "session_removed", sessionId: child.id });
      throw err;
    }
    this.pushUpdate(child.id);
    return this.merge(child);
  }
  // Pour a discussion or review child back into its parent: inject a (reviewed) summary
  // as a message into the parent's live conversation, then retire the child as merged.
  async mergeDiscussion(childId: string, summary?: string): Promise<{ merged: true }> {
    const c = this.registry.listSessions().find((x) => x.id === childId);
    if (!c) throw new Error("session not found");
    if ((c.kind !== "discussion" && c.kind !== "review") || !c.parentSessionId)
      throw new Error("not a discussion or review branch");
    const parentId = c.parentSessionId;

    const live = this.map.get(childId);
    const last = [...(live?.transcript ?? [])]
      .reverse()
      .find((e) => e.kind === "assistant_text") as { kind: "assistant_text"; text: string } | undefined;
    const text = (summary?.trim() || last?.text || "").trim();
    if (!text) throw new Error("nothing to merge — the branch has no conclusion yet");
    const label = c.kind === "review" ? `Ревізія «${c.name}»` : `Висновок гілки «${c.name}»`;
    const wrapped = `[${label}]: ${text}`;

    const parentLive = this.map.get(parentId);
    const mode: "prompt" | "follow_up" =
      parentLive && (parentLive.state.status === "thinking" || parentLive.state.status === "tool")
        ? "follow_up"
        : "prompt";
    // sendMessage resumes a dormant parent; if it throws, the child is left intact.
    await this.sendAsKermanych(parentId, wrapped, mode);

    if (live) {
      live.live.status = "stopped";
      this.stopPoll(live);
      await live.rpc.stop();
      this.map.delete(childId);
      this.toolDetails.dropSession(childId);
      this.skillLabels.delete(childId);
    }
    this.registry.updateSession(childId, { status: "merged" });
    this.pushUpdate(childId);
    return { merged: true };
  }

  private appendEntry(id: string, entry: TranscriptEntry) {
    const l = this.map.get(id)!;
    l.transcript.push(entry);
    this.events.next({ type: "transcript_append", sessionId: id, entry });
  }

  // Rebuild a transcript from omp's converted history and file the full tool output that
  // came with it, so a row opened after a reload can still expand through
  // GET /sessions/:id/tools/:callId instead of 410-ing.
  private rehydrate(l: Live, id: string, messages: unknown[]) {
    const { entries, full } = messagesToTranscript(messages, { skillSource: this.skillSource(id) });
    l.transcript = entries;
    for (const [callId, lines] of full) this.toolDetails.put(id, callId, lines);
  }

  // Complete a pending tool row in place from the reduced patch and notify clients.
  // Match by exact toolCallId when omp provides one, else the oldest pending
  // entry of the same tool name (FIFO — correct for interchangeable parallel calls).
  // `toolRowMatches` is the shared rule: the patch's tool name comes off the wire, where a
  // skill row still reads `read`, and for a frame with no toolCallId the id clause cannot
  // match at all — the reducer minted the patch id from the end stamp, the row from the start.
  private finishTool(id: string, patch: Extract<TranscriptEntry, { kind: "tool" }>, lines?: ToolLine[]) {
    const l = this.map.get(id);
    if (!l) return;
    const entry =
      l.transcript.find((x) => x.kind === "tool" && x.id === patch.id) ??
      l.transcript.find((x) => x.kind === "tool" && x.status === "pending" && toolRowMatches(x.tool, patch.tool));
    // The call is over either way: release its streaming state under both ids, since a frame
    // with no toolCallId makes the reducer mint one that differs from the row's.
    l.toolStarted.delete(patch.id);
    l.toolArgs.delete(patch.id);
    if (!entry || entry.kind !== "tool") return;
    // An unlabelled call makes the reducer mint an id it cannot correlate, so it returns no
    // wall time — but the row's own start stamp is right here, and `patch.at` is the end stamp.
    const started = l.toolStarted.get(entry.id);
    l.toolStarted.delete(entry.id);
    l.toolArgs.delete(entry.id);
    // Filed under the row's own id, not the frame's, or the expand endpoint would look in the
    // wrong slot for exactly the calls omp did not label.
    if (lines?.length) this.toolDetails.put(id, entry.id, lines);
    entry.status = patch.status;
    entry.stat = patch.stat;
    entry.count = patch.count;
    entry.ms = patch.ms ?? (started === undefined ? undefined : patch.at - started);
    entry.detail = patch.detail;
    // The patch only carries a target when the result improved on the one derived at call time.
    if (patch.target) entry.target = patch.target;
    // `target` rides along too: it is the one display field the result can improve on, so
    // omitting it left the client's copy of the row disagreeing with GET /sessions/:id/transcript.
    this.events.next({
      type: "transcript_update", sessionId: id, id: entry.id, status: entry.status as "ok" | "error",
      target: entry.target, stat: entry.stat, count: entry.count, ms: entry.ms, detail: entry.detail,
    });
  }

  // Strictly increasing so every entry gets a distinct id, even when two frames land in
  // the same millisecond.
  private stamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  // Echo the user's own message (initial task or follow-up) into the transcript so
  // the log reads as a full conversation. Images ride along as data URLs for render.
  private userEntry(text: string, images?: ImageInput[]): TranscriptEntry {
    const at = this.stamp();
    return { kind: "user_text", id: `u${at}`, at, text, ...(images?.length ? { images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) } : {}) };
  }

  // A Kermanych-authored row in the conversation. A fired trigger changed what the child was
  // asked, so the transcript has to say so: an invisible trigger is a session that behaves
  // differently for no reason the operator can read back.
  private noticeEntry(notice: string | Notice, level: "info" | "warn" | "error" = "info"): TranscriptEntry {
    const at = this.stamp();
    const n: Notice = typeof notice === "string" ? { text: notice } : notice;
    return {
      kind: "notice",
      id: `n${at}`,
      at,
      level,
      text: n.text,
      ...(n.code ? { code: n.code } : {}),
      ...(n.params ? { params: n.params } : {}),
    };
  }

  private onRpcEvent(id: string, e: RpcEvent) {
    const l = this.map.get(id);
    if (!l) return;
    // Progress heartbeat (in-memory) — distinct from last_activity_at, which user sends also
    // bump. The UI uses this to spot a wedged turn. `response` frames are replies to the
    // supervisor's OWN commands (chiefly the 2s get_state poll below), not agent progress:
    // counting them is what made a wedged turn invisible — the poll kept answering, so
    // lastEventAt never aged and the stall banner never fired. Only genuine agent events count
    // here; refreshState keeps the heartbeat alive across long, event-quiet turns via isStreaming.
    if (e.type !== "response") {
      l.live.lastEventAt = Date.now();
      // Any agent event counts as activity, except per-token streaming deltas
      // (message_update) — bumping per token would mean a DB write per token.
      if (e.type !== "message_update") {
        try {
          this.registry.touchSession(id);
        } catch {
          /* never let a bookkeeping write break the event stream */
        }
      }
    }
    const before = l.state.status;
    l.state = reduceStatus(l.state, e);
    // One reducer for the live stream and for rehydrated history, so a session that
    // streamed and the same session after a reload produce identical entries.
    const reduced = reduceRpcEvents([e], {
      now: () => this.stamp(),
      textBuf: l.textBuf,
      thinkBuf: l.thinkBuf,
      startedAt: l.toolStarted,
      pendingArgs: l.toolArgs,
      skillSource: this.skillSource(id),
    });
    l.textBuf = reduced.textBuf;
    l.thinkBuf = reduced.thinkBuf;
    let spent = false;
    for (const entry of reduced.entries) {
      // A completion carries no new entry — it patches the pending one in place, and files its
      // full output under the id of the row it actually patched.
      if (entry.kind === "tool" && entry.status !== "pending") this.finishTool(id, entry, reduced.full.get(entry.id));
      else this.appendEntry(id, entry);
      // A finished turn is the only frame carrying accounting; fold it into the session's
      // lifetime total. LIVE turns only — rehydrate() replays omp's history into the
      // transcript on every resume AND on every fork, so counting there would both double
      // count a resumed agent and bill a discussion branch for its parent's turns. The
      // price of that rule: agents whose turns predate this counter stay blank rather than
      // guess, which is the same contract every other figure in the app keeps.
      if (entry.kind === "turn" && entry.usage) {
        try {
          this.registry.addUsage(id, entry.usage);
          spent = true;
        } catch {
          /* never let a bookkeeping write break the event stream */
        }
      }
    }
    // RpcEvent carries an index-signature fallback member; Extract recovers the concrete typed member.
    if (e.type === "extension_ui_request" && l.state.status === "waiting_input")
      l.live.pendingUiRequest = e as Extract<RpcEvent, { type: "extension_ui_request" }>;
    l.live.status = l.state.status;
    l.live.currentTool = l.state.currentTool;
    if (l.state.status !== "waiting_input") l.live.pendingUiRequest = undefined;
    if (e.type === "agent_end" && (e as Extract<RpcEvent, { type: "agent_end" }>).isTerminal !== false) {
      this.registry.updateSession(id, { status: "done" });
      this.refreshState(id);
      this.stopPoll(l);
      // A turn cannot end with a tool still running, so anything left here belongs to a call
      // that was aborted and will never send its end frame. Without this the maps only shrink.
      l.toolStarted.clear();
      l.toolArgs.clear();
    }
    if ((l.state.status === "thinking" || l.state.status === "tool") && !l.poll)
      l.poll = setInterval(() => this.refreshState(id), 2000);
    if (before !== l.state.status || e.type === "tool_execution_start" || spent) this.pushUpdate(id);
  }

  private stopPoll(l: Live) {
    if (l.poll) {
      clearInterval(l.poll);
      l.poll = undefined;
    }
  }
  private async refreshState(id: string) {
    const l = this.map.get(id);
    if (!l) return;
    try {
      const st = await l.rpc.getState();
      l.live.contextPercent = st.contextUsage?.percent;
      l.live.todoPhases = st.todoPhases;
      // isStreaming is true for the whole active turn — thinking, model streaming, AND
      // minutes-long tool calls — and flips false only when the agent run ends. Treat it as the
      // real progress heartbeat: a busy-but-event-quiet turn (e.g. a long subagent) stays fresh,
      // so it never trips a false stall; a turn that ended without a terminal agent_end reaching
      // us (a stalled provider stream) lets lastEventAt age so the UI surfaces the stall + restart.
      if (st.isStreaming) {
        l.live.lastEventAt = Date.now();
        try {
          this.registry.touchSession(id);
        } catch {
          /* bookkeeping only */
        }
      }
      if (st.sessionId || st.sessionFile)
        this.registry.updateSession(id, { ompSessionId: st.sessionId, ompSessionFile: st.sessionFile });
      // omp picks the model itself when the launch left it unset — a discussion branch, a
      // review, a chat — and the board has to be able to name what is actually running.
      // Settled once per child: omp is spawned with a fixed `--model`, so there is nothing
      // to re-read on later polls. An operator's explicit choice is never overwritten; that
      // value is the launch parameter a relaunch reuses, not a reading of the current run.
      if (!l.modelResolved && st.model?.id) {
        l.modelResolved = true;
        if (!this.registry.listSessions().find((x) => x.id === id)?.model)
          this.registry.updateSession(id, { model: st.model.id });
      }
      // Reasoning effort, unlike the model, is LIVE state: omp accepts `set_thinking_level`
      // mid-session (from the composer here, or from omp's own UI in a shared session file),
      // so every poll reconciles rather than settling once. A write only when the value moved
      // keeps this off the hot path — the poll runs every couple of seconds per live child.
      if (st.thinkingLevel && this.registry.listSessions().find((x) => x.id === id)?.effort !== st.thinkingLevel)
        this.registry.updateSession(id, { effort: st.thinkingLevel });
      this.pushUpdate(id);
    } catch {}
  }

  // The Live to write to, respawning when there is none to write to. A dormant session (no
  // Live) resumes; a *dead* Live — the omp child exited, e.g. a provider outage killed it
  // after the turn ended — must ALSO resume, not be written to. A write to a dead child's
  // stdin raises EPIPE, which RpcSession swallows, so the message would vanish with no error
  // and the agent would look "hung". Drop the corpse and respawn.
  private async liveOrResume(id: string): Promise<Live> {
    const l = this.map.get(id);
    if (l?.rpc.isAlive()) {
      // A send or wake is activity: stamp it now so the idle reaper never stops a child we are
      // about to write to — the child's own events only stamp lastEventAt once the turn starts.
      l.live.lastEventAt = Date.now();
      return l;
    }
    if (l) {
      this.stopPoll(l);
      this.map.delete(id);
      this.toolDetails.dropSession(id);
      this.skillLabels.delete(id);
    }
    return this.resumeSession(id);
  }

  // Wake a session without prompting it: the omp child respawns, switch_session reloads its
  // saved transcript and doResume broadcasts `transcript_reset`, which is the whole point —
  // after an app restart getTranscript() has nothing but the "dormant" notice to serve, so the
  // chat reads empty until something rehydrates it. Deliberately NOT restartSession: this must
  // never kill a live child, so pressing it mid-turn cannot destroy the running turn.
  async resume(id: string): Promise<{ ok: true }> {
    await this.liveOrResume(id);
    return { ok: true };
  }

  // The OPERATOR's own message. Everything Kermanych sends itself goes through
  // `sendAsKermanych`, which is the same delivery with the operator's own affordances off.
  async sendMessage(id: string, text: string, mode: "prompt" | "follow_up" | "steer", images?: ImageInput[]) {
    await this.deliver(id, text, mode, images, true);
  }

  // Kermanych's own prompt into a session: a fired trigger's agent, a PR request, a merged
  // discussion's conclusion. Trigger matching and helper expansion both exist for text a
  // HUMAN wrote, so these are exempt — which is also what stops a fired `agent` action from
  // looping through the very agent it ran, and what keeps a machine-authored prompt that
  // happens to open with a slash from being rewritten. The exemption is an ARGUMENT, not a
  // flag on the session: a genuine operator message arriving while this send is still in
  // flight is treated as normal, because a trigger that silently does not fire is the failure
  // this feature exists to remove.
  private async sendAsKermanych(id: string, text: string, mode: "prompt" | "follow_up" | "steer") {
    await this.deliver(id, text, mode, undefined, false);
  }

  private async deliver(
    id: string,
    text: string,
    mode: "prompt" | "follow_up" | "steer",
    images: ImageInput[] | undefined,
    fromOperator: boolean,
  ) {
    const l = await this.liveOrResume(id);
    try {
      this.registry.touchSession(id);
    } catch {
      /* never let a bookkeeping write break message delivery */
    }
    const s = this.registry.listSessions().find((x) => x.id === id);
    // A chat's opening message IS the ask. Record it once, so promoting the chat can name the
    // agent and its branch after the thing being built, and so review/PR prompts have a task.
    if (text.trim() && s?.kind === "chat" && !s.task.trim()) this.registry.updateSession(id, { task: text.trim() });
    if (text.trim() || images?.length) this.appendEntry(id, this.userEntry(text, images));

    // Operator-sourced triggers run BEFORE the message reaches the child: Kermanych is the
    // only party that sees the operator's text, and an `agent` action has to be Kermanych's
    // to perform — a child cannot call back into us.
    const fired = fromOperator && s ? await this.matchOperatorTriggers(s, id, text) : undefined;
    if (fired?.trigger.action === "agent" && (await this.runTriggerAgent(id, fired.trigger))) return;
    // Хелпери are expanded AFTER the trigger match, and the match runs on the operator's raw
    // text on purpose: a pattern that happens to appear inside a helper's instruction must not
    // fire a trigger the operator never wrote for.
    const helped = fromOperator ? expandHelpers(text) : { text, used: [] };
    if (helped.used.length) this.appendEntry(id, this.noticeEntry(helperNotice(helped.used)));
    // `skill`: the resolved body goes in FRONT of what the operator wrote, so the instruction
    // is read before the request it applies to. The transcript keeps the operator's own text
    // as the visible row and the notices above say what was prepended to it.
    const body = fired?.block ? `${fired.block}\n\n${helped.text}` : helped.text;
    if (mode === "steer") l.rpc.steer(body, images);
    else if (mode === "follow_up") l.rpc.followUp(body, images);
    else l.rpc.prompt(body, images);
  }

  // The first enabled `operator` trigger whose pattern matches, with its `skill` body already
  // resolved. Never throws and never blocks a message: a trigger is an addition to a session.
  private async matchOperatorTriggers(
    s: Session,
    id: string,
    text: string,
  ): Promise<{ trigger: ProjectTrigger; block: string } | undefined> {
    // Past the cap no trigger fires. That is the degradation everything else on this path
    // uses: never an exception, never a blocked message.
    if (!text.trim() || text.length > MATCH_MAX_CHARS) return undefined;
    try {
      const triggers = await this.skills.operatorTriggers(s.projectId);
      if (!triggers.length) return undefined;
      const cwd = s.worktreePath || this.registry.listProjects().find((p) => p.id === s.projectId)?.localRepoPath || "";
      for (const trigger of triggers) {
        // Case-insensitive: the pattern is matched against prose an operator typed, where the
        // capitalisation of a sentence is not a decision they made. An unparseable pattern
        // costs its own trigger and nothing else.
        let re: RegExp;
        try {
          re = new RegExp(trigger.pattern, "i");
        } catch {
          continue;
        }
        if (!re.test(text)) continue;
        if (trigger.action === "agent") {
          this.appendEntry(
            id,
            this.noticeEntry({
              // The fallback text names the raw agent id — the api has no vue-i18n to render
              // its label. A UI that knows the code renders `t('agents.role.<agent>')` for it.
              text: `тригер «${trigger.label}» запускає «${trigger.target}»`,
              code: "trigger_launches_agent",
              params: { trigger: trigger.label, agent: trigger.target },
            }),
          );
          return { trigger, block: "" };
        }
        // One resolver for every skill body in Kermanych, assignments and triggers alike.
        const { block, missing } = await this.skills.assignedForNames(s.projectId, [trigger.target], cwd);
        if (!block.trim()) {
          // Reported, not dropped: a trigger the operator believes is armed and which resolves
          // to nothing is exactly the state the dangling-reference UI exists to surface.
          this.appendEntry(
            id,
            this.noticeEntry(
              {
                text: `тригер «${trigger.label}»: скіл «${missing[0] ?? trigger.target}» не знайдено`,
                code: "trigger_skill_missing",
                params: { trigger: trigger.label, skill: missing[0] ?? trigger.target },
              },
              "warn",
            ),
          );
          return undefined;
        }
        this.appendEntry(
          id,
          this.noticeEntry({
            text: `тригер «${trigger.label}» додав скіл «${trigger.target}»`,
            code: "skill_added_by_trigger",
            params: { trigger: trigger.label, skill: trigger.target },
          }),
        );
        return { trigger, block };
      }
      return undefined;
    } catch (err) {
      console.warn(`[supervisor] operator triggers skipped for session ${id}: ${(err as Error).message}`);
      return undefined;
    }
  }

  // Run the agent an operator trigger names, REPLACING the message: the agent's own
  // instruction says what the operator asked for, so forwarding both would say it twice.
  // `false` means the agent never ran, and then the replacement is not earned — the caller
  // forwards the operator's text rather than swallowing it.
  private async runTriggerAgent(id: string, trigger: ProjectTrigger): Promise<boolean> {
    try {
      // The four agents a trigger can run. `finish` and `summary` are automations with no
      // model and no session of their own, so they are not reachable from here.
      if (trigger.target === "review") await this.reviewSession(id);
      else if (trigger.target === "promote") await this.promoteChatToAgent(id, await this.promotionCard(id));
      else if (trigger.target === "pull-request") await this.createPullRequest(id);
      else if (trigger.target === "resolve-conflict") await this.resolveConflict(id);
      else throw new Error(`агента «${trigger.target}» не існує`);
      return true;
    } catch (err) {
      this.appendEntry(
        id,
        this.noticeEntry(
          {
            text: `тригер «${trigger.label}» не запустив агента: ${(err as Error).message}`,
            code: "trigger_agent_launch_failed",
            params: { trigger: trigger.label, reason: (err as Error).message },
          },
          "error",
        ),
      );
      return false;
    }
  }

  // A trigger promotes with no human in the loop, so there is no UI to mint the card:
  // this is the ONE place apps/api creates a `tasks` row (it already claims, patches and
  // pushes status on them). Same fields the ChatPage promotion writes, and the same owner
  // — the machine's signed-in user, whose worktree is about to run it.
  private async promotionCard(id: string): Promise<string> {
    const chat = this.registry.listSessions().find((x) => x.id === id);
    if (!chat) throw new Error("session not found");
    if (chat.taskId) return chat.taskId;
    const userId = this.auth.current()?.userId;
    if (!userId) throw new Error("not signed in");
    const card = await createTask(this.auth.cloudClient(), {
      projectId: chat.projectId,
      title: taskNameFromText(chat.task) || chat.name,
      description: chat.task,
      ...(chat.model ? { model: chat.model } : {}),
      prefix: "feature",
      worktree: true,
      assigneeId: userId,
      createdBy: userId,
    });
    return card.id;
  }

  // Retune how hard the agent thinks, from the composer's effort chip. omp treats the level as
  // session state, so a LIVE child is told first and only then is the row written: a refused or
  // timed-out command must not leave the UI showing a level the agent is not running at. A
  // dormant or backlog row is persisted without waking anything — `doResume`/`launch` re-assert
  // it on the next spawn, and the state poll reconciles from omp either way.
  async setEffort(id: string, level: ThinkingLevel): Promise<Session> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const l = this.map.get(id);
    if (l?.rpc.isAlive()) await l.rpc.setThinkingLevel(level);
    const saved = this.registry.updateSession(id, { effort: level });
    this.pushUpdate(id);
    return this.merge(saved);
  }

  // The composer's model/effort picker on a RUNNING session. omp addresses a model by
  // provider + id (`set_model`), so a bare model needs the catalogue to resolve its provider;
  // effort is a level in its own right. The live child is told first, then the row is written,
  // so a refused command never leaves the UI naming a model the agent is not on. A dormant row
  // is just persisted — launch/doResume apply it on the next spawn, and the poll reconciles.
  async setSessionModel(id: string, patch: { model?: string; provider?: string; effort?: ThinkingLevel }): Promise<Session> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const l = this.map.get(id);
    if (l?.rpc.isAlive()) {
      if (patch.model) {
        const provider = patch.provider ?? (await this.models.provider(patch.model));
        if (!provider) throw new Error(`провайдера для моделі «${patch.model}» не знайдено`);
        await l.rpc.setModel(provider, patch.model);
      }
      if (patch.effort) await l.rpc.setThinkingLevel(patch.effort);
    }
    const saved = this.registry.updateSession(id, {
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.effort ? { effort: patch.effort } : {}),
    });
    this.pushUpdate(id);
    return this.merge(saved);
  }

  // AI conflict resolution: resume the session's agent in its mid-merge worktree and
  // task it with resolving the conflicts + committing the merge, so the branch becomes
  // mergeable. Progress streams on the session's normal event feed.
  async resolveConflict(id: string): Promise<{ ok: true }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    const dir = s.worktreePath || g.localRepoPath;
    const files = await this.worktree.unmergedFiles(dir);
    if (!files.length) throw new Error("no merge conflict to resolve");
    const block = await this.assignedBlockFor(s.projectId, "resolve-conflict", dir);
    const prompt =
      renderInstruction(agentById("resolve-conflict")!, { files: files.map((f) => `- ${f}`).join("\n") }) + block;
    await this.sendAsKermanych(id, prompt, "prompt");
    return { ok: true };
  }

  // Open a pull request for the session's branch by delegating to its own omp agent: it already
  // has the repo's CLAUDE.md/AGENTS.md (auto-loaded) in context, so it honours the repo's own
  // ### PR/Commit Conventions when present and Kermanych's fallback otherwise, then commits,
  // pushes, and opens the PR via `gh`. Async — progress streams on the session's normal feed,
  // mirroring resolveConflict; the branch/worktree are left intact (the PR lives on the remote).
  async createPullRequest(id: string): Promise<{ ok: true }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    if (s.kind !== "agent") throw new Error(`only agent sessions can open a pull request (this is a ${s.kind})`);
    const g = this.project(s.projectId);

    const baseHint = (s.baseBranch || g.defaultBranch || "").trim();
    const baseLine = baseHint
      ? `Target the PR at \`${baseHint}\`, unless the repo's PR conventions dictate a different base.`
      : `Target the PR at the repository's default branch, unless the repo's PR conventions dictate otherwise.`;

    const block = await this.assignedBlockFor(s.projectId, "pull-request", s.worktreePath || g.localRepoPath);
    const prompt =
      renderInstruction(agentById("pull-request")!, {
        branch: s.branch,
        conventions: (g.conventions || "").trim() || PR_CONVENTIONS_FALLBACK,
        baseLine,
      }) + block;

    await this.sendAsKermanych(id, prompt, "prompt");
    return { ok: true };
  }
  answerUi(id: string, res: RpcExtensionUIResponse) {
    this.map.get(id)?.rpc.answerUi(res);
  }
  async stopSession(id: string) {
    const l = this.map.get(id);
    if (!l) return;
    l.live.status = "stopped";
    this.stopPoll(l);
    await l.rpc.stop();
    this.registry.updateSession(id, { status: "stopped" });
    this.pushUpdate(id);
  }

  // Recover a wedged/stuck agent: kill the (possibly unresponsive) omp child and respawn it,
  // rehydrating the conversation from its saved session file. No prompt — a continuation.
  async restartSession(id: string): Promise<{ ok: true }> {
    const l = this.map.get(id);
    if (l) {
      this.stopPoll(l);
      await l.rpc.stop().catch(() => {});
      this.map.delete(id);
      this.toolDetails.dropSession(id);
      this.skillLabels.delete(id);
    }
    await this.resumeSession(id);
    return { ok: true };
  }
  async deleteSession(id: string) {
    // Cascade: discussion branches hang off this session — discard them first.
    for (const child of this.registry.listSessions().filter((x) => x.parentSessionId === id))
      await this.deleteSession(child.id);

    const s = this.registry.listSessions().find((x) => x.id === id);
    const l = this.map.get(id);
    if (l) {
      l.live.status = "stopped";
      this.stopPoll(l);
      await l.rpc.stop();
      this.map.delete(id);
      this.toolDetails.dropSession(id);
      this.skillLabels.delete(id);
    }
    if (s && s.kind !== "agent") {
      // No git: the child owns no branch/worktree; its cwd is the parent's.
      if (s.ompSessionFile) await rm(s.ompSessionFile, { force: true }).catch(() => {});
    } else if (s) {
      const g = this.registry.listProjects().find((x) => x.id === s.projectId);
      if (g?.localRepoPath) {
        if (s.worktree) {
          if (s.worktreePath) await this.worktree.removeWorktree(g.localRepoPath, s.worktreePath);
        } else if (s.baseBranch && (await this.worktree.currentBranch(g.localRepoPath)) === s.branch) {
          // Restore the project to its base branch (delete discards the session's in-progress work).
          await this.worktree
            .checkout(g.localRepoPath, s.baseBranch)
            .catch(() => this.worktree.checkout(g.localRepoPath, s.baseBranch!, { force: true }));
        }
        if (s.branch) await this.worktree.removeBranch(g.localRepoPath, s.branch);
      }
    }
    this.registry.removeSession(id);
    this.events.next({ type: "session_removed", sessionId: id });
  }

  // Archive/unarchive is a pure hide flag: it never touches the worktree or the omp
  // process. Archiving an active agent is refused (the UI also pre-checks and toasts).
  setArchived(id: string, archived: boolean): void {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    if (archived && ACTIVE_STATUSES.includes(this.merge(s).status)) {
      throw new Error("cannot archive an active agent");
    }
    this.registry.updateSession(id, { archived });
    this.pushUpdate(id);
  }

  // Preview of what "finish" will do: the target branch, how many commits land,
  // and whether the worktree has uncommitted work that would be auto-committed.
  async finishInfo(id: string): Promise<{ branch: string; target: string; ahead: number; dirty: boolean; conflicts: string[]; files: ChangedFile[] }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.worktree && !s.worktreePath) throw new Error("session has no worktree — reopen it to continue");
    const dir = s.worktreePath || g.localRepoPath;
    const target = s.worktree ? await this.worktree.currentBranch(g.localRepoPath) : (s.baseBranch ?? "");
    const ahead = target ? await this.worktree.aheadCount(g.localRepoPath, target, s.branch) : 0;
    const dirty = await this.worktree.hasUncommitted(dir);
    const conflicts = await this.worktree.unmergedFiles(dir);
    const files = await this.worktree.changedFiles(dir, target);
    return { branch: s.branch, target, ahead, dirty, conflicts, files };
  }

  // The Зміни tab opens one of the files `finishInfo` listed. Same worktree and same fork
  // point, so the summary and the diff can never disagree about what the session changed.
  async fileDiff(id: string, path: string): Promise<SplitDiff> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.worktree && !s.worktreePath) throw new Error("session has no worktree — reopen it to continue");
    const dir = s.worktreePath || g.localRepoPath;
    const target = s.worktree ? await this.worktree.currentBranch(g.localRepoPath) : (s.baseBranch ?? "");
    return this.worktree.fileDiff(dir, target, path);
  }

  // The Файли tab's two reads. Same directory resolution as fileDiff — the worktree, or the
  // project repo for an in-place session — and the path guard lives in the worktree service.
  async sessionTree(id: string, path: string): Promise<TreeEntry[]> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.worktree && !s.worktreePath) throw new Error("session has no worktree — reopen it to continue");
    const dir = s.worktreePath || g.localRepoPath;
    return this.worktree.listTree(dir, path);
  }

  async sessionFile(id: string, path: string): Promise<FileContent> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.worktree && !s.worktreePath) throw new Error("session has no worktree — reopen it to continue");
    const dir = s.worktreePath || g.localRepoPath;
    return this.worktree.readFileContent(dir, path);
  }

  // Merge the session's branch into the project's current branch, then retire the
  // worktree + branch and keep the session as `merged` history. On a content conflict
  // it instead pulls the target into the worktree (leaving markers to resolve in an
  // editor) and marks the session `conflict`; re-running after a resolve merges cleanly.
  async finishSession(id: string): Promise<{ merged: true; into: string; pushed?: boolean; reason?: string } | { conflict: true; files: string[] }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.kind !== "agent")
      throw new Error(`${s.kind} branches can't be finished — merge or discard instead`);

    if (s.worktree) {
      if (!s.worktreePath) throw new Error("session has no worktree");
      // Finish targets the branch the session forked from, not whatever the project repo is
      // checked out on — merging a session into an unrelated branch is how work used to land
      // in the wrong place. Fall back to the current branch only for a row that predates
      // baseBranch being recorded.
      const base = (s.baseBranch || (await this.worktree.currentBranch(g.localRepoPath))).trim();
      if (!base) throw new Error("project repo has a detached HEAD - checkout a branch first");
      if (base === s.branch) throw new Error("project repo is on the session branch itself");
      const cur = await this.worktree.currentBranch(g.localRepoPath);
      if (cur !== base)
        throw new Error(`project repo is on ${cur || "detached HEAD"}, not the session's base ${base} - checkout ${base} first`);
      // A prior conflict left the worktree mid-merge — it must be resolved before retrying.
      if ((await this.worktree.unmergedFiles(s.worktreePath)).length)
        throw new Error("worktree has unresolved conflicts - resolve them in the editor first");
      if (await this.worktree.hasUncommitted(s.worktreePath))
        await this.worktree.commitAll(s.worktreePath, `session work: ${s.name}`);

      // Fold the team's latest into the worktree FIRST, so `base` never receives a conflicted
      // merge and a conflict is resolved in the agent's own tree (re-finish continues after).
      const remote = await this.worktree.hasRemote(g.localRepoPath);
      if (remote) {
        await this.worktree.fetch(g.localRepoPath, "origin", base);
        const down = await this.worktree.mergeInto(s.worktreePath, `origin/${base}`);
        if (down.ok === false && down.conflict) {
          this.registry.updateSession(id, { status: "conflict" });
          this.pushUpdate(id);
          return { conflict: true, files: await this.worktree.unmergedFiles(s.worktreePath) };
        }
      }

      const res = await this.worktree.mergeBranch(g.localRepoPath, s.branch, `merge session: ${s.name}`);
      if (!res.ok) {
        if (!res.conflict) throw new Error(res.message); // e.g. dirty project tree
        // Pull the base into the worktree so the conflict can be resolved there.
        await this.worktree.mergeInto(s.worktreePath, base);
        this.registry.updateSession(id, { status: "conflict" });
        this.pushUpdate(id);
        return { conflict: true, files: await this.worktree.unmergedFiles(s.worktreePath) };
      }
      const l = this.map.get(id);
      if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); this.toolDetails.dropSession(id); this.skillLabels.delete(id); }
      await this.worktree.removeWorktree(g.localRepoPath, s.worktreePath);
      await this.worktree.removeBranch(g.localRepoPath, s.branch);
      this.registry.updateSession(id, { status: "merged", worktreePath: "" });
      this.pushUpdate(id);
      // Publish the merged base so local and origin never drift. On a race retry once inside
      // pushBase; a persistent block leaves the merge local and is reported to the caller.
      if (remote) {
        const pushed = await this.pushBase(g.localRepoPath, base);
        this.pushUpdate(id);
        return { merged: true, into: base, ...pushed };
      }
      return { merged: true, into: base };
    }

    // In-place: the local repo is checked out on the session branch. Merge it into base.
    const base = s.baseBranch;
    if (!base) throw new Error("in-place session has no base branch");
    const cur = await this.worktree.currentBranch(g.localRepoPath);
    if (cur !== s.branch)
      throw new Error(`project is not on ${s.branch} (on ${cur || "detached HEAD"}) - switch to it first`);
    if ((await this.worktree.unmergedFiles(g.localRepoPath)).length)
      throw new Error("project has unresolved conflicts - resolve them first");
    if (await this.worktree.hasUncommitted(g.localRepoPath))
      await this.worktree.commitAll(g.localRepoPath, `session work: ${s.name}`);

    await this.worktree.checkout(g.localRepoPath, base);
    const res = await this.worktree.mergeBranch(g.localRepoPath, s.branch, `merge session: ${s.name}`);
    if (!res.ok) {
      // Restore onto the session branch; on a content conflict leave markers there to resolve.
      await this.worktree.checkout(g.localRepoPath, s.branch);
      if (!res.conflict) throw new Error(res.message);
      await this.worktree.mergeInto(g.localRepoPath, base);
      this.registry.updateSession(id, { status: "conflict" });
      this.pushUpdate(id);
      return { conflict: true, files: await this.worktree.unmergedFiles(g.localRepoPath) };
    }
    const l = this.map.get(id);
    if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); this.toolDetails.dropSession(id); this.skillLabels.delete(id); }
    await this.worktree.removeBranch(g.localRepoPath, s.branch); // the local repo is left on base
    this.registry.updateSession(id, { status: "merged" });
    this.pushUpdate(id);
    return { merged: true, into: base };
  }

  // Publish `base` to origin after a finish. A non-fast-forward rejection means origin moved
  // since our fetch: fold it into the local base and retry once. A second rejection, or a
  // conflict folding origin in, leaves the merge standing locally and reports the block — the
  // operator pulls and pushes rather than the finish looping.
  private async pushBase(repoDir: string, base: string): Promise<{ pushed: true } | { pushed: false; reason: string }> {
    let p = await this.worktree.push(repoDir, "origin", base);
    if (p.ok) return { pushed: true };
    if (!p.rejected) return { pushed: false, reason: p.message };
    await this.worktree.fetch(repoDir, "origin", base);
    const m = await this.worktree.mergeBranch(repoDir, `origin/${base}`, `merge origin/${base}`);
    if (!m.ok)
      return { pushed: false, reason: m.conflict ? `origin/${base} has conflicting changes — pull and resolve` : m.message };
    p = await this.worktree.push(repoDir, "origin", base);
    return p.ok ? { pushed: true } : { pushed: false, reason: "origin moved again — pull and push" };
  }

  // Reopen a merged (retired) worktree agent: fork a fresh branch + worktree from the base
  // — which now holds the merged work — so the same session can continue and be finished again.
  // The omp child resumes lazily on the next message, rehydrating its saved conversation.
  async reopenSession(id: string): Promise<Session> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.kind !== "agent") throw new Error(`${s.kind} sessions can't be reopened`);
    if (!s.worktree) throw new Error("in-place sessions can't be reopened — create a new task");
    if (s.worktreePath) throw new Error("session already has a worktree");
    const { branch, baseBranch } = await this.resolveLaunchParams(g, s.name, s.prefix ?? "feature", true, id, s.baseBranch);
    const wtDir = worktreeDir(id);
    try {
      await this.worktree.addWorktree(g.localRepoPath, wtDir, branch, baseBranch);
      await copyCarryFiles(g.localRepoPath, wtDir, g.carryFiles ?? [".env"]);
    } catch (err) {
      await this.worktree.removeWorktree(g.localRepoPath, wtDir).catch(() => {});
      await this.worktree.removeBranch(g.localRepoPath, branch).catch(() => {});
      throw err;
    }
    const next = this.registry.updateSession(id, { status: "done", branch, baseBranch, worktreePath: wtDir });
    this.pushUpdate(id);
    return this.merge(next);
  }

  // Open the session's worktree in the user's editor ($KERMANYCH_EDITOR or `code`).
  openInEditor(id: string): { ok: true } {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listProjects().find((x) => x.id === s.projectId);
    const dir = s.worktreePath || g?.localRepoPath;
    if (!dir) throw new Error("project not bound");
    const editor = process.env.KERMANYCH_EDITOR || "code";
    const child = spawn(editor, [dir], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // editor binary missing — swallow, don't crash the api
    child.unref();
    return { ok: true };
  }
  getTranscript(id: string): TranscriptEntry[] {
    const l = this.map.get(id);
    if (l) return l.transcript;
    // Dormant: in the registry but no live process (e.g. after an api restart).
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (s) {
      // Synthesised on every read, never appended to a transcript, so a fixed id is enough.
      const dormant: Notice =
        s.status === "merged"
          ? {
              text: "Сесію влито в проєкт. Натисни «↻ Відновити» вгорі, щоб підняти worktree і продовжити.",
              code: "session_dormant_merged",
            }
          : {
              text: "Сесія неактивна. Надішли повідомлення, щоб відновити її та підтягнути історію.",
              code: "session_dormant_inactive",
            };
      return [{ kind: "notice", id: "dormant", at: Date.now(), level: "info", text: dormant.text, code: dormant.code }];
    }
    return [];
  }

  // Full tool output on demand. A miss means the FIFO cache dropped it (or the API
  // restarted) — the UI says so rather than pretending the output was empty.
  getToolDetail(id: string, callId: string): { lines: ToolLine[]; totalLines: number } {
    const lines = this.toolDetails.get(id, callId);
    if (!lines) throw new GoneException("вивід більше недоступний");
    return { lines, totalLines: lines.length };
  }

  // Shared live-session wiring (fresh create + resume): build the Live, register it,
  // and route exit + events. onExit marks error unless the session ended cleanly.
  private wireLive(sessionId: string, rpc: AgentRuntime, status: Session["status"]): Live {
    const live: Live = { rpc, state: INITIAL_STATUS, transcript: [], live: { status, lastEventAt: Date.now() }, textBuf: "", thinkBuf: "", toolStarted: new Map(), toolArgs: new Map() };
    this.map.set(sessionId, live);
    rpc.onExit((_code, reason) => {
      this.stopPoll(live);
      if (live.live.status !== "stopped" && live.live.status !== "done") {
        live.live.status = "error";
        live.live.error = reason;
        this.registry.updateSession(sessionId, { status: "error" });
        this.pushUpdate(sessionId);
      }
    });
    rpc.onEvent((e) => this.onRpcEvent(sessionId, e));
    return live;
  }

  // Bring a session's omp process back after an api restart or crash: respawn in its
  // worktree, reload the saved omp session, rehydrate the transcript. Deduped so
  // concurrent sends resume once.
  private resumeSession(id: string): Promise<Live> {
    const inflight = this.resuming.get(id);
    if (inflight) return inflight;
    const p = this.doResume(id).finally(() => this.resuming.delete(id));
    this.resuming.set(id, p);
    return p;
  }

  private async doResume(id: string): Promise<Live> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.boundProject(s.projectId);
    if (s.kind === "agent" && s.worktree && !s.worktreePath)
      throw new Error("session was merged and its worktree retired — reopen it to continue");
    const dir = s.worktreePath || g.localRepoPath;
    if (s.kind === "agent" && !s.worktree && (await this.worktree.currentBranch(g.localRepoPath)) !== s.branch)
      throw new Error(`project is not on ${s.branch} — switch to it or delete the agent`);
    const configPath = await this.ompSkills(s.projectId, dir, id);
    const extensionPath = await this.ompTriggers(s.projectId, dir, id);
    const rpc = createRuntime(s.runtime ?? "omp", { cwd: dir, ...(s.kind === "chat" ? { tools: CHAT_TOOLS } : {}), ...(configPath ? { configPath } : {}), ...(extensionPath ? { extensionPath } : {}) });
    const live = this.wireLive(id, rpc, s.status);
    try {
      await rpc.start();
      if (s.ompSessionFile) {
        await rpc.switchSession(s.ompSessionFile);
        this.rehydrate(live, id, await rpc.getAllMessages());
      }
      // Re-assert the chosen effort AFTER switch_session: the reloaded session file carries its
      // own thinking level, so setting it at spawn (`--thinking`) would be overwritten here.
      // Best-effort — an agent that woke at the wrong effort is a nuisance, a resume that failed
      // because of it would cost the operator the whole session.
      if (s.effort)
        await rpc
          .setThinkingLevel(s.effort)
          .catch((e: unknown) => console.warn(`[supervisor] could not restore effort ${s.effort} on ${id}: ${(e as Error).message}`));
    } catch (err) {
      this.stopPoll(live);
      await rpc.stop().catch(() => {});
      this.map.delete(id);
      this.toolDetails.dropSession(id);
      this.skillLabels.delete(id);
      this.registry.updateSession(id, { status: "error" });
      this.pushUpdate(id);
      throw err;
    }
    live.live.status = "done";
    this.registry.updateSession(id, { status: "done" });
    this.events.next({ type: "transcript_reset", sessionId: id, entries: live.transcript });
    this.pushUpdate(id);
    return live;
  }
}
