// apps/api/test/finish.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
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

// A merge that is EXPECTED to conflict: git exits non-zero and leaves the markers in place,
// which is exactly the mid-merge tree finish must refuse to retire.
const conflictingMerge = (cwd: string, ref: string): void => {
  try {
    git(cwd, "merge", ref);
  } catch {
    /* conflict is the point */
  }
};

const wt = new WorktreeService();
let repo: string;
let reg: RegistryService;
let sup: SupervisorService;
let trash: string[];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-finish-"));
  trash = [repo];
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt, offlineAuth(), stubSkills());
});
afterEach(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

// Seed a project + session with a real worktree branched off `dev`; `mutate` runs work
// inside the worktree before the session row is created.
async function seed(mutate: (wtDir: string) => void): Promise<{ id: string; wtDir: string }> {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  const parent = mkdtempSync(join(tmpdir(), "kmq-finish-wt-"));
  trash.push(parent);
  const wtDir = join(parent, "wt"); // non-existing path — `git worktree add` creates it
  await wt.addWorktree(repo, wtDir, "kermanych/s1");
  mutate(wtDir);
  const s = reg.createSession({ projectId: g.id, name: "task one", task: "t", worktreePath: wtDir, branch: "kermanych/s1" });
  return { id: s.id, wtDir };
}

// Finish retires the session; it never merges. Code reaches the base branch through a pull
// request, so the branch must survive the worktree it was worked in.
test("retires the worktree, keeps the branch, and leaves the base untouched", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "hi\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "feature");
  });

  const res = await sup.finishSession(id);

  expect(res).toEqual({ finished: true, branch: "kermanych/s1" });
  expect(existsSync(wtDir)).toBe(false); // worktree retired
  expect(existsSync(join(repo, "feature.txt"))).toBe(false); // nothing landed on dev
  expect(git(repo, "log", "--oneline", "dev").trim()).not.toMatch(/feature/); // no merge commit either
  expect(git(repo, "branch", "--list", "kermanych/s1").trim()).not.toBe(""); // branch kept for its PR
  expect(git(repo, "show", "kermanych/s1:feature.txt").trim()).toBe("hi"); // with the work on it
  const s = reg.listSessions().find((x) => x.id === id)!;
  expect(s.status).toBe("merged");
  expect(s.worktreePath).toBe("");
});

test("auto-commits uncommitted worktree work onto the branch before retiring it", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "dirty.txt"), "uncommitted\n"); // never committed
  });

  expect(await sup.finishSession(id)).toEqual({ finished: true, branch: "kermanych/s1" });

  expect(git(repo, "show", "kermanych/s1:dirty.txt").trim()).toBe("uncommitted");
  expect(git(repo, "log", "--oneline", "kermanych/s1").trim()).toMatch(/session work: task one/);
  expect(existsSync(join(repo, "dirty.txt"))).toBe(false); // dev never saw it
});

test("refuses a worktree left mid-merge: retiring it would strand the resolution", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "file.txt"), "session\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "session edit");
  });
  // `dev` diverges on the same file and the agent folds it in → markers in the worktree.
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");
  conflictingMerge(wtDir, "dev");

  await expect(sup.finishSession(id)).rejects.toThrow(/unresolved merge conflicts/i);

  expect(existsSync(wtDir)).toBe(true); // worktree left alone
  expect(reg.listSessions().find((x) => x.id === id)!.worktreePath).toBe(wtDir);
  expect((await sup.finishInfo(id)).conflicts).toEqual(["file.txt"]); // the modal lists them
});

test("once the conflict is resolved, finish retires the worktree", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "file.txt"), "session\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "session edit");
  });
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");
  conflictingMerge(wtDir, "dev");

  // Resolve in the worktree (as the agent or the operator would) and complete the merge.
  writeFileSync(join(wtDir, "file.txt"), "resolved\n");
  git(wtDir, "add", "-A");
  git(wtDir, "commit", "--no-edit");

  expect(await sup.finishSession(id)).toEqual({ finished: true, branch: "kermanych/s1" });
  expect(existsSync(wtDir)).toBe(false);
  expect(git(repo, "show", "kermanych/s1:file.txt").trim()).toBe("resolved"); // resolution kept on the branch
  expect(git(repo, "show", "dev:file.txt").trim()).toBe("main"); // dev untouched
});

test("finishInfo reports target branch, ahead count, and dirty flag", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "a.txt"), "1\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "c1");
    writeFileSync(join(d, "b.txt"), "2\n"); // uncommitted
  });

  expect(await sup.finishInfo(id)).toMatchObject({
    branch: "kermanych/s1",
    target: "dev",
    ahead: 1,
    dirty: true,
  });
});

