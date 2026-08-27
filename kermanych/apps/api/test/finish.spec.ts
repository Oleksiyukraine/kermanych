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

test("merges the session branch into the project branch, then retires worktree + branch", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "feature.txt"), "hi\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "feature");
  });

  const res = await sup.finishSession(id);

  expect(res).toEqual({ merged: true, into: "dev" });
  expect(existsSync(wtDir)).toBe(false); // worktree retired
  expect(existsSync(join(repo, "feature.txt"))).toBe(true); // work landed on dev
  expect(git(repo, "branch", "--list", "kermanych/s1").trim()).toBe(""); // branch deleted
  expect(git(repo, "log", "--oneline").trim()).toMatch(/merge session: task one/); // no-ff commit
  const s = reg.listSessions().find((x) => x.id === id)!;
  expect(s.status).toBe("merged");
  expect(s.worktreePath).toBe("");
});

test("auto-commits uncommitted worktree work before merging", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "dirty.txt"), "uncommitted\n"); // never committed
  });

  const res = await sup.finishSession(id);

  expect(res.merged).toBe(true);
  expect(existsSync(join(repo, "dirty.txt"))).toBe(true); // auto-commit + merge landed it
  expect(git(repo, "log", "--oneline").trim()).toMatch(/session work: task one/);
});

test("on merge conflict: pulls target into the worktree to resolve, marks session conflict", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "file.txt"), "session\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "session edit");
  });
  // `dev` diverges on the same file → content conflict
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");

  const res = await sup.finishSession(id);

  expect(res).toEqual({ conflict: true, files: ["file.txt"] });
  expect(git(repo, "status", "--porcelain").trim()).toBe(""); // project tree left clean (aborted there)
  expect(git(repo, "branch", "--list", "kermanych/s1").trim()).not.toBe(""); // branch survives
  expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("conflict");
  expect(await wt.unmergedFiles(wtDir)).toContain("file.txt"); // conflict now lives in the worktree
});

test("resolving the worktree conflict then re-finishing merges cleanly", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "file.txt"), "session\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "session edit");
  });
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");

  const first = await sup.finishSession(id);
  expect("conflict" in first).toBe(true);

  // resolve in the worktree (as a user would in their editor) + commit the merge
  writeFileSync(join(wtDir, "file.txt"), "resolved\n");
  git(wtDir, "add", "-A");
  git(wtDir, "commit", "--no-edit");

  const second = await sup.finishSession(id);
  expect(second).toMatchObject({ merged: true, into: "dev" });
  expect(existsSync(wtDir)).toBe(false); // worktree retired
  expect(git(repo, "branch", "--list", "kermanych/s1").trim()).toBe(""); // branch gone
  expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("merged");
  expect(git(repo, "show", "dev:file.txt").trim()).toBe("resolved"); // resolution landed on dev
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

test("in-place: finishSession merges into base, restores base, deletes the branch", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "feature.txt"), "hi\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
  });

  const res = await sup.finishSession(id);

  expect(res).toEqual({ merged: true, into: "dev" });
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev"); // restored to base
  expect(existsSync(join(repo, "feature.txt"))).toBe(true); // work landed on dev
  expect(git(repo, "branch", "--list", "feature/s1").trim()).toBe(""); // branch deleted
  expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("merged");
});

test("in-place: conflict leaves markers on the branch; resolve + re-finish merges", async () => {
  const { id } = await seedInPlace(() => {
    writeFileSync(join(repo, "file.txt"), "session\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "session edit");
  });
  // Diverge base on the same file.
  git(repo, "checkout", "-q", "dev");
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");
  git(repo, "checkout", "-q", "feature/s1"); // in-place sits on the session branch

  const first = await sup.finishSession(id);
  expect("conflict" in first).toBe(true);
  expect(git(repo, "branch", "--show-current").trim()).toBe("feature/s1"); // still on the branch
  expect(await wt.unmergedFiles(repo)).toContain("file.txt");
  expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("conflict");

  // Resolve on the branch + complete the merge (as the agent/user would).
  writeFileSync(join(repo, "file.txt"), "resolved\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--no-edit");

  const second = await sup.finishSession(id);
  expect(second).toMatchObject({ merged: true, into: "dev" });
  expect(git(repo, "show", "dev:file.txt").trim()).toBe("resolved");
  expect(git(repo, "branch", "--list", "feature/s1").trim()).toBe("");
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
