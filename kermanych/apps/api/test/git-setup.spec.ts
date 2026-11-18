import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GitCloneState, ServerEvent } from "@kermanych/core";
import { GitSetupService, parseCloneProgress } from "../src/git/git-setup.service";
import { credentialEnv } from "../src/git/git-credentials";
import { WorktreeService } from "../src/worktree/worktree.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";

// The project wizard's git (docs/specs/2026-11-18-first-run-and-project-wizard.md): a clone job
// against a local bare repository, its refusals, and the rule that a failed or cancelled clone
// removes only what it created.

let root: string;
let bareUrl: string;
let events: GitCloneState[];
let svc: GitSetupService;
const savedSsh = process.env.GIT_SSH_COMMAND;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kmq-gitsetup-"));
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "-c", "init.defaultBranch=trunk", "init", "-q");
  for (let i = 0; i < 20; i++) writeFileSync(join(src, `f${i}.txt`), `line ${i}\n`);
  git(src, "add", ".");
  git(src, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
  git(root, "clone", "-q", "--bare", src, "bare.git");
  bareUrl = `file://${join(root, "bare.git")}`;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fresh = () => {
  events = [];
  const supervisor = { publish: (e: ServerEvent) => e.type === "git_clone" && events.push(e.state) } as unknown as SupervisorService;
  svc = new GitSetupService(supervisor, new WorktreeService());
  return mkdtempSync(join(root, "parent-"));
};

afterEach(() => {
  if (savedSsh === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = savedSsh;
});

async function settled(jobId: string): Promise<GitCloneState> {
  for (let i = 0; i < 300; i++) {
    const s = svc.get(jobId)!;
    if (s.phase !== "cloning") return s;
    await sleep(20);
  }
  throw new Error("clone did not settle");
}

// An ssh that `git` runs for an ssh:// remote: the tests' stand-in for a slow or refusing host.
function fakeSsh(body: string): void {
  const script = join(root, `ssh-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.GIT_SSH_COMMAND = script;
}

describe("parseCloneProgress", () => {
  it.each([
    ["remote: Counting objects:  45% (9/20)        ", { stage: "Counting objects", percent: 45 }],
    ["remote: Counting objects: 100% (32/32), done.", { stage: "Counting objects", percent: 100 }],
    ["remote: Compressing objects:   3% (1/22)", { stage: "Compressing objects", percent: 3 }],
    ["Receiving objects: 100% (32/32), 1.2 MiB | 3.4 MiB/s, done.", { stage: "Receiving objects", percent: 100 }],
    ["Receiving objects:   7% (2/32)", { stage: "Receiving objects", percent: 7 }],
    ["Resolving deltas:  50% (1/2)", { stage: "Resolving deltas", percent: 50 }],
    ["Updating files: 100% (12/12), done.", { stage: "Updating files", percent: 100 }],
    ["remote: Enumerating objects: 32, done.        ", { stage: "Enumerating objects", percent: null }],
  ])("reads %j", (line, want) => {
    expect(parseCloneProgress(line)).toEqual(want);
  });

  it.each([
    "Cloning into 'out'...",
    "remote: Total 32 (delta 0), reused 0 (delta 0), pack-reused 0",
    "fatal: repository 'x' does not exist",
    "warning: You appear to have cloned an empty repository.",
    "",
  ])("ignores %j", (line) => {
    expect(parseCloneProgress(line)).toBeNull();
  });
});

describe("credentialEnv", () => {
  const helper = (url?: string) => credentialEnv("tok", url).GIT_CONFIG_VALUE_1 ?? "";

  it.each([
    ["https://github.com/o/r.git", "x-access-token"],
    ["git@github.com-work:o/r.git", "x-access-token"],
    ["https://gitlab.com/o/r.git", "oauth2"],
    ["https://gitlab.example.org/o/r.git", "oauth2"],
    ["https://bitbucket.org/o/r.git", "x-token-auth"],
    ["https://git.example.com/o/r.git", "x-access-token"],
    [undefined, "x-access-token"],
  ])("names the username for %s", (url, user) => {
    expect(helper(url)).toContain(`username=${user}`);
  });

  it("carries the token in the environment only, never prompts", () => {
    const env = credentialEnv("secret", "https://github.com/o/r.git");
    expect(env.KERMANYCH_GIT_TOKEN).toBe("secret");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_VALUE_1).not.toContain("secret");
    expect(credentialEnv("").KERMANYCH_GIT_TOKEN).toBeUndefined();
  });

  it("puts ssh in batch mode for ssh remotes unless one is configured", () => {
    delete process.env.GIT_SSH_COMMAND;
    expect(credentialEnv("", "git@github.com:o/r.git").GIT_SSH_COMMAND).toMatch(/BatchMode=yes/);
    expect(credentialEnv("", "ssh://git@host/o/r.git").GIT_SSH_COMMAND).toMatch(/BatchMode=yes/);
    expect(credentialEnv("", "https://github.com/o/r.git").GIT_SSH_COMMAND).toBeUndefined();
    process.env.GIT_SSH_COMMAND = "ssh -i key";
    expect(credentialEnv("", "git@github.com:o/r.git").GIT_SSH_COMMAND).toBe("ssh -i key");
  });
});

describe("inspect", () => {
  it("reads a repository root's origin, branch and name", async () => {
    fresh();
    const dir = join(root, "checkout");
    git(root, "clone", "-q", bareUrl, dir);
    const r = await svc.inspect(dir);
    expect(r).toEqual({ path: dir, isRepo: true, origin: bareUrl, branch: "trunk", name: "checkout" });
  });

  it("calls a subfolder or a plain folder not a repo, and refuses a file", async () => {
    fresh();
    const dir = join(root, "checkout2");
    git(root, "clone", "-q", bareUrl, dir);
    mkdirSync(join(dir, "sub"));
    expect((await svc.inspect(join(dir, "sub"))).isRepo).toBe(false);
    const plain = mkdtempSync(join(root, "plain-"));
    expect(await svc.inspect(plain)).toMatchObject({ isRepo: false, origin: null, branch: null });
    await expect(svc.inspect(join(dir, "f1.txt"))).rejects.toThrow(/not a directory/);
  });
});

describe("remoteHead", () => {
  it("reads the branch HEAD names", async () => {
    fresh();
    expect(await svc.remoteHead(bareUrl)).toBe("trunk");
  });

  it("refuses an unreachable remote with git's message", async () => {
    fresh();
    await expect(svc.remoteHead(`file://${join(root, "nope.git")}`, "tok")).rejects.toThrow(/nope\.git/);
  });
});

