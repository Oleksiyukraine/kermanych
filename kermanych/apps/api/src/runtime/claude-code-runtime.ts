// apps/api/src/runtime/claude-code-runtime.ts
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { query as sdkQuery, getSessionMessages as sdkGetSessionMessages, getSubagentMessages as sdkGetSubagentMessages, type SDKMessage, type SDKUserMessage, type Query, type Options, type ModelInfo, type SessionMessage, type GetSessionMessagesOptions, type GetSubagentMessagesOptions, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel, SubagentInfo, SubagentMessagesPage, SubagentNode } from "@kermanych/core";
import type { AgentRuntime, RpcStateData, RuntimeLaunchOpts } from "./agent-runtime";
import { initClaudeMapState, mapSdkMessage, type ClaudeMapState } from "./claude-event-map";
import { toClaudeEffort, toClaudeThinking, fromClaudeEffort } from "./effort-map";
import { claudeHistoryToOmp } from "./claude-history";
import { AuthFailure, authFailureCode, type AuthFailureCode } from "./auth-failure";

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

// Launch options name tools the way omp does (lowercase); Claude Code's built-ins are
// capitalised. An unknown name passes through untouched — a caller naming a Claude tool
// directly means that tool.
const CLAUDE_TOOL_NAMES: Record<string, string> = { read: "Read", grep: "Grep", glob: "Glob", bash: "Bash", edit: "Edit", write: "Write" };

export function claudeToolName(name: string): string {
  return CLAUDE_TOOL_NAMES[name] ?? name;
}

