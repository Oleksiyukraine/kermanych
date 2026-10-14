// apps/api/test/base-sync.spec.ts
// docs/specs/2026-10-14-create-pr-base-sync.md against real repositories: a bare origin, the
// project's own checkout (it only learns about origin when a test fetches) and a teammate's clone
// that moves origin's `dev` the way merged pull requests do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextMacrotask } from "node:timers/promises";

// The session's agent: what it is asked, and a way to play its turns back at the supervisor.
const prompts: string[] = [];
const eventCbs: ((e: unknown) => void)[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent(cb: (e: unknown) => void) { eventCbs.push(cb); }
    onExit() {}
    async start() {}
    async switchSession() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    isAlive() { return true; }
    prompt(text: string) { prompts.push(text); }
    followUp(text: string) { prompts.push(text); }
    steer(text: string) { prompts.push(text); }
  }
  return { RpcSession: FakeRpc };
});

import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

function commit(cwd: string, file: string, text = `${file}\n`): void {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", file);
}

const wt = new WorktreeService();
let root: string;
let repo: string;
let mate: string;
let reg: RegistryService;
let sup: SupervisorService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kmq-base-sync-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q", "--bare", origin]);
  repo = join(root, "repo");
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  commit(repo, "base.txt");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "dev");
  mate = join(root, "mate");
  execFileSync("git", ["clone", "-q", origin, mate], { stdio: "pipe" });
  git(mate, "config", "user.email", "m@m");
  git(mate, "config", "user.name", "m");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt, offlineAuth(), stubSkills());
  prompts.length = 0;
  eventCbs.length = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A pull request merged by somebody else: origin's `dev` moves, the project checkout does not know.
function teammateMerges(file: string, text?: string): void {
  git(mate, "pull", "-q", "--ff-only");
  commit(mate, file, text);
  git(mate, "push", "-q", "origin", "dev");
}

// A session as Kermanych leaves it: a worktree on its own branch, forked from `start`, with a
// saved conversation so a message resumes its agent.
async function session(start: string): Promise<{ id: string; dir: string }> {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  const dir = join(root, "wt");
  await wt.addWorktree(repo, dir, "feature/s1", start);
  const s = reg.createSession({ projectId: g.id, name: "s1", task: "t", worktreePath: dir, branch: "feature/s1", baseBranch: "dev" });
  reg.updateSession(s.id, { ompSessionFile: "/tmp/s1.jsonl", status: "done" });
  return { id: s.id, dir };
}

const status = (id: string) => sup.snapshot().sessions.find((x) => x.id === id)!.status;

function endTurn(prUrl?: string): void {
  for (const cb of eventCbs) {
    if (prUrl) {
      cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `ПР відкрито: ${prUrl}` } });
      cb({ type: "message_end", message: { role: "assistant" } });
    }
    cb({ type: "agent_end", isTerminal: true });
  }
}

