# Team cloud — shared task board (Plan C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared cloud task board — `packages/cloud/src/tasks.ts` (queries + Realtime), `apps/ui/src/stores/board.ts` (tasks state, invariants, optimistic writes), `apps/ui/src/pages/BoardPage.vue` with status columns at `/board`, and the WorkspacePage seam that shows a local session's cloud task title.

**Architecture:** The board is a cloud-only read/write surface. `packages/cloud/src/tasks.ts` owns the snake_case↔camelCase boundary and every PostgREST call; nothing outside `@kermanych/cloud` sees a Postgres column name. `stores/board.ts` holds the task list, ONE Realtime channel with ONE `postgres_changes` binding, and the invariant pre-checks; it refetches in full on every (re)subscribe so a missed event can never leave the board stale. `BoardPage.vue` renders five status columns over the ten `SessionStatus` values. Execution stays local: the board reserves a «Запустити» button and an inert `launch()` seam that Plan D replaces.

**Tech Stack:** `@supabase/supabase-js` 2.112.3 (inside `packages/cloud` only), vitest (`packages/cloud`), Quasar/Vue 3 + Pinia setup stores, `@kermanych/core` (`SessionStatus`, `ACTIVE_STATUSES`), `@kermanych/tokens` CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-08-21-team-cloud-design.md` — this plan implements Requirement 4 (shared board: create/assign/describe/launch params + live Realtime), the UI half of Requirement 8 (an active task cannot be reassigned or deleted), and Deviation D6 (the board is a NEW page).

**Sibling plans this one depends on (all assumed merged):**

- **Plan A** — `docs/superpowers/plans/2026-08-21-team-cloud-foundation-auth.md`: `supabase/migrations/**` (the `tasks` table, `task_status` enum, `tasks_guard()`, RLS, `tasks` in the `supabase_realtime` publication), `packages/cloud` skeleton (`src/index.ts`, `src/types.ts`, `src/client.ts`, `src/status.ts`), `stores/auth.ts`, `pages/LoginPage.vue`, `router/index.ts` guard, the `Authorization: Bearer` work in `lib/api.ts`.
- **Plan B** — `docs/superpowers/plans/2026-08-21-team-cloud-projects-binding.md`: `Group` → `Project` cutover in `packages/core`, the SQLite `user_version` 0→1 migration, `packages/cloud/src/projects.ts`, `apps/ui/src/stores/projects.ts` (`useProjects`), the renamed `useOrchestrator` local-project state, `api.setProjectBinding`.
- **Plan D** — `docs/superpowers/plans/2026-08-21-team-cloud-status-sync.md`: `status_outbox`, `CloudSyncService`, `POST /api/sessions/from-task`, and the real body of this plan's `launch()` seam plus the offline banner and the stale-age threshold.

## Global Constraints

- All paths in this plan are relative to the `kermanych/` package root (the pnpm workspace root) — e.g. `apps/ui/src/stores/board.ts`.
- Node ≥22.12; pnpm pinned via `packageManager` (`pnpm@10.33.2`).
- Code, identifiers, comments and commit messages in English; every UI-visible string in Ukrainian. No i18n layer — copy is inline (spec non-goal).
- `packages/cloud` HAS vitest (`test/**/*.spec.ts`, config at `packages/cloud/vitest.config.ts`), so its tasks are TDD. `apps/ui` has NO component-test harness (its only spec is `test/socket.spec.ts`; there is no vitest config and Quasar's `#q-app/*`, `stores/*`, `components/*` aliases do not resolve under bare vitest) — every UI task is verified by `pnpm dev:api` + `pnpm dev:ui` against stated observable expectations plus `vue-tsc --noEmit`.
- RLS + `tasks_guard()` are the ONLY authorization surface. Every pre-check in the UI is UX, never security; the server refusal must still be rendered.
- No secret VALUES anywhere near the cloud. This plan touches `tasks` only and never reads or writes `.env`.
- Design tokens only in CSS — `var(--k-canvas | --k-bg | --k-surface | --k-surface2 | --k-line | --k-line-strong | --k-text | --k-muted | --k-accent | --k-diff | --k-font-ui | --k-font-mono)` (`packages/tokens/src/tokens.css`). No raw hex, no new colours.
- **Realtime contract — source-verified against `@supabase/supabase-js` 2.112.3, do not deviate:**
  - ONE channel, ONE `postgres_changes` binding, `filter: 'project_id=in.(<uuid>,…)'`. The server caps an `in` filter at **100** values; beyond that DROP the filter and rely on the `tasks` SELECT policy (RLS is enforced per subscriber for `postgres_changes`). This fallback is implemented in code, not described in prose.
  - Bindings MUST be registered BEFORE `subscribe()` — `.on()` throws afterwards. Never register the same filter twice on one channel (duplicates are silently dropped).
  - Tear down with `client.removeChannel(channel)`.
  - NEVER call `realtime.setAuth` — supabase-js propagates the token itself from `onAuthStateChange`; pinning it would disable that refresh.
  - Channel states reported to the `subscribe()` callback: `SUBSCRIBED` | `TIMED_OUT` | `CLOSED` | `CHANNEL_ERROR`. They drive the `offline` flag.
  - RLS is NOT applied to `DELETE` events, and this schema uses the default replica identity (no `replica identity full`), so a DELETE payload's `old` carries ONLY the primary key. The store must tolerate that.
  - `.is('assignee_id', null)` + `.select().maybeSingle()` is a genuine atomic claim; zero matched rows yield `{ data: null, error: null }` — the lost-race signal, NOT an error.
- **Ownership.** No task in this plan edits `apps/api/**`, `packages/core/**`, `apps/ui/src/lib/api.ts`, `apps/ui/src/stores/projects.ts`, `apps/ui/src/stores/auth.ts`, `supabase/**`, or `packages/cloud/src/{types,client,status,projects}.ts`. `packages/cloud/src/index.ts` receives exactly ONE appended barrel line (declared as a coordinated edit, not as file ownership).

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `packages/cloud/src/tasks.ts` | Every `tasks` query + the Realtime subscription; the snake_case↔camelCase boundary for tasks. | **Create** (Tasks 1-2) |
| `packages/cloud/test/tasks.spec.ts` | Unit suite over a hand-rolled fake client — no network, no `supabase start`. | **Create** (Tasks 1-2) |
| `packages/cloud/src/index.ts` | Barrel. Gains ONE line: `export * from "./tasks";`. | Coordinated append (Task 1) |
| `apps/ui/src/stores/board.ts` | Cloud TASKS + Realtime lifecycle. Consumes `useProjects()`; owns no project state. | **Create** (Tasks 3-4) |
| `apps/ui/src/pages/BoardPage.vue` | Five status columns, task cards, create/edit modal, assign control, reserved «Запустити». | **Create** (Tasks 5-6) |
| `apps/ui/src/router/routes.ts` | `/board` named child of `MainLayout`. | Modify (Task 5) |
| `apps/ui/src/pages/WorkspacePage.vue` | Header link to `/board`; local rows show their cloud task title. | Modify, surgical (Task 7) |

`tasks.ts` is split across two tasks (queries, then Realtime) because the two halves fail differently and a reviewer can reject one while approving the other: the queries are pure request-shaping, the subscription is lifecycle plumbing with an upstream API contract. `stores/board.ts` splits the same way (state + writes, then lifecycle). `BoardPage.vue` splits into "renders the board" and "mutates the board" so the first commit is already a usable read-only screen.

---

### Task 1: `packages/cloud/src/tasks.ts` — row mapping and queries

**Files:**
- Create: `packages/cloud/src/tasks.ts`
- Create: `packages/cloud/test/tasks.spec.ts`
- Modify: `packages/cloud/src/index.ts` (append ONE line)

**Interfaces:**
- Consumes: `Task`, `TaskInsert`, `TaskPatch`, `TaskStatus` from Plan A's `packages/cloud/src/types.ts`; `SupabaseClient` from `@supabase/supabase-js`; the `tasks` table, the `tasks_guard()` trigger and the four `tasks` RLS policies from Plan A's `supabase/migrations`.
- Produces:
  - `listTasks(client: SupabaseClient, projectIds: string[]): Promise<Task[]>`
  - `getTask(client: SupabaseClient, id: string): Promise<Task | undefined>`
  - `createTask(client: SupabaseClient, input: TaskInsert & { createdBy: string }): Promise<Task>`
  - `patchTask(client: SupabaseClient, id: string, patch: TaskPatch): Promise<Task>`
  - `assignTask(client: SupabaseClient, id: string, assigneeId: string | null): Promise<Task>`
  - `claimTask(client: SupabaseClient, id: string, userId: string): Promise<Task | undefined>` (`undefined` = lost the race)
  - `pushTaskStatus(client: SupabaseClient, id: string, status: TaskStatus, updatedAt: string): Promise<void>`
  - `deleteTask(client: SupabaseClient, id: string): Promise<void>`
  - `toTask(row)` / `toTaskRow(patch)` — exported for the tests and for Task 2's Realtime payload mapping.
- Coordinated edit: `packages/cloud/src/index.ts` gains `export * from "./tasks";`. Plan A ships that file with exactly three lines (`./types`, `./client`, `./status`) and cannot forward-declare a module that does not exist yet, so each module's author appends its own barrel line — Plan B appended `./projects`, this task appends `./tasks`. Change nothing else in that file.
- **Two functions beyond the spec's list, both required by a sibling and declared here:** `getTask` is consumed by Plan D's `SupervisorService.createSessionFromTask` (its Interfaces block names it verbatim); `deleteTask` is the other half of Requirement 8 ("an active task cannot be reassigned **or deleted**") — without it the guard's delete branch is unreachable from the product.

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/test/tasks.spec.ts`. The fake client is the same shape Plan B's `test/projects.spec.ts` uses — a `PostgrestBuilder` is a thenable that collects chained calls, so this fake records every op and resolves to a queued result. Convention: `describe`/`it`, double quotes, relative `../src/<module>` import.

```ts
// packages/cloud/test/tasks.spec.ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assignTask,
  claimTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  patchTask,
  pushTaskStatus,
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

