import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  claimTask,
  createTask,
  deleteTask,
  forceStopTask,
  getTask,
  listTasks,
  patchTask,
  pushTaskStatus,
  REALTIME_IN_FILTER_MAX,
  subscribeTasks,
  tasksFilter,
} from "../src/tasks";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// A PostgrestBuilder is a thenable that collects chained calls; this fake has the same
// shape, so `await client.from(t).update(v).eq(k, v).select(c).maybeSingle()` resolves to
// the n-th queued result while recording every op for assertions.
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
      for (const op of ["select", "insert", "update", "delete", "eq", "in", "is", "order", "single", "maybeSingle"]) {
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

const taskRow = {
  id: "t1",
  project_id: "p1",
  title: "Ship the board",
  description: "columns first",
  status: "backlog" as const,
  assignee_id: null,
  created_by: "u1",
  model: "opus-5",
  prefix: "feature",
  platform: null,
  kind: null,
  branch: "main",
  worktree: true,
  hidden: false,
  created_at: "2026-08-21T00:00:00.000Z",
  updated_at: "2026-08-21T00:10:00.000Z",
};

describe("listTasks", () => {
  it("filters by the project set, orders by creation and maps rows to camelCase", async () => {
    const { client, queries } = fakeClient({ data: [taskRow], error: null });

    const [t] = await listTasks(client, ["p1", "p2"]);
    expect(t).toEqual({
      id: "t1",
      projectId: "p1",
      title: "Ship the board",
      description: "columns first",
      status: "backlog",
      createdBy: "u1",
      model: "opus-5",
      prefix: "feature",
      branch: "main",
      worktree: true,
      hidden: false,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:10:00.000Z",
    });
    expect(queries[0]!.table).toBe("tasks");
    expect(queries[0]!.ops[1]).toEqual(["in", "project_id", ["p1", "p2"]]);
    expect(queries[0]!.ops[2]).toEqual(["order", "created_at", { ascending: true }]);
  });

  it("returns [] without a query for an empty project set", async () => {
    const { client, queries } = fakeClient();
    await expect(listTasks(client, [])).resolves.toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("maps a non-empty image_paths array to imagePaths and omits it when empty", async () => {
    const withImages = { ...taskRow, image_paths: ["p1/a.png", "p1/b.png"] };
    const { client } = fakeClient({ data: [withImages], error: null });
    const [t] = await listTasks(client, ["p1"]);
    expect(t!.imagePaths).toEqual(["p1/a.png", "p1/b.png"]);

    const noImages = fakeClient({ data: [{ ...taskRow, image_paths: [] }], error: null });
    const [t2] = await listTasks(noImages.client, ["p1"]);
    expect(t2!.imagePaths).toBeUndefined();
  });

  it("throws the postgrest message so the UI can toast an RLS refusal", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table tasks" } });
    await expect(listTasks(client, ["p1"])).rejects.toThrow(/permission denied/);
  });
});

describe("getTask", () => {
  it("reads one row by id and maps it", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });
    const t = await getTask(client, "t1");
    expect(t!.projectId).toBe("p1");
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "t1"]);
    expect(queries[0]!.ops.at(-1)).toEqual(["maybeSingle"]);
  });

  it("resolves undefined for an id the caller cannot see", async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(getTask(client, "nope")).resolves.toBeUndefined();
  });
});

describe("createTask", () => {
  it("inserts created_by, trims the title, and omits absent launch params", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });

    await createTask(client, { projectId: "p1", title: "  Ship the board  ", model: "opus-5", createdBy: "u1" });

    expect(queries[0]!.table).toBe("tasks");
    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { project_id: "p1", created_by: "u1", title: "Ship the board", model: "opus-5" },
    ]);
    expect(queries[0]!.ops.at(-1)).toEqual(["single"]);
  });

  it("sends blank optional strings as null and never sends status", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });

    await createTask(client, { projectId: "p1", title: "T", description: "   ", branch: "", createdBy: "u1" });

    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { project_id: "p1", created_by: "u1", title: "T", description: null, branch: null },
    ]);
  });

  it("refuses a blank title before touching the network", async () => {
    const { client, queries } = fakeClient();
    await expect(createTask(client, { projectId: "p1", title: "   ", createdBy: "u1" })).rejects.toThrow(
      /task title is required/,
    );
    expect(queries).toHaveLength(0);
  });

  it("sends assignee_id and image_paths when supplied at creation", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });

    await createTask(client, {
      projectId: "p1",
      title: "T",
      assigneeId: "u2",
      imagePaths: ["p1/shot.png"],
      createdBy: "u1",
    });

    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { project_id: "p1", created_by: "u1", title: "T", assignee_id: "u2", image_paths: ["p1/shot.png"] },
    ]);
  });
});

