// packages/cloud/test/skills.spec.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, test } from "vitest";
import { deleteAiSkill, toAiSkill } from "../src/skills";

const SKILL_COLUMNS = "id, workspace_id, project_id, user_id, name, description, body, enabled, updated_at, updated_by";

test("maps a row to camelCase, derives the owner, and omits a null author", () => {
  const s = toAiSkill({
    id: "s1",
    workspace_id: null,
    project_id: "p1",
    user_id: null,
    name: "opening-a-pr",
    description: "d",
    body: "b",
    enabled: true,
    updated_at: "2026-08-27T10:00:00Z",
    updated_by: null,
  });
  expect(s).toEqual({
    id: "s1",
    owner: { scope: "project", id: "p1" },
    name: "opening-a-pr",
    description: "d",
    body: "b",
    enabled: true,
    updatedAt: "2026-08-27T10:00:00Z",
  });
  // toEqual treats `{ updatedBy: undefined }` as equal to an absent key, so the omission
  // itself — what keeps a mapped skill free of null noise in Vue's reactivity — needs its
  // own assertion.
  expect("updatedBy" in s).toBe(false);
});

test("keeps a present author and reads the owner off whichever triad column is set", () => {
  const s = toAiSkill({
    id: "s2",
    workspace_id: "w1",
    project_id: null,
    user_id: null,
    name: "x",
    description: "d",
    body: "b",
    enabled: false,
    updated_at: "2026-08-27T10:00:00Z",
    updated_by: "u1",
  });
  expect(s.owner).toEqual({ scope: "workspace", id: "w1" });
  expect(s.updatedBy).toBe("u1");
  expect(s.enabled).toBe(false);
});

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// Same shape as the fakes in tasks.spec.ts and projects.spec.ts: a thenable that collects the
// chained calls and resolves to the queued result.
function fakeClient(...results: Result[]) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const op of ["delete", "eq", "select", "insert", "update", "upsert", "in", "order", "not"]) {
        chain[op] = (...args: unknown[]) => {
          q.ops.push([op, ...args]);
          return chain;
        };
      }
      chain.then = (resolve: (r: Result) => unknown) =>
        resolve(results.shift() ?? { data: [], error: null });
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const skillRow = {
  id: "s1",
  workspace_id: null,
  project_id: "p1",
  user_id: null,
  name: "opening-a-pr",
  description: "how this team opens a pull request",
  body: "Squash, then request a review.",
  enabled: true,
  updated_at: "2026-08-27T10:00:00Z",
  updated_by: "u1",
};

describe("deleteAiSkill", () => {
  it("deletes by the owner column and name and asks for the removed rows back", async () => {
    const { client, queries } = fakeClient({ data: [skillRow], error: null });

    await deleteAiSkill(client, { scope: "project", id: "p1" }, "opening-a-pr");

    expect(queries[0]!.table).toBe("ai_skills");
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "project_id", "p1"],
      ["eq", "name", "opening-a-pr"],
      ["select", SKILL_COLUMNS],
    ]);
  });

  // The whole point of the `.select()`: a member's delete is filtered out by the owner-only
  // USING clause and comes back `{ data: [], error: null }`. Resolving there would let the
  // editor drop a row the database still holds.
  it("throws when no row came back, naming the skill", async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(deleteAiSkill(client, { scope: "project", id: "p1" }, "opening-a-pr")).rejects.toThrow(
      /skill "opening-a-pr" was not deleted/,
    );
  });

  it("still surfaces a genuine postgrest error verbatim", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table ai_skills" } });
    await expect(deleteAiSkill(client, { scope: "project", id: "p1" }, "opening-a-pr")).rejects.toThrow(
      /permission denied/,
    );
  });
});
