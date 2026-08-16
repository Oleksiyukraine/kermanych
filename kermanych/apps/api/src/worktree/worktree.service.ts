// apps/api/src/worktree/worktree.service.ts
import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; out: string }>();
  const p = spawn("git", ["-C", cwd, ...args]);
  const chunks: Buffer[] = [];
  p.stdout.on("data", (b: Buffer) => chunks.push(b));
  p.stderr.on("data", (b: Buffer) => chunks.push(b));
  p.on("error", (e) => resolve({ ok: false, out: String(e) }));
  p.on("close", (code) => resolve({ ok: code === 0, out: Buffer.concat(chunks).toString("utf8") }));
  return promise;
}

@Injectable()
export class WorktreeService {
  async isGitRepo(dir: string): Promise<boolean> {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
  }

  // `base` is the ref the new branch forks from; omit it to fork from the repo's current HEAD.
  async addWorktree(repoDir: string, wtDir: string, branch: string, base?: string): Promise<void> {
    const args = ["worktree", "add", wtDir, "-b", branch];
    if (base) args.push(base);
    const r = await git(repoDir, args);
    if (!r.ok) throw new Error(`git worktree add failed: ${r.out}`);
  }

  // Local branch names (refs/heads), for choosing a worktree's fork base. Empty on a
  // non-repo or error so callers can degrade to "no branches to pick from".
  async listBranches(repoDir: string): Promise<string[]> {
    const r = await git(repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (!r.ok) return [];
    return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  async removeWorktree(repoDir: string, wtDir: string): Promise<void> {
    await git(repoDir, ["worktree", "remove", "--force", wtDir]);
  }

  async removeBranch(repoDir: string, branch: string): Promise<void> {
    await git(repoDir, ["branch", "-D", branch]);
  }

  // Empty string on a detached HEAD (symbolic-ref fails) so callers can treat it as "no branch".
  async currentBranch(repoDir: string): Promise<string> {
    const r = await git(repoDir, ["symbolic-ref", "--short", "HEAD"]);
    return r.ok ? r.out.trim() : "";
  }

  async hasUncommitted(dir: string): Promise<boolean> {
    return (await git(dir, ["status", "--porcelain"])).out.trim().length > 0;
  }

  async commitAll(dir: string, message: string): Promise<void> {
    await git(dir, ["add", "-A"]);
    const r = await git(dir, ["commit", "-m", message]);
    if (!r.ok) throw new Error(`git commit failed: ${r.out}`);
  }

  // How many session commits will land (commits on branch not yet in base).
  async aheadCount(repoDir: string, base: string, branch: string): Promise<number> {
    const n = Number((await git(repoDir, ["rev-list", "--count", `${base}..${branch}`])).out.trim());
    return Number.isFinite(n) ? n : 0;
  }

  // Merge branch into the repo's current HEAD (no-ff). On failure the merge is
  // aborted so the project tree stays clean; the result says whether it was a
  // content conflict (recoverable in the worktree) or a hard error (e.g. dirty tree).
  async mergeBranch(
    repoDir: string,
    branch: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; conflict: boolean; message: string }> {
    const r = await git(repoDir, ["merge", "--no-ff", branch, "-m", message]);
    if (r.ok) return { ok: true };
    const conflict = /CONFLICT|Automatic merge failed/i.test(r.out);
    await git(repoDir, ["merge", "--abort"]);
    return { ok: false, conflict, message: r.out.trim() || "merge failed" };
  }

  // Merge a ref INTO a worktree's branch, leaving conflict markers in place (no abort)
  // so they can be resolved in an editor.
  async mergeInto(dir: string, ref: string): Promise<void> {
    await git(dir, ["merge", ref]);
  }

  // Unified diff of a worktree against where its branch forked from `base`. The
  // merge-base captures the session's committed work, and diffing from there also
  // folds in changes still uncommitted in the tree. Empty string when nothing differs.
  async diff(dir: string, base: string): Promise<string> {
    const ref = base || "HEAD";
    const mergeBase = (await git(dir, ["merge-base", "HEAD", ref])).out.trim() || "HEAD";
    return (await git(dir, ["diff", mergeBase])).out;
  }

  // Create a branch and switch to it in `dir` (in-place mode: no separate worktree).
  async createBranchHere(dir: string, branch: string): Promise<void> {
    const r = await git(dir, ["checkout", "-b", branch]);
    if (!r.ok) throw new Error(`git checkout -b failed: ${r.out}`);
  }

  // Switch `dir` to `ref`. `force` (-f) discards local changes — used when retiring
  // an in-place session, where the working-tree changes belong to that session.
  async checkout(dir: string, ref: string, opts?: { force?: boolean }): Promise<void> {
    const args = opts?.force ? ["checkout", "-f", ref] : ["checkout", ref];
    const r = await git(dir, args);
    if (!r.ok) throw new Error(`git checkout failed: ${r.out}`);
  }

  // Paths with unresolved merge conflicts in a worktree.
  async unmergedFiles(dir: string): Promise<string[]> {
    const out = (await git(dir, ["diff", "--name-only", "--diff-filter=U"])).out.trim();
    return out ? out.split("\n") : [];
  }

  // True when `path` is git-ignored in `dir` (exit 0 from check-ignore). Works
  // on non-existent paths too, so it can validate a file we are about to create.
  async isIgnored(dir: string, path: string): Promise<boolean> {
    return (await git(dir, ["check-ignore", "-q", "--", path])).ok;
  }
}
