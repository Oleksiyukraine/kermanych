// apps/api/src/worktree/worktree.service.ts
import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { addedFileDiff, splitDiff, type SplitDiff } from "./split-diff";

export type ChangedFile = { path: string; added: number; removed: number };

// Upper bound on a changed-files listing: the Зміни tab is a summary, and an agent that
// touched thousands of paths must not turn one tab open into an unbounded walk.
const MAX_CHANGED_FILES = 500;

// Head slice git itself inspects when deciding whether a blob is binary.
const BINARY_SNIFF_BYTES = 8000;
const MAX_COUNT_BYTES = 4 * 1024 * 1024;

// Keep git from octal-escaping non-ASCII paths, so a Cyrillic filename reaches the UI
// as itself instead of "\321\204...".
const RAW_PATHS = ["-c", "core.quotePath=false"];

// A pathspec that comes back from the UI is a literal file name: without this git would
// read `*`, `[` or a leading `:` in a name as a glob or as pathspec magic.
const LITERAL_PATHS = ["--literal-pathspecs"];

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

// Like `git`, but stdout only. A diff is content: a stray warning on stderr merged into
// the patch would be parsed as part of the file. stderr is still drained, or a chatty
// command would block on a full pipe.
function gitStdout(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; out: string }>();
  const p = spawn("git", ["-C", cwd, ...args]);
  const chunks: Buffer[] = [];
  p.stdout.on("data", (b: Buffer) => chunks.push(b));
  p.stderr.resume();
  p.on("error", () => resolve({ ok: false, out: "" }));
  p.on("close", (code) => resolve({ ok: code === 0, out: Buffer.concat(chunks).toString("utf8") }));
  return promise;
}

// A never-added file has no blob to diff against, so its added-line count is measured
// here the way numstat would: `\n`-terminated lines, with a final unterminated line
// still counting as one. A NUL byte in the head marks the file binary (0, git's "-");
// unreadable or oversized files also report 0 rather than sinking the whole listing.
async function addedLines(file: string): Promise<number> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size === 0 || st.size > MAX_COUNT_BYTES) return 0;
    const buf = await readFile(file);
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 0;
    let lines = 0;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
    return buf[buf.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return 0;
  }
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

  // Everything the session has produced since it forked off `base`: commits on the
  // branch, staged and unstaged edits, and files never added to the index. An agent
  // is normally mid-flight with nothing committed yet, so diffing `base...HEAD` would
  // report an empty session; the working tree is the right-hand side instead, taken
  // against the merge-base (like `diff()`) so commits that landed on `base` afterwards
  // don't leak in. Untracked paths are collected separately because git omits them
  // from a diff entirely. Any git failure degrades to what was gathered so far.
  async changedFiles(dir: string, base: string): Promise<ChangedFile[]> {
    // On a vanished or unrelated `base` the fork point is unknowable; fall back to HEAD,
    // which still reports the uncommitted half rather than an error string used as a ref.
    const forkPoint = await git(dir, ["merge-base", "HEAD", base || "HEAD"]);
    const mergeBase = (forkPoint.ok && forkPoint.out.trim()) || "HEAD";
    const files: ChangedFile[] = [];

    // `--no-renames` keeps every listed path a real path: a rename is reported as a delete
    // plus an add instead of git's `src/{old => new}.ts` shorthand, which names no file the
    // operator could open.
    const tracked = await git(dir, [...RAW_PATHS, "diff", "--numstat", "--no-renames", mergeBase]);
    if (tracked.ok) {
      for (const line of tracked.out.split("\n")) {
        if (files.length >= MAX_CHANGED_FILES) return files;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const path = parts.slice(2).join("\t");
        if (!path) continue;
        // Binary files report "-" for both counts; anything unparseable counts as 0.
        const added = Number(parts[0]);
        const removed = Number(parts[1]);
        files.push({
          path,
          added: added > 0 ? added : 0,
          removed: removed > 0 ? removed : 0,
        });
      }
    }

    const untracked = await git(dir, [...RAW_PATHS, "ls-files", "--others", "--exclude-standard"]);
    if (untracked.ok) {
      for (const path of untracked.out.split("\n")) {
        if (files.length >= MAX_CHANGED_FILES) return files;
        if (!path) continue;
        files.push({ path, added: await addedLines(join(dir, path)), removed: 0 });
      }
    }
    return files;
  }

  // One changed file as side-by-side rows, for the Зміни tab. Same right-hand side as
  // `changedFiles` — the working tree against the fork point — so the agent's committed and
  // uncommitted edits to that file show up in one view. An untracked file has no blob to
  // diff against and is read from disk instead.
  async fileDiff(dir: string, base: string, path: string): Promise<SplitDiff> {
    // The listed path travelled to the UI and comes back verbatim when the operator opens
    // that file, so it is re-checked here before reaching git or the filesystem:
    // worktree-relative only, no absolute path and no `..` hop out of the session's tree.
    const rel = path.trim();
    if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split(/[\\/]/).includes("..")) {
      throw new Error("invalid path");
    }

    const forkPoint = await git(dir, ["merge-base", "HEAD", base || "HEAD"]);
    const mergeBase = (forkPoint.ok && forkPoint.out.trim()) || "HEAD";
    // `--no-ext-diff` keeps a user's configured difftool out of the pipe.
    const patch = await gitStdout(dir, [
      ...RAW_PATHS,
      ...LITERAL_PATHS,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      mergeBase,
      "--",
      rel,
    ]);
    const diff = patch.ok ? splitDiff(patch.out) : { hunks: [], binary: false, truncated: false };
    if (diff.hunks.length || diff.binary) return diff;

    // git had nothing to say. An untracked file has no blob on either side, so git omits it
    // from a diff entirely and its own content IS the diff; a tracked path that produced no
    // hunks is genuinely unchanged. `ls-files` tells the two apart, and only here — asking
    // it first would miss a file `git rm`/`git mv` took out of the index, which git diffs
    // perfectly well as a deletion.
    const listed = await git(dir, [...RAW_PATHS, ...LITERAL_PATHS, "ls-files", "--", rel]);
    return listed.out.trim() ? diff : this.untrackedDiff(join(dir, rel));
  }

  // Every line of a never-added file is an addition. Binary or oversized content reports a
  // flag rather than a body, the same way the listing counts it as 0 added lines; so does a
  // path that vanished between the listing and the click.
  private async untrackedDiff(file: string): Promise<SplitDiff> {
    try {
      const st = await stat(file);
      if (st.isFile() && st.size > MAX_COUNT_BYTES) {
        return { hunks: [], binary: false, truncated: true };
      }
      if (st.isFile() && st.size > 0) {
        const buf = await readFile(file);
        return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
          ? { hunks: [], binary: true, truncated: false }
          : addedFileDiff(buf.toString("utf8"));
      }
    } catch {
      // unreadable, or gone since the listing — nothing to show
    }
    return { hunks: [], binary: false, truncated: false };
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

  // Sync the project's current branch with its upstream. Both return git's own output so the
  // footer can surface "Already up to date", a diverged-branch refusal, or a missing upstream
  // verbatim. `--ff-only` keeps pull non-destructive: a diverged branch is reported, never
  // silently merged.
  async pull(repoDir: string): Promise<{ ok: boolean; out: string }> {
    return git(repoDir, ["pull", "--ff-only"]);
  }

  async push(repoDir: string): Promise<{ ok: boolean; out: string }> {
    return git(repoDir, ["push"]);
  }
}
