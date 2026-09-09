import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@kermanych/core";
import { LinearService } from "../src/linear/linear.service";
import { LinearHttpError, type LinearClient } from "../src/linear/linear-client";
import { RegistryService } from "../src/registry/registry.service";
import type { AuthService } from "../src/auth/auth.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";

type Result = { data: unknown; error: { message: string } | null };
type Query = { table: string; ops: [string, ...unknown[]][] };

// Table-routed fake: each table owns a result queue, because the sync path touches many
// tables in one pass and positional scripting would couple the test to call order that is
// not the contract.
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
  org_url_key: "acme",
  team_key: "ENG",
  team_id: "t1",
  team_name: "Engineering",
  connected_by: "u1",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

const rawIssue = {
  id: "10001",
  identifier: "ENG-42",
  title: "Fix it",
  description: "why",
  priority: 2,
  priorityLabel: "High",
  estimate: 3,
  url: "https://linear.app/acme/issue/ENG-42",
  updatedAt: "2026-09-02T10:00:00.000Z",
  dueDate: "2026-09-30",
  startedAt: "2026-09-05T08:00:00.000Z",
  state: { id: "s3", name: "In Progress", type: "started" },
  assignee: null,
  parent: null,
  labels: { nodes: [] },
  comments: { nodes: [] },
  attachments: { nodes: [] },
};

function scriptedLinearClient(overrides: Partial<Record<keyof LinearClient, unknown>> = {}): LinearClient {
  return {
    identity: vi.fn(async () => ({ viewerId: "acc", viewerName: "Dev", orgUrlKey: "acme", orgName: "Acme" })),
    listTeams: vi.fn(async () => [{ id: "t1", key: "ENG", name: "Engineering" }]),
    teamStates: vi.fn(async () => [{ id: "s1", name: "Todo", type: "unstarted", position: 0 }]),
    searchIssues: vi.fn(async () => [rawIssue]),
    getIssue: vi.fn(async () => rawIssue),
    updateIssue: vi.fn(async () => undefined),
    createIssue: vi.fn(async () => ({ id: "10001", identifier: "ENG-42" })),
    deleteIssue: vi.fn(async () => undefined),
    addComment: vi.fn(async () => ({ id: "c1" })),
    teamLabels: vi.fn(async () => []),
    teamMembers: vi.fn(async () => []),
    ...overrides,
  } as unknown as LinearClient;
}

let dir: string;
let registry: RegistryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "linear-svc-"));
  registry = new RegistryService(join(dir, "test.sqlite"));
  registry.setLinearToken("acme", "u1", "lin_key");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(cloud: SupabaseClient, linearClient: LinearClient, supervisor?: Partial<SupervisorService>) {
  const auth = { cloudClient: () => cloud } as unknown as AuthService;
  return new LinearService(registry, auth, (supervisor ?? {}) as SupervisorService, () => linearClient);
}

describe("sync", () => {
  it("does nothing when another client already holds the lease", async () => {
    const { client, queries } = fakeCloud({
      workspace_linear_integrations: [{ data: integrationRow, error: null }],
      linear_sync_state: [{ data: [], error: null }], // lease lost: zero updated rows
    });
    const linear = scriptedLinearClient();
    const res = await service(client, linear).sync("w1", "u1");
    expect(res).toEqual({ synced: false });
    expect(linear.searchIssues).not.toHaveBeenCalled();
    // Nothing was written beyond the guarded lease update itself.
    expect(queries.filter((q) => q.table === "linear_issues")).toEqual([]);
  });

  it("full sync replaces columns, upserts issues, reconciles deletions and advances the cursor", async () => {
    const { client, queries } = fakeCloud({
      workspace_linear_integrations: [{ data: integrationRow, error: null }],
      linear_sync_state: [
        { data: { integration_id: "i1", workspace_id: "w1", last_synced_at: null, sync_cursor: null }, error: null }, // getLinearSyncState
        { data: null, error: null }, // advance cursor
      ],
      linear_issues: [
        { data: null, error: null }, // upsert
        // listLinearIssues for reconciliation: one live row, one gone row
        { data: [mirrorIssueRow("10001", "ENG-42"), mirrorIssueRow("10099", "ENG-99")], error: null },
        { data: null, error: null }, // delete gone
      ],
    });
    const linear = scriptedLinearClient();
    // `full: true` path is taken because the cursor is null.
    const res = await service(client, linear).sync("w1", "u1", true);
    expect(res).toEqual({ synced: true });

    expect(queries.find((q) => q.table === "linear_columns" && q.ops[0]![0] === "delete")).toBeTruthy();
    expect(queries.find((q) => q.table === "linear_columns" && q.ops[0]![0] === "insert")).toBeTruthy();

    const del = queries.filter((q) => q.table === "linear_issues").find((q) => q.ops[0]![0] === "delete");
    expect(del!.ops).toContainEqual(["in", "issue_id", ["10099"]]);

    const cursor = queries.filter((q) => q.table === "linear_sync_state").find((q) => q.ops[0]![0] === "update");
    expect(cursor!.ops[0]![1]).toEqual({ sync_cursor: "2026-09-02T10:00:00.000Z" });
  });
});

