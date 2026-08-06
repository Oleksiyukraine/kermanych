// src/server/supervisor.ts
import { Registry } from "./registry";
import { RpcSession } from "./rpc-session";
import { INITIAL_STATUS, reduceStatus, type StatusState } from "./status";
import * as wt from "./worktree";
import { slugify, branchName, uniqueSlug, worktreeDir } from "./worktree";
import type { Group, RpcEvent, RpcExtensionUIResponse, ServerEvent, Session, TranscriptEntry } from "./types";

type Live = { rpc: RpcSession; state: StatusState; transcript: TranscriptEntry[]; live: Partial<Session>; textBuf: string; poll?: Timer };

export class Supervisor {
  private map = new Map<string, Live>();
  private cbs: ((e: ServerEvent) => void)[] = [];
  constructor(private registry: Registry) {}
  onServerEvent(cb: (e: ServerEvent) => void) { this.cbs.push(cb); }
  private emit(e: ServerEvent) { this.cbs.forEach((cb) => cb(e)); }
  snapshot() { return { groups: this.registry.listGroups(), sessions: this.registry.listSessions().map((s) => this.merge(s)) }; }

  private merge(s: Session): Session { const l: Partial<Session> = this.map.get(s.id)?.live ?? {}; return { ...s, ...l, status: l.status ?? s.status }; }
  private pushUpdate(id: string) { const s = this.registry.listSessions().find((x) => x.id === id); if (s) this.emit({ type: "session_update", session: this.merge(s) }); }

  async addGroup(name: string, projectDir: string): Promise<Group> {
    if (!(await wt.isGitRepo(projectDir))) throw new Error("project dir is not a git repo");
    const g = this.registry.createGroup({ name, projectDir }); this.emit({ type: "group_update", group: g }); return g;
  }
  removeGroup(id: string) { this.registry.removeGroup(id); this.emit({ type: "group_removed", groupId: id }); }

  async createSession(groupId: string, name: string, task: string, model?: string): Promise<Session> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");
    // Dynamic membership set built from existing branches; `uniqueSlug` consumes a Set.
    const existing = new Set(this.registry.listSessions(groupId).map((s) => s.branch.replace("maestro/", "")));
    const slug = uniqueSlug(slugify(name), existing);
    const branch = branchName(slug);
    const session = this.registry.createSession({ groupId, name, task, worktreePath: "", branch });
    const wtDir = worktreeDir(session.id);
    try {
      await wt.addWorktree(group.projectDir, wtDir, branch);
    } catch (err) {
      this.registry.removeSession(session.id); this.emit({ type: "session_removed", sessionId: session.id });
      throw err;
    }
    const saved = this.registry.updateSession(session.id, { worktreePath: wtDir });
    const rpc = new RpcSession({ cwd: wtDir, model });
    const live: Live = { rpc, state: INITIAL_STATUS, transcript: [], live: { status: "queued" }, textBuf: "" };
    this.map.set(session.id, live);
    rpc.onExit(() => {
      this.stopPoll(live);
      if (live.live.status !== "stopped" && live.live.status !== "done") { live.live.status = "error"; this.registry.updateSession(session.id, { status: "error" }); this.pushUpdate(session.id); }
    });
    rpc.onEvent((e) => this.onRpcEvent(session.id, e));
    await rpc.start();
    rpc.prompt(task);
    this.pushUpdate(session.id);
    return this.merge(saved);
  }

  private appendEntry(id: string, entry: TranscriptEntry) { const l = this.map.get(id)!; l.transcript.push(entry); this.emit({ type: "transcript_append", sessionId: id, entry }); }

  private onRpcEvent(id: string, e: RpcEvent) {
    const l = this.map.get(id); if (!l) return;
    const before = l.state.status;
    l.state = reduceStatus(l.state, e);
    // RpcEvent carries an index-signature fallback member; Extract recovers the concrete typed member.
    if (e.type === "message_update") {
      const ame = (e as Extract<RpcEvent, { type: "message_update" }>).assistantMessageEvent;
      if (ame?.type === "text_delta") l.textBuf += ame.delta ?? "";
    }
    if (e.type === "message_end") { if (l.textBuf.trim()) this.appendEntry(id, { kind: "assistant_text", text: l.textBuf }); l.textBuf = ""; }
    if (e.type === "tool_execution_start") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_start" }>;
      this.appendEntry(id, { kind: "tool_call", tool: ev.toolName ?? "?", summary: ev.args?.command ?? ev.args?.path });
    }
    if (e.type === "tool_execution_end") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_end" }>;
      this.appendEntry(id, { kind: "tool_result", tool: ev.toolName ?? "?", ok: !ev.isError });
    }
    if (e.type === "extension_ui_request" && l.state.status === "waiting_input") l.live.pendingUiRequest = e as Extract<RpcEvent, { type: "extension_ui_request" }>;
    l.live.status = l.state.status; l.live.currentTool = l.state.currentTool;
    if (l.state.status !== "waiting_input") l.live.pendingUiRequest = undefined;
    if (e.type === "agent_end" && (e as Extract<RpcEvent, { type: "agent_end" }>).isTerminal !== false) { this.registry.updateSession(id, { status: "done" }); this.refreshState(id); this.stopPoll(l); }
    if ((l.state.status === "thinking" || l.state.status === "tool") && !l.poll) l.poll = setInterval(() => this.refreshState(id), 2000);
    if (before !== l.state.status || e.type === "tool_execution_start") this.pushUpdate(id);
  }

  private stopPoll(l: Live) { if (l.poll) { clearInterval(l.poll); l.poll = undefined; } }
  private async refreshState(id: string) {
    const l = this.map.get(id); if (!l) return;
    try { const st = await l.rpc.getState(); l.live.contextPercent = st.contextUsage?.percent; l.live.todoPhases = st.todoPhases;
      if (st.sessionId || st.sessionFile) this.registry.updateSession(id, { ompSessionId: st.sessionId, ompSessionFile: st.sessionFile });
      this.pushUpdate(id);
    } catch {}
  }

  sendMessage(id: string, text: string, mode: "prompt" | "follow_up" | "steer") {
    const l = this.map.get(id); if (!l) return;
    if (mode === "steer") l.rpc.steer(text); else if (mode === "follow_up") l.rpc.followUp(text); else l.rpc.prompt(text);
  }
  answerUi(id: string, res: RpcExtensionUIResponse) { this.map.get(id)?.rpc.answerUi(res); }
  async stopSession(id: string) { const l = this.map.get(id); if (!l) return; l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.registry.updateSession(id, { status: "stopped" }); this.pushUpdate(id); }
  async deleteSession(id: string) {
    const s = this.registry.listSessions().find((x) => x.id === id); const l = this.map.get(id);
    if (l) { l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); }
    if (s) { const g = this.registry.listGroups().find((x) => x.id === s.groupId); if (g) { if (s.worktreePath) await wt.removeWorktree(g.projectDir, s.worktreePath); await wt.removeBranch(g.projectDir, s.branch); } }
    this.registry.removeSession(id); this.emit({ type: "session_removed", sessionId: id });
  }
  getTranscript(id: string): TranscriptEntry[] { return this.map.get(id)?.transcript ?? []; }
}
