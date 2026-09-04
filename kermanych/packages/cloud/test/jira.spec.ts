import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteJiraIssues,
  listJiraWorklogsBetween,
  patchJiraIssueBinding,
  replaceJiraColumns,
  takeJiraSyncLease,
  toJiraIssue,
  toJiraIssueRow,
  upsertJiraIssues,
} from "../src/jira";
import type { JiraIssue } from "../src/types";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// The tasks.spec fakeClient with the extra builder verbs the jira module chains
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
  issue_id: "10001",
  key: "KAN-42",
  summary: "Fix the flux capacitor",
  description_html: "<p>details</p>",
  type_name: "Bug",
  type_icon: "https://x/bug.svg",
  priority_name: "High",
  priority_icon: "https://x/high.svg",
  labels: ["backend"],
  original_estimate: "3d",
  time_spent: "1d 2h",
  remaining_estimate: "1d 6h",
  original_estimate_seconds: 86400,
  time_spent_seconds: 36000,
  remaining_estimate_seconds: 50400,
  start_date: "2026-09-01",
  due_date: "2026-09-30",
  assignee_account_id: "acc1",
  assignee_name: "Andrii",
  assignee_avatar: "https://x/a.png",
  reporter_name: "Olha",
  status_id: "3",
  status_name: "In Progress",
  status_category: "indeterminate",
  parent_key: null,
  jira_updated_at: "2026-09-02T10:00:00.000Z",
  kermanych_project_id: null,
  task_id: null,
  updated_at: "2026-09-02T10:00:05.000Z",
};

describe("toJiraIssue", () => {
  it("maps a row and omits absent optionals instead of carrying nulls", () => {
    const t = toJiraIssue(issueRow);
    expect(t).toEqual({
      integrationId: "i1",
      workspaceId: "w1",
      issueId: "10001",
      key: "KAN-42",
      summary: "Fix the flux capacitor",
      descriptionHtml: "<p>details</p>",
      typeName: "Bug",
      typeIcon: "https://x/bug.svg",
      priorityName: "High",
      priorityIcon: "https://x/high.svg",
      labels: ["backend"],
      originalEstimate: "3d",
      timeSpent: "1d 2h",
      remainingEstimate: "1d 6h",
      originalEstimateSeconds: 86400,
      timeSpentSeconds: 36000,
      remainingEstimateSeconds: 50400,
      startDate: "2026-09-01",
      dueDate: "2026-09-30",
      assigneeAccountId: "acc1",
      assigneeName: "Andrii",
      assigneeAvatar: "https://x/a.png",
      reporterName: "Olha",
      statusId: "3",
      statusName: "In Progress",
      statusCategory: "indeterminate",
      jiraUpdatedAt: "2026-09-02T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:05.000Z",
    });
    expect("parentKey" in t).toBe(false);
    expect("taskId" in t).toBe(false);
  });

  it("degrades an unknown status category to 'new' rather than crashing", () => {
    expect(toJiraIssue({ ...issueRow, status_category: "someday" }).statusCategory).toBe("new");
  });

  it("carries the numeric counters beside the display strings", () => {
    const issue = toJiraIssue(issueRow);
    expect(issue.originalEstimateSeconds).toBe(86400);
    expect(issue.timeSpentSeconds).toBe(36000);
    expect(issue.remainingEstimateSeconds).toBe(50400);
    expect(toJiraIssueRow(issue)).toMatchObject({
      original_estimate_seconds: 86400,
      time_spent_seconds: 36000,
      remaining_estimate_seconds: 50400,
    });
  });
});

describe("toJiraIssueRow", () => {
  it("never writes the launch binding — a poll must not clobber a launch", () => {
    const issue: JiraIssue = { ...toJiraIssue(issueRow), kermanychProjectId: "p1", taskId: "t1" };
    const row = toJiraIssueRow(issue);
    expect("kermanych_project_id" in row).toBe(false);
    expect("task_id" in row).toBe(false);
    expect(row.key).toBe("KAN-42");
    expect(row.assignee_account_id).toBe("acc1");
  });
});

