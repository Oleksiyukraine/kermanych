// apps/api/test/startup-gc.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDir } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { StartupGcService } from "../src/gc/startup-gc.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;
let legacy: string;
let native: string;
let reg: RegistryService;
let gc: StartupGcService;
let trash: string[];
const prevDb = process.env.KERMANYCH_DB;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-gc-"));
  legacy = mkdtempSync(join(tmpdir(), "kmq-gc-legacy-"));
  native = mkdtempSync(join(tmpdir(), "kmq-gc-native-"));
  trash = [repo, legacy, native];
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  gc = new StartupGcService(reg, wt);
  gc.opts.legacyRoot = legacy;
  gc.opts.nativeRoot = native;
  delete process.env.KERMANYCH_DB;
});
afterEach(() => {
  if (prevDb === undefined) delete process.env.KERMANYCH_DB;
  else process.env.KERMANYCH_DB = prevDb;
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

async function tree(branch: string): Promise<string> {
  const dir = worktreeDir(repo, branch);
  await wt.addWorktree(repo, dir, branch, "dev");
  return dir;
}

function session(branch: string, worktreePath: string): string {
  return reg.createSession({ projectId: "p1", name: branch, task: "t", worktreePath, branch, baseBranch: "dev" }).id;
}

const registered = (): string => git(repo, "worktree", "list", "--porcelain");

// `.gitworktree/` is shared with the operator and other tools: a tree Kermanych did not make is
// never touched, however unreferenced and clean it is.
test("a worktree no session made is kept, even unreferenced and clean", async () => {
  const dir = await tree("feature/operators-own");
  await gc.run();
  expect(existsSync(dir)).toBe(true);
  expect(registered()).toContain("feature/operators-own");
  // The main checkout is never a candidate.
  expect(existsSync(join(repo, "file.txt"))).toBe(true);
});

test("a finished session's leftover tree with uncommitted changes is kept", async () => {
  const dir = await tree("feature/dirty");
  reg.updateSession(session("feature/dirty", ""), { status: "merged" });
  writeFileSync(join(dir, "wip.txt"), "unsaved\n");
  await gc.run();
  expect(existsSync(join(dir, "wip.txt"))).toBe(true);
  expect(registered()).toContain("feature/dirty");
});

test("a worktree a session row names is kept", async () => {
  const dir = await tree("feature/live");
  session("feature/live", dir);
  await gc.run();
  expect(existsSync(dir)).toBe(true);
  expect(registered()).toContain("feature/live");
});

test("a row left without its path by an interrupted launch adopts its tree, which then stays", async () => {
  const dir = await tree("feature/crash");
  const id = session("feature/crash", "");
  await gc.run();
  expect(reg.listSessions().find((s) => s.id === id)!.worktreePath).toBe(dir);
  expect(existsSync(dir)).toBe(true);
  expect(registered()).toContain("feature/crash");
});

test("a finished row does not adopt the tree on its branch: it is a leftover, removed with its branch kept", async () => {
  const dir = await tree("feature/done");
  const id = session("feature/done", "");
  reg.updateSession(id, { status: "merged" });
  await gc.run();
  expect(reg.listSessions().find((s) => s.id === id)!.worktreePath).toBe("");
  expect(existsSync(dir)).toBe(false);
  expect(registered()).not.toContain("feature/done");
  expect(await wt.refExists(repo, "refs/heads/feature/done")).toBe(true);
});

test("legacy leftovers go; a referenced legacy path and a dirty legacy tree stay", async () => {
  const bare = join(legacy, "no-git");
  mkdirSync(join(bare, "node_modules", ".cache"), { recursive: true });
  writeFileSync(join(bare, "node_modules", ".cache", "x"), "x");
  const dangling = join(legacy, "dangling");
  mkdirSync(dangling);
  writeFileSync(join(dangling, ".git"), "gitdir: /private/tmp/kmq-gc-gone/.git/worktrees/x\n");
  const referenced = join(legacy, "referenced");
  mkdirSync(referenced);
  writeFileSync(join(referenced, "keep.txt"), "x");
  session("feature/legacy-live", referenced);
  const linked = join(legacy, "linked");
  await wt.addWorktree(repo, linked, "feature/legacy-clean", "dev");
  const dirty = join(legacy, "dirty");
  await wt.addWorktree(repo, dirty, "feature/legacy-dirty", "dev");
  writeFileSync(join(dirty, "wip.txt"), "unsaved\n");

  await gc.run();

  expect(existsSync(bare)).toBe(false);
  expect(existsSync(dangling)).toBe(false);
  expect(existsSync(join(referenced, "keep.txt"))).toBe(true);
  expect(existsSync(linked)).toBe(false);
  expect(registered()).not.toContain("feature/legacy-clean");
  expect(await wt.refExists(repo, "refs/heads/feature/legacy-clean")).toBe(true);
  expect(existsSync(join(dirty, "wip.txt"))).toBe(true);
  expect(registered()).toContain("feature/legacy-dirty");
});

test("a native MCP config of an unknown session is deleted; a known session's and other files stay", async () => {
  const id = session("feature/native", "");
  writeFileSync(join(native, "mcp-gone-session.json"), "{}");
  writeFileSync(join(native, `mcp-${id}.json`), "{}");
  writeFileSync(join(native, "hook.sh"), "#!/bin/sh\n");
  await gc.onModuleInit();
  expect(existsSync(join(native, "mcp-gone-session.json"))).toBe(false);
  expect(existsSync(join(native, `mcp-${id}.json`))).toBe(true);
  expect(existsSync(join(native, "hook.sh"))).toBe(true);
});

test("with KERMANYCH_DB set nothing is swept", async () => {
  process.env.KERMANYCH_DB = join(repo, "other.sqlite");
  const dir = await tree("feature/orphan");
  reg.updateSession(session("feature/orphan", ""), { status: "merged" });
  const crashId = session("feature/crash", "");
  const crash = await tree("feature/crash");
  const bare = join(legacy, "no-git");
  mkdirSync(bare);
  writeFileSync(join(native, "mcp-gone-session.json"), "{}");

  await gc.onModuleInit();

  expect(existsSync(dir)).toBe(true);
  expect(existsSync(crash)).toBe(true);
  expect(reg.listSessions().find((s) => s.id === crashId)!.worktreePath).toBe("");
  expect(existsSync(bare)).toBe(true);
  expect(existsSync(join(native, "mcp-gone-session.json"))).toBe(true);
});
