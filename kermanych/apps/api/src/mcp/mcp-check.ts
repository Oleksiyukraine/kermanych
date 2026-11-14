// apps/api/src/mcp/mcp-check.ts
// «Перевірити» (docs/specs/2026-11-14-project-mcp-servers.md, decision 7): start one server the
// way a session would, ask it `initialize` and `tools/list`, and stop it. A minimal JSON-RPC
// client, the size of omp-mcp-bridge.ts's, so the api carries no MCP SDK.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { McpCheckResult, McpServerDef } from "@kermanych/core";
import { signalGroup } from "../runtime/process-group";

// `npx -y` downloads the package on first use, which can take most of a minute.
export const MCP_CHECK_TIMEOUT_MS = 60_000;
const STDERR_LINES = 20;
const PROTOCOL_VERSION = "2025-06-18";

type Tool = { name: string; description: string };
type RpcReply = { id?: unknown; result?: unknown; error?: { message?: string } };

function toolsOf(result: unknown): Tool[] {
  const tools = result && typeof result === "object" && "tools" in result && Array.isArray(result.tools) ? (result.tools as unknown[]) : [];
  return tools.flatMap((t) =>
    t && typeof t === "object" && "name" in t && typeof t.name === "string"
      ? [{ name: t.name, description: "description" in t && typeof t.description === "string" ? t.description : "" }]
      : [],
  );
}

const INITIALIZE = { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "kermanych-check", version: "1" } };

/** `def` with its variables already expanded; `env` is the full environment of the server. */
export async function checkMcpServer(def: McpServerDef, cwd: string, env: Record<string, string>, timeoutMs = MCP_CHECK_TIMEOUT_MS): Promise<McpCheckResult> {
  const started = Date.now();
  try {
    const tools = def.kind === "stdio" ? await checkStdio(def, cwd, env, timeoutMs) : await checkHttp(def, timeoutMs);
    return { ok: true, tools, ms: Date.now() - started };
  } catch (err) {
    const e = err as CheckError;
    return { ok: false, error: e.message, ...(e.auth ? { auth: true as const } : {}), stderr: e.stderr ?? [], ms: Date.now() - started };
  }
}

class CheckError extends Error {
  constructor(message: string, readonly stderr?: string[], readonly auth?: boolean) {
    super(message);
  }
}

function checkStdio(def: Extract<McpServerDef, { kind: "stdio" }>, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<Tool[]> {
  const { promise, resolve, reject } = Promise.withResolvers<Tool[]>();
  // Its own group, so stopping it also stops what `npx` started under it.
  const proc = spawn(def.command, def.args, { cwd, env: { ...env, ...def.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const out = new StringDecoder("utf8");
  const errDec = new StringDecoder("utf8");
  let buf = "";
  let stderr = "";
  const pending = new Map<number, (r: RpcReply) => void>();
  let seq = 0;
  let done = false;
  const tail = () => stderr.split("\n").filter((l) => l.trim()).slice(-STDERR_LINES);
  const finish = (fn: () => void) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (proc.pid !== undefined) signalGroup(proc.pid, "SIGKILL");
    fn();
  };
  const timer = setTimeout(() => finish(() => reject(new CheckError(`no answer in ${Math.round(timeoutMs / 1000)} s`, tail()))), timeoutMs);
  const send = (method: string, params: unknown) => {
    const id = ++seq;
    const { promise: reply, resolve: settle } = Promise.withResolvers<RpcReply>();
    pending.set(id, settle);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return reply;
  };
  proc.stdin.on("error", () => {});
  proc.stderr.on("data", (b: Buffer) => (stderr = (stderr + errDec.write(b)).slice(-16_384)));
  proc.stdout.on("data", (b: Buffer) => {
    buf += out.write(b);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: RpcReply;
      try {
        msg = JSON.parse(line) as RpcReply;
      } catch {
        continue; // a server logging to stdout; the protocol lines still come through
      }
      if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
    }
  });
  proc.on("error", (err) => finish(() => reject(new CheckError(err.message, tail()))));
  proc.on("exit", (code, signal) => finish(() => reject(new CheckError(`the server exited (${signal ?? `code ${code}`}) before answering`, tail()))));

  void (async () => {
    const init = await send("initialize", INITIALIZE);
    if (init.error) throw new CheckError(init.error.message ?? "initialize failed", tail());
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await send("tools/list", {});
    if (list.error) throw new CheckError(list.error.message ?? "tools/list failed", tail());
    return toolsOf(list.result);
  })().then(
    (tools) => finish(() => resolve(tools)),
    (err: Error) => finish(() => reject(err)),
  );
  return promise;
}

// A Streamable HTTP answer is JSON, or an SSE stream whose `data:` lines carry the JSON-RPC reply.
async function rpcReply(res: Response): Promise<RpcReply> {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text) as RpcReply;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const msg = JSON.parse(line.slice(5).trim()) as RpcReply;
    if (msg.id !== undefined) return msg;
  }
  throw new Error("the server sent no reply in its event stream");
}

async function checkHttp(def: Extract<McpServerDef, { kind: "http" }>, timeoutMs: number): Promise<Tool[]> {
  if (def.sse) throw new CheckError("«Перевірити» works with Streamable HTTP servers; this one uses the older SSE transport");
  const signal = AbortSignal.timeout(timeoutMs);
  let session: string | null = null;
  let seq = 0;
  const post = async (body: Record<string, unknown>): Promise<Response> => {
    const res = await fetch(def.url, {
      method: "POST",
      headers: {
        ...def.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal,
    });
    if (res.status === 401 || res.status === 403) throw new CheckError(`HTTP ${res.status}`, [], true);
    if (!res.ok && res.status !== 202) throw new CheckError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  };
  const call = async (method: string, params: unknown) => {
    const reply = await rpcReply(await post({ id: ++seq, method, params }));
    if (reply.error) throw new CheckError(reply.error.message ?? `${method} failed`);
    return reply.result;
  };
  try {
    const init = await post({ id: ++seq, method: "initialize", params: INITIALIZE });
    session = init.headers.get("mcp-session-id");
    const reply = await rpcReply(init);
    if (reply.error) throw new CheckError(reply.error.message ?? "initialize failed");
    await post({ method: "notifications/initialized" });
    return toolsOf(await call("tools/list", {}));
  } catch (err) {
    if (err instanceof CheckError) throw err;
    throw new CheckError(signal.aborted ? `no answer in ${Math.round(timeoutMs / 1000)} s` : (err as Error).message);
  }
}
