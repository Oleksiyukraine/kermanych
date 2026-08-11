// apps/api/src/supervisor/supervisor.service.ts
import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { Observable, Subject } from "rxjs";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";
import { RpcSession } from "../rpc/rpc-session";
import { messagesToTranscript } from "./messages-to-transcript";
import {
  INITIAL_STATUS,
  reduceStatus,
  ACTIVE_STATUSES,
  slugify,
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
  type TranscriptEntry,
} from "@kermanych/core";

type Live = {
  rpc: RpcSession;
  state: StatusState;
  transcript: TranscriptEntry[];
  live: Partial<Session>;
  textBuf: string;
  thinkBuf: string;
  poll?: NodeJS.Timeout;
};

@Injectable()
export class SupervisorService {
  private map = new Map<string, Live>();
  private resuming = new Map<string, Promise<Live>>();
  private events = new Subject<ServerEvent>();
  events$: Observable<ServerEvent> = this.events.asObservable();

  constructor(
    private registry: RegistryService,
    private worktree: WorktreeService,
  ) {}

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

  async addGroup(name: string, projectDir: string): Promise<Group> {
    if (!(await this.worktree.isGitRepo(projectDir))) throw new Error("project dir is not a git repo");
    const g = this.registry.createGroup({ name, projectDir });
    this.events.next({ type: "group_update", group: g });
    return g;
  }
  async removeGroup(id: string): Promise<void> {
    for (const s of this.registry.listSessions(id)) await this.deleteSession(s.id);
    this.registry.removeGroup(id);
    this.events.next({ type: "group_removed", groupId: id });
  }
  async updateGroup(id: string, patch: { previewCommand?: string; apiCommand?: string }): Promise<Group> {
    const g = this.registry.updateGroup(id, patch);
    this.events.next({ type: "group_update", group: g });
    return g;
  }

  async createSession(
    groupId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = "feature",
  ): Promise<Session> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");

    // In-place guards run first — they must not leave a row, branch, or omp process behind.
    let baseBranch: string | undefined;
    if (!worktree) {
      if (await this.worktree.hasUncommitted(group.projectDir))
        throw new Error("project working tree must be clean to create an in-place (non-worktree) agent");
      const activeInPlace = this.registry
        .listSessions(groupId)
        .some((s) => !s.worktree && s.kind !== "discussion" && s.status !== "merged");
      if (activeInPlace)
        throw new Error("an in-place agent is already active in this project — finish or delete it first");
      baseBranch = await this.worktree.currentBranch(group.projectDir);
      if (!baseBranch) throw new Error("project has a detached HEAD — checkout a branch first");
    }

    // Branch name: <prefix>/<slug>, de-duplicated against ALL existing session branches.
    const existing = new Set(this.registry.listSessions(groupId).map((s) => s.branch));
    const branch = uniqueSlug(branchName(slugify(name), prefix), existing);

    const session = this.registry.createSession({ groupId, name, task, worktreePath: "", branch, worktree, baseBranch });
    let wtDir = "";
    try {
      if (worktree) {
        wtDir = worktreeDir(session.id);
        await this.worktree.addWorktree(group.projectDir, wtDir, branch);
      } else {
        await this.worktree.createBranchHere(group.projectDir, branch);
      }
    } catch (err) {
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    const saved = worktree
      ? this.registry.updateSession(session.id, { worktreePath: wtDir })
      : session;

    const rpc = new RpcSession({ cwd: worktree ? wtDir : group.projectDir, model });
    const live = this.wireLive(session.id, rpc, "queued");
    try {
      await rpc.start();
      this.appendEntry(session.id, this.userEntry(task, images));
      rpc.prompt(task, images);
    } catch (err) {
      this.stopPoll(live);
      await rpc.stop().catch(() => {});
      if (worktree) {
        await this.worktree.removeWorktree(group.projectDir, wtDir).catch(() => {});
      } else if (baseBranch) {
        await this.worktree.checkout(group.projectDir, baseBranch, { force: true }).catch(() => {});
      }
      await this.worktree.removeBranch(group.projectDir, branch).catch(() => {});
      this.map.delete(session.id);
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    this.pushUpdate(session.id);
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
    if (s.kind === "discussion") throw new Error("cannot branch a discussion branch");

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
      this.registry.removeSession(child.id);
      this.events.next({ type: "session_removed", sessionId: child.id });
      throw err;
    }
    this.pushUpdate(child.id);
    return this.merge(child);
  }

