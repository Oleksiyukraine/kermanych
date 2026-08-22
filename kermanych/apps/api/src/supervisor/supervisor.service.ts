// apps/api/src/supervisor/supervisor.service.ts
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { Observable, Subject } from "rxjs";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";
import { RpcSession } from "../rpc/rpc-session";
import { messagesToTranscript } from "./messages-to-transcript";
import { reduceRpcEvents } from "./transcript-reducer";
import { ToolDetailCache } from "./tool-detail-cache";
import { copyCarryFiles } from "../env/carry-files";
import {
  INITIAL_STATUS,
  reduceStatus,
  ACTIVE_STATUSES,
  slugify,
  taskNameFromText,
  branchName,
  uniqueSlug,
  worktreeDir,
  type BranchPrefix,
  type StatusState,
  type Group,
  type ImageInput,
  type RpcEvent,
  type RpcExtensionUIResponse,
  type ServerEvent,
  type Session,
  type TaskDraft,
  type TranscriptEntry,
} from "@kermanych/core";

type Live = {
  rpc: RpcSession;
  state: StatusState;
  transcript: TranscriptEntry[];
  live: Partial<Session>;
  textBuf: string;
  thinkBuf: string;
  // Tool start stamps and call args live across events: the wall time and the `$ <command>`
  // header of a call are only reducible once its end frame arrives, several calls later.
  toolStarted: Map<string, number>;
  toolArgs: Map<string, Record<string, unknown>>;
  poll?: NodeJS.Timeout;
};

// Chat sessions run omp with a read-only tool subset: they explore and plan in the project
// dir without ever mutating it (git-free). Promotion to an agent later grants the full toolset.
const CHAT_TOOLS = ["read", "grep", "glob"];

// Kermanych's built-in fallback PR/commit conventions, injected only when the target repo
// defines none of its own (no `### PR Conventions` / `### Commit Conventions` in
// CLAUDE.md/AGENTS.md) and the group has no override. A project's own rules always win.
const DEFAULT_PR_CONVENTIONS = [
  "- Commits: Conventional Commits — `type(scope): summary` in the imperative mood (feat, fix, chore, refactor, docs, test).",
  "- PR title: the same Conventional-Commit style, summarising the whole change.",
  "- PR body: a `## Summary` section (what changed and why) and a `## Testing` section (commands run / how it was verified).",
  "- Keep the PR scoped to this branch's work; do not fold in unrelated changes.",
].join("\n");

@Injectable()
export class SupervisorService implements OnModuleDestroy {
  private map = new Map<string, Live>();
  private resuming = new Map<string, Promise<Live>>();
  // One cache for every session, live or dormant: GET /sessions/:id/tools/:callId must
  // still serve a session whose omp child has already been torn down.
  private toolDetails = new ToolDetailCache();
  private lastStamp = 0;
  private events = new Subject<ServerEvent>();
  events$: Observable<ServerEvent> = this.events.asObservable();

  constructor(
    private registry: RegistryService,
    private worktree: WorktreeService,
  ) {}

  onModuleDestroy(): void {
    for (const live of this.map.values()) {
      this.stopPoll(live);
      void live.rpc.stop();
    }
  }

  snapshot() {
    return {
      groups: this.registry.listGroups(),
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

  async addGroup(name: string, projectDir: string, carryFiles?: string[]): Promise<Group> {
    if (!(await this.worktree.isGitRepo(projectDir))) throw new Error("project dir is not a git repo");
    const g = this.registry.createGroup({ name, projectDir, carryFiles });
    this.events.next({ type: "group_update", group: g });
    return g;
  }
  async removeGroup(id: string): Promise<void> {
    for (const s of this.registry.listSessions(id)) await this.deleteSession(s.id);
    this.registry.removeGroup(id);
    this.events.next({ type: "group_removed", groupId: id });
  }
  async updateGroup(id: string, patch: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string }): Promise<Group> {
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("project name cannot be empty");
      patch = { ...patch, name };
    }
    const g = this.registry.updateGroup(id, patch);
    this.events.next({ type: "group_update", group: g });
    return g;
  }

