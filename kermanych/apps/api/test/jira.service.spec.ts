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
    // Every real site answers this; the service resolves «Start date» from it once per
    // site and then asks Jira for that field id beside the standard set.
    listFields: vi.fn(async () => [
      { id: "duedate", name: "Due date", schema: { type: "date" } },
      { id: "customfield_10015", name: "Start date", custom: true, schema: { type: "date" } },
    ]),
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

  it("asks Jira for the site's start-date field once, then mirrors both planning dates", async () => {
    const { client, queries } = fakeCloud({
      workspace_jira_integrations: Array.from({ length: 2 }, () => ({ data: integrationRow, error: null })),
      jira_sync_state: Array.from({ length: 4 }, () => ({ data: { integration_id: "i1", workspace_id: "w1", last_synced_at: null, sync_cursor: null }, error: null })),
      jira_issues: Array.from({ length: 4 }, () => ({ data: [], error: null })),
    });
    const dated = {
      ...rawIssue,
      fields: { ...rawIssue.fields, duedate: "2026-09-30", customfield_10015: "2026-09-05" },
    };
    const searchIssues = vi.fn(async () => [dated]);
    const jira = scriptedJiraClient({ searchIssues });
    const svc = service(client, jira);

    await svc.sync("w1", "u1", true);
    // The id is per site, so it must travel with the search — Jira returns no field the
    // caller did not name.
    expect(searchIssues).toHaveBeenLastCalledWith(expect.any(String), "customfield_10015");
    const upsert = queries.filter((q) => q.table === "jira_issues").find((q) => q.ops[0]![0] === "upsert")!;
    expect((upsert.ops[0]![1] as Record<string, unknown>[])[0]).toMatchObject({
      start_date: "2026-09-05",
      due_date: "2026-09-30",
    });

    // Second poll, same site: the field dictionary is cached, because a 30-second tick
    // cannot afford to re-read every field a site defines.
    await svc.sync("w1", "u1", true);
    expect(jira.listFields).toHaveBeenCalledTimes(1);
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

  it("writes the due date under Jira's own key and the start date under the site's field id", async () => {
    const integrations = Array.from({ length: 4 }, () => ({ data: integrationRow, error: null }));
    const { client } = fakeCloud({ workspace_jira_integrations: integrations });
    const editIssue = vi.fn(async () => undefined);
    const svc = service(client, scriptedJiraClient({ editIssue }));

    await svc.editIssue("w1", "KAN-42", { startDate: "2026-09-05", dueDate: "2026-09-30" }, "u1");
    expect(editIssue).toHaveBeenLastCalledWith("KAN-42", {
      duedate: "2026-09-30",
      customfield_10015: "2026-09-05",
    });

    // An emptied input clears the date in Jira; null is how Jira spells that.
    await svc.editIssue("w1", "KAN-42", { startDate: "", dueDate: "" }, "u1");
    expect(editIssue).toHaveBeenLastCalledWith("KAN-42", { duedate: null, customfield_10015: null });
  });

  it("refuses a start date on a site that has no start-date field, in words a user can read", async () => {
    const { client } = fakeCloud({
      workspace_jira_integrations: [{ data: integrationRow, error: null }],
    });
    const editIssue = vi.fn(async () => undefined);
    const jira = scriptedJiraClient({ editIssue, listFields: vi.fn(async () => []) });

    await expect(service(client, jira).editIssue("w1", "KAN-42", { startDate: "2026-09-05" }, "u1")).rejects.toThrow(
      /no start date field/,
    );
    expect(editIssue).not.toHaveBeenCalled();
  });

  it("refuses a malformed date rather than letting Jira answer for it", async () => {
    const { client } = fakeCloud({
      workspace_jira_integrations: [{ data: integrationRow, error: null }],
    });
    const editIssue = vi.fn(async () => undefined);

    await expect(
      service(client, scriptedJiraClient({ editIssue })).editIssue("w1", "KAN-42", { dueDate: "30.09.2026" }, "u1"),
    ).rejects.toThrow(/invalid date/);
    expect(editIssue).not.toHaveBeenCalled();
  });
});

