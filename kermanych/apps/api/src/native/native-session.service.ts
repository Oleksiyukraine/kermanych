// apps/api/src/native/native-session.service.ts
// Native sessions (docs/specs/2026-10-05-native-sessions.md): `claude` or `omp` runs as its own
// TUI in a pty inside the session's worktree, and Kermanych only OBSERVES it. Per harness this
// service owns the start/resume argv, the per-launch bearer its status hooks post back with,
// the hook → SessionStatus mapping, and the readers of the harness's own session file (usage,
// model, PR link, history). It knows nothing about SupervisorService: the supervisor routes a
// native row here and listens on `events$` to push `session_update` / `transcript_reset`.
import { Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Subject, type Subscription } from "rxjs";
import { getSessionMessages, type SessionMessage, type GetSessionMessagesOptions } from "@anthropic-ai/claude-agent-sdk";
import { ACTIVE_STATUSES, type NativeHarness, type Session, type SessionStatus, type Usage } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { TerminalService } from "../terminal/terminal.service";
import { CodedError } from "../management/coded-error";
import { claudeHistoryToOmp } from "../runtime/claude-history";
import { messagesToTranscript, type OmpMessage, type Rehydrated } from "../supervisor/messages-to-transcript";
import { PR_URL_RE } from "../supervisor/pr-url";
import { CHAT_TOOLS } from "../supervisor/chat-tools";
import { claudeToolName } from "../runtime/claude-code-runtime";
import { claudeMcpConfigPath, claudeSettingsPath, codexConfigArgs, codexHookPath, NATIVE_TOKEN_ENV, NATIVE_URL_ENV, ompExtensionPath } from "./native-hooks";
import { BrowserMcpService } from "../browser/browser-mcp.service";
import { MCP_TOKEN_ENV, MCP_URL_ENV, ompMcpBridgePath } from "../runtime/omp-mcp-bridge";

// `settled`: a turn just came to rest at `status` — the supervisor checks the tree for a merge
// left mid-way (docs/specs/2026-10-14-create-pr-base-sync.md, decision 6) and may call
// `markConflict`.
export type NativeEvent =
  | { type: "changed"; sessionId: string }
  | { type: "transcript"; sessionId: string; transcript: Rehydrated }
  | { type: "settled"; sessionId: string; status: SessionStatus };

// The live overlay the supervisor merges over a native row while its harness runs.
export type NativeLive = Pick<Session, "status" | "currentTool" | "error" | "terminalId">;

type Run = {
  terminalId?: string;
  token: string;
  status: SessionStatus;
  currentTool?: string;
  error?: string;
  // «Створити ПР» was pasted: the next PR URL in the session file sets `prOpened`. `prFrom` is
  // the history length at arming, so a URL already in the conversation does not count.
  prRequested?: boolean;
  prFrom?: number;
  // «Закоміти» was pasted onto a session with a PR: the turn it starts settles on `in_review`.
  reviewPending?: boolean;
  // claude's transcript path as its hooks report it (CLAUDE_CONFIG_DIR may move it).
  transcriptPath?: string;
  exited: Promise<void>;
  onExit: () => void;
};

// claude hook events / notification types that mean the harness waits on the operator.
const CLAUDE_ASKING_TOOLS: Record<string, true> = { AskUserQuestion: true, ExitPlanMode: true };
const CLAUDE_ASKING_NOTIFICATIONS: Record<string, true> = {
  permission_prompt: true,
  elicitation_dialog: true,
  elicitation_url_dialog: true,
  agent_needs_input: true,
};
// A helper prompt is pasted only into a harness that sits idle at its input box — `conflict`
// included: a turn that stopped mid-merge waits there for «Вирішити автоматично» or an answer.
const PASTE_OK: readonly SessionStatus[] = ["done", "in_review", "error", "conflict"];
// The Stop hook fires before claude flushes the turn's last transcript lines.
const CLAUDE_FLUSH_MS = 300;
// codex's ask-the-operator tool; it reaches hooks as a PreToolUse like any function tool.
const CODEX_ASK_TOOL = "request_user_input";
// codex appends its rollout asynchronously: the turn's last lines land just around `Stop`.
const CODEX_FLUSH_MS = 300;
// Bracketed paste lands as one (multi-line) message; the Enter after it submits it.
const SUBMIT_DELAY_MS = 150;
// SIGHUP first (a closed terminal window); a harness that ignores it is killed after this.
const KILL_GRACE_MS = 3000;