// Whether `p` settles within `ms` — a bounded wait that never rejects.
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  const { promise: timeout, resolve } = Promise.withResolvers<false>();
  const timer = setTimeout(resolve, ms, false);
  try {
    return await Promise.race([p.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The CLI's stderr ends up in the transcript notice, the exit reason and the HTTP launch error.
// The SDK redacts its own stderr tail; ours (spawnProcess) is collected outside the SDK, so the
// same kinds of secret are masked here: auth header values, Bearer/Basic credentials, API keys.
function redactSecrets(text: string): string {
  return text
    .replace(/(authorization\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
}

// The in-turn signature of a signed-out account: the CLI's own synthetic assistant message
// (`model: "<synthetic>"`, no API call made) flagged `authentication_failed`, whose text is
// the CLI's instruction, e.g. "Not logged in · Please run /login". Returns that text, or
// undefined for every other message.
function signedOutText(msg: SDKMessage): string | undefined {
  if (msg.type !== "assistant" || msg.error !== "authentication_failed") return undefined;
  const content = (msg.message?.content ?? []) as Array<{ type?: string; text?: string }>;
  return content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join(" ").trim() || "authentication failed";
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly droppedFrames = 0;
  private input = new InputQueue();
  private q?: Query;
  private mapState: ClaudeMapState = initClaudeMapState();
  private eventCbs: ((e: RpcEvent) => void)[] = [];
  private exitCbs: ((code: number | null, reason: string, cause?: AuthFailureCode) => void)[] = [];
  private alive = false;
  // Settles once the SDK stream has ended — the CLI has exited and closed its stdout. stop()
  // waits on it; `stopping` marks that end as asked for, not a death to report.
  private drained?: Promise<void>;
  private stopping = false;
  private sessionId?: string;
  private model?: string;
  private thinking: ThinkingLevel;
  // Subagent registry built live from the SDK's task lifecycle, keyed by task_id (which is
  // also the id listSubagents/getSubagentMessages use). The omp backend keeps this in the
  // supervisor; here it lives on the runtime because only the runtime sees the SDK stream.
  private subagents = new Map<string, SubagentNode>();
  // The CLI's stderr, last STDERR_TAIL chars. The SDK keeps this tail itself only for its own
  // spawn; ours (spawnProcess, needed for the pid) hands stderr to us, so a launch failure would
  // otherwise lose the words authFailureCode classifies ("Please run /login").
  private stderrTail = "";
  // Settles once the CLI's stderr closed: its exit can be reported before the last stderr chunk
  // is read, so the failure path waits for this (bounded) before reading the tail.
  private stderrClosed?: Promise<void>;

  constructor(
    private opts: RuntimeLaunchOpts,
    private queryFn: QueryFn = sdkQuery,
    private getSessionMessagesFn: GetSessionMessagesFn = sdkGetSessionMessages,
    private getSubagentMessagesFn: GetSubagentMessagesFn = sdkGetSubagentMessages,
  ) {
    this.thinking = opts.thinking ?? "off";
    // A plain resume continues the SAME session id (no `forkSession`), so the id is known
    // before the SDK reports it — on a resume its first `system` message lands ~1s after spawn,
    // well past start()'s grace window. Without this the supervisor's rehydrate on wake
    // (doResume, right after start()) read no id, and the session's whole transcript was
    // replaced with an empty one. A fork's own id is minted by the SDK on its first turn, so it
    // stays unset; see getAllMessages.
    if (!opts.fork && opts.resume) this.sessionId = opts.resume;
  }

  onEvent(cb: (e: RpcEvent) => void): void { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null, reason: string, cause?: AuthFailureCode) => void): void { this.exitCbs.push(cb); }
  isAlive(): boolean { return this.alive; }

  private emit(e: RpcEvent): void { for (const cb of this.eventCbs) cb(e); }

  // How long start() watches a freshly-spawned child before declaring it launched. The two
  // failures that matter — a missing platform binary and a signed-out CLI — both reject the
  // message stream in single-digit milliseconds (measured against the real SDK), so this
  // window buys the difference between "created a dead session" and "told the operator why"
  // at a cost no operator can perceive.
  private static readonly START_GRACE_MS = 250;
  // stop(): how long a CLI whose input was closed gets to exit on its own (the omp backend's
  // SIGTERM delay), then how long close() — which SIGKILLs the CLI's whole process group,
  // background shells included — gets before stop() returns regardless.
  private static readonly STOP_GRACE_MS = 1000;
  private static readonly STOP_KILL_MS = 3000;
  private static readonly STDERR_TAIL = 4096;
  // How long a failure waits for the dead CLI's stderr to close before it reports without it.
  private static readonly STDERR_CLOSE_MS = 200;

  // The SDK's own local spawn, verbatim (`spawn(command, args, { cwd, stdio, signal, env,
  // windowsHide })`), plus the two things it does not give back: the pid, for renice and the
  // memory watchdog (the SDK exposes no CLI pid anywhere), and the stderr tail. Not detached, like
  // the SDK's, so close() still reaches the CLI. A missing binary still surfaces through the
  // returned process's 'error' event, which the SDK classifies the same way as with its own spawn.
  private spawnProcess = (o: SpawnOptions): SpawnedProcess => {
    const child = spawn(o.command, o.args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], signal: o.signal, env: o.env, windowsHide: true });
    const dec = new StringDecoder("utf8");
    const { promise: closed, resolve } = Promise.withResolvers<void>();
    this.stderrClosed = closed;
    // Drained always: an unread pipe fills and blocks the CLI on its next stderr write.
    child.stderr.on("data", (b: Buffer) => { this.stderrTail = (this.stderrTail + dec.write(b)).slice(-ClaudeCodeRuntime.STDERR_TAIL); });
    child.stderr.on("error", () => {});
    child.stderr.once("close", () => resolve());
    if (child.pid !== undefined) this.opts.onSpawn?.(child.pid);
    return child;
  };

  // A failure reason with the CLI's own stderr, the way the SDK words it for its own spawn
  // (". stderr: …"). Left alone when the SDK already carried a tail, or there is none.
  private async withStderr(reason: string): Promise<string> {
    if (/stderr:/i.test(reason)) return reason;
    if (this.stderrClosed) await settlesWithin(this.stderrClosed, ClaudeCodeRuntime.STDERR_CLOSE_MS);
    const tail = redactSecrets(this.stderrTail.trim());
    return tail ? `${reason}. stderr: ${tail}` : reason;
  }

  async start(): Promise<void> {
    const effort = toClaudeEffort(this.thinking);
    const options: Options = {
      cwd: this.opts.cwd,
      includePartialMessages: true,
      canUseTool: async () => ({ behavior: "allow" }),
      thinking: toClaudeThinking(this.thinking),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(effort ? { effort } : {}),
      // `tools` is the SDK's actual restriction of the built-in set; `allowedTools` only
      // skips the permission prompt. The launch names tools in the backend-neutral (omp)
      // spelling, so they are mapped to Claude Code's — passing `read` as-is restricted
      // nothing, and a «read-only» chat child quietly had Bash, Edit and Write.
      ...(this.opts.tools ? { tools: this.opts.tools.map(claudeToolName), allowedTools: this.opts.tools.map(claudeToolName) } : {}),
      // noTools wins over a stray `tools` allowlist: an empty base set = no built-in tools.
      ...(this.opts.noTools ? { tools: [], allowedTools: [] } : {}),
      // MCP tools are not built-ins, so the restriction above leaves them available.
      ...(this.opts.mcp
        ? {
            mcpServers: {
              [this.opts.mcp.name]: {
                type: "http" as const,
                url: this.opts.mcp.url,
                headers: { Authorization: `Bearer ${this.opts.mcp.token}` },
                alwaysLoad: true,
              },
            },
          }
        : {}),
      // A fork copies the parent session (new id); a plain resume continues the same id in
      // place. `fork` wins if both are set — a branch is a fork.
      ...(this.opts.fork ? { resume: this.opts.fork, forkSession: true } : this.opts.resume ? { resume: this.opts.resume } : {}),
      // The agent communication language directive (and any other system-prompt append),
      // added onto Claude Code's default preset so its own harness prompt is preserved.
      ...(this.opts.appendSystemPrompt
        ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: this.opts.appendSystemPrompt } }
        : {}),
      // The machine resource limits (CLAUDE_CODE_* vars). The SDK's `env` replaces the child's
      // environment, so process.env goes first; the operator's settings `env` still beats both.
      ...(this.opts.env ? { env: { ...process.env, ...this.opts.env } } : {}),
      spawnClaudeCodeProcess: this.spawnProcess,
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
    this.drained = (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === "system") {
            if ("session_id" in msg && typeof msg.session_id === "string") this.sessionId = msg.session_id;
            if ("model" in msg && typeof msg.model === "string") this.model = msg.model;
            this.ingestSubagentTask(msg);
          }
          // A signed-out (or revoked) account does not kill the child: it answers the turn with
          // a synthetic assistant message flagged `authentication_failed` and then idles. The
          // stream only rejects once the input closes, which a live session never does, so
          // without this the turn ended empty and the session looked merely quiet. The child is
          // ended here, before the loop unwinds into the iterator's return(): the next send
          // respawns it with `resume` and retries on whatever credentials the operator has then.
          const signedOut = signedOutText(msg);
          if (signedOut !== undefined) {
            this.input.close();
            q.close();
            throw new AuthFailure("claude_not_authenticated", `Claude Code is not signed in: ${signedOut}`);
          }
          for (const e of mapSdkMessage(msg, this.mapState)) this.emit(e);
        }
        this.alive = false;
        for (const cb of this.exitCbs) cb(0, "claude query ended");
      } catch (err) {
        this.alive = false;
        // A stream torn down by stop() (close() past the grace window) is the exit stop() asked
        // for: no warning on the transcript, no launch to fail.
        if (this.stopping) {
          for (const cb of this.exitCbs) cb(0, "claude query closed");
          return;
        }
        const reason = await this.withStderr((err as Error).message ?? "claude query failed");
        // The notice still fires: a child that dies mid-session (after start() long returned)
        // has no launch to fail, and the transcript row is the only account of it.
        const code = err instanceof AuthFailure ? err.code : authFailureCode(reason);
        this.emit({ type: "notice", level: "warn", message: reason, ...(code ? { code } : {}) });
        for (const cb of this.exitCbs) cb(null, reason, code);
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
  // claude-code has no RPC compaction control method; its `/compact` is a slash command read
  // from the prompt stream. Push it as a user message and let the CLI compact its own history.
  // Fire-and-forget like the other prompt paths — the input queue is one-way — so this resolves
  // as soon as the message is enqueued.
  async compact(customInstructions?: string): Promise<void> {
    const trimmed = customInstructions?.trim();
    this.input.push(userMessage(trimmed ? `/compact ${trimmed}` : "/compact"));
  }
  // Rehydrate: read claude's own persisted transcript for this session and convert it to the
  // omp `OmpMessage[]` seam so a resumed/forked session re-renders through the same reducers
  // the live stream uses. A fork that has not taken a turn yet has no id of its own, but its
  // conversation IS the parent's, so the parent's transcript is read instead — the id is only
  // borrowed here, never reported by getState(), so the parent's id is never persisted as the
  // child's. Neither (never started, fresh start before init) → nothing to read.
  // `getSessionMessagesFn` is injectable so tests fake the SDK.
  async getAllMessages(): Promise<unknown[]> {
    const id = this.sessionId ?? this.opts.fork;
    if (!id) return [];
    const msgs = await this.getSessionMessagesFn(id, { dir: this.opts.cwd });
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
  // Resolves once the CLI has exited, as the omp backend's stop() does: callers retire the
  // worktree right after (finish, delete), and a CLI still shutting down in it — its background
  // shells not yet reaped — races the removal and can write the tree back. Closing the input
  // asks for a clean exit; past the grace window close() kills the CLI's process group.
  async stop(): Promise<void> {
    this.stopping = true;
    try { await this.q?.interrupt().catch(() => {}); } finally { this.input.close(); this.alive = false; }
    if (!this.drained || (await settlesWithin(this.drained, ClaudeCodeRuntime.STOP_GRACE_MS))) return;
    this.q?.close();
    await settlesWithin(this.drained, ClaudeCodeRuntime.STOP_KILL_MS);
  }

  // The claude model catalog for GET /models. There is no top-level SDK export for this
  // (only the per-Query control method), so we spin a throwaway streaming query, ask it over
  // the control channel — this does NOT consume a prompt turn, so it answers without any
  // input — then tear it down. `queryFn` is injectable so the test can fake the SDK.
  static async supportedModels(queryFn: QueryFn = sdkQuery): Promise<ModelInfo[]> {
    return ClaudeCodeRuntime.control(queryFn, (q) => q.supportedModels());
  }

  // The preflight's question, on one throwaway child: is an account signed in, and which
  // models does it offer. The catalog alone cannot tell — a signed-out child lists every model
  // (measured) — while accountInfo() names no token for it: `tokenSource: "none"` with no
  // `apiKeySource`. Only the first-party API needs that login; Bedrock, Vertex and gateway
  // setups authenticate outside Claude Code, so they always count as signed in here.
  static async probe(queryFn: QueryFn = sdkQuery): Promise<{ signedIn: boolean; models: ModelInfo[] }> {
    return ClaudeCodeRuntime.control(queryFn, async (q) => {
      const account = await q.accountInfo();
      const firstParty = (account.apiProvider ?? "firstParty") === "firstParty";
      const signedIn = !firstParty || account.tokenSource !== "none" || Boolean(account.apiKeySource);
      return { signedIn, models: await q.supportedModels() };
    });
  }

  private static async control<T>(queryFn: QueryFn, ask: (q: Query) => Promise<T>): Promise<T> {
    const input = new InputQueue();
    const q = queryFn({ prompt: input, options: { includePartialMessages: false } });
    try {
      return await ask(q);
    } finally {
      input.close();
      await q.interrupt?.().catch(() => {});
    }
  }
}