describe("worktree on a task", () => {
  it("maps the column even when false, unlike the optional text columns", async () => {
    const { client } = fakeClient({ data: { ...taskRow, worktree: false }, error: null });
    const t = await getTask(client, "t1");
    expect(t!.worktree).toBe(false);
  });

  it("sends worktree:false on create — an in-place card is not a blank field", async () => {
    const { client, queries } = fakeClient({ data: { ...taskRow, worktree: false }, error: null });

    await createTask(client, { projectId: "p1", title: "T", worktree: false, createdBy: "u1" });

    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { project_id: "p1", created_by: "u1", title: "T", worktree: false },
    ]);
  });

  it("patches worktree without touching anything else", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });
    await patchTask(client, "t1", { worktree: true });
    expect(queries[0]!.ops[0]).toEqual(["update", { worktree: true }]);
  });
});

// «Приховати з дошки»: a NOT NULL boolean like `worktree`, and read at exactly one place —
// BoardPage's `visibleTasks`. Everything here is about the column surviving the round trip
// intact, because a `hidden` that arrives as `undefined` reads as «visible» and would put a
// card the author hid back onto the team's board.
describe("hidden on a task", () => {
  it("is selected, so a listTasks snapshot agrees with the realtime echo", async () => {
    const { client, queries } = fakeClient({ data: [taskRow], error: null });
    await listTasks(client, ["p1"]);
    const [, columns] = queries[0]!.ops[0] as [string, string];
    expect(columns.split(", ")).toContain("hidden");
  });

  it("maps the column even when true, like every non-nullable flag", async () => {
    const { client } = fakeClient({ data: { ...taskRow, hidden: true }, error: null });
    const t = await getTask(client, "t1");
    expect(t!.hidden).toBe(true);
  });

  it("sends hidden:true on create — the card is off the board from birth", async () => {
    const { client, queries } = fakeClient({ data: { ...taskRow, hidden: true }, error: null });

    await createTask(client, { projectId: "p1", title: "T", hidden: true, createdBy: "u1" });

    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { project_id: "p1", created_by: "u1", title: "T", hidden: true },
    ]);
  });

  it("patches hidden:false without touching anything else — the way back onto the board", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });
    await patchTask(client, "t1", { hidden: false });
    expect(queries[0]!.ops[0]).toEqual(["update", { hidden: false }]);
  });
});

describe("createTask with an explicit id", () => {
  // The one-time publication of local backlog rows reuses the local session id, so a second
  // pass collides on the primary key instead of minting a duplicate card.
  it("sends the id when the caller supplies one", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });

    await createTask(client, { id: "s-1", projectId: "p1", title: "T", createdBy: "u1" });

    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { id: "s-1", project_id: "p1", created_by: "u1", title: "T" },
    ]);
  });

  it("omits the id key entirely when absent", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });
    await createTask(client, { projectId: "p1", title: "T", createdBy: "u1" });
    expect(Object.keys((queries[0]!.ops[0] as [string, Record<string, unknown>])[1])).not.toContain("id");
  });
});

describe("patchTask", () => {
  it("sends only the provided columns, snake-cased", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });

    await patchTask(client, "t1", { title: " New ", description: "  ", platform: "web" });

    expect(queries[0]!.ops[0]).toEqual(["update", { title: "New", description: null, platform: "web" }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "t1"]);
  });

  it("keeps an explicit null assignee as a real null (clear the assignment)", async () => {
    const { client, queries } = fakeClient({ data: { ...taskRow, assignee_id: null }, error: null });
    await patchTask(client, "t1", { assigneeId: null });
    expect(queries[0]!.ops[0]).toEqual(["update", { assignee_id: null }]);
  });

  it("surfaces the tasks_guard refusal verbatim", async () => {
    const { client } = fakeClient({ data: null, error: { message: "task is active" } });
    await expect(patchTask(client, "t1", { assigneeId: "u2" })).rejects.toThrow(/task is active/);
  });
});

