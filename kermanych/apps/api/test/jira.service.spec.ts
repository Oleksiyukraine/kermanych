import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@kermanych/core";
import { JiraService } from "../src/jira/jira.service";
import { JiraHttpError, type JiraClient } from "../src/jira/jira-client";
import { RegistryService } from "../src/registry/registry.service";
import type { AuthService } from "../src/auth/auth.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";

type Result = { data: unknown; error: { message: string } | null };
type Query = { table: string; ops: [string, ...unknown[]][] };

// Table-routed fake: each table owns a result queue, because the sync path touches many
// tables in one pass and positional scripting would couple the test to call order that
// is not the contract.
function fakeCloud(queues: Record<string, Result[]>) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const result = (queues[table] ?? []).shift() ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (v: Result) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const op of ["select", "insert", "update", "upsert", "delete", "eq", "in", "or", "order", "single", "maybeSingle"]) {
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

const integrationRow = {
  id: "i1",
  workspace_id: "w1",
  site_url: "https://team.atlassian.net",
  jira_project_key: "KAN",
  board_id: 7,
  board_name: "KAN board",
  connected_by: "u1",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

const rawIssue = {
  id: "10001",
  key: "KAN-42",
  fields: {
    summary: "Fix it",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "why" }] }] },
    status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
    updated: "2026-09-02T10:00:00.000Z",
  },
  renderedFields: { description: "<p>why</p>" },
};

