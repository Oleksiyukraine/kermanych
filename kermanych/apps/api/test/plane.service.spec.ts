import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@kermanych/core";
import { PlaneService } from "../src/plane/plane.service";
import { PlaneHttpError, type PlaneClient, type PlaneRawIssue } from "../src/plane/plane-client";
import { RegistryService } from "../src/registry/registry.service";
import type { AuthService } from "../src/auth/auth.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";

type Result = { data: unknown; error: { message: string } | null };
type Query = { table: string; ops: [string, ...unknown[]][] };

// Routed by `table:verb` (the query's first builder call), resolved when awaited. A plain
// Result answers every such query; an array is a queue. The sync path touches many tables
// in one pass, and positional scripting would couple the test to call order that is not
// the contract.
function fakeCloud(routes: Record<string, Result | Result[]>) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const builder: Record<string, unknown> = {
        then: (resolve: (v: Result) => unknown) => {
          const route = routes[`${table}:${q.ops[0]?.[0] ?? ""}`];
          const result = (Array.isArray(route) ? route.shift() : route) ?? { data: null, error: null };
          return Promise.resolve(result).then(resolve);
        },
      };
      for (const op of ["select", "insert", "update", "upsert", "delete", "eq", "in", "is", "or", "gte", "lt", "order", "single", "maybeSingle"]) {
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
  site_url: "https://app.plane.so",
  workspace_slug: "acme",
  project_id: "p-uuid",
  project_identifier: "WEB",
  project_name: "Web",
  connected_by: "u1",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
};

const project = {
  id: "p-uuid",
  name: "Web",
  identifier: "WEB",
  estimate: null,
  is_time_tracking_enabled: true,
  is_issue_type_enabled: false,
  member_role: 20,
};

const states = [
  { id: "s-done", name: "Done", group: "completed", sequence: 1, color: "#0f0" },
  { id: "s-todo", name: "Todo", group: "unstarted", sequence: 1, color: "#ccc" },
  { id: "s-backlog", name: "Backlog", group: "backlog", sequence: 1, color: "#aaa" },
  { id: "s-wip", name: "In Progress", group: "started", sequence: 1, color: "#fa0" },
];

function rawItem(id: string, seq: number, updatedAt = "2026-11-04T10:00:00.000Z", over: Partial<PlaneRawIssue> = {}): PlaneRawIssue {
  return {
    id,
    name: `Item ${seq}`,
    description_html: "<h2>Why</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p>check</p></li></ul>",
    priority: "high",
    sequence_id: seq,
    state: { id: "s-wip", name: "In Progress", group: "started", color: "#fa0" },
    assignees: [{ id: "u-plane-1", display_name: "Andrii" }],
    labels: [{ id: "l1", name: "backend" }],
    estimate_point: null,
    parent: null,
    start_date: null,
    target_date: "2026-11-30",
    created_by: { id: "u-plane-2", display_name: "Olha" },
    updated_at: updatedAt,
    ...over,
  };
}

function mirrorRow(issueId: string, key: string, over: Record<string, unknown> = {}) {
  return {
    integration_id: "i1",
    workspace_id: "w1",
    issue_id: issueId,
    key,
    summary: "x",
    description_html: "",
    type_name: "",
    priority: "none",
    labels: [],
    estimate_point_id: null,
    estimate: "",
    original_estimate_seconds: 0,
    time_spent: "",
    time_spent_seconds: 0,
    start_date: "",
    due_date: "",
    assignee_account_id: null,
    assignee_name: null,
    assignee_avatar: null,
    reporter_name: null,
    status_id: "s-todo",
    status_name: "Todo",
    status_category: "new",
    parent_key: null,
    plane_updated_at: "2026-11-04T10:00:00.000Z",
    children_synced_at: null,
    kermanych_project_id: null,
    task_id: null,
    updated_at: "2026-11-04T10:00:00.000Z",
    ...over,
  };
}

