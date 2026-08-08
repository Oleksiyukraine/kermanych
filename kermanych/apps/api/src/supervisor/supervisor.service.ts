// apps/api/src/supervisor/supervisor.service.ts
import { Injectable } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";
import { RpcSession } from "../rpc/rpc-session";
import {
  INITIAL_STATUS,
  reduceStatus,
  slugify,
  branchName,
  uniqueSlug,
  worktreeDir,
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
  poll?: NodeJS.Timeout;
};

@Injectable()
export class SupervisorService {
  private map = new Map<string, Live>();
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

  async createSession(groupId: string, name: string, task: string, model?: string, images?: ImageInput[]): Promise<Session> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");
    // Dynamic membership set built from existing branches; `uniqueSlug` consumes a Set.
    const existing = new Set(this.registry.listSessions(groupId).map((s) => s.branch.replace("kermanych/", "")));
    const slug = uniqueSlug(slugify(name), existing);
    const branch = branchName(slug);
    const session = this.registry.createSession({ groupId, name, task, worktreePath: "", branch });
    const wtDir = worktreeDir(session.id);
    try {
      await this.worktree.addWorktree(group.projectDir, wtDir, branch);
    } catch (err) {
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    const saved = this.registry.updateSession(session.id, { worktreePath: wtDir });
    const rpc = new RpcSession({ cwd: wtDir, model });
    const live: Live = { rpc, state: INITIAL_STATUS, transcript: [], live: { status: "queued" }, textBuf: "" };
    this.map.set(session.id, live);
    rpc.onExit((_code, reason) => {
      this.stopPoll(live);
      if (live.live.status !== "stopped" && live.live.status !== "done") {
        live.live.status = "error";
        live.live.error = reason;
        this.registry.updateSession(session.id, { status: "error" });
        this.pushUpdate(session.id);
      }
    });
    rpc.onEvent((e) => this.onRpcEvent(session.id, e));
    try {
      await rpc.start();
      this.appendEntry(session.id, this.userEntry(task, images));
      rpc.prompt(task, images);
    } catch (err) {
      this.stopPoll(live);
      await rpc.stop().catch(() => {});
      await this.worktree.removeWorktree(group.projectDir, wtDir).catch(() => {});
      await this.worktree.removeBranch(group.projectDir, branch).catch(() => {});
      this.map.delete(session.id);
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    this.pushUpdate(session.id);
    return this.merge(saved);
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
    const before = l.state.status;
    l.state = reduceStatus(l.state, e);
    // RpcEvent carries an index-signature fallback member; Extract recovers the concrete typed member.
    if (e.type === "message_update") {
      const ame = (e as Extract<RpcEvent, { type: "message_update" }>).assistantMessageEvent;
      if (ame?.type === "text_delta") l.textBuf += ame.delta ?? "";
    }
    if (e.type === "message_end") {
      if (l.textBuf.trim()) this.appendEntry(id, { kind: "assistant_text", text: l.textBuf });
      l.textBuf = "";
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

  sendMessage(id: string, text: string, mode: "prompt" | "follow_up" | "steer", images?: ImageInput[]) {
    const l = this.map.get(id);
    if (!l) return;
    if (text.trim() || images?.length) this.appendEntry(id, this.userEntry(text, images));
    if (mode === "steer") l.rpc.steer(text, images);
    else if (mode === "follow_up") l.rpc.followUp(text, images);
    else l.rpc.prompt(text, images);
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
    const s = this.registry.listSessions().find((x) => x.id === id);
    const l = this.map.get(id);
    if (l) {
      l.live.status = "stopped";
      this.stopPoll(l);
      await l.rpc.stop();
      this.map.delete(id);
    }
    if (s) {
      const g = this.registry.listGroups().find((x) => x.id === s.groupId);
      if (g) {
        if (s.worktreePath) await this.worktree.removeWorktree(g.projectDir, s.worktreePath);
        await this.worktree.removeBranch(g.projectDir, s.branch);
      }
    }
    this.registry.removeSession(id);
    this.events.next({ type: "session_removed", sessionId: id });
  }
  getTranscript(id: string): TranscriptEntry[] {
    return this.map.get(id)?.transcript ?? [];
  }
}
