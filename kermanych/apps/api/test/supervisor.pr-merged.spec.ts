// apps/api/test/supervisor.pr-merged.spec.ts
// The merged-PR check and «Закрити задачу» (docs/specs/2026-10-26-pr-merged-close-prompt.md)
// over a real git worktree and a fake GitHub (`fetch` stubbed, as the Jira/Linear client specs
// do): which PR is found, how GitHub's failures read, what work the merged PR is missing, and
// that closing skips the documentation gate only after a confirmed merge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Session } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { EnvFileService } from "../src/env/env-file.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

const P = "55555555-5555-4555-8555-555555555555";
const BRANCH = "kermanych/s1";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (dir: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

const wt = new WorktreeService();
let repo: string;
let trash: string[];
let reg: RegistryService;
let sup: SupervisorService;

// The fake GitHub: `answer` maps a request URL to a response; every request is recorded.
type Answer = { status?: number; json?: unknown; headers?: Record<string, string> } | Error;
let calls: { url: string; headers: Record<string, string> }[];
function github(answer: (url: URL) => Answer): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    const a = answer(new URL(url));
    if (a instanceof Error) throw a;
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json", ...a.headers },
    });
  });
}

const later = new Date(Date.now() + 60_000).toISOString();
const pull = (number: number, o: { merged?: boolean; state?: "open" | "closed"; sha?: string; base?: string; created?: string } = {}) => ({
  number,
  html_url: `https://github.com/o/r/pull/${number}`,
  state: o.state ?? (o.merged ? "closed" : "open"),
  merged_at: o.merged ? later : null,
  created_at: o.created ?? later,
  head: { sha: o.sha ?? "0".repeat(40), ref: BRANCH },
  base: { ref: o.base ?? "dev" },
});
// A route: the stored PR's own endpoint, and the closed-by-branch listing.
const isPull = (u: URL, n: number) => u.pathname === `/repos/o/r/pulls/${n}`;
const isList = (u: URL) => u.pathname === "/repos/o/r/pulls" && u.searchParams.get("state") === "closed";

