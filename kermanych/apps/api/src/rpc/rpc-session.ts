// apps/api/src/rpc/rpc-session.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { LineSplitter, ChunkReassembler } from "@kermanych/core";
import type { RpcEvent, RpcExtensionUIResponse, TodoPhase, ImageInput } from "@kermanych/core";

export interface RpcStateData {
  isStreaming: boolean; contextUsage?: { percent: number };
  model?: { provider: string; id: string }; sessionId?: string; sessionFile?: string; todoPhases?: TodoPhase[];
}

interface RpcResponseFrame {
  type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string;
}

function isResponseFrame(o: unknown): o is RpcResponseFrame {
  return typeof o === "object" && o !== null && "type" in o && o.type === "response";
}

// omp RPC ImageContent: { type:"image", data:<base64>, mimeType }. Spread only when present.
function imagesFrame(images?: ImageInput[]): { images?: { type: "image"; data: string; mimeType: string }[] } {
  return images?.length
    ? { images: images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })) }
    : {};
}

export class RpcSession {
  private proc?: ChildProcessWithoutNullStreams;
  private splitter = new LineSplitter();
  private reassembler = new ChunkReassembler();
  private eventCbs: ((e: RpcEvent) => void)[] = [];
  private exitCbs: ((code: number | null, reason: string) => void)[] = [];
  private pending = new Map<string, { resolve: (r: RpcResponseFrame) => void; reject: (e: Error) => void }>();
  private stderr = "";
  // Frames omp sent that we could not decode. Silent loss is the exact failure class the
  // transcript work exists to remove, so the count is kept and each loss is announced.
  droppedFrames = 0;
  private seq = 0;
  constructor(private opts: { cwd: string; model?: string; ompPath?: string; fork?: string; noTools?: boolean; tools?: string[]; commandTimeoutMs?: number }) {}

