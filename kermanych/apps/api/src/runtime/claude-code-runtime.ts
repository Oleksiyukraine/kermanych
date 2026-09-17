// apps/api/src/runtime/claude-code-runtime.ts
import { query as sdkQuery, getSessionMessages as sdkGetSessionMessages, getSubagentMessages as sdkGetSubagentMessages, type SDKMessage, type SDKUserMessage, type Query, type Options, type ModelInfo, type SessionMessage, type GetSessionMessagesOptions, type GetSubagentMessagesOptions } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel, SubagentInfo, SubagentMessagesPage, SubagentNode } from "@kermanych/core";
import type { AgentRuntime, RpcStateData, RuntimeLaunchOpts } from "./agent-runtime";
import { initClaudeMapState, mapSdkMessage, type ClaudeMapState } from "./claude-event-map";
import { toClaudeEffort, toClaudeThinking, fromClaudeEffort } from "./effort-map";
import { claudeHistoryToOmp } from "./claude-history";

type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
type GetSessionMessagesFn = (sessionId: string, options?: GetSessionMessagesOptions) => Promise<SessionMessage[]>;
type GetSubagentMessagesFn = (sessionId: string, agentId: string, options?: GetSubagentMessagesOptions) => Promise<SessionMessage[]>;

// claude's task status vocabulary → the status words the map/transcript already render.
const CLAUDE_TASK_STATUS: Record<string, string> = {
  pending: "running", running: "running", completed: "done",
  failed: "error", killed: "aborted", paused: "parked",
};

// A pushable async generator: the runtime feeds user turns into a live query() this way.
class InputQueue {
  private pending: SDKUserMessage[] = [];
  private waiter?: (m: IteratorResult<SDKUserMessage>) => void;
  private closed = false;
  push(m: SDKUserMessage): void {
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w({ value: m, done: false }); }
    else this.pending.push(m);
  }
  close(): void {
    this.closed = true;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w({ value: undefined as never, done: true }); }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.pending.length) { yield this.pending.shift()!; continue; }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => { this.waiter = resolve; });
      if (r.done) return;
      yield r.value;
    }
  }
}