describe("assignTask", () => {
  it("updates assignee_id for the given id", async () => {
    const { client, queries } = fakeClient({ data: { ...taskRow, assignee_id: "u2" }, error: null });

    const t = await assignTask(client, "t1", "u2");

    expect(queries[0]!.ops[0]).toEqual(["update", { assignee_id: "u2" }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "t1"]);
    expect(t.assigneeId).toBe("u2");
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

describe("deleteTask", () => {
  it("deletes by id and surfaces the guard refusal", async () => {
    const ok = fakeClient({ data: null, error: null });
    await deleteTask(ok.client, "t1");
    expect(ok.queries[0]!.ops).toEqual([["delete"], ["eq", "id", "t1"]]);

    const refused = fakeClient({ data: null, error: { message: "task is active" } });
    await expect(deleteTask(refused.client, "t1")).rejects.toThrow(/task is active/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kermanych/cloud exec vitest run test/tasks.spec.ts`
Expected: FAIL — `Cannot find module '../src/tasks'`.

- [ ] **Step 3: Implement the module**

Create `packages/cloud/src/tasks.ts`:

```ts
// packages/cloud/src/tasks.ts
// The shared task board's data access. This file owns the snake_case <-> camelCase boundary
// for `tasks`: nothing outside @kermanych/cloud ever sees a Postgres column name. Every
// call runs under the caller's JWT, so the RLS policies and tasks_guard() — not this code —
// are the authorization surface; refusals surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task, TaskInsert, TaskPatch, TaskStatus } from "./types";

const TASK_COLUMNS =
  "id, project_id, title, description, status, assignee_id, created_by, model, prefix, platform, kind, branch, created_at, updated_at";

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee_id: string | null;
  created_by: string;
  model: string | null;
  prefix: string | null;
  platform: string | null;
  kind: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
};

export function toTask(row: TaskRow): Task {
  const t: Task = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // Optional keys are omitted rather than set to undefined, so a mapped task deep-equals a
  // hand-written literal in tests and carries no null noise into Vue's reactivity.
  if (row.description !== null) t.description = row.description;
  if (row.assignee_id !== null) t.assigneeId = row.assignee_id;
  if (row.model !== null) t.model = row.model;
  if (row.prefix !== null) t.prefix = row.prefix;
  if (row.platform !== null) t.platform = row.platform;
  if (row.kind !== null) t.kind = row.kind;
  if (row.branch !== null) t.branch = row.branch;
  return t;
}

// Only the keys actually present in the patch are sent, so a partial edit never nulls a
// column the user did not touch. An empty text value means "clear it" -> NULL; an explicit
// `assigneeId: null` is the "unassign" signal and must survive as a real null.
export function toTaskRow(patch: TaskPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title.trim();
  if (patch.description !== undefined) row.description = patch.description.trim() || null;
  if (patch.assigneeId !== undefined) row.assignee_id = patch.assigneeId;
  if (patch.model !== undefined) row.model = patch.model.trim() || null;
  if (patch.prefix !== undefined) row.prefix = patch.prefix.trim() || null;
  if (patch.platform !== undefined) row.platform = patch.platform.trim() || null;
  if (patch.kind !== undefined) row.kind = patch.kind.trim() || null;
  if (patch.branch !== undefined) row.branch = patch.branch.trim() || null;
  return row;
}

export async function listTasks(client: SupabaseClient, projectIds: string[]): Promise<Task[]> {
  // `in.()` with an empty list is not valid postgrest syntax, and there is nothing to ask
  // for anyway: a member of no project sees no tasks.
  if (projectIds.length === 0) return [];
  const { data, error } = await client
    .from("tasks")
    .select(TASK_COLUMNS)
    .in("project_id", projectIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as TaskRow[]).map(toTask);
}

// `undefined` means "no row this caller may see" — either the id does not exist or the
// tasks SELECT policy filtered it out. Both are the same thing to a client.
export async function getTask(client: SupabaseClient, id: string): Promise<Task | undefined> {
  const { data, error } = await client.from("tasks").select(TASK_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toTask(data as TaskRow) : undefined;
}

export async function createTask(
  client: SupabaseClient,
  input: TaskInsert & { createdBy: string },
): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Error("task title is required");
  // `created_by` must equal auth.uid() or the tasks INSERT policy refuses the row. The
  // caller passes the signed-in user's id instead of this file reading a session, because
  // apps/api builds a per-request client with `persistSession: false` and has no session.
  // `status` is deliberately absent: the column defaults to 'backlog'.
  const row: Record<string, unknown> = {
    project_id: input.projectId,
    created_by: input.createdBy,
    title,
    ...toTaskRow({
      description: input.description,
      assigneeId: input.assigneeId,
      model: input.model,
      prefix: input.prefix,
      platform: input.platform,
      kind: input.kind,
      branch: input.branch,
    }),
  };
  const { data, error } = await client.from("tasks").insert(row).select(TASK_COLUMNS).single();
  if (error) throw new Error(error.message);
  return toTask(data as TaskRow);
}

export async function patchTask(client: SupabaseClient, id: string, patch: TaskPatch): Promise<Task> {
  const { data, error } = await client
    .from("tasks")
    .update(toTaskRow(patch))
    .eq("id", id)
    .select(TASK_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toTask(data as TaskRow);
}

// Assignment has its own name because it is the one edit tasks_guard refuses on an active
// task (message `task is active`); a dedicated call keeps that refusal legible at the call
// site. `null` clears the assignment.
export function assignTask(client: SupabaseClient, id: string, assigneeId: string | null): Promise<Task> {
  return patchTask(client, id, { assigneeId });
}

// Atomic self-assign: one `UPDATE tasks SET assignee_id = $1 WHERE id = $2 AND assignee_id
// IS NULL`. Zero matched rows come back as `{ data: null, error: null }` — that is what
// maybeSingle means — and it is the "someone else claimed it first" signal, NOT an error.
export async function claimTask(
  client: SupabaseClient,
  id: string,
  userId: string,
): Promise<Task | undefined> {
  const { data, error } = await client
    .from("tasks")
    .update({ assignee_id: userId })
    .eq("id", id)
    .is("assignee_id", null)
    .select(TASK_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toTask(data as TaskRow) : undefined;
}

// Local -> cloud status mirror, called by apps/api's CloudSyncService under the user's JWT
// (Plan D). `updated_at` travels with the push even though tasks_guard overwrites it with
// now() on every UPDATE: the outbox row carries the moment the LOCAL session actually
// changed, so the payload stays self-describing and the retry is idempotent.
export async function pushTaskStatus(
  client: SupabaseClient,
  id: string,
  status: TaskStatus,
  updatedAt: string,
): Promise<void> {
  const { error } = await client.from("tasks").update({ status, updated_at: updatedAt }).eq("id", id);
  if (error) throw new Error(error.message);
}

// tasks_guard refuses a delete while old.status is active (`task is active`), which is the
// other half of Requirement 8.
export async function deleteTask(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("tasks").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 4: Append the barrel line**

Add ONE line to the end of `packages/cloud/src/index.ts`, after Plan A's three (`./types`, `./client`, `./status`) and Plan B's `./projects`:

```ts
export * from "./tasks";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kermanych/cloud exec vitest run test/tasks.spec.ts`
Expected: PASS — 16 tests.

- [ ] **Step 6: Typecheck and build the package**

Run: `pnpm --filter @kermanych/cloud exec tsc -p tsconfig.json --noEmit && pnpm --filter @kermanych/cloud build`
Expected: no type errors. The build is REQUIRED — `apps/ui` resolves `@kermanych/cloud` through its `dist`, so Task 3 cannot import from it until this runs.

- [ ] **Step 7: Commit**

```bash
git add kermanych/packages/cloud/src/tasks.ts kermanych/packages/cloud/src/index.ts \
        kermanych/packages/cloud/test/tasks.spec.ts
git commit -m "feat(cloud): task queries with snake-case mapping and an atomic claim"
```

---

### Task 2: `subscribeTasks` — one channel, one binding, >100-project fallback

**Files:**
- Modify: `packages/cloud/src/tasks.ts` (append the Realtime section at the end of the file)
- Modify: `packages/cloud/test/tasks.spec.ts` (append the Realtime suites)

**Interfaces:**
- Consumes: `toTask` and `TaskRow` (Task 1); `RealtimeChannel` from `@supabase/supabase-js`.
- Produces:
  - `type TaskChange = { kind: 'upsert'; task: Task } | { kind: 'delete'; taskId: string }`
  - `type TaskChannelState = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'`
  - `const REALTIME_IN_FILTER_MAX = 100`
  - `tasksFilter(projectIds: string[]): string | undefined`
  - `subscribeTasks(client, projectIds, onChange: (c: TaskChange) => void, onState?: (s: TaskChannelState) => void): () => void` — the returned function is the unsubscribe.

- [ ] **Step 1: Write the failing test**

Append to `packages/cloud/test/tasks.spec.ts`. Extend the import at the top of the file to also pull the new symbols:

```ts
import {
  assignTask,
  claimTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  patchTask,
  pushTaskStatus,
  REALTIME_IN_FILTER_MAX,
  subscribeTasks,
  tasksFilter,
} from "../src/tasks";
```

Then append the suites:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kermanych/cloud exec vitest run test/tasks.spec.ts`
Expected: FAIL — `subscribeTasks is not a function` / `tasksFilter is not a function` (the Task 1 suites still pass).

- [ ] **Step 3: Implement the Realtime section**

Append to `packages/cloud/src/tasks.ts`. Extend the type import at the top of the file to `import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";`, then add:

```ts
// ── Realtime ──────────────────────────────────────────────────────────────────
// The board engine. One channel per client, one binding on it; a status push from any
// machine's local Nest and an assignment from any UI both arrive here.

export type TaskChange = { kind: "upsert"; task: Task } | { kind: "delete"; taskId: string };

// The four states realtime-js hands to a subscribe() callback.
export type TaskChannelState = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

// The Realtime server caps an `in` filter at 100 values. Past that the filter is dropped
// and the `tasks` SELECT policy scopes the stream instead — RLS IS enforced per subscriber
// for postgres_changes (the table is in the supabase_realtime publication and
// `authenticated` has SELECT), so a filterless binding is safe, just chattier.
export const REALTIME_IN_FILTER_MAX = 100;

export function tasksFilter(projectIds: string[]): string | undefined {
  if (projectIds.length > REALTIME_IN_FILTER_MAX) return undefined;
  return `project_id=in.(${projectIds.join(",")})`;
}

export function subscribeTasks(
  client: SupabaseClient,
  projectIds: string[],
  onChange: (change: TaskChange) => void,
  onState?: (state: TaskChannelState) => void,
): () => void {
  // Nothing to watch, and `project_id=in.()` is not valid filter syntax.
  if (projectIds.length === 0) return () => {};

  const filter = tasksFilter(projectIds);
  const channel: RealtimeChannel = client.channel("kermanych-tasks");

  // ONE binding, registered BEFORE subscribe(): .on() throws once the channel is
  // subscribed, and a second identical postgres_changes binding on the same channel is
  // silently dropped. Never call realtime.setAuth here — supabase-js refreshes the socket
  // token itself from onAuthStateChange, and pinning it would disable that.
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "tasks", ...(filter ? { filter } : {}) },
    (payload) => {
      if (payload.eventType === "DELETE") {
        // `old` carries the primary key ONLY (default replica identity), and DELETE events
        // are not RLS-filtered, so an id from a project we do not track can arrive. The
        // consumer removes by id, which is a no-op for an unknown one.
        const id = (payload.old as { id?: string }).id;
        if (id) onChange({ kind: "delete", taskId: id });
        return;
      }
      onChange({ kind: "upsert", task: toTask(payload.new as TaskRow) });
    },
  );

  channel.subscribe((status) => onState?.(status as TaskChannelState));

  // removeChannel unsubscribes AND drops the channel from the client, so a later
  // subscribeTasks() can rebuild the binding with a different project set. A
  // postgres_changes filter cannot be edited in place.
  return () => {
    void client.removeChannel(channel);
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kermanych/cloud exec vitest run test/tasks.spec.ts`
Expected: PASS — 25 tests.

- [ ] **Step 5: Typecheck, build, and run the whole package suite**

Run: `pnpm --filter @kermanych/cloud exec tsc -p tsconfig.json --noEmit && pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/cloud exec vitest run`
Expected: no type errors; `status.spec.ts`, `client.spec.ts`, `projects.spec.ts` and `tasks.spec.ts` all green. (`rls.spec.ts` stays skipped unless `SUPABASE_TEST_URL` is set.)

- [ ] **Step 6: Commit**

```bash
git add kermanych/packages/cloud/src/tasks.ts kermanych/packages/cloud/test/tasks.spec.ts
git commit -m "feat(cloud): realtime task subscription with a single filtered binding"
```

---

### Task 3: `apps/ui/src/stores/board.ts` — task state, invariants, optimistic writes

**Files:**
- Create: `apps/ui/src/stores/board.ts`

**Interfaces:**
- Consumes:
  - `useAuth()` from Plan A (`apps/ui/src/stores/auth.ts`): `client: SupabaseClient`, `user: { id: string } | null`, `ready: Promise<void>`.
  - `useProjects()` from Plan B (`apps/ui/src/stores/projects.ts`): `projects: CloudProject[]`, `load()`. This store reads the project list and owns NO project or membership state.
  - `useOrchestrator()` (`apps/ui/src/stores/orchestrator.ts:263-267`): `notify(message, kind)` — the app's only toast surface.
  - `listTasks`, `createTask`, `patchTask`, `assignTask`, `deleteTask`, `Task`, `TaskInsert`, `TaskPatch` from `@kermanych/cloud` (Task 1).
  - `ACTIVE_STATUSES` from `@kermanych/core/status` (`packages/core/src/status.ts:10`, `readonly SessionStatus[]` = `queued`/`thinking`/`tool`/`waiting_input`). `TaskStatus = SessionStatus`, so it applies unchanged. Imported from the `./status` subpath rather than the barrel for the same CJS-interop reason `orchestrator.ts:16-19` documents. **`packages/core` is not edited** — there is no `isActiveStatus()` helper in the repo and adding one would be a core edit, so the store wraps the existing exported constant in a local `isActive()`.
- Produces: `useBoard()` exposing `tasks: Task[]`, `loading: boolean`, `loadError: string | null`, `channelState: TaskChannelState`, `offline: boolean`, `load(): Promise<void>`, `createTask(input: TaskInsert): Promise<Task | undefined>`, `updateTaskFields(id, patch: TaskPatch): Promise<boolean>`, `assignTask(id, assigneeId: string | null): Promise<boolean>`, `deleteTask(id): Promise<boolean>`. `subscribe()`/`unsubscribe()` land in Task 4.
- Coordinated: Plan D renders `offline` (its Task 7) and replaces `BoardPage.vue`'s `launch()` seam (its Task 6). This store must therefore EXPOSE `offline` and never render it.

- [ ] **Step 1: Create the store with state and reads**

Create `apps/ui/src/stores/board.ts`:

```ts
// apps/ui/src/stores/board.ts
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Task, TaskChannelState, TaskInsert, TaskPatch } from '@kermanych/cloud';
import {
  assignTask as cloudAssignTask,
  createTask as cloudCreateTask,
  deleteTask as cloudDeleteTask,
  listTasks as cloudListTasks,
  patchTask as cloudPatchTask,
} from '@kermanych/cloud';
// Import from core's status module directly (not the barrel): @kermanych/core is a CJS
// workspace dep whose named exports vite/rollup only sees once its dist is commonjs-
// transformed (see quasar.config commonjsOptions.include) — same reason as
// stores/orchestrator.ts:16-19.
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import { useAuth } from './auth';
import { useProjects } from './projects';
import { useOrchestrator } from './orchestrator';

// The shared board's TASKS, and nothing else. Cloud projects and membership live in
// stores/projects.ts; local sessions and the socket live in stores/orchestrator.ts. Writes
// are optimistic and roll back when the cloud refuses, because RLS and tasks_guard() — not
// this store — decide what is allowed.
export const useBoard = defineStore('board', () => {
  const auth = useAuth();
  const cloud = useProjects();
  const local = useOrchestrator();

  const tasks = ref<Task[]>([]);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  // 'CLOSED' until a subscription actually reports otherwise, so `offline` starts true and
  // nothing can claim the board is live before Realtime says so.
  const channelState = ref<TaskChannelState>('CLOSED');
  // Anything other than a live SUBSCRIBED channel means "the board may be stale". Plan D
  // renders this; the store only computes it.
  const offline = computed(() => channelState.value !== 'SUBSCRIBED');

  const projectIds = computed(() => cloud.projects.map((p) => p.id));

  // Sorted by createdAt so a Realtime insert lands in a stable place instead of appending
  // to whichever column happened to render last. Replace-or-append keyed by id, so the
  // optimistic row, the awaited response and the Realtime echo all collapse into one.
  function upsert(task: Task): void {
    tasks.value = [...tasks.value.filter((t) => t.id !== task.id), task].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  function drop(taskId: string): void {
    tasks.value = tasks.value.filter((t) => t.id !== taskId);
  }

  // TaskStatus === SessionStatus, so core's constant applies verbatim. Active = the omp
  // process is mid-work or blocked on its user.
  function isActive(task: Task): boolean {
    return ACTIVE_STATUSES.includes(task.status);
  }

  function fail(e: unknown): void {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }

  // The task query is scoped by project, so the cloud project list is a hard prerequisite.
  // Loading it here keeps every caller a one-liner instead of sequencing two stores.
  async function load(): Promise<void> {
    await auth.ready;
    if (!auth.user) return;
    loading.value = true;
    loadError.value = null;
    try {
      if (!cloud.projects.length) await cloud.load();
      tasks.value = await cloudListTasks(auth.client, projectIds.value);
    } catch (e) {
      // Deliberately NOT a toast: load() also runs from the workspace page on every app
      // open, and an unreachable Supabase must not greet the user with a popup. BoardPage
      // renders loadError inline instead.
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  return {
    tasks,
    loading,
    loadError,
    channelState,
    offline,
    load,
  };
});
```

- [ ] **Step 2: Add the optimistic write path**

Insert the following into `stores/board.ts`, after `load()` and before the `return` block:

```ts
  // Apply a patch to a local copy exactly the way Postgres will, so the optimistic row and
  // the eventual server row agree. `assigneeId: null` means "clear it", which on the Task
  // type is an absent key, not a null.
  function applyPatch(task: Task, patch: TaskPatch): Task {
    const next: Task = { ...task };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId === null) delete next.assigneeId;
      else next.assigneeId = patch.assigneeId;
    }
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.prefix !== undefined) next.prefix = patch.prefix;
    if (patch.platform !== undefined) next.platform = patch.platform;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.branch !== undefined) next.branch = patch.branch;
    return next;
  }

  async function createTask(input: TaskInsert): Promise<Task | undefined> {
    const userId = auth.user?.id;
    if (!userId) {
      local.notify('Спочатку увійдіть у Kermanych', 'error');
      return undefined;
    }
    try {
      // No optimistic row here: the id is minted by Postgres. Realtime delivers the same
      // task moments later and upsert() dedupes it by id.
      const created = await cloudCreateTask(auth.client, { ...input, createdBy: userId });
      upsert(created);
      return created;
    } catch (e) {
      fail(e);
      return undefined;
    }
  }

  async function updateTaskFields(id: string, patch: TaskPatch): Promise<boolean> {
    const before = tasks.value.find((t) => t.id === id);
    if (!before) return false;
    // UX pre-check only. tasks_guard() refuses this server-side with `task is active`
    // whatever the UI allows — this exists so the user gets an instant, readable answer
    // instead of a round trip and a Postgres sentence.
    if (patch.assigneeId !== undefined && isActive(before)) {
      local.notify('Активну задачу не можна переасайнити', 'error');
      return false;
    }
    upsert(applyPatch(before, patch));
    try {
      upsert(await cloudPatchTask(auth.client, id, patch));
      return true;
    } catch (e) {
      // The cloud refused — an RLS policy or tasks_guard(). Put the row back exactly as it
      // was and surface the Postgres message, which names the invariant that fired.
      upsert(before);
      fail(e);
      return false;
    }
  }

  // Assignment is just the field edit tasks_guard() guards, so it shares the pre-check and
  // the rollback rather than duplicating them.
  function assignTask(id: string, assigneeId: string | null): Promise<boolean> {
    return updateTaskFields(id, { assigneeId });
  }

  async function deleteTask(id: string): Promise<boolean> {
    const before = tasks.value.find((t) => t.id === id);
    if (!before) return false;
    if (isActive(before)) {
      local.notify('Активну задачу не можна видалити', 'error');
      return false;
    }
    drop(id);
    try {
      await cloudDeleteTask(auth.client, id);
      return true;
    } catch (e) {
      upsert(before);
      fail(e);
      return false;
    }
  }
```

- [ ] **Step 3: Extend the return block**

Replace the `return` block added in Step 1 with:

```ts
  return {
    tasks,
    loading,
    loadError,
    channelState,
    offline,
    load,
    createTask,
    updateTaskFields,
    assignTask,
    deleteTask,
  };
```

- [ ] **Step 4: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors inside `src/stores/board.ts`. If the `@kermanych/cloud` named imports fail to resolve, the package was not built (Task 2 Step 5) or Plan A's `quasar.config.ts` CJS-interop entry for `@kermanych/cloud` is missing — fix that, do not add a workaround here.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/src/stores/board.ts
git commit -m "feat(ui): cloud task board store with optimistic writes and active-task guards"
```

---

### Task 4: Realtime lifecycle in the board store

**Files:**
- Modify: `apps/ui/src/stores/board.ts` (add `subscribe`/`unsubscribe` after `load()`; add two watchers before the `return`; extend the `return` block)

**Interfaces:**
- Consumes: `subscribeTasks`, `TaskChange`, `TaskChannelState` from `@kermanych/cloud` (Task 2); `load()`, `upsert()`, `drop()`, `channelState`, `projectIds` (Task 3); `useAuth().user` (Plan A).
- Produces: `subscribe(): Promise<void>` and `unsubscribe(): void` on `useBoard()`. Contract:
  - every (re)subscribe performs a FULL refetch first;
  - a change to the project-id set rebuilds the channel;
  - losing the session (sign-out, or a 401 that forced one) tears the channel down and clears the task list;
  - `channelState` is written only by the channel's own state callback and by `unsubscribe()`.

- [ ] **Step 1: Add subscribe / unsubscribe**

In `apps/ui/src/stores/board.ts`, extend the `@kermanych/cloud` value import with `subscribeTasks as cloudSubscribeTasks,` and the type import with `TaskChange`, then add `watch` to the `vue` import:

```ts
import { computed, ref, watch } from 'vue';
import type { Task, TaskChange, TaskChannelState, TaskInsert, TaskPatch } from '@kermanych/cloud';
import {
  assignTask as cloudAssignTask,
  createTask as cloudCreateTask,
  deleteTask as cloudDeleteTask,
  listTasks as cloudListTasks,
  patchTask as cloudPatchTask,
  subscribeTasks as cloudSubscribeTasks,
} from '@kermanych/cloud';
```

Declare the channel handle next to the other store-local state, immediately after `const projectIds = computed(...)`:

```ts
  // Store-local, not reactive: nothing renders it, and exposing it would let a component
  // tear the channel down behind the store's back.
  let unsubscribeChannel: (() => void) | undefined;
```

Add both functions after `load()`:

```ts
  // A full refetch on every (re)subscribe is the whole staleness story: events that fired
  // while the channel was down are gone forever, so the snapshot has to be re-read rather
  // than patched. Idempotent — calling it twice rebuilds one channel, never two.
  async function subscribe(): Promise<void> {
    unsubscribe();
    await load();
    if (!auth.user || !projectIds.value.length) return;
    unsubscribeChannel = cloudSubscribeTasks(
      auth.client,
      projectIds.value,
      (change: TaskChange) => {
        if (change.kind === 'delete') drop(change.taskId);
        else upsert(change.task);
      },
      (state) => {
        channelState.value = state;
      },
    );
  }

  function unsubscribe(): void {
    unsubscribeChannel?.();
    unsubscribeChannel = undefined;
    channelState.value = 'CLOSED';
  }
```

- [ ] **Step 2: Add the two watchers**

Insert immediately before the `return` block. These watchers are created in the store's setup scope on purpose: they have no owning component, so they live as long as the app — which is exactly the lifetime of the channel they manage.

```ts
  // The project set is the channel's filter, and a postgres_changes filter cannot be edited
  // in place — a project added, or membership revoked, means rebuilding the channel. Only
  // while a channel actually exists: before the board mounts there is nothing to rebuild.
  watch(
    () => projectIds.value.join(','),
    (next, prev) => {
      if (next === prev || !unsubscribeChannel) return;
      void subscribe();
    },
  );

  // Sign-out must take the channel with it. Left running, the socket would keep a revoked
  // token alive and the next user on this machine would inherit this user's cards.
  watch(
    () => auth.user,
    (u) => {
      if (u) return;
      unsubscribe();
      tasks.value = [];
      loadError.value = null;
    },
  );
```

- [ ] **Step 3: Extend the return block**

```ts
  return {
    tasks,
    loading,
    loadError,
    channelState,
    offline,
    load,
    subscribe,
    unsubscribe,
    createTask,
    updateTaskFields,
    assignTask,
    deleteTask,
  };
```

- [ ] **Step 4: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors. In particular `channelState.value = state` must typecheck without a cast — `subscribeTasks`'s fourth parameter is typed `(state: TaskChannelState) => void`.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/src/stores/board.ts
git commit -m "feat(ui): realtime lifecycle for the board store with refetch on resubscribe"
```

---

### Task 5: `BoardPage.vue` — status columns, cards, and the `/board` route

**Files:**
- Create: `apps/ui/src/pages/BoardPage.vue`
- Modify: `apps/ui/src/router/routes.ts` (whole file)

**Interfaces:**
- Consumes:
  - `useBoard()` (Tasks 3-4) as `const board = useBoard()` — Plan D's Task 7 names that variable verbatim.
  - `useProjects()` (Plan B): `projects: CloudProject[]`, `members: Record<string, ProjectMember[]>`, `loadMembers(id)`.
  - `useOrchestrator()` (Plan B's renamed state) as `const local = useOrchestrator()`: `projects: Project[]` (LOCAL rows carrying `localRepoPath`, `''` when unbound) and `notify(message, kind)`.
  - `useNow(): Ref<number>` (`apps/ui/src/composables/useNow.ts`, ticks every 15 s) and `relativeTime(iso: string, nowMs: number): string` (`apps/ui/src/lib/time.ts`) — both already exist and are used by `WorkspacePage.vue:475-476`. Nothing new is added to either file.
  - `ACTIVE_STATUSES` from `@kermanych/core/status`.
  - Kit components: `KBtn` (`variant`/`disabled`), `KSelect` (`label?`/`modelValue?`/`options: string[]`/`placeholder?`/`disabled?`, emits `update:modelValue`), `KStatusDot` (`status: SessionStatus`), `KTag` (default slot, `plain?`).
  - `routes.ts` as Plan A ships it, carrying the literal marker comment `// Plan C (cloud board) adds the /board child here.` inside the `MainLayout` children array. Plan A's `/login` record with `meta: { public: true }`, the `RouteMeta` module augmentation, and the `not-found` record are **Consumed verbatim** — this task adds one child and changes nothing else.
- Produces: `pages/BoardPage.vue` rendering five status columns of cards (title, assignee handle + avatar, status dot, launch-param summary, `оновлено N хв тому`), a project filter, an orphan-project note, `function isBound(task: Task): boolean`, `function launch(task: Task): void` (the inert seam), and the named route `board` at `/board`.
- Coordinated: Plan D replaces the `launch()` body with the real `POST /api/sessions/from-task` flow plus a binding modal (its Task 6), and renders `board.offline` as a banner plus upgrades the per-card age line into a staleness warning (its Task 7). This task must therefore ship the button, the `isBound` gate and the age line, and must NOT render `board.offline`.

**Column decision (one line, as required):** ten `SessionStatus` values collapse to five columns because `thinking` and `tool` are one human state («агент працює») and `done`/`merged`/`stopped`/`error`/`conflict` are all «не рухається» — ten lanes would be ten mostly-empty columns on a team board.

- [ ] **Step 1: Write the page template**

Create `apps/ui/src/pages/BoardPage.vue` with this template. (Step 2 adds the script, Step 3 the styles; the file is only valid after all three.)

```vue
<template>
  <main class="board">
    <header class="board__head">
      <div class="board__title">
        <h1 class="board__heading">Дошка команди</h1>
        <span class="board__count mono">{{ visibleTasks.length }} задач</span>
      </div>
      <div class="board__controls">
        <KSelect v-model="projectFilter" :options="projectNames" placeholder="Усі проєкти" />
        <KBtn variant="primary" :disabled="!cloud.projects.length" @click="openCreate">Нова задача</KBtn>
      </div>
    </header>

    <p v-if="loadHint" class="board__hint mono">{{ loadHint }}</p>
    <p v-if="orphanCount" class="board__hint mono">
      Локальних проєктів поза хмарою: {{ orphanCount }} — дошка їх не показує.
    </p>

    <div v-if="cloud.projects.length" class="board__columns">
      <section v-for="col in COLUMNS" :key="col.key" class="board__column">
        <header class="board__column-head">
          <span class="board__column-title">{{ col.label }}</span>
          <span class="board__column-count mono">{{ byColumn[col.key]?.length ?? 0 }}</span>
        </header>

        <div class="board__column-body">
          <article v-for="task in byColumn[col.key]" :key="task.id" class="board__card">
            <header class="board__card-head">
              <KStatusDot :status="task.status" />
              <span class="board__card-title">{{ task.title }}</span>
            </header>

            <p v-if="task.description" class="board__card-desc">{{ task.description }}</p>

            <div class="board__card-tags">
              <KTag v-if="!projectFilter">{{ projectName(task.projectId) }}</KTag>
              <KTag v-if="task.model">{{ task.model }}</KTag>
              <KTag v-if="task.prefix">{{ task.prefix }}</KTag>
              <KTag v-if="task.platform">{{ task.platform }}</KTag>
              <KTag v-if="task.branch">⑂ {{ task.branch }}</KTag>
            </div>

            <div class="board__card-assignee">
              <img v-if="avatarOf(task)" :src="avatarOf(task)" class="board__avatar" alt="" />
              <KSelect
                :model-value="handleOfAssignee(task)"
                :options="memberHandles(task.projectId)"
                placeholder="не призначено"
                :disabled="isActiveTask(task)"
                @update:model-value="(handle: string) => onAssign(task, handle)"
              />
            </div>

            <footer class="board__card-foot">
              <span class="board__card-age mono">оновлено {{ relativeTime(task.updatedAt, now) }}</span>
              <span class="board__spacer"></span>
              <KBtn variant="ghost" @click="openEdit(task)">Змінити</KBtn>
              <KBtn variant="ghost" @click="onDelete(task)">Видалити</KBtn>
              <KBtn
                variant="primary"
                :disabled="!isBound(task)"
                :title="isBound(task) ? 'Запустити локальну сесію' : 'Прив’яжіть локальну теку репозиторію'"
                @click="launch(task)"
              >Запустити</KBtn>
            </footer>
          </article>

          <p v-if="!byColumn[col.key]?.length" class="board__column-empty mono">—</p>
        </div>
      </section>
    </div>

    <div v-else class="board__blank">
      <div class="board__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="board__blank-text">
        Ви ще не в жодному проєкті. Створіть проєкт або попросіть колегу додати вас до свого.
      </p>
    </div>
  </main>
</template>
```

- [ ] **Step 2: Write the script**

Append to `apps/ui/src/pages/BoardPage.vue`:

```vue
<script setup lang="ts">
// The shared cloud board (design deviation D6): a NEW page with status columns, kept apart
// from WorkspacePage's LOCAL session table. Cards are cloud tasks; execution still happens
// on the assignee's own machine, which is why «Запустити» needs a local binding.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ProjectMember, Task, TaskStatus } from '@kermanych/cloud';
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import { useBoard } from 'stores/board';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import KBtn from 'components/kit/KBtn.vue';
import KSelect from 'components/kit/KSelect.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KTag from 'components/kit/KTag.vue';
import { useNow } from '../composables/useNow';
import { relativeTime } from '../lib/time';

const board = useBoard();
const cloud = useProjects();
const local = useOrchestrator();
const now = useNow();

// Ten task statuses, five columns: `thinking` and `tool` are one human state («агент
// працює»), and the five end states are all «не рухається». Ten lanes would be ten
// mostly-empty columns.
type Column = { key: string; label: string; statuses: TaskStatus[] };
const COLUMNS: Column[] = [
  { key: 'backlog', label: 'Беклог', statuses: ['backlog'] },
  { key: 'queued', label: 'У черзі', statuses: ['queued'] },
  { key: 'running', label: 'В роботі', statuses: ['thinking', 'tool'] },
  { key: 'waiting', label: 'Чекає відповіді', statuses: ['waiting_input'] },
  { key: 'closed', label: 'Завершені', statuses: ['done', 'merged', 'stopped', 'error', 'conflict'] },
];

// subscribe() refetches then opens the channel; leaving the page closes it, so Realtime
// traffic is scoped to the screen that shows it. The task list survives in the store, which
// is what lets WorkspacePage name a session's task without subscribing.
onMounted(async () => {
  await board.subscribe();
  await loadMembers();
});
onUnmounted(() => board.unsubscribe());

// Cards show assignees by GitHub handle, which lives in `profiles` and reaches the UI
// through the membership join. One project's failure must not blank the whole board.
async function loadMembers(): Promise<void> {
  for (const p of cloud.projects) {
    try {
      await cloud.loadMembers(p.id);
    } catch {
      /* membership is decoration here; the cards render with raw ids instead */
    }
  }
}

// ── Project scope ─────────────────────────────────────────────────────────────
const projectFilter = ref('');
const projectNames = computed(() => cloud.projects.map((p) => p.name));

function projectName(id: string): string {
  return cloud.projects.find((p) => p.id === id)?.name ?? '—';
}

function projectIdByName(name: string): string | undefined {
  return cloud.projects.find((p) => p.name === name)?.id;
}

const visibleTasks = computed(() => {
  const id = projectFilter.value ? projectIdByName(projectFilter.value) : undefined;
  return id ? board.tasks.filter((t) => t.projectId === id) : board.tasks;
});

const byColumn = computed<Record<string, Task[]>>(() => {
  const out: Record<string, Task[]> = {};
  for (const col of COLUMNS) out[col.key] = visibleTasks.value.filter((t) => col.statuses.includes(t.status));
  return out;
});

const loadHint = computed(() => {
  if (board.loading) return 'Читаю дошку…';
  if (board.loadError) return `Хмара недоступна: ${board.loadError}`;
  return '';
});

// A LOCAL project row whose cloud project is gone (membership revoked, project deleted, or
// a transient RLS-empty read) survives as an orphan so its sessions keep working — the api
// only prunes rows with zero sessions. The board never lists one: every card and every
// project option comes from cloud.projects, so no cloud action can be offered on a project
// this user no longer belongs to. The count is shown so the state is not invisible.
const orphanCount = computed(() => {
  const known = new Set(cloud.projects.map((p) => p.id));
  return local.projects.filter((p) => !known.has(p.id)).length;
});

// ── Assignee ──────────────────────────────────────────────────────────────────
function membersOf(projectId: string): ProjectMember[] {
  return cloud.members[projectId] ?? [];
}

function handleOf(m: ProjectMember): string {
  return m.profile?.githubUsername ?? m.profile?.displayName ?? m.userId;
}

function memberHandles(projectId: string): string[] {
  return membersOf(projectId).map(handleOf);
}

// '' is KSelect's placeholder option. KSelect keeps an unknown current value as an option,
// so a not-yet-loaded membership still renders the raw id instead of silently unassigning.
function handleOfAssignee(task: Task): string {
  if (!task.assigneeId) return '';
  const m = membersOf(task.projectId).find((x) => x.userId === task.assigneeId);
  return m ? handleOf(m) : task.assigneeId;
}

function avatarOf(task: Task): string | undefined {
  return membersOf(task.projectId).find((m) => m.userId === task.assigneeId)?.profile?.avatarUrl;
}

function onAssign(task: Task, handle: string): void {
  const userId = handle ? (membersOf(task.projectId).find((m) => handleOf(m) === handle)?.userId ?? null) : null;
  if (userId === (task.assigneeId ?? null)) return;
  void board.assignTask(task.id, userId);
}

// ── Launch seam ───────────────────────────────────────────────────────────────
function isActiveTask(task: Task): boolean {
  return ACTIVE_STATUSES.includes(task.status);
}

// A cloud task runs where its repo actually lives, so a launch needs THIS machine's
// binding: the LOCAL project row's localRepoPath ('' when unbound).
function isBound(task: Task): boolean {
  return !!local.projects.find((p) => p.id === task.projectId)?.localRepoPath;
}

// RESERVED SEAM — Plan D (status sync) replaces this entire body with
// api.createSessionFromTask(task.id) plus the unbound-project binding detour. Until then
// the button, its disabled state and its hint are real, and pressing it says so rather than
// pretending to have started anything.
function launch(task: Task): void {
  local.notify(
    `Запуск задачі «${task.title}» зʼявиться разом із локальною синхронізацією статусів`,
    'info',
  );
}

// ── Placeholder handlers wired by Task 6 ──────────────────────────────────────
function openCreate(): void {
  editorOpen.value = true;
}

function openEdit(task: Task): void {
  editingId.value = task.id;
  editorOpen.value = true;
}

function onDelete(task: Task): void {
  void board.deleteTask(task.id);
}

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
</script>
```

The four members at the bottom exist because the template above references them; Task 6 replaces them with the real create/edit flow. They are wired, not stubbed: `onDelete` already performs a real cloud delete with the active-task guard, and `openCreate`/`openEdit` already open the modal Task 6 fills in.

- [ ] **Step 3: Write the styles**

Append to `apps/ui/src/pages/BoardPage.vue`. Tokens only — no raw hex.

```vue
<style scoped lang="scss">
.board {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 20px 24px;
  background: var(--k-canvas);
}

.board__head {
  display: flex;
  align-items: flex-end;
  gap: 16px;
}

.board__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.board__heading {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--k-text);
}

.board__count,
.board__hint,
.board__column-count,
.board__column-empty,
.board__card-age {
  font-family: var(--k-font-mono);
  font-size: 11px;
  color: var(--k-muted);
}

.board__controls {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-left: auto;
}

.board__hint {
  margin: 0;
}

.board__columns {
  display: grid;
  grid-template-columns: repeat(5, minmax(220px, 1fr));
  gap: 2px;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  background: var(--k-line);
}

.board__column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--k-bg);
}

.board__column-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 2px solid var(--k-line-strong);
}

.board__column-title {
  font-family: var(--k-font-ui);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-text);
}

.board__column-count {
  margin-left: auto;
}

.board__column-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px;
  overflow-y: auto;
}

.board__column-empty {
  padding: 12px;
}

.board__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--k-surface);
  border: 1px solid var(--k-line);
}

.board__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.board__card-title {
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--k-text);
}

.board__card-desc {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.board__card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.board__card-assignee {
  display: flex;
  align-items: center;
  gap: 6px;
}

.board__avatar {
  width: 18px;
  height: 18px;
  border: 1px solid var(--k-line-strong);
  object-fit: cover;
}

.board__card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--k-line);
}

.board__spacer {
  flex: 1;
}

.board__blank {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
}

.board__blank-eyebrow {
  font-family: var(--k-font-mono);
  font-size: 11px;
  letter-spacing: 0.3em;
  color: var(--k-muted);
}

.board__blank-text {
  margin: 0;
  max-width: 420px;
  text-align: center;
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--k-muted);
}
</style>
```

- [ ] **Step 4: Register the route**

Replace the whole of `apps/ui/src/router/routes.ts` with the merged file. Plan A's `/login` record, the `RouteMeta` augmentation and the `not-found` record are unchanged; the only addition is the `board` child, dropped exactly where Plan A left its marker comment.

```ts
import type { RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    // Reachable without a Supabase session. Everything else is redirected to
    // /login by the beforeEach guard in router/index.ts.
    public?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('layouts/AuthLayout.vue'),
    meta: { public: true },
  },

  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      { path: '', name: 'workspace', component: () => import('pages/WorkspacePage.vue'), meta: { public: false } },
      { path: 'board', name: 'board', component: () => import('pages/BoardPage.vue'), meta: { public: false } },
      { path: 'kit', name: 'kit', component: () => import('pages/KitGalleryPage.vue'), meta: { public: false } },
    ],
  },

  // Always leave this as the last one.
  {
    path: '/:catchAll(.*)*',
    name: 'not-found',
    component: () => import('pages/ErrorNotFound.vue'),
    meta: { public: true },
  },
];

export default routes;
```

- [ ] **Step 5: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify the board renders in the browser**

`supabase start` must be running, plus `pnpm dev:api` and `pnpm dev:ui`. Sign in, then create a project and a task from the Supabase Studio SQL editor (<http://127.0.0.1:54323>) so there is something to look at — the create modal lands in Task 6:

```sql
insert into projects (name, owner_id) values ('Acme Web', (select id from profiles limit 1));
insert into tasks (project_id, title, description, created_by, model, prefix, branch)
values ((select id from projects where name = 'Acme Web'),
        'Перенести хедер на токени', 'Прибрати захардкоджені кольори.',
        (select id from profiles limit 1), 'opus-5', 'feature', 'main');
```

Open <http://localhost:5317/#/board>. Expected, in order:
1. Five columns in this order: Беклог · У черзі · В роботі · Чекає відповіді · Завершені, each with a count.
2. The seeded card sits in Беклог with its status dot, title, clamped description, tags `Acme Web` / `opus-5` / `feature` / `⑂ main`, an assignee select reading «не призначено», and a footer line «оновлено щойно».
3. «Запустити» is DISABLED, and hovering it shows «Прив’яжіть локальну теку репозиторію» (the local project row exists but has no `localRepoPath` yet).
4. Pick `Acme Web` in the project filter → the project tag disappears from the card (redundant when filtered) and the card stays; pick the empty option → «Усі проєкти» and the tag returns.
5. In Studio, `update tasks set title = 'Інша назва' where title = 'Перенести хедер на токени';` → the card's title changes within a second **without a reload**, proving the Realtime binding.
6. In Studio, `delete from tasks where title = 'Інша назва';` → the card disappears live (the DELETE payload carries only the id, and the store still removes the right row).
7. The browser console is clean — no errors, no `.on() after subscribe` warning, no unhandled rejection.

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/ui/src/pages/BoardPage.vue kermanych/apps/ui/src/router/routes.ts
git commit -m "feat(ui): cloud board page with status columns and the /board route"
```

---

### Task 6: Create/edit modal, assign control and the reserved «Запустити»

**Files:**
- Modify: `apps/ui/src/pages/BoardPage.vue` (append the modal to the template; replace the four placeholder members at the end of the script; extend the imports and styles)

**Interfaces:**
- Consumes: `board.createTask(input: TaskInsert): Promise<Task | undefined>` and `board.updateTaskFields(id, patch: TaskPatch): Promise<boolean>` (Task 3); `KModal` (`modelValue`, `title`, `width?`, `flush?`; slots default + `#controls` + `#head-meta`) and `KField` (`label?`, `modelValue?`, `placeholder?`, `multiline?`, `rows?`).
- Produces: a «Нова задача» / «Змінити задачу» modal reusing the local launcher's field vocabulary; `MODEL_OPTIONS`, `PREFIX_OPTIONS`, `PLATFORM_OPTIONS`; `submitEditor()`; the finished assign + delete + launch card controls.
- The launch-param vocabulary is copied from the local launcher (`WorkspacePage.vue:658-661`) so a cloud task and a hand-started agent offer identical choices: models `opus-5` / `sonnet-4.5` / `haiku`, prefixes `feature` / `fix` / `refactoring` / `chore`, platforms `backend` / `web` / `mobile`.

- [ ] **Step 1: Add the modal to the template**

In `apps/ui/src/pages/BoardPage.vue`, insert immediately before the closing `</main>` of the template:

```html
    <!-- CREATE / EDIT TASK — same launch vocabulary as the local launcher -->
    <KModal v-model="editorOpen" :title="editingId ? 'Змінити задачу' : 'Нова задача'" width="720px">
      <template #head-meta>
        <span class="board__esc mono">Esc — закрити</span>
      </template>

      <div class="board__form">
        <KSelect
          v-if="!editingId"
          v-model="draftProject"
          label="Проєкт"
          :options="projectNames"
          placeholder="виберіть проєкт"
        />
        <KField v-model="draftTitle" label="Назва задачі" placeholder="що саме треба зробити" />
        <KField
          v-model="draftDescription"
          label="Опис"
          placeholder="Один абзац — далі агент поставить уточнення."
          multiline
          :rows="6"
        />
        <div class="board__form-row">
          <KSelect v-model="draftModel" label="Модель" :options="MODEL_OPTIONS" placeholder="за замовчуванням" />
          <KSelect v-model="draftPrefix" label="Тип" :options="PREFIX_OPTIONS" placeholder="feature" />
          <KSelect
            v-model="draftPlatform"
            label="Платформа"
            :options="PLATFORM_OPTIONS"
            placeholder="необовʼязково"
          />
        </div>
        <KField v-model="draftBranch" label="Базова гілка" placeholder="за замовчуванням проєкту" />
        <p v-if="editorError" class="board__error" role="alert">{{ editorError }}</p>
      </div>

      <template #controls>
        <KBtn variant="ghost" @click="editorOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canSubmit" @click="submitEditor">
          {{ editingId ? 'Зберегти' : 'Створити' }}
        </KBtn>
      </template>
    </KModal>
```

- [ ] **Step 2: Extend the script imports**

In the same file, extend the two component imports:

```ts
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
```

- [ ] **Step 3: Replace the placeholder members with the real editor**

Delete the `// ── Placeholder handlers wired by Task 6 ──` block from Task 5 Step 2 (`openCreate`, `openEdit`, `onDelete`, `editorOpen`, `editingId`) and put this in its place:

```ts
// ── Create / edit ─────────────────────────────────────────────────────────────
// Same launch vocabulary as the local launcher (WorkspacePage.vue:658-661), so a task born
// on the board and an agent started by hand offer identical choices.
const MODEL_OPTIONS = ['opus-5', 'sonnet-4.5', 'haiku'];
const PREFIX_OPTIONS = ['feature', 'fix', 'refactoring', 'chore'];
const PLATFORM_OPTIONS = ['backend', 'web', 'mobile'];

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const editorError = ref<string | null>(null);
const draftProject = ref('');
const draftTitle = ref('');
const draftDescription = ref('');
const draftModel = ref('');
const draftPrefix = ref('');
const draftPlatform = ref('');
const draftBranch = ref('');

// A task always needs a title; a NEW one also needs a project, because `project_id` is what
// the tasks INSERT policy checks membership against.
const canSubmit = computed(
  () => !!draftTitle.value.trim() && (!!editingId.value || !!projectIdByName(draftProject.value)),
);

function openCreate(): void {
  editingId.value = null;
  editorError.value = null;
  // Default to whatever the board is already filtered to — that is the project the user is
  // looking at.
  draftProject.value = projectFilter.value || (cloud.projects[0]?.name ?? '');
  draftTitle.value = '';
  draftDescription.value = '';
  draftModel.value = '';
  draftPrefix.value = '';
  draftPlatform.value = '';
  draftBranch.value = '';
  editorOpen.value = true;
}

function openEdit(task: Task): void {
  editingId.value = task.id;
  editorError.value = null;
  draftProject.value = projectName(task.projectId);
  draftTitle.value = task.title;
  draftDescription.value = task.description ?? '';
  draftModel.value = task.model ?? '';
  draftPrefix.value = task.prefix ?? '';
  draftPlatform.value = task.platform ?? '';
  draftBranch.value = task.branch ?? '';
  editorOpen.value = true;
}

async function submitEditor(): Promise<void> {
  editorError.value = null;
  // Blank strings are meaningful: toTaskRow() turns them into NULL, which is how a user
  // clears a launch param they set earlier. The project is immutable after creation —
  // moving a task between projects would move it between membership sets.
  const fields = {
    title: draftTitle.value.trim(),
    description: draftDescription.value,
    model: draftModel.value,
    prefix: draftPrefix.value,
    platform: draftPlatform.value,
    branch: draftBranch.value,
  };

  if (editingId.value) {
    if (!(await board.updateTaskFields(editingId.value, fields))) {
      editorError.value = 'Хмара відмовила — подробиці в повідомленні';
      return;
    }
  } else {
    const projectId = projectIdByName(draftProject.value);
    if (!projectId) {
      editorError.value = 'Виберіть проєкт';
      return;
    }
    if (!(await board.createTask({ projectId, ...fields }))) {
      editorError.value = 'Не вдалося створити задачу — подробиці в повідомленні';
      return;
    }
  }
  editorOpen.value = false;
}

function onDelete(task: Task): void {
  void board.deleteTask(task.id);
}
```

- [ ] **Step 4: Add the modal styles**

Append to the `<style scoped lang="scss">` block:

```scss
.board__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.board__form-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.board__esc {
  font-family: var(--k-font-mono);
  font-size: 11px;
  color: var(--k-muted);
}

.board__error {
  margin: 0;
  font-family: var(--k-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-accent);
}
```

- [ ] **Step 5: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify create, edit, assign and the invariants in the browser**

With `supabase start`, `pnpm dev:api` and `pnpm dev:ui` running and a signed-in user who owns a project, open <http://localhost:5317/#/board>. Expected, in order:

1. «Нова задача» opens the modal titled «Нова задача»; the project select is pre-filled, «Створити» is disabled until a title is typed.
2. Fill title + description, pick `opus-5` / `fix` / `web`, type `main` as the base branch, press «Створити» → the modal closes and the card appears in Беклог with tags `opus-5` / `fix` / `web` / `⑂ main`.
3. Verify the row landed with the right author and default status:
   `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select status, created_by, assignee_id, model, prefix, platform, branch from tasks order by created_at desc limit 1;"`
   Expected: `status = backlog`, `created_by` = your profile id, `assignee_id` NULL, launch params as entered.
4. «Змінити» reopens the modal WITHOUT the project select, pre-filled from the card; clear the Платформа select back to the placeholder and save → the tag disappears and the column shows `platform` is NULL in psql.
5. The card's assignee select lists your GitHub handle; pick it → the card shows your avatar and the select keeps your handle. `select assignee_id from tasks …` matches your profile id.
6. Pick the placeholder option again → the assignment clears (`assignee_id` back to NULL).
7. Make the task active from Studio: `update tasks set status = 'thinking' where id = '<id>';`. The card moves to «В роботі» live. Now the assignee select is DISABLED, and «Видалити» produces the toast «Активну задачу не можна видалити» with the card still on the board and the row still in Postgres.
8. Set it back (`update tasks set status = 'backlog' …`), then «Видалити» → the card disappears and the row is gone.
9. Console clean throughout.

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/ui/src/pages/BoardPage.vue
git commit -m "feat(ui): board task create/edit modal, assign control and reserved launch button"
```

---

### Task 7: `WorkspacePage.vue` — link to the board and surface cloud task titles

**Files:**
- Modify: `apps/ui/src/pages/WorkspacePage.vue` (template: board controls at 16-20, `#cell-name` slot at 40-50; script: `vue` import at 448, store imports around 459, page setup after 484)

**Interfaces:**
- Consumes: `useBoard()` (Tasks 3-4) — `tasks`, `load()`; `Session.taskId?: string` (Plan B, `packages/core/src/types.ts`); `useRouter` from `vue-router`; the named route `board` (Task 5); `KBtn` and `KTag`, both already imported by this file (lines 464, 466).
- Produces: a «Дошка команди» button in the board header, and a `☁` tag on every local session row that carries a `taskId`.
- Non-goals: the file is NOT restructured. No new modal, no change to `KTable`'s columns, `boardRows`, `STATUS_RANK`, the launcher or any existing handler.

- [ ] **Step 1: Add the header link**

In the template, `.ws__board-controls` currently reads (lines 16-20):

```html
          <div class="ws__board-controls">
            <KToggle :options="viewOptions" v-model="viewMode" />
            <KBtn variant="ghost" @click="onNewChat">+ Швидкий чат</KBtn>
            <KBtn variant="primary" @click="openLauncher()">Нова задача</KBtn>
          </div>
```

Insert one line directly after line 16, so the cloud link sits leftmost and the local actions keep their order:

```html
            <KBtn variant="ghost" title="Спільна дошка задач команди" @click="goToBoard">Дошка команди</KBtn>
```

- [ ] **Step 2: Surface the cloud task title on local rows**

The `#cell-name` slot currently reads (lines 40-50):

```html
          <template #cell-name="{ row }">
            <span class="ws__cell-name" :class="{ 'ws__cell-name--child': !!row.parentSessionId }">
              <span v-if="row.parentSessionId" class="ws__branch-connector" aria-hidden="true">└</span>
              {{ row.name }}
              <KTag v-if="row.kind === 'discussion'">discussion</KTag>
```

Insert one line directly after line 43 (`{{ row.name }}`), before the first kind tag:

```html
              <KTag v-if="row.taskId">☁ {{ cloudTaskTitle(row.taskId) }}</KTag>
```

- [ ] **Step 3: Extend the script imports**

Line 448 currently reads:

```ts
import { computed, nextTick, ref, watch } from 'vue';
```

Replace it with:

```ts
import { computed, nextTick, onMounted, ref, watch } from 'vue';
```

Line 459 currently reads `import { useOrchestrator } from 'stores/orchestrator';`. Add two lines directly after it:

```ts
import { useBoard } from 'stores/board';
import { useRouter } from 'vue-router';
```

- [ ] **Step 4: Wire the board store and the two helpers**

Line 484 currently reads `const now = useNow();`. Insert after it:

```ts
const board = useBoard();
const router = useRouter();

// Sessions launched from the shared board carry `taskId`; naming the cloud task next to the
// local row is what ties the two boards together. load() — not subscribe() — on purpose:
// Realtime belongs to /board, this page only needs the titles, and load() swallows an
// unreachable cloud into board.loadError instead of toasting on every app open.
onMounted(() => {
  void board.load();
});

function cloudTaskTitle(taskId: string): string {
  return board.tasks.find((t) => t.id === taskId)?.title ?? 'з дошки';
}

function goToBoard(): void {
  void router.push({ name: 'board' });
}
```

- [ ] **Step 5: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors. `row.taskId` must resolve — it comes from Plan B's `Session.taskId?: string`.

- [ ] **Step 6: Verify both surfaces in the browser**

With the stack running and signed in, open <http://localhost:5317/#/>. Expected:
1. The selected project's board header shows «Дошка команди» to the left of the view toggle; clicking it navigates to `#/board`, and the browser Back button returns to the workspace.
2. Local sessions with no `taskId` look exactly as before — no new tag, no layout shift.
3. Attach a session to a cloud task by hand and confirm the tag. With a session id and a task id in scope:
   ```bash
   sqlite3 ~/.kermanych/kermanych.sqlite \
     "update sessions set task_id = '<task-uuid>' where id = '<session-id>';"
   ```
   Reload the page. Expected: that row shows `☁ <the task's title>` next to its name — the title comes from the board store, which `onMounted` loaded. If Supabase is unreachable the tag degrades to `☁ з дошки` and no toast appears.
4. Console clean.

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): link the workspace to the cloud board and name a session's task"
```

---

### Task 8: Two-account end-to-end verification

**Files:** none (manual verification). This is the board half of the spec's required pre-merge smoke; Plan D's Task 9 covers the cross-machine launch/status half.

**Prerequisites:** `supabase start`; `pnpm dev:api` and `pnpm dev:ui` running; TWO GitHub accounts, each having signed in at least once so both have a `profiles` row; two separate browser profiles (Chrome «Add profile», or one Chrome window plus one Firefox window — NOT two tabs of the same profile, which share the Supabase session storage).

- [ ] **Step 1: Set up one shared project**

As user **A**, sign in and create a project. Add user **B** as a member. If Plan B's members panel is not in front of you, do it in psql:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" <<'SQL'
insert into project_members (project_id, user_id, role)
values ((select id from projects where name = 'Acme Web'),
        (select id from profiles where github_username = '<B-handle>'), 'member');
select p.name, pr.github_username, m.role
from project_members m join projects p on p.id = m.project_id join profiles pr on pr.id = m.user_id;
SQL
```

Expected: two rows — A as `owner`, B as `member`.

- [ ] **Step 2: A creates a task, B sees it appear with no reload**

Open `#/board` in BOTH windows. As A: «Нова задача» → title «Оновити хедер», description «Прибрати захардкоджені кольори», model `opus-5`, prefix `feature` → «Створити».

Expected: the card appears in A's Беклог immediately, and in **B's Беклог within about a second without B touching anything** — this is the Realtime binding doing its job. B's card carries the same tags and «оновлено щойно».

- [ ] **Step 3: A assigns to B; both boards update**

As A, pick B's GitHub handle in the card's assignee select.

Expected: A's card shows B's handle and avatar. B's card shows the same, live. `select assignee_id from tasks;` in psql matches B's profile id.

- [ ] **Step 4: B edits the description; A sees it**

As B, «Змінити» on the card, replace the description with «Замінити hex на var(--k-*)», «Зберегти».

Expected: B's card text changes on save; A's card text changes live without a reload. This proves a `member` (not just the owner) may update a task — the `tasks` UPDATE policy is membership-scoped.

- [ ] **Step 5: An active task refuses reassignment, with the toast and no change**

In Supabase Studio (<http://127.0.0.1:54323>) set the status directly, bypassing the UI:

```sql
update tasks set status = 'thinking' where title = 'Оновити хедер';
```

Expected: on BOTH boards the card moves to «В роботі» live, and its assignee select becomes disabled. Now prove the invariant twice over:

1. In A's window, run `await window.__pinia_board?.assignTask?.('<task-id>', null)` — or simply attempt the reassignment by re-enabling the select in devtools. Either way the store's pre-check fires first: the toast reads **«Активну задачу не можна переасайнити»** and `select assignee_id from tasks;` is unchanged.
2. Bypass the UI entirely and prove the SERVER is the real gate, from A's window console (A's client, A's JWT):
   ```js
   const pinia = document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia;
   const client = pinia._s.get('auth').client;
   console.log(await client.from('tasks').update({ assignee_id: null }).eq('title', 'Оновити хедер'));
   ```
   Expected: an `error` whose `message` contains `task is active` (raised by `tasks_guard()`), and `assignee_id` still B's id. Same for a delete attempt.

Then release it: `update tasks set status = 'backlog' where title = 'Оновити хедер';` → both cards return to Беклог and the select re-enables.

- [ ] **Step 6: Sign-out tears the channel down**

In B's window, open devtools → Network → WS and note the live `/realtime/v1/websocket` connection. Sign out (Plan A's sign-out path, or from the console:
`document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia._s.get('auth').signOut()`).

Expected, in order:
1. B lands on `#/login`.
2. The realtime WebSocket closes — the Network panel shows it finished, and no new one opens.
3. The console has NO errors and no unhandled rejection (no `.on() after subscribe`, no "channel already subscribed").
4. As A, edit the task title. B's window receives NOTHING — no console noise, no state change; the board store's task list was cleared on sign-out.
5. B signs back in and opens `#/board`: the full current board is there, including A's edit, because `subscribe()` refetches before it opens the channel.

- [ ] **Step 7: Verify the board tolerates a lost channel**

With both boards open, stop the Realtime service (`supabase stop` then `supabase start`, or block it in devtools' offline mode). Expected: `useBoard().channelState` flips to `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` — check in A's console:

```js
document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia._s.get('board').channelState;
```

Expected: not `SUBSCRIBED`, and `offline` is `true`. Nothing is rendered for it yet — Plan D's Task 7 owns that banner. Navigate away from `/board` and back: the page remounts, `subscribe()` refetches the full list and re-opens the channel, and `channelState` returns to `SUBSCRIBED`.

- [ ] **Step 8: Full suites**

Run: `pnpm --filter @kermanych/cloud exec vitest run && pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: PASS / no type errors. (`apps/api` and `packages/core` are untouched by this plan; run their suites too if the working tree also carries sibling-plan work.)

- [ ] **Step 9: Clean up the smoke data**

Delete the smoke task and, if you created it only for this run, the project. B's membership row goes with the project (`on delete cascade`).

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" <<'SQL'
delete from tasks where title in ('Оновити хедер', 'Інша назва', 'Перенести хедер на токени');
delete from projects where name = 'Acme Web';
SQL
```

Expected: both boards go empty live (the cascade fires DELETE events for the tasks), and no card is left behind.

- [ ] **Step 10: Commit the completed plan**

This task ships no source change, so the only artifact is the plan itself with its boxes ticked — that is what tells the next reader the board half was actually verified.

```bash
git add kermanych/docs/superpowers/plans/2026-08-21-team-cloud-board-tasks.md
git commit -m "docs(plan): record the two-account cloud board verification"
```

---

## Self-Review

**Spec coverage — what this plan owns:**

- **Requirement 4** — «The board is shared: create, assign (self or member), describe, carry launch params (`model`, `prefix`, `platform`, `kind`, `branch`); Realtime updates every member's board live.»
  - create → Task 6 (`board.createTask` → `createTask` in `packages/cloud/src/tasks.ts`, Task 1);
  - assign to self or any member → Task 6's per-card assignee select over `useProjects().members`, `board.assignTask` → `assignTask` (Task 1);
  - describe → Task 6's multiline «Опис» field → `patchTask`;
  - launch params → the modal's `MODEL_OPTIONS`/`PREFIX_OPTIONS`/`PLATFORM_OPTIONS` + «Базова гілка», mapped through `toTaskRow` (Task 1) and summarised as `KTag`s on every card (Task 5). `kind` is carried by the type and the mapper but has no board control on purpose: it is the LOCAL session kind, decided at launch, not a property of a cloud card;
  - live for every member → Task 2's single filtered binding, Task 4's lifecycle, verified end-to-end in Task 8 Steps 2-4.
- **Requirement 8 (UI half)** — «An active task (`queued`, `thinking`, `tool`, `waiting_input`) cannot be reassigned or deleted.» Pre-checks in Task 3 using core's `ACTIVE_STATUSES`, toasts «Активну задачу не можна переасайнити» / «Активну задачу не можна видалити», the disabled assignee select in Task 5, and the rollback path that renders the server's `task is active` when the pre-check is bypassed. Task 8 Step 5 proves both layers.
- **Deviation D6** — «the cloud board is a NEW page.» `pages/BoardPage.vue` + the `board` route (Task 5). `WorkspacePage.vue` keeps rendering LOCAL sessions in its `KTable`; Task 7 adds exactly two things to it (a header link, a `☁` tag) and restructures nothing.
- **Spec's `packages/cloud` verification bullets** — «`claimTask` builds the `assignee_id is null` predicate; `subscribeTasks` filter string per project set» → Task 1's claim suite (including the `{ data: null, error: null }` lost-race assertion, verbatim) and Task 2's `tasksFilter` / binding suites.
- **Verified upstream behaviour** — every bullet the board depends on is implemented, not merely quoted: the `in` filter (Task 2), the 100-value cap fallback (`tasksFilter` returns `undefined`, the binding omits the key), bindings before `subscribe()` (enforced by the test fake, which throws otherwise), one binding per channel, `removeChannel` teardown, no `realtime.setAuth`, DELETE payloads carrying only the primary key, and the atomic-claim semantics.

**Deferred to sibling plans (intentionally not covered here):**

- **Plan A** — `supabase/**` (the `tasks` table, `task_status` enum, `tasks_guard()`, the RLS policies, `tasks` in the `supabase_realtime` publication), `packages/cloud/src/{types,client,status}.ts`, `stores/auth.ts`, `LoginPage.vue`/`AuthLayout.vue`, the router guard in `router/index.ts`, and all `Authorization: Bearer` work in `lib/api.ts`. This plan appends ONE barrel line to `packages/cloud/src/index.ts` and adds ONE child record to `routes.ts` at Plan A's marker comment — both declared as coordinated edits above, neither claiming ownership of the file.
- **Plan B** — the `Group` → `Project` cutover, `Session.projectId`/`Session.taskId?`, the SQLite migration, `packages/cloud/src/projects.ts`, `stores/projects.ts` (cloud projects + membership, including `loadMembers`), the local binding flow (`PUT /api/projects/:id/binding`, `api.setProjectBinding`, `KDirPicker`), the members panel, and marking orphaned local rows «поза хмарою» on the workspace side. This plan only READS `useProjects()` and `useOrchestrator().projects`, and enforces the orphan rule negatively: every card and every project option comes from `cloud.projects`, so a project the user no longer belongs to can never carry a cloud action (Task 5's `orphanCount` surfaces the count without offering one).
- **Plan D** — the real `launch()` body (`api.createSessionFromTask` + the unbound-project binding detour) replacing this plan's documented seam; `POST /api/sessions/from-task`; `status_outbox` + `CloudSyncService` (the producer of the status changes this board displays); rendering `board.offline` as a banner; the pending-outbox pill; and upgrading Task 5's plain «оновлено N хв тому» line into a staleness warning with an age threshold. This plan ships the button, the `isBound(task)` gate, the hint «Прив’яжіть локальну теку репозиторію», the `offline` flag and the age line — and renders no banner, so Plan D's Task 7 has nothing to undo. `pushTaskStatus` is DEFINED here (Task 1) and CALLED only by Plan D; `getTask` and `claimTask` likewise.
- Not in any plan, per the spec's non-goals: no heartbeat (staleness is `updated_at` age only), no i18n layer, no cross-machine session control, no transcripts/`currentTool`/`contextPercent` in the cloud.

**Ownership check:** no task here edits `apps/api/**`, `packages/core/**` (which is why `isActive()` wraps the existing exported `ACTIVE_STATUSES` instead of adding an `isActiveStatus()` helper to `packages/core/src/status.ts`), `apps/ui/src/lib/api.ts`, `apps/ui/src/stores/projects.ts`, `apps/ui/src/stores/auth.ts`, `supabase/**`, or `packages/cloud/src/{types,client,status,projects}.ts`. Two files are shared and edited as declared coordinated appends: `packages/cloud/src/index.ts` (Task 1 — one barrel line, confirmed against Plan A's hand-off note and Plan B's precedent) and `apps/ui/src/router/routes.ts` (Task 5 — one child record at Plan A's literal marker; the full merged file is shown so nothing is guessed).

**Placeholder scan:** none. Every code step carries the real code, and every test step carries real assertions. Two things that read like placeholders are not: (1) Task 5's four short members at the end of the script are replaced wholesale by Task 6 Step 3 and are named as such — `onDelete` already performs a real guarded delete; (2) `launch()` is a *declared* seam, documented in Plan D's own Interfaces block as the function whose body it replaces, and it does something honest (says the feature is not wired yet) rather than pretending to start a session. Runtime values the operator substitutes are marked: `<id>`, `<task-uuid>`, `<session-id>`, `<B-handle>`.

**Type consistency:** `Task`/`TaskInsert`/`TaskPatch`/`TaskStatus` are Plan A's types, never redefined. `TaskRow` and the `toTask`/`toTaskRow` mappers live only in `packages/cloud/src/tasks.ts`; no snake_case key appears in `stores/board.ts`, `BoardPage.vue` or `WorkspacePage.vue`. `TaskChange` and `TaskChannelState` are declared in Task 2 and consumed under exactly those names in Tasks 3-4. `subscribeTasks(client, projectIds, onChange, onState?)` matches its single call site. `claimTask` and `getTask` resolve `Task | undefined` — the shape Plan D's Interfaces block names. `board.updateTaskFields`/`assignTask`/`deleteTask` all resolve `boolean` and `createTask` resolves `Task | undefined`, which is what Task 6's `submitEditor` branches on. The page's `const board = useBoard()` / `const local = useOrchestrator()` variable names, `isBound(task)`, `launch(task)`, `board.offline`, `useNow()` and `relativeTime(iso, now)` are the exact identifiers Plan D's Tasks 6-7 expect.