export function nativeBusy(): CodedError {
  return new CodedError("native_busy", "Агент зараз працює або чекає на тебе в терміналі — дочекайся кінця ходу і спробуй ще раз.");
}

export function nativeUnsupported(): CodedError {
  return new CodedError("native_unsupported", "Для нативної сесії ця дія недоступна — скористайся самим агентом у терміналі.");
}

type FileUsage = { usage?: Usage; model?: string };

// claude's transcript: one API response spans several lines that repeat `message.id` and its
// `usage`, so the total keys on the id. The file carries no cost — 0, not a guess.
export function claudeFileUsage(text: string): FileUsage {
  const byId = new Map<string, Record<string, unknown>>();
  let model: string | undefined;
  for (const line of jsonLines(text)) {
    if (line.type !== "assistant") continue;
    const m = line.message as Record<string, unknown> | undefined;
    if (!m) continue;
    if (typeof m.model === "string" && m.model !== "<synthetic>") model = m.model;
    const u = m.usage as Record<string, unknown> | undefined;
    if (u && typeof m.id === "string") byId.set(m.id, u);
  }
  if (!byId.size) return { model };
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const u of byId.values()) {
    usage.input += num(u.input_tokens);
    usage.output += num(u.output_tokens);
    usage.cacheRead += num(u.cache_read_input_tokens);
    usage.cacheWrite += num(u.cache_creation_input_tokens);
  }
  return { usage, model };
}

// omp's session file: every assistant `message` line carries its own turn's usage and cost.
export function ompFileUsage(text: string): FileUsage {
  let usage: Usage | undefined;
  let model: string | undefined;
  for (const m of ompFileMessages(text)) {
    if (m.role !== "assistant") continue;
    const raw = m as Record<string, unknown>;
    if (typeof raw.model === "string") model = raw.model;
    const u = raw.usage as Record<string, unknown> | undefined;
    if (!u) continue;
    usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    usage.input += num(u.input);
    usage.output += num(u.output);
    usage.cacheRead += num(u.cacheRead);
    usage.cacheWrite += num(u.cacheWrite);
    usage.cost += num((u.cost as Record<string, unknown> | undefined)?.total);
  }
  return { usage, model };
}

// omp's history: the `.message` of each `type: "message"` line is already the OmpMessage the
// transcript reducer reads.
export function ompFileMessages(text: string): OmpMessage[] {
  const out: OmpMessage[] = [];
  for (const line of jsonLines(text)) if (line.type === "message" && line.message && typeof line.message === "object") out.push(line.message as OmpMessage);
  return out;
}

// codex's rollout file (`~/.codex/sessions/…/rollout-*.jsonl`): `token_count` events carry the
// session's CUMULATIVE usage (it keeps growing across resume), so the last one is the total.
// `input_tokens` includes the cached part, split out here as omp/claude count it. No cost in
// the file (ChatGPT plan) — 0, not a guess. The model is on every `turn_context`.
export function codexFileUsage(text: string): FileUsage {
  let total: Record<string, unknown> | undefined;
  let model: string | undefined;
  for (const line of jsonLines(text)) {
    const p = line.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    if (line.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (line.type === "event_msg" && p.type === "token_count") {
      const info = p.info as Record<string, unknown> | null | undefined;
      if (info?.total_token_usage && typeof info.total_token_usage === "object") total = info.total_token_usage as Record<string, unknown>;
    }
  }
  if (!total) return { model };
  const cached = num(total.cached_input_tokens);
  return {
    usage: { input: Math.max(0, num(total.input_tokens) - cached), output: num(total.output_tokens), cacheRead: cached, cacheWrite: num(total.cache_write_input_tokens), cost: 0 },
    model,
  };
}

// A codex tool output: a string, or `[{type, text}]` parts.
function codexOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return (raw as Array<{ text?: unknown }>).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  return "";
}

