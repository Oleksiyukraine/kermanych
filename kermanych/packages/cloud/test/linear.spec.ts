import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteLinearIssues,
  patchLinearIssueBinding,
  replaceLinearColumns,
  takeLinearSyncLease,
  toLinearIssue,
  toLinearIssueRow,
  upsertLinearIssues,
} from "../src/linear";
import type { LinearIssue } from "../src/types";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// The tasks.spec fakeClient with the extra builder verbs the linear module chains
// (`upsert`, `or`). Same contract: n-th query resolves to the n-th queued result.
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
      for (const op of [
        "select", "insert", "update", "upsert", "delete", "eq", "in", "is", "or", "gte", "lt", "order", "single", "maybeSingle",
      ]) {
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

const issueRow = {
  integration_id: "i1",
  workspace_id: "w1",
  issue_id: "uuid-1",
  key: "ENG-42",
  title: "Fix the flux capacitor",
  description_md: "**details**",
  priority: 2,
  priority_name: "High",
  estimate: 3,
  labels: ["backend"],
  assignee_id: "acc1",
  assignee_name: "Andrii",
  assignee_avatar: "https://x/a.png",
  state_id: "st1",
  state_name: "In Progress",
  state_category: "indeterminate",
  parent_key: null,
  url: "https://linear.app/acme/issue/ENG-42",
  start_date: "2026-09-01",
  due_date: "2026-09-30",
  linear_updated_at: "2026-09-02T10:00:00.000Z",
  kermanych_project_id: null,
  task_id: null,
  updated_at: "2026-09-02T10:00:05.000Z",
};

describe("toLinearIssue", () => {
  it("maps a row and omits absent optionals instead of carrying nulls", () => {
    const t = toLinearIssue(issueRow);
    expect(t).toEqual({
      integrationId: "i1",
      workspaceId: "w1",
      issueId: "uuid-1",
      key: "ENG-42",
      title: "Fix the flux capacitor",
      descriptionMd: "**details**",
      priority: 2,
      priorityName: "High",
      estimate: 3,
      labels: ["backend"],
      assigneeId: "acc1",
      assigneeName: "Andrii",
      assigneeAvatar: "https://x/a.png",
      stateId: "st1",
      stateName: "In Progress",
      stateCategory: "indeterminate",
      url: "https://linear.app/acme/issue/ENG-42",
      startDate: "2026-09-01",
      dueDate: "2026-09-30",
      linearUpdatedAt: "2026-09-02T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:05.000Z",
    });
    expect("parentKey" in t).toBe(false);
    expect("taskId" in t).toBe(false);
  });

  it("degrades an unknown state category to 'new' rather than crashing", () => {
    expect(toLinearIssue({ ...issueRow, state_category: "someday" }).stateCategory).toBe("new");
  });

  it("carries the numeric priority and estimate straight through", () => {
    const issue = toLinearIssue(issueRow);
    expect(issue.priority).toBe(2);
    expect(issue.estimate).toBe(3);
    expect(toLinearIssueRow(issue)).toMatchObject({ priority: 2, estimate: 3 });
  });
});

describe("toLinearIssueRow", () => {
  it("never writes the launch binding — a poll must not clobber a launch", () => {
    const issue: LinearIssue = { ...toLinearIssue(issueRow), kermanychProjectId: "p1", taskId: "t1" };
    const row = toLinearIssueRow(issue);
    expect("kermanych_project_id" in row).toBe(false);
    expect("task_id" in row).toBe(false);
    expect(row.key).toBe("ENG-42");
    expect(row.assignee_id).toBe("acc1");
  });
});

describe("takeLinearSyncLease", () => {
  it("takes the lease with a guarded update and reports a won race", async () => {
    const { client, queries } = fakeClient({ data: [{ integration_id: "i1" }], error: null });
    const won = await takeLinearSyncLease(client, "i1", 25_000);
    expect(won).toBe(true);
    const ops = queries[0]!.ops;
    expect(ops[0]![0]).toBe("update");
    expect(ops[1]).toEqual(["eq", "integration_id", "i1"]);
    // The guard: stale-or-null, in one `or` — race losers match zero rows.
    expect(String(ops[2]![1])).toMatch(/^last_synced_at\.is\.null,last_synced_at\.lt\./);
  });

  it("reports a lost race as false, not as an error", async () => {
    const { client } = fakeClient({ data: [], error: null });
    expect(await takeLinearSyncLease(client, "i1", 25_000)).toBe(false);
  });
});

describe("upsertLinearIssues", () => {
  it("upserts on the (integration_id, issue_id) pk and skips an empty batch", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await upsertLinearIssues(client, [toLinearIssue(issueRow)]);
    expect(queries[0]!.table).toBe("linear_issues");
    expect(queries[0]!.ops[0]![2]).toEqual({ onConflict: "integration_id,issue_id" });

    await upsertLinearIssues(client, []);
    expect(queries.length).toBe(1);
  });
});

describe("deleteLinearIssues", () => {
  it("deletes exactly the named ids within one integration", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await deleteLinearIssues(client, "i1", ["uuid-1", "uuid-2"]);
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "integration_id", "i1"],
      ["in", "issue_id", ["uuid-1", "uuid-2"]],
    ]);
  });
});

describe("patchLinearIssueBinding", () => {
  it("sends only the provided sides and keeps explicit nulls", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await patchLinearIssueBinding(client, "i1", "uuid-1", { taskId: null });
    expect(queries[0]!.ops[0]).toEqual(["update", { task_id: null }]);
  });
});

describe("replaceLinearColumns", () => {
  it("deletes the old layout before inserting the new one", async () => {
    const { client, queries } = fakeClient({ data: null, error: null }, { data: null, error: null });
    await replaceLinearColumns(client, "i1", "w1", [{ position: 0, name: "Todo", stateIds: ["st1"] }]);
    expect(queries[0]!.ops[0]).toEqual(["delete"]);
    expect(queries[1]!.ops[0]![0]).toBe("insert");
    const rows = queries[1]!.ops[0]![1] as Record<string, unknown>[];
    expect(rows[0]).toEqual({
      integration_id: "i1",
      workspace_id: "w1",
      position: 0,
      name: "Todo",
      state_ids: ["st1"],
    });
  });
});
