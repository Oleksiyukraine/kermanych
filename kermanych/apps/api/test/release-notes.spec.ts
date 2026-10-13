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
    sources: [
      {
        projectName: "мобільний-застосунок",
        branch: "release/2.4",
        repoPath: "/repos/mobile",
        commits: [commit(), commit({ subject: "виправлено падіння на логіні", body: "Падало, коли токен протух." })],
      },
    ],
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-31",
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
  it("demands plain language for a non-technical reader", () => {
    expect(prompt).toContain("без технічної освіти");
  });

  // Every note is English, whatever language the commits (here Ukrainian) are written in:
  // the rule names English and tells the model to translate rather than quote.
  it("always writes the note in English, translating commits in another language", () => {
    expect(prompt).toContain("МОВА ДОКУМЕНТА — АНГЛІЙСЬКА, завжди");
    expect(prompt).toContain("коміти іншою мовою перекладай англійською");
    expect(prompt).not.toContain("українською");
  });

  it("carries each commit's subject and its indented body", () => {
    expect(prompt).toContain("2026-08-20 · Оля: додано експорт у PDF");
    expect(prompt).toContain("    Падало, коли токен протух.");
  });

  it("requires a first-level heading, which is where the stored title comes from", () => {
    expect(prompt).toContain("заголовок першого рівня");
  });

  // One project is the note it always was: no project sections, and no folder to point at
  // — the child is born in that repository.
  it("writes no project sections for a single project", () => {
    expect(prompt).not.toContain("Розділи документ за проєктами");
    expect(prompt).not.toContain("/repos/mobile");
  });
});

describe("buildReleaseNotesPrompt — several projects", () => {
  const back = { projectName: "Backend", branch: "dev", repoPath: "/repos/back" };
  const front = { projectName: "Frontend", branch: "main", repoPath: "/repos/front" };
  const ask = { workspaceName: "Acme", rangeFrom: "2026-08-01", rangeTo: "2026-08-31" };
  const prompt = buildReleaseNotesPrompt({
    ...ask,
    sources: [
      { ...back, commits: [commit({ subject: "черга листів" })] },
      { ...front, commits: [commit({ subject: "темна тема" })] },
    ],
  });

  it("heads one section per project, by its exact name, in the order given", () => {
    expect(prompt).toContain("Розділи документ за проєктами");
    expect(prompt).toContain("заголовок другого рівня, який є РІВНО назвою проєкту");
    expect(prompt).toContain("1. Backend — гілка dev, код у теці /repos/back\n2. Frontend — гілка main, код у теці /repos/front");
  });

  // The split the operator asked for: a commit is printed under its own project only, so the
  // model has no mixed list to mis-attribute from.
  it("prints each project's commits under that project", () => {
    const backAt = prompt.indexOf("=== Проєкт Backend (гілка dev) ===");
    const frontAt = prompt.indexOf("=== Проєкт Frontend (гілка main) ===");
    expect(backAt).toBeGreaterThan(0);
    expect(frontAt).toBeGreaterThan(backAt);
    const mail = prompt.indexOf(": черга листів");
    const theme = prompt.indexOf(": темна тема");
    expect(mail > backAt && mail < frontAt).toBe(true);
    expect(theme).toBeGreaterThan(frontAt);
  });

  it("moves the by-meaning groups and the per-person sections inside each project", () => {
    expect(prompt).toContain("Усередині розділу кожного проєкту згрупуй");
    expect(prompt).toContain("«New», «Improvements», «Fixes» (заголовки третього рівня");
    const perPerson = buildReleaseNotesPrompt({
      ...ask,
      groupBy: "person",
      sources: [
        { ...back, commits: [commit({ author: "Оля" })] },
        { ...front, commits: [commit({ author: "Петро" })] },
      ],
    });
    expect(perPerson).toContain("заголовок третього рівня для кожної людини");
    // Each project's own roster, not one merged list.
    expect(perPerson.match(/Учасники \(/g)).toHaveLength(2);
  });

  // One busy repository must not push the other one's commits out of the prompt.
  it("splits the commit budget evenly between the projects", () => {
    const out = buildReleaseNotesPrompt({
      ...ask,
      sources: [
        { ...back, commits: [commit({ body: "x".repeat(MAX_COMMITS_CHARS * 0.6) }), commit({ subject: "за межею" })] },
        { ...front, commits: [commit({ subject: "темна тема" })] },
      ],
    });
    expect(out).not.toContain(": за межею");
    expect(out).toContain("(1 з 2 — список обрізано");
    expect(out).toContain(": темна тема");
  });
});

describe("buildReleaseNotesPrompt — per person", () => {
  const ask = {
    workspaceName: "Acme",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-31",
  };
  const repo = { projectName: "мобільний-застосунок", branch: "main", repoPath: "/repos/mobile" };
  // Newest first and interleaved, as git hands them out.
  const commits = [
    commit({ author: "Петро", subject: "п-1" }),
    commit({ author: "Оля", subject: "о-1" }),
    commit({ author: "Петро", subject: "п-2" }),
    commit({ author: "Андрій", subject: "а-1" }),
  ];

  // The default must stay the document it always was: grouped by meaning, nobody listed.
  it("keeps the by-topic note when no grouping, or topic, is asked for", () => {
    const plain = buildReleaseNotesPrompt({ ...ask, sources: [{ ...repo, commits }] });
    expect(buildReleaseNotesPrompt({ ...ask, sources: [{ ...repo, commits }], groupBy: "topic" })).toBe(plain);
    expect(plain).toContain("«New», «Improvements», «Fixes»");
    expect(plain).not.toContain("Учасники");
  });

  it("lists every author with a count and prints each author's commits together, busiest first", () => {
    const prompt = buildReleaseNotesPrompt({ ...ask, sources: [{ ...repo, commits }], groupBy: "person" });
    expect(prompt).not.toContain("«New», «Improvements», «Fixes»");
    expect(prompt).toContain("- Петро — 2\n- Андрій — 1\n- Оля — 1");
    const order = ["п-1", "п-2", "а-1", "о-1"].map((s) => prompt.indexOf(`: ${s}`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
  });

  // A person whose commits fell past the cap is still in the roster — a report about people
  // must not silently drop one because somebody else wrote long commit bodies.
  it("names an author whose commits were cut by the cap", () => {
    const prompt = buildReleaseNotesPrompt({
      ...ask,
      groupBy: "person",
      sources: [
        {
          ...repo,
          commits: [
            commit({ author: "Оля", body: "x".repeat(MAX_COMMITS_CHARS) }),
            commit({ author: "Оля", subject: "друге" }),
            commit({ author: "Петро", subject: "за межею" }),
          ],
        },
      ],
    });
    expect(prompt).toContain("- Петро — 1");
    expect(prompt).not.toContain("за межею");
    expect(prompt).toContain("не вигадуй, які саме");
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

// The per-person note groups by this name, so one person's two spellings must arrive as one.
test("logRange names authors through the repository's .mailmap", async () => {
  writeFileSync(join(repo, ".mailmap"), "Тарас Шевченко <t@t>\n");
  commitOn("2026-08-10", "mapped", "a.txt");
  const commits = await wt.logRange(repo, "dev", "2026-08-01", "2026-08-31");
  expect(commits[0]!.author).toBe("Тарас Шевченко");
});
