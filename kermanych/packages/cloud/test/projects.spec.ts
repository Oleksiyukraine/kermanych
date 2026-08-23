import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMember,
  createProject,
  deleteProject,
  listMembers,
  listProjects,
  patchProject,
  removeMember,
} from "../src/projects";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// A PostgrestBuilder is a thenable that collects chained calls; this fake has the same
// shape, so `await client.from(t).select(c).eq(k, v).single()` resolves to the n-th queued
// result while recording every op for assertions.
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
      for (const op of ["select", "insert", "update", "delete", "eq", "order", "single", "maybeSingle"]) {
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

const projectRow = {
  id: "p1",
  name: "Acme",
  git_remote_url: "git@github.com:acme/web.git",
  conventions: null,
  preview_command: "pnpm dev",
  api_command: null,
  default_branch: "main",
  carry_files: [".env", ".env.local"],
  env_keys: ["GITHUB_TOKEN"],
  color: "#ff563c",
  owner_id: "u1",
  created_at: "2026-08-21T00:00:00.000Z",
};

const profileRow = { id: "u2", github_username: "octocat", display_name: "Octo Cat", avatar_url: null };
const memberRow = { project_id: "p1", user_id: "u2", role: "member" as const, added_at: "2026-08-21T01:00:00.000Z", profiles: profileRow };

describe("listProjects", () => {
  it("maps snake_case rows to CloudProject and nulls to absent keys", async () => {
    const { client, queries } = fakeClient({ data: [projectRow], error: null });

    const [p] = await listProjects(client);

    expect(p).toEqual({
      id: "p1",
      name: "Acme",
      gitRemoteUrl: "git@github.com:acme/web.git",
      previewCommand: "pnpm dev",
      defaultBranch: "main",
      carryFiles: [".env", ".env.local"],
      envKeys: ["GITHUB_TOKEN"],
      color: "#ff563c",
      ownerId: "u1",
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops[1]).toEqual(["order", "created_at", { ascending: true }]);
  });

  it("defaults carry_files to [.env] and env_keys to [] when the row has nulls", async () => {
    const { client } = fakeClient({ data: [{ ...projectRow, carry_files: null, env_keys: null }], error: null });
    const [p] = await listProjects(client);
    expect(p!.carryFiles).toEqual([".env"]);
    expect(p!.envKeys).toEqual([]);
  });

  it("throws the postgrest message so the UI can toast an RLS refusal", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table projects" } });
    await expect(listProjects(client)).rejects.toThrow(/permission denied/);
  });
});

describe("createProject", () => {
  it("inserts owner_id with a trimmed name and an empty remote as null", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });

    await createProject(client, { name: "  Acme  ", ownerId: "u1", gitRemoteUrl: "   " });

    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops[0]).toEqual(["insert", { name: "Acme", git_remote_url: null, owner_id: "u1" }]);
    expect(queries[0]!.ops.at(-1)).toEqual(["single"]);
  });

  it("refuses a blank name before touching the network", async () => {
    const { client, queries } = fakeClient();
    await expect(createProject(client, { name: "   ", ownerId: "u1" })).rejects.toThrow(/project name is required/);
    expect(queries).toHaveLength(0);
  });
});

describe("patchProject", () => {
  it("sends only the provided columns, snake-cased, emptied strings as null", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });

    await patchProject(client, "p1", { name: " New ", conventions: "   ", envKeys: ["A", "B"], previewCommand: "pnpm dev" });

    expect(queries[0]!.ops[0]).toEqual([
      "update",
      { name: "New", conventions: null, env_keys: ["A", "B"], preview_command: "pnpm dev" },
    ]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "p1"]);
  });
});

describe("listMembers", () => {
  it("filters by project and folds the embedded profile into `profile`", async () => {
    const { client, queries } = fakeClient({ data: [memberRow], error: null });

    const [m] = await listMembers(client, "p1");

    expect(m).toEqual({
      projectId: "p1",
      userId: "u2",
      role: "member",
      addedAt: "2026-08-21T01:00:00.000Z",
      profile: { id: "u2", githubUsername: "octocat", displayName: "Octo Cat" },
    });
    expect(queries[0]!.table).toBe("project_members");
    expect(queries[0]!.ops[1]).toEqual(["eq", "project_id", "p1"]);
  });
});

describe("addMember", () => {
  it("resolves the github handle to a profile, strips a leading @, then inserts", async () => {
    const { client, queries } = fakeClient({ data: profileRow, error: null }, { data: memberRow, error: null });

    const m = await addMember(client, "p1", " @octocat ");

    expect(queries[0]!.table).toBe("profiles");
    expect(queries[0]!.ops[1]).toEqual(["eq", "github_username", "octocat"]);
    expect(queries[1]!.table).toBe("project_members");
    expect(queries[1]!.ops[0]).toEqual(["insert", { project_id: "p1", user_id: "u2", role: "member" }]);
    expect(m.userId).toBe("u2");
  });

  it("refuses a handle with no Kermanych profile and never inserts", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await expect(addMember(client, "p1", "ghost")).rejects.toThrow(/no Kermanych profile for @ghost/);
    expect(queries).toHaveLength(1);
  });

  it("refuses an empty handle", async () => {
    const { client, queries } = fakeClient();
    await expect(addMember(client, "p1", "  @ ")).rejects.toThrow(/github username is required/);
    expect(queries).toHaveLength(0);
  });
});

describe("removeMember", () => {
  it("deletes by the composite primary key", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });

    await removeMember(client, "p1", "u2");

    expect(queries[0]!.table).toBe("project_members");
    expect(queries[0]!.ops).toEqual([["delete"], ["eq", "project_id", "p1"], ["eq", "user_id", "u2"]]);
  });
});

describe("deleteProject", () => {
  it("deletes by id and nothing else", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });

    await deleteProject(client, "p1");

    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops).toEqual([["delete"], ["eq", "id", "p1"]]);
  });

  it("throws the postgrest message so the UI can toast a refusal", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table projects" } });
    await expect(deleteProject(client, "p1")).rejects.toThrow(/permission denied/);
  });
});