function scriptedJiraClient(overrides: Partial<Record<keyof JiraClient, unknown>> = {}): JiraClient {
  return {
    myself: vi.fn(async () => ({ accountId: "acc", displayName: "Dev" })),
    boardConfiguration: vi.fn(async () => [{ name: "To Do", statusIds: ["1"] }]),
    searchIssues: vi.fn(async () => [rawIssue]),
    listComments: vi.fn(async () => []),
    listWorklogs: vi.fn(async () => []),
    getIssue: vi.fn(async () => rawIssue),
    transition: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as JiraClient;
}

let dir: string;
let registry: RegistryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jira-svc-"));
  registry = new RegistryService(join(dir, "test.sqlite"));
  registry.setJiraToken("https://team.atlassian.net", "u1", "a@b.c", "tok");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(cloud: SupabaseClient, jiraClient: JiraClient, supervisor?: Partial<SupervisorService>) {
  const auth = { cloudClient: () => cloud } as unknown as AuthService;
  return new JiraService(registry, auth, (supervisor ?? {}) as SupervisorService, () => jiraClient);
}

describe("sync", () => {
  it("does nothing when another client already holds the lease", async () => {
    const { client, queries } = fakeCloud({
      workspace_jira_integrations: [{ data: integrationRow, error: null }],
      jira_sync_state: [{ data: [], error: null }], // lease lost: zero updated rows
    });
    const jira = scriptedJiraClient();
    const res = await service(client, jira).sync("w1", "u1");
    expect(res).toEqual({ synced: false });
    expect(jira.searchIssues).not.toHaveBeenCalled();
    // Nothing was written beyond the guarded lease update itself.
    expect(queries.filter((q) => q.table === "jira_issues")).toEqual([]);
  });

  it("full sync replaces columns, upserts issues, reconciles deletions and advances the cursor", async () => {
    const { client, queries } = fakeCloud({
      workspace_jira_integrations: [{ data: integrationRow, error: null }],
      jira_sync_state: [
        { data: { integration_id: "i1", workspace_id: "w1", last_synced_at: null, sync_cursor: null }, error: null }, // getJiraSyncState
        { data: null, error: null }, // advance cursor
      ],
      jira_issues: [
        { data: null, error: null }, // upsert
        // listJiraIssues for reconciliation: one live row, one gone row
        {
          data: [
            { ...mirrorIssueRow("10001", "KAN-42") },
            { ...mirrorIssueRow("10099", "KAN-99") },
          ],
          error: null,
        },
        { data: null, error: null }, // delete gone
      ],
    });
    const jira = scriptedJiraClient();
    // `full: true` path is taken because the cursor is null.
    const res = await service(client, jira).sync("w1", "u1", true);
    expect(res).toEqual({ synced: true });

    expect(queries.find((q) => q.table === "jira_columns" && q.ops[0]![0] === "delete")).toBeTruthy();
    expect(queries.find((q) => q.table === "jira_columns" && q.ops[0]![0] === "insert")).toBeTruthy();

    const del = queries.filter((q) => q.table === "jira_issues").find((q) => q.ops[0]![0] === "delete");
    expect(del!.ops).toContainEqual(["in", "issue_id", ["10099"]]);

    const cursor = queries.filter((q) => q.table === "jira_sync_state").find((q) => q.ops[0]![0] === "update");
    expect(cursor!.ops[0]![1]).toEqual({ sync_cursor: "2026-09-02T10:00:00.000Z" });
  });
});

describe("launch", () => {
  it("creates the shadow task, starts the session, binds the issue, then transitions", async () => {
    const order: string[] = [];
    const { client } = fakeCloud({
      workspace_jira_integrations: [{ data: integrationRow, error: null }],
      tasks: [{ data: shadowTaskRow(), error: null }],
      jira_issues: [{ data: null, error: null }, { data: null, error: null }],
      jira_comments: [{ data: null, error: null }],
      jira_worklogs: [{ data: null, error: null }],
      jira_attachments: [{ data: null, error: null }],
    });
    const jira = scriptedJiraClient({
      transition: vi.fn(async () => {
        order.push("transition");
      }),
    });
    const supervisor = {
      createSessionFromTask: vi.fn(async () => {
        order.push("session");
        return { id: "s1" } as Session;
      }),
    };
    // refreshIssue inside launch needs its own integration lookup.
    const svc = service(client, jira, supervisor);
    const spy = vi.spyOn(svc, "refreshIssue").mockResolvedValue({} as never);

    const res = await svc.launch("w1", "KAN-42", "p1", "u1", "31");
    expect(res.session).toEqual({ id: "s1" });
    expect(res.transitionError).toBeUndefined();
    expect(order).toEqual(["session", "transition"]);
    expect(supervisor.createSessionFromTask).toHaveBeenCalledWith("t1", "u1", undefined);
    expect(spy).toHaveBeenCalledWith("w1", "KAN-42", "u1");
  });

  it("keeps the session and reports a refused transition as a warning, not a failure", async () => {
    const { client } = fakeCloud({
      workspace_jira_integrations: [{ data: integrationRow, error: null }],
      tasks: [{ data: shadowTaskRow(), error: null }],
      jira_issues: [{ data: null, error: null }],
    });
    const jira = scriptedJiraClient({
      transition: vi.fn(async () => {
        throw new JiraHttpError(409, "issue was moved already");
      }),
    });
    const supervisor = { createSessionFromTask: vi.fn(async () => ({ id: "s1" }) as Session) };
    const res = await service(client, jira, supervisor).launch("w1", "KAN-42", "p1", "u1", "31");
    expect(res.session).toEqual({ id: "s1" });
    expect(res.transitionError).toBe("issue was moved already");
  });

  it("derives the shadow task's title and plain-text description from the issue", async () => {
    const { client, queries } = fakeCloud({
      workspace_jira_integrations: [{ data: integrationRow, error: null }],
      tasks: [{ data: shadowTaskRow(), error: null }],
      jira_issues: [{ data: null, error: null }],
    });
    const supervisor = { createSessionFromTask: vi.fn(async () => ({ id: "s1" }) as Session) };
    await service(client, scriptedJiraClient(), supervisor).launch("w1", "KAN-42", "p1", "u1");
    const insert = queries.find((q) => q.table === "tasks")!;
    const row = insert.ops[0]![1] as Record<string, unknown>;
    expect(row.title).toBe("KAN-42 — Fix it");
    expect(row.description).toBe("why");
    expect(row.jira_key).toBe("KAN-42");
    expect(row.assignee_id).toBe("u1");
  });
});

describe("editIssue", () => {
  it("spells the estimate as timetracking and clears an emptied one with null", async () => {
    // Two edits; each needs withIntegration + refreshIssue's own integration lookup.
    const integrations = Array.from({ length: 4 }, () => ({ data: integrationRow, error: null }));
    const { client } = fakeCloud({ workspace_jira_integrations: integrations });
    const editIssue = vi.fn(async () => undefined);
    const jira = scriptedJiraClient({ editIssue });
    const svc = service(client, jira);

    await svc.editIssue("w1", "KAN-42", { originalEstimate: "2d 4h" }, "u1");
    expect(editIssue).toHaveBeenLastCalledWith("KAN-42", { timetracking: { originalEstimate: "2d 4h" } });

    await svc.editIssue("w1", "KAN-42", { originalEstimate: "  " }, "u1");
    expect(editIssue).toHaveBeenLastCalledWith("KAN-42", { timetracking: { originalEstimate: null } });
  });

  it("sends only the drafted fields — a one-field patch must not clear the rest", async () => {
    const integrations = Array.from({ length: 2 }, () => ({ data: integrationRow, error: null }));
    const { client } = fakeCloud({ workspace_jira_integrations: integrations });
    const editIssue = vi.fn(async () => undefined);
    const svc = service(client, scriptedJiraClient({ editIssue }));

    await svc.editIssue("w1", "KAN-42", { priorityId: "2" }, "u1");
    expect(editIssue).toHaveBeenLastCalledWith("KAN-42", { priority: { id: "2" } });
  });
});

describe("setToken", () => {
  it("refuses to store a token /myself rejects", async () => {
    const { client } = fakeCloud({});
    const jira = scriptedJiraClient({
      myself: vi.fn(async () => {
        throw new JiraHttpError(401, "Client must be authenticated");
      }),
    });
    await expect(service(client, jira).setToken("other.atlassian.net", "a@b.c", "bad", "u1")).rejects.toThrow(
      /authenticated/,
    );
    expect(registry.getJiraToken("https://other.atlassian.net", "u1")).toBeUndefined();
  });
});

function mirrorIssueRow(issueId: string, key: string) {
  return {
    integration_id: "i1",
    workspace_id: "w1",
    issue_id: issueId,
    key,
    summary: "x",
    description_html: "",
    type_name: "",
    type_icon: "",
    priority_name: "",
    priority_icon: "",
    labels: [],
    original_estimate: "",
    assignee_account_id: null,
    assignee_name: null,
    assignee_avatar: null,
    reporter_name: null,
    status_id: "1",
    status_name: "To Do",
    status_category: "new",
    parent_key: null,
    jira_updated_at: "2026-09-01T00:00:00.000Z",
    kermanych_project_id: null,
    task_id: null,
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

function shadowTaskRow() {
  return {
    id: "t1",
    project_id: "p1",
    title: "KAN-42 — Fix it",
    description: "why",
    status: "backlog",
    assignee_id: "u1",
    created_by: "u1",
    model: null,
    effort: null,
    prefix: null,
    platform: null,
    worktree: true,
    kind: null,
    branch: null,
    image_paths: null,
    jira_key: "KAN-42",
    created_at: "2026-09-02T10:00:00.000Z",
    updated_at: "2026-09-02T10:00:00.000Z",
  };
}
