// apps/api/test/file-tree.spec.ts
// The Файли tab lists a session's worktree one level at a time and opens a file read-only.
// Both halves take a worktree-relative path that round-tripped through the browser, so the
// path guard is the point of these tests; the read mirrors fileDiff's binary/oversize flags.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "../src/worktree/worktree.service";

const wt = new WorktreeService();
let dir: string;
const trash: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kermanych-tree-"));
  trash.push(dir);
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "alpha"));
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "readme.md"), "# readme\n");
  writeFileSync(join(dir, "app.txt"), "hello\nworld\n");
  // A NUL byte in the head is git's own binary test.
  writeFileSync(join(dir, "bin.dat"), Buffer.from([104, 0, 105]));
  // Over the 4 MiB read cap.
  writeFileSync(join(dir, "big.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 97));
});

afterEach(() => {
  for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("listTree lists one level, folders first, and hides .git", async () => {
  expect(await wt.listTree(dir, "")).toEqual([
    { name: "alpha", type: "dir" },
    { name: "src", type: "dir" },
    { name: "app.txt", type: "file" },
    { name: "big.txt", type: "file" },
    { name: "bin.dat", type: "file" },
    { name: "readme.md", type: "file" },
  ]);
});

test("listTree descends into a sub-directory", async () => {
  expect(await wt.listTree(dir, "src")).toEqual([{ name: "app.ts", type: "file" }]);
});

test("listTree refuses a path that escapes the worktree", async () => {
  await expect(wt.listTree(dir, "../..")).rejects.toThrow(/invalid path/i);
  await expect(wt.listTree(dir, "/etc")).rejects.toThrow(/invalid path/i);
});

test("readFileContent returns a text file's body", async () => {
  expect(await wt.readFileContent(dir, "app.txt")).toEqual({
    path: "app.txt",
    content: "hello\nworld\n",
    binary: false,
    truncated: false,
  });
});

test("readFileContent flags a binary file instead of returning its bytes", async () => {
  const r = await wt.readFileContent(dir, "bin.dat");
  expect(r.binary).toBe(true);
  expect(r.content).toBe("");
});

test("readFileContent flags an oversized file as truncated", async () => {
  const r = await wt.readFileContent(dir, "big.txt");
  expect(r.truncated).toBe(true);
  expect(r.content).toBe("");
});

test("readFileContent refuses a path that escapes the worktree or names no file", async () => {
  await expect(wt.readFileContent(dir, "../secret")).rejects.toThrow(/invalid path/i);
  await expect(wt.readFileContent(dir, "/etc/passwd")).rejects.toThrow(/invalid path/i);
  await expect(wt.readFileContent(dir, "")).rejects.toThrow(/invalid path/i);
});