  // Merge a discussion branch back into its parent: inject a (reviewed) summary as a
  // message into the parent's live conversation, then retire the child as merged history.
  async mergeDiscussion(childId: string, summary?: string): Promise<{ merged: true }> {
    const c = this.registry.listSessions().find((x) => x.id === childId);
    if (!c) throw new Error("session not found");
    if (c.kind !== "discussion" || !c.parentSessionId) throw new Error("not a discussion branch");
    const parentId = c.parentSessionId;

    const live = this.map.get(childId);
    const last = [...(live?.transcript ?? [])]
      .reverse()
      .find((e) => e.kind === "assistant_text") as { kind: "assistant_text"; text: string } | undefined;
    const text = (summary?.trim() || last?.text || "").trim();
    if (!text) throw new Error("nothing to merge — the branch has no conclusion yet");
    const wrapped = `[Висновок гілки «${c.name}»]: ${text}`;

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

  // Echo the user's own message (initial task or follow-up) into the transcript so
  // the log reads as a full conversation. Images ride along as data URLs for render.
  private userEntry(text: string, images?: ImageInput[]): TranscriptEntry {
    return { kind: "user_text", text, images: images?.map((i) => `data:${i.mimeType};base64,${i.data}`) };
  }

  private onRpcEvent(id: string, e: RpcEvent) {
    const l = this.map.get(id);
    if (!l) return;
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
    // RpcEvent carries an index-signature fallback member; Extract recovers the concrete typed member.
    if (e.type === "message_update") {
      const ame = (e as Extract<RpcEvent, { type: "message_update" }>).assistantMessageEvent;
      if (ame?.type === "text_delta") l.textBuf += ame.delta ?? "";
      else if (ame?.type === "thinking_delta") l.thinkBuf += ame.delta ?? "";
    }
    if (e.type === "message_end") {
      if (l.thinkBuf.trim()) this.appendEntry(id, { kind: "assistant_thinking", text: l.thinkBuf });
      if (l.textBuf.trim()) this.appendEntry(id, { kind: "assistant_text", text: l.textBuf });
      l.textBuf = "";
      l.thinkBuf = "";
    }
    if (e.type === "tool_execution_start") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_start" }>;
      this.appendEntry(id, { kind: "tool_call", tool: ev.toolName ?? "?", summary: ev.args?.command ?? ev.args?.path });
    }
    if (e.type === "tool_execution_end") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_end" }>;
      this.appendEntry(id, { kind: "tool_result", tool: ev.toolName ?? "?", ok: !ev.isError });
    }
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
      l = undefined;
    }
    if (!l) l = await this.resumeSession(id);
    try {
      this.registry.touchSession(id);
    } catch {
      /* never let a bookkeeping write break message delivery */
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
    }
    if (s && s.kind === "discussion") {
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
        await this.worktree.removeBranch(g.projectDir, s.branch);
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
    if (s.kind === "discussion")
      throw new Error("discussion branches can't be finished — merge or discard instead");

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
      if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); }
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
    if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); }
    await this.worktree.removeBranch(g.projectDir, s.branch); // projectDir left on base
    this.registry.updateSession(id, { status: "merged" });
    this.pushUpdate(id);
    return { merged: true, into: base };
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
    if (s) return [{ kind: "notice", text: "Сесія неактивна. Надішли повідомлення, щоб відновити її та підтягнути історію." }];
    return [];
  }

  // Shared live-session wiring (fresh create + resume): build the Live, register it,
  // and route exit + events. onExit marks error unless the session ended cleanly.
  private wireLive(sessionId: string, rpc: RpcSession, status: Session["status"]): Live {
    const live: Live = { rpc, state: INITIAL_STATUS, transcript: [], live: { status }, textBuf: "", thinkBuf: "" };
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
    const dir = s.worktreePath || g.projectDir;
    if (s.kind !== "discussion" && !s.worktree && (await this.worktree.currentBranch(g.projectDir)) !== s.branch)
      throw new Error(`project is not on ${s.branch} — switch to it or delete the agent`);
    const rpc = new RpcSession({ cwd: dir });
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