// codex's history as the OmpMessage seam the transcript reducer reads. The prompt comes from an
// `event_msg`: `user_message` (codex ≤ 0.147) or `item_completed` with a `UserMessage` item
// (0.163) — the `response_item` user messages also carry codex's injected blocks
// (`<environment_context>` …), and `developer` messages are system text. Assistant text and tool
// calls are `response_item`s; a call pairs with its output on `call_id`. Reasoning is encrypted
// and skipped.
export function codexFileMessages(text: string): OmpMessage[] {
  const out: OmpMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const line of jsonLines(text)) {
    const p = line.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    const timestamp = Number.isFinite(at) ? { timestamp: at } : {};
    if (line.type === "event_msg") {
      let prompt: string | undefined;
      if (p.type === "user_message" && typeof p.message === "string") prompt = p.message;
      const item = p.item as { type?: unknown; content?: unknown } | undefined;
      if (p.type === "item_completed" && item?.type === "UserMessage" && Array.isArray(item.content))
        prompt = (item.content as Array<{ type?: unknown; text?: unknown }>).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
      // A build writing both shapes would otherwise show the prompt twice.
      const last = out[out.length - 1];
      if (prompt?.trim() && !(last?.role === "user" && last.content?.[0]?.text === prompt))
        out.push({ role: "user", content: [{ type: "text", text: prompt }], ...timestamp });
      continue;
    }
    if (line.type !== "response_item") continue;
    const callId = typeof p.call_id === "string" ? p.call_id : "";
    if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      const parts = (p.content as Array<{ type?: unknown; text?: unknown }>)
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => ({ type: "text", text: c.text as string }));
      if (parts.length) out.push({ role: "assistant", content: parts, ...timestamp });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = typeof p.name === "string" ? p.name : "?";
      toolNames.set(callId, name);
      let args: Record<string, unknown> = { input: p.input };
      if (p.type === "function_call") {
        try {
          const parsed = JSON.parse(String(p.arguments)) as unknown;
          args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { arguments: p.arguments };
        } catch {
          args = { arguments: p.arguments };
        }
      }
      out.push({ role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], ...timestamp });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      out.push({
        role: "toolResult",
        toolCallId: callId,
        ...(toolNames.has(callId) ? { toolName: toolNames.get(callId) } : {}),
        content: [{ type: "text", text: codexOutputText(p.output) }],
        ...timestamp,
      });
    }
  }
  return out;
}

// Each harness's session-file usage reader.
const FILE_USAGE: Record<NativeHarness, (text: string) => FileUsage> = { "claude-code": claudeFileUsage, omp: ompFileUsage, codex: codexFileUsage };

// claude's project directory name for a working directory.
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object") yield v as Record<string, unknown>;
    } catch {
      // A half-written last line (the harness is mid-append) is skipped, not fatal.
    }
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

@Injectable()
export class NativeSessionService implements OnModuleInit, OnModuleDestroy {
  readonly events$ = new Subject<NativeEvent>();
  private runs = new Map<string, Run>();
  private starting = new Map<string, Promise<void>>();
  private sub: Subscription;
  // The SDK's history reader — a test seam, like ClaudeCodeRuntime's.
  readClaudeHistory: (sessionId: string, options?: GetSessionMessagesOptions) => Promise<SessionMessage[]> = getSessionMessages;