function userMessage(text: string, images?: ImageInput[]): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const img of images ?? []) content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null } as unknown as SDKUserMessage;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly droppedFrames = 0;
  private input = new InputQueue();
  private q?: Query;
  private mapState: ClaudeMapState = initClaudeMapState();
  private eventCbs: ((e: RpcEvent) => void)[] = [];
  private exitCbs: ((code: number | null, reason: string) => void)[] = [];
  private alive = false;
  private sessionId?: string;
  private model?: string;
  private thinking: ThinkingLevel;
  // Subagent registry built live from the SDK's task lifecycle, keyed by task_id (which is
  // also the id listSubagents/getSubagentMessages use). The omp backend keeps this in the
  // supervisor; here it lives on the runtime because only the runtime sees the SDK stream.
  private subagents = new Map<string, SubagentNode>();

  constructor(
    private opts: RuntimeLaunchOpts,
    private queryFn: QueryFn = sdkQuery,
    private getSessionMessagesFn: GetSessionMessagesFn = sdkGetSessionMessages,
    private getSubagentMessagesFn: GetSubagentMessagesFn = sdkGetSubagentMessages,
  ) {
    this.thinking = opts.thinking ?? "off";
  }

  onEvent(cb: (e: RpcEvent) => void): void { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null, reason: string) => void): void { this.exitCbs.push(cb); }
  isAlive(): boolean { return this.alive; }

  private emit(e: RpcEvent): void { for (const cb of this.eventCbs) cb(e); }

  async start(): Promise<void> {
    const effort = toClaudeEffort(this.thinking);
    const options: Options = {
      cwd: this.opts.cwd,
      includePartialMessages: true,
      canUseTool: async () => ({ behavior: "allow" }),
      thinking: toClaudeThinking(this.thinking),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(effort ? { effort } : {}),
      ...(this.opts.tools ? { allowedTools: this.opts.tools } : {}),
      // noTools wins over a stray `tools` allowlist: an empty allowlist = no tools. Placed
      // last so it overwrites `allowedTools` above. `tools: []` (the prior code) is not a
      // canonical SDK Option and was a silent no-op.
      ...(this.opts.noTools ? { allowedTools: [] } : {}),
      // A fork copies the parent session (new id); a plain resume continues the same id in
      // place. `fork` wins if both are set — a branch is a fork.
      ...(this.opts.fork ? { resume: this.opts.fork, forkSession: true } : this.opts.resume ? { resume: this.opts.resume } : {}),
      // The agent communication language directive (and any other system-prompt append),
      // added onto Claude Code's default preset so its own harness prompt is preserved.
      ...(this.opts.appendSystemPrompt
        ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: this.opts.appendSystemPrompt } }
        : {}),
    };
    const q = this.queryFn({ prompt: this.input, options });
    this.q = q;
    this.alive = true;
    // Drain the SDK stream in the background, translating each message to RpcEvent(s).
    // start() does NOT await `ready`: the streaming query() only emits system/init after the
    // first input turn is consumed, but callers send prompt() only after start() resolves.
    // Awaiting ready here would deadlock. Events (ready included) still flow via onEvent.
    (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === "system") {
            if ("session_id" in msg && typeof msg.session_id === "string") this.sessionId = msg.session_id;
            if ("model" in msg && typeof msg.model === "string") this.model = msg.model;
            this.ingestSubagentTask(msg);
          }
          for (const e of mapSdkMessage(msg, this.mapState)) this.emit(e);
        }
        this.alive = false;
        for (const cb of this.exitCbs) cb(0, "claude query ended");
      } catch (err) {
        this.alive = false;
        const reason = (err as Error).message ?? "claude query failed";
        this.emit({ type: "notice", level: "warn", message: reason });
        for (const cb of this.exitCbs) cb(null, reason);
      }
    })();
  }

  prompt(message: string, images?: ImageInput[]): void { this.input.push(userMessage(message, images)); }
  followUp(message: string, images?: ImageInput[]): void { this.input.push(userMessage(message, images)); }
  steer(message: string, images?: ImageInput[]): void {
    void this.q?.interrupt().catch(() => {});
    this.input.push(userMessage(message, images));
  }
  answerUi(_res: RpcExtensionUIResponse): void { /* interactive UI not surfaced this increment */ }

  async getState(): Promise<RpcStateData> {
    let percent: number | undefined;
    try { const cu = await this.q?.getContextUsage?.(); percent = (cu as { percent?: number } | undefined)?.percent; } catch { /* best effort */ }
    return {
      isStreaming: this.mapState.turnOpen,
      ...(percent !== undefined ? { contextUsage: { percent } } : {}),
      ...(this.model ? { model: { provider: "anthropic", id: this.model } } : {}),
      thinkingLevel: fromClaudeEffort(toClaudeEffort(this.thinking)),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }

  async switchSession(_sessionPath: string): Promise<void> {
    // Resume is expressed at start() via opts.fork/resume; a live switch is not used by the
    // claude path this increment. No-op keeps the supervisor's doResume shape intact.
  }
  async setModel(_provider: string, modelId: string): Promise<void> { this.model = modelId; await this.q?.setModel(modelId); }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.thinking = level;
    const effort = toClaudeEffort(level);
    // No dedicated live effort setter; approximate via thinking-token budget (coarse; see spec).
    await this.q?.setMaxThinkingTokens?.(effort ? null : 0);
  }
  // Rehydrate: read claude's own persisted transcript for this session and convert it to the
  // omp `OmpMessage[]` seam so a resumed/forked session re-renders through the same reducers
  // the live stream uses. No session id yet (never started, or start failed before init) →
  // nothing to read. `getSessionMessagesFn` is injectable so tests fake the SDK.
  async getAllMessages(): Promise<unknown[]> {
    if (!this.sessionId) return [];
    const msgs = await this.getSessionMessagesFn(this.sessionId, { dir: this.opts.cwd });
    return claudeHistoryToOmp(msgs);
  }

  // omp-style subagent surface for the claude backend. The registry is built from the SDK's
  // task lifecycle (see ingestSubagentTask); the transcript comes from claude's on-disk
  // per-subagent JSONL, converted through the same `claudeHistoryToOmp` seam the main
  // rehydrate uses, so a subagent's log renders identically to the session's own.
  async getSubagents(): Promise<SubagentInfo[]> {
    return [...this.subagents.values()];
  }

  async getSubagentMessages(sel: { subagentId?: string; sessionFile?: string; fromByte?: number }): Promise<SubagentMessagesPage> {
    if (!this.sessionId || !sel.subagentId) return {};
    const msgs = await this.getSubagentMessagesFn(this.sessionId, sel.subagentId, { dir: this.opts.cwd });
    return { messages: claudeHistoryToOmp(msgs) };
  }

  // Fold one SDK `task_*` system message into the registry and signal the change. The
  // supervisor listens for `subagent_progress` and re-snapshots via getSubagents(), so this
  // one event kind carries every lifecycle transition (started/updated/notification).
  private ingestSubagentTask(msg: SDKMessage): void {
    const m = msg as Record<string, unknown> & { type: string; subtype?: string };
    if (m.type !== "system" || typeof m.subtype !== "string" || !m.subtype.startsWith("task")) return;
    if (typeof m.task_id !== "string") return;
    const id = m.task_id;
    const node = this.subagents.get(id) ?? { id, index: this.subagents.size, status: "running" };
    if (typeof m.subagent_type === "string") node.agent = m.subagent_type;
    if (m.subtype === "task_started") node.status = "running";
    const patch = m.patch;
    if (patch && typeof patch === "object" && "status" in patch && typeof patch.status === "string") {
      node.status = CLAUDE_TASK_STATUS[patch.status] ?? patch.status;
    }
    const usage = m.usage;
    if (usage && typeof usage === "object") {
      if ("total_tokens" in usage && typeof usage.total_tokens === "number") node.tokens = usage.total_tokens;
      if ("duration_ms" in usage && typeof usage.duration_ms === "number") node.durationMs = usage.duration_ms;
      if ("tool_uses" in usage && typeof usage.tool_uses === "number") node.toolCalls = usage.tool_uses;
    }
    this.subagents.set(id, node);
    this.emit({ type: "subagent_progress", subagentId: id });
  }

  async stop(): Promise<void> {
    try { await this.q?.interrupt().catch(() => {}); } finally { this.input.close(); this.alive = false; }
  }

  // The claude model catalog for GET /models. There is no top-level SDK export for this
  // (only the per-Query control method), so we spin a throwaway streaming query, ask it over
  // the control channel — this does NOT consume a prompt turn, so it answers without any
  // input — then tear it down. `queryFn` is injectable so the test can fake the SDK.
  static async supportedModels(queryFn: QueryFn = sdkQuery): Promise<ModelInfo[]> {
    const input = new InputQueue();
    const q = queryFn({ prompt: input, options: { includePartialMessages: false } });
    try {
      return await q.supportedModels();
    } finally {
      input.close();
      await q.interrupt?.().catch(() => {});
    }
  }
}
