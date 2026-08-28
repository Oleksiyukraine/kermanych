import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createProject, deleteProject, listProjects, patchProject, toCloudProject } from "../src/projects";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// A PostgrestBuilder is a thenable that collects chained calls; this fake has the same
// shape, so `await client.from(t).select(c).eq(k, v).single()` resolves to the n-th queued
// result while recording every op for assertions. `rpc()` shares the same queue, so a
// function call and a table read can be asserted in the order the code makes them.
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
    // An rpc call takes no chained ops in this package, so the argument object is the
    // whole surface worth recording.
    rpc(fn: string, args: unknown) {
      const { q, result } = enqueue(`rpc:${fn}`);
      q.ops.push(["rpc", args]);
      return thenable(result);
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
  workspace_id: "w1",
  created_at: "2026-08-21T00:00:00.000Z",
};

describe("toCloudProject", () => {
  it("carries workspaceId and has no ownerId", () => {
    const p = toCloudProject(projectRow);
    expect(p.workspaceId).toBe("w1");
    expect(p).not.toHaveProperty("ownerId");
  });
});

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
      workspaceId: "w1",
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops[1]).toEqual(["order", "created_at", { ascending: true }]);
  });

  // The column list is the contract with Postgres and nothing else asserts it; a typo
  // here is a runtime 42703 that every fake-client test would happily miss.
  it("selects workspace_id and never owner_id", async () => {
    const { client, queries } = fakeClient({ data: [projectRow], error: null });
    await listProjects(client);
    expect(queries[0]!.ops[0]).toEqual([
      "select",
      "id, name, workspace_id, git_remote_url, conventions, preview_command, api_command, default_branch, carry_files, env_keys, color, created_at",
    ]);
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
  // Exact equality, so this is also the "omits id" case: with no caller-supplied id the
  // payload is name + workspace_id and nothing else, and Postgres mints the uuid.
  it("sends workspace_id, not owner_id", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });
    await createProject(client, { name: "back-end", workspaceId: "w1" });
    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops[0]).toEqual(["insert", { name: "back-end", workspace_id: "w1" }]);
    expect(queries[0]!.ops.at(-1)).toEqual(["single"]);
  });

  it("trims the name and writes an empty remote as null", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });

    await createProject(client, { name: "  Acme  ", workspaceId: "w1", gitRemoteUrl: "   " });

    expect(queries[0]!.ops[0]).toEqual(["insert", { name: "Acme", workspace_id: "w1", git_remote_url: null }]);
  });

  it("refuses a blank name before touching the network", async () => {
    const { client, queries } = fakeClient();
    await expect(createProject(client, { name: "   ", workspaceId: "w1" })).rejects.toThrow(
      /project name is required/,
    );
    expect(queries).toHaveLength(0);
  });

  it("adopts a caller-supplied id so publishing keeps the local identity", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });
    await createProject(client, { name: "back-end", workspaceId: "w1", id: "p-local" });
    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { name: "back-end", id: "p-local", workspace_id: "w1" },
    ]);
  });

  // Publishing a local-only project. The id is the load-bearing part: reuse it and the
  // machine's binding, sessions and worktrees stay attached; mint a new one and they are
  // stranded on an orphan row. The config columns must ride along too, because
  // syncProjects() overwrites the local row from the cloud one straight afterwards.
  it("seeds the config columns at birth", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });

    await createProject(client, {
      id: "6d96ada8-7caf-43b2-98f0-e2d1245903e5",
      name: "Multiagent-app",
      workspaceId: "w1",
      carryFiles: [".env"],
      color: "#ff563c",
      previewCommand: "pnpm dev",
      defaultBranch: "dev",
      conventions: "   ",
    });

    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      {
        id: "6d96ada8-7caf-43b2-98f0-e2d1245903e5",
        name: "Multiagent-app",
        workspace_id: "w1",
        carry_files: [".env"],
        color: "#ff563c",
        preview_command: "pnpm dev",
        default_branch: "dev",
        conventions: null,
      },
    ]);
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

  it("moves a project by patching workspace_id", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });
    await patchProject(client, "p1", { workspaceId: "w2" });
    expect(queries[0]!.ops[0]).toEqual(["update", { workspace_id: "w2" }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "p1"]);
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
