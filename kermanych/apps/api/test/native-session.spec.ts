// apps/api/test/native-session.spec.ts
// Native sessions (docs/specs/2026-10-05-native-sessions.md, 2026-10-16-native-codex.md): the
// harness argv, the hook → status mapping per harness, the per-launch bearer, helper delivery by
// bracketed paste, the session-file readers, and the api-start reset. The pty is a fake
// TerminalService.
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, TerminalInfo } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import type { TerminalEvent, TerminalService } from "../src/terminal/terminal.service";
import { claudeFileUsage, codexFileMessages, codexFileUsage, NativeSessionService, ompFileUsage, type NativeEvent } from "../src/native/native-session.service";
import { codexHookHash } from "../src/native/native-hooks";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";
import { NativeController } from "../src/http/native.controller";
import { CodedError } from "../src/management/coded-error";
import type { BrowserMcpService } from "../src/browser/browser-mcp.service";

type OpenOpts = Parameters<TerminalService["openSession"]>[0];

function fakeTerminal() {
  const events$ = new Subject<TerminalEvent>();
  let n = 0;
  const opened: OpenOpts[] = [];
  const terminal = {
    events$,
    openSession: vi.fn((o: OpenOpts): TerminalInfo => {
      opened.push(o);
      return { id: `t${++n}`, projectId: o.projectId, cwd: o.cwd, shell: o.file, pid: 1, createdAt: "", sessionId: o.sessionId };
    }),
    write: vi.fn(),
    // The pty dies on the hangup, as a real harness does.
    kill: vi.fn((id: string) => queueMicrotask(() => events$.next({ type: "exit", id, exitCode: 0 }))),
  };
  return { terminal, opened };
}

const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "native-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function make(browser?: { name: string; url: string; token: string }) {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "p", localRepoPath: dir });
  const { terminal, opened } = fakeTerminal();
  // Only bindingFor is read at launch; undefined = no session browser (a standalone api).
  const mcp = browser ? ({ bindingFor: () => browser } as unknown as BrowserMcpService) : undefined;
  const native = new NativeSessionService(registry, terminal as unknown as TerminalService, http, mcp);
  native.readClaudeHistory = async () => [];
  const events: NativeEvent[] = [];
  native.events$.subscribe((e) => events.push(e));
  const create = (runtime: Session["runtime"], over: Partial<Session> = {}): Session =>
    registry.createSession({ projectId: "p1", name: "n", task: "t", worktreePath: dir, branch: "b", runtime, native: true, ...over });
  const row = (id: string) => registry.listSessions().find((s) => s.id === id)!;
  return { registry, terminal, opened, native, events, create, row };
}

