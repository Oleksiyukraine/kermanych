import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimRoutineRun, deleteWorkspaceRoutine, listRunnableRoutines } from "../src/routines";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string; code?: string } | null };

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
      for (const op of ["select", "insert", "update", "delete", "eq", "order", "limit", "single", "maybeSingle"]) {
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

const row = {
  id: "r1",
  workspace_id: "w1",
  project_id: null,
  name: "Weekly notes",
  action: { kind: "release_notes", sources: [{ projectId: "p1", branch: "main" }], periodDays: 7, groupBy: "topic" },
  schedule: { kind: "weekly", days: [1], time: "10:00" },
  timezone: "Europe/Kyiv",
  slack: null,
  enabled: true,
  armed_at: "2026-10-16T07:00:00Z",
  created_at: "2026-10-16T07:00:00Z",
  created_by: "u1",
  updated_at: "2026-10-16T07:00:00Z",
  updated_by: null,
};

describe("listRunnableRoutines", () => {
  it("reads only the member's own enabled routines", async () => {
    const { client, queries } = fakeClient({ data: [row], error: null });
    await listRunnableRoutines(client, "u1");
    expect(queries[0]!.ops).toContainEqual(["eq", "created_by", "u1"]);
    expect(queries[0]!.ops).toContainEqual(["eq", "enabled", true]);
  });
});

describe("claimRoutineRun", () => {
  it("answers undefined when the occurrence is already claimed", async () => {
    const { client } = fakeClient({ data: null, error: { message: "duplicate key", code: "23505" } });
    await expect(
      claimRoutineRun(client, { routineId: "r1", trigger: "schedule", scheduledFor: "2026-10-19T07:00:00Z" }),
    ).resolves.toBeUndefined();
  });

  it("throws any other refusal", async () => {
    const { client } = fakeClient({ data: null, error: { message: "new row violates row-level security policy", code: "42501" } });
    await expect(claimRoutineRun(client, { routineId: "r1", trigger: "manual" })).rejects.toThrow("row-level security");
  });

  it("claims a skip already finished", async () => {
    const { client, queries } = fakeClient({
      data: { ...row, routine_id: "r1", trigger: "schedule", scheduled_for: null, status: "skipped", started_at: "x", finished_at: "y", run_by: "u1", note_id: null, task_id: null, commit_count: null, output_md: null, slack_channel_name: null, error_code: "routine_previous_running", error_message: null, error_params: null },
      error: null,
    });
    await claimRoutineRun(client, { routineId: "r1", trigger: "schedule", status: "skipped", errorCode: "routine_previous_running" });
    const insert = queries[0]!.ops.find((o) => o[0] === "insert")![1] as Record<string, unknown>;
    expect(insert.status).toBe("skipped");
    expect(typeof insert.finished_at).toBe("string");
  });
});

describe("deleteWorkspaceRoutine", () => {
  it("reports a delete RLS refused as a refusal", async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(deleteWorkspaceRoutine(client, "r1")).rejects.toThrow("only its author or the workspace owner");
  });
});
