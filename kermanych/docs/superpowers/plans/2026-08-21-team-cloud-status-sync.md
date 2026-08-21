# Team cloud, part D: launch-from-task and offline-durable status sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the assignee launch a cloud task as a real local session on their own machine, and push that session's coarse status back to the cloud through a durable local outbox that survives being offline, signed out, or restarted.

**Architecture:** Direction is Task → Session. `POST /api/sessions/from-task { taskId }` reads the task under the user's JWT, enforces the assignee rule, atomically self-assigns an unassigned task, resolves the local `projects` row (the binding), refreshes its offline config cache from the cloud, and then hands off to the EXISTING `launch()` path (worktree + carry files + `omp --mode rpc`) unchanged. The reverse direction never touches the supervisor's 18 status-write sites: a new `CloudSyncService` subscribes to `supervisor.events$` exactly like `EventsGateway` does, keeps the last pushed status per task in memory, and on an edge change writes one row into the `status_outbox` SQLite table. A drain loop pushes those rows under the user's JWT with exponential backoff, so nothing local ever blocks on cloud availability.

**Tech Stack:** NestJS 10 (`apps/api`), `better-sqlite3` v13, RxJS 7, `@kermanych/core` + `@kermanych/cloud` (shared), Quasar 2 / Vue 3 / Pinia 2 (`apps/ui`), vitest.

**Spec:** [`docs/superpowers/specs/2026-08-21-team-cloud-design.md`](../specs/2026-08-21-team-cloud-design.md)

**Prerequisite plans (must be merged before starting):**
- **Plan A** — `docs/superpowers/plans/2026-08-21-team-cloud-foundation-auth.md`: Supabase schema/RLS, `@kermanych/cloud` (`client.ts`, `types.ts`, `status.ts`), `apps/api/src/auth/**` (`AuthService`, `SupabaseAuthGuard` as `APP_GUARD`, `@Public()`, `req.user = { id }`), `apps/ui` auth store + login + `Authorization: Bearer` in `lib/api.ts`, `apps/api/package.json` gains `@kermanych/cloud`.
- **Plan B** — `docs/superpowers/plans/2026-08-21-team-cloud-projects-binding.md`: `Group` → `Project` rename across core/api/ui, `Session.projectId` + `Session.taskId?`, the versioned SQLite migration, `registry.listProjects/upsertProject/patchProject/removeProject/listSessions(projectId?)`, `projects.controller.ts` incl. `PUT /api/projects/:id/binding`, `packages/cloud/src/projects.ts`, `apps/ui/src/stores/projects.ts` (`useProjects`), `api.setProjectBinding`.
- **Plan C** — `docs/superpowers/plans/2026-08-21-team-cloud-board-tasks.md`: `packages/cloud/src/tasks.ts` (incl. `pushTaskStatus`, `claimTask`, `getTask`), `apps/ui/src/stores/board.ts` (`useBoard`), `apps/ui/src/pages/BoardPage.vue` + the `/board` route and its inert `launch()` seam. Note: `relativeTime` lives in the pre-existing `apps/ui/src/lib/time.ts` and `useNow` in the pre-existing `apps/ui/src/composables/useNow.ts` — neither is created by Plan C, both are already in the repo.

This plan assumes all three are merged. Every symbol it consumes from them is named in the task's **Interfaces:** block.

## Global Constraints

- Node 22.x required (`better-sqlite3` native ABI).
- Code, identifiers, comments, commit messages in English; every UI-visible string in Ukrainian, inline. No i18n layer (spec: "No i18n layer; UI copy stays Ukrainian inline, code/identifiers English").
- **Only `status` (+ `updated_at`) leaves the machine, only on coarse changes.** Transcripts, `currentTool`, `contextPercent`, `todoPhases` and interactive prompts never leave the machine (Requirement 6, Non-goals).
- **Local work never blocks on cloud availability**: an existing session keeps running, answering, merging and finishing with Supabase unreachable, because the local `projects` row caches everything `launch()` reads; status pushes queue in a local outbox and retry (Requirement 7). The one cloud-bound step is STARTING a board task — `createSessionFromTask` must read and claim the task, so it fails fast with a clear error while offline; that is deliberate, since an offline machine cannot claim a shared task.
- **No service-role key on any machine**; every cloud write is under the user's JWT + RLS (Requirement 10).
- **D3 — the status push hooks into `events$`, not into the 18 `updateSession({status})` call sites.** `pushUpdate` (`apps/api/src/supervisor/supervisor.service.ts:88-91`) is the single point where a fully merged `Session` (durable ∪ live) is emitted. Zero edits inside the supervisor's status paths.
- **D5 — local session deletion pushes a terminal status.** `session_removed` does not pass through `pushUpdate`; if the removed session's task was active, `CloudSyncService` enqueues `stopped`.
- No heartbeat in v1 — stale detection is `updated_at` age in the UI only (Non-goals).
- Additive local schema uses the existing idioms in `registry.service.ts:27-102`: `try { ALTER TABLE … } catch {}` for columns, `CREATE TABLE IF NOT EXISTS` for tables. This plan adds NO versioned migration (Plan B owns `user_version` 0 → 1).
- Controllers keep the uniform error idiom: `try { … } catch (err) { throw new BadRequestException((err as Error).message); }`.
- Exact error strings, asserted by tests and matched by the UI: `task not found`, `task assigned to someone else`, `task already claimed`, `project not bound`, `not signed in`.
- Row↔domain mapping is snake_case→camelCase inside `@kermanych/cloud`; nothing outside that package sees snake_case. `apps/api` never queries Supabase tables directly.
- vitest runs for `apps/api`, `packages/core` and `packages/cloud`. `apps/ui` has NO component-test harness (only `test/socket.spec.ts`, no vitest config), so UI tasks are verified by running the app with `pnpm dev:api` + `pnpm dev:ui`.
- No new npm dependency is introduced by this plan: `@kermanych/cloud` is already a dependency of `apps/api` (Plan A) and `apps/ui` (Plans A–C).

## File Structure

| File | Created / Modified | Responsibility |
|---|---|---|
| `apps/api/src/registry/registry.service.ts` | Modify | `status_outbox` table + the four outbox methods. The only place SQL for the outbox lives. |
| `apps/api/test/registry.outbox.spec.ts` | Create | Outbox dedupe/bump/drop semantics against a real `:memory:` DB. |
| `apps/api/src/supervisor/supervisor.service.ts` | Modify | `createSessionFromTask` — the six-step launch flow. Third constructor dep (`AuthService`). No other line changes. |
| `apps/api/test/offline-auth.ts` | Create | One DI stub (`offlineAuth()`) reused by the 14 supervisor specs that never sign in. |
| `apps/api/test/sessions.from-task.spec.ts` | Create | The launch-from-task flow: assignee rule, claim, binding precondition, happy path. |
| `apps/api/src/http/sessions.controller.ts` | Modify | `POST /sessions/from-task`, declared above the `:id` block. |
| `apps/api/src/cloud/cloud-sync.service.ts` | Create | `events$` subscriber, edge dedupe, outbox drain with backoff, shutdown terminal status. |
| `apps/api/test/cloud-sync.spec.ts` | Create | Every bullet of the spec's `cloud-sync.spec.ts` verification list. |
| `apps/api/src/cloud/cloud.controller.ts` | Create | `GET /cloud/outbox` → `{ pending }` for the UI's local-queue indicator. |
| `apps/api/src/app.module.ts` | Modify (coordinated) | Register `CloudSyncService` + `CloudController`. Plan A owns the file's guard/auth wiring. |
| `apps/ui/src/lib/api.ts` | Modify (coordinated) | `createSessionFromTask`, `cloudOutbox`. Plan A owns the `Authorization` work in this file. |
| `apps/ui/src/pages/BoardPage.vue` | Modify (coordinated) | Launch handler, binding modal, offline banner, pending pill, stale rule. Plan C owns the page. |
| `README.md` | Modify | Task flow + offline behaviour. |

Two files are deliberately split rather than merged: the drain/subscribe logic (`cloud-sync.service.ts`) is stateful and event-driven, while `cloud.controller.ts` is a two-line read of SQLite — folding the read into the service would force the controller to depend on event-loop state it does not need.

---

### Task 1: `status_outbox` table + registry methods

**Files:**
- Modify: `apps/api/src/registry/registry.service.ts` (add the exported `OutboxRow` type above the class at line 10; append the `CREATE TABLE` at the end of the constructor, after the last additive migration — today the `["model", "prefix", "platform"]` loop at lines 96-102, after Plan B the `sessions.task_id` / `sessions_project_idx` block; add the four methods after `removeSession`, today line 231)
- Test: `apps/api/test/registry.outbox.spec.ts`

**Interfaces:**
- Consumes: `SessionStatus` from `@kermanych/core` (already imported at `registry.service.ts:8`).
- Produces:
  - `export type OutboxRow = { taskId: string; status: SessionStatus; updatedAt: string; attempts: number; lastError?: string }`
  - `enqueueTaskStatus(taskId: string, status: SessionStatus, updatedAt: string): void` — UPSERT keyed by `task_id`; a second enqueue for the same task overwrites `status`/`updated_at` and RESETS `attempts` to 0 and `last_error` to NULL (latest-wins dedupe).
  - `listOutbox(): OutboxRow[]` — oldest `updated_at` first.
  - `dropOutbox(taskId: string): void`
  - `bumpOutboxAttempt(taskId: string, error: string): void` — `attempts = attempts + 1`, `last_error = error`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/registry.outbox.spec.ts`:

```ts
// apps/api/test/registry.outbox.spec.ts
import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

test("enqueueTaskStatus keeps one latest-wins row per task", () => {
  const r = new RegistryService(":memory:");

  r.enqueueTaskStatus("task-1", "queued", "2026-08-21T10:00:00.000Z");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:05.000Z");

  const rows = r.listOutbox();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    taskId: "task-1",
    status: "thinking",
    updatedAt: "2026-08-21T10:00:05.000Z",
    attempts: 0,
    lastError: undefined,
  });
});

