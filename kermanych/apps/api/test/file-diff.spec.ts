// apps/api/test/file-diff.spec.ts
// Clicking a file in the Зміни tab must show that file's diff as two columns. Half of that
// is the pairing of `-`/`+` runs (pure, tested against hand-written patches) and half is
// asking git the right question in a real worktree.
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { addedFileDiff, splitDiff } from "../src/worktree/split-diff";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;
let reg: RegistryService;
let sup: SupervisorService;
let trash: string[];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-diff-"));
  trash = [repo];
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt, offlineAuth());
});
afterEach(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

async function seed(mutate: (wtDir: string) => void): Promise<{ id: string; wtDir: string }> {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  const parent = mkdtempSync(join(tmpdir(), "kmq-diff-wt-"));
  trash.push(parent);
  const wtDir = join(parent, "wt");
  await wt.addWorktree(repo, wtDir, "kermanych/s1");
  mutate(wtDir);
  const s = reg.createSession({ projectId: g.id, name: "task one", task: "t", worktreePath: wtDir, branch: "kermanych/s1" });
  return { id: s.id, wtDir };
}

// ── pairing ────────────────────────────────────────────────────────────────────────

test("a replaced line becomes one row carrying both sides", () => {
  const { hunks } = splitDiff(
    ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n"),
  );

  expect(hunks).toHaveLength(1);
  expect(hunks[0]!.header).toBe("@@ -1,3 +1,3 @@");
  expect(hunks[0]!.rows).toEqual([
    { kind: "ctx", old: { no: 1, text: "one" }, new: { no: 1, text: "one" } },
    { kind: "mod", old: { no: 2, text: "two" }, new: { no: 2, text: "TWO" } },
    { kind: "ctx", old: { no: 3, text: "three" }, new: { no: 3, text: "three" } },
  ]);
});

// An uneven run is what keeps the two columns aligned: the surplus side gets rows whose
// other half is blank, so line 3 of the original stays opposite line 3 of the change.
test("a longer added run spills into rows with an empty original side", () => {
  const { hunks } = splitDiff(["@@ -1,1 +1,3 @@", "-two", "+TWO", "+extra", "+more"].join("\n"));

  expect(hunks[0]!.rows).toEqual([
    { kind: "mod", old: { no: 1, text: "two" }, new: { no: 1, text: "TWO" } },
    { kind: "add", old: null, new: { no: 2, text: "extra" } },
    { kind: "add", old: null, new: { no: 3, text: "more" } },
  ]);
});

test("a deleted line leaves the changed side blank", () => {
  const { hunks } = splitDiff(["@@ -1,2 +1,1 @@", " one", "-two"].join("\n"));

  expect(hunks[0]!.rows[1]).toEqual({ kind: "del", old: { no: 2, text: "two" }, new: null });
});

// The trap in every hand-rolled diff parser: a removed `-- flag` is written `--- flag`,
// which is byte-for-byte a file header. Only the hunk's line budget tells them apart.
test("body lines that look like file headers are content, not headers", () => {
  const { hunks } = splitDiff(
    ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "--- old flag", "+++ new flag"].join("\n"),
  );

  expect(hunks).toHaveLength(1);
  expect(hunks[0]!.rows).toEqual([
    { kind: "mod", old: { no: 1, text: "-- old flag" }, new: { no: 1, text: "++ new flag" } },
  ]);
});

test("several hunks keep git's line numbering", () => {
  const { hunks } = splitDiff(
    ["@@ -1,1 +1,1 @@", "-a", "+A", "@@ -40,2 +40,2 @@ fn tail()", " keep", "-b", "+B"].join("\n"),
  );

  expect(hunks).toHaveLength(2);
  expect(hunks[1]!.header).toBe("@@ -40,2 +40,2 @@ fn tail()");
  expect(hunks[1]!.rows[1]).toEqual({
    kind: "mod",
    old: { no: 41, text: "b" },
    new: { no: 41, text: "B" },
  });
});

test("'no newline at end of file' is an annotation, not a line", () => {
  const { hunks } = splitDiff(["@@ -1 +1 @@", "-two", "\\ No newline at end of file", "+TWO"].join("\n"));

  expect(hunks[0]!.rows).toEqual([
    { kind: "mod", old: { no: 1, text: "two" }, new: { no: 1, text: "TWO" } },
  ]);
});

test("git's binary notice is reported as a flag with no rows", () => {
  expect(splitDiff("Binary files a/logo.png and b/logo.png differ")).toEqual({
    hunks: [],
    binary: true,
    truncated: false,
  });
});

// The cap has to hold inside one unbroken run too, not just between hunks.
test("an oversized diff is cut at the row cap and says so", () => {
  const adds = Array.from({ length: 50 }, (_, i) => `+line ${i}`);
  const { hunks, truncated } = splitDiff(["@@ -0,0 +1,50 @@", ...adds].join("\n"), 4);

  expect(truncated).toBe(true);
  expect(hunks[0]!.rows).toHaveLength(4);
});

