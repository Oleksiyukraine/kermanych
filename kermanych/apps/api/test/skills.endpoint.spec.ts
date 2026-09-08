import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { SkillsController } from "../src/http/skills.controller";
import type { SkillsService } from "../src/skills/skills.service";
import type { RegistryService } from "../src/registry/registry.service";

test("returns the resolved view and the repository's own names for a bound project", async () => {
  const repo = mkdtempSync(join(tmpdir(), "kmq-skill-ep-"));
  mkdirSync(join(repo, ".omp/skills/mine"), { recursive: true });
  writeFileSync(join(repo, ".omp/skills/mine/SKILL.md"), "---\nname: mine\n---\n");
  const path = join(repo, ".omp/skills/mine/SKILL.md");
  const registry = { listProjects: () => [{ id: "p1", localRepoPath: repo }] } as unknown as RegistryService;
  const skills = {
    view: async () => ({
      view: [{ name: "mine", description: "d", source: "project" as const, shadowedByRepo: path }],
      // The scan is NOT filtered by the library: `repo-only` has no row and no default, so
      // it appears here and nowhere else. The assignment board needs it to tell an
      // assignment to a deleted skill from one the repository still provides.
      repo: { mine: path, "repo-only": join(repo, ".omp/skills/repo-only/SKILL.md") },
    }),
  } as unknown as SkillsService;
  const out = await new SkillsController(skills, registry).list("p1");
  expect(out.view[0]).toMatchObject({ name: "mine", shadowedByRepo: path });
  expect(Object.keys(out.repo).sort()).toEqual(["mine", "repo-only"]);
  rmSync(repo, { recursive: true, force: true });
});

test("an unknown project is a 400, not a crash", async () => {
  const registry = { listProjects: () => [] } as unknown as RegistryService;
  const skills = { view: async () => ({ view: [], repo: {} }) } as unknown as SkillsService;
  await expect(new SkillsController(skills, registry).list("nope")).rejects.toBeInstanceOf(BadRequestException);
});

// `view` REJECTS when the cloud read fails, and THROWS when the project id is not a legal
// path segment — deliberately, because a defaults-only list would read as "your skills are
// gone". The controller must turn that into a 503 the UI can show on its error line, not an
// unhandled rejection Nest logs as a 500 crash.
test("a failed library read is a 503 carrying its own message, not an unhandled rejection", async () => {
  const registry = { listProjects: () => [{ id: "p1", localRepoPath: "/repo" }] } as unknown as RegistryService;
  const skills = {
    view: async () => {
      throw new Error("Failed to fetch");
    },
  } as unknown as SkillsService;
  const call = new SkillsController(skills, registry).list("p1");
  await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
  await expect(call).rejects.toThrow(/Failed to fetch/);
});

// An unbound project has no checkout, so nothing can shadow the library: the controller
// still answers, handing the service the empty cwd rather than refusing the read.
test("an unbound project still resolves, with nothing to scan", async () => {
  const registry = { listProjects: () => [{ id: "p1", localRepoPath: "" }] } as unknown as RegistryService;
  const seen: string[] = [];
  const skills = {
    view: async (_id: string, cwd: string) => {
      seen.push(cwd);
      return { view: [{ name: "opening-a-pr", description: "d", source: "default" as const }], repo: {} };
    },
  } as unknown as SkillsService;
  const out = await new SkillsController(skills, registry).list("p1");
  expect(seen).toEqual([""]);
  expect(out.view).toEqual([{ name: "opening-a-pr", description: "d", source: "default" }]);
  // Nothing to scan means nothing shadowed and nothing repository-only: an assignment that
  // resolves to no library entry here really is dangling.
  expect(out.repo).toEqual({});
});
