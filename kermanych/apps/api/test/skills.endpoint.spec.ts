import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { SkillsController } from "../src/http/skills.controller";
import type { SkillsService } from "../src/skills/skills.service";
import type { RegistryService } from "../src/registry/registry.service";

test("returns the resolved view for a bound project", async () => {
  const repo = mkdtempSync(join(tmpdir(), "kmq-skill-ep-"));
  mkdirSync(join(repo, ".omp/skills/mine"), { recursive: true });
  writeFileSync(join(repo, ".omp/skills/mine/SKILL.md"), "---\nname: mine\n---\n");
  const registry = { listProjects: () => [{ id: "p1", localRepoPath: repo }] } as unknown as RegistryService;
  const skills = {
    view: async (id: string, cwd: string) => [{ name: "mine", description: "d", source: "project" as const, shadowedByRepo: join(cwd, ".omp/skills/mine/SKILL.md") }],
  } as unknown as SkillsService;
  const out = await new SkillsController(skills, registry).list("p1");
  expect(out[0]).toMatchObject({ name: "mine", shadowedByRepo: join(repo, ".omp/skills/mine/SKILL.md") });
  rmSync(repo, { recursive: true, force: true });
});

test("an unknown project is a 400, not a crash", async () => {
  const registry = { listProjects: () => [] } as unknown as RegistryService;
  const skills = { view: async () => [] } as unknown as SkillsService;
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
      return [{ name: "opening-a-pr", description: "d", source: "default" as const }];
    },
  } as unknown as SkillsService;
  const out = await new SkillsController(skills, registry).list("p1");
  expect(seen).toEqual([""]);
  expect(out).toEqual([{ name: "opening-a-pr", description: "d", source: "default" }]);
});
