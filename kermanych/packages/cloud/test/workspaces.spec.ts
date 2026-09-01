import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createWorkspace,
  deleteWorkspace,
  inviteMember,
  listMembers,
  listWorkspaces,
  patchWorkspace,
  removeMember,
  setMemberRole,
  toWorkspace,
} from "../src/workspaces";

type Result = { data: unknown; error: { message: string } | null };
type Query = { table: string; ops: [string, ...unknown[]][] };

// The house postgrest fake: a thenable builder that records every chained call, so a
// test asserts the QUERY, not a mock's return value. Mirrors test/projects.spec.ts.
function fakeClient(...results: Result[]) {
  const queries: Query[] = [];
  function enqueue(table: string): { q: Query; result: Result } {
    const q: Query = { table, ops: [] };
    queries.push(q);
    return { q, result: results[queries.length - 1] ?? { data: null, error: null } };
  }
  const thenable = (result: Result) => ({
    then: (resolve: (v: Result) => unknown) => Promise.resolve(result).then(resolve),
  });
  const client = {
    from(table: string) {
      const { q, result } = enqueue(table);
      const builder: Record<string, unknown> = { ...thenable(result) };
      for (const op of ["select", "insert", "update", "delete", "eq", "order", "single", "maybeSingle"]) {
        builder[op] = (...args: unknown[]) => {
          q.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
    rpc(fn: string, args: unknown) {
      const { q, result } = enqueue(`rpc:${fn}`);
      q.ops.push(["rpc", args]);
      return thenable(result);
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const workspaceRow = {
  id: "w1",
  name: "AAA",
  color: "#ff8800",
  owner_id: "u1",
  created_at: "2026-08-27T00:00:00.000Z",
};

const memberRow = {
  workspace_id: "w1",
  user_id: "u2",
  role: "developer" as const,
  added_at: "2026-08-27T01:00:00.000Z",
  profiles: { id: "u2", github_username: "octocat", display_name: "Octo Cat", avatar_url: null },
};

describe("toWorkspace", () => {
  it("maps snake_case and omits absent optionals rather than setting undefined", () => {
    expect(toWorkspace(workspaceRow)).toEqual({
      id: "w1",
      name: "AAA",
      color: "#ff8800",
      ownerId: "u1",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    expect(toWorkspace({ ...workspaceRow, color: null })).not.toHaveProperty("color");
  });
});

describe("listWorkspaces", () => {
  it("selects every column and orders by creation", async () => {
    const { client, queries } = fakeClient({ data: [workspaceRow], error: null });
    const list = await listWorkspaces(client);
    expect(list).toHaveLength(1);
    expect(queries[0]!.table).toBe("workspaces");
    expect(queries[0]!.ops[0]).toEqual(["select", "id, name, color, owner_id, created_at"]);
    expect(queries[0]!.ops[1]).toEqual(["order", "created_at", { ascending: true }]);
  });
});

describe("createWorkspace", () => {
  it("refuses a blank name before any round trip", async () => {
    const { client, queries } = fakeClient();
    await expect(createWorkspace(client, { name: "   ", ownerId: "u1" })).rejects.toThrow(
      "workspace name is required",
    );
    expect(queries).toHaveLength(0);
  });

  it("sends owner_id and the trimmed name", async () => {
    const { client, queries } = fakeClient({ data: workspaceRow, error: null });
    await createWorkspace(client, { name: "  AAA  ", ownerId: "u1", color: "#ff8800" });
    expect(queries[0]!.ops[0]).toEqual(["insert", { name: "AAA", color: "#ff8800", owner_id: "u1" }]);
  });
});

describe("patchWorkspace", () => {
  it("sends only the keys present and clears with an empty string", async () => {
    const { client, queries } = fakeClient({ data: workspaceRow, error: null });
    await patchWorkspace(client, "w1", { color: "" });
    expect(queries[0]!.ops[0]).toEqual(["update", { color: null }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "w1"]);
  });
});

describe("listMembers", () => {
  it("filters by workspace and folds the embedded profile into `profile`", async () => {
    const { client, queries } = fakeClient({ data: [memberRow], error: null });
    const [m] = await listMembers(client, "w1");
    expect(m).toEqual({
      workspaceId: "w1",
      userId: "u2",
      role: "developer",
      addedAt: "2026-08-27T01:00:00.000Z",
      profile: { id: "u2", githubUsername: "octocat", displayName: "Octo Cat" },
    });
    expect(queries[0]!.table).toBe("workspace_members");
    expect(queries[0]!.ops[1]).toEqual(["eq", "workspace_id", "w1"]);
  });
});

describe("inviteMember", () => {
  it("normalizes the address, calls the rpc, then re-reads for the joined profile", async () => {
    const { client, queries } = fakeClient(
      { data: { user_id: "u2" }, error: null },
      { data: memberRow, error: null },
    );
    const m = await inviteMember(client, "w1", "  Octo@Example.COM ");
    expect(queries[0]!.table).toBe("rpc:invite_workspace_member");
    expect(queries[0]!.ops[0]).toEqual([
      "rpc",
      { p_workspace_id: "w1", p_email: "octo@example.com" },
    ]);
    expect(queries[1]!.table).toBe("workspace_members");
    expect(m.profile?.githubUsername).toBe("octocat");
  });

  it("rejects an obvious non-email without calling the rpc", async () => {
    const { client, queries } = fakeClient();
    await expect(inviteMember(client, "w1", "octocat")).rejects.toThrow("is not a valid email address");
    expect(queries).toHaveLength(0);
  });

  it("surfaces the rpc's refusal message unchanged", async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: "only the workspace owner can invite" },
    });
    await expect(inviteMember(client, "w1", "octo@example.com")).rejects.toThrow(
      "only the workspace owner can invite",
    );
  });
});

describe("removeMember", () => {
  it("deletes by the composite key", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await removeMember(client, "w1", "u2");
    expect(queries[0]!.ops[0]).toEqual(["delete"]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "workspace_id", "w1"]);
    expect(queries[0]!.ops[2]).toEqual(["eq", "user_id", "u2"]);
  });
});

describe("setMemberRole", () => {
  it("calls the rpc then re-reads for the joined profile", async () => {
    const { client, queries } = fakeClient(
      { data: { user_id: "u2" }, error: null },
      { data: { ...memberRow, role: "manager" }, error: null },
    );
    const m = await setMemberRole(client, "w1", "u2", "manager");
    expect(queries[0]!.table).toBe("rpc:set_workspace_member_role");
    expect(queries[0]!.ops[0]).toEqual([
      "rpc",
      { p_workspace_id: "w1", p_user_id: "u2", p_role: "manager" },
    ]);
    expect(queries[1]!.table).toBe("workspace_members");
    expect(m.role).toBe("manager");
    expect(m.profile?.githubUsername).toBe("octocat");
  });

  it("surfaces the rpc's refusal message unchanged", async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: "only the workspace owner can change roles" },
    });
    await expect(setMemberRole(client, "w1", "u2", "developer")).rejects.toThrow(
      "only the workspace owner can change roles",
    );
  });
});

describe("deleteWorkspace", () => {
  it("deletes by id", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await deleteWorkspace(client, "w1");
    expect(queries[0]!.table).toBe("workspaces");
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "w1"]);
  });
});