describe("logWork", () => {
  // withIntegration + refreshIssue each read the integration row.
  const integrations = () => Array.from({ length: 2 }, () => ({ data: integrationRow, error: null }));

  it("writes the entry under the acting user's token and brings the issue back from Jira", async () => {
    const { client } = fakeCloud({ workspace_jira_integrations: integrations() });
    const addWorklog = vi.fn(async () => ({ id: "w1" }));
    const getIssue = vi.fn(async () => rawIssue);
    const svc = service(client, scriptedJiraClient({ addWorklog, getIssue }));

    const issue = await svc.logWork(
      "w1",
      "KAN-42",
      { timeSpent: " 3h 20m ", started: "2026-09-02T11:30:00.000Z", comment: " pair review " },
      "u1",
    );

    expect(addWorklog).toHaveBeenCalledWith("KAN-42", {
      timeSpent: "3h 20m",
      started: "2026-09-02T11:30:00.000+0000",
      comment: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "pair review" }] }],
      },
      adjust: { mode: "auto" },
    });
    // The refetch is what moves «Витрачено»/«Залишилось» on the board without waiting for
    // the next poll.
    expect(getIssue).toHaveBeenCalled();
    expect(issue.key).toBe("KAN-42");
  });

  it("defaults the start to now and omits an empty note", async () => {
    const { client } = fakeCloud({ workspace_jira_integrations: integrations() });
    const addWorklog = vi.fn(async () => ({ id: "w1" }));
    await service(client, scriptedJiraClient({ addWorklog })).logWork("w1", "KAN-42", { timeSpent: "1h", comment: "  " }, "u1");

    const [, input] = addWorklog.mock.calls[0] as unknown as [string, { started: string; comment?: unknown }];
    expect(input.started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+0000$/);
    expect("comment" in input).toBe(false);
  });

  it("passes each estimate adjustment through and falls back to Jira's default on nonsense", async () => {
    const { client } = fakeCloud({
      workspace_jira_integrations: Array.from({ length: 6 }, () => ({ data: integrationRow, error: null })),
    });
    const addWorklog = vi.fn(async () => ({ id: "w1" }));
    const svc = service(client, scriptedJiraClient({ addWorklog }));

    await svc.logWork("w1", "KAN-42", { timeSpent: "1h", adjust: { mode: "leave" } }, "u1");
    expect((addWorklog.mock.lastCall as unknown as [string, { adjust: unknown }])[1].adjust).toEqual({ mode: "leave" });

    await svc.logWork("w1", "KAN-42", { timeSpent: "1h", adjust: { mode: "manual", value: " 30m " } }, "u1");
    expect((addWorklog.mock.lastCall as unknown as [string, { adjust: unknown }])[1].adjust).toEqual({
      mode: "manual",
      value: "30m",
    });

    // A mode Jira never defined would earn `adjustEstimate=whatever` and a 400; the entry
    // is worth more than the adjustment, so it lands with Jira's own default.
    await svc.logWork("w1", "KAN-42", { timeSpent: "1h", adjust: { mode: "sideways" } as never }, "u1");
    expect((addWorklog.mock.lastCall as unknown as [string, { adjust: unknown }])[1].adjust).toEqual({ mode: "auto" });
  });

  it("refuses an empty duration and an adjustment with nothing to adjust by", async () => {
    const { client } = fakeCloud({
      workspace_jira_integrations: Array.from({ length: 4 }, () => ({ data: integrationRow, error: null })),
    });
    const addWorklog = vi.fn(async () => ({ id: "w1" }));
    const svc = service(client, scriptedJiraClient({ addWorklog }));

    await expect(svc.logWork("w1", "KAN-42", { timeSpent: "   " }, "u1")).rejects.toThrow(/timeSpent is required/);
    await expect(
      svc.logWork("w1", "KAN-42", { timeSpent: "1h", adjust: { mode: "new", value: "" } }, "u1"),
    ).rejects.toThrow(/needs a duration/);
    expect(addWorklog).not.toHaveBeenCalled();
  });
});

describe("editWorklog", () => {
  const integrations = (n = 2) => Array.from({ length: n }, () => ({ data: integrationRow, error: null }));

  it("sends the edited entry against its worklog id and keeps the start the user gave", async () => {
    const { client } = fakeCloud({ workspace_jira_integrations: integrations() });
    const updateWorklog = vi.fn(async () => ({ id: "10100" }));
    const svc = service(client, scriptedJiraClient({ updateWorklog }));

    await svc.editWorklog(
      "w1",
      "KAN-42",
      "10100",
      { timeSpent: "2h", started: "2026-09-01T08:00:00.000Z", comment: "fixed" },
      "u1",
    );

    expect(updateWorklog).toHaveBeenCalledWith("KAN-42", "10100", {
      timeSpent: "2h",
      // The entry keeps the day it happened on — an edit is not a re-log.
      started: "2026-09-01T08:00:00.000+0000",
      comment: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "fixed" }] }],
      },
      adjust: { mode: "auto" },
    });
  });

  it("reads a relative adjustment as «recalculate», because Jira's update has no such parameter", async () => {
    const { client } = fakeCloud({ workspace_jira_integrations: integrations() });
    const updateWorklog = vi.fn(async () => ({ id: "10100" }));
    await service(client, scriptedJiraClient({ updateWorklog })).editWorklog(
      "w1",
      "KAN-42",
      "10100",
      { timeSpent: "2h", started: "2026-09-01T08:00:00.000Z", adjust: { mode: "manual", value: "30m" } },
      "u1",
    );
    expect((updateWorklog.mock.lastCall as unknown as [string, string, { adjust: unknown }])[2].adjust).toEqual({
      mode: "auto",
    });
  });

  it("refuses an edit with no start rather than silently restamping the entry to now", async () => {
    const { client } = fakeCloud({ workspace_jira_integrations: integrations() });
    const updateWorklog = vi.fn(async () => ({ id: "10100" }));
    await expect(
      service(client, scriptedJiraClient({ updateWorklog })).editWorklog("w1", "KAN-42", "10100", { timeSpent: "2h" }, "u1"),
    ).rejects.toThrow(/started is required/);
    expect(updateWorklog).not.toHaveBeenCalled();
  });
});

