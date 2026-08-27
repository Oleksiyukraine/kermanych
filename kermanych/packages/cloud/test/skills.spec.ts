// packages/cloud/test/skills.spec.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, test } from "vitest";
import { deleteProjectSkill, toProjectSkill } from "../src/skills";

test("maps a row to camelCase and omits a null author", () => {
  const s = toProjectSkill({
    project_id: "p1",
    name: "opening-a-pr",
    description: "d",
    body: "b",
    enabled: true,
    updated_at: "2026-08-27T10:00:00Z",
    updated_by: null,
  });
  expect(s).toEqual({
    projectId: "p1",
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

test("keeps a present author", () => {
  const s = toProjectSkill({
    project_id: "p1",
    name: "x",
    description: "d",
    body: "b",
    enabled: false,
    updated_at: "2026-08-27T10:00:00Z",
    updated_by: "u1",
  });
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
      const result = results[queries.length - 1] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (v: Result) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "in", "order", "single"]) {
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

const skillRow = {
  project_id: "p1",
  name: "opening-a-pr",
  description: "how this team opens a pull request",
  body: "Squash, then request a review.",
  enabled: true,
  updated_at: "2026-08-27T10:00:00Z",
  updated_by: "u1",
};

describe("deleteProjectSkill", () => {
  it("deletes by the composite key and asks for the removed rows back", async () => {
    const { client, queries } = fakeClient({ data: [skillRow], error: null });

    await deleteProjectSkill(client, "p1", "opening-a-pr");

    expect(queries[0]!.table).toBe("project_skills");
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "project_id", "p1"],
      ["eq", "name", "opening-a-pr"],
      ["select", "project_id, name, description, body, enabled, updated_at, updated_by"],
    ]);
  });

  // The whole point of the `.select()`: a member's delete is filtered out by the owner-only
  // USING clause and comes back `{ data: [], error: null }`. Resolving there would let the
  // editor drop a row the database still holds.
  it("throws when no row came back, naming the skill", async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(deleteProjectSkill(client, "p1", "opening-a-pr")).rejects.toThrow(
      /skill "opening-a-pr" was not deleted/,
    );
  });

  it("still surfaces a genuine postgrest error verbatim", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table project_skills" } });
    await expect(deleteProjectSkill(client, "p1", "opening-a-pr")).rejects.toThrow(/permission denied/);
  });
});