describe("harness argv", () => {
  it("claude: a fresh start names the transcript, a resume continues it; settings ride both", async () => {
    const { native, opened, create, row, terminal } = make();
    const s = create("claude-code");
    await native.start(s, { prompt: "-fix the bug", resume: false });
    const uuid = row(s.id).ompSessionId!;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    const settings = join(tmpdir(), "kermanych-native", "claude-settings.json");
    expect(opened[0]).toMatchObject({ sessionId: s.id, projectId: "p1", cwd: dir, file: "claude" });
    expect(opened[0].args).toEqual(["--session-id", uuid, "--settings", settings, "--", "-fix the bug"]);
    expect(opened[0].env).toMatchObject({ KERMANYCH_NATIVE_URL: `http://127.0.0.1:4317/api/native/${s.id}` });
    expect(native.live(s.id)).toMatchObject({ status: "queued", terminalId: "t1" });

    await native.stop(s.id);
    expect(terminal.kill).toHaveBeenCalledWith("t1");
    expect(row(s.id).status).toBe("stopped");
    expect(native.live(s.id)).toBeUndefined();

    await native.start(row(s.id), { resume: true });
    expect(opened[1].args).toEqual(["--resume", uuid, "--settings", settings]);
    // Launched without a prompt: idle at its input box.
    expect(native.live(s.id)?.status).toBe("done");
  });

  it("omp: `launch` with the hook; resume by session file once the extension reported one", async () => {
    const { native, opened, create, row, terminal } = make();
    const s = create("omp");
    await native.start(s, { prompt: "review the code", resume: true });
    const hook = join(tmpdir(), "kermanych-native", "omp-native.js");
    // No file known yet → a fresh start even though a resume was asked for.
    expect(opened[0]).toMatchObject({ file: "omp", args: ["launch", "--hook", hook, "--", "review the code"] });

    const token = opened[0].env!.KERMANYCH_NATIVE_TOKEN;
    expect(native.authorize(s.id, token)).toBe(true);
    native.ompEvent(s.id, { event: "session", sessionId: "abc", sessionFile: "/x/s.jsonl" });
    expect(row(s.id).ompSessionFile).toBe("/x/s.jsonl");

    terminal.events$.next({ type: "exit", id: "t1", exitCode: 0 });
    await native.start(row(s.id), { resume: true });
    expect(opened[1].args).toEqual(["launch", "--resume", "/x/s.jsonl", "--hook", hook]);
  });

  it("with the session browser bound: claude gets a 0600 --mcp-config before the tail, omp the bridge hook and env", async () => {
    const binding = { name: "kermanych", url: "http://127.0.0.1:4317/api/browser/mcp", token: "tok" };
    const { native, opened, create, row } = make(binding);
    const c = create("claude-code");
    await native.start(c, { prompt: "go", resume: false });
    const settings = join(tmpdir(), "kermanych-native", "claude-settings.json");
    const config = join(tmpdir(), "kermanych-native", `mcp-${c.id}.json`);
    expect(opened[0].args).toEqual(["--session-id", row(c.id).ompSessionId, "--settings", settings, "--mcp-config", config, "--", "go"]);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      mcpServers: { kermanych: { type: "http", url: binding.url, headers: { Authorization: "Bearer tok" } } },
    });
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(opened[0].env).not.toHaveProperty("KERMANYCH_MCP_TOKEN");

    const o = create("omp");
    await native.start(o, { resume: false });
    const hook = join(tmpdir(), "kermanych-native", "omp-native.js");
    const bridge = join(tmpdir(), "kermanych-omp-mcp", "bridge.js");
    expect(opened[1].args).toEqual(["launch", "--hook", hook, "--hook", bridge]);
    expect(opened[1].env).toMatchObject({ KERMANYCH_MCP_URL: binding.url, KERMANYCH_MCP_TOKEN: "tok", KERMANYCH_NATIVE_TOKEN: expect.any(String) });
  });

  it("codex: trusted folder and pre-trusted hooks on every launch; resume by the id its hooks report", async () => {
    const binding = { name: "kermanych", url: "http://127.0.0.1:4317/api/browser/mcp", token: "tok" };
    const { native, opened, create, row, terminal } = make(binding);
    const s = create("codex");
    await native.start(s, { prompt: "--fix it", resume: true });
    const hook = join(tmpdir(), "kermanych-native", "codex-hook.sh");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    const args = opened[0].args;
    expect(opened[0].file).toBe("codex");
    // No id known yet → a fresh start; the prompt stays text after `--`.
    expect(args[0]).toBe("-c");
    expect(args.slice(-2)).toEqual(["--", "--fix it"]);
    expect(args).toContain(`projects={${JSON.stringify(realpathSync(dir))}={trust_level="trusted"}}`);
    const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt"];
    for (const e of events) expect(args).toContain(`hooks.${e}=[{hooks=[{type="command",command=${JSON.stringify(`'${hook}'`)},timeout=3,async=false}]}]`);
    const state = args.find((a) => a.startsWith("hooks.state="))!;
    expect(state).toContain(`"/<session-flags>/config.toml:user_prompt_submit:0:0"={trusted_hash="${codexHookHash("user_prompt_submit", `'${hook}'`, 3)}"}`);
    expect(state.match(/trusted_hash=/g)).toHaveLength(events.length);
    // The session MCP server's bearer stays in the env, never in argv.
    expect(args).toContain(`mcp_servers.kermanych={url="${binding.url}",bearer_token_env_var="KERMANYCH_MCP_TOKEN"}`);
    expect(args.join(" ")).not.toContain("tok\"");
    expect(opened[0].env).toMatchObject({ KERMANYCH_MCP_TOKEN: "tok" });
    expect(args).not.toContain("read-only");

    native.codexHook(s.id, { hook_event_name: "SessionStart", session_id: "01a1-x", transcript_path: "/x/rollout.jsonl" });
    expect(row(s.id)).toMatchObject({ ompSessionId: "01a1-x", ompSessionFile: "/x/rollout.jsonl" });
    terminal.events$.next({ type: "exit", id: "t1", exitCode: 0 });
    await native.start(row(s.id), { prompt: "more", resume: true });
    const resumed = opened[1].args;
    expect(resumed[0]).toBe("resume");
    expect(resumed.slice(-3)).toEqual(["01a1-x", "--", "more"]);
  });

  it("codex chat: read-only by sandbox, on every start", async () => {
    const { native, opened, create } = make();
    const s = create("codex", { kind: "chat" });
    await native.start(s, { resume: false });
    expect(opened[0].args.slice(-4)).toEqual(["-s", "read-only", "-a", "never"]);
  });

  it("codex trusted_hash reproduces the value codex itself wrote for a hook", () => {
    // From a real codex 0.147 config.toml after «Trust all» for `-c hooks.Stop=[{hooks=[{type="command",
    // command="/tmp/cxsmoke/hook.sh Stop",timeout=5,async=false}]}]`.
    expect(codexHookHash("stop", "/tmp/cxsmoke/hook.sh Stop", 5)).toBe("sha256:3540b6ed7771f9d056b4f997eb7b69a5d51c84aaf9f018339fd76747d721f8f9");
  });
});

