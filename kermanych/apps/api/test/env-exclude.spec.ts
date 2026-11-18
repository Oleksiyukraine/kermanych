import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "../src/worktree/worktree.service";
import { EnvFileService } from "../src/env/env-file.service";

// A `.env` that receives GIT_TOKEN is kept out of the agent's commits through the repository's
// own info/exclude when git does not ignore it already
// (docs/specs/2026-11-18-first-run-and-project-wizard.md, decision 4).

const wt = new WorktreeService();
const svc = new EnvFileService(wt);
let repo: string;
const exclude = () => join(repo, ".git", "info", "exclude");
const excludeText = () => (existsSync(exclude()) ? readFileSync(exclude(), "utf8") : "");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-envx-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("GIT_TOKEN in an unignored .env adds it to info/exclude once", async () => {
  expect(await wt.isIgnored(repo, ".env")).toBe(false);
  const view = await svc.write(repo, ".env", { set: { GIT_TOKEN: "ghp_x" } });
  expect(view.ignored).toBe(true);
  expect(await wt.isIgnored(repo, ".env")).toBe(true);
  await svc.write(repo, ".env", { set: { GIT_TOKEN: "ghp_y" } });
  expect(excludeText().split("\n").filter((l) => l === "/.env")).toHaveLength(1);
});

test("nothing is added when .gitignore already ignores .env", async () => {
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  const before = excludeText();
  const view = await svc.write(repo, ".env", { set: { GIT_TOKEN: "ghp_x" } });
  expect(view.ignored).toBe(true);
  expect(excludeText()).toBe(before);
});

test("other keys leave info/exclude alone", async () => {
  const before = excludeText();
  const view = await svc.write(repo, ".env", { set: { API_URL: "http://x" } });
  expect(view.ignored).toBe(false);
  expect(excludeText()).toBe(before);
});

test("a missing info/ folder is created", async () => {
  rmSync(join(repo, ".git", "info"), { recursive: true, force: true });
  await svc.write(repo, ".env", { set: { GIT_TOKEN: "ghp_x" } });
  expect(excludeText()).toBe("/.env\n");
});

test("a project bound to a subfolder gets its repo-relative path", async () => {
  const sub = join(repo, "apps", "web");
  mkdirSync(sub, { recursive: true });
  writeFileSync(exclude(), "# local rules\n*.log");
  const view = await svc.write(sub, ".env", { set: { GIT_TOKEN: "ghp_x" } });
  expect(view.ignored).toBe(true);
  expect(excludeText()).toBe("# local rules\n*.log\n/apps/web/.env\n");
});

test("outside a git repository the file is written and nothing else", async () => {
  const plain = mkdtempSync(join(tmpdir(), "kmq-envx-plain-"));
  try {
    const view = await svc.write(plain, ".env", { set: { GIT_TOKEN: "ghp_x" } });
    expect(view.entries).toEqual([{ key: "GIT_TOKEN", value: "ghp_x" }]);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
