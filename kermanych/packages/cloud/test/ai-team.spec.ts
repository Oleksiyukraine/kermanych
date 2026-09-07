import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, test } from "vitest";
import { setAgentSkills, toAgentSkill } from "../src/agent-skills";
import { deleteProjectAgent, toProjectAgent } from "../src/project-agents";
import { listTriggers, setTriggerSkills, toTrigger } from "../src/triggers";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// Same shape as the fake in skills.spec.ts, plus `not` — the filter the replace-all writers
// use to spare the rows that are staying.
function fakeClient(...results: Result[]) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const result = results[queries.length - 1] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (v: Result) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "in", "not", "order", "single"]) {
        builder[op] = (...args: unknown[]) => {
          q.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

test("an assignment row maps to camelCase", () => {
  expect(toAgentSkill({ project_id: "p1", agent_id: "review", skill_name: "how-we-review", position: 2 })).toEqual({
    projectId: "p1", agentId: "review", skillName: "how-we-review", position: 2,
  });
});

test("a prompt trigger row maps: an absent glob list, a null agent and no sequence all normalise", () => {
  expect(
    toTrigger({
      project_id: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
      source: "thinking", pattern: "нову env|new env var", path_globs: null,
      action: "prompt", instruction: "Спитай, куди її прописати.", agent_id: null,
      mode: "remind", repeat: "once",
    }),
  ).toEqual({
    projectId: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
    source: "thinking", pattern: "нову env|new env var", pathGlobs: [],
    action: "prompt", instruction: "Спитай, куди її прописати.", agentId: "", skills: [],
    mode: "remind", repeat: "once",
  });
});

test("a tool-scoped trigger keeps its path globs and the sequence it was handed", () => {
  const t = toTrigger(
    {
      project_id: "p1", id: "wf", label: "Workflow", enabled: false, source: "tool",
      pattern: "set-env-vars", path_globs: [".github/workflows/*.yml"],
      action: "prompt", instruction: "", agent_id: null,
      mode: "interrupt", repeat: "after-gap",
    },
    ["how-we-add-env", "opening-a-pr"],
  );
  expect(t.pathGlobs).toEqual([".github/workflows/*.yml"]);
  expect(t.enabled).toBe(false);
  expect(t.skills).toEqual(["how-we-add-env", "opening-a-pr"]);
});

test("an agent trigger carries its agent id and no skills", () => {
  const t = toTrigger({
    project_id: "p1", id: "review-now", label: "Перевір", enabled: true, source: "operator",
    pattern: "перевір", path_globs: null, action: "agent", instruction: "", agent_id: "review",
    mode: "interrupt", repeat: "after-gap",
  });
  expect(t.agentId).toBe("review");
  expect(t.skills).toEqual([]);
});

describe("listTriggers", () => {
  const promptRow = {
    project_id: "p1", id: "env-guard", label: "env", enabled: true, source: "thinking" as const,
    pattern: "env", path_globs: null, action: "prompt" as const, instruction: "Спитай.",
    agent_id: null, mode: "remind" as const, repeat: "once" as const,
  };

  // The sequence is what makes a trigger able to deliver more than one skill, and the child
  // table's `position` is the only thing that says in which order — so the join must carry
  // the query's ordering through untouched.
  it("joins the ordered sequence onto its trigger and keeps two projects apart", async () => {
    const { client, queries } = fakeClient(
      { data: [promptRow, { ...promptRow, project_id: "p2" }], error: null },
      {
        data: [
          { project_id: "p1", trigger_id: "env-guard", skill_name: "how-we-add-env", position: 0 },
          { project_id: "p1", trigger_id: "env-guard", skill_name: "opening-a-pr", position: 1 },
          { project_id: "p2", trigger_id: "env-guard", skill_name: "how-we-review", position: 0 },
        ],
        error: null,
      },
    );

    const triggers = await listTriggers(client, ["p1", "p2"]);

    expect(triggers.map((t) => t.skills)).toEqual([
      ["how-we-add-env", "opening-a-pr"],
      ["how-we-review"],
    ]);
    expect(queries[1]!.table).toBe("project_trigger_skills");
    expect(queries[1]!.ops).toEqual([
      ["select", "project_id, trigger_id, skill_name, position"],
      ["in", "project_id", ["p1", "p2"]],
      ["order", "trigger_id", { ascending: true }],
      ["order", "position", { ascending: true }],
      ["order", "skill_name", { ascending: true }],
    ]);
  });

  it("leaves a trigger with no rows in the child table on an empty sequence", async () => {
    const { client } = fakeClient({ data: [promptRow], error: null }, { data: [], error: null });
    expect((await listTriggers(client, ["p1"]))[0]!.skills).toEqual([]);
  });

  it("surfaces a failure of the second query, not just the first", async () => {
    const { client } = fakeClient(
      { data: [promptRow], error: null },
      { data: null, error: { message: "permission denied for table project_trigger_skills" } },
    );
    await expect(listTriggers(client, ["p1"])).rejects.toThrow(/permission denied/);
  });
});

describe("setTriggerSkills", () => {
  it("spares the surviving names, then writes the order as `position`", async () => {
    const { client, queries } = fakeClient({ data: null, error: null }, { data: null, error: null });

    await setTriggerSkills(client, "p1", "env-guard", ["opening-a-pr", "how-we-add-env"]);

    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "project_id", "p1"],
      ["eq", "trigger_id", "env-guard"],
      ["not", "skill_name", "in", "(opening-a-pr,how-we-add-env)"],
    ]);
    expect(queries[1]!.ops).toEqual([
      [
        "upsert",
        [
          { project_id: "p1", trigger_id: "env-guard", skill_name: "opening-a-pr", position: 0 },
          { project_id: "p1", trigger_id: "env-guard", skill_name: "how-we-add-env", position: 1 },
        ],
        { onConflict: "project_id,trigger_id,skill_name" },
      ],
    ]);
  });

  // An empty sequence is a legitimate state — an instruction with no skills — and an
  // unfiltered delete is what clears it. A second, empty upsert would be a postgrest error.
  it("clears the sequence with a single unfiltered delete", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });

    await setTriggerSkills(client, "p1", "env-guard", []);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.ops.map((op) => op[0])).toEqual(["delete", "eq", "eq"]);
  });

  it("throws when the delete is rejected, before anything is written", async () => {
    const { client, queries } = fakeClient({ data: null, error: { message: "row-level security" } });
    await expect(setTriggerSkills(client, "p1", "env-guard", ["a"])).rejects.toThrow(/row-level security/);
    expect(queries).toHaveLength(1);
  });
});

