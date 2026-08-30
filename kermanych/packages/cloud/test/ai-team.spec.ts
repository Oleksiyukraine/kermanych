import { expect, test } from "vitest";
import { toAgentSkill } from "../src/agent-skills";
import { toTrigger } from "../src/triggers";

test("an assignment row maps to camelCase", () => {
  expect(toAgentSkill({ project_id: "p1", agent_id: "review", skill_name: "how-we-review", position: 2 })).toEqual({
    projectId: "p1", agentId: "review", skillName: "how-we-review", position: 2,
  });
});

test("a trigger row maps, and an absent glob list becomes an empty array", () => {
  expect(
    toTrigger({
      project_id: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
      source: "thinking", pattern: "нову env|new env var", path_globs: null,
      action: "skill", target: "how-we-add-env", mode: "remind", repeat: "once",
    }),
  ).toEqual({
    projectId: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
    source: "thinking", pattern: "нову env|new env var", pathGlobs: [],
    action: "skill", target: "how-we-add-env", mode: "remind", repeat: "once",
  });
});

test("a tool-scoped trigger keeps its path globs", () => {
  const t = toTrigger({
    project_id: "p1", id: "wf", label: "Workflow", enabled: false, source: "tool",
    pattern: "set-env-vars", path_globs: [".github/workflows/*.yml"],
    action: "skill", target: "how-we-add-env", mode: "interrupt", repeat: "after-gap",
  });
  expect(t.pathGlobs).toEqual([".github/workflows/*.yml"]);
  expect(t.enabled).toBe(false);
});
