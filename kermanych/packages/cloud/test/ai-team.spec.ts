import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, test } from "vitest";
import { setAiAgentSkills, toAiAgentSkill } from "../src/agent-skills";
import { deleteAiAgent, toAiAgent } from "../src/ai-agents";
import { listAiTriggers, setAiTriggerSkills, toAiTrigger } from "../src/triggers";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// The owner axis is a nullable triad; a project-scoped fixture carries a uuid in `project_id`
// and NULL in the other two. These are the ids the mappers read back into `{ scope, id }`.
const P1 = "11111111-1111-1111-1111-111111111111";
const WS = "22222222-2222-2222-2222-222222222222";

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

test("an assignment row maps to camelCase and reads its owner off the triad", () => {
  expect(
    toAiAgentSkill({
      workspace_id: null, project_id: P1, user_id: null,
      agent_id: "review", skill_name: "how-we-review", position: 2,
    }),
  ).toEqual({
    owner: { scope: "project", id: P1 }, agentId: "review", skillName: "how-we-review", position: 2,
  });
});

// rowOwner picks whichever column of the triad is set — a workspace-owned row carries its id in
// `workspace_id` and reads back as a workspace owner, not the project default.
test("a workspace-owned row derives a workspace owner", () => {
  expect(
    toAiAgentSkill({
      workspace_id: WS, project_id: null, user_id: null,
      agent_id: "review", skill_name: "how-we-review", position: 0,
    }).owner,
  ).toEqual({ scope: "workspace", id: WS });
});

test("a prompt trigger row maps: an absent glob list, a null agent and no sequence all normalise", () => {
  expect(
    toAiTrigger({
      id: "t-env", workspace_id: null, project_id: P1, user_id: null,
      slug: "env-guard", label: "Нова env-змінна", enabled: true,
      source: "thinking", pattern: "нову env|new env var", path_globs: null,
      action: "prompt", instruction: "Спитай, куди її прописати.", agent_id: null,
      mode: "remind", repeat: "once",
    }),
  ).toEqual({
    id: "t-env", owner: { scope: "project", id: P1 }, slug: "env-guard", label: "Нова env-змінна", enabled: true,
    source: "thinking", pattern: "нову env|new env var", pathGlobs: [],
    action: "prompt", instruction: "Спитай, куди її прописати.", agentId: "", skills: [],
    mode: "remind", repeat: "once",
  });
});

// A workspace-owned trigger reads its owner off `workspace_id`, and the surrogate `id` and the
// slug are two distinct fields the mapper keeps apart.
test("a workspace-owned trigger maps its owner and keeps id and slug apart", () => {
  const t = toAiTrigger({
    id: "t-ws", workspace_id: WS, project_id: null, user_id: null,
    slug: "env-guard", label: "env", enabled: true, source: "thinking",
    pattern: "env", path_globs: null, action: "prompt", instruction: "Спитай.", agent_id: null,
    mode: "remind", repeat: "once",
  });
  expect(t.owner).toEqual({ scope: "workspace", id: WS });
  expect(t.id).toBe("t-ws");
  expect(t.slug).toBe("env-guard");
});

