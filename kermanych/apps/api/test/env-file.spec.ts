import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "../src/worktree/worktree.service";
import { EnvFileService } from "../src/env/env-file.service";

const wt = new WorktreeService();
const svc = new EnvFileService(wt);
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-env-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), ".env\n");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("read reports entries and ignored flag", async () => {
  writeFileSync(join(repo, ".env"), "# c\nA=1\nGITHUB_TOKEN=ghp_x\n");
  const view = await svc.read(repo);
  expect(view.entries).toEqual([{ key: "A", value: "1" }, { key: "GITHUB_TOKEN", value: "ghp_x" }]);
  expect(view.ignored).toBe(true);
});

test("read of a missing .env returns empty entries", async () => {
  const view = await svc.read(repo);
  expect(view.entries).toEqual([]);
});

test("write updates in place, appends, removes, and preserves comments", async () => {
  writeFileSync(join(repo, ".env"), "# keep\nA=1\nB=2\n");
  await svc.write(repo, ".env", { set: { B: "9", C: "3" }, remove: ["A"] });
  expect(readFileSync(join(repo, ".env"), "utf8")).toBe("# keep\nB=9\nC=3\n");
});

test("write creates the file when absent", async () => {
  await svc.write(repo, ".env", { set: { GITHUB_TOKEN: "ghp_new" } });
  expect(readFileSync(join(repo, ".env"), "utf8")).toBe("GITHUB_TOKEN=ghp_new\n");
});

test("write rejects paths escaping the project dir", async () => {
  await expect(svc.write(repo, "../evil", { set: { X: "1" } })).rejects.toThrow(/escapes/i);
  await expect(svc.write(repo, "/etc/passwd", { set: { X: "1" } })).rejects.toThrow(/escapes/i);
});

test("read warns (ignored=false) when .env is not gitignored", async () => {
  writeFileSync(join(repo, ".gitignore"), "node_modules\n"); // no .env
  writeFileSync(join(repo, ".env"), "A=1\n");
  expect((await svc.read(repo)).ignored).toBe(false);
});
