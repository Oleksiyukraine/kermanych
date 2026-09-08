import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS } from "@kermanych/core";
import type { AiAgent, AiAgentSkill, AiSkill } from "@kermanych/cloud";
import { SkillsService } from "../src/skills/skills.service";

const P = "11111111-1111-4111-8111-111111111111";
const assign = (skillName: string, position = 0): AiAgentSkill =>
  ({ owner: { scope: "project", id: P }, agentId: "review", skillName, position });
const row = (p: Partial<AiSkill> & { name: string }): AiSkill =>
  ({ owner: { scope: "project", id: P }, id: p.name, description: "d", body: "b", enabled: true, updatedAt: "t", ...p });

function service(assignments: AiAgentSkill[], library: AiSkill[]): SkillsService {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readAssignments = async () => assignments;
  svc.readSkills = async () => library;
  return svc;
}

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-assign-repo-"));
  home = mkdtempSync(join(tmpdir(), "kmq-assign-home-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
});
afterEach(() => {
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("order follows position, then name", async () => {
  const svc = service(
    [assign("b-skill", 1), assign("a-skill", 1), assign("first", 0)],
    [row({ name: "a-skill", body: "A" }), row({ name: "b-skill", body: "B" }), row({ name: "first", body: "F" })],
  );
  const { block } = await svc.assignedFor({ projectId: P }, "review", repo);
  expect(block.indexOf("### first")).toBeLessThan(block.indexOf("### a-skill"));
  expect(block.indexOf("### a-skill")).toBeLessThan(block.indexOf("### b-skill"));
});

test("a Kermanych default is assignable with no cloud row, and its own body is used", async () => {
  const def = DEFAULT_SKILLS[0]!;
  const svc = service([assign(def.name)], []);
  const { block, view, missing } = await svc.assignedFor({ projectId: P }, "review", repo);
  expect(missing).toEqual([]);
  expect(block).toContain(def.body.split("\n")[0]!);
  expect(view[0]).toMatchObject({ name: def.name, source: "default" });
});

test("a project row overriding that name supplies the body instead", async () => {
  const def = DEFAULT_SKILLS[0]!;
  const svc = service([assign(def.name)], [row({ name: def.name, body: "PROJECT BODY" })]);
  const { block, view } = await svc.assignedFor({ projectId: P }, "review", repo);
  expect(block).toContain("PROJECT BODY");
  expect(view[0]).toMatchObject({ source: "project" });
});

test("a repository-defined name wins, and the view says where from", async () => {
  mkdirSync(join(repo, ".claude/skills/how-we-review"), { recursive: true });
  writeFileSync(
    join(repo, ".claude/skills/how-we-review/SKILL.md"),
    "---\nname: how-we-review\ndescription: repo\n---\nREPO BODY\n",
  );
  const svc = service([assign("how-we-review")], [row({ name: "how-we-review", body: "CLOUD BODY" })]);
  const { block, view } = await svc.assignedFor({ projectId: P }, "review", repo);
  expect(block).toContain("REPO BODY");
  expect(block).not.toContain("CLOUD BODY");
  expect(view[0]?.shadowedByRepo).toBe(join(repo, ".claude/skills/how-we-review/SKILL.md"));
});

test("a name that resolves to nothing is reported, not silently dropped", async () => {
  const svc = service([assign("deleted-skill")], []);
  const { block, missing } = await svc.assignedFor({ projectId: P }, "review", repo);
  expect(missing).toEqual(["deleted-skill"]);
  expect(block).toBe("");
});

test("an agent with no assignments gets no block, and an unknown id does not throw", async () => {
  const svc = service([assign("a-skill")], [row({ name: "a-skill" })]);
  expect((await svc.assignedFor({ projectId: P }, "pull-request", repo)).block).toBe("");
  expect((await svc.assignedFor({ projectId: P }, "not-an-agent", repo)).block).toBe("");
});

test("an unreachable cloud degrades to no block instead of failing the launch", async () => {
  const svc = service([], []);
  svc.readAssignments = async () => { throw new Error("offline"); };
  await expect(svc.assignedFor({ projectId: P }, "review", repo)).resolves.toEqual({ block: "", view: [], missing: [] });
});

// ---- instructionFor -------------------------------------------------------------------
// The per-project instruction, which the four launch sites render instead of the compile-time
// default. Validated on the way OUT as well as in the editor: a row outlives the template it
// was written against.

const override = (instruction: string, agentId = "review"): AiAgent =>
  ({ owner: { scope: "project", id: P }, id: agentId, agentId, instruction, updatedAt: "t" });

test("a project's template is returned once it fills every hole the agent declares", async () => {
  const svc = service([], []);
  svc.readAgents = async () => [
    override("Дивись {{task}} на {{base}}…{{branch}}: {{diff}}"),
    override("не для цього агента", "promote"),
  ];
  await expect(svc.instructionFor({ projectId: P }, "review")).resolves.toBe("Дивись {{task}} на {{base}}…{{branch}}: {{diff}}");
});

test("a template that no longer matches the agent's holes is dropped, not delivered", async () => {
  // Both directions of stale: a hole the agent still fills but the text no longer uses (the
  // agent would run with no diff and never say so), and one the agent cannot fill at all
  // (renderInstruction would throw mid-session).
  const svc = service([], []);
  svc.readAgents = async () => [override("Подивись {{task}} на {{base}} у {{branch}}.")];
  await expect(svc.instructionFor({ projectId: P }, "review")).resolves.toBeUndefined();

  svc.readAgents = async () => [override("{{task}} {{base}} {{branch}} {{diff}} {{whatever}}")];
  await expect(svc.instructionFor({ projectId: P }, "review")).resolves.toBeUndefined();
});

test("no row, a blank row, an unknown agent and an unreachable cloud all mean the default", async () => {
  // Every one of these is "render the compile-time text": the method has no way to fail that
  // could cost an agent its run.
  const svc = service([], []);
  svc.readAgents = async () => [];
  await expect(svc.instructionFor({ projectId: P }, "review")).resolves.toBeUndefined();

  svc.readAgents = async () => [override("   ")];
  await expect(svc.instructionFor({ projectId: P }, "review")).resolves.toBeUndefined();

  svc.readAgents = async () => [override("що завгодно", "not-an-agent")];
  await expect(svc.instructionFor({ projectId: P }, "not-an-agent")).resolves.toBeUndefined();

  svc.readAgents = async () => { throw new Error("offline"); };
  await expect(svc.instructionFor({ projectId: P }, "review")).resolves.toBeUndefined();
  // And an id that is not a project throws for every other read on this service; here it is
  // the same degradation, because a launch must not die on it.
  await expect(svc.instructionFor({ projectId: "../evil" }, "review")).resolves.toBeUndefined();
});