describe("deleteWorklog", () => {
  it("passes the estimate adjustment through and refreshes the issue afterwards", async () => {
    const { client } = fakeCloud({
      workspace_jira_integrations: Array.from({ length: 2 }, () => ({ data: integrationRow, error: null })),
    });
    const deleteWorklog = vi.fn(async () => undefined);
    const getIssue = vi.fn(async () => rawIssue);
    const svc = service(client, scriptedJiraClient({ deleteWorklog, getIssue }));

    const issue = await svc.deleteWorklog("w1", "KAN-42", "10100", { mode: "manual", value: " 2h " }, "u1");
    expect(deleteWorklog).toHaveBeenCalledWith("KAN-42", "10100", { mode: "manual", value: "2h" });
    expect(getIssue).toHaveBeenCalled();
    expect(issue.key).toBe("KAN-42");
  });
});

describe("editorOptions", () => {
  it("reports the token's identity and Jira's worklog verdict", async () => {
    const { client } = fakeCloud({ workspace_jira_integrations: [{ data: integrationRow, error: null }] });
    const myPermissions = vi.fn(async () => ({
      WORKLOG_EDIT_OWN: true,
      WORKLOG_EDIT_ALL: false,
      WORKLOG_DELETE_OWN: true,
      WORKLOG_DELETE_ALL: false,
    }));
    const svc = service(client, scriptedJiraClient({ myPermissions, projectIssueTypes: vi.fn(async () => []), listPriorities: vi.fn(async () => []) }));

    const opts = await svc.editorOptions("w1", "u1");
    expect(myPermissions).toHaveBeenCalledWith("KAN", [
      "WORKLOG_EDIT_OWN",
      "WORKLOG_EDIT_ALL",
      "WORKLOG_DELETE_OWN",
      "WORKLOG_DELETE_ALL",
    ]);
    expect(opts.worklog).toEqual({ editOwn: true, editAll: false, deleteOwn: true, deleteAll: false });
  });

  it("backfills the token's accountId from /myself once and stores it for next time", async () => {
    const { client } = fakeCloud({
      workspace_jira_integrations: Array.from({ length: 2 }, () => ({ data: integrationRow, error: null })),
    });
    // The token in beforeEach was stored without an accountId — the pre-existing-install
    // case this backfill exists for.
    const myself = vi.fn(async () => ({ accountId: "acc-me", displayName: "Dev" }));
    const jira = scriptedJiraClient({
      myself,
      myPermissions: vi.fn(async () => ({})),
      projectIssueTypes: vi.fn(async () => []),
      listPriorities: vi.fn(async () => []),
    });
    const svc = service(client, jira);

    expect((await svc.editorOptions("w1", "u1")).myAccountId).toBe("acc-me");
    expect(registry.getJiraToken("https://team.atlassian.net", "u1")?.accountId).toBe("acc-me");

    // Second ask: the registry answers, Jira is not asked again.
    expect((await svc.editorOptions("w1", "u1")).myAccountId).toBe("acc-me");
    expect(myself).toHaveBeenCalledTimes(1);
  });

  it("degrades an unreadable permission answer to «may touch nothing», not to an error", async () => {
    const { client } = fakeCloud({ workspace_jira_integrations: [{ data: integrationRow, error: null }] });
    const jira = scriptedJiraClient({
      myPermissions: vi.fn(async () => {
        throw new JiraHttpError(403, "no browse permission");
      }),
      projectIssueTypes: vi.fn(async () => []),
      listPriorities: vi.fn(async () => []),
    });

    const opts = await service(client, jira).editorOptions("w1", "u1");
    expect(opts.worklog).toEqual({ editOwn: false, editAll: false, deleteOwn: false, deleteAll: false });
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
    time_spent: "",
    remaining_estimate: "",
    start_date: "",
    due_date: "",
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