test("listOutbox returns every queued task oldest-first", () => {
  const r = new RegistryService(":memory:");

  r.enqueueTaskStatus("task-b", "done", "2026-08-21T11:00:00.000Z");
  r.enqueueTaskStatus("task-a", "thinking", "2026-08-21T10:00:00.000Z");

  expect(r.listOutbox().map((x) => x.taskId)).toEqual(["task-a", "task-b"]);
});

test("bumpOutboxAttempt increments attempts and persists last_error", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:00.000Z");

  r.bumpOutboxAttempt("task-1", "fetch failed");
  expect(r.listOutbox()[0].attempts).toBe(1);
  expect(r.listOutbox()[0].lastError).toBe("fetch failed");

  r.bumpOutboxAttempt("task-1", "not signed in");
  expect(r.listOutbox()[0].attempts).toBe(2);
  expect(r.listOutbox()[0].lastError).toBe("not signed in");
});

test("a fresh enqueue resets the retry counter of a failing row", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:00.000Z");
  r.bumpOutboxAttempt("task-1", "fetch failed");

  r.enqueueTaskStatus("task-1", "done", "2026-08-21T10:00:30.000Z");

  expect(r.listOutbox()[0]).toEqual({
    taskId: "task-1",
    status: "done",
    updatedAt: "2026-08-21T10:00:30.000Z",
    attempts: 0,
    lastError: undefined,
  });
});

test("dropOutbox removes the row and leaves the rest", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "done", "2026-08-21T10:00:00.000Z");
  r.enqueueTaskStatus("task-2", "error", "2026-08-21T10:00:01.000Z");

  r.dropOutbox("task-1");

  expect(r.listOutbox().map((x) => x.taskId)).toEqual(["task-2"]);
  r.dropOutbox("task-2");
  expect(r.listOutbox()).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.outbox.spec.ts`
Expected: FAIL — `r.enqueueTaskStatus is not a function`.

- [ ] **Step 3: Add the `OutboxRow` type**

In `apps/api/src/registry/registry.service.ts`, insert above `@Injectable()` (line 10):

```ts
// A queued cloud status push. One row per task — the outbox is a latest-wins mailbox, not a
// log: if a session goes thinking → tool → thinking while offline, only the newest status is
// worth sending, and the cloud board has no use for the intermediate ones.
export type OutboxRow = { taskId: string; status: SessionStatus; updatedAt: string; attempts: number; lastError?: string };
```

- [ ] **Step 4: Create the table**

Append at the very end of the constructor (after the last additive migration block):

```ts
    // Durable queue of cloud status pushes. `task_id` is the PRIMARY KEY, so an UPSERT
    // collapses a burst of changes into the newest one. No FK: the tasks live in Postgres.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS status_outbox (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
    );
