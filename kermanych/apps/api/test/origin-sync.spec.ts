// apps/api/test/origin-sync.spec.ts
// Origin is the team's source of truth: a finished session is pushed back so local <base>
// and origin/<base> never drift apart, and a teammate's commit that landed on origin while
// the session ran is folded in FIRST — in the worktree, where a conflict is resolved in the
// agent's own context — so `dev` never receives a conflicted merge. All origin ops are
// best-effort: with no remote (offline / local-only project) finish still merges locally.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let origin: string;
let repo: string;
let reg: RegistryService;
let sup: SupervisorService;
let trash: string[];

beforeEach(() => {
  trash = [];
  origin = mkdtempSync(join(tmpdir(), "kmq-origin-"));
  trash.push(origin);
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q", "--bare"], { cwd: origin });
  repo = mkdtempSync(join(tmpdir(), "kmq-osync-"));
  trash.push(repo);
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "dev");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt, offlineAuth(), stubSkills());
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

// A teammate on another machine moves origin/dev: clone the bare, commit, push.
function teammatePush(mutate: (clone: string) => void): void {
  const clone = mkdtempSync(join(tmpdir(), "kmq-mate-"));
  trash.push(clone);
  execFileSync("git", ["clone", "-q", origin, clone], { cwd: tmpdir() });
  git(clone, "config", "user.email", "m@m");
  git(clone, "config", "user.name", "m");
  mutate(clone);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "teammate");
  git(clone, "push", "-q", "origin", "dev");
}

// A project + worktree session branched off `dev`, with `baseBranch` recorded (the real
// launch path sets it; the older finish.spec seed did not, which is why this file sets it).
async function seed(mutate: (wtDir: string) => void): Promise<{ id: string; wtDir: string }> {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  const parent = mkdtempSync(join(tmpdir(), "kmq-osync-wt-"));
  trash.push(parent);
  const wtDir = join(parent, "wt");
  await wt.addWorktree(repo, wtDir, "kermanych/s1", "dev");
  mutate(wtDir);
  const s = reg.createSession({
    projectId: g.id, name: "task one", task: "t",
    worktreePath: wtDir, branch: "kermanych/s1", baseBranch: "dev",
  });
  return { id: s.id, wtDir };
}

test("pushes the merged base to origin after a clean finish", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "hi\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "feature");
  });

  const res = await sup.finishSession(id);

  expect(res).toMatchObject({ merged: true, into: "dev", pushed: true });
  expect(git(repo, "show", "origin/dev:feature.txt").trim()).toBe("hi"); // work reached origin
  expect(git(repo, "rev-parse", "dev").trim()).toBe(git(repo, "rev-parse", "origin/dev").trim()); // lockstep
});

test("folds in a teammate's origin commit, then pushes, losing neither side", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "mine\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "mine");
  });
  teammatePush((c) => writeFileSync(join(c, "other.txt"), "theirs\n"));

  const res = await sup.finishSession(id);

  expect(res).toMatchObject({ merged: true, pushed: true });
  expect(git(repo, "show", "origin/dev:feature.txt").trim()).toBe("mine"); // my work
  expect(git(repo, "show", "origin/dev:other.txt").trim()).toBe("theirs"); // teammate's work
});

test("a teammate's conflicting origin commit surfaces in the worktree, not on dev", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "file.txt"), "mine\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "mine");
  });
  teammatePush((c) => writeFileSync(join(c, "file.txt"), "theirs\n")); // same file → conflict

  const first = await sup.finishSession(id);

  expect("conflict" in first).toBe(true);
  expect(await wt.unmergedFiles(wtDir)).toContain("file.txt"); // conflict lives in the worktree
  expect(git(repo, "status", "--porcelain").trim()).toBe(""); // dev tree clean
  expect(git(repo, "show", "origin/dev:file.txt").trim()).toBe("theirs"); // origin untouched by us

  // resolve in the worktree (as the operator/agent would), then re-finish
  writeFileSync(join(wtDir, "file.txt"), "resolved\n");
  git(wtDir, "add", "-A");
  git(wtDir, "commit", "--no-edit");

  const second = await sup.finishSession(id);
  expect(second).toMatchObject({ merged: true, pushed: true });
  expect(git(repo, "show", "origin/dev:file.txt").trim()).toBe("resolved");
});

test("with no origin remote, finish still merges locally and attempts no push", async () => {
  git(repo, "remote", "remove", "origin");
  const { id } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "hi\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "feature");
  });

  const res = await sup.finishSession(id);

  expect(res).toMatchObject({ merged: true, into: "dev" });
  expect("pushed" in res).toBe(false); // no remote → no push attempted
  expect(existsSync(join(repo, "feature.txt"))).toBe(true);
});

test("finish targets the session's recorded base, not the repo's current checkout", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "hi\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "feature");
  });
  git(repo, "checkout", "-q", "-b", "other"); // main repo moved off the session's base (dev)

  await expect(sup.finishSession(id)).rejects.toThrow(/dev/); // refuses: not on the base
});

// A push rejected by a race (origin moved after our fetch) is simulated with a one-shot
// rejection; everything else is real git, so the retry's fetch-merge-push runs for real.
test("a push rejected by a race is folded in and retried once, succeeding", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "hi\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "feature");
  });
  vi.spyOn(wt, "push").mockImplementationOnce(async () => ({
    ok: false,
    rejected: true,
    message: "! [rejected] non-fast-forward",
  }));

  const res = await sup.finishSession(id);

  expect(res).toMatchObject({ merged: true, pushed: true });
  expect(git(repo, "show", "origin/dev:feature.txt").trim()).toBe("hi");
});

test("a push that stays rejected leaves the merge local and reports the block", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "hi\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "feature");
  });
  vi.spyOn(wt, "push").mockImplementation(async () => ({
    ok: false,
    rejected: true,
    message: "! [rejected] non-fast-forward",
  }));

  const res = await sup.finishSession(id);

  expect(res).toMatchObject({ merged: true, pushed: false });
  if ("merged" in res) expect(res.reason).toBeTruthy();
  expect(git(repo, "show", "dev:feature.txt").trim()).toBe("hi"); // merged locally regardless
});