  constructor(
    private registry: RegistryService,
    private terminal: TerminalService,
    @Optional() private http?: HttpAdapterHost,
    // The session browser's tools — a deliberate exception to «nothing of Kermanych enters a
    // native session» (docs/specs/2026-10-05-embedded-browser.md → Who gets the tools).
    @Optional() private browser?: BrowserMcpService,
  ) {
    this.sub = this.terminal.events$.subscribe((e) => {
      if (e.type !== "exit") return;
      for (const [id, run] of this.runs) if (run.terminalId === e.id) this.onExit(id, run);
    });
  }

  // A native row left active by the previous api process: its pty died with that process.
  onModuleInit(): void {
    for (const s of this.registry.listSessions()) {
      if (s.native && ACTIVE_STATUSES.includes(s.status)) this.registry.updateSession(s.id, { status: "stopped" });
    }
  }

  // App close: TerminalService kills every pty, and their exit events may never be processed,
  // so the rows are written `stopped` here — reopening shows «Продовжити», not a stale state.
  onModuleDestroy(): void {
    this.sub.unsubscribe();
    for (const id of this.runs.keys()) this.persist(id, "stopped");
    this.runs.clear();
  }

  isRunning(id: string): boolean {
    return !!this.runs.get(id)?.terminalId;
  }

  live(id: string): NativeLive | undefined {
    const run = this.runs.get(id);
    if (!run?.terminalId) return undefined;
    return { status: run.status, currentTool: run.currentTool, error: run.error, terminalId: run.terminalId };
  }

  // Launch the harness in the session's working directory. `resume` continues the session's
  // saved conversation when one is known (a fresh start otherwise); `prompt` is submitted as
  // the harness's positional argument. A running session is left alone.
  start(session: Session, opts: { prompt?: string; resume: boolean }): Promise<void> {
    if (this.isRunning(session.id)) return Promise.resolve();
    const inflight = this.starting.get(session.id);
    if (inflight) return inflight;
    const p = this.doStart(session, opts).finally(() => this.starting.delete(session.id));
    this.starting.set(session.id, p);
    return p;
  }

  private async doStart(session: Session, opts: { prompt?: string; resume: boolean }): Promise<void> {
    const project = this.registry.listProjects().find((p) => p.id === session.projectId);
    const cwd = session.worktreePath || project?.localRepoPath;
    if (!cwd) throw new Error("project not bound");
    const port = this.port();
    if (!port) throw new Error("the api is not listening yet");
    const token = randomBytes(24).toString("hex");
    const prompt = opts.prompt?.trim() ? opts.prompt : undefined;
    const mcp = this.browser?.bindingFor(session.id);
    const { file, args } = await this.command(session, cwd, opts.resume, prompt, mcp);

    const run = { token, status: prompt ? "queued" : this.settled(session.id) } as Run;
    run.exited = new Promise<void>((resolve) => (run.onExit = resolve));
    this.runs.set(session.id, run);
    try {
      const info = this.terminal.openSession({
        sessionId: session.id,
        projectId: session.projectId,
        cwd,
        file,
        args,
        env: {
          [NATIVE_URL_ENV]: `http://127.0.0.1:${port}/api/native/${session.id}`,
          [NATIVE_TOKEN_ENV]: token,
          // omp's bridge reads the browser server from here, and codex its bearer
          // (`bearer_token_env_var`); claude has both in its --mcp-config.
          ...(mcp && session.runtime !== "claude-code" ? { [MCP_URL_ENV]: mcp.url, [MCP_TOKEN_ENV]: mcp.token } : {}),
        },
      });
      run.terminalId = info.id;
    } catch (err) {
      this.runs.delete(session.id);
      throw err;
    }
    this.persist(session.id, run.status);
    this.events$.next({ type: "changed", sessionId: session.id });
  }

