import { afterEach, beforeEach, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS } from "@kermanych/core";
import type { ProjectSkill } from "@kermanych/cloud";
import { REPO_SKILL_DIRS, repoSkillNames, resolveSkills, SkillsService } from "../src/skills/skills.service";

const row = (p: Partial<ProjectSkill> & { name: string }): ProjectSkill => ({
  projectId: "p1", description: "d", body: "b", enabled: true, updatedAt: "t", ...p,
});

// The auth stub stands in for the cloud read: no network in unit tests. Every test then
// replaces `readRows`, which is the seam that read goes through. `readCustomDirs` is the
// second seam — it spawns a real `omp` to read the effective `skills.customDirectories` — and
// defaults to "the operator declared none" so these tests stay hermetic; the merge itself is
// pinned below and end-to-end in skills.e2e.spec.ts.
const service = () => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readCustomDirs = async () => [];
  return svc;
};

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

test("a row name that is not a valid skill name is dropped before any mkdir", async () => {
  const bad = ["../evil", "/abs/path", "Uppercase", "dot.name", ""];
  const defaults = DEFAULT_SKILLS.map((d) => d.name).sort();
  expect(resolveSkills(bad.map((name) => row({ name }))).map((s) => s.def.name).sort()).toEqual(defaults);

  const svc = service();
  svc.readRows = async () => bad.map((name) => row({ name }));
  await svc.materialize("p1", repo);
  expect(readdirSync(join(home, "skills", "p1")).sort()).toEqual(defaults);
  expect(existsSync(join(home, "skills", "evil"))).toBe(false);
  expect(existsSync(join(home, "skills", "p1", "Uppercase"))).toBe(false);
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

test("a symlinked repo skill directory shadows the library too", async () => {
  const shared = mkdtempSync(join(tmpdir(), "kmq-skill-shared-"));
  mkdirSync(join(shared, "kermanych-session"));
  writeFileSync(join(shared, "kermanych-session", "SKILL.md"), "---\nname: kermanych-session\n---\n");
  mkdirSync(join(repo, ".claude/skills"), { recursive: true });
  symlinkSync(join(shared, "kermanych-session"), join(repo, ".claude/skills/kermanych-session"), "dir");

  const link = join(repo, ".claude/skills/kermanych-session/SKILL.md");
  expect((await repoSkillNames(repo)).get("kermanych-session")).toBe(link);

  const svc = service();
  svc.readRows = async () => [];
  const { view } = await svc.materialize("p1", repo);
  expect(readdirSync(join(home, "skills", "p1"))).toEqual(["kermanych-pull-request"]);
  expect(view.find((v) => v.name === "kermanych-session")?.shadowedByRepo).toBe(link);
  rmSync(shared, { recursive: true, force: true });
});

test("a repo directory without SKILL.md shadows nothing", async () => {
  mkdirSync(join(repo, ".claude/skills/kermanych-session/assets"), { recursive: true });
  expect((await repoSkillNames(repo)).has("kermanych-session")).toBe(false);

  const svc = service();
  svc.readRows = async () => [];
  const { view } = await svc.materialize("p1", repo);
  expect(readdirSync(join(home, "skills", "p1")).sort()).toEqual(DEFAULT_SKILLS.map((d) => d.name).sort());
  expect(view.every((v) => v.shadowedByRepo === undefined)).toBe(true);
});

test("materialize writes the library, the overlay, and skips a repo-shadowed skill", async () => {
  mkdirSync(join(repo, ".claude/skills/kermanych-session"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/kermanych-session/SKILL.md"), "---\nname: kermanych-session\n---\n");
  const svc = service();
  svc.readRows = async () => [row({ name: "extra", description: "e", body: "eb" })];

  const { configPath, view, stale } = await svc.materialize("p1", repo);

  const dir = join(home, "skills", "p1");
  expect(stale).toBeUndefined();
  expect(readdirSync(dir).sort()).toEqual(["extra", "kermanych-pull-request"]);
  expect(readFileSync(join(dir, "extra", "SKILL.md"), "utf8")).toContain('description: "e"');
  // `ttsr.enabled: true` rides along with every overlay: the same launch carries the session's
  // trigger package via `-e`, and an operator with TTSR off would get rules that never fire.
  expect(readFileSync(configPath!, "utf8")).toBe(
    `skills:\n  customDirectories:\n    - ${JSON.stringify(dir)}\nttsr:\n  enabled: true\n`,
  );
  expect(view.find((v) => v.name === "kermanych-session")?.shadowedByRepo).toBe(
    join(repo, ".claude/skills/kermanych-session/SKILL.md"),
  );
  expect(view.find((v) => v.name === "extra")).toMatchObject({ source: "project" });
});

test("a removed skill is pruned on the next materialize", async () => {
  const svc = service();
  svc.readRows = async () => [row({ name: "temporary" })];
  await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "temporary"))).toBe(true);
  svc.readRows = async () => [];
  await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "temporary"))).toBe(false);
});

