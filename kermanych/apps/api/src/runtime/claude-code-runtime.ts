// apps/api/src/runtime/claude-code-runtime.ts
import { query as sdkQuery, type SDKMessage, type SDKUserMessage, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel } from "@kermanych/core";
import type { AgentRuntime, RpcStateData, RuntimeLaunchOpts } from "./agent-runtime";
import { initClaudeMapState, mapSdkMessage, type ClaudeMapState } from "./claude-event-map";
import { toClaudeEffort, toClaudeThinking, fromClaudeEffort } from "./effort-map";

type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

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

  constructor(private opts: RuntimeLaunchOpts, private queryFn: QueryFn = sdkQuery) {
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
      ...(this.opts.noTools ? { tools: [] } : {}),
      ...(this.opts.fork ? { resume: this.opts.fork, forkSession: true } : {}),
    };
    const q = this.queryFn({ prompt: this.input, options });
    this.q = q;
    this.alive = true;
    const { promise: ready, resolve } = Promise.withResolvers<void>();
    // Drain the SDK stream in the background, translating each message to RpcEvent(s).
    (async () => {
      try {
        for await (const msg of q) {
          const m = msg as { type?: string; session_id?: string; model?: string };
          if (m.type === "system" && m.session_id) this.sessionId = m.session_id;
          if (m.type === "system" && m.model) this.model = m.model;
          for (const e of mapSdkMessage(msg, this.mapState)) {
            if (e.type === "ready") resolve();
            this.emit(e);
          }
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
    await ready;
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
  async getAllMessages(): Promise<unknown[]> { return []; }

  async stop(): Promise<void> {
    try { await this.q?.interrupt().catch(() => {}); } finally { this.input.close(); this.alive = false; }
  }
}
