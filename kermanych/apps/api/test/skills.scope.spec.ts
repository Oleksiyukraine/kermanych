// kermanych/apps/api/test/skills.scope.spec.ts
// The multi-owner precedence a single-scope launch cannot exercise: the «ШІ-команда» tables
// carry rows at workspace, project and user scope, and every resolver on this path collapses
// them by the SAME order — user > project > workspace, then the code defaults. This file pins
// that order for the four things it decides: an agent's instruction, an agent's skill
// sequence, a skill's body by name, and the operator trigger union.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiAgent, AiAgentSkill, AiScope, AiSkill, AiTrigger } from "@kermanych/cloud";
import { SkillsService } from "../src/skills/skills.service";

// Every owner a full launch sees: a project checkout inside a workspace, opened by a signed-in
// user. Each fixture below places a row at one of these three scopes.
const S = { projectId: "p", workspaceId: "w", userId: "u" };
const ID: Record<AiScope, string> = { workspace: "w", project: "p", user: "u" };

const svc = (): SkillsService => {
  const s = new SkillsService({ cloudClient: () => ({}) } as never);
  s.readCustomDirs = async () => [];
  return s;
};

// review declares exactly {task, base, branch, diff}; a template is delivered only when it
// fills every hole and names no other, so each scope's text keeps those four and differs only
// by a leading tag.
const tmpl = (tag: string): string => `${tag} {{task}} {{base}} {{branch}} {{diff}}`;
const agent = (scope: AiScope, instruction: string, agentId = "review"): AiAgent =>
  ({ owner: { scope, id: ID[scope] }, id: `${scope}-${agentId}`, agentId, instruction, updatedAt: "t" });

const assign = (scope: AiScope, skillName: string, position: number): AiAgentSkill =>
  ({ owner: { scope, id: ID[scope] }, agentId: "review", skillName, position });

const skill = (scope: AiScope, name: string, body: string): AiSkill =>
  ({ owner: { scope, id: ID[scope] }, id: `${scope}-${name}`, name, description: "d", body, enabled: true, updatedAt: "t" });

const trig = (scope: AiScope, slug: string, label: string): AiTrigger =>
  ({
    owner: { scope, id: ID[scope] }, id: `${scope}-${slug}`, slug, label, enabled: true,
    source: "operator", pattern: "x", pathGlobs: [], action: "prompt", instruction: "", agentId: "",
    skills: [], mode: "remind", repeat: "once",
  });

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-scope-repo-"));
  home = mkdtempSync(join(tmpdir(), "kmq-scope-home-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
});
afterEach(() => {
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---- (a) agent instruction: most specific scope with a valid override wins ------------

test("a project instruction override wins over a workspace one, and a user override over both", async () => {
  const s = svc();
  s.readSkills = async () => [];

  // Only the workspace has one → it is used.
  s.readAgents = async () => [agent("workspace", tmpl("WS"))];
  await expect(s.instructionFor(S, "review")).resolves.toBe(tmpl("WS"));

  // The project overrides the workspace.
  s.readAgents = async () => [agent("workspace", tmpl("WS")), agent("project", tmpl("PROJ"))];
  await expect(s.instructionFor(S, "review")).resolves.toBe(tmpl("PROJ"));

  // The user overrides both.
  s.readAgents = async () => [
    agent("workspace", tmpl("WS")),
    agent("project", tmpl("PROJ")),
    agent("user", tmpl("USER")),
  ];
  await expect(s.instructionFor(S, "review")).resolves.toBe(tmpl("USER"));
});

// ---- (b) agent skill sequence: taken WHOLE from the most specific scope, never merged ----

test("the most specific scope's whole sequence is used, and a less specific one is not appended", async () => {
  const s = svc();
  s.readSkills = async () => [
    skill("workspace", "ws-a", "WS A"),
    skill("workspace", "ws-b", "WS B"),
    skill("project", "proj-x", "PROJ X"),
    skill("project", "proj-y", "PROJ Y"),
  ];

  // Both scopes define a sequence for review; the project's is taken whole and the
  // workspace's is NOT glued on after it.
  s.readAssignments = async () => [
    assign("workspace", "ws-a", 0),
    assign("workspace", "ws-b", 1),
    assign("project", "proj-x", 0),
    assign("project", "proj-y", 1),
  ];
  const chosen = await s.assignedFor(S, "review", repo);
  expect(chosen.view.map((v) => v.name)).toEqual(["proj-x", "proj-y"]);
  expect(chosen.block.indexOf("### proj-x")).toBeLessThan(chosen.block.indexOf("### proj-y"));
  expect(chosen.block).not.toContain("### ws-a");
  expect(chosen.block).not.toContain("### ws-b");

  // With only the workspace defining a sequence, that sequence is what runs.
  s.readAssignments = async () => [assign("workspace", "ws-a", 0), assign("workspace", "ws-b", 1)];
  const fallback = await s.assignedFor(S, "review", repo);
  expect(fallback.view.map((v) => v.name)).toEqual(["ws-a", "ws-b"]);
});

// ---- (c) skill body by name: repo > user > project > workspace > default ---------------

test("a name defined at every scope resolves to the user body, and the repository outranks even that", async () => {
  const s = svc();
  s.readSkills = async () => [
    skill("workspace", "dup", "WS BODY"),
    skill("project", "dup", "PROJ BODY"),
    skill("user", "dup", "USER BODY"),
  ];

  // No repository file for the name: the user's row is the most specific, so its body wins.
  const cloud = await s.assignedForNames(S, ["dup"], repo);
  expect(cloud.missing).toEqual([]);
  expect(cloud.block).toContain("USER BODY");
  expect(cloud.block).not.toContain("PROJ BODY");
  expect(cloud.block).not.toContain("WS BODY");
  expect(cloud.view[0]?.shadowedByRepo).toBeUndefined();

  // The repository's own file for the name outranks every cloud scope: its body is delivered
  // and the view says where from.
  mkdirSync(join(repo, ".omp/skills/dup"), { recursive: true });
  writeFileSync(join(repo, ".omp/skills/dup/SKILL.md"), "---\nname: dup\ndescription: d\n---\nREPO BODY\n");
  const shadowed = await s.assignedForNames(S, ["dup"], repo);
  expect(shadowed.block).toContain("REPO BODY");
  expect(shadowed.block).not.toContain("USER BODY");
  expect(shadowed.view[0]?.shadowedByRepo).toBe(join(repo, ".omp/skills/dup/SKILL.md"));
});

// ---- (d) triggers: the UNION of every scope, deduped by slug with the most specific winning ----

test("operator triggers with different slugs across scopes all survive, sorted by slug", async () => {
  const s = svc();
  s.readTriggers = async () => [trig("workspace", "b-ws", "WS"), trig("project", "a-proj", "PROJ")];
  const out = await s.operatorTriggers(S);
  expect(out.map((t) => t.slug)).toEqual(["a-proj", "b-ws"]);
});

test("the same slug at two scopes collapses to the most specific one", async () => {
  const s = svc();
  s.readTriggers = async () => [trig("workspace", "same", "WS"), trig("project", "same", "PROJ")];
  const out = await s.operatorTriggers(S);
  expect(out).toHaveLength(1);
  expect(out[0]!.slug).toBe("same");
  // The project scope is more specific than the workspace, so its row is the one kept.
  expect(out[0]!.owner.scope).toBe("project");
  expect(out[0]!.label).toBe("PROJ");
});
