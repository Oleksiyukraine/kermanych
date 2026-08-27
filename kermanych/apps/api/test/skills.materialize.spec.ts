import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS } from "@kermanych/core";
import type { ProjectSkill } from "@kermanych/cloud";
import { REPO_SKILL_DIRS, repoSkillNames, resolveSkills, SkillsService } from "../src/skills/skills.service";

const row = (p: Partial<ProjectSkill> & { name: string }): ProjectSkill => ({
  projectId: "p1", description: "d", body: "b", enabled: true, updatedAt: "t", ...p,
});

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-skill-repo-"));
  home = mkdtempSync(join(tmpdir(), "kmq-skill-home-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
});
afterEach(() => {
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a project row overrides a same-named default", () => {
  const name = DEFAULT_SKILLS[0]!.name;
  const out = resolveSkills([row({ name, description: "mine", body: "my body" })]);
  const hit = out.find((s) => s.def.name === name)!;
  expect(hit.source).toBe("project");
  expect(hit.def.body).toBe("my body");
});

test("enabled:false removes a default, and a new name is added", () => {
  const name = DEFAULT_SKILLS[0]!.name;
  const out = resolveSkills([row({ name, enabled: false }), row({ name: "extra" })]);
  expect(out.some((s) => s.def.name === name)).toBe(false);
  expect(out.find((s) => s.def.name === "extra")?.source).toBe("project");
});

test("invalid rows never reach the filesystem", () => {
  const out = resolveSkills([row({ name: "ok-one" }), row({ name: "ok-two", description: "   " })]);
  expect(out.map((s) => s.def.name)).toContain("ok-one");
  expect(out.map((s) => s.def.name)).not.toContain("ok-two");
});

test("every repo skill location shadows a library skill of the same name", async () => {
  for (const dir of REPO_SKILL_DIRS) {
    const fresh = mkdtempSync(join(tmpdir(), "kmq-skill-scan-"));
    mkdirSync(join(fresh, dir, "kermanych-session"), { recursive: true });
    writeFileSync(join(fresh, dir, "kermanych-session", "SKILL.md"), "---\nname: kermanych-session\n---\n");
    const found = await repoSkillNames(fresh);
    expect(found.get("kermanych-session")).toBe(join(fresh, dir, "kermanych-session", "SKILL.md"));
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("materialize writes the library, the overlay, and skips a repo-shadowed skill", async () => {
  mkdirSync(join(repo, ".claude/skills/kermanych-session"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/kermanych-session/SKILL.md"), "---\nname: kermanych-session\n---\n");
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  // The stub stands in for the cloud read: no network in unit tests.
  svc.readRows = async () => [row({ name: "extra", description: "e", body: "eb" })];

  const { configPath, view } = await svc.materialize("p1", repo);

  const dir = join(home, "skills", "p1");
  expect(readdirSync(dir).sort()).toEqual(["extra", "kermanych-pull-request"]);
  expect(readFileSync(join(dir, "extra", "SKILL.md"), "utf8")).toContain('description: "e"');
  expect(readFileSync(configPath, "utf8")).toBe(`skills:\n  customDirectories:\n    - ${dir}\n`);
  expect(view.find((v) => v.name === "kermanych-session")?.shadowedByRepo).toBe(
    join(repo, ".claude/skills/kermanych-session/SKILL.md"),
  );
  expect(view.find((v) => v.name === "extra")).toMatchObject({ source: "project" });
});

test("a removed skill is pruned on the next materialize", async () => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readRows = async () => [row({ name: "temporary" })];
  await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "temporary"))).toBe(true);
  svc.readRows = async () => [];
  await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "temporary"))).toBe(false);
});

test("an unreachable cloud keeps the last materialised library", async () => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readRows = async () => [row({ name: "cached" })];
  await svc.materialize("p1", repo);
  svc.readRows = async () => {
    throw new Error("offline");
  };
  const { configPath } = await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "cached"))).toBe(true);
  expect(existsSync(configPath)).toBe(true);
});

test("an unbound project (no repo path) scans nothing instead of the api's own cwd", async () => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readRows = async () => [];
  const view = await svc.view("p1", "");
  expect(view.every((v) => v.shadowedByRepo === undefined)).toBe(true);
});