  // The harness argv (docs/specs/2026-10-05-native-sessions.md → Commands,
  // docs/specs/2026-10-16-native-codex.md → D3). `--` keeps a prompt that opens with a dash, or
  // with a subcommand's name, from being read as an option. With the session browser bound,
  // claude also gets `--mcp-config <file>` — variadic, so it stays right before the `--` tail (or
  // last) and never swallows a following argument — omp a second `--hook`: the MCP bridge, which
  // reads its server from the pty env, and codex an `mcp_servers` override. A chat runs in the
  // operator's own checkout, so it keeps the managed chat's read-only built-ins on every launch
  // (docs/specs/2026-10-06-native-chats.md); `--tools` is variadic for claude too, so it sits
  // before `--settings`. codex has no tool allowlist: its chat is read-only by sandbox.
  private async command(
    session: Session,
    cwd: string,
    resume: boolean,
    prompt?: string,
    mcp?: { name: string; url: string; token: string },
  ): Promise<{ file: string; args: string[] }> {
    const tail = prompt ? ["--", prompt] : [];
    const chat = session.kind === "chat";
    const harness: NativeHarness = session.runtime ?? "omp";
    switch (harness) {
      case "claude-code": {
        const tools = chat ? ["--tools", CHAT_TOOLS.map(claudeToolName).join(",")] : [];
        const settings = await claudeSettingsPath();
        const mcpArgs = mcp ? ["--mcp-config", await claudeMcpConfigPath(session.id, mcp)] : [];
        if (resume && session.ompSessionId)
          return { file: "claude", args: ["--resume", session.ompSessionId, ...tools, "--settings", settings, ...mcpArgs, ...tail] };
        // Kermanych names the transcript, so history and usage are findable before any hook.
        const uuid = randomUUID();
        this.registry.updateSession(session.id, { ompSessionId: uuid });
        return { file: "claude", args: ["--session-id", uuid, ...tools, "--settings", settings, ...mcpArgs, ...tail] };
      }
      case "omp": {
        const hook = await ompExtensionPath();
        const from = resume && session.ompSessionFile ? ["--resume", session.ompSessionFile] : [];
        const bridge = mcp ? ["--hook", await ompMcpBridgePath()] : [];
        const tools = chat ? ["--tools", CHAT_TOOLS.join(",")] : [];
        return { file: "omp", args: ["launch", ...from, ...tools, "--hook", hook, ...bridge, ...tail] };
      }
      case "codex": {
        // codex mints its own session id; the hooks report it (codexHook). Options go before
        // `resume`'s positional id. The trust override needs the realpath (/private/tmp/…).
        const flags = [...codexConfigArgs(await realpath(cwd), await codexHookPath(), mcp), ...(chat ? ["-s", "read-only", "-a", "never"] : [])];
        if (resume && session.ompSessionId) return { file: "codex", args: ["resume", ...flags, session.ompSessionId, ...tail] };
        return { file: "codex", args: [...flags, ...tail] };
      }
    }
  }