function scriptedPlaneClient(overrides: Partial<Record<keyof PlaneClient, unknown>> = {}): PlaneClient {
  return {
    me: vi.fn(async () => ({ id: "u-plane-1", display_name: "Andrii" })),
    listProjects: vi.fn(async () => [project]),
    getProject: vi.fn(async () => project),
    listStates: vi.fn(async () => states),
    listLabels: vi.fn(async () => [{ id: "l1", name: "Backend", color: "#f00" }]),
    createLabel: vi.fn(async (_p: string, name: string) => ({ id: `new-${name}`, name })),
    listMembers: vi.fn(async () => [{ id: "u-plane-1", display_name: "Andrii" }, { id: "u-plane-2", display_name: "Olha" }]),
    listIssues: vi.fn(async () => [rawItem("a", 42)]),
    getIssue: vi.fn(async (_p: string, id: string) => rawItem(id, 42)),
    getIssueByKey: vi.fn(async () => rawItem("a", 42)),
    createIssue: vi.fn(async () => rawItem("new", 43)),
    updateIssue: vi.fn(async () => ({})),
    deleteIssue: vi.fn(async () => undefined),
    listComments: vi.fn(async () => []),
    addComment: vi.fn(async () => ({})),
    listAttachments: vi.fn(async () => []),
    listWorklogs: vi.fn(async () => []),
    addWorklog: vi.fn(async () => ({})),
    updateWorklog: vi.fn(async () => ({})),
    deleteWorklog: vi.fn(async () => undefined),
    totalWorklogs: vi.fn(async () => []),
    getEstimate: vi.fn(async () => undefined),
    listEstimatePoints: vi.fn(async () => []),
    listIssueTypes: vi.fn(async () => []),
    ...overrides,
  } as unknown as PlaneClient;
}

let dir: string;
let registry: RegistryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plane-svc-"));
  registry = new RegistryService(join(dir, "test.sqlite"));
  registry.setPlaneToken("https://app.plane.so", "acme", "u1", "tok", "u-plane-1", "Andrii");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(cloud: SupabaseClient, planeClient: PlaneClient, supervisor?: Partial<SupervisorService>) {
  const auth = { cloudClient: () => cloud } as unknown as AuthService;
  return new PlaneService(registry, auth, (supervisor ?? {}) as SupervisorService, () => planeClient);
}

const freshState = { data: { integration_id: "i1", workspace_id: "w1", last_synced_at: null, sync_cursor: null }, error: null };