  // Local branches of a project plus its current HEAD and configured default — feeds the
  // worktree fork-base picker in the UI.
  async projectBranches(groupId: string): Promise<{ branches: string[]; current: string; default: string | null }> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");
    const [branches, current] = await Promise.all([
      this.worktree.listBranches(group.projectDir),
      this.worktree.currentBranch(group.projectDir),
    ]);
    return { branches, current, default: group.defaultBranch ?? null };
  }

  async createSession(
    groupId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = "feature",
    asTask = false,
    platform?: Session["platform"],
    baseBranch?: string,
  ): Promise<Session> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");

    // A backlog task is just a saved launch config: no branch, no worktree, no omp child.
    // startTask turns it into a running agent later, reusing exactly these fields.
    if (asTask) {
      const session = this.registry.createSession({
        groupId, name, task, worktreePath: "", branch: "",
        worktree, model, prefix, platform, baseBranch, status: "backlog", kind: "task",
      });
      this.pushUpdate(session.id);
      return this.merge(session);
    }

    const { branch, baseBranch: resolvedBase } = await this.resolveLaunchParams(group, name, prefix, worktree, undefined, baseBranch);
    const session = this.registry.createSession({ groupId, name, task, worktreePath: "", branch, worktree, baseBranch: resolvedBase, model, prefix, platform });
    try {
      return await this.launch(session, group, { images });
    } catch (err) {
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
  }

  // Turn a backlog task into a running agent in place: apply any last edits, resolve its
  // branch, flip kind task→agent + status backlog→queued on the SAME row, then launch. On
  // failure the row returns to the backlog so a transient spawn error never loses the plan.
  async startTask(
    id: string,
    overrides?: TaskDraft,
    images?: ImageInput[],
  ): Promise<Session> {
    const cur = this.registry.listSessions().find((x) => x.id === id);
    if (!cur) throw new Error("session not found");
    if (cur.kind !== "task" || cur.status !== "backlog") throw new Error("not a backlog task");
    const group = this.registry.listGroups().find((g) => g.id === cur.groupId);
    if (!group) throw new Error("group not found");

    if (overrides)
      this.registry.updateSession(id, {
        name: overrides.name ?? cur.name,
        task: overrides.task ?? cur.task,
        model: overrides.model ?? cur.model,
        prefix: overrides.prefix ?? cur.prefix,
        platform: overrides.platform ?? cur.platform,
        worktree: overrides.worktree ?? cur.worktree,
        baseBranch: overrides.baseBranch ?? cur.baseBranch,
      });
    const edited = this.registry.listSessions().find((x) => x.id === id)!;

    const { branch, baseBranch } = await this.resolveLaunchParams(group, edited.name, edited.prefix ?? "feature", edited.worktree, id, edited.baseBranch);
    const session = this.registry.updateSession(id, { status: "queued", kind: "agent", branch, baseBranch, worktreePath: "" });
    try {
      return await this.launch(session, group, { images });
    } catch (err) {
      this.registry.updateSession(id, { status: "backlog", kind: "task", branch: "", baseBranch: undefined, worktreePath: "" });
      this.pushUpdate(id);
      throw err;
    }
  }

  // Edit a backlog task's saved launch config without starting it.
  updateTask(
    id: string,
    patch: TaskDraft,
  ): Session {
    const cur = this.registry.listSessions().find((x) => x.id === id);
    if (!cur) throw new Error("session not found");
    if (cur.kind !== "task" || cur.status !== "backlog") throw new Error("not a backlog task");
    const saved = this.registry.updateSession(id, {
      name: patch.name ?? cur.name,
      task: patch.task ?? cur.task,
      model: patch.model ?? cur.model,
      prefix: patch.prefix ?? cur.prefix,
      platform: patch.platform ?? cur.platform,
      worktree: patch.worktree ?? cur.worktree,
      baseBranch: patch.baseBranch ?? cur.baseBranch,
    });
    this.pushUpdate(id);
    return this.merge(saved);
  }

  // Move a backlog task to another project. A backlog row is bound to its project only by
  // group_id (no branch/worktree/omp child yet), so this is a pure re-parent — no git side effects.
  moveTask(id: string, groupId: string): Session {
    const cur = this.registry.listSessions().find((x) => x.id === id);
    if (!cur) throw new Error("session not found");
    if (cur.kind !== "task" || cur.status !== "backlog") throw new Error("not a backlog task");
    if (!this.registry.listGroups().some((g) => g.id === groupId)) throw new Error("group not found");
    const saved = this.registry.updateSession(id, { groupId });
    this.pushUpdate(id);
    return this.merge(saved);
  }

  // A quick chat: an instant, git-free omp conversation in the project dir with a read-only
  // tool subset. No branch, no worktree, no opening prompt — it spawns ready and the operator
  // sends the first message. It can later be promoted (forked) into a real agent, so a throwaway
  // exploration becomes real work without losing context.
  async createChat(groupId: string): Promise<Session> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");
    const n = this.registry.listSessions(groupId).filter((s) => s.kind === "chat").length + 1;
    const session = this.registry.createSession({
      groupId, name: `чат ${n}`, task: "", worktreePath: "", branch: "",
      worktree: false, kind: "chat", status: "queued",
    });
    const rpc = new RpcSession({ cwd: group.projectDir, tools: CHAT_TOOLS });
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
  async promoteChatToAgent(chatId: string): Promise<Session> {
    const chat = this.registry.listSessions().find((x) => x.id === chatId);
    if (!chat) throw new Error("session not found");
    if (chat.kind !== "chat") throw new Error("not a chat session");
    const group = this.registry.listGroups().find((g) => g.id === chat.groupId);
    if (!group) throw new Error("group not found");

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
    const { branch, baseBranch } = await this.resolveLaunchParams(group, name, "feature", true, chatId);
    const prompt =
      `The planning discussion above is settled — implement it now.\n\n` +
      `You are no longer read-only: you have been moved out of the project directory into a ` +
      `dedicated git worktree on branch \`${branch}\`, with the full toolset. Everything agreed ` +
      `above is the specification — do not re-open it and do not re-ask what was already ` +
      `answered.\n\n` +
      `Implement it end to end: follow the repo's existing conventions and patterns, leave no ` +
      `stubs or TODOs behind, and commit your work on this branch. Where the discussion left ` +
      `something ambiguous, take the most reasonable reading, say which one you took, and keep ` +
      `going — stop only for a genuinely blocking question.`;

    // The read-only child must die before the worktree one takes over this row's event stream.
    if (live) {
      this.stopPoll(live);
      await live.rpc.stop().catch(() => {});
      this.map.delete(chatId);
      this.toolDetails.dropSession(chatId);
    }
    const session = this.registry.updateSession(chatId, {
      name, kind: "agent", worktree: true, branch, baseBranch, worktreePath: "", prefix: "feature", status: "queued",
    });
    try {
      return await this.launch(session, group, { fork: chatFile, firstPrompt: prompt });
    } catch (err) {
      // Back to being a chat: the row keeps its conversation, and the next message resumes its
      // read-only omp child through doResume.
      this.registry.updateSession(chatId, {
        name: chat.name, kind: "chat", worktree: false, branch: "", baseBranch: undefined,
        worktreePath: "", prefix: undefined, status: "done",
      });
      this.pushUpdate(chatId);
      throw err;
    }
  }

  // In-place guards + a de-duplicated branch name, shared by an immediate agent
  // (createSession) and a started backlog task (startTask). excludeId keeps a task from
  // colliding with or blocking itself.
  private async resolveLaunchParams(
    group: Group,
    name: string,
    prefix: BranchPrefix,
    worktree: boolean,
    excludeId?: string,
    requestedBase?: string,
  ): Promise<{ branch: string; baseBranch?: string }> {
    let baseBranch: string | undefined;
    if (!worktree) {
      if (await this.worktree.hasUncommitted(group.projectDir))
        throw new Error("project working tree must be clean to create an in-place (non-worktree) agent");
      // A backlog task hasn't launched, so it never occupies the single in-place slot.
      const activeInPlace = this.registry
        .listSessions(group.id)
        .some((s) => s.id !== excludeId && !s.worktree && s.kind !== "discussion" && s.kind !== "review" && s.status !== "merged" && s.status !== "backlog");
      if (activeInPlace)
        throw new Error("an in-place agent is already active in this project — finish or delete it first");
      baseBranch = await this.worktree.currentBranch(group.projectDir);
      if (!baseBranch) throw new Error("project has a detached HEAD — checkout a branch first");
    } else {
      // Worktree agents fork from the chosen base: explicit pick > project default > current HEAD.
      baseBranch = requestedBase ?? group.defaultBranch ?? undefined;
    }
    const existing = new Set(
      this.registry.listSessions(group.id).filter((s) => s.id !== excludeId).map((s) => s.branch).filter(Boolean),
    );
    const branch = uniqueSlug(branchName(slugify(name), prefix), existing);
    return { branch, baseBranch };
  }

  // Create the git isolation (worktree or in-place branch), spawn the omp child, and kick off
  // the first turn. `fork` seeds the child from a prior omp conversation (chat → agent) and
  // rehydrates its history; `firstPrompt` overrides the opening message sent (defaults to the
  // task), and an empty one lands the session idle — a forked agent that just continues the
  // chat. On failure it undoes any git side effects and rethrows; the caller owns the
  // registry-row rollback (remove vs return-to-backlog).
  private async launch(
    session: Session,
    group: Group,
    opts: { images?: ImageInput[]; fork?: string; firstPrompt?: string } = {},
  ): Promise<Session> {
    const { id, branch, worktree, baseBranch, task, model } = session;
    const { images, fork } = opts;
    const firstPrompt = opts.firstPrompt ?? task;
    let wtDir = "";
    let branchCreated = false;
    try {
      if (worktree) {
        wtDir = worktreeDir(id);
        await this.worktree.addWorktree(group.projectDir, wtDir, branch, baseBranch);
        branchCreated = true;
        await copyCarryFiles(group.projectDir, wtDir, group.carryFiles ?? [".env"]);
      } else {
        await this.worktree.createBranchHere(group.projectDir, branch);
        branchCreated = true;
      }
    } catch (err) {
      if (wtDir) await this.worktree.removeWorktree(group.projectDir, wtDir).catch(() => {});
      if (branchCreated) await this.worktree.removeBranch(group.projectDir, branch).catch(() => {});
      throw err;
    }
    const saved = worktree ? this.registry.updateSession(id, { worktreePath: wtDir }) : session;

    const rpc = new RpcSession({ cwd: worktree ? wtDir : group.projectDir, model, ...(fork ? { fork } : {}) });
    const live = this.wireLive(id, rpc, "queued");
    try {
      await rpc.start();
      // A forked child inherits the source conversation — surface its history before the turn.
      if (fork) {
        live.transcript = messagesToTranscript(await rpc.getAllMessages());
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
        await this.worktree.removeWorktree(group.projectDir, wtDir).catch(() => {});
      } else if (baseBranch) {
        await this.worktree.checkout(group.projectDir, baseBranch, { force: true }).catch(() => {});
      }
      await this.worktree.removeBranch(group.projectDir, branch).catch(() => {});
      this.map.delete(id);
      this.toolDetails.dropSession(id);
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
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
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

    const cwd = s.worktreePath || g.projectDir;
    const child = this.registry.createSession({
      groupId: s.groupId,
      name: `гілка: ${s.name}`,
      task: "",
      worktreePath: "",
      branch: "",
      worktree: false,
      kind: "discussion",
      parentSessionId: parentId,
    });

    const rpc = new RpcSession({ cwd, fork: parentFile, noTools: true });
    const childLive = this.wireLive(child.id, rpc, "queued");
    try {
      await rpc.start();
      childLive.transcript = messagesToTranscript(await rpc.getAllMessages());
      this.events.next({ type: "transcript_reset", sessionId: child.id, entries: childLive.transcript });
      await this.refreshState(child.id);
      childLive.live.status = "done";
      this.registry.updateSession(child.id, { status: "done" });
    } catch (err) {
      this.stopPoll(childLive);
      await rpc.stop().catch(() => {});
      this.map.delete(child.id);
      this.toolDetails.dropSession(child.id);
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
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    if (s.kind !== "agent") throw new Error("only agent sessions can be reviewed");

    const live = this.map.get(parentId);
    if (live && (live.state.status === "thinking" || live.state.status === "tool"))
      throw new Error("wait for the agent to finish its turn before requesting a review");

    const cwd = s.worktreePath || g.projectDir;
    const base = s.worktree ? await this.worktree.currentBranch(g.projectDir) : (s.baseBranch ?? "");
    const diff = await this.worktree.diff(cwd, base);
    if (!diff.trim()) throw new Error("nothing to review — the branch has no changes yet");

    const child = this.registry.createSession({
      groupId: s.groupId,
      name: `ревізія: ${s.name}`,
      task: s.task,
      worktreePath: "",
      branch: "",
      worktree: false,
      kind: "review",
      parentSessionId: parentId,
    });

    const prompt =
      `You are an INDEPENDENT code reviewer. You did NOT do this work and have no prior ` +
      `context — audit ONLY the task and the diff below, with fresh eyes.\n\n` +
      `## Original task\n${s.task}\n\n` +
      `## Diff (base \`${base}\` → branch \`${s.branch}\`)\n` +
      "```diff\n" + diff + "\n```\n\n" +
      `Perform a FULL audit: does the change satisfy the task; are any requirements missed ` +
      `or only partly done; are there bugs, edge cases, or security issues; are tests present ` +
      `and meaningful; is the code sound? You may read any file in the worktree for context, ` +
      `but you are read-only — do NOT modify anything or run commands. Finish with a clear ` +
      `verdict (APPROVE or NEEDS CHANGES) and a prioritized list of findings.`;

    const rpc = new RpcSession({ cwd, tools: ["read", "grep", "glob"] });
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
    await this.sendMessage(parentId, wrapped, mode);

    if (live) {
      live.live.status = "stopped";
      this.stopPoll(live);
      await live.rpc.stop();
      this.map.delete(childId);
      this.toolDetails.dropSession(childId);
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

  // Complete a pending tool row in place from the reduced patch and notify clients.
  // Match by exact toolCallId when omp provides one, else the oldest pending
  // entry of the same tool name (FIFO — correct for interchangeable parallel calls).
  private finishTool(id: string, patch: Extract<TranscriptEntry, { kind: "tool" }>) {
    const l = this.map.get(id);
    if (!l) return;
    const entry =
      l.transcript.find((x) => x.kind === "tool" && x.id === patch.id) ??
      l.transcript.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === patch.tool);
    if (!entry || entry.kind !== "tool") return;
    entry.status = patch.status;
    entry.stat = patch.stat;
    entry.count = patch.count;
    entry.ms = patch.ms;
    entry.detail = patch.detail;
    // The patch only carries a target when the result improved on the one derived at call time.
    if (patch.target) entry.target = patch.target;
    this.events.next({
      type: "transcript_update", sessionId: id, id: entry.id, status: entry.status as "ok" | "error",
      stat: entry.stat, count: entry.count, ms: entry.ms, detail: entry.detail,
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

  private onRpcEvent(id: string, e: RpcEvent) {
    const l = this.map.get(id);
    if (!l) return;
    // Progress heartbeat (in-memory, every event incl. streaming deltas) — distinct from
    // last_activity_at, which user sends also bump. The UI uses this to spot a wedged turn.
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
    });
    l.textBuf = reduced.textBuf;
    l.thinkBuf = reduced.thinkBuf;
    for (const [callId, lines] of reduced.full) this.toolDetails.put(id, callId, lines);
    for (const entry of reduced.entries) {
      // A completion carries no new entry — it patches the pending one in place.
      if (entry.kind === "tool" && entry.status !== "pending") this.finishTool(id, entry);
      else this.appendEntry(id, entry);
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
    }
    if ((l.state.status === "thinking" || l.state.status === "tool") && !l.poll)
      l.poll = setInterval(() => this.refreshState(id), 2000);
    if (before !== l.state.status || e.type === "tool_execution_start") this.pushUpdate(id);
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
      if (st.sessionId || st.sessionFile)
        this.registry.updateSession(id, { ompSessionId: st.sessionId, ompSessionFile: st.sessionFile });
      this.pushUpdate(id);
    } catch {}
  }

  async sendMessage(id: string, text: string, mode: "prompt" | "follow_up" | "steer", images?: ImageInput[]) {
    // A dormant session (no Live) resumes; a *dead* Live — the omp child exited, e.g. a
    // provider outage killed it after the turn ended — must ALSO resume, not be written to.
    // A write to a dead child's stdin raises EPIPE, which RpcSession swallows, so the message
    // would vanish with no error and the agent would look "hung". Drop the corpse and respawn.
    let l = this.map.get(id);
    if (l && !l.rpc.isAlive()) {
      this.stopPoll(l);
      this.map.delete(id);
      this.toolDetails.dropSession(id);
      l = undefined;
    }
    if (!l) l = await this.resumeSession(id);
    try {
      this.registry.touchSession(id);
    } catch {
      /* never let a bookkeeping write break message delivery */
    }
    // A chat's opening message IS the ask. Record it once, so promoting the chat can name the
    // agent and its branch after the thing being built, and so review/PR prompts have a task.
    if (text.trim()) {
      const s = this.registry.listSessions().find((x) => x.id === id);
      if (s?.kind === "chat" && !s.task.trim()) this.registry.updateSession(id, { task: text.trim() });
    }
    if (text.trim() || images?.length) this.appendEntry(id, this.userEntry(text, images));
    if (mode === "steer") l.rpc.steer(text, images);
    else if (mode === "follow_up") l.rpc.followUp(text, images);
    else l.rpc.prompt(text, images);
  }

  // AI conflict resolution: resume the session's agent in its mid-merge worktree and
  // task it with resolving the conflicts + committing the merge, so the branch becomes
  // mergeable. Progress streams on the session's normal event feed.
  async resolveConflict(id: string): Promise<{ ok: true }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    const dir = s.worktreePath || g.projectDir;
    const files = await this.worktree.unmergedFiles(dir);
    if (!files.length) throw new Error("no merge conflict to resolve");
    const prompt =
      `A git merge is in progress in this worktree with conflicts in:\n` +
      files.map((f) => `- ${f}`).join("\n") +
      `\n\nResolve every conflict: edit each file, remove the conflict markers ` +
      `(<<<<<<<, =======, >>>>>>>), and combine BOTH sides so nothing is lost — keep this ` +
      `branch's changes AND the changes merged in from the base branch. When all conflicts ` +
      `are resolved, run \`git add -A && git commit --no-edit\` to complete the merge. Do only this.`;
    await this.sendMessage(id, prompt, "prompt");
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
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");

    const baseHint = (s.baseBranch || g.defaultBranch || "").trim();
    const fallback = (g.conventions || "").trim() || DEFAULT_PR_CONVENTIONS;
    const baseLine = baseHint
      ? `Target the PR at \`${baseHint}\`, unless the repo's PR conventions dictate a different base.`
      : `Target the PR at the repository's default branch, unless the repo's PR conventions dictate otherwise.`;

    const prompt =
      `Open a pull request for this session's branch \`${s.branch}\`.\n\n` +
      `Follow the repository's own \`### PR Conventions\` and \`### Commit Conventions\` from its ` +
      `CLAUDE.md / AGENTS.md if they exist. If the repo defines none, follow these defaults instead:\n` +
      `${fallback}\n\n` +
      `Steps:\n` +
      `1. Commit any uncommitted work, following the commit conventions.\n` +
      `2. Push \`${s.branch}\` to \`origin\` (set the upstream).\n` +
      `3. Open the PR with \`gh pr create\`. ${baseLine}\n` +
      `Reply with the PR URL when done. Do only this.`;

    await this.sendMessage(id, prompt, "prompt");
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
    }
    if (s && s.kind !== "agent") {
      // No git: the child owns no branch/worktree; its cwd is the parent's.
      if (s.ompSessionFile) await rm(s.ompSessionFile, { force: true }).catch(() => {});
    } else if (s) {
      const g = this.registry.listGroups().find((x) => x.id === s.groupId);
      if (g) {
        if (s.worktree) {
          if (s.worktreePath) await this.worktree.removeWorktree(g.projectDir, s.worktreePath);
        } else if (s.baseBranch && (await this.worktree.currentBranch(g.projectDir)) === s.branch) {
          // Restore the project to its base branch (delete discards the session's in-progress work).
          await this.worktree
            .checkout(g.projectDir, s.baseBranch)
            .catch(() => this.worktree.checkout(g.projectDir, s.baseBranch!, { force: true }));
        }
        if (s.branch) await this.worktree.removeBranch(g.projectDir, s.branch);
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
  async finishInfo(id: string): Promise<{ branch: string; target: string; ahead: number; dirty: boolean; conflicts: string[] }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    if (s.worktree && !s.worktreePath) throw new Error("session has no worktree — reopen it to continue");
    const dir = s.worktreePath || g.projectDir;
    const target = s.worktree ? await this.worktree.currentBranch(g.projectDir) : (s.baseBranch ?? "");
    const ahead = target ? await this.worktree.aheadCount(g.projectDir, target, s.branch) : 0;
    const dirty = await this.worktree.hasUncommitted(dir);
    const conflicts = await this.worktree.unmergedFiles(dir);
    return { branch: s.branch, target, ahead, dirty, conflicts };
  }

  // Merge the session's branch into the project's current branch, then retire the
  // worktree + branch and keep the session as `merged` history. On a content conflict
  // it instead pulls the target into the worktree (leaving markers to resolve in an
  // editor) and marks the session `conflict`; re-running after a resolve merges cleanly.
  async finishSession(id: string): Promise<{ merged: true; into: string } | { conflict: true; files: string[] }> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    if (s.kind !== "agent")
      throw new Error(`${s.kind} branches can't be finished — merge or discard instead`);

    if (s.worktree) {
      if (!s.worktreePath) throw new Error("session has no worktree");
      const target = await this.worktree.currentBranch(g.projectDir);
      if (!target) throw new Error("project repo has a detached HEAD - checkout a branch first");
      if (target === s.branch) throw new Error("project repo is on the session branch itself");
      // A prior conflict left the worktree mid-merge — it must be resolved before retrying.
      if ((await this.worktree.unmergedFiles(s.worktreePath)).length)
        throw new Error("worktree has unresolved conflicts - resolve them in the editor first");
      if (await this.worktree.hasUncommitted(s.worktreePath))
        await this.worktree.commitAll(s.worktreePath, `session work: ${s.name}`);
      const res = await this.worktree.mergeBranch(g.projectDir, s.branch, `merge session: ${s.name}`);
      if (!res.ok) {
        if (!res.conflict) throw new Error(res.message); // e.g. dirty project tree
        // Pull the target into the worktree so the conflict can be resolved there.
        await this.worktree.mergeInto(s.worktreePath, target);
        this.registry.updateSession(id, { status: "conflict" });
        this.pushUpdate(id);
        return { conflict: true, files: await this.worktree.unmergedFiles(s.worktreePath) };
      }
      const l = this.map.get(id);
      if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); this.toolDetails.dropSession(id); }
      await this.worktree.removeWorktree(g.projectDir, s.worktreePath);
      await this.worktree.removeBranch(g.projectDir, s.branch);
      this.registry.updateSession(id, { status: "merged", worktreePath: "" });
      this.pushUpdate(id);
      return { merged: true, into: target };
    }

    // In-place: projectDir is checked out on the session branch. Merge it into base.
    const base = s.baseBranch;
    if (!base) throw new Error("in-place session has no base branch");
    const cur = await this.worktree.currentBranch(g.projectDir);
    if (cur !== s.branch)
      throw new Error(`project is not on ${s.branch} (on ${cur || "detached HEAD"}) - switch to it first`);
    if ((await this.worktree.unmergedFiles(g.projectDir)).length)
      throw new Error("project has unresolved conflicts - resolve them first");
    if (await this.worktree.hasUncommitted(g.projectDir))
      await this.worktree.commitAll(g.projectDir, `session work: ${s.name}`);

    await this.worktree.checkout(g.projectDir, base);
    const res = await this.worktree.mergeBranch(g.projectDir, s.branch, `merge session: ${s.name}`);
    if (!res.ok) {
      // Restore onto the session branch; on a content conflict leave markers there to resolve.
      await this.worktree.checkout(g.projectDir, s.branch);
      if (!res.conflict) throw new Error(res.message);
      await this.worktree.mergeInto(g.projectDir, base);
      this.registry.updateSession(id, { status: "conflict" });
      this.pushUpdate(id);
      return { conflict: true, files: await this.worktree.unmergedFiles(g.projectDir) };
    }
    const l = this.map.get(id);
    if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); this.toolDetails.dropSession(id); }
    await this.worktree.removeBranch(g.projectDir, s.branch); // projectDir left on base
    this.registry.updateSession(id, { status: "merged" });
    this.pushUpdate(id);
    return { merged: true, into: base };
  }

  // Reopen a merged (retired) worktree agent: fork a fresh branch + worktree from the base
  // — which now holds the merged work — so the same session can continue and be finished again.
  // The omp child resumes lazily on the next message, rehydrating its saved conversation.
  async reopenSession(id: string): Promise<Session> {
    const s = this.registry.listSessions().find((x) => x.id === id);
    if (!s) throw new Error("session not found");
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    if (s.kind !== "agent") throw new Error(`${s.kind} sessions can't be reopened`);
    if (!s.worktree) throw new Error("in-place sessions can't be reopened — create a new task");
    if (s.worktreePath) throw new Error("session already has a worktree");
    const { branch, baseBranch } = await this.resolveLaunchParams(g, s.name, s.prefix ?? "feature", true, id, s.baseBranch);
    const wtDir = worktreeDir(id);
    try {
      await this.worktree.addWorktree(g.projectDir, wtDir, branch, baseBranch);
      await copyCarryFiles(g.projectDir, wtDir, g.carryFiles ?? [".env"]);
    } catch (err) {
      await this.worktree.removeWorktree(g.projectDir, wtDir).catch(() => {});
      await this.worktree.removeBranch(g.projectDir, branch).catch(() => {});
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
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    const dir = s.worktreePath || g.projectDir;
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
      const text =
        s.status === "merged"
          ? "Сесію влито в проєкт. Натисни «↻ Відновити» вгорі, щоб підняти worktree і продовжити."
          : "Сесія неактивна. Надішли повідомлення, щоб відновити її та підтягнути історію.";
      // Synthesised on every read, never appended to a transcript, so a fixed id is enough.
      return [{ kind: "notice", id: "dormant", at: Date.now(), level: "info", text }];
    }
    return [];
  }

  // Shared live-session wiring (fresh create + resume): build the Live, register it,
  // and route exit + events. onExit marks error unless the session ended cleanly.
  private wireLive(sessionId: string, rpc: RpcSession, status: Session["status"]): Live {
    const live: Live = { rpc, state: INITIAL_STATUS, transcript: [], live: { status }, textBuf: "", thinkBuf: "", toolStarted: new Map(), toolArgs: new Map() };
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
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    if (s.kind === "agent" && s.worktree && !s.worktreePath)
      throw new Error("session was merged and its worktree retired — reopen it to continue");
    const dir = s.worktreePath || g.projectDir;
    if (s.kind === "agent" && !s.worktree && (await this.worktree.currentBranch(g.projectDir)) !== s.branch)
      throw new Error(`project is not on ${s.branch} — switch to it or delete the agent`);
    const rpc = new RpcSession({ cwd: dir, ...(s.kind === "chat" ? { tools: CHAT_TOOLS } : {}) });
    const live = this.wireLive(id, rpc, s.status);
    try {
      await rpc.start();
      if (s.ompSessionFile) {
        await rpc.switchSession(s.ompSessionFile);
        live.transcript = messagesToTranscript(await rpc.getAllMessages());
      }
    } catch (err) {
      this.stopPoll(live);
      await rpc.stop().catch(() => {});
      this.map.delete(id);
      this.toolDetails.dropSession(id);
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