  // Kill the harness (SIGHUP, then SIGKILL past a grace period) and resolve once it exited.
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run?.terminalId) return;
    const terminalId = run.terminalId;
    this.terminal.kill(terminalId);
    const grace = setTimeout(() => this.terminal.kill(terminalId, "SIGKILL"), KILL_GRACE_MS);
    try {
      await run.exited;
    } finally {
      clearTimeout(grace);
    }
  }

  async restart(session: Session): Promise<void> {
    await this.stop(session.id);
    const fresh = this.registry.listSessions().find((s) => s.id === session.id) ?? session;
    await this.start(fresh, { resume: true });
  }

  // Hand the harness a prompt. Idle at its input box → bracketed paste (one message, newlines
  // intact) and Enter a beat later; not running → resumed with the prompt; anything else (mid
  // turn, waiting on the operator, still starting) → `native_busy`, and the operator retries.
  async send(id: string, text: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run?.terminalId) {
      if (this.starting.has(id)) throw nativeBusy();
      const session = this.registry.listSessions().find((s) => s.id === id);
      if (!session) throw new Error("session not found");
      await this.start(session, { prompt: text, resume: true });
      return;
    }
    if (!PASTE_OK.includes(run.status)) throw nativeBusy();
    const terminalId = run.terminalId;
    this.terminal.write(terminalId, `\x1b[200~${text}\x1b[201~`);
    setTimeout(() => this.terminal.write(terminalId, "\r"), SUBMIT_DELAY_MS);
    // Busy from here, so a second helper is refused until the harness settles again.
    this.setStatus(id, run, "queued");
  }

  // A helper prompt was just handed over: its outcome decides how the turn settles.
  async arm(id: string, kind: "pr" | "review"): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    if (kind === "review") {
      run.reviewPending = true;
      return;
    }
    run.prRequested = true;
    const session = this.registry.listSessions().find((s) => s.id === id);
    run.prFrom = session ? (await this.history(session).catch(() => [])).length : 0;
  }

  // The supervisor found the tree mid-merge right after a turn settled at `settled`: the session
  // rests at `conflict` instead — unless a new turn has already moved it.
  markConflict(id: string, settled: SessionStatus): void {
    const run = this.runs.get(id);
    if (run?.status === settled) this.setStatus(id, run, "conflict");
  }

  // The merge is gone, resolved outside a turn: back to the rest state.
  resettle(id: string): void {
    const run = this.runs.get(id);
    if (run) return this.setStatus(id, run, this.settled(id));
    this.persist(id, this.settled(id));
    this.events$.next({ type: "changed", sessionId: id });
  }

  authorize(id: string, token: string | undefined): boolean {
    const run = this.runs.get(id);
    if (!run || !token) return false;
    const a = Buffer.from(run.token);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // A claude hook's stdin JSON. The caller has already checked the bearer.
  claudeHook(id: string, body: Record<string, unknown>): void {
    const run = this.runs.get(id);
    if (!run) return;
    if (typeof body.transcript_path === "string") run.transcriptPath = body.transcript_path;
    switch (body.hook_event_name) {
      case "SessionStart": {
        // `/clear` and resume can start a new session id: the next resume must continue it.
        const sid = body.session_id;
        if (typeof sid === "string" && sid) {
          const s = this.registry.listSessions().find((x) => x.id === id);
          if (s && s.ompSessionId !== sid) this.registry.updateSession(id, { ompSessionId: sid });
        }
        return;
      }
      case "UserPromptSubmit":
        run.error = undefined;
        this.registry.touchSession(id);
        return this.setStatus(id, run, "thinking");
      case "PreToolUse": {
        const tool = typeof body.tool_name === "string" ? body.tool_name : "";
        if (CLAUDE_ASKING_TOOLS[tool] === true) return this.setStatus(id, run, "waiting_input");
        return this.setStatus(id, run, "tool", tool || undefined);
      }
      case "PostToolUse":
        return this.setStatus(id, run, "thinking");
      case "PermissionRequest":
        return this.setStatus(id, run, "waiting_input");
      case "Notification":
        if (CLAUDE_ASKING_NOTIFICATIONS[String(body.notification_type)] === true) this.setStatus(id, run, "waiting_input");
        return;
      case "Stop":
        this.settle(id, run);
        this.afterTurn(id, CLAUDE_FLUSH_MS);
        return;
    }
  }

  // A normalized event from the omp extension (native-hooks.ts). The bearer is checked.
  ompEvent(id: string, body: Record<string, unknown>): void {
    const run = this.runs.get(id);
    if (!run) return;
    switch (body.event) {
      case "session": {
        const file = typeof body.sessionFile === "string" && body.sessionFile ? body.sessionFile : undefined;
        const sid = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined;
        const s = this.registry.listSessions().find((x) => x.id === id);
        if (s && ((file && s.ompSessionFile !== file) || (sid && s.ompSessionId !== sid)))
          this.registry.updateSession(id, { ...(file ? { ompSessionFile: file } : {}), ...(sid ? { ompSessionId: sid } : {}) });
        return;
      }
      case "working":
        run.error = undefined;
        this.registry.touchSession(id);
        return this.setStatus(id, run, "thinking");
      case "tool": {
        const tool = typeof body.toolName === "string" ? body.toolName : "";
        if (tool === "ask") return this.setStatus(id, run, "waiting_input");
        return this.setStatus(id, run, "tool", tool || undefined);
      }
      case "tool_end":
      case "unblocked":
        return this.setStatus(id, run, "thinking");
      case "blocked":
        return this.setStatus(id, run, "waiting_input");
      case "idle":
        this.settle(id, run);
        this.afterTurn(id, 0);
        return;
      case "error":
        run.error = typeof body.message === "string" && body.message ? body.message : "omp error";
        this.setStatus(id, run, "error");
        this.afterTurn(id, 0);
        return;
    }
  }

  // A codex hook's stdin JSON (docs/specs/2026-10-16-native-codex.md → D6, D7). The bearer is
  // checked. Every event carries the current session id and rollout path: `/new` and `/resume`
  // inside the TUI switch them, and «Продовжити» must continue the conversation last open.
  codexHook(id: string, body: Record<string, unknown>): void {
    const run = this.runs.get(id);
    if (!run) return;
    const sid = typeof body.session_id === "string" && body.session_id ? body.session_id : undefined;
    const file = typeof body.transcript_path === "string" && body.transcript_path ? body.transcript_path : undefined;
    if (sid || file) {
      const s = this.registry.listSessions().find((x) => x.id === id);
      if (s && ((sid && s.ompSessionId !== sid) || (file && s.ompSessionFile !== file)))
        this.registry.updateSession(id, { ...(sid ? { ompSessionId: sid } : {}), ...(file ? { ompSessionFile: file } : {}) });
    }
    switch (body.hook_event_name) {
      case "UserPromptSubmit":
        run.error = undefined;
        this.registry.touchSession(id);
        return this.setStatus(id, run, "thinking");
      case "PreToolUse": {
        const tool = typeof body.tool_name === "string" ? body.tool_name : "";
        if (tool === CODEX_ASK_TOOL) return this.setStatus(id, run, "waiting_input");
        return this.setStatus(id, run, "tool", tool || undefined);
      }
      case "PostToolUse":
        return this.setStatus(id, run, "thinking");
      case "PermissionRequest":
        return this.setStatus(id, run, "waiting_input");
      // Esc ends a turn without `Stop`; codex < 0.163 sends no `Interrupt` either, and a failed
      // turn has no hook at all — both stay busy until the next prompt (spec D6).
      case "Stop":
      case "Interrupt":
        this.settle(id, run);
        this.afterTurn(id, CODEX_FLUSH_MS);
        return;
    }
  }

  // The session's history from the harness's own file, as the Лог/Сесія transcript renders it.
  async transcript(session: Session): Promise<Rehydrated> {
    return messagesToTranscript(await this.history(session).catch(() => []));
  }

  private async history(session: Session): Promise<OmpMessage[]> {
    const harness: NativeHarness = session.runtime ?? "omp";
    switch (harness) {
      case "claude-code": {
        if (!session.ompSessionId) return [];
        const cwd = this.cwd(session);
        return claudeHistoryToOmp(await this.readClaudeHistory(session.ompSessionId, cwd ? { dir: cwd } : undefined));
      }
      case "omp":
        return session.ompSessionFile ? ompFileMessages(await readFile(session.ompSessionFile, "utf8")) : [];
      case "codex":
        return session.ompSessionFile ? codexFileMessages(await readFile(session.ompSessionFile, "utf8")) : [];
    }
  }

  private cwd(session: Session): string | undefined {
    return session.worktreePath || this.registry.listProjects().find((p) => p.id === session.projectId)?.localRepoPath || undefined;
  }

  private sessionFilePath(session: Session, run?: Run): string | undefined {
    if (session.runtime !== "claude-code") return session.ompSessionFile;
    if (run?.transcriptPath) return run.transcriptPath;
    const cwd = this.cwd(session);
    if (!cwd || !session.ompSessionId) return undefined;
    return join(homedir(), ".claude", "projects", claudeProjectDir(cwd), `${session.ompSessionId}.jsonl`);
  }

  // After a turn: usage (absolute), the model last used, an armed PR link, and the history.
  private afterTurn(id: string, delayMs: number): void {
    const go = () => void this.readTurn(id).catch((err: unknown) => console.warn(`[native] could not read the session file of ${id}: ${(err as Error).message}`));
    if (delayMs) setTimeout(go, delayMs);
    else go();
  }

  async readTurn(id: string): Promise<void> {
    const session = this.registry.listSessions().find((s) => s.id === id);
    if (!session) return;
    const run = this.runs.get(id);
    const path = this.sessionFilePath(session, run);
    if (path) {
      const text = await readFile(path, "utf8").catch(() => "");
      const { usage, model } = FILE_USAGE[session.runtime ?? "omp"](text);
      if (usage) this.registry.setUsage(id, usage);
      if (model && model !== session.model) this.registry.updateSession(id, { model });
    }
    const messages = await this.history(session).catch(() => [] as OmpMessage[]);
    const transcript = messagesToTranscript(messages);
    // A native chat's opening message is typed into its TUI, not sent through the supervisor's
    // deliver, so it is learned here: it names the thread and seeds «В беклог», as a managed
    // chat's first message does.
    if (session.kind === "chat" && !session.task.trim()) {
      const first = transcript.entries.find((e) => e.kind === "user_text" && e.text.trim());
      if (first?.kind === "user_text") this.registry.updateSession(id, { task: first.text.trim() });
    }
    if (run?.prRequested && !session.prOpened && this.mentionsPr(messages.slice(run.prFrom ?? 0))) {
      run.prRequested = false;
      this.registry.updateSession(id, { prOpened: true });
      if (run.status === "done") this.setStatus(id, run, "in_review");
    }
    this.events$.next({ type: "transcript", sessionId: id, transcript });
    this.events$.next({ type: "changed", sessionId: id });
  }

  private mentionsPr(messages: OmpMessage[]): boolean {
    const { entries, full } = messagesToTranscript(messages);
    return entries.some(
      (e) =>
        (e.kind === "assistant_text" && PR_URL_RE.test(e.text)) ||
        (e.kind === "tool" && (full.get(e.id) ?? []).some((ln) => "text" in ln && PR_URL_RE.test(ln.text))),
    );
  }

  // The rest state after a turn: on review when the branch has a PR or a «Закоміти» landed.
  private settle(id: string, run: Run): void {
    const status = run.reviewPending ? "in_review" : this.settled(id);
    run.reviewPending = false;
    this.setStatus(id, run, status);
    this.events$.next({ type: "settled", sessionId: id, status });
  }

  private settled(id: string): SessionStatus {
    return this.registry.listSessions().find((s) => s.id === id)?.prOpened ? "in_review" : "done";
  }

  private setStatus(id: string, run: Run, status: SessionStatus, currentTool?: string): void {
    if (run.status === status && run.currentTool === currentTool) return;
    const persist = run.status !== status;
    run.status = status;
    run.currentTool = currentTool;
    if (status !== "error") run.error = undefined;
    if (persist) this.persist(id, status);
    this.events$.next({ type: "changed", sessionId: id });
  }

  private persist(id: string, status: SessionStatus): void {
    try {
      this.registry.updateSession(id, { status });
    } catch {
      // The row was deleted while its harness was still reporting.
    }
  }

  private onExit(id: string, run: Run): void {
    this.runs.delete(id);
    this.persist(id, "stopped");
    run.onExit();
    this.events$.next({ type: "changed", sessionId: id });
  }

  private port(): number | undefined {
    const address = this.http?.httpAdapter?.getHttpServer()?.address() as { port?: number } | string | null | undefined;
    return address && typeof address === "object" ? address.port : undefined;
  }
}