describe("claimTask", () => {
  it("builds the atomic `assignee_id is null` predicate and maps the winner", async () => {
    const { client, queries } = fakeClient({ data: { ...taskRow, assignee_id: "u2" }, error: null });

    const t = await claimTask(client, "t1", "u2");

    expect(queries[0]!.ops[0]).toEqual(["update", { assignee_id: "u2" }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "t1"]);
    expect(queries[0]!.ops[2]).toEqual(["is", "assignee_id", null]);
    expect(queries[0]!.ops.at(-1)).toEqual(["maybeSingle"]);
    expect(t!.assigneeId).toBe("u2");
  });

  it("treats zero matched rows as a lost race, not an error", async () => {
    // This is the exact PostgREST answer for `UPDATE … WHERE id = $1 AND assignee_id IS
    // NULL` matching nothing: no data, NO error. Anything else here would make the losing
    // machine report a failure instead of "someone else got it".
    const { client } = fakeClient({ data: null, error: null });
    await expect(claimTask(client, "t1", "u2")).resolves.toBeUndefined();
  });

  it("still throws a genuine postgrest error", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table tasks" } });
    await expect(claimTask(client, "t1", "u2")).rejects.toThrow(/permission denied/);
  });
});

describe("pushTaskStatus", () => {
  it("writes status plus updated_at for one id", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });

    await pushTaskStatus(client, "t1", "thinking", "2026-08-21T01:00:00.000Z");

    expect(queries[0]!.ops[0]).toEqual([
      "update",
      { status: "thinking", updated_at: "2026-08-21T01:00:00.000Z" },
    ]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "t1"]);
  });

  it("throws so the outbox can keep the row and retry", async () => {
    const { client } = fakeClient({ data: null, error: { message: "only the assignee can change status" } });
    await expect(pushTaskStatus(client, "t1", "done", "2026-08-21T01:00:00.000Z")).rejects.toThrow(
      /only the assignee/,
    );
  });
});

describe("forceStopTask", () => {
  it("sends status alone — no updated_at — and maps the row back", async () => {
    const { client, queries } = fakeClient({ data: taskRow, error: null });

    const t = await forceStopTask(client, "t1");

    expect(queries[0]!.table).toBe("tasks");
    expect(queries[0]!.ops[0]).toEqual(["update", { status: "stopped" }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "t1"]);
    expect(queries[0]!.ops[3]).toEqual(["single"]);
    expect(t.id).toBe(taskRow.id);
  });

  it("surfaces the guard refusal when the caller is neither assignee nor owner", async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: "only the assignee can change status" },
    });
    await expect(forceStopTask(client, "t1")).rejects.toThrow(/only the assignee/);
  });
});

describe("deleteTask", () => {
  it("deletes by id and surfaces the guard refusal", async () => {
    const ok = fakeClient({ data: null, error: null });
    await deleteTask(ok.client, "t1");
    expect(ok.queries[0]!.ops).toEqual([["delete"], ["eq", "id", "t1"]]);

    const refused = fakeClient({ data: null, error: { message: "task is active" } });
    await expect(deleteTask(refused.client, "t1")).rejects.toThrow(/task is active/);
  });
});

type Binding = { event: string; config: Record<string, unknown> };

// A RealtimeChannel fake that enforces the two upstream rules this design depends on:
// .on() throws after subscribe(), and removeChannel is the only teardown.
function fakeRealtime() {
  const bindings: Binding[] = [];
  const handlers: ((payload: unknown) => void)[] = [];
  const states: string[] = [];
  const removed: unknown[] = [];
  const channels: string[] = [];
  let subscribed = false;
  let stateCb: ((s: string) => void) | undefined;

  const channel = {
    on(event: string, config: Record<string, unknown>, cb: (payload: unknown) => void) {
      if (subscribed) throw new Error("cannot .on() after subscribe()");
      bindings.push({ event, config });
      handlers.push(cb);
      return channel;
    },
    subscribe(cb?: (s: string) => void) {
      subscribed = true;
      stateCb = cb;
      return channel;
    },
  };

  const client = {
    channel(name: string) {
      channels.push(name);
      return channel;
    },
    removeChannel(c: unknown) {
      removed.push(c);
      return Promise.resolve("ok");
    },
  } as unknown as SupabaseClient;

  return {
    client,
    bindings,
    channels,
    removed,
    states,
    emit: (payload: unknown) => handlers.forEach((h) => h(payload)),
    setState: (s: string) => stateCb?.(s),
  };
}

