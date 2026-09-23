// apps/api/src/runtime/claude-code-runtime.ts
import { query as sdkQuery, getSessionMessages as sdkGetSessionMessages, type SDKMessage, type SDKUserMessage, type Query, type Options, type ModelInfo, type SessionMessage, type GetSessionMessagesOptions } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel } from "@kermanych/core";
import type { AgentRuntime, RpcStateData, RuntimeLaunchOpts } from "./agent-runtime";
import { initClaudeMapState, mapSdkMessage, type ClaudeMapState } from "./claude-event-map";
import { toClaudeEffort, toClaudeThinking, fromClaudeEffort } from "./effort-map";
import { claudeHistoryToOmp } from "./claude-history";
import { authFailureCode } from "./auth-failure";

type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
type GetSessionMessagesFn = (sessionId: string, options?: GetSessionMessagesOptions) => Promise<SessionMessage[]>;

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

  constructor(
    private opts: RuntimeLaunchOpts,
    private queryFn: QueryFn = sdkQuery,
    private getSessionMessagesFn: GetSessionMessagesFn = sdkGetSessionMessages,
  ) {
    this.thinking = opts.thinking ?? "off";
  }

  onEvent(cb: (e: RpcEvent) => void): void { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null, reason: string) => void): void { this.exitCbs.push(cb); }
  isAlive(): boolean { return this.alive; }

  private emit(e: RpcEvent): void { for (const cb of this.eventCbs) cb(e); }

  // How long start() watches a freshly-spawned child before declaring it launched. The two
  // failures that matter — a missing platform binary and a signed-out CLI — both reject the
  // message stream in single-digit milliseconds (measured against the real SDK), so this
  // window buys the difference between "created a dead session" and "told the operator why"
  // at a cost no operator can perceive.
  private static readonly START_GRACE_MS = 250;

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
    // A child that never launched (no platform binary, signed-out CLI) shows up ONLY as a
    // rejection of this stream — query() itself does not throw. `died` lets start() below
    // observe that, so a corpse is reported as a failed launch instead of a ready session.
    const { promise: died, reject: onDeath } = Promise.withResolvers<never>();
    // Nobody may be awaiting `died` once start() has returned; without this an early death
    // after the grace window would be an unhandled rejection that takes the process down.
    died.catch(() => {});
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
          }
          for (const e of mapSdkMessage(msg, this.mapState)) this.emit(e);
        }
        this.alive = false;
        for (const cb of this.exitCbs) cb(0, "claude query ended");
      } catch (err) {
        this.alive = false;
        const reason = (err as Error).message ?? "claude query failed";
        // The notice still fires: a child that dies mid-session (after start() long returned)
        // has no launch to fail, and the transcript row is the only account of it.
        const code = authFailureCode(reason);
        this.emit({ type: "notice", level: "warn", message: reason, ...(code ? { code } : {}) });
        for (const cb of this.exitCbs) cb(null, reason);
        onDeath(this.launchError(reason, code));
      }
    })();

    // Watch the newborn child just long enough to catch an immediate death. A healthy child is
    // silent here (init is gated on the first input turn), so the grace window elapsing is the
    // success case — not evidence that anything started.
    const grace = this.opts.startGraceMs ?? ClaudeCodeRuntime.START_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        died,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, grace); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // The launch failure a caller sees, carrying the child's own words plus the localizable
  // cause. `code` rides on the Error because every existing caller (createChat, launch,
  // doResume) already funnels a thrown start() into its own rollback and rethrow, so the
  // code reaches the HTTP layer without a new channel.
  private launchError(reason: string, code: string | undefined): Error & { code?: string } {
    const err = new Error(reason) as Error & { code?: string };
    if (code) err.code = code;
    return err;
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
