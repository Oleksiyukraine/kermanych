import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deletePlaneIssues,
  listPlaneWorklogsBetween,
  markPlaneChildrenSynced,
  patchPlaneIssueBinding,
  replacePlaneColumns,
  replacePlaneIssueChildren,
  takePlaneSyncLease,
  toPlaneIssue,
  toPlaneIssueRow,
  upsertPlaneIntegration,
  upsertPlaneIssues,
} from "../src/plane";
import type { PlaneIssue } from "../src/types";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// The jira.spec fakeClient: n-th query resolves to the n-th queued result.
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
  issue_id: "e1c25c66-5bb8-465e-a818-92a483423443",
  key: "WEB-42",
  summary: "Fix the flux capacitor",
  description_html: "<p>details</p>",
  type_name: "",
  priority: "high",
  labels: ["backend"],
  estimate_point_id: "ep1",
  estimate: "90",
  original_estimate_seconds: 5400,
  time_spent: "1h 30m",
  time_spent_seconds: 5400,
  start_date: "2026-11-01",
  due_date: "2026-11-30",
  assignee_account_id: "u-plane-1",
  assignee_name: "Andrii",
  assignee_avatar: "https://x/a.png",
  reporter_name: "Olha",
  status_id: "s-started",
  status_name: "In Progress",
  status_category: "indeterminate",
  parent_key: null,
  plane_updated_at: "2026-11-04T10:00:00.000Z",
  children_synced_at: null,
  kermanych_project_id: null,
  task_id: null,
  updated_at: "2026-11-04T10:00:05.000Z",
};

describe("toPlaneIssue", () => {
  it("maps a row and omits absent optionals instead of carrying nulls", () => {
    const t = toPlaneIssue(issueRow);
    expect(t).toEqual({
      integrationId: "i1",
      workspaceId: "w1",
      issueId: "e1c25c66-5bb8-465e-a818-92a483423443",
      key: "WEB-42",
      summary: "Fix the flux capacitor",
      descriptionHtml: "<p>details</p>",
      typeName: "",
      priority: "high",
      labels: ["backend"],
      estimatePointId: "ep1",
      estimate: "90",
      originalEstimateSeconds: 5400,
      timeSpent: "1h 30m",
      timeSpentSeconds: 5400,
      startDate: "2026-11-01",
      dueDate: "2026-11-30",
      assigneeAccountId: "u-plane-1",
      assigneeName: "Andrii",
      assigneeAvatar: "https://x/a.png",
      reporterName: "Olha",
      statusId: "s-started",
      statusName: "In Progress",
      statusCategory: "indeterminate",
      planeUpdatedAt: "2026-11-04T10:00:00.000Z",
      updatedAt: "2026-11-04T10:00:05.000Z",
    });
    expect("parentKey" in t).toBe(false);
    expect("childrenSyncedAt" in t).toBe(false);
    expect("taskId" in t).toBe(false);
  });

  it("degrades an unknown status category to 'new' rather than crashing", () => {
    expect(toPlaneIssue({ ...issueRow, status_category: "triage" }).statusCategory).toBe("new");
  });

  it("carries the child-refresh stamp when the mirror has one", () => {
    const t = toPlaneIssue({ ...issueRow, children_synced_at: "2026-11-04T10:01:00.000Z" });
    expect(t.childrenSyncedAt).toBe("2026-11-04T10:01:00.000Z");
  });
});