describe("status mapping", () => {
  it("claude hooks", async () => {
    const { native, create, row } = make();
    const s = create("claude-code");
    await native.start(s, { prompt: "go", resume: false });
    const status = () => native.live(s.id);
    const hook = (body: Record<string, unknown>) => native.claudeHook(s.id, body);

    hook({ hook_event_name: "SessionStart", session_id: "11111111-2222-3333-4444-555555555555" });
    expect(row(s.id).ompSessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(status()?.status).toBe("queued");
    hook({ hook_event_name: "UserPromptSubmit" });
    expect(status()?.status).toBe("thinking");
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(status()).toMatchObject({ status: "tool", currentTool: "Bash" });
    hook({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(status()).toMatchObject({ status: "thinking", currentTool: undefined });
    hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
    expect(status()?.status).toBe("waiting_input");
    hook({ hook_event_name: "PostToolUse" });
    hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
    expect(status()?.status).toBe("waiting_input");
    hook({ hook_event_name: "UserPromptSubmit" });
    hook({ hook_event_name: "Notification", notification_type: "idle_prompt" });
    expect(status()?.status).toBe("thinking");
    hook({ hook_event_name: "Notification", notification_type: "permission_prompt" });
    expect(status()?.status).toBe("waiting_input");
    hook({ hook_event_name: "Stop" });
    expect(status()?.status).toBe("done");
    expect(row(s.id).status).toBe("done");
  });

  it("codex hooks, including Interrupt and a handle switched inside the TUI", async () => {
    const { native, create, row } = make();
    const s = create("codex");
    await native.start(s, { prompt: "go", resume: false });
    const status = () => native.live(s.id);
    const hook = (body: Record<string, unknown>) => native.codexHook(s.id, { session_id: "a", transcript_path: "/x/a.jsonl", ...body });

    hook({ hook_event_name: "UserPromptSubmit" });
    expect(status()?.status).toBe("thinking");
    expect(row(s.id).ompSessionId).toBe("a");
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(status()).toMatchObject({ status: "tool", currentTool: "Bash" });
    hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
    expect(status()?.status).toBe("waiting_input");
    hook({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(status()).toMatchObject({ status: "thinking", currentTool: undefined });
    hook({ hook_event_name: "PreToolUse", tool_name: "request_user_input" });
    expect(status()?.status).toBe("waiting_input");
    hook({ hook_event_name: "Stop" });
    expect(status()?.status).toBe("done");
    // Esc mid-turn: no Stop, an Interrupt.
    hook({ hook_event_name: "UserPromptSubmit" });
    hook({ hook_event_name: "Interrupt" });
    expect(status()?.status).toBe("done");
    // `/new` in the TUI: the next prompt reports the new conversation.
    native.codexHook(s.id, { hook_event_name: "SessionStart", source: "startup", session_id: "b", transcript_path: "/x/b.jsonl" });
    expect(row(s.id)).toMatchObject({ ompSessionId: "b", ompSessionFile: "/x/b.jsonl" });
  });

  it("omp events, and `in_review` once the branch has a PR", async () => {
    const { native, create, registry } = make();
    const s = create("omp");
    await native.start(s, { prompt: "go", resume: false });
    const status = () => native.live(s.id);
    const ev = (body: Record<string, unknown>) => native.ompEvent(s.id, body);

    ev({ event: "working" });
    expect(status()?.status).toBe("thinking");
    ev({ event: "tool", toolName: "bash" });
    expect(status()).toMatchObject({ status: "tool", currentTool: "bash" });
    ev({ event: "tool_end" });
    expect(status()?.status).toBe("thinking");
    ev({ event: "tool", toolName: "ask" });
    expect(status()?.status).toBe("waiting_input");
    ev({ event: "tool_end" });
    ev({ event: "blocked" });
    expect(status()?.status).toBe("waiting_input");
    ev({ event: "unblocked" });
    expect(status()?.status).toBe("thinking");
    ev({ event: "error", message: "rate limited" });
    expect(status()).toMatchObject({ status: "error", error: "rate limited" });
    ev({ event: "working" });
    expect(status()).toMatchObject({ status: "thinking", error: undefined });
    ev({ event: "idle" });
    expect(status()?.status).toBe("done");

    registry.updateSession(s.id, { prOpened: true });
    ev({ event: "working" });
    ev({ event: "idle" });
    expect(status()?.status).toBe("in_review");
  });

  it("a «Закоміти» turn settles on review", async () => {
    const { native, create } = make();
    const s = create("omp");
    await native.start(s, { resume: false });
    await native.arm(s.id, "review");
    native.ompEvent(s.id, { event: "working" });
    native.ompEvent(s.id, { event: "idle" });
    expect(native.live(s.id)?.status).toBe("in_review");
  });

  it("pty exit persists `stopped`", async () => {
    const { native, create, row, terminal, events } = make();
    const s = create("omp");
    await native.start(s, { prompt: "go", resume: false });
    terminal.events$.next({ type: "exit", id: "t1", exitCode: 0 });
    expect(row(s.id).status).toBe("stopped");
    expect(native.isRunning(s.id)).toBe(false);
    expect(events.at(-1)).toEqual({ type: "changed", sessionId: s.id });
  });
});

describe("hook bearer", () => {
  it("only the current launch's token is accepted", async () => {
    const { native, create, opened, terminal } = make();
    const s = create("claude-code");
    const controller = new NativeController(native);
    await native.start(s, { prompt: "go", resume: false });
    const token = opened[0].env!.KERMANYCH_NATIVE_TOKEN;

    const refused = (auth: string | undefined) => {
      try {
        controller.claude(s.id, auth, { hook_event_name: "UserPromptSubmit" });
      } catch (err) {
        return err instanceof HttpException ? err.getStatus() : err;
      }
      return "accepted";
    };
    expect(refused(undefined)).toBe(401);
    expect(refused("Bearer nope")).toBe(401);
    expect(refused(`Bearer ${token}`)).toBe("accepted");
    expect(native.live(s.id)?.status).toBe("thinking");

    // A relaunch mints a new secret; the old one is dead.
    terminal.events$.next({ type: "exit", id: "t1", exitCode: 0 });
    expect(refused(`Bearer ${token}`)).toBe(401);
    await native.start(s, { resume: true });
    expect(refused(`Bearer ${token}`)).toBe(401);
    expect(refused(`Bearer ${opened[1].env!.KERMANYCH_NATIVE_TOKEN}`)).toBe("accepted");
  });
});

describe("send", () => {
  it("pastes into an idle harness and submits it a beat later", async () => {
    vi.useFakeTimers();
    const { native, create, terminal } = make();
    const s = create("claude-code");
    await native.start(s, { resume: false });
    await native.send(s.id, "line1\nline2");
    expect(terminal.write).toHaveBeenCalledWith("t1", "\x1b[200~line1\nline2\x1b[201~");
    expect(terminal.write).not.toHaveBeenCalledWith("t1", "\r");
    vi.advanceTimersByTime(150);
    expect(terminal.write).toHaveBeenLastCalledWith("t1", "\r");
    // Busy until the harness settles again: a second helper is refused.
    expect(native.live(s.id)?.status).toBe("queued");
    await expect(native.send(s.id, "again")).rejects.toMatchObject({ code: "native_busy" });
  });

  it("refuses while the harness works or waits on the operator", async () => {
    const { native, create, terminal } = make();
    const s = create("claude-code");
    await native.start(s, { resume: false });
    for (const hook of ["UserPromptSubmit", "PermissionRequest"]) {
      native.claudeHook(s.id, { hook_event_name: hook });
      const err = await native.send(s.id, "x").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CodedError);
      expect(err).toMatchObject({ code: "native_busy" });
    }
    expect(terminal.write).not.toHaveBeenCalled();
    native.claudeHook(s.id, { hook_event_name: "Stop" });
    await native.send(s.id, "x");
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });

  it("resumes a stopped session with the text as its prompt", async () => {
    const { native, create, opened, row } = make();
    const s = create("claude-code", { ompSessionId: "11111111-2222-3333-4444-555555555555", status: "stopped" });
    await native.send(s.id, "continue please");
    expect(opened[0].args).toEqual(["--resume", "11111111-2222-3333-4444-555555555555", "--settings", expect.any(String), "--", "continue please"]);
    expect(row(s.id).status).toBe("queued");
  });
});

describe("session-file readers", () => {
  it("claude: one response's repeated lines count once; the model is the last one used", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 };
    const text = [
      line({ type: "user", message: { role: "user", content: "hi" } }),
      line({ type: "assistant", message: { id: "m1", model: "claude-a", usage } }),
      line({ type: "assistant", message: { id: "m1", model: "claude-a", usage } }),
      line({ type: "assistant", message: { id: "m2", model: "claude-b", usage: { ...usage, output_tokens: 20 } } }),
      line({ type: "assistant", message: { id: "m3", model: "<synthetic>" } }),
      "{half a line",
    ].join("\n");
    expect(claudeFileUsage(text)).toEqual({
      usage: { input: 20, output: 25, cacheRead: 200, cacheWrite: 14, cost: 0 },
      model: "claude-b",
    });
  });

  it("omp: every assistant message's usage and cost are summed", () => {
    const text = [
      JSON.stringify({ type: "session", id: "x" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", model: "m-1", usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cost: { total: 0.25 } } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", model: "m-2", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } }),
    ].join("\n");
    expect(ompFileUsage(text)).toEqual({ usage: { input: 4, output: 5, cacheRead: 5, cacheWrite: 6, cost: 0.75 }, model: "m-2" });
  });

  it("codex: the last cumulative token count, cached input split out, no cost; the model per turn", () => {
    const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-16T12:00:00.000Z", type, payload });
    const tokens = (input: number, cached: number, output: number) =>
      line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 2, output_tokens: output, total_tokens: input + output } } });
    const text = [
      line("session_meta", { id: "a" }),
      line("turn_context", { model: "gpt-a" }),
      tokens(100, 40, 5),
      line("turn_context", { model: "gpt-b" }),
      tokens(300, 200, 9),
      line("event_msg", { type: "token_count", info: null }),
    ].join("\n");
    expect(codexFileUsage(text)).toEqual({ usage: { input: 100, output: 9, cacheRead: 200, cacheWrite: 2, cost: 0 }, model: "gpt-b" });
    expect(codexFileUsage(line("session_meta", { id: "a" }))).toEqual({ model: undefined });
  });

  it("codex history: 0.163's UserMessage items are prompts too, and a prompt written in both shapes counts once", () => {
    const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-16T12:00:00.000Z", type, payload });
    const item = (text: string) => line("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text, text_elements: [] }] } });
    const text = [
      item("first"),
      line("event_msg", { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "text", text: "not a prompt" }] } }),
      line("event_msg", { type: "user_message", message: "second" }),
      item("second"),
    ].join("\n");
    expect(codexFileMessages(text).map((m) => [m.role, m.content?.[0]?.text])).toEqual([
      ["user", "first"],
      ["user", "second"],
    ]);
  });

  it("codex history: clean prompts, assistant text, tool calls paired with their outputs", () => {
    const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-16T12:00:00.000Z", type, payload });
    const text = [
      line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "system" }] }),
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] }),
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }),
      line("event_msg", { type: "user_message", message: "list files" }),
      line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Listing." }], phase: "commentary" }),
      line("response_item", { type: "custom_tool_call", name: "exec", input: "tools.exec_command({cmd:'ls'})", call_id: "c1" }),
      line("response_item", { type: "reasoning", encrypted_content: "…" }),
      line("response_item", { type: "function_call", name: "wait", arguments: "{\"cell_id\":\"2\"}", call_id: "c2" }),
      line("response_item", { type: "function_call_output", call_id: "c2", output: "waited" }),
      line("response_item", { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "a.txt\n" }, { type: "input_text", text: "b.txt" }] }),
      line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Two files." }], phase: "final_answer" }),
    ].join("\n");
    const messages = codexFileMessages(text);
    expect(messages.filter((m) => m.role === "user").map((m) => m.content?.[0]?.text)).toEqual(["list files"]);
    expect(messages.find((m) => m.role === "assistant" && m.content?.[0]?.type === "toolCall" && m.content[0].name === "wait")?.content?.[0]?.arguments).toEqual({ cell_id: "2" });
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => [m.toolCallId, m.toolName, m.content?.[0]?.text])).toEqual([
      ["c2", "wait", "waited"],
      ["c1", "exec", "a.txt\nb.txt"],
    ]);
    const { entries } = messagesToTranscript(messages);
    expect(entries.map((e) => e.kind).filter((k) => k !== "turn")).toEqual(["user_text", "assistant_text", "tool", "tool", "assistant_text"]);
  });

  it("after an omp turn: absolute usage, model, the armed PR link, and the history", async () => {
    const { native, create, row, events } = make();
    const file = join(dir, "s.jsonl");
    const msg = (m: unknown) => JSON.stringify({ type: "message", message: m });
    const assistant = (text: string, cost: number) =>
      msg({ role: "assistant", model: "m-1", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } });
    writeFileSync(file, [msg({ role: "user", content: [{ type: "text", text: "see https://github.com/o/r/pull/1" }] }), assistant("ok", 0.5)].join("\n"));
    const s = create("omp", { ompSessionFile: file });
    await native.start(s, { resume: true });
    await native.arm(s.id, "pr");
    writeFileSync(file, [msg({ role: "user", content: [{ type: "text", text: "x" }] }), assistant("ok", 0.5), msg({ role: "user", content: [{ type: "text", text: "open a PR" }] }), assistant("Opened https://github.com/o/r/pull/42", 0.25)].join("\n"));
    native.ompEvent(s.id, { event: "working" });
    native.ompEvent(s.id, { event: "idle" });
    await vi.waitFor(() => expect(row(s.id).prOpened).toBe(true));
    expect(row(s.id).usage).toEqual({ input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.75 });
    expect(row(s.id).model).toBe("m-1");
    expect(native.live(s.id)?.status).toBe("in_review");
    const reset = events.find((e) => e.type === "transcript");
    expect(reset?.type === "transcript" && reset.transcript.entries.some((e) => e.kind === "assistant_text" && e.text.includes("pull/42"))).toBe(true);
  });

  it("a PR link already in the conversation before arming does not count", async () => {
    const { native, create, row } = make();
    const file = join(dir, "s.jsonl");
    writeFileSync(file, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "see https://github.com/o/r/pull/1" }] } }));
    const s = create("omp", { ompSessionFile: file });
    await native.start(s, { resume: true });
    await native.arm(s.id, "pr");
    native.ompEvent(s.id, { event: "idle" });
    await native.readTurn(s.id);
    expect(row(s.id).prOpened).toBe(false);
  });

  it("a chat takes its opening message from the history as `task`, once", async () => {
    const { native, create, row } = make();
    const file = join(dir, "s.jsonl");
    const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    writeFileSync(file, [user("  why does drag drop land in the wrong cell?\nsecond line "), user("and the board?")].join("\n"));
    const chat = create("omp", { kind: "chat", task: "", worktreePath: "", ompSessionFile: file });
    await native.readTurn(chat.id);
    expect(row(chat.id).task).toBe("why does drag drop land in the wrong cell?\nsecond line");

    // A stamped task is the thread's name; a later turn does not rename it.
    writeFileSync(file, user("something else"));
    await native.readTurn(chat.id);
    expect(row(chat.id).task).toBe("why does drag drop land in the wrong cell?\nsecond line");

    // An agent's task is its card's text, never the history.
    const agent = create("omp", { task: "", ompSessionFile: file });
    await native.readTurn(agent.id);
    expect(row(agent.id).task).toBe("");
  });
});

describe("api start", () => {
  it("native rows left active become `stopped`; settled and managed rows are untouched", () => {
    const { native, registry, create } = make();
    const thinking = create("omp", { status: "thinking" });
    const waiting = create("claude-code", { status: "waiting_input" });
    const done = create("omp", { status: "done" });
    const managed = registry.createSession({ projectId: "p1", name: "m", task: "t", worktreePath: dir, branch: "m", status: "thinking" });
    native.onModuleInit();
    const status = (id: string) => registry.listSessions().find((s) => s.id === id)?.status;
    expect(status(thinking.id)).toBe("stopped");
    expect(status(waiting.id)).toBe("stopped");
    expect(status(done.id)).toBe("done");
    expect(status(managed.id)).toBe("thinking");
  });
});