test("a tool-scoped trigger keeps its path globs and the sequence it was handed", () => {
  const t = toAiTrigger(
    {
      id: "t-wf", workspace_id: null, project_id: P1, user_id: null,
      slug: "wf", label: "Workflow", enabled: false, source: "tool",
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
  const t = toAiTrigger({
    id: "t-review", workspace_id: null, project_id: P1, user_id: null,
    slug: "review-now", label: "Перевір", enabled: true, source: "operator",
    pattern: "перевір", path_globs: null, action: "agent", instruction: "", agent_id: "review",
    mode: "interrupt", repeat: "after-gap",
  });
  expect(t.agentId).toBe("review");
  expect(t.skills).toEqual([]);
});

describe("listAiTriggers", () => {
  const promptRow = {
    id: "t-env", workspace_id: null, project_id: P1, user_id: null,
    slug: "env-guard", label: "env", enabled: true, source: "thinking" as const,
    pattern: "env", path_globs: null, action: "prompt" as const, instruction: "Спитай.",
    agent_id: null, mode: "remind" as const, repeat: "once" as const,
  };

  // The sequence is what makes a trigger able to deliver more than one skill, and the child
  // table's `position` is the only thing that says in which order — so the join must carry
  // the query's ordering through untouched. The child hangs off the surrogate `id`, so the
  // join keys on that, not the slug.
  it("joins the ordered sequence onto its trigger and keeps two triggers apart", async () => {
    const { client, queries } = fakeClient(
      { data: [promptRow, { ...promptRow, id: "t-wf", slug: "wf" }], error: null },
      {
        data: [
          { trigger_id: "t-env", skill_name: "how-we-add-env", position: 0 },
          { trigger_id: "t-env", skill_name: "opening-a-pr", position: 1 },
          { trigger_id: "t-wf", skill_name: "how-we-review", position: 0 },
        ],
        error: null,
      },
    );

    const triggers = await listAiTriggers(client, { scope: "project", id: P1 });

    expect(triggers.map((t) => t.skills)).toEqual([
      ["how-we-add-env", "opening-a-pr"],
      ["how-we-review"],
    ]);
    expect(queries[1]!.table).toBe("ai_trigger_skills");
    expect(queries[1]!.ops).toEqual([
      ["select", "trigger_id, skill_name, position"],
      ["in", "trigger_id", ["t-env", "t-wf"]],
      ["order", "trigger_id", { ascending: true }],
      ["order", "position", { ascending: true }],
      ["order", "skill_name", { ascending: true }],
    ]);
  });

  it("leaves a trigger with no rows in the child table on an empty sequence", async () => {
    const { client } = fakeClient({ data: [promptRow], error: null }, { data: [], error: null });
    expect((await listAiTriggers(client, { scope: "project", id: P1 }))[0]!.skills).toEqual([]);
  });

  it("surfaces a failure of the second query, not just the first", async () => {
    const { client } = fakeClient(
      { data: [promptRow], error: null },
      { data: null, error: { message: "permission denied for table ai_trigger_skills" } },
    );
    await expect(listAiTriggers(client, { scope: "project", id: P1 })).rejects.toThrow(/permission denied/);
  });
});

describe("setAiTriggerSkills", () => {
  // The sequence is a replace addressed by the trigger's surrogate id: an unfiltered delete
  // clears the old rows, then the new order is written back as `position`.
  it("clears the sequence, then writes the order as `position`", async () => {
    const { client, queries } = fakeClient({ data: null, error: null }, { data: null, error: null });

    await setAiTriggerSkills(client, "t-env", ["opening-a-pr", "how-we-add-env"]);

    expect(queries[0]!.table).toBe("ai_trigger_skills");
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "trigger_id", "t-env"],
    ]);
    expect(queries[1]!.ops).toEqual([
      [
        "insert",
        [
          { trigger_id: "t-env", skill_name: "opening-a-pr", position: 0 },
          { trigger_id: "t-env", skill_name: "how-we-add-env", position: 1 },
        ],
      ],
    ]);
  });

  // An empty sequence is a legitimate state — an instruction with no skills — and the
  // unfiltered delete is what clears it. A second, empty insert would be a postgrest error.
  it("clears the sequence with a single delete when the names are empty", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });

    await setAiTriggerSkills(client, "t-env", []);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.ops).toEqual([["delete"], ["eq", "trigger_id", "t-env"]]);
  });

  it("throws when the delete is rejected, before anything is written", async () => {
    const { client, queries } = fakeClient({ data: null, error: { message: "row-level security" } });
    await expect(setAiTriggerSkills(client, "t-env", ["a"])).rejects.toThrow(/row-level security/);
    expect(queries).toHaveLength(1);
  });
});

describe("setAiAgentSkills", () => {
  it("replaces an agent's sequence on its own table and owner key", async () => {
    const { client, queries } = fakeClient({ data: null, error: null }, { data: null, error: null });

    await setAiAgentSkills(client, { scope: "project", id: P1 }, "review", ["how-we-review"]);

    expect(queries[0]!.table).toBe("ai_agent_skills");
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "project_id", P1],
      ["eq", "agent_id", "review"],
    ]);
    expect(queries[1]!.ops).toEqual([
      [
        "insert",
        [{ workspace_id: null, project_id: P1, user_id: null, agent_id: "review", skill_name: "how-we-review", position: 0 }],
      ],
    ]);
  });
});

test("an instruction override maps to camelCase and omits a null author", () => {
  const a = toAiAgent({
    id: "a-review",
    workspace_id: null, project_id: P1, user_id: null,
    agent_id: "review",
    instruction: "Дивись лише на {{diff}}.",
    updated_at: "2026-09-07T10:00:00Z",
    updated_by: null,
  });
  expect(a).toEqual({
    id: "a-review",
    owner: { scope: "project", id: P1 },
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
  const a = toAiAgent({
    id: "a-review",
    workspace_id: null, project_id: P1, user_id: null,
    agent_id: "review",
    instruction: "  веди список\n",
    updated_at: "2026-09-07T10:00:00Z",
    updated_by: "u1",
  });
  expect(a.updatedBy).toBe("u1");
  expect(a.instruction).toBe("  веди список\n");
});

describe("deleteAiAgent", () => {
  it("deletes by the owner key and asks for the removed rows back", async () => {
    const { client, queries } = fakeClient({
      data: [
        {
          id: "a-review",
          workspace_id: null, project_id: P1, user_id: null,
          agent_id: "review",
          instruction: "x",
          updated_at: "2026-09-07T10:00:00Z",
          updated_by: "u1",
        },
      ],
      error: null,
    });

    await deleteAiAgent(client, { scope: "project", id: P1 }, "review");

    expect(queries[0]!.table).toBe("ai_agents");
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "project_id", P1],
      ["eq", "agent_id", "review"],
      ["select", "id, workspace_id, project_id, user_id, agent_id, instruction, updated_at, updated_by"],
    ]);
  });

  // The whole point of the `.select()`: a member's delete is filtered out by the owner-only
  // USING clause and comes back `{ data: [], error: null }`. Resolving there would let the
  // pane claim the agent is back on its default while the override still stands.
  it("throws when no row came back, naming the agent", async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(deleteAiAgent(client, { scope: "project", id: P1 }, "review")).rejects.toThrow(
      /agent "review" was not reset/,
    );
  });
});
