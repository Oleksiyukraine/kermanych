// apps/api/src/git/git-setup.service.ts
// The git half of the project wizard (docs/specs/2026-11-18-first-run-and-project-wizard.md):
// what a folder on this machine already is, which branch a remote's HEAD names, and the clone
// job that fills a new project folder. A clone runs in the background and streams its state as
// the `git_clone` event through SupervisorService.publish, like every other server event; the
// route answers at once with the job, so a slow remote never holds a request open.
//
// Ownership of the disk is strict: a failed or cancelled clone removes only what its job
// created — the target folder if it did not exist, or, if the operator pointed at an empty
// folder, that folder's new contents. Nothing that was there before is ever deleted.
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { GitCloneState, GitInspect } from "@kermanych/core";
import { SupervisorService } from "../supervisor/supervisor.service";
import { WorktreeService } from "../worktree/worktree.service";
import { credentialEnv, scrubToken } from "./git-credentials";
import { runGit } from "./run-git";
import { signalGroup } from "../runtime/process-group";

// The wizard asks for the default branch while the operator fills step 3; a remote that does
// not answer in this long is reported, not waited on.
const REMOTE_HEAD_TIMEOUT_MS = 15_000;

// Between two `git_clone` events of the same stage: git repaints its percentage many times a
// second, the progress bar needs a few.
const PUBLISH_EVERY_MS = 250;

// A finished job stays readable (GET /git/clone/:jobId) this long, for a window that reconnects
// after the final event; then it is forgotten.
const FINAL_JOB_TTL_MS = 10 * 60_000;

// A cancelled git that ignores SIGTERM this long is killed outright.
const KILL_GRACE_MS = 5_000;

// The last lines of git's output kept for a failure message: the `fatal:` line and whatever
// `remote:` said before it, without holding a whole chatty clone in memory.
const KEEP_LINES = 40;