// The modal names the base the PR will target, which is the branch the session forked from —
// not whatever the developer's own checkout happens to sit on while the agent works.
test("finishInfo targets the session's base branch, not the project repo's current branch", async () => {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  const parent = mkdtempSync(join(tmpdir(), "kmq-finish-base-"));
  trash.push(parent);
  const wtDir = join(parent, "wt");
  await wt.addWorktree(repo, wtDir, "kermanych/s2", "dev");
  writeFileSync(join(wtDir, "a.txt"), "1\n");
  git(wtDir, "add", "-A");
  git(wtDir, "commit", "-q", "-m", "c1");
  const s = reg.createSession({
    projectId: g.id, name: "task two", task: "t", worktreePath: wtDir, branch: "kermanych/s2", baseBranch: "dev",
  });
  git(repo, "checkout", "-q", "-b", "somewhere-else"); // the operator wandered off

  expect(await sup.finishInfo(s.id)).toMatchObject({ target: "dev", ahead: 1 });
});

// The Зміни tab renders `files`, and an agent is normally mid-flight: it has committed
// nothing yet, or only part of its work. All three shapes of work must be listed.
test("finishInfo lists committed, uncommitted and untracked work as changed files", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "a.txt"), "1\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "c1"); // committed
    writeFileSync(join(d, "file.txt"), "base\nextra\n"); // tracked, edited, not committed
    writeFileSync(join(d, "b.txt"), "2\n3\n"); // brand new, never added
  });

  const { files } = await sup.finishInfo(id);

  expect([...files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
    { path: "a.txt", added: 1, removed: 0 },
    { path: "b.txt", added: 2, removed: 0 },
    { path: "file.txt", added: 1, removed: 0 },
  ]);
});

// In-place: the session branch lives in the project repo itself (no worktree).
async function seedInPlace(mutate: () => void): Promise<{ id: string }> {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  await wt.createBranchHere(repo, "feature/s1"); // repo now checked out on the session branch
  mutate();
  const s = reg.createSession({
    projectId: g.id, name: "task one", task: "t",
    worktreePath: "", branch: "feature/s1", worktree: false, baseBranch: "dev",
  });
  return { id: s.id };
}

test("in-place: finishSession restores the base branch and keeps the session branch", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "feature.txt"), "hi\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
  });

  const res = await sup.finishSession(id);

  expect(res).toEqual({ finished: true, branch: "feature/s1" });
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev"); // repo handed back
  expect(existsSync(join(repo, "feature.txt"))).toBe(false); // nothing merged into dev
  expect(git(repo, "branch", "--list", "feature/s1").trim()).not.toBe(""); // branch kept for its PR
  expect(git(repo, "show", "feature/s1:feature.txt").trim()).toBe("hi");
  expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("merged");
});

test("in-place: refuses while the branch is mid-merge with conflicts", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "file.txt"), "session\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "session edit");
  });
  // Diverge base on the same file, then fold it into the session branch.
  git(repo, "checkout", "-q", "dev");
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");
  git(repo, "checkout", "-q", "feature/s1");
  conflictingMerge(repo, "dev");

  await expect(sup.finishSession(id)).rejects.toThrow(/unresolved merge conflicts/i);
  expect(git(repo, "branch", "--show-current").trim()).toBe("feature/s1"); // still on the branch

  // Resolve on the branch + complete the merge, then finish goes through.
  writeFileSync(join(repo, "file.txt"), "resolved\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--no-edit");

  expect(await sup.finishSession(id)).toEqual({ finished: true, branch: "feature/s1" });
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev");
  expect(git(repo, "show", "feature/s1:file.txt").trim()).toBe("resolved");
  expect(git(repo, "show", "dev:file.txt").trim()).toBe("main");
});

test("in-place: finishInfo reports base as target, ahead, dirty", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "a.txt"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "c1");
    writeFileSync(join(repo, "b.txt"), "2\n"); // uncommitted
  });

  expect(await sup.finishInfo(id)).toMatchObject({
    branch: "feature/s1", target: "dev", ahead: 1, dirty: true,
  });
});

test("in-place: deleteSession restores base and removes the branch", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "x.txt"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "x");
  });

  await sup.deleteSession(id);

  expect(git(repo, "branch", "--show-current").trim()).toBe("dev");
  expect(git(repo, "branch", "--list", "feature/s1").trim()).toBe("");
  expect(reg.listSessions().find((x) => x.id === id)).toBeUndefined();
});