test("a skill that becomes repo-shadowed is pruned on the next materialize", async () => {
  const svc = service();
  svc.readRows = async () => [];
  await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "kermanych-session"))).toBe(true);

  mkdirSync(join(repo, ".omp/skills/kermanych-session"), { recursive: true });
  writeFileSync(join(repo, ".omp/skills/kermanych-session/SKILL.md"), "---\nname: kermanych-session\n---\n");
  await svc.materialize("p1", repo);
  expect(readdirSync(join(home, "skills", "p1"))).toEqual(["kermanych-pull-request"]);
});

test("an unreachable cloud keeps the last materialised library and reports it as stale", async () => {
  const svc = service();
  svc.readRows = async () => [row({ name: "cached" })];
  await svc.materialize("p1", repo);
  svc.readRows = async () => {
    throw new Error("offline");
  };
  const { configPath, stale } = await svc.materialize("p1", repo);
  expect(existsSync(join(home, "skills", "p1", "cached"))).toBe(true);
  expect(existsSync(configPath!)).toBe(true);
  expect(stale).toBe(true);
});

test("a first-ever materialise with no cloud still lands Kermanych's own defaults", async () => {
  const svc = service();
  svc.readRows = async () => {
    throw new Error("offline");
  };
  // DEFAULT_SKILLS are compile-time constants: no cloud, no network, no sign-in. Suppressing
  // them because the cloud was unreachable would hand omp an EMPTY directory — the state of
  // every signed-out or offline launch on a fresh install.
  const { configPath, stale } = await svc.materialize("p1", repo);
  expect(stale).toBe(true);
  expect(readdirSync(join(home, "skills", "p1")).sort()).toEqual(DEFAULT_SKILLS.map((d) => d.name).sort());
  expect(existsSync(configPath!)).toBe(true);
});

test("a cloud failure writes nothing over a richer cached library", async () => {
  const overridden = DEFAULT_SKILLS[0]!.name;
  const svc = service();
  svc.readRows = async () => [
    row({ name: "cached", description: "cached desc" }),
    row({ name: overridden, description: "the project's own take", body: "mine" }),
  ];
  await svc.materialize("p1", repo);

  svc.readRows = async () => {
    throw new Error("offline");
  };
  await svc.materialize("p1", repo);
  const dir = join(home, "skills", "p1");
  // The project's skills survive (no prune) AND the default of the same name does not
  // overwrite the project's version.
  expect(existsSync(join(dir, "cached", "SKILL.md"))).toBe(true);
  expect(readFileSync(join(dir, overridden, "SKILL.md"), "utf8")).toContain("the project's own take");
});

test("the overlay EXTENDS the directories omp already resolves, Kermanych's last", async () => {
  const dir = join(home, "skills", "p1");
  const svc = service();
  svc.readRows = async () => [];
  // Duplicates collapse, and Kermanych's own directory goes last: among custom directories the
  // first same-named skill wins, so appending preserves every other layer's precedence.
  svc.readCustomDirs = async () => ["/tmp/op # one", dir, "/tmp/two: b"];

  const { configPath } = await svc.materialize("p1", repo);
  expect(readFileSync(configPath!, "utf8")).toBe(
    `skills:\n  customDirectories:\n    - "/tmp/op # one"\n    - "/tmp/two: b"\n    - ${JSON.stringify(dir)}\n` +
      `ttsr:\n  enabled: true\n`,
  );
});