test("a new file is all additions and its trailing newline adds no row", () => {
  expect(addedFileDiff("a\nb\n")).toEqual({
    hunks: [
      {
        header: "@@ -0,0 +1,2 @@",
        rows: [
          { kind: "add", old: null, new: { no: 1, text: "a" } },
          { kind: "add", old: null, new: { no: 2, text: "b" } },
        ],
      },
    ],
    binary: false,
    truncated: false,
  });
});

test("an empty new file has nothing to show", () => {
  expect(addedFileDiff("")).toEqual({ hunks: [], binary: false, truncated: false });
});

// ── against a real worktree ────────────────────────────────────────────────────────

// The agent is mid-flight: part of its work on this file is committed, part is not. One
// click has to show both, or the tab would contradict the summary above it.
test("fileDiff shows committed and uncommitted edits to one file together", async () => {
  const { id } = await seed((d) => {
    writeFileSync(join(d, "file.txt"), "one\nTWO\nthree\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "c1");
    writeFileSync(join(d, "file.txt"), "one\nTWO\nthree\nfour\n"); // not committed
  });

  const { hunks, binary, truncated } = await sup.fileDiff(id, "file.txt");

  expect({ binary, truncated }).toEqual({ binary: false, truncated: false });
  const rows = hunks.flatMap((h) => h.rows);
  expect(rows).toContainEqual({ kind: "mod", old: { no: 2, text: "two" }, new: { no: 2, text: "TWO" } });
  expect(rows).toContainEqual({ kind: "add", old: null, new: { no: 4, text: "four" } });
});

test("fileDiff of an untracked file is every line added", async () => {
  const { id } = await seed((d) => writeFileSync(join(d, "fresh.txt"), "x\ny\n"));

  const { hunks } = await sup.fileDiff(id, "fresh.txt");

  expect(hunks[0]!.rows).toEqual([
    { kind: "add", old: null, new: { no: 1, text: "x" } },
    { kind: "add", old: null, new: { no: 2, text: "y" } },
  ]);
});

test("fileDiff of a deleted file is every line removed", async () => {
  const { id } = await seed((d) => rmSync(join(d, "file.txt")));

  const rows = (await sup.fileDiff(id, "file.txt")).hunks.flatMap((h) => h.rows);

  expect(rows.map((r) => r.kind)).toEqual(["del", "del", "del"]);
  expect(rows[0]!.new).toBeNull();
});

// The path is round-tripped through the browser, so it is treated as untrusted input.
test("fileDiff refuses a path that escapes the worktree", async () => {
  const { id } = await seed(() => {});

  await expect(sup.fileDiff(id, "../../etc/passwd")).rejects.toThrow(/invalid path/i);
  await expect(sup.fileDiff(id, "/etc/passwd")).rejects.toThrow(/invalid path/i);
});

// Rename detection would list `file.txt => moved.txt`, a string that names no file the
// operator can open. Both halves must be paths a click can resolve.
test("a rename is listed as two openable paths", async () => {
  const { id } = await seed((d) => {
    git(d, "mv", "file.txt", "moved.txt");
    git(d, "commit", "-q", "-m", "move");
  });

  const paths = (await sup.finishInfo(id)).files.map((f) => f.path).sort();
  expect(paths).toEqual(["file.txt", "moved.txt"]);

  expect((await sup.fileDiff(id, "moved.txt")).hunks[0]!.rows.map((r) => r.kind)).toEqual([
    "add",
    "add",
    "add",
  ]);
  expect((await sup.fileDiff(id, "file.txt")).hunks[0]!.rows.map((r) => r.kind)).toEqual([
    "del",
    "del",
    "del",
  ]);
});

// In-place sessions have no worktree: the branch lives in the project repo and the fork
// point comes from `baseBranch`, not from the project's current branch. Same click, same
// answer — a diff against the wrong base here would show the whole file as new.
test("fileDiff works for an in-place session, against its base branch", async () => {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  await wt.createBranchHere(repo, "feature/s1");
  writeFileSync(join(repo, "file.txt"), "one\nTWO\nthree\n");
  const s = reg.createSession({
    projectId: g.id, name: "task one", task: "t",
    worktreePath: "", branch: "feature/s1", worktree: false, baseBranch: "dev",
  });

  const rows = (await sup.fileDiff(s.id, "file.txt")).hunks.flatMap((h) => h.rows);

  expect(rows).toContainEqual({ kind: "mod", old: { no: 2, text: "two" }, new: { no: 2, text: "TWO" } });
  expect(rows.filter((r) => r.kind === "add")).toEqual([]);
});
