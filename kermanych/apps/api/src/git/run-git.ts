// apps/api/src/git/run-git.ts
// One finite git command for the wizard's routes and the .env guard: exit status, stdout, and
// stdout+stderr together for a refusal message. `timeoutMs` kills a remote call that hangs.
import { spawn } from "node:child_process";

export type GitResult = { ok: boolean; stdout: string; out: string };

export function runGit(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<GitResult> {
  const { promise, resolve } = Promise.withResolvers<GitResult>();
  const p = spawn("git", args, { cwd, env: opts.env, timeout: opts.timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const all: Buffer[] = [];
  p.stdout.on("data", (b: Buffer) => (stdout.push(b), all.push(b)));
  p.stderr.on("data", (b: Buffer) => all.push(b));
  p.on("error", (e) => resolve({ ok: false, stdout: "", out: String(e) }));
  p.on("close", (code) =>
    resolve({ ok: code === 0, stdout: Buffer.concat(stdout).toString("utf8"), out: Buffer.concat(all).toString("utf8") }),
  );
  return promise;
}