test("an unreadable customDirectories writes no overlay rather than replacing it", async () => {
  const svc = service();
  svc.readRows = async () => [row({ name: "extra" })];
  svc.readCustomDirs = async () => undefined;

  const { configPath, stale } = await svc.materialize("p1", repo);
  // Losing the library for one launch beats erasing the operator's own skill directories.
  expect(configPath).toBeUndefined();
  expect(stale).toBe(true);
  expect(existsSync(join(home, "skills", "p1.config.yml"))).toBe(false);
  // The library is still laid out, so the next launch that CAN read the config finds it warm.
  expect(existsSync(join(home, "skills", "p1", "extra", "SKILL.md"))).toBe(true);
});

test("view surfaces a cloud failure instead of presenting the defaults as the library", async () => {
  const svc = service();
  svc.readRows = async () => {
    throw new Error("offline");
  };
  await expect(svc.view("p1", repo)).rejects.toThrow("offline");
});

test("view writes nothing", async () => {
  const svc = service();
  svc.readRows = async () => [row({ name: "extra" })];
  const view = await svc.view("p1", repo);
  expect(view.some((v) => v.name === "extra")).toBe(true);
  expect(readdirSync(home)).toEqual([]);
});

test("a projectId that is not a valid skill name is refused before any path is joined", async () => {
  const svc = service();
  svc.readRows = async () => [];
  for (const bad of ["../evil", "p1\nskills:\n  customDirectories: []", "P1", ""]) {
    await expect(svc.materialize(bad, repo)).rejects.toThrow(/invalid project id/);
    await expect(svc.view(bad, repo)).rejects.toThrow(/invalid project id/);
  }
  expect(readdirSync(home)).toEqual([]);

  // A lowercase UUID — what the cloud actually hands out — passes.
  const { configPath } = await svc.materialize("0f9c4a1e-2b3d-4c5f-8a7b-6d5e4f3a2b1c", repo);
  expect(existsSync(configPath!)).toBe(true);
});

test("a filesystem failure degrades to a stale result instead of blocking the launch", async () => {
  mkdirSync(join(home, "skills"), { recursive: true });
  writeFileSync(join(home, "skills", "p1"), "a plain file where the library should be");
  const svc = service();
  svc.readRows = async () => [row({ name: "extra" })];

  const { configPath, view, stale } = await svc.materialize("p1", repo);
  expect(stale).toBe(true);
  expect(configPath).toBeUndefined();
  expect(view.some((v) => v.name === "extra")).toBe(true);
});

test.skipIf(process.getuid?.() === 0)("an unreadable repo skill directory fails closed, not open", async () => {
  const base = join(repo, ".claude/skills");
  mkdirSync(base, { recursive: true });
  chmodSync(base, 0o000);
  try {
    await expect(repoSkillNames(repo)).rejects.toThrow();
    // materialize must still not block the launch: it degrades and prunes nothing.
    const svc = service();
    svc.readRows = async () => [];
    const { stale } = await svc.materialize("p1", repo);
    expect(stale).toBe(true);
    expect(existsSync(join(home, "skills", "p1"))).toBe(true);
    expect(readdirSync(join(home, "skills", "p1"))).toEqual([]);
  } finally {
    chmodSync(base, 0o700);
  }
});

test("an unbound project (no repo path) scans nothing instead of the api's own cwd", async () => {
  mkdirSync(join(repo, ".claude/skills/kermanych-session"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/kermanych-session/SKILL.md"), "---\nname: kermanych-session\n---\n");
  expect((await repoSkillNames(repo)).size).toBe(1);
  expect((await repoSkillNames("")).size).toBe(0);
});