describe("launch", () => {
  it("creates the shadow task, starts the session, binds the issue, then transitions", async () => {
    const order: string[] = [];
    const { client } = fakeCloud({
      workspace_linear_integrations: [{ data: integrationRow, error: null }],
      tasks: [{ data: shadowTaskRow(), error: null }],
      linear_issues: [{ data: null, error: null }],
    });
    const linear = scriptedLinearClient({
      updateIssue: vi.fn(async () => {
        order.push("transition");
      }),
    });
    const supervisor = {
      createSessionFromTask: vi.fn(async () => {
        order.push("session");
        return { id: "s1" } as Session;
      }),
    };
    const svc = service(client, linear, supervisor);
    // refreshIssue inside launch needs its own integration lookup — stubbed away here.
    const spy = vi.spyOn(svc, "refreshIssue").mockResolvedValue({} as never);

    const res = await svc.launch("w1", "ENG-42", "p1", "u1", "s2");
    expect(res.session).toEqual({ id: "s1" });
    expect(res.transitionError).toBeUndefined();
    expect(order).toEqual(["session", "transition"]);
    expect(supervisor.createSessionFromTask).toHaveBeenCalledWith("t1", "u1", undefined);
    expect(linear.updateIssue).toHaveBeenCalledWith("ENG-42", { stateId: "s2" });
    expect(spy).toHaveBeenCalledWith("w1", "ENG-42", "u1");
  });

  it("keeps the session and reports a refused transition as a warning, not a failure", async () => {
    const { client } = fakeCloud({
      workspace_linear_integrations: [{ data: integrationRow, error: null }],
      tasks: [{ data: shadowTaskRow(), error: null }],
      linear_issues: [{ data: null, error: null }],
    });
    const linear = scriptedLinearClient({
      updateIssue: vi.fn(async () => {
        throw new LinearHttpError(400, "state not on this team");
      }),
    });
    const supervisor = { createSessionFromTask: vi.fn(async () => ({ id: "s1" }) as Session) };
    const res = await service(client, linear, supervisor).launch("w1", "ENG-42", "p1", "u1", "s2");
    expect(res.session).toEqual({ id: "s1" });
    expect(res.transitionError).toBe("state not on this team");
  });

  it("derives the shadow task's title, markdown description and linear key from the issue", async () => {
    const { client, queries } = fakeCloud({
      workspace_linear_integrations: [{ data: integrationRow, error: null }],
      tasks: [{ data: shadowTaskRow(), error: null }],
      linear_issues: [{ data: null, error: null }],
    });
    const supervisor = { createSessionFromTask: vi.fn(async () => ({ id: "s1" }) as Session) };
    await service(client, scriptedLinearClient(), supervisor).launch("w1", "ENG-42", "p1", "u1");
    const insert = queries.find((q) => q.table === "tasks")!;
    const row = insert.ops[0]![1] as Record<string, unknown>;
    expect(row.title).toBe("ENG-42 — Fix it");
    expect(row.description).toBe("why");
    expect(row.linear_key).toBe("ENG-42");
    expect(row.assignee_id).toBe("u1");
  });
});

describe("transition", () => {
  it("moves the issue to the chosen state and refreshes it from Linear", async () => {
    const { client } = fakeCloud({
      workspace_linear_integrations: Array.from({ length: 2 }, () => ({ data: integrationRow, error: null })),
      linear_issues: [{ data: null, error: null }],
    });
    const updateIssue = vi.fn(async () => undefined);
    const getIssue = vi.fn(async () => rawIssue);
    const issue = await service(client, scriptedLinearClient({ updateIssue, getIssue })).transition("w1", "ENG-42", "s9", "u1");
    expect(updateIssue).toHaveBeenCalledWith("ENG-42", { stateId: "s9" });
    // The refetch is what moves the card without waiting for the next poll.
    expect(getIssue).toHaveBeenCalled();
    expect(issue.key).toBe("ENG-42");
  });
});