describe("toPlaneIssueRow", () => {
  it("never writes the launch binding — a poll must not clobber a launch", () => {
    const issue: PlaneIssue = { ...toPlaneIssue(issueRow), kermanychProjectId: "p1", taskId: "t1" };
    const row = toPlaneIssueRow(issue);
    expect("kermanych_project_id" in row).toBe(false);
    expect("task_id" in row).toBe(false);
    expect(row.key).toBe("WEB-42");
    expect(row.assignee_account_id).toBe("u-plane-1");
  });

  it("never writes the child-refresh stamp — a list upsert must not make every item due again", () => {
    const issue: PlaneIssue = { ...toPlaneIssue(issueRow), childrenSyncedAt: "2026-11-04T10:01:00.000Z" };
    expect("children_synced_at" in toPlaneIssueRow(issue)).toBe(false);
  });

  it("writes an absent estimate point as an explicit null so a cleared estimate clears", () => {
    const { estimatePointId: _drop, ...rest } = toPlaneIssue(issueRow);
    expect(toPlaneIssueRow(rest as PlaneIssue).estimate_point_id).toBeNull();
  });
});

describe("upsertPlaneIntegration", () => {
  it("upserts on (workspace_id, project_id) so a re-connect refreshes the row", async () => {
    const { client, queries } = fakeClient({
      data: {
        id: "i1", workspace_id: "w1", site_url: "https://app.plane.so", workspace_slug: "acme",
        project_id: "p-uuid", project_identifier: "WEB", project_name: "Web", connected_by: null,
        created_at: "2026-11-04T10:00:00.000Z", updated_at: "2026-11-04T10:00:00.000Z",
      },
      error: null,
    });
    const out = await upsertPlaneIntegration(client, {
      workspaceId: "w1",
      siteUrl: " https://app.plane.so ",
      workspaceSlug: "acme",
      projectId: "p-uuid",
      projectIdentifier: "WEB",
      projectName: "Web",
    });
    expect(queries[0]!.table).toBe("workspace_plane_integrations");
    expect(queries[0]!.ops[0]).toEqual([
      "upsert",
      {
        workspace_id: "w1",
        site_url: "https://app.plane.so",
        workspace_slug: "acme",
        project_id: "p-uuid",
        project_identifier: "WEB",
        project_name: "Web",
      },
      { onConflict: "workspace_id,project_id" },
    ]);
    expect(out).toMatchObject({ projectIdentifier: "WEB", workspaceSlug: "acme" });
    expect("connectedBy" in out).toBe(false);
  });
});

describe("takePlaneSyncLease", () => {
  it("takes the lease with a guarded update and reports a won race", async () => {
    const { client, queries } = fakeClient({ data: [{ integration_id: "i1" }], error: null });
    expect(await takePlaneSyncLease(client, "i1", 25_000)).toBe(true);
    const ops = queries[0]!.ops;
    expect(queries[0]!.table).toBe("plane_sync_state");
    expect(ops[0]![0]).toBe("update");
    expect(ops[1]).toEqual(["eq", "integration_id", "i1"]);
    expect(String(ops[2]![1])).toMatch(/^last_synced_at\.is\.null,last_synced_at\.lt\./);
  });

  it("reports a lost race as false, not as an error", async () => {
    const { client } = fakeClient({ data: [], error: null });
    expect(await takePlaneSyncLease(client, "i1", 25_000)).toBe(false);
  });
});

describe("upsertPlaneIssues", () => {
  it("upserts on the (integration_id, issue_id) pk and skips an empty batch", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await upsertPlaneIssues(client, [toPlaneIssue(issueRow)]);
    expect(queries[0]!.table).toBe("plane_issues");
    expect(queries[0]!.ops[0]![2]).toEqual({ onConflict: "integration_id,issue_id" });

    await upsertPlaneIssues(client, []);
    expect(queries.length).toBe(1);
  });
});

describe("deletePlaneIssues", () => {
  it("deletes exactly the named ids within one integration", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await deletePlaneIssues(client, "i1", ["a", "b"]);
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "integration_id", "i1"],
      ["in", "issue_id", ["a", "b"]],
    ]);
  });
});

describe("patchPlaneIssueBinding", () => {
  it("sends only the provided sides and keeps explicit nulls", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await patchPlaneIssueBinding(client, "i1", "a", { taskId: null });
    expect(queries[0]!.ops[0]).toEqual(["update", { task_id: null }]);
  });
});