describe("where a new session branch starts (decision 4)", () => {
  it("forks from origin's base when the local one is only behind, and the branch tracks nothing", async () => {
    teammateMerges("t.txt");

    const start = await wt.forkStart(repo, "dev");
    expect(start).toEqual({ ref: "refs/remotes/origin/dev", stale: false });

    const dir = join(root, "wt");
    await wt.addWorktree(repo, dir, "feature/x", start.ref);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("t.txt");
    expect(() => git(dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
  });

  it("keeps the local base when it is ahead of origin, or the two diverged", async () => {
    commit(repo, "local.txt");
    expect(await wt.forkStart(repo, "dev")).toEqual({ ref: "dev", stale: false });
    teammateMerges("t.txt");
    expect(await wt.forkStart(repo, "dev")).toEqual({ ref: "dev", stale: false });
  });

  it("picks over the last-known origin base, and says it is stale, when origin cannot be asked", async () => {
    teammateMerges("t.txt");
    git(repo, "fetch", "-q", "origin");
    git(repo, "remote", "set-url", "origin", join(root, "gone.git"));

    expect(await wt.forkStart(repo, "dev")).toEqual({ ref: "refs/remotes/origin/dev", stale: true });
  });

  it("forks as before when origin has no such branch, or there is no origin", async () => {
    git(repo, "branch", "release");
    expect(await wt.forkStart(repo, "release")).toEqual({ ref: "release", stale: false });
    git(repo, "remote", "remove", "origin");
    expect(await wt.forkStart(repo, "dev")).toEqual({ ref: "dev", stale: false });
  });
});

describe("counts and diffs once the branch brings origin's base in (decision 5)", () => {
  it("lists only the session's own files and commits, and what origin still has", async () => {
    teammateMerges("t.txt");
    const { id, dir } = await session("dev");
    commit(dir, "s.txt");
    git(repo, "fetch", "-q", "origin");
    expect(await sup.finishInfo(id)).toMatchObject({ target: "dev", ahead: 1, behind: 1 });

    git(dir, "merge", "-q", "--no-edit", "origin/dev");

    const info = await sup.finishInfo(id);
    expect(info.files.map((f) => f.path)).toEqual(["s.txt"]);
    expect(info).toMatchObject({ ahead: 2, behind: 0 }); // its commit and the merge, not the teammate's
  });

  it("gives the reviewer the session's diff from its own base, not from the checkout's branch", async () => {
    teammateMerges("t.txt");
    const { id, dir } = await session("dev");
    commit(dir, "s.txt");
    git(dir, "fetch", "-q", "origin");
    git(dir, "merge", "-q", "--no-edit", "origin/dev");
    git(repo, "checkout", "-q", "-b", "elsewhere");

    await sup.reviewSession(id);

    const p = prompts.at(-1)!;
    expect(p).toContain("base `dev`");
    expect(p).toContain("s.txt");
    expect(p).not.toContain("t.txt");
  });
});

describe("a turn that ends mid-merge (decision 6)", () => {
  it("rests at conflict, and clears once the finish sheet finds the merge resolved", async () => {
    teammateMerges("base.txt", "theirs\n");
    const { id, dir } = await session("dev");
    commit(dir, "base.txt", "ours\n");
    git(dir, "fetch", "-q", "origin");
    expect(() => git(dir, "merge", "origin/dev")).toThrow();

    await sup.sendMessage(id, "підтягни dev", "prompt");
    endTurn();
    await vi.waitFor(() => expect(status(id)).toBe("conflict"));
    expect(reg.listSessions().find((x) => x.id === id)!.status).toBe("conflict");

    // Resolved in an editor, with no agent turn to notice it.
    writeFileSync(join(dir, "base.txt"), "both\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--no-edit");
    expect((await sup.finishInfo(id)).conflicts).toEqual([]);
    expect(status(id)).toBe("done");
  });
});

describe("after the pull-request turn (decision 6)", () => {
  it("warns when the agent pushed without bringing origin's base in", async () => {
    const { id, dir } = await session("dev");
    commit(dir, "s.txt");
    teammateMerges("t.txt");
    await sup.createPullRequest(id);
    expect(prompts.at(-1)).toContain("git merge --no-commit origin/dev");

    git(dir, "push", "-q", "origin", "feature/s1");
    endTurn("https://github.com/o/r/pull/7");

    await vi.waitFor(() =>
      expect(sup.getTranscript(id).find((e) => e.kind === "notice")).toMatchObject({
        level: "warn",
        code: "pr_behind_base",
        params: { base: "dev", count: 1 },
      }),
    );
    expect(status(id)).toBe("in_review");
  });

  it("checks the pushed branch: a merge left unpushed still leaves the PR behind", async () => {
    const { id, dir } = await session("dev");
    commit(dir, "s.txt");
    git(dir, "push", "-q", "origin", "feature/s1");
    teammateMerges("t.txt");
    await sup.createPullRequest(id);

    git(dir, "fetch", "-q", "origin");
    git(dir, "merge", "-q", "--no-edit", "origin/dev");
    endTurn("https://github.com/o/r/pull/7");

    await vi.waitFor(() =>
      expect(sup.getTranscript(id).find((e) => e.kind === "notice")).toMatchObject({ code: "pr_behind_base", params: { count: 1 } }),
    );
  });

  it("stays silent when the pushed branch has origin's base", async () => {
    const counted = vi.spyOn(wt, "behindCount");
    try {
      const { id, dir } = await session("dev");
      commit(dir, "s.txt");
      teammateMerges("t.txt");
      await sup.createPullRequest(id);

      git(dir, "fetch", "-q", "origin");
      git(dir, "merge", "-q", "--no-edit", "origin/dev");
      git(dir, "push", "-q", "origin", "feature/s1");
      endTurn("https://github.com/o/r/pull/7");

      await vi.waitFor(() => expect(counted).toHaveBeenCalled());
      await counted.mock.results[0]!.value;
      await nextMacrotask();
      expect(sup.getTranscript(id).some((e) => e.kind === "notice")).toBe(false);
    } finally {
      counted.mockRestore();
    }
  });
});
