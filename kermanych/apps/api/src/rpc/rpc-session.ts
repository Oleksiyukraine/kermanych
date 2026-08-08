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
  private seq = 0;
  constructor(private opts: { cwd: string; model?: string; ompPath?: string }) {}

  onEvent(cb: (e: RpcEvent) => void) { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null, reason: string) => void) { this.exitCbs.push(cb); }

  private write(o: unknown) { this.proc!.stdin.write(JSON.stringify(o) + "\n"); }

  async start(): Promise<void> {
    const argv = ["omp", "--mode", "rpc", "--cwd", this.opts.cwd];
    if (this.opts.model) argv.push("--model", this.opts.model);
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
    try { frame = JSON.parse(line); } catch { return; }
    let obj: unknown;
    try { obj = this.reassembler.push(frame); } catch { return; }
    if (obj === null) return;
    if (isResponseFrame(obj) && obj.id && this.pending.has(obj.id)) {
      this.pending.get(obj.id)!.resolve(obj); this.pending.delete(obj.id);
    }
    this.eventCbs.forEach((cb) => cb(obj as RpcEvent));
  }

  private command(type: string, extra: Record<string, unknown> = {}): Promise<RpcResponseFrame> {
    const id = `req_${++this.seq}`;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponseFrame>();
    this.pending.set(id, { resolve, reject });
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

  async stop(): Promise<void> {
    try { this.proc?.stdin.end(); } catch {}
    const proc = this.proc;
    if (!proc) return;
    // Child already terminated (crashed, or stop() called twice) → 'close' has fired; don't await it.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    proc.once("close", () => resolve());
    await promise;
  }
}