describe("tasksFilter", () => {
  it("builds one `in` filter for the whole project set", () => {
    expect(tasksFilter(["a"])).toBe("project_id=in.(a)");
    expect(tasksFilter(["a", "b", "c"])).toBe("project_id=in.(a,b,c)");
  });

  it("keeps the filter at exactly the server cap and drops it past it", () => {
    const at = Array.from({ length: REALTIME_IN_FILTER_MAX }, (_, i) => `p${i}`);
    expect(tasksFilter(at)).toContain("project_id=in.(p0,");
    expect(tasksFilter([...at, "p100"])).toBeUndefined();
  });
});

describe("subscribeTasks", () => {
  it("registers exactly one filtered postgres_changes binding before subscribing", () => {
    const rt = fakeRealtime();

    subscribeTasks(rt.client, ["p1", "p2"], () => {});

    expect(rt.channels).toHaveLength(1);
    expect(rt.bindings).toHaveLength(1);
    expect(rt.bindings[0]!.event).toBe("postgres_changes");
    expect(rt.bindings[0]!.config).toEqual({
      event: "*",
      schema: "public",
      table: "tasks",
      filter: "project_id=in.(p1,p2)",
    });
  });

  it("omits the filter key entirely past the 100-project cap", () => {
    const rt = fakeRealtime();
    const many = Array.from({ length: 101 }, (_, i) => `p${i}`);

    subscribeTasks(rt.client, many, () => {});

    expect(rt.bindings[0]!.config).toEqual({ event: "*", schema: "public", table: "tasks" });
  });

  it("opens no channel for an empty project set and returns a usable no-op", () => {
    const rt = fakeRealtime();
    const off = subscribeTasks(rt.client, [], () => {});
    expect(rt.channels).toHaveLength(0);
    expect(() => off()).not.toThrow();
    expect(rt.removed).toHaveLength(0);
  });

  it("maps INSERT and UPDATE payloads into upserts", () => {
    const rt = fakeRealtime();
    const seen: unknown[] = [];
    subscribeTasks(rt.client, ["p1"], (c) => seen.push(c));

    rt.emit({ eventType: "INSERT", new: taskRow, old: {} });
    rt.emit({ eventType: "UPDATE", new: { ...taskRow, status: "thinking" }, old: {} });

    expect(seen).toEqual([
      { kind: "upsert", task: expect.objectContaining({ id: "t1", status: "backlog" }) },
      { kind: "upsert", task: expect.objectContaining({ id: "t1", status: "thinking" }) },
    ]);
  });

  it("tolerates a DELETE payload carrying only the primary key", () => {
    // RLS is not applied to DELETE events and this schema uses the default replica
    // identity, so `old` is `{ id }` and nothing else — mapping it as a task would crash.
    const rt = fakeRealtime();
    const seen: unknown[] = [];
    subscribeTasks(rt.client, ["p1"], (c) => seen.push(c));

    rt.emit({ eventType: "DELETE", new: {}, old: { id: "t1" } });
    rt.emit({ eventType: "DELETE", new: {}, old: {} });

    expect(seen).toEqual([{ kind: "delete", taskId: "t1" }]);
  });

  it("reports every channel state to the optional state callback", () => {
    const rt = fakeRealtime();
    const states: string[] = [];
    subscribeTasks(rt.client, ["p1"], () => {}, (s) => states.push(s));

    rt.setState("SUBSCRIBED");
    rt.setState("CHANNEL_ERROR");
    rt.setState("TIMED_OUT");
    rt.setState("CLOSED");

    expect(states).toEqual(["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);
  });

  it("tears down through removeChannel exactly once per unsubscribe", () => {
    const rt = fakeRealtime();
    const off = subscribeTasks(rt.client, ["p1"], () => {});
    off();
    expect(rt.removed).toHaveLength(1);
  });
});