function rowsOf(queries: Query[], table: string, verb: string): Record<string, unknown>[] {
  return queries
    .filter((q) => q.table === table && q.ops[0]![0] === verb)
    .flatMap((q) => {
      const payload = q.ops[0]![1];
      return (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
    });
}

describe("sync", () => {
  it("does nothing when another client already holds the lease", async () => {
    const { client, queries } = fakeCloud({
      "workspace_plane_integrations:select": { data: integrationRow, error: null },
      "plane_sync_state:update": { data: [], error: null }, // lease lost: zero updated rows
    });
    const plane = scriptedPlaneClient();
    expect(await service(client, plane).sync("i1", "u1")).toEqual({ synced: false });
    expect(plane.listIssues).not.toHaveBeenCalled();
    expect(queries.filter((q) => q.table === "plane_issues")).toEqual([]);
  });

  it("never takes the lease for a member without a key — the members who have one must poll", async () => {
    const { client, queries } = fakeCloud({ "workspace_plane_integrations:select": { data: integrationRow, error: null } });
    await expect(service(client, scriptedPlaneClient()).sync("i1", "u2")).rejects.toThrow(/no plane token/);
    expect(queries.filter((q) => q.table === "plane_sync_state")).toEqual([]);
  });

  it("full sync lays out the columns, mirrors the items, reconciles deletions and advances the cursor", async () => {
    const { client, queries } = fakeCloud({
      "workspace_plane_integrations:select": { data: integrationRow, error: null },
      "plane_sync_state:select": freshState,
      "plane_issues:select": { data: [mirrorRow("a", "WEB-42"), mirrorRow("gone", "WEB-99")], error: null },
    });
    const plane = scriptedPlaneClient();
    expect(await service(client, plane).sync("i1", "u1", true)).toEqual({ synced: true });

    // One column per state, in group order.
    expect(rowsOf(queries, "plane_columns", "insert").map((r) => [r.name, r.state_group])).toEqual([
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["Done", "completed"],
    ]);

    const [row] = rowsOf(queries, "plane_issues", "upsert");
    expect(row).toMatchObject({
      issue_id: "a",
      key: "WEB-42",
      status_id: "s-wip",
      status_category: "indeterminate",
      assignee_account_id: "u-plane-1",
      reporter_name: "Olha",
      labels: ["backend"],
      due_date: "2026-11-30",
    });

    const del = queries.find((q) => q.table === "plane_issues" && q.ops[0]![0] === "delete");
    expect(del!.ops).toContainEqual(["in", "issue_id", ["gone"]]);

    expect(rowsOf(queries, "plane_sync_state", "update")).toContainEqual({ sync_cursor: "2026-11-04T10:00:00.000Z" });

    // The never-refreshed item gets its children now — the removed one does not.
    expect(plane.listComments).toHaveBeenCalledTimes(1);
    expect(plane.listComments).toHaveBeenCalledWith("p-uuid", "a");
    expect(plane.listWorklogs).toHaveBeenCalledWith("p-uuid", "a");
    expect(rowsOf(queries, "plane_issues", "update")).toContainEqual({ children_synced_at: expect.any(String) });
  });

  it("refreshes children for at most five items per tick", async () => {
    const { client } = fakeCloud({
      "workspace_plane_integrations:select": { data: integrationRow, error: null },
      "plane_sync_state:select": freshState,
      "plane_issues:select": { data: [], error: null },
    });
    const many = Array.from({ length: 8 }, (_, n) => rawItem(`i${n}`, n + 1));
    const plane = scriptedPlaneClient({ listIssues: vi.fn(async () => many) });
    await service(client, plane).sync("i1", "u1", true);
    expect(plane.listComments).toHaveBeenCalledTimes(5);
  });

  it("reads incrementally down to one minute before the cursor and stops there", async () => {
    const { client, queries } = fakeCloud({
      "workspace_plane_integrations:select": { data: integrationRow, error: null },
      "plane_sync_state:select": {
        data: { integration_id: "i1", workspace_id: "w1", last_synced_at: null, sync_cursor: "2026-11-04T10:00:00.000Z" },
        error: null,
      },
      "plane_sync_state:update": { data: [{ integration_id: "i1" }], error: null }, // lease won
      "plane_issues:select": { data: [], error: null },
    });
    const fresh = rawItem("new", 1, "2026-11-04T10:05:00.000Z");
    const boundary = rawItem("edge", 2, "2026-11-04T09:59:30.000Z");
    const old = rawItem("old", 3, "2026-11-04T09:00:00.000Z");
    const listIssues = vi.fn(async () => [fresh, boundary, old]);
    const svc = service(client, scriptedPlaneClient({ listIssues }));

    await svc.sync("i1", "u1", true); // the first tick of a process is a sweep
    queries.length = 0;
    await svc.sync("i1", "u1");

    const stop = listIssues.mock.calls[1]![1] as (page: PlaneRawIssue[]) => boolean;
    expect(stop([fresh, boundary])).toBe(false);
    expect(stop([fresh, old])).toBe(true);
    const upserted = rowsOf(queries, "plane_issues", "upsert").map((r) => r.issue_id);
    expect(upserted).toEqual(["new", "edge"]);
    expect(rowsOf(queries, "plane_sync_state", "update")).toContainEqual({ sync_cursor: "2026-11-04T10:05:00.000Z" });
  });

  it("queues a child refresh when an item's worklog total moved, and rewrites its logged time", async () => {
    const { client, queries } = fakeCloud({
      "workspace_plane_integrations:select": { data: integrationRow, error: null },
      "plane_sync_state:select": freshState,
      // Children current as of after the item's last change — only the total says otherwise.
      "plane_issues:select": { data: [mirrorRow("a", "WEB-42", { children_synced_at: "2026-11-04T10:01:00.000Z" })], error: null },
    });
    const plane = scriptedPlaneClient({ totalWorklogs: vi.fn(async () => [{ issue_id: "a", duration: 90 }]) });
    await service(client, plane).sync("i1", "u1", true);
    expect(plane.listWorklogs).toHaveBeenCalledWith("p-uuid", "a");
    expect(rowsOf(queries, "plane_issues", "upsert")).toContainEqual(
      expect.objectContaining({ issue_id: "a", time_spent: "1h 30m", time_spent_seconds: 5400 }),
    );
  });

  it("ends a tick quietly when Plane's budget is spent", async () => {
    const { client } = fakeCloud({
      "workspace_plane_integrations:select": { data: integrationRow, error: null },
      "plane_sync_state:select": freshState,
    });
    const plane = scriptedPlaneClient({
      listIssues: vi.fn(async () => {
        throw new PlaneHttpError(429, "RATE_LIMIT_EXCEEDED");
      }),
    });
    expect(await service(client, plane).sync("i1", "u1", true)).toEqual({ synced: false, rateLimited: true });
  });
});

describe("authoring", () => {
  const routes = () => ({
    "workspace_plane_integrations:select": { data: integrationRow, error: null },
    "plane_issues:select": {
      data: [
        mirrorRow("a", "WEB-42", { children_synced_at: "2026-11-04T10:01:00.000Z" }),
        mirrorRow("par", "WEB-7"),
      ],
      error: null,
    },
  });

  it("spells a draft the way Plane's PATCH expects", async () => {
    const { client } = fakeCloud(routes());
    const createLabel = vi.fn(async (_p: string, name: string) => {
      if (name === "nope") throw new PlaneHttpError(400, "bad label");
      return { id: `new-${name}`, name };
    });
    const plane = scriptedPlaneClient({ createLabel });
    await service(client, plane).editIssue(
      "i1",
      "WEB-42",
      {
        // Matched case-insensitively; a missing one is created; a refused one is dropped.
        labels: ["backend", "frontend", "nope", "BACKEND"],
        assigneeAccountId: null,
        dueDate: "",
        startDate: "2026-11-01",
        parentKey: "WEB-7",
        estimatePointId: null,
        priority: "urgent",
        description: "- [ ] check",
      },
      "u1",
    );
    expect(plane.updateIssue).toHaveBeenCalledWith("p-uuid", "a", {
      labels: ["l1", "new-frontend"],
      assignees: [],
      target_date: null,
      start_date: "2026-11-01",
      parent: "par",
      estimate_point: null,
      priority: "urgent",
      description_html: expect.stringContaining('data-type="taskList"'),
    });
  });

  it("sets the one assignee as Plane's whole set and detaches a parent with a blank key", async () => {
    const { client } = fakeCloud(routes());
    const plane = scriptedPlaneClient();
    await service(client, plane).editIssue("i1", "WEB-42", { assigneeAccountId: "u-plane-2", parentKey: "" }, "u1");
    expect(plane.updateIssue).toHaveBeenCalledWith("p-uuid", "a", { assignees: ["u-plane-2"], parent: null });
  });

  it("keeps a field edit off the child-refresh queue when the children were current", async () => {
    const { client, queries } = fakeCloud(routes());
    const plane = scriptedPlaneClient();
    const issue = await service(client, plane).transition("i1", "WEB-42", "s-done", "u1");
    expect(plane.updateIssue).toHaveBeenCalledWith("p-uuid", "a", { state: "s-done" });
    // One read of the item, no comment/attachment/worklog reads.
    expect(plane.getIssue).toHaveBeenCalledTimes(1);
    expect(plane.listComments).not.toHaveBeenCalled();
    expect(rowsOf(queries, "plane_issues", "update")).toContainEqual({ children_synced_at: expect.any(String) });
    expect(issue.key).toBe("WEB-42");
  });

  it("logs work in Plane's minutes and refuses an unreadable duration before any request", async () => {
    const { client } = fakeCloud(routes());
    const plane = scriptedPlaneClient();
    const svc = service(client, plane);
    await svc.logWork("i1", "WEB-42", { timeSpent: "1.5h", description: " pairing " }, "u1");
    expect(plane.addWorklog).toHaveBeenCalledWith("p-uuid", "a", { duration: 90, description: "pairing" });

    await expect(svc.logWork("i1", "WEB-42", { timeSpent: "soon" }, "u1")).rejects.toThrow(/unreadable duration/);
    expect(plane.addWorklog).toHaveBeenCalledTimes(1);
  });

  it("offers every other state as a transition, in board order", async () => {
    const { client } = fakeCloud({
      "workspace_plane_integrations:select": { data: integrationRow, error: null },
      "plane_issues:select": { data: [mirrorRow("a", "WEB-42", { status_id: "s-wip" })], error: null },
    });
    const transitions = await service(client, scriptedPlaneClient()).listTransitions("i1", "WEB-42", "u1");
    expect(transitions.map((t) => [t.id, t.to.statusCategory.key])).toEqual([
      ["s-backlog", "new"],
      ["s-todo", "new"],
      ["s-done", "done"],
    ]);
  });
});

describe("editorOptions", () => {
  const routes = () => ({ "workspace_plane_integrations:select": { data: integrationRow, error: null } });

  it("lets a project admin touch anyone's worklog when time tracking answers", async () => {
    const { client } = fakeCloud(routes());
    const options = await service(client, scriptedPlaneClient()).editorOptions("i1", "u1");
    expect(options.priorities[0]).toEqual({ id: "urgent", name: "Urgent" });
    expect(options.states.map((s) => s.id)).toEqual(["s-backlog", "s-todo", "s-wip", "s-done"]);
    expect(options.timeTrackingEnabled).toBe(true);
    expect(options.myAccountId).toBe("u-plane-1");
    expect(options.worklog).toEqual({ editOwn: true, deleteOwn: true, editAll: true, deleteAll: true });
  });

  it("hides time tracking when the worklog route is not there (Community, or no plan)", async () => {
    const { client } = fakeCloud(routes());
    const plane = scriptedPlaneClient({
      totalWorklogs: vi.fn(async () => {
        throw new PlaneHttpError(404, "Page not found");
      }),
    });
    const options = await service(client, plane).editorOptions("i1", "u1");
    expect(options.timeTrackingEnabled).toBe(false);
    expect(options.worklog).toEqual({ editOwn: false, deleteOwn: false, editAll: false, deleteAll: false });
  });

  it("offers the active estimate's points and its type", async () => {
    const { client } = fakeCloud(routes());
    const plane = scriptedPlaneClient({
      getProject: vi.fn(async () => ({ ...project, estimate: "est1", member_role: 15 })),
      getEstimate: vi.fn(async () => ({ id: "est1", type: "time" })),
      listEstimatePoints: vi.fn(async () => [
        { id: "ep2", key: 2, value: "120" },
        { id: "ep1", key: 1, value: "60" },
      ]),
    });
    const options = await service(client, plane).editorOptions("i1", "u1");
    expect(options.estimateType).toBe("time");
    expect(options.estimatePoints).toEqual([
      { id: "ep1", value: "60" },
      { id: "ep2", value: "120" },
    ]);
    // A member, not an admin: own entries only.
    expect(options.worklog).toEqual({ editOwn: true, deleteOwn: true, editAll: false, deleteAll: false });
  });
});

describe("setToken", () => {
  it("refuses to store a key Plane rejects", async () => {
    const { client } = fakeCloud({});
    const plane = scriptedPlaneClient({
      me: vi.fn(async () => {
        throw new PlaneHttpError(401, "Given API token is not valid");
      }),
    });
    await expect(service(client, plane).setToken("app.plane.so", "acme", "bad", "u3")).rejects.toThrow(/not valid/);
    expect(registry.getPlaneToken("https://app.plane.so", "acme", "u3")).toBeUndefined();
  });

  it("stores the key with its Plane identity under the normalised site and slug", async () => {
    const { client } = fakeCloud({});
    const plane = scriptedPlaneClient({ me: vi.fn(async () => ({ id: "u-plane-9", first_name: "Dev", last_name: "One" })) });
    const res = await service(client, plane).setToken("api.plane.so", "/acme/", "tok2", "u3");
    expect(res).toEqual({ displayName: "Dev One" });
    expect(plane.listProjects).toHaveBeenCalled();
    expect(registry.getPlaneToken("https://app.plane.so", "acme", "u3")).toEqual({
      apiToken: "tok2",
      planeUserId: "u-plane-9",
      displayName: "Dev One",
    });
  });
});

describe("launch", () => {
  const routes = () => ({
    "workspace_plane_integrations:select": { data: integrationRow, error: null },
    "tasks:insert": { data: shadowTaskRow(), error: null },
    "plane_issues:select": { data: [mirrorRow("a", "WEB-42")], error: null },
  });

  it("creates the shadow task, starts the session, binds the item, then moves it", async () => {
    const order: string[] = [];
    const { client, queries } = fakeCloud(routes());
    const plane = scriptedPlaneClient({
      updateIssue: vi.fn(async () => {
        order.push("move");
        return {};
      }),
    });
    const supervisor = {
      createSessionFromTask: vi.fn(async () => {
        order.push("session");
        return { id: "s1" } as Session;
      }),
    };
    const res = await service(client, plane, supervisor).launch("i1", "WEB-42", "p1", "u1", "s-wip");
    expect(res).toEqual({ session: { id: "s1" } });
    expect(order).toEqual(["session", "move"]);
    expect(plane.updateIssue).toHaveBeenCalledWith("p-uuid", "a", { state: "s-wip" });

    const task = rowsOf(queries, "tasks", "insert")[0]!;
    expect(task.title).toBe("WEB-42 — Item 42");
    // The ticket's HTML arrives as markdown, task list and all.
    expect(task.description).toBe("## Why\n\n- [ ] check");
    expect(task.plane_key).toBe("WEB-42");
    expect(task.assignee_id).toBe("u1");
    expect(rowsOf(queries, "plane_issues", "update")).toContainEqual({ kermanych_project_id: "p1", task_id: "t1" });
  });

  it("keeps the session and reports a refused move as a warning, not a failure", async () => {
    const { client } = fakeCloud(routes());
    const plane = scriptedPlaneClient({
      updateIssue: vi.fn(async () => {
        throw new PlaneHttpError(400, "State is not valid please pass a valid state_id");
      }),
    });
    const supervisor = { createSessionFromTask: vi.fn(async () => ({ id: "s1" }) as Session) };
    const res = await service(client, plane, supervisor).launch("i1", "WEB-42", "p1", "u1", "bogus");
    expect(res.session).toEqual({ id: "s1" });
    expect(res.transitionError).toBe("State is not valid please pass a valid state_id");
  });
});

function shadowTaskRow() {
  return {
    id: "t1",
    project_id: "p1",
    title: "WEB-42 — Item 42",
    description: "## Why\n\n- [ ] check",
    status: "backlog",
    assignee_id: "u1",
    created_by: "u1",
    model: null,
    effort: null,
    prefix: null,
    worktree: true,
    kind: null,
    branch: null,
    image_paths: null,
    jira_key: null,
    linear_key: null,
    plane_key: "WEB-42",
    created_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:00:00.000Z",
  };
}
