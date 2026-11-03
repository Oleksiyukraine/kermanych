// apps/api/src/device/device-proc.ts
// Running the device tools (`xcrun simctl`, `adb`, `emulator`, `sips`) for the drivers: one
// process per call, bounded by a timeout and the caller's AbortSignal, failing with the tool's own
// last words so the preview row can show them.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export type RunOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  // A non-zero exit resolves instead of rejecting (the caller reads `code`).
  allowFail?: boolean;
};

export type RunResult = { code: number | null; stdout: Buffer; stderr: string };

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  if (opts.signal?.aborted) {
    reject(abortError(opts.signal));
    return promise;
  }
  const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => out.push(d));
  child.stderr.on("data", (d: Buffer) => err.push(d));
  child.stdin.on("error", () => {});
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), opts.timeoutMs) : undefined;
  const onAbort = () => child.kill("SIGKILL");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  child.once("error", (e) => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    reject(new ToolError(`${cmd}: ${e.message}`, null, ""));
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    const stdout = Buffer.concat(out);
    const stderr = Buffer.concat(err).toString("utf8");
    if (opts.signal?.aborted) return reject(abortError(opts.signal));
    if (timedOut) return reject(new ToolError(`${commandLine(cmd, args)} did not finish in ${Math.round(opts.timeoutMs! / 1000)} s`, null, stderr));
    if (code !== 0 && !opts.allowFail) {
      const said = lastLines(stderr || stdout.toString("utf8"), 3);
      return reject(new ToolError(`${commandLine(cmd, args)} failed (exit ${code})${said ? `: ${said}` : ""}`, code, stderr));
    }
    resolve({ code, stdout, stderr });
  });
  if (opts.input !== undefined) child.stdin.end(opts.input);
  else child.stdin.end();
  return promise;
}

export async function runText(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return (await run(cmd, args, opts)).stdout.toString("utf8");
}

function commandLine(cmd: string, args: string[]): string {
  const name = cmd.slice(cmd.lastIndexOf("/") + 1);
  return [name, ...args.slice(0, 3)].join(" ");
}

export function lastLines(text: string, n: number): string {
  return text.trim().split(/\r?\n/).slice(-n).join(" · ");
}

export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("the device start was cancelled");
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    throw abortError(signal!);
  }
}

// Line-by-line output of a long-lived child (an emulator, a log stream).
export function onLines(child: ChildProcess, cb: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream?.on("data", (d: Buffer) => {
      const parts = (rest + d.toString("utf8")).split(/\r?\n/);
      rest = parts.pop()!;
      for (const p of parts) if (p.trim()) cb(p);
    });
    stream?.on("end", () => {
      if (rest.trim()) cb(rest);
      rest = "";
    });
  }
}

// `signal` 0 asks whether any member of the group is left.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A detached child (its own process group), stopped as a group: SIGTERM, then SIGKILL after
// `graceMs`. Resolves once the leader has exited.
export async function stopGroup(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    signalGroup(child, "SIGKILL");
    return;
  }
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  signalGroup(child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (signalGroup(child, 0) && Date.now() < deadline) await sleep(50);
  signalGroup(child, "SIGKILL");
  await Promise.race([exited, sleep(2000)]);
}

export function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    srv.close(() => resolve(port));
  });
  return promise;
}

export function portFree(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const srv = createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  return promise;
}