```

- [ ] **Step 5: Add the four methods**

After `removeSession` (today `registry.service.ts:229-231`), inside the class:

```ts
  // Queue (or replace) the pending cloud status for a task. Resetting `attempts` is
  // deliberate: a NEW status is a new delivery, so it must not inherit the previous
  // status's backoff and wait a minute before its first try.
  enqueueTaskStatus(taskId: string, status: SessionStatus, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO status_outbox (task_id, status, updated_at, attempts, last_error) VALUES (?,?,?,0,NULL)
         ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, attempts = 0, last_error = NULL`,
      )
      .run(taskId, status, updatedAt);
  }

  listOutbox(): OutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT task_id as taskId, status, updated_at as updatedAt, attempts, last_error as lastError FROM status_outbox ORDER BY updated_at`,
      )
      .all() as (Omit<OutboxRow, "lastError"> & { lastError: string | null })[];
    return rows.map((r) => ({ ...r, lastError: r.lastError ?? undefined }));
  }

  dropOutbox(taskId: string): void {
    this.db.prepare(`DELETE FROM status_outbox WHERE task_id = ?`).run(taskId);
  }

  bumpOutboxAttempt(taskId: string, error: string): void {
    this.db.prepare(`UPDATE status_outbox SET attempts = attempts + 1, last_error = ? WHERE task_id = ?`).run(error, taskId);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.outbox.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the registry's other specs for regressions**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.spec.ts test/registry.branch.spec.ts test/registry.migration.spec.ts`
Expected: PASS — the new table is additive and touches no existing statement.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/registry/registry.service.ts apps/api/test/registry.outbox.spec.ts
git commit -m "feat(api): durable status_outbox table with latest-wins enqueue"
```

---

### Task 2: `SupervisorService.createSessionFromTask`

**Files:**
- Modify: `apps/api/src/supervisor/supervisor.service.ts` (imports at the top; constructor at lines 65-68; new method inserted after `createSession`, which ends at line 162, and before the `startTask` comment at line 164)
- Create: `apps/api/test/offline-auth.ts`
- Test: `apps/api/test/sessions.from-task.spec.ts`
- Modify (mechanical, 14 files): every existing `new SupervisorService(registry, worktree)` construction — listed in Step 7

**Interfaces:**
- Consumes:
  - `AuthService.cloudClient(): SupabaseClient` — throws `new Error("not signed in")` when there is no cached token (Plan A).
  - `getTask(client: SupabaseClient, taskId: string): Promise<Task | undefined>`, `claimTask(client: SupabaseClient, taskId: string, userId: string): Promise<Task | undefined>` (`undefined` = race lost; the predicate is `.is('assignee_id', null)` and the read is `.maybeSingle()`) — Plan C, `packages/cloud/src/tasks.ts`.
  - `listProjects(client: SupabaseClient): Promise<CloudProject[]>` — Plan B, `packages/cloud/src/projects.ts`.
  - `registry.listProjects(): Project[]`, `registry.patchProject(id, patch): Project`, `registry.createSession({ projectId, taskId, … })` — Plan B.
  - The private `resolveLaunchParams(project, name, prefix, worktree, excludeId?, requestedBase?)` and `launch(session, project, opts?)` already in this file (lines 333, 370) — after Plan B their first parameter is `Project` and they read `project.localRepoPath`.
- Produces: `SupervisorService.createSessionFromTask(taskId: string, userId: string): Promise<Session>` and the third constructor parameter `private auth: AuthService`. `apps/api/test/offline-auth.ts` exports `offlineAuth(): AuthService`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/sessions.from-task.spec.ts`:

```ts
// apps/api/test/sessions.from-task.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { CloudProject, Task } from "@kermanych/cloud";

// Capture every spawned RpcSession so a test can prove whether a launch happened.
const started: unknown[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: unknown) {
      started.push(opts);
    }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() {
      return { sessionId: "omp", sessionFile: "/tmp/s.jsonl" };
    }
    async getAllMessages() {
      return [];
    }
    async stop() {}
    prompt() {}
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

// Fake cloud: an in-memory `tasks` map + the project list. Mocked wholesale (no
// importOriginal) so this unit test never needs packages/cloud built and can flip the
// claim race by hand. `claimTask` reproduces the DB's `assignee_id is null` predicate:
// losing the race is zero rows, i.e. `undefined`, not an exception.
const cloudTasks = new Map<string, Task>();
const cloudProjects: CloudProject[] = [];
let claimWins = true;
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_client: unknown, taskId: string) => cloudTasks.get(taskId),
  claimTask: async (_client: unknown, taskId: string, userId: string) => {
    const t = cloudTasks.get(taskId);
    if (!t || t.assigneeId || !claimWins) return undefined;
    const next: Task = { ...t, assigneeId: userId };
    cloudTasks.set(taskId, next);
    return next;
  },
  listProjects: async () => cloudProjects,
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const NOW = "2026-08-21T10:00:00.000Z";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    removeBranch: vi.fn(),
    createBranchHere: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  // The launch path only forwards this client to @kermanych/cloud, which is mocked above.
  const auth = {
    current: () => ({ userId: USER, accessToken: "token" }),
    cloudClient: () => ({}),
  } as unknown as AuthService;
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth);
  return { sup, registry, worktree };
}

function task(over: Partial<Task> = {}): Task {
  const t: Task = {
    id: "task-1",
    projectId: PROJECT,
    title: "Add login",
    description: "wire GitHub OAuth",
    status: "backlog",
    createdBy: OTHER,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
  cloudTasks.set(t.id, t);
  return t;
}

function bind(registry: RegistryService, localRepoPath = "/tmp/proj"): void {
  registry.upsertProject({
    id: PROJECT,
    name: "stale local name",
    localRepoPath,
    carryFiles: [".env"],
    createdAt: NOW,
  });
  cloudProjects.push({
    id: PROJECT,
    name: "kermanych",
    carryFiles: [".env", ".env.local"],
    envKeys: ["GITHUB_TOKEN"],
    defaultBranch: "main",
    ownerId: OTHER,
    createdAt: NOW,
  });
}

beforeEach(() => {
  started.length = 0;
  cloudTasks.clear();
  cloudProjects.length = 0;
  claimWins = true;
});

describe("createSessionFromTask", () => {
  it("refuses a task assigned to somebody else", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: OTHER });

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task assigned to someone else");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("refuses an unknown task", async () => {
    const { sup } = make();

    await expect(sup.createSessionFromTask("nope", USER)).rejects.toThrow("task not found");
    expect(started).toHaveLength(0);
  });

  it("self-assigns an unassigned task and launches it", async () => {
    const { sup, registry } = make();
    bind(registry);
    task();

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(cloudTasks.get("task-1")!.assigneeId).toBe(USER);
    expect(session.taskId).toBe("task-1");
    expect(session.projectId).toBe(PROJECT);
    expect(started).toHaveLength(1);
    expect(registry.listSessions()).toHaveLength(1);
  });

  it("refuses when the atomic claim loses the race", async () => {
    const { sup, registry } = make();
    bind(registry);
    task();
    claimWins = false;

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task already claimed");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("refuses when the project has no local binding", async () => {
    const { sup, registry } = make();
    task({ assigneeId: USER });

    // No local row at all.
    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("project not bound");

    // Row exists but the path is empty (created by a cloud sync, never bound on this machine).
    bind(registry, "");
    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("project not bound");
    expect(started).toHaveLength(0);
  });

  it("launches the assignee's task, carrying task fields onto the session", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({
      assigneeId: USER,
      model: "opus-5",
      prefix: "fix",
      platform: "web",
      branch: "release/2026-08",
    });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.name).toBe("Add login");
    expect(session.task).toBe("wire GitHub OAuth");
    expect(session.model).toBe("opus-5");
    expect(session.prefix).toBe("fix");
    expect(session.platform).toBe("web");
    expect(session.kind).toBe("agent");
    expect(session.branch).toBe("fix/add-login");
    expect(session.baseBranch).toBe("release/2026-08");
    expect(session.worktree).toBe(true);
    // Exactly one omp child, spawned in the session's worktree.
    expect(started).toHaveLength(1);
    expect(worktree.addWorktree).toHaveBeenCalledTimes(1);
    // Step 5 of the spec: the local config cache is refreshed from the cloud project.
    const local = registry.listProjects().find((p) => p.id === PROJECT)!;
    expect(local.name).toBe("kermanych");
    expect(local.carryFiles).toEqual([".env", ".env.local"]);
    expect(local.localRepoPath).toBe("/tmp/proj");
  });

  it("falls back to the task title and safe launch defaults", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, description: undefined, prefix: "nonsense", platform: "watch" });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.task).toBe("Add login");
    expect(session.prefix).toBe("feature");
    expect(session.platform).toBeUndefined();
    // Cloud task carried no branch → the refreshed project default is used.
    expect(session.baseBranch).toBe("main");
  });

  it("rolls the session row back when the launch fails", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER });
    worktree.addWorktree.mockRejectedValueOnce(new Error("fatal: invalid reference"));

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("fatal: invalid reference");
    expect(registry.listSessions()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/sessions.from-task.spec.ts`
Expected: FAIL — `sup.createSessionFromTask is not a function` (and a TS arity complaint on the 3-arg `new SupervisorService`).

- [ ] **Step 3: Add the imports and the third constructor dependency**

In `apps/api/src/supervisor/supervisor.service.ts`, add to the import block (after the `@kermanych/core` import that ends at line 31):

```ts
import { claimTask, getTask, listProjects } from "@kermanych/cloud";
import { AuthService } from "../auth/auth.service";
```

Replace the constructor (lines 65-68):

```ts
  constructor(
    private registry: RegistryService,
    private worktree: WorktreeService,
    private auth: AuthService,
  ) {}
```

`AuthService` is the only new dependency, and it is used by exactly one method. It is injected rather than passed per call because `createSessionFromTask` is reached from HTTP with nothing but a `userId`, and the cached-token client belongs to the process, not the request. Direction of dependency: `SupervisorService → AuthService → RegistryService`; nothing in `AuthService` knows about the supervisor, so there is no cycle.

- [ ] **Step 4: Add `createSessionFromTask`**

Insert after `createSession` (which ends at line 162), before the `// Turn a backlog task into a running agent…` comment at line 164:

```ts
  // Launch a CLOUD task on this machine. The cloud decides who may run a task (assignee +
  // atomic claim) and owns the project config; SQLite owns where the repo lives locally.
  // From `registry.createSession` onward this is byte-for-byte the ordinary launch path, so
  // a task-born session behaves exactly like a locally created one — including offline.
  async createSessionFromTask(taskId: string, userId: string): Promise<Session> {
    const client = this.auth.cloudClient();

    const task = await getTask(client, taskId);
    if (!task) throw new Error("task not found");
    if (task.assigneeId && task.assigneeId !== userId) throw new Error("task assigned to someone else");
    if (!task.assigneeId) {
      // Atomic self-assign (`update … where assignee_id is null`). A lost race is not a DB
      // error, it is zero updated rows — hence `undefined` rather than a throw.
      const claimed = await claimTask(client, taskId, userId);
      if (!claimed) throw new Error("task already claimed");
    }

    const local = this.registry.listProjects().find((p) => p.id === task.projectId);
    if (!local?.localRepoPath) throw new Error("project not bound");

    // D1: the local row is the binding AND the offline config cache. Refresh it while we
    // are demonstrably online, so the next launch of this project needs no network at all.
    const cloudProject = (await listProjects(client)).find((p) => p.id === task.projectId);
    const project = cloudProject
      ? this.registry.patchProject(local.id, {
          name: cloudProject.name,
          color: cloudProject.color,
          previewCommand: cloudProject.previewCommand,
          apiCommand: cloudProject.apiCommand,
          carryFiles: cloudProject.carryFiles,
          defaultBranch: cloudProject.defaultBranch,
          conventions: cloudProject.conventions,
        })
      : local;

    // The board stores launch params as free text; validate them against the local
    // vocabularies instead of casting, so a bad card cannot produce a bogus branch prefix.
    const prefix: BranchPrefix = (BRANCH_PREFIXES as readonly string[]).includes(task.prefix ?? "")
      ? (task.prefix as BranchPrefix)
      : "feature";
    const platform = (PLATFORMS as readonly string[]).includes(task.platform ?? "")
      ? (task.platform as Session["platform"])
      : undefined;

    // Always a worktree: a cloud task must never commandeer the developer's checkout.
    const { branch, baseBranch } = await this.resolveLaunchParams(
      project,
      task.title,
      prefix,
      true,
      undefined,
      task.branch ?? project.defaultBranch,
    );
    const session = this.registry.createSession({
      projectId: project.id,
      taskId: task.id,
      name: task.title,
      task: task.description ?? task.title,
      worktreePath: "",
      branch,
      worktree: true,
      baseBranch,
      model: task.model,
      prefix,
      platform,
    });
    try {
      return await this.launch(session, project);
    } catch (err) {
      this.registry.removeSession(session.id);
      this.events.next({ type: "session_removed", sessionId: session.id });
      throw err;
    }
  }
```

Two notes for the implementer:

1. `BRANCH_PREFIXES` and `PLATFORMS` are VALUE exports of `@kermanych/core` (`packages/core/src/worktree-names.ts:29`, `packages/core/src/platform.ts:4`). The file's `@kermanych/core` import is a multi-line list (lines 11-31) whose value imports come first and whose type imports follow; insert the two names right after `toolCallSummary,` (line 20), before `type BranchPrefix` (line 21):

```ts
  toolCallSummary,
  BRANCH_PREFIXES,
  PLATFORMS,
  type BranchPrefix,
```

2. `task.kind` is intentionally NOT mapped onto `Session.kind`. The local `kind` is a row taxonomy (`agent | task | discussion | review | chat`) that decides whether a row owns a branch and a child process; a launched cloud task is always an `agent` (the registry default). The cloud's `kind` is board metadata. Mapping one onto the other would let a card create a `chat` row with a branch it must not have.

- [ ] **Step 5: Create the shared offline-auth DI stub**

Create `apps/api/test/offline-auth.ts`:

```ts
// apps/api/test/offline-auth.ts
// DI stub for the supervisor specs that never sign in. Those tests exercise launch, merge,
// finish and restart — paths that never reach the cloud — but the constructor now requires
// an AuthService, so hand them one that refuses exactly the way the real service does when
// no token is cached. If a test accidentally reaches a cloud path it fails loudly with
// "not signed in" instead of silently talking to a half-mocked object.
import type { AuthService } from "../src/auth/auth.service";

export function offlineAuth(): AuthService {
  return {
    current: () => undefined,
    cloudClient: () => {
      throw new Error("not signed in");
    },
  } as unknown as AuthService;
}
```

- [ ] **Step 6: Run the new spec to verify it passes**

Run: `pnpm --filter @kermanych/api exec vitest run test/sessions.from-task.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Update the 14 existing `new SupervisorService(...)` sites**

Every file below gets one added import line, `import { offlineAuth } from "./offline-auth";`, placed after its existing `import { RegistryService } from "../src/registry/registry.service";` line, plus the one-line construction change shown:

| File | Line | Replace with |
|---|---|---|
| `apps/api/test/create-guards.spec.ts` | 28 | `  sup = new SupervisorService(reg, wt, offlineAuth());` |
| `apps/api/test/finish.spec.ts` | 30 | `  sup = new SupervisorService(reg, wt, offlineAuth());` |
| `apps/api/test/reopen.spec.ts` | 30 | `  sup = new SupervisorService(reg, wt, offlineAuth());` |
| `apps/api/test/supervisor.base-branch.spec.ts` | 44 | `  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());` |
| `apps/api/test/supervisor.branch.spec.ts` | 30 | `  const sup = new SupervisorService(registry, worktree, offlineAuth());` |
| `apps/api/test/supervisor.chat.spec.ts` | 55 | `  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());` |
| `apps/api/test/supervisor.discard.spec.ts` | 22 | `  return { sup: new SupervisorService(registry, worktree, offlineAuth()), registry, worktree };` |
| `apps/api/test/supervisor.group.spec.ts` | 27 | `  return { sup: new SupervisorService(registry, worktree, offlineAuth()), registry, worktree };` |
| `apps/api/test/supervisor.merge.spec.ts` | 28 | `  return { sup: new SupervisorService(registry, worktree, offlineAuth()), registry };` |
| `apps/api/test/supervisor.pr.spec.ts` | 32 | `  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());` |
| `apps/api/test/supervisor.restart.spec.ts` | 38 | `  const sup = new SupervisorService(registry, worktree, offlineAuth());` |
| `apps/api/test/supervisor.resume.spec.ts` | 42 | `  const sup = new SupervisorService(registry, worktree, offlineAuth());` |
| `apps/api/test/supervisor.review.spec.ts` | 34 | `  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());` |
| `apps/api/test/supervisor.tasks.spec.ts` | 44 | `  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());` |

Note: Plan B renamed `supervisor.group.spec.ts`'s subject but not the file; if it was renamed to `supervisor.project.spec.ts` by Plan B, apply the same edit to the renamed file. Confirm the set with:

Run: `grep -rn "new SupervisorService(" apps/api/test apps/api/src`
Expected: 14 test call sites, all three-argument, and zero in `src` (Nest constructs it).

- [ ] **Step 8: Run the whole api suite**

Run: `pnpm --filter @kermanych/api exec vitest run`
Expected: PASS — all specs, including the 14 updated ones.

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @kermanych/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/supervisor/supervisor.service.ts apps/api/test/offline-auth.ts apps/api/test/sessions.from-task.spec.ts apps/api/test/create-guards.spec.ts apps/api/test/finish.spec.ts apps/api/test/reopen.spec.ts apps/api/test/supervisor.base-branch.spec.ts apps/api/test/supervisor.branch.spec.ts apps/api/test/supervisor.chat.spec.ts apps/api/test/supervisor.discard.spec.ts apps/api/test/supervisor.group.spec.ts apps/api/test/supervisor.merge.spec.ts apps/api/test/supervisor.pr.spec.ts apps/api/test/supervisor.restart.spec.ts apps/api/test/supervisor.resume.spec.ts apps/api/test/supervisor.review.spec.ts apps/api/test/supervisor.tasks.spec.ts
git commit -m "feat(api): launch a local session from a cloud task with assignee + claim checks"
```

