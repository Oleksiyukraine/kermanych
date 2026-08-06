// src/server/rpc-session.ts
import { LineSplitter, ChunkReassembler } from "./rpc-frames";
import type { RpcEvent, RpcExtensionUIResponse, TodoPhase } from "./types";

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

export class RpcSession {
  private proc?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private enc = new TextEncoder();
  private splitter = new LineSplitter();
  private reassembler = new ChunkReassembler();
  private eventCbs: ((e: RpcEvent) => void)[] = [];
  private exitCbs: ((code: number | null) => void)[] = [];
  private pending = new Map<string, { resolve: (r: RpcResponseFrame) => void; reject: (e: Error) => void }>();
  private stderr = "";
  private seq = 0;
  constructor(private opts: { cwd: string; model?: string; ompPath?: string }) {}

  onEvent(cb: (e: RpcEvent) => void) { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null) => void) { this.exitCbs.push(cb); }

  private write(o: unknown) { this.proc!.stdin.write(this.enc.encode(JSON.stringify(o) + "\n")); }

  async start(): Promise<void> {
    const argv = ["omp", "--mode", "rpc", "--cwd", this.opts.cwd];
    if (this.opts.model) argv.push("--model", this.opts.model);
    if (this.opts.ompPath) argv[0] = this.opts.ompPath;
    this.proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.drainStderr();
    let ready_ = false;
    this.proc.exited.then((code) => {
      const e = new Error(this.exitMessage(code));
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      this.exitCbs.forEach((cb) => cb(code));
    });
    const { promise: ready, resolve } = Promise.withResolvers<void>();
    const onReady = (e: RpcEvent) => {
      if (e.type === "ready") { this.write({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 }); resolve(); }
    };
    this.eventCbs.push(onReady);
    this.readLoop();
    const exitedBeforeReady = this.proc.exited.then((code) => { if (!ready_) throw new Error(this.exitMessage(code)); });
    await Promise.race([ready.then(() => { ready_ = true; }), exitedBeforeReady]);
  }

  private exitMessage(code: number | null): string {
    const tail = this.stderr.trim();
    return `omp child exited (code ${code}) before completing request${tail ? `: ${tail}` : ""}`;
  }

  private async drainStderr() {
    const stream = this.proc?.stderr;
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.stderr = (this.stderr + dec.decode(value, { stream: true })).slice(-8192);
      }
    } catch {}
  }

  private async readLoop() {
    const reader = this.proc!.stdout.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of this.splitter.push(dec.decode(value, { stream: true }))) {
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { continue; }
        let obj: unknown;
        try { obj = this.reassembler.push(frame); } catch { continue; }
        if (obj === null) continue;
        if (isResponseFrame(obj) && obj.id && this.pending.has(obj.id)) {
          this.pending.get(obj.id)!.resolve(obj); this.pending.delete(obj.id);
        }
        this.eventCbs.forEach((cb) => cb(obj as RpcEvent));
      }
    }
  }

  private command(type: string, extra: Record<string, unknown> = {}): Promise<RpcResponseFrame> {
    const id = `req_${++this.seq}`;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponseFrame>();
    this.pending.set(id, { resolve, reject });
    this.write({ id, type, ...extra });
    return promise;
  }

  prompt(message: string) { this.write({ id: `req_${++this.seq}`, type: "prompt", message }); }
  followUp(message: string) { this.write({ id: `req_${++this.seq}`, type: "follow_up", message }); }
  steer(message: string) { this.write({ id: `req_${++this.seq}`, type: "steer", message }); }
  answerUi(res: RpcExtensionUIResponse) { this.write(res); }

  async getState(): Promise<RpcStateData> {
    const r = await this.command("get_state");
    // RPC boundary: get_state data shape is the documented payload; no schema lib in project (YAGNI).
    return (r.data ?? {}) as RpcStateData;
  }

  async stop(): Promise<void> { try { this.proc?.stdin.end(); } catch {} await this.proc?.exited; }
}