describe("takeJiraSyncLease", () => {
  it("takes the lease with a guarded update and reports a won race", async () => {
    const { client, queries } = fakeClient({ data: [{ integration_id: "i1" }], error: null });
    const won = await takeJiraSyncLease(client, "i1", 25_000);
    expect(won).toBe(true);
    const ops = queries[0]!.ops;
    expect(ops[0]![0]).toBe("update");
    expect(ops[1]).toEqual(["eq", "integration_id", "i1"]);
    // The guard: stale-or-null, in one `or` — race losers match zero rows.
    expect(String(ops[2]![1])).toMatch(/^last_synced_at\.is\.null,last_synced_at\.lt\./);
  });

  it("reports a lost race as false, not as an error", async () => {
    const { client } = fakeClient({ data: [], error: null });
    expect(await takeJiraSyncLease(client, "i1", 25_000)).toBe(false);
  });
});

describe("upsertJiraIssues", () => {
  it("upserts on the (integration_id, issue_id) pk and skips an empty batch", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await upsertJiraIssues(client, [toJiraIssue(issueRow)]);
    expect(queries[0]!.table).toBe("jira_issues");
    expect(queries[0]!.ops[0]![2]).toEqual({ onConflict: "integration_id,issue_id" });

    await upsertJiraIssues(client, []);
    expect(queries.length).toBe(1);
  });
});

describe("deleteJiraIssues", () => {
  it("deletes exactly the named ids within one integration", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await deleteJiraIssues(client, "i1", ["10001", "10002"]);
    expect(queries[0]!.ops).toEqual([
      ["delete"],
      ["eq", "integration_id", "i1"],
      ["in", "issue_id", ["10001", "10002"]],
    ]);
  });
});

describe("patchJiraIssueBinding", () => {
  it("sends only the provided sides and keeps explicit nulls", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await patchJiraIssueBinding(client, "i1", "10001", { taskId: null });
    expect(queries[0]!.ops[0]).toEqual(["update", { task_id: null }]);
  });
});

describe("replaceJiraColumns", () => {
  it("deletes the old layout before inserting the new one", async () => {
    const { client, queries } = fakeClient({ data: null, error: null }, { data: null, error: null });
    await replaceJiraColumns(client, "i1", "w1", [{ position: 0, name: "To Do", statusIds: ["1"] }]);
    expect(queries[0]!.ops[0]).toEqual(["delete"]);
    expect(queries[1]!.ops[0]![0]).toBe("insert");
    const rows = queries[1]!.ops[0]![1] as Record<string, unknown>[];
    expect(rows[0]).toEqual({
      integration_id: "i1",
      workspace_id: "w1",
      position: 0,
      name: "To Do",
      status_ids: ["1"],
    });
  });
});

describe("listJiraWorklogsBetween", () => {
  it("reads one integration's worklogs by started_at half-open range, oldest first", async () => {
    const row = {
      integration_id: "i1", workspace_id: "w1", issue_id: "10001", worklog_id: "wl1",
      author_account_id: "acc1", author_name: "Andrii", author_avatar: "", time_spent: "2h",
      seconds: 7200, started_at: "2026-09-02T08:00:00.000Z", comment_html: "",
    };
    const { client, queries } = fakeClient({ data: [row], error: null });
    const out = await listJiraWorklogsBetween(client, "i1", "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    expect(queries[0]!.table).toBe("jira_worklogs");
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ["eq", "integration_id", "i1"],
        ["gte", "started_at", "2026-09-01T00:00:00.000Z"],
        ["lt", "started_at", "2026-09-08T00:00:00.000Z"],
        ["order", "started_at", { ascending: true }],
      ]),
    );
    expect(out[0]).toMatchObject({ worklogId: "wl1", authorAccountId: "acc1", seconds: 7200 });
  });
});
