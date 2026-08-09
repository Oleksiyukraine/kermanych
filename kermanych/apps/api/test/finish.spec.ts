// apps/api/test/finish.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
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
  sup = new SupervisorService(reg, wt);
});
afterEach(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

// Seed a group + session with a real worktree branched off `dev`; `mutate` runs work
// inside the worktree before the session row is created.
async function seed(mutate: (wtDir: string) => void): Promise<{ id: string; wtDir: string }> {
  const g = reg.createGroup({ name: "g", projectDir: repo });
  const parent = mkdtempSync(join(tmpdir(), "kmq-finish-wt-"));
  trash.push(parent);
  const wtDir = join(parent, "wt"); // non-existing path — `git worktree add` creates it
  await wt.addWorktree(repo, wtDir, "kermanych/s1");
  mutate(wtDir);
  const s = reg.createSession({ groupId: g.id, name: "task one", task: "t", worktreePath: wtDir, branch: "kermanych/s1" });
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

test("on merge conflict, aborts and leaves the worktree + branch intact (not merged)", async () => {
  const { id, wtDir } = await seed((d) => {
    writeFileSync(join(d, "file.txt"), "session\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "session edit");
  });
  // `dev` diverges on the same file → merge cannot fast-forward and conflicts
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main edit");

  await expect(sup.finishSession(id)).rejects.toThrow();

  expect(existsSync(wtDir)).toBe(true); // worktree survives for manual resolution
  expect(git(repo, "status", "--porcelain").trim()).toBe(""); // merge was aborted, tree clean
  expect(git(repo, "branch", "--list", "kermanych/s1").trim()).not.toBe(""); // branch survives
  expect(reg.listSessions().find((x) => x.id === id)!.status).not.toBe("merged");
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