describe("clone", () => {
  it("clones a local bare repository and ends done with the folder in place", async () => {
    const parent = fresh();
    const started = await svc.clone({ url: bareUrl, parentDir: parent, dirName: "app" });
    expect(started).toMatchObject({ phase: "cloning", path: join(parent, "app"), error: null });
    const end = await settled(started.jobId);
    expect(end).toMatchObject({ phase: "done", error: null, authFailed: false });
    expect(existsSync(join(parent, "app", "f0.txt"))).toBe(true);
    expect(git(join(parent, "app"), "remote", "get-url", "origin").trim()).toBe(bareUrl);
    expect(events[0]!.phase).toBe("cloning");
    expect(events.at(-1)!.phase).toBe("done");
  });

  it("clones into an existing empty folder", async () => {
    const parent = fresh();
    mkdirSync(join(parent, "app"));
    const end = await settled((await svc.clone({ url: bareUrl, parentDir: parent, dirName: "app" })).jobId);
    expect(end.phase).toBe("done");
  });

  it("refuses a non-empty target and a malformed request before touching the disk", async () => {
    const parent = fresh();
    mkdirSync(join(parent, "app"));
    writeFileSync(join(parent, "app", "keep.txt"), "x");
    await expect(svc.clone({ url: bareUrl, parentDir: parent, dirName: "app" })).rejects.toThrow("target_not_empty");
    writeFileSync(join(parent, "file"), "x");
    await expect(svc.clone({ url: bareUrl, parentDir: parent, dirName: "file" })).rejects.toThrow("target_not_empty");
    for (const bad of [
      { url: "", parentDir: parent, dirName: "a" },
      { url: bareUrl, parentDir: "relative/dir", dirName: "a" },
      { url: bareUrl, parentDir: parent, dirName: ".." },
      { url: bareUrl, parentDir: parent, dirName: "a/b" },
      { url: bareUrl, parentDir: parent, dirName: "" },
    ])
      await expect(svc.clone(bad)).rejects.toThrow("invalid_clone_request");
    expect(readdirSync(join(parent, "app"))).toEqual(["keep.txt"]);
    expect(events).toEqual([]);
  });

  it("removes the folder it created when the clone fails", async () => {
    const parent = fresh();
    const end = await settled((await svc.clone({ url: `file://${join(root, "missing.git")}`, parentDir: parent, dirName: "app" })).jobId);
    expect(end.phase).toBe("failed");
    expect(end.error).toMatch(/missing\.git/);
    expect(end.authFailed).toBe(false);
    expect(existsSync(join(parent, "app"))).toBe(false);
    expect(events.at(-1)!.phase).toBe("failed");
  });

  it("keeps a pre-existing empty folder, emptied, when the clone fails", async () => {
    const parent = fresh();
    mkdirSync(join(parent, "app"));
    const end = await settled((await svc.clone({ url: `file://${join(root, "missing.git")}`, parentDir: parent, dirName: "app" })).jobId);
    expect(end.phase).toBe("failed");
    expect(readdirSync(join(parent, "app"))).toEqual([]);
  });

  it("marks an ssh key refusal as authFailed and masks the token", async () => {
    const parent = fresh();
    fakeSsh(`echo "git@host: Permission denied (publickey). token=$KERMANYCH_GIT_TOKEN" >&2; exit 255`);
    const job = await svc.clone({ url: "ssh://git@host.invalid/o/r.git", parentDir: parent, dirName: "r", token: "s3cr3t" });
    const end = await settled(job.jobId);
    expect(end.phase).toBe("failed");
    expect(end.authFailed).toBe(true);
    expect(end.error).toContain("Permission denied (publickey)");
    expect(end.error).not.toContain("s3cr3t");
  });

  it("cancel stops a running clone and removes only the folder it created", async () => {
    const parent = fresh();
    fakeSsh("exec sleep 30");
    const job = await svc.clone({ url: "ssh://git@host.invalid/o/r.git", parentDir: parent, dirName: "r" });
    await sleep(200);
    const end = await svc.cancel(job.jobId);
    expect(end!.phase).toBe("cancelled");
    expect(existsSync(join(parent, "r"))).toBe(false);
    expect(existsSync(parent)).toBe(true);
    expect(events.at(-1)!.phase).toBe("cancelled");
    expect((await svc.cancel(job.jobId))!.phase).toBe("cancelled");
  });

  it("cancel keeps a pre-existing empty folder", async () => {
    const parent = fresh();
    mkdirSync(join(parent, "r"));
    fakeSsh("exec sleep 30");
    const job = await svc.clone({ url: "ssh://git@host.invalid/o/r.git", parentDir: parent, dirName: "r" });
    await sleep(200);
    expect((await svc.cancel(job.jobId))!.phase).toBe("cancelled");
    expect(readdirSync(join(parent, "r"))).toEqual([]);
  });

  it("answers null for an unknown job", async () => {
    fresh();
    expect(svc.get("nope")).toBeNull();
    expect(await svc.cancel("nope")).toBeNull();
  });
});