beforeEach(() => {
  calls = [];
  repo = mkdtempSync(join(tmpdir(), "kmq-pr-merged-"));
  trash = [repo];
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
  write(repo, "src/app.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".env\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(
    reg, wt, offlineAuth(), stubSkills(), undefined as never,
    undefined, undefined, undefined, undefined, undefined, undefined, new EnvFileService(wt),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

// An agent session that opened its PR, on a real worktree branched off `dev` with one commit of
// code (no task document, so the documentation gate fails when the project requires it).
async function seed(patch: Partial<Session> = {}, docsRequired = false): Promise<{ id: string; wtDir: string; head: string }> {
  reg.upsertProject({ id: P, name: "g", localRepoPath: repo, docsRequired });
  const parent = mkdtempSync(join(tmpdir(), "kmq-pr-merged-wt-"));
  trash.push(parent);
  const wtDir = join(parent, "wt");
  await wt.addWorktree(repo, wtDir, BRANCH);
  write(wtDir, "src/app.ts", "export const a = 2;\n");
  git(wtDir, "add", "-A");
  git(wtDir, "commit", "-q", "-m", "work");
  const s = reg.createSession({ projectId: P, name: "task", task: "t", worktreePath: wtDir, branch: BRANCH, baseBranch: "dev" });
  reg.updateSession(s.id, { status: "in_review", prOpened: true, ...patch });
  return { id: s.id, wtDir, head: git(wtDir, "rev-parse", "HEAD") };
}

describe("prCheck: finding the PR", () => {
  it("reports a stored URL's merged PR without a branch lookup", async () => {
    const { id, head } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    github((u) => (isPull(u, 7) ? { json: pull(7, { merged: true, sha: head }) } : { status: 500 }));

    expect(await sup.prCheck(id)).toEqual({
      state: "merged", url: "https://github.com/o/r/pull/7", number: 7, leftover: { dirty: false, unpushed: false },
    });
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/o/r/pulls/7"]);
  });

  it.each(["open", "closed"] as const)("reports a stored URL's %s PR when the branch has no merged one", async (state) => {
    const { id } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    github((u) => (isPull(u, 7) ? { json: pull(7, { state }) } : isList(u) ? { json: [] } : { status: 500 }));

    expect(await sup.prCheck(id)).toEqual({ state, url: "https://github.com/o/r/pull/7", number: 7 });
  });

  it("finds the merged replacement of a stored PR that was closed", async () => {
    const { id, head } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    github((u) =>
      isPull(u, 7) ? { json: pull(7, { state: "closed" }) }
      : isList(u) ? { json: [pull(7, { state: "closed" }), pull(9, { merged: true, sha: head })] }
      : { status: 500 },
    );

    expect(await sup.prCheck(id)).toMatchObject({ state: "merged", number: 9, url: "https://github.com/o/r/pull/9" });
  });

  it("without a URL counts only a merged PR into the session's base opened since the session", async () => {
    const { id, head } = await seed();
    github((u) =>
      isList(u)
        ? {
            json: [
              pull(1, { merged: true, base: "main" }), // another base
              pull(2, { merged: true, created: "2020-01-01T00:00:00Z" }), // a reused branch name's old PR
              pull(3, { state: "closed" }), // closed without merging
              pull(4, { merged: true, sha: head }),
            ],
          }
        : { status: 500 },
    );

    expect(await sup.prCheck(id)).toMatchObject({ state: "merged", number: 4 });
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get("head")).toBe(`o:${BRANCH}`);
    expect(q.get("per_page")).toBe("100");
  });

  it("without a URL reports a matching closed PR as closed, and nothing as not found", async () => {
    const { id } = await seed();
    github((u) => (isList(u) ? { json: [pull(3, { state: "closed" }), pull(1, { merged: true, base: "main" })] } : { status: 500 }));
    expect(await sup.prCheck(id)).toEqual({ state: "closed", url: "https://github.com/o/r/pull/3", number: 3 });

    github(() => ({ json: [] }));
    expect(await sup.prCheck(id)).toEqual({ state: "not_found" });
  });

  it("does not check a non-GitHub remote without a GitHub URL", async () => {
    const { id } = await seed({ prUrl: "https://gitlab.com/o/r/-/merge_requests/3" });
    git(repo, "remote", "set-url", "origin", "git@gitlab.com:o/r.git");
    github(() => ({ json: [] }));

    expect(await sup.prCheck(id)).toEqual({ state: "unsupported" });
    expect(calls).toHaveLength(0);
  });
});

describe("prCheck: GitHub failures", () => {
  it.each([
    [{ status: 401 }, "no_access"],
    [{ status: 403 }, "no_access"],
    [{ status: 404 }, "no_access"],
    [{ status: 403, headers: { "x-ratelimit-remaining": "0" } }, "rate_limited"],
    [{ status: 429 }, "rate_limited"],
    [{ status: 502 }, "error"],
    [new TypeError("fetch failed"), "offline"],
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "offline"],
  ] as const)("maps %o to %s", async (answer, state) => {
    const { id } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    github(() => answer);

    expect(await sup.prCheck(id)).toEqual({ state });
  });

  it("maps a refused branch lookup to no access", async () => {
    const { id } = await seed();
    github(() => ({ status: 404 }));
    expect(await sup.prCheck(id)).toEqual({ state: "no_access" });
  });
});

describe("prCheck: which sessions are checked", () => {
  it.each<[string, Partial<Session>]>([
    ["an active one", { status: "thinking" }],
    ["a waiting one", { status: "waiting_input" }],
    ["a retired one", { status: "merged" }],
    ["one without a PR", { prOpened: false }],
    ["a non-agent one", { kind: "review" }],
  ])("skips %s", async (_name, patch) => {
    const { id } = await seed({ prUrl: "https://github.com/o/r/pull/7", ...patch });
    github(() => ({ json: pull(7, { merged: true }) }));

    expect(await sup.prCheck(id)).toEqual({ state: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown session", async () => {
    await expect(sup.prCheck("nope")).rejects.toThrow(/session not found/);
  });
});

describe("prCheck: credentials", () => {
  it("sends the project's GIT_TOKEN as a bearer token", async () => {
    const { id } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    write(repo, ".env", "GIT_TOKEN=ghp_secret\n");
    github(() => ({ json: pull(7, { state: "open" }) }));

    const res = await sup.prCheck(id);

    expect(calls[0]!.headers.Authorization).toBe("Bearer ghp_secret");
    expect(calls[0]!.headers.Accept).toBe("application/vnd.github+json");
    expect(JSON.stringify(res)).not.toContain("ghp_secret");
  });

  it("asks anonymously without one", async () => {
    const { id } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    write(repo, ".env", "OTHER=1\n");
    github(() => ({ json: pull(7, { state: "open" }) }));

    await sup.prCheck(id);

    expect(calls[0]!.headers).not.toHaveProperty("Authorization");
  });
});

describe("prCheck: work the merged PR does not carry", () => {
  const merged = async (sha: (head: string) => string, after?: (wtDir: string) => void) => {
    const { id, wtDir, head } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    after?.(wtDir);
    github(() => ({ json: pull(7, { merged: true, sha: sha(head) }) }));
    return (await sup.prCheck(id)).leftover;
  };

  it("finds nothing on a clean branch equal to the PR head", async () => {
    expect(await merged((h) => h)).toEqual({ dirty: false, unpushed: false });
  });

  it("finds nothing when the PR head is ahead of the local branch", async () => {
    // The PR got a commit on GitHub that this clone has fetched: local is its ancestor.
    const { id, wtDir } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    write(wtDir, "src/b.ts", "b\n");
    git(wtDir, "add", "-A");
    git(wtDir, "commit", "-q", "-m", "pushed later");
    const ahead = git(wtDir, "rev-parse", "HEAD");
    git(wtDir, "reset", "-q", "--hard", "HEAD~1");
    github(() => ({ json: pull(7, { merged: true, sha: ahead }) }));
    expect((await sup.prCheck(id)).leftover).toEqual({ dirty: false, unpushed: false });
  });

  it("flags a commit made after the PR head", async () => {
    expect(
      await merged((h) => h, (d) => {
        write(d, "src/c.ts", "c\n");
        git(d, "add", "-A");
        git(d, "commit", "-q", "-m", "after the push");
      }),
    ).toEqual({ dirty: false, unpushed: true });
  });

  it("flags a PR head this clone does not know", async () => {
    expect(await merged(() => "f".repeat(40))).toEqual({ dirty: false, unpushed: true });
  });

  it("flags uncommitted changes", async () => {
    expect(await merged((h) => h, (d) => write(d, "src/app.ts", "export const a = 3;\n"))).toEqual({ dirty: true, unpushed: false });
  });
});

describe("closeMerged", () => {
  it("finishes a merged session even though the documentation gate fails", async () => {
    const { id, wtDir, head } = await seed({ prUrl: "https://github.com/o/r/pull/7" }, true);
    github(() => ({ json: pull(7, { merged: true, sha: head }) }));

    // The public finish keeps the gate.
    await expect(sup.finishSession(id)).rejects.toThrow(/^documentation required/);
    expect(existsSync(wtDir)).toBe(true);

    expect(await sup.closeMerged(id)).toEqual({ finished: true, branch: BRANCH });
    expect(existsSync(wtDir)).toBe(false);
    expect(reg.listSessions().find((s) => s.id === id)).toMatchObject({ status: "merged", worktreePath: "" });
    expect(git(repo, "rev-parse", BRANCH)).toBe(head); // the branch is kept
  });

  it("refuses a PR that is still open", async () => {
    const { id, wtDir } = await seed({ prUrl: "https://github.com/o/r/pull/7" });
    github((u) => (isPull(u, 7) ? { json: pull(7, { state: "open" }) } : { json: [] }));

    await expect(sup.closeMerged(id)).rejects.toThrow("pr is not merged");
    expect(existsSync(wtDir)).toBe(true);
    expect(reg.listSessions().find((s) => s.id === id)!.status).toBe("in_review");
  });
});
