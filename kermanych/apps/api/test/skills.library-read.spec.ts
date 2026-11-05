// kermanych/apps/api/test/skills.library-read.spec.ts
// How often one launch reads the skill library from the cloud. Every row carries its full
// text, so each read is egress the Free project pays for (docs/specs/2026-11-03-board-egress-and-lag.md).
// The seams the other skill specs replace are left in place here: what is counted is the
// real `listAiSkills` the default `readSkills` calls, one call per owner.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiAgentSkill, AiOwner, AiSkill, AiTrigger } from "@kermanych/cloud";
import { SkillsService } from "../src/skills/skills.service";

const { listAiSkills } = vi.hoisted(() => ({
  listAiSkills: vi.fn<(client: unknown, owner: AiOwner) => Promise<AiSkill[]>>(),
}));
vi.mock("@kermanych/cloud", async (orig) => ({ ...(await orig<object>()), listAiSkills }));

const P = "11111111-1111-4111-8111-111111111111";
const W = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const SCOPE = { projectId: P, workspaceId: W, userId: U };

const skill = (name: string, body: string): AiSkill => ({
  owner: { scope: "project", id: P }, id: name, name, description: "d", body, enabled: true, updatedAt: "t",
});
const trigger = (slug: string, skills: string[]): AiTrigger => ({
  owner: { scope: "project", id: P }, id: slug, slug, label: slug, enabled: true,
  source: "thinking", pattern: slug, pathGlobs: [],
  action: "prompt", instruction: "", agentId: "", skills,
  mode: "remind", repeat: "once",
});
const assigned: AiAgentSkill = { owner: { scope: "project", id: P }, agentId: "review", skillName: "house", position: 0 };

function service() {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readCustomDirs = async () => [];
  svc.readAssignments = async () => [assigned];
  svc.readTriggers = async () => [trigger("env-guard", ["house"]), trigger("pr-guard", ["pr-rules"])];
  return svc;
}

// The supervisor's order for one launch: ompSkills, ompTriggers, then the first prompt.
async function launch(svc: SkillsService, sessionId: string) {
  await svc.materialize(SCOPE, repo);
  await svc.materializeTriggers(SCOPE, sessionId, repo);
  return svc.assignedFor(SCOPE, "review", repo);
}

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-libread-repo-"));
  home = mkdtempSync(join(tmpdir(), "kmq-libread-home-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
  vi.useFakeTimers({ toFake: ["Date"] });
  listAiSkills.mockReset();
  listAiSkills.mockImplementation(async (_c, owner) =>
    owner.scope === "project" ? [skill("house", "HOUSE BODY"), skill("pr-rules", "PR BODY")] : [],
  );
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("one launch reads the library once: one listAiSkills call per owner", async () => {
  const svc = service();
  const { block } = await launch(svc, "s-1");
  expect(block).toContain("HOUSE BODY");
  expect(listAiSkills).toHaveBeenCalledTimes(3);
  expect(listAiSkills.mock.calls.map(([, o]) => o.scope).sort()).toEqual(["project", "user", "workspace"]);
});

test("a trigger firing or a PR turn soon after reuses the read; one past the window reads again", async () => {
  const svc = service();
  await launch(svc, "s-1");
  vi.advanceTimersByTime(10_000);
  expect((await svc.assignedForNames(SCOPE, ["pr-rules"], repo)).block).toContain("PR BODY");
  await svc.assignedFor(SCOPE, "review", repo);
  expect(listAiSkills).toHaveBeenCalledTimes(3);

  vi.advanceTimersByTime(30_000);
  await launch(svc, "s-2");
  expect(listAiSkills).toHaveBeenCalledTimes(6);
});

test("a failed read is not kept: the next caller reads again", async () => {
  const svc = service();
  listAiSkills.mockRejectedValueOnce(new Error("offline"));
  const { stale } = await svc.materialize(SCOPE, repo);
  expect(stale).toBe(true);
  const { block } = await svc.assignedFor(SCOPE, "review", repo);
  expect(block).toContain("HOUSE BODY");
  expect(listAiSkills).toHaveBeenCalledTimes(6);
});

test("the editor's view always reads fresh, and the next launch of that project does too", async () => {
  const svc = service();
  await launch(svc, "s-1");
  await svc.view(P, repo);
  expect(listAiSkills).toHaveBeenCalledTimes(4); // the editor reads the project's own rows only
  await launch(svc, "s-2");
  expect(listAiSkills).toHaveBeenCalledTimes(7);
});