  onEvent(cb: (e: RpcEvent) => void) { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null, reason: string) => void) { this.exitCbs.push(cb); }

  private write(o: unknown) { this.proc!.stdin.write(JSON.stringify(o) + "\n"); }

  async start(): Promise<void> {
    const argv = ["omp", "--mode", "rpc", "--cwd", this.opts.cwd];
    if (this.opts.model) argv.push("--model", this.opts.model);
    if (this.opts.fork) argv.push("--fork", this.opts.fork);
    if (this.opts.noTools) argv.push("--no-tools");
    if (this.opts.tools?.length) argv.push("--tools", this.opts.tools.join(","));
    if (this.opts.ompPath) argv[0] = this.opts.ompPath;
    this.proc = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    // Persistent decoders buffer partial multibyte (UTF-8) sequences split across chunk boundaries.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    this.proc.stderr.on("data", (b: Buffer) => { this.stderr = (this.stderr + errDec.write(b)).slice(-8192); });
    // Swallow post-exit stdin writes (EPIPE / write-after-end) so they never crash the process.
    this.proc.stdin.on("error", () => {});
    let ready_ = false;
    const { promise: ready, resolve } = Promise.withResolvers<void>();
    const { promise: settleBeforeReady, reject: rejectBeforeReady } = Promise.withResolvers<never>();
    // exit: normal child termination. error: spawn failure (async, no 'exit' follows) or stream error.
    this.proc.on("exit", (code) => this.failAll(new Error(this.exitMessage(code)), code, ready_, rejectBeforeReady));
    this.proc.on("error", (err) => this.failAll(err, null, ready_, rejectBeforeReady));
    const onReady = (e: RpcEvent) => {
      if (e.type === "ready") { this.write({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 }); resolve(); }
    };
    this.eventCbs.push(onReady);
    this.proc.stdout.on("data", (b: Buffer) => {
      for (const line of this.splitter.push(outDec.write(b))) this.handleLine(line);
    });
    await Promise.race([ready.then(() => { ready_ = true; }), settleBeforeReady]);
  }

  // Shared failure path for both 'exit' and 'error': reject start() if not yet ready, reject+clear all
  // outstanding command promises, then notify exit callbacks. Callers pass the live `ready_` at fire time;
  // rejectBeforeReady is a no-op once start() has already settled, so a post-ready failure only fans out.
  private failAll(e: Error, code: number | null, ready_: boolean, rejectBeforeReady: (e: Error) => void) {
    if (!ready_) rejectBeforeReady(e);
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.exitCbs.forEach((cb) => cb(code, e.message));
  }

  private exitMessage(code: number | null): string {
    const tail = this.stderr.trim();
    return `omp child exited (code ${code}) before completing request${tail ? `: ${tail}` : ""}`;
  }

  private handleLine(line: string) {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { return this.dropFrame(); }
    let obj: unknown;
    try { obj = this.reassembler.push(frame); } catch { return this.dropFrame(); }
    if (obj === null) return;
    if (isResponseFrame(obj) && obj.id && this.pending.has(obj.id)) {
      this.pending.get(obj.id)!.resolve(obj); this.pending.delete(obj.id);
    }
    this.eventCbs.forEach((cb) => cb(obj as RpcEvent));
  }

  // Shaped like an omp notice so the transcript reducer turns it into a visible row
  // rather than the turn simply missing output.
  private dropFrame() {
    this.droppedFrames++;
    this.eventCbs.forEach((cb) => cb({ type: "notice", message: "втрачено кадр від omp" }));
  }

  private command(type: string, extra: Record<string, unknown> = {}): Promise<RpcResponseFrame> {
    const id = `req_${++this.seq}`;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponseFrame>();
    // A wedged omp child (e.g. a provider request that hung with no internal timeout) would
    // otherwise leave this pending forever, hanging every caller (the refreshState poll,
    // resume rehydrate). Reject after a bound so callers fail fast and can recover.
    const ms = this.opts.commandTimeoutMs ?? 20000;
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) reject(new Error(`omp did not respond to "${type}" within ${ms}ms`));
    }, ms);
    this.pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    this.write({ id, type, ...extra });
    return promise;
  }

  prompt(message: string, images?: ImageInput[]) { this.write({ id: `req_${++this.seq}`, type: "prompt", message, ...imagesFrame(images) }); }
  followUp(message: string, images?: ImageInput[]) { this.write({ id: `req_${++this.seq}`, type: "follow_up", message, ...imagesFrame(images) }); }
  steer(message: string, images?: ImageInput[]) { this.write({ id: `req_${++this.seq}`, type: "steer", message, ...imagesFrame(images) }); }
  answerUi(res: RpcExtensionUIResponse) { this.write(res); }

  async getState(): Promise<RpcStateData> {
    const r = await this.command("get_state");
    // RPC boundary: get_state data shape is the documented payload; no schema lib in project (YAGNI).
    return (r.data ?? {}) as RpcStateData;
  }

  async switchSession(sessionPath: string): Promise<void> {
    const r = await this.command("switch_session", { sessionPath });
    if (!r.success) throw new Error(r.error ?? "switch_session failed");
  }

  // Drain the paged message history (used to rehydrate a resumed session's transcript).
  async getAllMessages(): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.command("get_messages_page", cursor ? { cursor } : {});
      if (!r.success) break;
      const d = (r.data ?? {}) as { messages?: unknown[]; nextCursor?: string };
      if (d.messages) out.push(...d.messages);
      cursor = d.nextCursor;
    } while (cursor);
    return out;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    try { proc.stdin.end(); } catch {}
    // Child already terminated (crashed, or stop() called twice) → 'close' has fired; don't await it.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    proc.once("close", () => resolve());
    // A wedged child may ignore stdin EOF — escalate to signals so stop()/restart never hangs.
    const term = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 1000);
    const kill = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 4000);
    await promise;
    clearTimeout(term);
    clearTimeout(kill);
  }

  // Whether the omp child is still running. A dead child must be resumed (respawned),
  // never written to: writes to its closed stdin raise EPIPE, which start() swallows,
  // so the message would vanish silently and the agent would appear "hung".
  isAlive(): boolean {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }
}