---

### Task 3: `POST /api/sessions/from-task`

**Files:**
- Modify: `apps/api/src/http/sessions.controller.ts` (insert after the `@Post("chat")` handler, which ends at line 40, and above `@Post(":id/start")` at line 42)

**Interfaces:**
- Consumes: `SupervisorService.createSessionFromTask(taskId, userId)` (Task 2); `req.user = { id: string }` set by `SupabaseAuthGuard` (Plan A); `GET /sessions` with `@Query("projectId")` and `reg.listSessions(projectId?)` (Plan B — this task does NOT edit that handler, it only verifies it).
- Produces: `POST /api/sessions/from-task { taskId }` → `Session`; `400` with the service's message on every refusal.

- [ ] **Step 1: Add the route**

In `apps/api/src/http/sessions.controller.ts`, extend the `@nestjs/common` import at line 2 with `Req`:

```ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
```

Then insert the handler after the `createChat` method (line 40):

```ts
  // A literal segment, so it MUST be declared above the `:id` block — Nest matches in
  // declaration order and `:id/...` would otherwise swallow `from-task` (same reason
  // `@Post("chat")` sits above `@Post(":id/start")`).
  // The task id is the ONLY input: who may run it comes from the guard's cached token,
  // never from the request body.
  @Post("from-task")
  async createFromTask(@Body() b: { taskId: string }, @Req() req: { user: { id: string } }) {
    try {
      return await this.sup.createSessionFromTask(b.taskId, req.user.id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
```

- [ ] **Step 2: Verify the route order in the source**

Run: `grep -n '@Post(\|@Get(' apps/api/src/http/sessions.controller.ts`
Expected: `@Post("from-task")` appears BEFORE the first `":id` route. If it does not, move it.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kermanych/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify against the running API**

Start the API with `pnpm dev:api`. Sign in through the UI once (`pnpm dev:ui`, "Увійти через GitHub") so the local API has a cached token, then read it out of SQLite for curl:

```bash
TOKEN=$(sqlite3 ~/.kermanych/kermanych.sqlite 'select access_token from auth_session where id = 1')
# 1. no credentials → the global guard refuses
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4317/api/sessions/from-task \
  -H 'content-type: application/json' -d '{"taskId":"00000000-0000-0000-0000-000000000000"}'
# 2. authenticated, unknown task → the handler ran (route order is correct)
curl -s -X POST http://127.0.0.1:4317/api/sessions/from-task \
  -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"taskId":"00000000-0000-0000-0000-000000000000"}'
# 3. Plan B's list route still filters by project
curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:4317/api/sessions?projectId=00000000-0000-0000-0000-000000000000'
```

Expected: (1) `401`; (2) `{"message":"task not found","error":"Bad Request","statusCode":400}` — a 404 would mean the literal route is shadowed; (3) `[]`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/http/sessions.controller.ts
git commit -m "feat(api): POST /sessions/from-task launches the caller's cloud task"
```

---

### Task 4: `CloudSyncService` — edge-triggered push with a draining outbox

**Files:**
- Create: `apps/api/src/cloud/cloud-sync.service.ts`
- Test: `apps/api/test/cloud-sync.spec.ts`

**Interfaces:**
- Consumes: `supervisor.events$: Observable<ServerEvent>` (`supervisor.service.ts:63`); `registry.enqueueTaskStatus/listOutbox/dropOutbox/bumpOutboxAttempt` (Task 1); `AuthService.cloudClient()` and `AuthService.onToken(cb: (auth: { userId: string; accessToken: string }) => void): void` — fired at the end of a successful `setToken()` (Plan A); `pushTaskStatus(client, taskId, status, updatedAt): Promise<void>` and `taskStatusFromSession(session): TaskStatus` from `@kermanych/cloud` (Plans A/C); `ACTIVE_STATUSES` from `@kermanych/core` (`status.ts:10`).
- Produces: `CloudSyncService implements OnModuleInit, OnModuleDestroy` with a public `drain(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/cloud-sync.spec.ts`:

```ts
// apps/api/test/cloud-sync.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Subject } from "rxjs";
import type { ServerEvent, Session } from "@kermanych/core";
import type { AuthService } from "../src/auth/auth.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";

// Fake cloud transport. Mocked wholesale (no importOriginal) so the unit test needs no
// built packages/cloud and can be switched to failing mode mid-test.
// `taskStatusFromSession` is the identity map, mirroring packages/cloud/src/status.ts.
const pushed: { taskId: string; status: string; updatedAt: string }[] = [];
let failing = false;
vi.mock("@kermanych/cloud", () => ({
  taskStatusFromSession: (s: { status: string }) => s.status,
  pushTaskStatus: async (_client: unknown, taskId: string, status: string, updatedAt: string) => {
    if (failing) throw new Error("fetch failed");
    pushed.push({ taskId, status, updatedAt });
  },
}));

import { CloudSyncService } from "../src/cloud/cloud-sync.service";
import { RegistryService } from "../src/registry/registry.service";

const NOW = "2026-08-21T10:00:00.000Z";

function make(opts: { signedIn?: boolean } = {}) {
  const registry = new RegistryService(":memory:");
  const events = new Subject<ServerEvent>();
  // Partial mock: CloudSyncService only ever reads `events$`. Cast once at the DI seam.
  const supervisor = { events$: events.asObservable() } as unknown as SupervisorService;
  const tokenListeners: (() => void)[] = [];
  let signedIn = opts.signedIn ?? true;
  const auth = {
    onToken: (cb: () => void) => tokenListeners.push(cb),
    cloudClient: () => {
      if (!signedIn) throw new Error("not signed in");
      return {};
    },
  } as unknown as AuthService;
  const sync = new CloudSyncService(supervisor, registry, auth);
  sync.onModuleInit();
  return {
    sync,
    registry,
    events,
    signIn: () => {
      signedIn = true;
      for (const cb of tokenListeners) cb();
    },
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    taskId: "t1",
    name: "Add login",
    task: "wire GitHub OAuth",
    worktreePath: "/tmp/wt",
    branch: "feature/add-login",
    worktree: true,
    kind: "agent",
    status: "thinking",
    archived: false,
    createdAt: NOW,
    lastActivityAt: NOW,
    ...over,
  };
}

// Let the `void this.drain()` microtask chain settle.
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  pushed.length = 0;
  failing = false;
});