describe("setAgentSkills", () => {
  it("replaces an agent's sequence on its own table and key", async () => {
    const { client, queries } = fakeClient({ data: null, error: null }, { data: null, error: null });

    await setAgentSkills(client, "p1", "review", ["how-we-review"]);

    expect(queries[0]!.table).toBe("project_agent_skills");
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "project_id", "p1"],
      ["eq", "agent_id", "review"],
      ["not", "skill_name", "in", "(how-we-review)"],
    ]);
    expect(queries[1]!.ops).toEqual([
      [
        "upsert",
        [{ project_id: "p1", agent_id: "review", skill_name: "how-we-review", position: 0 }],
        { onConflict: "project_id,agent_id,skill_name" },
      ],
    ]);
  });
});

test("an instruction override maps to camelCase and omits a null author", () => {
  const a = toProjectAgent({
    project_id: "p1",
    agent_id: "review",
    instruction: "Дивись лише на {{diff}}.",
    updated_at: "2026-09-07T10:00:00Z",
    updated_by: null,
  });
  expect(a).toEqual({
    projectId: "p1",
    agentId: "review",
    instruction: "Дивись лише на {{diff}}.",
    updatedAt: "2026-09-07T10:00:00Z",
  });
  // toEqual treats `{ updatedBy: undefined }` as equal to an absent key, so the omission
  // itself — what keeps a mapped override free of null noise in Vue's reactivity — needs
  // its own assertion.
  expect("updatedBy" in a).toBe(false);
});

test("an instruction override keeps a present author and its whitespace", () => {
  const a = toProjectAgent({
    project_id: "p1",
    agent_id: "review",
    instruction: "  веди список\n",
    updated_at: "2026-09-07T10:00:00Z",
    updated_by: "u1",
  });
  expect(a.updatedBy).toBe("u1");
  expect(a.instruction).toBe("  веди список\n");
});

describe("deleteProjectAgent", () => {
  it("deletes by the composite key and asks for the removed rows back", async () => {
    const { client, queries } = fakeClient({
      data: [
        {
          project_id: "p1",
          agent_id: "review",
          instruction: "x",
          updated_at: "2026-09-07T10:00:00Z",
          updated_by: "u1",
        },
      ],
      error: null,
    });

    await deleteProjectAgent(client, "p1", "review");

    expect(queries[0]!.table).toBe("project_agents");
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "project_id", "p1"],
      ["eq", "agent_id", "review"],
      ["select", "project_id, agent_id, instruction, updated_at, updated_by"],
    ]);
  });

  // The whole point of the `.select()`: a member's delete is filtered out by the owner-only
  // USING clause and comes back `{ data: [], error: null }`. Resolving there would let the
  // pane claim the agent is back on its default while the override still stands.
  it("throws when no row came back, naming the agent", async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(deleteProjectAgent(client, "p1", "review")).rejects.toThrow(
      /agent "review" was not reset/,
    );
  });
});