describe("editIssue", () => {
  it("sends only the drafted fields — a one-field patch must not clear the rest", async () => {
    const { client } = fakeCloud({
      workspace_linear_integrations: Array.from({ length: 2 }, () => ({ data: integrationRow, error: null })),
      linear_issues: [{ data: null, error: null }],
    });
    const updateIssue = vi.fn(async () => undefined);
    await service(client, scriptedLinearClient({ updateIssue })).editIssue("w1", "ENG-42", { priority: 3 }, "u1");
    expect(updateIssue).toHaveBeenLastCalledWith("ENG-42", { priority: 3 });
  });

  it("resolves label NAMES to ids and drops names the team does not define", async () => {
    const { client } = fakeCloud({
      workspace_linear_integrations: Array.from({ length: 2 }, () => ({ data: integrationRow, error: null })),
      linear_issues: [{ data: null, error: null }],
    });
    const updateIssue = vi.fn(async () => undefined);
    const teamLabels = vi.fn(async () => [{ id: "l1", name: "Bug" }, { id: "l2", name: "Backend" }]);
    await service(client, scriptedLinearClient({ updateIssue, teamLabels })).editIssue(
      "w1",
      "ENG-42",
      { labels: ["bug", "Unknown", "Backend"] },
      "u1",
    );
    expect(updateIssue).toHaveBeenLastCalledWith("ENG-42", { labelIds: ["l1", "l2"] });
  });

  it("clears an emptied due date and estimate with null, and rounds a fractional estimate", async () => {
    const { client } = fakeCloud({
      workspace_linear_integrations: Array.from({ length: 4 }, () => ({ data: integrationRow, error: null })),
      linear_issues: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    const updateIssue = vi.fn(async () => undefined);
    const svc = service(client, scriptedLinearClient({ updateIssue }));

    await svc.editIssue("w1", "ENG-42", { dueDate: "", estimate: 3.7 }, "u1");
    expect(updateIssue).toHaveBeenLastCalledWith("ENG-42", { dueDate: null, estimate: 4 });

    await svc.editIssue("w1", "ENG-42", { estimate: null }, "u1");
    expect(updateIssue).toHaveBeenLastCalledWith("ENG-42", { estimate: null });
  });
});

describe("setToken", () => {
  it("validates the key, stores it under the discovered org, and returns viewer + org", async () => {
    const { client } = fakeCloud({});
    const linear = scriptedLinearClient({
      identity: vi.fn(async () => ({ viewerId: "v9", viewerName: "Andrii", orgUrlKey: "acme", orgName: "Acme Inc" })),
    });
    const res = await service(client, linear).setToken("lin_new", "u2");
    expect(res).toEqual({ displayName: "Andrii", orgUrlKey: "acme", orgName: "Acme Inc" });
    expect(registry.getLinearToken("acme", "u2")).toEqual({ apiKey: "lin_new", accountId: "v9" });
  });

  it("refuses to store a key identity rejects", async () => {
    const { client } = fakeCloud({});
    const linear = scriptedLinearClient({
      identity: vi.fn(async () => {
        throw new LinearHttpError(401, "Invalid API key", "authentication error");
      }),
    });
    await expect(service(client, linear).setToken("bad", "u3")).rejects.toThrow(/Invalid API key/);
    expect(registry.getLinearToken("acme", "u3")).toBeUndefined();
  });
});

function mirrorIssueRow(issueId: string, key: string) {
  return {
    integration_id: "i1",
    workspace_id: "w1",
    issue_id: issueId,
    key,
    title: "x",
    description_md: "",
    priority: 0,
    priority_name: "",
    estimate: 0,
    labels: [],
    assignee_id: null,
    assignee_name: null,
    assignee_avatar: null,
    state_id: "s1",
    state_name: "Todo",
    state_category: "new",
    parent_key: null,
    url: "",
    start_date: "",
    due_date: "",
    linear_updated_at: "2026-09-01T00:00:00.000Z",
    kermanych_project_id: null,
    task_id: null,
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

function shadowTaskRow() {
  return {
    id: "t1",
    project_id: "p1",
    title: "ENG-42 — Fix it",
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
    jira_key: null,
    linear_key: "ENG-42",
    created_at: "2026-09-02T10:00:00.000Z",
    updated_at: "2026-09-02T10:00:00.000Z",
  };
}