describe("CloudSyncService", () => {
  it("pushes a status change once and dedupes repeats", async () => {
    const { registry, events } = make();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["thinking"]);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("ignores updates that do not change the status", async () => {
    const { events } = make();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "thinking", contextPercent: 42 }) });
    events.next({ type: "session_update", session: session({ status: "thinking", currentTool: "read" }) });
    await flush();

    expect(pushed).toHaveLength(1);
  });

  it("ignores sessions that carry no task", async () => {
    const { registry, events } = make();

    events.next({ type: "session_update", session: session({ taskId: undefined }) });
    await flush();

    expect(pushed).toHaveLength(0);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("keeps the row with attempts = 1 when the push fails, then drains on reconnect", async () => {
    const { sync, registry, events } = make();
    failing = true;

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();

    const queued = registry.listOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0].taskId).toBe("t1");
    expect(queued[0].status).toBe("thinking");
    expect(queued[0].attempts).toBe(1);
    expect(queued[0].lastError).toBe("fetch failed");
    expect(pushed).toHaveLength(0);

    failing = false;
    await sync.drain();

    expect(pushed.map((p) => p.status)).toEqual(["thinking"]);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("collapses an offline burst into the newest status", async () => {
    const { sync, registry, events } = make();
    failing = true;

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "tool" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "done" }) });
    await flush();

    expect(registry.listOutbox()).toHaveLength(1);
    failing = false;
    await sync.drain();

    expect(pushed.map((p) => p.status)).toEqual(["done"]);
  });

  it("holds the queue while signed out and drains on the token handoff", async () => {
    const { registry, events, signIn } = make({ signedIn: false });

    events.next({ type: "session_update", session: session({ status: "queued" }) });
    await flush();

    expect(pushed).toHaveLength(0);
    // Not a delivery failure: nothing was attempted, so the retry counter stays clean.
    expect(registry.listOutbox()[0].attempts).toBe(0);

    signIn();
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["queued"]);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("pushes `stopped` when an active task's session is deleted", async () => {
    const { events } = make();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_removed", sessionId: "s1" });
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["thinking", "stopped"]);
  });

  it("does not resurrect a finished task when its session is deleted", async () => {
    const { events } = make();

    events.next({ type: "session_update", session: session({ status: "done" }) });
    await flush();
    events.next({ type: "session_removed", sessionId: "s1" });
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["done"]);
  });

  it("enqueues `stopped` for every live task-bound session on shutdown", async () => {
    const { sync, registry, events } = make();

    events.next({ type: "session_update", session: session({ id: "s1", taskId: "t1", status: "thinking" }) });
    events.next({ type: "session_update", session: session({ id: "s2", taskId: "t2", status: "tool" }) });
    events.next({ type: "session_update", session: session({ id: "s3", taskId: "t3", status: "done" }) });
    await flush();
    pushed.length = 0;

    sync.onModuleDestroy();

    // Written synchronously to SQLite, so a hard exit right after cannot lose them; they
    // are pushed by the next boot's drain.
    expect(registry.listOutbox().map((r) => [r.taskId, r.status])).toEqual([
      ["t1", "stopped"],
      ["t2", "stopped"],
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/cloud-sync.spec.ts`
Expected: FAIL — "Cannot find module '../src/cloud/cloud-sync.service'".

- [ ] **Step 3: Implement the service**

Create `apps/api/src/cloud/cloud-sync.service.ts`:

```ts
// apps/api/src/cloud/cloud-sync.service.ts
// Local → cloud status mirror. The ONLY component that writes to Supabase from this
// process. It never mutates a session and never blocks one: everything it needs is on
// `supervisor.events$`, and every push it owes goes through a SQLite outbox first.
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ACTIVE_STATUSES, type Session } from "@kermanych/core";
import { pushTaskStatus, taskStatusFromSession, type TaskStatus } from "@kermanych/cloud";
import { RegistryService } from "../registry/registry.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import { AuthService } from "../auth/auth.service";
import type { OutboxRow } from "../registry/registry.service";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

@Injectable()
export class CloudSyncService implements OnModuleInit, OnModuleDestroy {
  // Last status actually enqueued per TASK — the edge filter. Mirrors the `shouldNotify`
  // idiom in core/status.ts: act on transitions, not on repeats.
  private lastPushed = new Map<string, TaskStatus>();
  // sessionId → taskId. `session_removed` carries only the id and the row is already gone
  // from SQLite by then (supervisor.service.ts:817-818), so the binding must be remembered.
  private taskOf = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private supervisor: SupervisorService,
    private registry: RegistryService,
    private auth: AuthService,
  ) {}

  onModuleInit(): void {
    // Same subscription shape as EventsGateway (ws/events.gateway.ts:21-23): subscribe from
    // outside instead of reaching into the supervisor's status paths (D3).
    this.supervisor.events$.subscribe((e) => {
      if (e.type === "session_update") this.onSession(e.session);
      else if (e.type === "session_removed") this.onRemoved(e.sessionId);
    });
    // Relogin / TOKEN_REFRESHED: a queue parked on "not signed in" resumes immediately
    // instead of waiting out its backoff.
    this.auth.onToken(() => void this.drain());
    // A previous run may have exited with rows still queued (offline, or the shutdown
    // `stopped` writes below).
    void this.drain();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // A clean shutdown must never leave the board on `thinking` (spec: "so a clean shutdown
    // never leaves the board on thinking"). Enqueue only — the write is synchronous and
    // durable, whereas an awaited HTTP push would race the process exit.
    for (const taskId of new Set(this.taskOf.values())) {
      const last = this.lastPushed.get(taskId);
      if (last && ACTIVE_STATUSES.includes(last)) {
        this.lastPushed.set(taskId, "stopped");
        this.registry.enqueueTaskStatus(taskId, "stopped", new Date().toISOString());
      }
    }
  }

  private onSession(s: Session): void {
    if (!s.taskId) return;
    this.taskOf.set(s.id, s.taskId);
    const status = taskStatusFromSession(s);
    // `pushUpdate` also fires for contextPercent/todoPhases/task edits — those must cost
    // nothing (Requirement 6: only coarse status changes leave the machine).
    if (this.lastPushed.get(s.taskId) === status) return;
    this.lastPushed.set(s.taskId, status);
    this.registry.enqueueTaskStatus(s.taskId, status, new Date().toISOString());
    void this.drain();
  }

  private onRemoved(sessionId: string): void {
    const taskId = this.taskOf.get(sessionId);
    if (!taskId) return;
    this.taskOf.delete(sessionId);
    const last = this.lastPushed.get(taskId);
    // D5: only an ACTIVE task needs a terminal push; a session deleted after `done`/`merged`
    // must not have its outcome overwritten by `stopped`.
    if (!last || !ACTIVE_STATUSES.includes(last)) return;
    this.lastPushed.set(taskId, "stopped");
    this.registry.enqueueTaskStatus(taskId, "stopped", new Date().toISOString());
    void this.drain();
  }

  // Push everything queued. Safe to call concurrently — overlapping calls collapse into the
  // running one, and whatever they queued is picked up by its `listOutbox()` read or by the
  // re-armed timer.
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.pass();
    } finally {
      this.draining = false;
    }
  }

  private async pass(): Promise<void> {
    const rows = this.registry.listOutbox();
    if (!rows.length) return;

    let client: ReturnType<AuthService["cloudClient"]>;
    try {
      client = this.auth.cloudClient();
    } catch {
      // Signed out: nothing was attempted, so `attempts` stays untouched and the row keeps
      // its place in the queue. The next token handoff drains it.
      this.rearm(rows);
      return;
    }

    for (const row of rows) {
      try {
        await pushTaskStatus(client, row.taskId, row.status, row.updatedAt);
        this.registry.dropOutbox(row.taskId);
      } catch (err) {
        const message = (err as Error).message;
        this.registry.bumpOutboxAttempt(row.taskId, message);
        console.warn(`[cloud-sync] status push for task ${row.taskId} failed (attempt ${row.attempts + 1}): ${message}`);
      }
    }
    this.rearm(this.registry.listOutbox());
  }

  // Exponential backoff — first retry ~2 s (attempts is already 1 after the first
  // failure), doubling to a 60 s cap — driven by the least-retried row so a single
  // poisoned row cannot starve a fresh one. Unref'd: a pending retry must never
  // hold the process open.
  private rearm(rows: OutboxRow[]): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!rows.length) return;
    const attempts = Math.min(...rows.map((r) => r.attempts));
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
    this.timer.unref();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kermanych/api exec vitest run test/cloud-sync.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kermanych/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cloud/cloud-sync.service.ts apps/api/test/cloud-sync.spec.ts
git commit -m "feat(api): CloudSyncService mirrors session status to the cloud via a durable outbox"
```

---

### Task 5: Wire it up — `AppModule` + `GET /api/cloud/outbox`

**Files:**
- Create: `apps/api/src/cloud/cloud.controller.ts`
- Modify (coordinated edit to a Plan A file): `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: Plan A's `app.module.ts`, which ships `controllers: [AuthController, ProjectsController, SessionsController, FsController]` and `providers: [RegistryService, WorktreeService, SupervisorService, PreviewService, EnvFileService, EventsGateway, AuthService, { provide: APP_GUARD, useClass: SupabaseAuthGuard }]` (Plan B renames `GroupsController` → `ProjectsController` there). This task APPENDS to those two arrays and changes nothing else in the file.
- Produces: `GET /api/cloud/outbox` → `{ pending: number }`; `CloudSyncService` instantiated at boot (its `onModuleInit` is what starts the mirror).

**Why a REST endpoint for the outbox:** the UI must distinguish two different failures. "The cloud is unreachable from the browser" is already visible to the UI through the Realtime channel state (`useBoard().offline`). "This machine owes the cloud N status pushes" is knowable ONLY inside the local Nest process — the browser can be perfectly online while the local API's token is expired or its DNS is blocked, which is exactly the smoke scenario in Task 9. The alternative, a new `ServerEvent` variant, would mean editing `packages/core/src/types.ts` (Plan B's file), the gateway and the UI reducer to carry a counter that changes at most a few times a minute. A 3-line read of SQLite polled by the board is cheaper and touches nobody else's files.

- [ ] **Step 1: Create the controller**

Create `apps/api/src/cloud/cloud.controller.ts`:

```ts
// apps/api/src/cloud/cloud.controller.ts
import { Controller, Get } from "@nestjs/common";
import { RegistryService } from "../registry/registry.service";

@Controller("cloud")
export class CloudController {
  constructor(private reg: RegistryService) {}

  // How many status pushes this machine still owes the cloud. The board renders a distinct
  // indicator for it: the browser's Realtime channel can be healthy while our own pushes are
  // stuck (expired token, blocked host), and only this process can see that.
  @Get("outbox")
  outbox(): { pending: number } {
    return { pending: this.reg.listOutbox().length };
  }
}
```

The route is intentionally NOT `@Public()`: it reports on the signed-in user's own queue and is covered by the global `SupabaseAuthGuard`.

- [ ] **Step 2: Register both in `AppModule`**

In `apps/api/src/app.module.ts`, add the two imports next to the existing ones:

```ts
import { CloudController } from "./cloud/cloud.controller";
import { CloudSyncService } from "./cloud/cloud-sync.service";
```

Append `CloudController` to the `controllers` array and `CloudSyncService` to the `providers` array (keep every entry Plan A/B put there):

```ts
  controllers: [AuthController, ProjectsController, SessionsController, FsController, CloudController],
  providers: [
    RegistryService,
    WorktreeService,
    SupervisorService,
    PreviewService,
    EnvFileService,
    EventsGateway,
    AuthService,
    CloudSyncService,
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
  ],
```

Dependency direction, stated once so nobody inverts it later: `CloudSyncService → { SupervisorService, RegistryService, AuthService }`. Nothing in `SupervisorService` knows `CloudSyncService` exists — it is a pure `events$` subscriber, like `EventsGateway`. That is what makes the mirror removable and the supervisor testable without any cloud stubs.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kermanych/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify at runtime**

Run `pnpm dev:api`, sign in once via the UI, then:

```bash
TOKEN=$(sqlite3 ~/.kermanych/kermanych.sqlite 'select access_token from auth_session where id = 1')
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/api/cloud/outbox
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4317/api/cloud/outbox
sqlite3 ~/.kermanych/kermanych.sqlite '.schema status_outbox'
```

Expected: `{"pending":0}`; then `401` without the header; then the `CREATE TABLE status_outbox (...)` DDL, proving the table was created on this real database (not just `:memory:`). The API log shows no `[cloud-sync]` warnings.

- [ ] **Step 5: Run the full api suite**

Run: `pnpm --filter @kermanych/api exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cloud/cloud.controller.ts apps/api/src/app.module.ts
git commit -m "feat(api): register CloudSyncService and expose GET /cloud/outbox"
```

---

### Task 6: UI — launch a task from the board (with the unbound-project detour)

**Files:**
- Modify (coordinated edit to a Plan A file): `apps/ui/src/lib/api.ts` (add one member; Plan A owns the `Authorization` work in this file)
- Modify (coordinated edit to a Plan C file): `apps/ui/src/pages/BoardPage.vue` (replace the placeholder `launch` body; add the binding modal)