// git's words for "the remote refused these credentials" across https and ssh: `Authentication
// failed`, a 401/403 from the server, an ssh key refusal. GitHub answers a private repository it
// will not show as `Repository not found`, so that counts too.
const AUTH_FAILED = /Authentication failed|could not read (?:Username|Password)|HTTP Basic: Access denied|returned error: 40[13]\b|\bHTTP\/[\d.]+ 40[13]\b|Permission denied \(publickey|Repository not found|Invalid username or (?:password|token)/i;

// One line of `git clone --progress` output as stage + percent: `Receiving objects:  45% (9/20)`,
// `remote: Counting objects: 100% (12/12), done.`, or a stage with a bare count and no
// percentage (`remote: Enumerating objects: 45, done.`). null for everything else.
export function parseCloneProgress(line: string): { stage: string; percent: number | null } | null {
  const m = /^(?:remote:\s*)?([A-Z][a-z]+(?: [a-z]+)*):\s+(?:(\d{1,3})%|\d+\b)/.exec(line.trim());
  if (!m) return null;
  return { stage: m[1]!, percent: m[2] === undefined ? null : Math.min(100, Number(m[2])) };
}

export type CloneRequest = { url: string; parentDir: string; dirName: string; token?: string };

type Job = {
  state: GitCloneState;
  child: ChildProcess | null;
  token: string;
  cancelled: boolean;
  lastPublish: number;
  finished: Promise<void>;
};

@Injectable()
export class GitSetupService implements OnModuleDestroy {
  private readonly log = new Logger(GitSetupService.name);
  private readonly jobs = new Map<string, Job>();

  constructor(
    private supervisor: SupervisorService,
    private worktree: WorktreeService,
  ) {}

  // `isRepo` means the folder is the ROOT of a work tree: bind accepts any folder inside a work
  // tree (WorktreeService.isGitRepo), and the wizard is stricter still, so whatever it offers to
  // bind, bind takes. A subfolder or a bare repository is "not a repo" here.
  async inspect(path: string): Promise<GitInspect> {
    const dir = resolve(path.trim());
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`not a directory: ${dir}`);
    const name = basename(dir);
    const isRepo = (await this.worktree.isGitRepo(dir)) && (await isRepoRoot(dir));
    if (!isRepo) return { path: dir, isRepo, origin: null, branch: null, name };
    const [origin, branch] = await Promise.all([
      runGit(dir, ["remote", "get-url", "origin"]),
      runGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ]);
    return {
      path: dir,
      isRepo,
      origin: (origin.ok && origin.stdout.trim()) || null,
      branch: (branch.ok && branch.stdout.trim()) || null,
      name,
    };
  }

  // The branch `url`'s HEAD points at, read without cloning; null when the remote names none
  // (an empty repository). A refusal carries git's own message, token masked.
  async remoteHead(url: string, token = ""): Promise<string | null> {
    const remote = url.trim();
    if (!remote) throw new Error("remote URL cannot be empty");
    const r = await runGit(homedir(), ["ls-remote", "--symref", "--", remote, "HEAD"], {
      env: credentialEnv(token, remote),
      timeoutMs: REMOTE_HEAD_TIMEOUT_MS,
    });
    if (!r.ok) throw new Error(scrubToken(r.out.trim() || "git ls-remote timed out", token));
    const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout);
    return m ? m[1]! : null;
  }

  // Start `git clone` of `url` into `<parentDir>/<dirName>` and answer the job in `cloning`.
  // Refused before anything touches the disk: an empty URL, a relative parent, a folder name
  // that is not one path segment (`invalid_clone_request`), or a target that exists and is not
  // an empty folder (`target_not_empty`).
  async clone(req: CloneRequest): Promise<GitCloneState> {
    const url = req.url?.trim() ?? "";
    const dirName = req.dirName?.trim() ?? "";
    const parentDir = req.parentDir?.trim() ?? "";
    // The folder name is one path segment: no separator, no NUL, not `.`/`..`.
    const badName = !dirName || dirName === "." || dirName === ".." || /[/\\\0]/.test(dirName);
    if (!url || !isAbsolute(parentDir) || badName) throw new Error("invalid_clone_request");
    const parent = resolve(parentDir);
    const target = join(parent, dirName);
    const existing = await stat(target).catch(() => null);
    if (existing && (!existing.isDirectory() || (await readdir(target)).length > 0)) throw new Error("target_not_empty");
    const preExisted = existing !== null;
    await mkdir(parent, { recursive: true });

    const token = req.token ?? "";
    const state: GitCloneState = {
      jobId: randomUUID(),
      phase: "cloning",
      path: target,
      stage: null,
      percent: null,
      error: null,
      authFailed: false,
    };
    const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
    const job: Job = { state, child: null, token, cancelled: false, lastPublish: 0, finished };
    this.jobs.set(state.jobId, job);

    // Its own process group, so a cancel stops git's ssh and helpers with it: a transport child
    // left running would hold the stderr pipe open and the job would never settle.
    const child = spawn("git", ["clone", "--progress", "--", url, target], {
      cwd: parent,
      env: credentialEnv(token, url),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    job.child = child;
    const tail: string[] = [];
    let partial = "";
    child.stderr!.on("data", (b: Buffer) => {
      const lines = (partial + b.toString("utf8")).split(/[\r\n]/);
      partial = lines.pop() ?? "";
      for (const line of lines) this.onLine(job, line, tail);
    });
    // A git that cannot start reports `error` and may still report `close`: settle once.
    let ended = false;
    const end = (ok: boolean, output: string) => {
      if (ended) return;
      ended = true;
      void this.settle(job, ok, output, preExisted).finally(finish);
    };
    child.on("error", (e) => end(false, String(e)));
    child.on("close", (code) => {
      if (partial) this.onLine(job, partial, tail);
      end(code === 0, tail.join("\n"));
    });
    this.publish(job);
    return { ...state };
  }

  get(jobId: string): GitCloneState | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job.state } : null;
  }

  // Stop a running clone and answer once its folder is cleaned up. A job already final answers
  // its final state unchanged.
  async cancel(jobId: string): Promise<GitCloneState | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.state.phase === "cloning") {
      job.cancelled = true;
      kill(job);
      await job.finished;
    }
    return { ...job.state };
  }

  // The app is quitting: a clone left running would keep writing into a folder nobody will
  // finish; stop each one and let its cleanup run.
  async onModuleDestroy(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.state.phase === "cloning");
    for (const job of running) {
      job.cancelled = true;
      kill(job);
    }
    await Promise.all(running.map((j) => j.finished));
  }

  private onLine(job: Job, line: string, tail: string[]): void {
    const text = scrubToken(line.trimEnd(), job.token);
    if (!text.trim()) return;
    const progress = parseCloneProgress(text);
    if (!progress) {
      tail.push(text);
      if (tail.length > KEEP_LINES) tail.shift();
      return;
    }
    const s = job.state;
    const newStage = progress.stage !== s.stage;
    if (!newStage && progress.percent === s.percent) return;
    s.stage = progress.stage;
    s.percent = progress.percent;
    if (newStage || Date.now() - job.lastPublish >= PUBLISH_EVERY_MS) this.publish(job);
  }

  private async settle(job: Job, ok: boolean, output: string, preExisted: boolean): Promise<void> {
    const s = job.state;
    if (ok && !job.cancelled) {
      s.phase = "done";
    } else {
      // Cleanup before the final event: the window reads "cancelled"/"failed" as "the folder is
      // as it was", so the retry may clone into it straight away.
      await removeCreated(s.path, preExisted).catch((err) =>
        this.log.warn(`clone cleanup of ${s.path} failed: ${(err as Error).message}`),
      );
      if (job.cancelled) {
        s.phase = "cancelled";
      } else {
        s.phase = "failed";
        s.error = scrubToken(output.trim() || "git clone failed", job.token);
        s.authFailed = AUTH_FAILED.test(s.error);
      }
    }
    job.child = null;
    this.publish(job);
    setTimeout(() => this.jobs.delete(s.jobId), FINAL_JOB_TTL_MS).unref();
  }

  private publish(job: Job): void {
    job.lastPublish = Date.now();
    this.supervisor.publish({ type: "git_clone", state: { ...job.state } });
  }
}

// `git rev-parse --show-toplevel` is the work tree's root as a real path; compare it with the
// folder's own, so a symlinked or `/var` → `/private/var` path still matches.
async function isRepoRoot(dir: string): Promise<boolean> {
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return false;
  const [top, self] = await Promise.all([realpath(r.stdout.trim()).catch(() => null), realpath(dir).catch(() => null)]);
  return top !== null && top === self;
}

// SIGTERM lets git remove its half-written folder itself; whatever still runs after the grace
// period — the job has not settled, so something holds its pipe — is killed outright.
function kill(job: Job): void {
  const pid = job.child?.pid;
  if (pid === undefined) return;
  signalGroup(pid, "SIGTERM");
  setTimeout(() => job.state.phase === "cloning" && signalGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
}

// Undo a clone: the folder goes if the job made it; a folder that was there (empty) stays,
// emptied of what git wrote into it.
async function removeCreated(target: string, preExisted: boolean): Promise<void> {
  if (!preExisted) return rm(target, { recursive: true, force: true });
  const names = await readdir(target).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(join(target, n), { recursive: true, force: true })));
}
