// packages/cloud/test/skill-improvements.spec.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  insertSkillImprovement,
  listSkillImprovementEntries,
  markSkillImprovementsSeen,
  subscribeSkillImprovements,
  toSkillImprovement,
  toSkillImprovementEntry,
  type SkillImprovementChange,
} from "../src/skill-improvements";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// The same collecting thenable as skills.spec.ts, with the chain methods these helpers use.
function fakeClient(...results: Result[]) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "insert", "update", "eq", "in", "is", "order", "limit", "single", "maybeSingle"]) {
        chain[op] = (...args: unknown[]) => {
          q.ops.push([op, ...args]);
          return chain;
        };
      }
      chain.then = (resolve: (r: Result) => unknown) => resolve(results.shift() ?? { data: [], error: null });
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const entryRow = {
  id: "i1",
  skill_name: "qa-tester",
  summary: "run tests with at most four workers",
  session_name: "Додати онбординг",
  project_id: "p1",
  workspace_id: null,
  state: "applied",
  seen_at: null,
  created_at: "2026-11-04T10:00:00Z",
};

const recordRow = {
  ...entryRow,
  user_id: "u1",
  session_id: "s1",
  reason: "The operator stopped a run that used every core.",
  before_body: "2. Run the suite.",
  edits: [{ find: "Run the suite.", replace: "Run the suite with --maxWorkers=4." }],
  created_copy: true,
  team_scope: "default",
  team_owner_id: null,
  state_at: "2026-11-04T10:00:00Z",
};

describe("row mapping", () => {
  it("maps an entry to camelCase and leaves out absent ids and an unseen stamp", () => {
    const e = toSkillImprovementEntry(entryRow);
    expect(e).toEqual({
      id: "i1",
      skillName: "qa-tester",
      summary: "run tests with at most four workers",
      sessionName: "Додати онбординг",
      projectId: "p1",
      state: "applied",
      createdAt: "2026-11-04T10:00:00Z",
    });
    expect(e && "workspaceId" in e).toBe(false);
    expect(e && "seenAt" in e).toBe(false);
  });

  it("maps a whole record with its edits", () => {
    expect(toSkillImprovement(recordRow)).toMatchObject({
      userId: "u1",
      beforeBody: "2. Run the suite.",
      edits: [{ find: "Run the suite.", replace: "Run the suite with --maxWorkers=4." }],
      createdCopy: true,
      teamScope: "default",
    });
  });

  // A newer client may write a state or scope this build cannot act on: the row is left out
  // rather than offered with buttons that would do the wrong thing.
  it("drops rows whose state, scope or edits this build does not read", () => {
    expect(toSkillImprovementEntry({ ...entryRow, state: "archived" })).toBeUndefined();
    expect(toSkillImprovement({ ...recordRow, team_scope: "galaxy" })).toBeUndefined();
    expect(toSkillImprovement({ ...recordRow, edits: [{ find: "x" }] })).toBeUndefined();
  });
});

describe("insertSkillImprovement", () => {
  it("writes snake_case columns and nulls for absent ids, and asks only for the id back", async () => {
    const { client, queries } = fakeClient({ data: { id: "i9" }, error: null });
    const id = await insertSkillImprovement(client, {
      userId: "u1",
      skillName: "qa-tester",
      teamScope: "default",
      createdCopy: true,
      beforeBody: "2. Run the suite.",
      edits: [{ find: "Run the suite.", replace: "Run the suite with --maxWorkers=4." }],
      summary: "s",
      reason: "r",
      sessionId: "s1",
      sessionName: "Додати онбординг",
      projectId: "p1",
    });
    expect(id).toBe("i9");
    expect(queries[0]!.table).toBe("skill_improvements");
    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      {
        user_id: "u1",
        skill_name: "qa-tester",
        team_scope: "default",
        team_owner_id: null,
        created_copy: true,
        before_body: "2. Run the suite.",
        edits: [{ find: "Run the suite.", replace: "Run the suite with --maxWorkers=4." }],
        summary: "s",
        reason: "r",
        session_id: "s1",
        session_name: "Додати онбординг",
        project_id: "p1",
        workspace_id: null,
      },
    ]);
    expect(queries[0]!.ops.slice(1)).toEqual([["select", "id"], ["single"]]);
  });

  it("surfaces a refusal verbatim", async () => {
    const { client } = fakeClient({ data: null, error: { message: 'relation "public.skill_improvements" does not exist' } });
    await expect(
      insertSkillImprovement(client, {
        userId: "u1",
        skillName: "qa-tester",
        teamScope: "default",
        createdCopy: true,
        beforeBody: "x",
        edits: [{ find: "x", replace: "y" }],
        summary: "s",
        reason: "r",
        sessionId: "s1",
        sessionName: "",
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("the column's reads and writes", () => {
  it("lists the newest records without the skill text", async () => {
    const { client, queries } = fakeClient({ data: [entryRow], error: null });
    expect(await listSkillImprovementEntries(client, 100)).toHaveLength(1);
    const select = queries[0]!.ops.find((o) => o[0] === "select")?.[1];
    expect(select).not.toMatch(/before_body|edits|reason/);
    expect(queries[0]!.ops).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(queries[0]!.ops).toContainEqual(["limit", 100]);
  });

  it("marks only unseen records, and sends nothing for an empty list", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await markSkillImprovementsSeen(client, []);
    expect(queries).toHaveLength(0);
    await markSkillImprovementsSeen(client, ["i1", "i2"]);
    expect(queries[0]!.ops.map((o) => o[0])).toEqual(["update", "in", "is"]);
    expect(queries[0]!.ops[2]).toEqual(["is", "seen_at", null]);
  });
});

describe("subscribeSkillImprovements", () => {
  function fakeRealtime() {
    const bindings: { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[] = [];
    let removed = false;
    const channel = {
      on(type: string, filter: Record<string, unknown>, cb: (p: unknown) => void) {
        bindings.push({ type, filter, cb });
        return channel;
      },
      subscribe() {
        return channel;
      },
    };
    const client = {
      channel: () => channel,
      removeChannel: async () => {
        removed = true;
      },
    } as unknown as SupabaseClient;
    return { client, bindings, removed: () => removed };
  }

  it("binds the caller's own rows with the light columns and passes inserts and updates on", () => {
    const { client, bindings, removed } = fakeRealtime();
    const seen: SkillImprovementChange[] = [];
    const stop = subscribeSkillImprovements(client, "u1", (c) => seen.push(c));
    const pg = bindings.find((b) => b.type === "postgres_changes")!;
    expect(pg.filter).toMatchObject({ table: "skill_improvements", filter: "user_id=eq.u1" });
    expect(pg.filter.select).not.toContain("before_body");

    pg.cb({ eventType: "INSERT", new: entryRow });
    pg.cb({ eventType: "UPDATE", new: { ...entryRow, state: "rolled_back" } });
    pg.cb({ eventType: "DELETE", old: { id: "i1" } });
    expect(seen.map((c) => [c.kind, c.entry.state])).toEqual([
      ["insert", "applied"],
      ["update", "rolled_back"],
    ]);
    stop();
    expect(removed()).toBe(true);
  });
});