describe("markPlaneChildrenSynced", () => {
  it("stamps exactly one item of one integration", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await markPlaneChildrenSynced(client, "i1", "a", "2026-11-04T10:01:00.000Z");
    expect(queries[0]!.table).toBe("plane_issues");
    expect(queries[0]!.ops).toEqual([
      ["update", { children_synced_at: "2026-11-04T10:01:00.000Z" }],
      ["eq", "integration_id", "i1"],
      ["eq", "issue_id", "a"],
    ]);
  });
});

describe("replacePlaneColumns", () => {
  it("deletes the old layout before inserting the new one, group and colour included", async () => {
    const { client, queries } = fakeClient({ data: null, error: null }, { data: null, error: null });
    await replacePlaneColumns(client, "i1", "w1", [
      { position: 0, name: "Backlog", stateIds: ["s1"], stateGroup: "backlog", color: "#a3a3a3" },
    ]);
    expect(queries[0]!.ops[0]).toEqual(["delete"]);
    expect(queries[1]!.ops[0]![0]).toBe("insert");
    const rows = queries[1]!.ops[0]![1] as Record<string, unknown>[];
    expect(rows[0]).toEqual({
      integration_id: "i1",
      workspace_id: "w1",
      position: 0,
      name: "Backlog",
      state_ids: ["s1"],
      state_group: "backlog",
      color: "#a3a3a3",
    });
  });
});

describe("replacePlaneIssueChildren", () => {
  it("clears all three child tables, then inserts only the non-empty ones", async () => {
    const { client, queries } = fakeClient();
    await replacePlaneIssueChildren(client, "i1", "w1", "a", {
      comments: [],
      worklogs: [
        {
          worklogId: "wl1", authorAccountId: "u1", authorName: "Andrii", authorAvatar: "",
          timeSpent: "1h 30m", seconds: 5400, startedAt: "2026-11-04T09:00:00.000Z", description: "pairing",
        },
      ],
      attachments: [],
    });
    expect(queries.slice(0, 3).map((q) => [q.table, q.ops[0]![0]])).toEqual([
      ["plane_comments", "delete"],
      ["plane_worklogs", "delete"],
      ["plane_attachments", "delete"],
    ]);
    expect(queries).toHaveLength(4);
    expect(queries[3]!.table).toBe("plane_worklogs");
    expect((queries[3]!.ops[0]![1] as Record<string, unknown>[])[0]).toEqual({
      integration_id: "i1",
      workspace_id: "w1",
      issue_id: "a",
      worklog_id: "wl1",
      author_account_id: "u1",
      author_name: "Andrii",
      author_avatar: "",
      time_spent: "1h 30m",
      seconds: 5400,
      started_at: "2026-11-04T09:00:00.000Z",
      description: "pairing",
    });
  });
});

describe("listPlaneWorklogsBetween", () => {
  it("reads one integration's worklogs by started_at half-open range, oldest first", async () => {
    const row = {
      integration_id: "i1", workspace_id: "w1", issue_id: "a", worklog_id: "wl1",
      author_account_id: "u1", author_name: "Andrii", author_avatar: "", time_spent: "2h",
      seconds: 7200, started_at: "2026-11-02T08:00:00.000Z", description: "",
    };
    const { client, queries } = fakeClient({ data: [row], error: null });
    const out = await listPlaneWorklogsBetween(client, "i1", "2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z");
    expect(queries[0]!.table).toBe("plane_worklogs");
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ["eq", "integration_id", "i1"],
        ["gte", "started_at", "2026-11-01T00:00:00.000Z"],
        ["lt", "started_at", "2026-11-08T00:00:00.000Z"],
        ["order", "started_at", { ascending: true }],
      ]),
    );
    expect(out[0]).toMatchObject({ worklogId: "wl1", authorAccountId: "u1", seconds: 7200 });
  });
});