**Interfaces:**
- Consumes:
  - `POST /api/sessions/from-task` (Task 3).
  - Plan C's `BoardPage.vue` ships `function launch(task: Task): void` whose entire body is `local.notify(...)` — Plan C states verbatim that Plan D replaces it — plus `function isBound(task: Task): boolean` and the button `<KBtn variant="primary" :disabled="!isBound(task)" :title="…" @click="launch(task)">Запустити</KBtn>`.
  - `const local = useOrchestrator()` and `local.projects` (Plan B's renamed LOCAL rows: `Project[]` with `localRepoPath`), `local.notify(message, kind)`.
  - `useProjects()` from `apps/ui/src/stores/projects.ts` with `projects: CloudProject[]` (Plan B).
  - `api.setProjectBinding(id: string, localRepoPath: string): Promise<Project>` (Plan B).
  - `KModal`, `KBtn` (already imported by Plan C's create/assign modals), `KField`, `KDirPicker` (kit components; `KDirPicker` emits `select` with an absolute path and keeps talking to the LOCAL API).
- Produces: `api.createSessionFromTask(taskId: string): Promise<Session>`; a working «Запустити» that either starts a local session or walks the user through binding first.

- [ ] **Step 1: Add the API client member**

In `apps/ui/src/lib/api.ts`, insert after `createChat` (line 97-98):

```ts
  createSessionFromTask: (taskId: string): Promise<Session> =>
    post<Session>('/sessions/from-task', { taskId }),
```

It goes through the shared `post` helper, so it inherits the `Authorization: Bearer` header and the 401 handling Plan A added there.

- [ ] **Step 2: Replace the placeholder launch handler**

In `apps/ui/src/pages/BoardPage.vue`, replace Plan C's one-line `launch` with the real flow. Add `import { api } from 'lib/api';`, `import { useProjects } from 'stores/projects';` and `import { useRouter } from 'vue-router';` to the script's import block if they are not already there, then:

```ts
const router = useRouter();
const cloudProjects = useProjects();

const launching = ref<string | null>(null);
const bindingOpen = ref(false);
const bindingProjectId = ref<string | null>(null);
const bindingPath = ref('');
const bindingError = ref<string | null>(null);
const pickerOpen = ref(false);
const pendingLaunch = ref<Task | null>(null);

// The board is a shared surface, so this is a pre-check for UX only: the API re-checks the
// binding and the RLS-backed assignee rule regardless of what the button allowed.
async function launch(task: Task): Promise<void> {
  if (launching.value) return;
  if (!isBound(task)) {
    openBinding(task);
    return;
  }
  await runLaunch(task);
}

async function runLaunch(task: Task): Promise<void> {
  launching.value = task.id;
  try {
    const session = await api.createSessionFromTask(task.id);
    local.notify(`Сесію «${session.name}» запущено на цій машині.`, 'info');
    // The local session lives on the workspace board, so go where the work is.
    await router.push('/');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'project not bound') {
      // Raced with someone unbinding, or the row vanished — offer the picker instead of a toast.
      openBinding(task);
      return;
    }
    local.notify(
      message === 'task assigned to someone else'
        ? 'Задача призначена іншому учаснику — запустити її може лише він.'
        : message === 'task already claimed'
          ? 'Задачу щойно забрав інший учасник — онови дошку.'
          : message === 'not signed in'
            ? 'Локальний Керманич не має токена — увійди ще раз.'
            : `Не вдалося запустити задачу: ${message}`,
      'error',
    );
  } finally {
    launching.value = null;
  }
}

function openBinding(task: Task): void {
  pendingLaunch.value = task;
  bindingProjectId.value = task.projectId;
  bindingPath.value = local.projects.find((p) => p.id === task.projectId)?.localRepoPath ?? '';
  bindingError.value = null;
  bindingOpen.value = true;
}

async function confirmBinding(): Promise<void> {
  const projectId = bindingProjectId.value;
  const task = pendingLaunch.value;
  if (!projectId || !task) return;
  bindingError.value = null;
  try {
    await api.setProjectBinding(projectId, bindingPath.value.trim());
    bindingOpen.value = false;
    await runLaunch(task);
  } catch (e) {
    bindingError.value = e instanceof Error ? e.message : String(e);
  }
}
```

Note on the `:disabled="!isBound(task)"` binding Plan C already wrote: change it to `:disabled="launching !== null"` so an unbound project routes into the picker instead of being a dead button, and keep Plan C's `:title` hint (it now reads as an invitation rather than a refusal). The exact replacement for that one attribute:

```html
          :disabled="launching !== null"
          :title="isBound(task) ? 'Запустити локальну сесію' : 'Проєкт не звʼязано з локальною текою — вкажи її'"
```

- [ ] **Step 3: Add the binding modal to the template**

At the end of `BoardPage.vue`'s template, next to Plan C's create/assign modals:

```html
    <!-- LOCAL BINDING: a cloud task only runs where its repo actually lives -->
    <KModal v-model="bindingOpen" title="Звʼязати проєкт з локальною текою">
      <div class="board__bind">
        <p class="board__bind-note">
          Задача «{{ pendingLaunch?.title ?? '' }}» виконується на цій машині. Вкажи локальний
          git-репозиторій проєкту «{{ cloudProjects.projects.find((p) => p.id === bindingProjectId)?.name ?? '' }}» —
          шлях лишається лише тут і в хмару не потрапляє.
        </p>
        <KField v-model="bindingPath" label="Локальна тека" placeholder="/Users/me/code/project" />
        <KBtn variant="secondary" @click="pickerOpen = true">Обрати теку…</KBtn>
        <p v-if="bindingError" class="board__bind-error" role="alert">{{ bindingError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="bindingOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!bindingPath.trim()" @click="confirmBinding">
          Звʼязати і запустити
        </KBtn>
      </template>
    </KModal>
    <KDirPicker v-model="pickerOpen" :start="bindingPath" @select="bindingPath = $event" />
```

Add to the script imports whichever of these the file lacks (Plan C already imports `KBtn` and `KModal`):

```ts
import KField from 'components/kit/KField.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
```

And to the `<style scoped lang="scss">` block:

```scss
.board__bind { display: flex; flex-direction: column; gap: 10px; }
.board__bind-note { font-size: 12px; color: var(--k-muted); margin: 0; }
.board__bind-error { font-size: 12px; color: var(--k-danger); margin: 0; }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Verify in the browser**

Run `pnpm dev:api` and `pnpm dev:ui`, sign in, open `/#/board`.

- On a task in a project with NO local binding, click «Запустити» → the binding modal opens naming the task and the project; «Обрати теку…» opens `KDirPicker`; picking a repo and pressing «Звʼязати і запустити» closes the modal and starts the session, and the app navigates to the workspace board where a new row appears with the task's title, status `queued` → `thinking`.
- Pointing the picker at a non-git directory → the modal stays open showing the API's message (`project dir is not a git repo`) and no session is created.
- On a task assigned to somebody else, click «Запустити» → an error toast «Задача призначена іншому учаснику — запустити її може лише він.» and no new row on the workspace board.
- On an unassigned task, click «Запустити» → the card's assignee avatar becomes you (Realtime), and the session starts.

Expected: all of the above; no console errors.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/api.ts apps/ui/src/pages/BoardPage.vue
git commit -m "feat(ui): launch a cloud task locally, with a binding detour for unbound projects"
```

---

### Task 7: UI — offline banner, pending-outbox indicator, stale cards

**Files:**
- Modify (coordinated edit to a Plan A file): `apps/ui/src/lib/api.ts` (one member)
- Modify (coordinated edit to a Plan C file): `apps/ui/src/pages/BoardPage.vue`

**Interfaces:**
- Consumes: `GET /api/cloud/outbox` (Task 5); Plan C's page holds `const board = useBoard()` and `const local = useOrchestrator()`, and its `board.offline: boolean` is set from the Realtime channel state (`true` unless `channelState === 'SUBSCRIBED'`) but rendered nowhere — this task renders it; the two PRE-EXISTING helpers `useNow(intervalMs = 15_000): Ref<number>` from `apps/ui/src/composables/useNow.ts` (called with no argument here, so it ticks every 15 s — enough for a minute-granularity hint) and `relativeTime(iso: string, now: number): string` from `apps/ui/src/lib/time.ts`; `Task.updatedAt` (camelCase, mapped inside `@kermanych/cloud`).
- Produces: `api.cloudOutbox(): Promise<{ pending: number }>`; the board's three status surfaces — cloud-channel banner, local-queue pill, per-card stale hint.

- [ ] **Step 1: Add the API client member**

In `apps/ui/src/lib/api.ts`, insert after `createSessionFromTask` (added in Task 6):

```ts
  cloudOutbox: (): Promise<{ pending: number }> =>
    get<{ pending: number }>('/cloud/outbox'),
```

- [ ] **Step 2: Poll the local outbox from the board**

In `BoardPage.vue`'s script, below Plan C's `onMounted`/`onUnmounted` subscribe lifecycle (Vue composes multiple hooks; keeping the two concerns in separate blocks keeps them reviewable):

```ts
// The local queue is invisible to Supabase: this browser can be perfectly online while THIS
// machine's pushes are stuck. Only the local API knows, and only by polling — there is no
// ServerEvent for it (see the API task's justification).
const outboxPending = ref(0);
let outboxTimer: ReturnType<typeof setInterval> | undefined;

async function refreshOutbox(): Promise<void> {
  try {
    outboxPending.value = (await api.cloudOutbox()).pending;
  } catch {
    // Local API unreachable (Electron still booting, dev server restarting): keep the last
    // known count rather than flashing a false "all clear".
  }
}

onMounted(() => {
  void refreshOutbox();
  outboxTimer = setInterval(() => void refreshOutbox(), 5000);
});
onUnmounted(() => {
  if (outboxTimer) clearInterval(outboxTimer);
});
```

- [ ] **Step 3: Add the stale rule**

Also in the script:

```ts
// Stale = the card claims to be working, but nothing has moved for a while. There is no
// heartbeat in v1 (spec Non-goals), so `updated_at` age is the only signal.
// `waiting_input` is excluded on purpose: a task blocked on its owner's answer is
// legitimately idle for hours — that is not staleness, that is the design (model B1).
const STALE_MS = 90_000;
const SELF_DRIVING: readonly TaskStatus[] = ['queued', 'thinking', 'tool'];

function isStale(task: Task): boolean {
  return SELF_DRIVING.includes(task.status) && now.value - new Date(task.updatedAt).getTime() > STALE_MS;
}
```

Add `TaskStatus` to the existing `import type { … } from '@kermanych/cloud';` line.

- [ ] **Step 4: Render the three surfaces**

At the top of the board template, above the columns:

```html
    <div v-if="board.offline || outboxPending > 0" class="board__alerts">
      <p v-if="board.offline" class="board__alert board__alert--offline" role="status">
        Немає звʼязку з хмарою — показано останній відомий стан дошки. Локальні сесії працюють як завжди.
      </p>
      <p v-if="outboxPending > 0" class="board__alert board__alert--outbox" role="status">
        Статуси цієї машини ще не відправлені: {{ outboxPending }}. Надішлемо автоматично, щойно зʼявиться звʼязок.
      </p>
    </div>
```

On the task card, right after Plan C's `relativeTime(task.updatedAt, now)` hint:

```html
        <span
          v-if="isStale(task)"
          class="board__stale"
          :title="`Останнє оновлення ${relativeTime(task.updatedAt, now)} — машина виконавця, схоже, офлайн`"
        >⚠ давно без змін</span>
```

And in the `<style scoped lang="scss">` block:

```scss
.board__alerts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.board__alert { margin: 0; font-size: 12px; padding: 6px 10px; border-radius: 6px; }
.board__alert--offline { color: var(--k-muted); background: var(--k-surface-2); }
.board__alert--outbox { color: var(--k-accent); background: var(--k-surface-2); }
.board__stale { font-size: 11px; color: var(--k-accent); white-space: nowrap; }
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Verify each surface in the browser**

Run `pnpm dev:api` + `pnpm dev:ui`, sign in, open `/#/board`.

1. **Cloud channel offline.** Open DevTools → Network → Offline (or block the Supabase host in `/etc/hosts`). Within a few seconds the grey banner «Немає звʼязку з хмарою…» appears; cards keep rendering their last known state. Re-enable the network → the banner disappears.
2. **Local queue pending.** With the browser ONLINE but the local API's cloud path blocked, launch a task and let it change status:
   ```bash
   sudo sh -c 'echo "127.0.0.1 <your-project-ref>.supabase.co" >> /etc/hosts'
   ```
   Restart `pnpm dev:api` so Node picks up the hosts entry. Start a task from the board; within 5 s the accent pill «Статуси цієї машини ще не відправлені: 1» appears while the grey cloud banner stays hidden (the browser's own channel is fine). `sqlite3 ~/.kermanych/kermanych.sqlite 'select * from status_outbox'` shows one row with a growing `attempts`. Remove the hosts line, wait up to 60 s (backoff cap) or restart the API to drain immediately → the pill disappears and the card's status jumps to the current one.
3. **Stale card.** With a task in `thinking`, `kill` the local API (`Ctrl-C` on `pnpm dev:api`) with SIGKILL so no shutdown hook runs:
   ```bash
   pkill -9 -f 'nest start'
   ```
   After 90 s the card shows «⚠ давно без змін» with a tooltip naming the age. A `waiting_input` card never shows it, however long it waits.

Expected: all three, and no console errors.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/lib/api.ts apps/ui/src/pages/BoardPage.vue
git commit -m "feat(ui): cloud-offline banner, pending-outbox indicator and stale task cards"
```

---

### Task 8: README — the task flow and what happens offline

**Files:**
- Modify: `README.md` (append a new section after the `## Design` section, which ends at line 90)

**Interfaces:**
- Consumes: nothing at runtime. Plan A already added a "cloud prerequisites" section (env vars, `supabase start`); this task appends a separate section and edits none of Plan A's lines.
- Produces: documentation of the task lifecycle and the offline guarantees.

- [ ] **Step 1: Append the section**

At the end of `README.md`:

```markdown
## Cloud tasks and local sessions

A **task** is a card in the shared cloud board; a **session** is its execution on one
developer's machine. The direction is always task → session.

1. **Create** — any member of a project creates a task on the board (`/#/board`) with a
   title, a description and optional launch params (model, branch prefix, platform, base
   branch). It starts in `backlog`, which exists only in the cloud.
2. **Assign** — the author assigns it to a member, or a member presses «Запустити» on an
   unassigned task, which self-assigns it atomically. Only the assignee can run it; an
   active task (`queued`, `thinking`, `tool`, `waiting_input`) can be neither reassigned
   nor deleted.
3. **Bind** — a cloud project has no idea where its repo lives on your disk. The first
   «Запустити» for an unbound project asks for the local git repository and stores that
   path locally (it never reaches the cloud).
4. **Run** — `POST /api/sessions/from-task` creates a git worktree under
   `~/.kermanych/worktrees/<sessionId>`, copies the project's `carryFiles` (`.env` by
   default) into it, and spawns one `omp --mode rpc` child. From here on the session is an
   ordinary local session: it appears on the workspace board and you drive it there.
5. **Status flows back** — the local API mirrors the session's coarse status
   (`queued → thinking → tool → waiting_input → done | error | stopped | merged |
   conflict`) to the task, and everyone's board updates live over Supabase Realtime.

Nothing else leaves your machine. Transcripts, the current tool, context usage, todo
phases and interactive prompts are local-only by design — the board shows THAT a task
waits for input, and only its owner can answer it, on their own machine.

### Offline behaviour

Local work never waits for the cloud:

- A session that already exists keeps running, answering, merging and finishing with no
  network at all — the local `projects` row caches the project config, so nothing on
  that path reads the cloud.
- STARTING a board task is the one step that needs the cloud: Kermanych has to read the
  task and claim it for you. Offline, «Запустити» fails with a clear error; the tasks you
  already started are unaffected.
- Every status change is written to a local `status_outbox` table (SQLite) before it is
  pushed. The pusher retries with exponential backoff (~2 s, doubling to a 60 s cap) and
  also retries immediately after a re-login, so a queue parked on an expired token
  resumes at sign-in.
- The outbox keeps ONE row per task: an offline burst of `thinking → tool → thinking`
  collapses into the newest status, because the board has no use for the ones in between.
- A clean shutdown enqueues `stopped` for every running task, so the board never hangs on
  `thinking` after you quit Kermanych.
- On the board, a grey banner means THIS BROWSER lost the cloud; an accent pill
  («Статуси цієї машини ще не відправлені: N») means this machine still owes the cloud
  pushes; «⚠ давно без змін» on a card means the assignee's machine has gone quiet
  (there is no heartbeat — it is the age of the task's `updated_at`).
```

- [ ] **Step 2: Verify it renders**

Run: `grep -n '^## ' README.md`
Expected: the new `## Cloud tasks and local sessions` heading is last, and Plan A's cloud-prerequisites heading is untouched.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the cloud task flow and offline status sync"
```

---

### Task 9: Cross-machine end-to-end smoke

**Files:** none (manual verification). This is the spec's required pre-merge smoke for the whole four-plan feature.

Two participants are needed: **A** and **B**. Use two machines, or two OS accounts on one machine (two separate `$HOME`s, hence two separate `~/.kermanych/kermanych.sqlite` files and two separate Electron/browser profiles — one shared SQLite file would invalidate the whole test). Two GitHub accounts, one shared Supabase project, one shared cloud project with both users as members.

- [ ] **Step 1: Bring both sides up**

On each machine:

```bash
cd kermanych
pnpm install
pnpm --filter @kermanych/core build && pnpm --filter @kermanych/cloud build
pnpm dev:api   # terminal 1
pnpm dev:ui    # terminal 2
```

Sign in with GitHub in each browser and confirm the token reached the local API on both:

```bash
sqlite3 ~/.kermanych/kermanych.sqlite 'select user_id, github_username, expires_at from auth_session'
```

Expected: one row per machine, with the right GitHub username.

- [ ] **Step 2: A creates a project and adds B; B binds it**

A: `/#/board` → create the project, add B by GitHub username in the members panel.
B: reload `/#/board` → the project appears. B does NOT bind yet.

Expected: both see the project; B's board is empty of tasks.

- [ ] **Step 3: A creates and assigns a task; B sees it live**

A creates a task titled `Smoke: cross-machine status` with the description `echo hello and stop`, launch params model default and prefix `chore`, and assigns it to B.

Expected: B's board shows the card WITHOUT a reload (Realtime), with B's avatar and status `backlog`.

- [ ] **Step 4: B launches; A watches the status walk**

B presses «Запустити» → the binding modal opens → B picks a real local git repo → «Звʼязати і запустити».

Expected on B: navigation to the workspace board, a new row named `Smoke: cross-machine status`, a worktree on disk (`ls ~/.kermanych/worktrees/`), and one `omp` child (`pgrep -fl 'omp --mode rpc'`).
Expected on A, without reloading: the card moves `backlog → queued → thinking` and ends on `done`.

- [ ] **Step 5: Kill B's API mid-run; A sees the stale hint**

B starts a second task (assign it to B from A's side first), waits for `thinking`, then hard-kills the API so no shutdown hook can run:

```bash
pkill -9 -f 'nest start'
```

Expected on A: the card stays on `thinking` and after 90 s shows «⚠ давно без змін». (A SIGKILL is the point of this step: a `Ctrl-C` would run `onModuleDestroy` and push `stopped` immediately — verify that too, on a third task, and confirm A's card flips to `stopped` within seconds.)

- [ ] **Step 6: Restart B; the terminal status arrives**

B: `pnpm dev:api` again.

Expected: `sqlite3 ~/.kermanych/kermanych.sqlite 'select * from status_outbox'` is empty within a second or two (the boot drain ran), and A's card leaves the stale state with the real terminal status. B's session row can be resumed from the workspace board as usual.

- [ ] **Step 7: Block Supabase on B; the session keeps running and the queue grows**

```bash
sudo sh -c 'echo "127.0.0.1 <your-project-ref>.supabase.co" >> /etc/hosts'
```

Restart B's API so Node resolves the new entry, then B starts another assigned task and sends it a message.

Expected on B: the session launches, prompts and answers normally — the block changes nothing locally. The board shows the accent pill with a non-zero count, and:

```bash
watch -n2 "sqlite3 ~/.kermanych/kermanych.sqlite 'select task_id, status, attempts, last_error from status_outbox'"
```

shows exactly ONE row for that task whose `status` tracks the newest state and whose `attempts` climbs. Expected on A: the card is frozen at its last delivered status.

- [ ] **Step 8: Unblock; the status lands**

```bash
sudo sed -i '' '/supabase.co/d' /etc/hosts   # macOS sed
```

Wait for the backoff (≤ 60 s) or restart B's API to drain at once.

Expected: `status_outbox` empties, the pill disappears, and A's card jumps straight to the current status — no intermediate statuses replayed (latest-wins).

- [ ] **Step 9: Assignee enforcement, from the other side**

A presses «Запустити» on the task assigned to B.

Expected: an error toast «Задача призначена іншому учаснику — запустити її може лише він.», and no session on A (`curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/api/sessions | jq length` unchanged).

- [ ] **Step 10: Full suites as the final gate**

From the repo root:

```bash
pnpm -r test
```

Expected: PASS for `@kermanych/core`, `@kermanych/cloud`, `@kermanych/api` and `@kermanych/ui` (the ui package runs only `test/socket.spec.ts`).

Then the typechecks the suites do not cover:

```bash
pnpm --filter @kermanych/api exec tsc --noEmit
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```

Expected: no errors.

- [ ] **Step 11: Clean up**

Delete the smoke sessions on B (worktrees and branches go with them), delete the smoke tasks on A, and remove any leftover `/etc/hosts` line:

```bash
grep supabase.co /etc/hosts || echo "clean"
ls ~/.kermanych/worktrees/
```

Expected: `clean`, and no smoke worktrees left behind.

---

## Self-Review

**Spec coverage (this plan's slice):**
- **Requirement 5** — "Only the assignee launches a task's local session; launching an unassigned task atomically self-assigns" → Task 2 (`createSessionFromTask` steps 2-3, error strings `task assigned to someone else` / `task already claimed`, tested in `sessions.from-task.spec.ts`), Task 3 (the route takes the user from the guard, never from the body), Task 6 (the UI's pre-check + the toast for each refusal), Task 9 Step 9 (cross-machine proof).
- **Requirement 6** — "Status flows local → cloud: only `status` (+ `updated_at`), only on coarse changes. Transcripts, `currentTool`, `contextPercent`, `todoPhases` and interactive prompts never leave the machine" → Task 4: `pushTaskStatus` is the only outbound call, the `lastPushed` edge filter drops non-status `pushUpdate`s, and the spec's `contextPercent` case is an explicit test.
- **Requirement 7** — "Local work never blocks on cloud availability … status pushes queue in a local outbox and retry" → Task 1 (durable table), Task 4 (`drain()` + backoff + token-handoff retry, offline/reconnect tests), Task 2 step 5 (the local row is refreshed while online so every later local action needs no network), Task 9 Steps 7-8. The spec's own carve-out — starting a board task needs the cloud (read + claim) — is honoured by Task 2's error paths and stated in the README text of Task 8.
- **Deviation D3** — "the status push hooks into `events$`, not into the 18 `updateSession({status})` call sites … A new `CloudSyncService` subscribes to `supervisor.events$` exactly like `EventsGateway` does, keeps the last pushed status per task, and enqueues only on an edge change. Zero edits inside the supervisor's status paths" → Task 4. The only edits this plan makes to `supervisor.service.ts` are the import block, the constructor, and one new method; no line inside any status path is touched.
- **Deviation D5** — "local session deletion pushes a terminal status … if the removed session's task was active, `CloudSyncService` enqueues `stopped`" → Task 4 `onRemoved`, plus the negative case (a `done` session deleted must NOT be overwritten with `stopped`) and the `onModuleDestroy` variant, all tested.
- **Spec's `cloud-sync.spec.ts` verification list** — every bullet has a test in Task 4: edge dedupe (`pushes a status change once and dedupes repeats`), non-status updates (`ignores updates that do not change the status`), offline push with `attempts = 1`, reconnect drain, `session_removed` on an active task, `onModuleDestroy` → `stopped`.
- **Spec's `sessions.from-task.spec.ts` verification list** — assignee check, atomic claim on unassigned, `project not bound` refusal, happy path with `taskId`/`projectId` and one spawned child: all in Task 2, plus the claim-race and launch-rollback cases.
- **Launch flow steps 1-6 (spec lines 306-320)** → Task 2 in order: guard-resolved `userId` (Task 3), task read under the user's client, assignee refusal, `claimTask`, local row + `local_repo_path` precondition, cloud→local config refresh, `registry.createSession({ projectId, taskId, … })`, then the untouched `launch()`.
- **Local API changes: `src/cloud/cloud-sync.service.ts` (subscriber + outbox drain)** → Tasks 4, 5. **`http/sessions.controller.ts`: new literal route `POST /sessions/from-task` declared ABOVE the `:id` block; `GET /sessions?projectId=`** → Task 3 (the `GET` handler is Plan B's rename; Task 3 verifies it rather than editing it). **`registry.service.ts`: `enqueueTaskStatus`, `listOutbox`, `dropOutbox`, `bumpOutboxAttempt`** → Task 1.
- **UI changes: `lib/api.ts` `createSessionFromTask(taskId)`** → Task 6. **`BoardPage.vue` "Запустити" (disabled without a binding)** → Task 6, which upgrades "disabled" into "opens the binding flow" — a strict superset of the spec's behaviour and the only way Requirement 3's "launching is refused until it exists" becomes actionable rather than a dead end. **Offline banner driven by the Realtime channel state** → Task 7 (Plan C owns the flag, this plan renders it). **Stale hint from `updated_at`** → Task 7's `isStale`. **Manual smoke: two machines/two accounts, kill B mid-run, block Supabase** → Task 9.
- **Non-goal honoured:** "No heartbeat in v1 — stale detection is `updated_at` age in the UI only" — Task 7 adds no heartbeat, only an age threshold, and deliberately exempts `waiting_input` (documented in the code comment).

**Left to sibling plans (intentionally not covered here):**
- The `supabase/**` schema, RLS, `tasks_guard()`, `@kermanych/cloud`'s `client.ts` / `types.ts` / `status.ts`, `apps/api/src/auth/**` (incl. `AuthService.onToken`, whose contract Plan A confirmed), `stores/auth.ts`, `LoginPage`, the router guard, Electron OAuth, and the `Authorization` header work in `lib/api.ts` — **Plan A**.
- `Group` → `Project` rename, `Session.projectId`/`Session.taskId?` in `packages/core/src/types.ts`, the `user_version` 0 → 1 migration, `registry.listProjects/upsertProject/patchProject/removeProject/listSessions(projectId?)`, `projects.controller.ts` incl. `PUT /api/projects/:id/binding` and `POST /api/projects/sync` (with the "prune never deletes a row that still has sessions" rule), `packages/cloud/src/projects.ts`, `stores/projects.ts`, `api.setProjectBinding`, the members panel and the env-keys checklist — **Plan B**.
- `packages/cloud/src/tasks.ts` (`getTask`, `claimTask`, `pushTaskStatus`, `listTasks`, `createTask`, `patchTask`, `assignTask`, `subscribeTasks`), `stores/board.ts` (incl. the `offline` flag this plan renders), `BoardPage.vue`'s columns/cards/modals, the `/board` route, and the WorkspacePage task-title surfacing — **Plan C**. (`lib/time.ts` and `composables/useNow.ts` are pre-existing repo files, owned by neither plan.)
- `packages/cloud/src/index.ts` is not touched by this plan: it adds no cloud module, so it appends no barrel line (Plan A ships `types`/`client`/`status`, Plan B appends `projects`, Plan C appends `tasks`).
- Orphaned local project rows (a bound row whose cloud project is gone) need no guard here: the board lists tasks per CLOUD project, so an orphaned row can never present a launchable card. Plan B owns marking those rows «поза хмарою» on the workspace side.

**Ownership check:** no task in this plan edits `supabase/**`, `apps/api/src/auth/**`, `packages/cloud/src/{index,client,types,status,projects,tasks}.ts`, `apps/ui/src/stores/board.ts`, `apps/ui/src/stores/projects.ts`, `apps/ui/src/stores/auth.ts`, `apps/ui/src/router/*`, `apps/ui/src-electron/**`, or `packages/core/src/types.ts`. Three files are shared and edited as declared coordinated appends: `apps/api/src/app.module.ts` (Task 5 — two array entries, confirmed with Plan A), `apps/ui/src/lib/api.ts` (Tasks 6-7 — two members), `apps/ui/src/pages/BoardPage.vue` (Tasks 6-7 — the `launch` body Plan C reserved for this plan, plus the binding modal, banners and stale rule Plan C confirmed it will not add).

**Placeholder scan:** none. Every code step carries the actual code. Runtime values the operator substitutes are marked as such: `<your-project-ref>` (the Supabase project ref in `/etc/hosts`) and `$TOKEN` (read out of `auth_session` by the command shown). The only conditional instructions are "add this import if the file does not already have it" for `KBtn`/`KModal`/`api`/`useProjects`/`useRouter`, which exist because Plan C owns that file's import block — each names the exact import line.

**Type consistency:** `OutboxRow` (Task 1) is the same shape everywhere it appears — `listOutbox()` in the registry, `rearm(rows: OutboxRow[])` in `CloudSyncService`, and `{ pending: number }` in the controller, which only counts it. `enqueueTaskStatus(taskId, status, updatedAt)` is called with exactly three arguments at all four call sites (`onSession`, `onRemoved`, `onModuleDestroy`, tests). `TaskStatus` = `SessionStatus`, so `taskStatusFromSession(session)` feeds `enqueueTaskStatus`'s `SessionStatus` parameter and `ACTIVE_STATUSES.includes(...)` without a cast. `createSessionFromTask(taskId, userId)` has the same two-parameter signature in the supervisor, the controller and every test. `api.createSessionFromTask(taskId): Promise<Session>` matches the route's return, and `api.cloudOutbox(): Promise<{ pending: number }>` matches `CloudController.outbox`. `isBound`/`isStale`/`launch`/`runLaunch`/`openBinding`/`confirmBinding` are each defined once and referenced under the same name in the template.

**Open follow-ups (non-blocking, out of scope per spec):** a heartbeat/lease so staleness is authoritative rather than heuristic; pushing `waiting_input`'s prompt title (deliberately excluded by Requirement 6); a WS event for the outbox count if the 5 s board poll ever shows up in a profile.
