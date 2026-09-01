// apps/api/test/release-notes.spec.ts
// The pure halves of the release-notes generator: the prompt the model is handed, the
// commit-block cap, the title extraction and the git-log parsing. The omp round trip
// itself is not tested here for the same reason management-chat's is not — it is the
// same RpcSession plumbing rpc-session.spec.ts already covers.
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseCommit } from "@kermanych/core";
import { WorktreeService } from "../src/worktree/worktree.service";
import { buildReleaseNotesPrompt, commitsBlock, MAX_COMMITS_CHARS } from "../src/management/release-notes-prompt";
import { titleOf } from "../src/management/release-notes.service";

function commit(over: Partial<ReleaseCommit> = {}): ReleaseCommit {
  return { date: "2026-08-20", author: "Оля", subject: "додано експорт у PDF", body: "", ...over };
}

describe("buildReleaseNotesPrompt", () => {
  const prompt = buildReleaseNotesPrompt({
    workspaceName: "Acme",
    projectName: "мобільний-застосунок",
    branch: "release/2.4",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-31",
    commits: [commit(), commit({ subject: "виправлено падіння на логіні", body: "Падало, коли токен протух." })],
  });

  it("states the repository, the branch and the range verbatim, and no platform", () => {
    expect(prompt).toContain("release/2.4");
    expect(prompt).toContain("2026-08-01 — 2026-08-31");
    expect(prompt).toContain("«Acme»");
    expect(prompt).toContain("мобільний-застосунок");
    // The project IS the shipping shape, so nothing in the prompt asks for a platform.
    expect(prompt).not.toContain("Платформа");
  });

  // The whole feature request in one assertion: the reader is not an engineer.
  it("demands plain language for a non-technical reader, in Ukrainian", () => {
    expect(prompt).toContain("без технічної освіти");
    expect(prompt).toContain("Пиши українською");
  });

  it("carries each commit's subject and its indented body", () => {
    expect(prompt).toContain("2026-08-20 · Оля: додано експорт у PDF");
    expect(prompt).toContain("    Падало, коли токен протух.");
  });

  it("requires a first-level heading, which is where the stored title comes from", () => {
    expect(prompt).toContain("заголовок першого рівня");
  });
});

describe("commitsBlock", () => {
  it("keeps every commit when the block fits", () => {
    const { block, included, truncated } = commitsBlock([commit(), commit({ subject: "друге" })]);
    expect(included).toBe(2);
    expect(truncated).toBe(false);
    expect(block).toContain("друге");
  });

  // Whole commits only: a body sliced mid-sentence would be quoted into the note as if
  // the sentence ended there.
  it("cuts at a commit boundary once the cap is reached, and says so", () => {
    const fat = commit({ body: "x".repeat(MAX_COMMITS_CHARS - 60) });
    const { included, truncated } = commitsBlock([fat, commit({ subject: "за межею" }), commit()]);
    expect(included).toBe(1);
    expect(truncated).toBe(true);
  });

  it("never drops the first commit even when it alone exceeds the cap", () => {
    const oversized = commit({ body: "x".repeat(MAX_COMMITS_CHARS + 100) });
    const { included, truncated } = commitsBlock([oversized, commit()]);
    expect(included).toBe(1);
    expect(truncated).toBe(true);
  });
});

describe("titleOf", () => {
  it("reads the first first-level heading", () => {
    expect(titleOf("# Реліз 2.4 · iOS\n\n## Нове\n- пункт", "запасний")).toBe("Реліз 2.4 · iOS");
  });

  // A `##` is not the document's title, and a model that ignored the heading rule must
  // not sink the generation — the fallback restates what the note is about.
  it("falls back when there is no first-level heading", () => {
    expect(titleOf("## Нове\n- пункт", "запасний")).toBe("запасний");
    expect(titleOf("", "запасний")).toBe("запасний");
  });
});

// ── logRange, against a real repository ───────────────────────────────────────

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;

// Commit dates are pinned so the range filter is deterministic: `--since/--until` read the
// commit date, and a wall-clock date would make the test mean something different each day.
function commitOn(date: string, message: string, file: string): void {
  writeFileSync(join(repo, file), `${message}\n`);
  git(repo, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` },
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-rel-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "Тарас");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("logRange keeps only the branch's commits inside the inclusive date range", async () => {
  commitOn("2026-07-31", "before the range", "a.txt");
  commitOn("2026-08-01", "first day", "b.txt");
  commitOn("2026-08-31", "last day", "c.txt");
  commitOn("2026-09-01", "after the range", "d.txt");

  const commits = await wt.logRange(repo, "dev", "2026-08-01", "2026-08-31");

  expect(commits.map((c) => c.subject)).toEqual(["last day", "first day"]);
  expect(commits[0]).toMatchObject({ date: "2026-08-31", author: "Тарас", body: "" });
});

test("logRange carries the commit body and survives newlines inside it", async () => {
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(repo, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", "subject line", "-m", "чому: перший рядок\nдругий рядок"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-10T12:00:00", GIT_COMMITTER_DATE: "2026-08-10T12:00:00" },
  });

  const commits = await wt.logRange(repo, "dev", "2026-08-01", "2026-08-31");

  expect(commits).toHaveLength(1);
  expect(commits[0]!.subject).toBe("subject line");
  expect(commits[0]!.body).toBe("чому: перший рядок\nдругий рядок");
});

test("logRange answers an empty list for an unknown branch rather than throwing", async () => {
  commitOn("2026-08-10", "on dev", "a.txt");
  expect(await wt.logRange(repo, "no-such-branch", "2026-08-01", "2026-08-31")).toEqual([]);
});
