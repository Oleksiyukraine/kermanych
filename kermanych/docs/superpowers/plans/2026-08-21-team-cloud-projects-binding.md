# Team cloud — cloud projects, membership and local binding (Plan B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the machine-local `Group` (a name + an absolute directory) into a cloud `Project` with owner/member roles, whose local SQLite row is both an offline config cache and this machine's manual binding to a local repo path.

**Architecture:** Deviation **D1** of the spec: the local `groups` table is RENAMED to `projects`, its `id` becomes the CLOUD project UUID and `project_dir` becomes `local_repo_path`. Cloud (Supabase, via the new `@kermanych/cloud` package) is the source of truth for project *config* and *membership*; the local row is refreshed from every successful cloud read and is what the launch path reads, so launching never needs the network. Binding is manual, per machine, through the existing `KDirPicker`. Env secret VALUES stay in the bound repo's `.env`; the cloud stores key NAMES only (`projects.env_keys`) as a checklist.

**Tech Stack:** `@kermanych/core` (shared types), `@kermanych/cloud` (new; `@supabase/supabase-js` ^2), NestJS 10 + `better-sqlite3` v13 (api), Quasar 2 / Vue 3 / Pinia 2 (ui), vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-team-cloud-design.md` — Requirements 2, 3, 9 and Deviation D1. Read it before Task 1.

**Prerequisite plan:** `docs/superpowers/plans/2026-08-21-team-cloud-foundation-auth.md` (Plan A) MUST be merged first. This plan assumes Plan A produced:
- `packages/cloud` as a working workspace package (`package.json`, `tsconfig.json`, `vitest.config.ts` with `include: ["test/**/*.spec.ts"]`, deps `@supabase/supabase-js` ^2 + `@kermanych/core` workspace:*), with `src/index.ts` containing exactly `export * from "./types"; export * from "./client"; export * from "./status";`, and `src/types.ts` exporting `CloudProject`, `ProjectMember`, `Profile`, `Task`, `TaskStatus`.
- `@kermanych/cloud` listed as a dependency of both `apps/api` and `apps/ui`, with the `quasar.config.ts` vite CJS-interop entries already extended for it.
- `apps/api/src/auth/**` with `SupabaseAuthGuard` registered as `APP_GUARD` in `app.module.ts`, `@Public()`, and `req.user = { id }`.
- `apps/ui/src/stores/auth.ts` (`useAuth`) exposing `client: SupabaseClient`, `user: { id: string } | null`, `profile: Profile | null`, `accessToken: string | null`, `ready: Promise<void>`, `signInWithGithub()`, `signOut()`.
- `apps/ui/src/lib/api.ts` sending `Authorization: Bearer <token>` from the `post`/`get`/`put` helpers and from the remaining inline `fetch` calls, plus a router guard that means every route under `MainLayout` is reached only when signed in.
- `supabase/migrations/*.sql` with the `projects`, `project_members`, `profiles` tables, the `handle_new_project()` trigger and the RLS policies from the spec.

Sibling plans: Plan C (`tasks`/board) and Plan D (launch-from-task + status sync) run AFTER this one.

## Global Constraints

- Node ≥22.12 required (`better-sqlite3` v13 N-API prebuilt); pnpm workspace, `packageManager` pinned in `package.json`.
- Code, identifiers, comments, commit messages and thrown error messages in **English**; UI-visible copy in `.vue` templates in **Ukrainian**. (Existing behaviour: the UI shows raw API error text in toasts, e.g. `MainLayout.vue` `e.message` — that stays English, as today.)
- **This is a clean cutover.** No `Group` alias, no `projectDir` alias, no `groups` REST route, no deprecated re-export survives. `packages/core`, `apps/api/src` and `apps/ui/src` MUST end with zero `Group` / `groupId` / `projectDir` / `group_id` / `project_dir` identifiers (Task 14 verifies).
- **`projects.id` is the cloud UUID.** The local registry NEVER generates a project id — `randomUUID()` is used for sessions only, and for the offline preview seed.
- **Env secret VALUES never reach the cloud.** `projects.env_keys` holds NAMES only. `.env` reads/writes stay local, path-confined to the bound `localRepoPath`, atomic (`EnvFileService`, unchanged from the 2026-08-11 design).
- **Requirement 7 (offline).** Nothing on the local launch path may call Supabase. The local `projects` row must be sufficient to launch.
- **No cascade data loss.** `POST /api/projects/sync` prune deletes only local project rows with **zero** sessions. A project that vanished from the cloud view (RLS change, membership removal, transient empty read) but still has local sessions survives as an orphan row; its sessions stay usable.
- Additive schema changes keep the existing `try { ALTER TABLE … ADD COLUMN } catch {}` idiom (`registry.service.ts:27-102`); the rename is the repo's FIRST versioned migration, guarded by `pragma user_version`.
- vitest exists for `apps/api`, `packages/core` and `packages/cloud` only. `apps/ui` has NO component-test harness (its only spec is `test/socket.spec.ts`, no vitest config) — every UI task is verified by running `pnpm dev:api` + `pnpm dev:ui` against stated observable expectations.
- No new dependency is introduced by this plan. `@supabase/supabase-js` is imported by `packages/cloud` only.
- There is no CHANGELOG in this repo. Do not create one.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` | `Project`, `Session.projectId`/`taskId`, `ServerEvent` renames. Modify. |
| `apps/api/src/registry/registry.service.ts` | v1 versioned migration + the `projects` CRUD surface. Modify. |
| `apps/api/test/registry.migration.spec.ts` | Legacy-DB migration + idempotency. **Create.** |
| `apps/api/src/supervisor/supervisor.service.ts` | `project`/`boundProject` lookups, `updateProject`/`bindProject`/`syncProjects`/`removeProject`/`projectBranches`, launch path on `localRepoPath`. Modify. |
| `apps/api/test/supervisor.project.spec.ts` | Renamed from `supervisor.group.spec.ts`; adds bind/sync/prune tests. Modify (git mv). |
| `apps/api/src/http/projects.controller.ts` | Renamed from `groups.controller.ts`; list/patch/binding/sync/env/branches. Modify (git mv). |
| `apps/api/src/http/sessions.controller.ts` | `groupId` → `projectId` in 4 DTOs. Modify. |
| `apps/api/src/preview/{seed.ts,preview.service.ts}` | Follow the rename; seed keeps working offline. Modify. |
| `apps/api/src/env/{env-file.service.ts,carry-files.ts}` | `projectDir` parameter → `repoPath`. Modify. |
| `packages/cloud/src/projects.ts` | Cloud project + membership queries, snake↔camel mapping. **Create.** |
| `packages/cloud/test/projects.spec.ts` | Mapping + query-builder units against a fake client. **Create.** |
| `apps/ui/src/lib/api.ts` | Local project wrappers, `setProjectBinding`, `syncProjects`. Modify. |
| `apps/ui/src/stores/orchestrator.ts` | Local project state/actions (rename). Modify. |
| `apps/ui/src/stores/projects.ts` | Cloud projects + members store (`useProjects`). **Create.** |
| `apps/ui/src/layouts/MainLayout.vue` | Rail, create-in-cloud, binding, settings + members, env panel. Modify. |
| `apps/ui/src/components/kit/KRailItem.vue` | `project` prop + unbound/orphan affordance. Modify. |
| `apps/ui/src/pages/{WorkspacePage.vue,KitGalleryPage.vue}` | Identifier rename; preview config writes to the cloud. Modify. |

Decomposition note: cloud PROJECTS and MEMBERS live in their own store (`stores/projects.ts`), not in `stores/board.ts` — the board (Plan C) owns tasks + Realtime and reads the project list from `useProjects()`. That keeps a 300-line store out of the board and lets this plan ship without Plan C.

---

### Task 1: Shared types — `Group` → `Project`, `Session.projectId`/`taskId`, `ServerEvent`

**Files:**
- Modify: `packages/core/src/types.ts:10` (`Group`), `:18-30` (`Session`), `:76-84` (`ServerEvent`)

**Interfaces:**
- Produces: `Project = { id: string; name: string; localRepoPath: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string; createdAt: string }`; `Session.projectId: string`; `Session.taskId?: string`; `ServerEvent` variants `{ type: "snapshot"; projects: Project[]; sessions: Session[] }`, `{ type: "project_update"; project: Project }`, `{ type: "project_removed"; projectId: string }`. `SessionStatus` is UNCHANGED (10 values).
- Consumes: nothing.

This task deliberately breaks `apps/api` and `apps/ui` typechecking. They are repaired by Tasks 2-6 (api) and 8-14 (ui); Task 14 is the gate that proves the whole cutover compiles. Do not add a `Group` alias to "keep things building" — that defeats the cutover.

- [ ] **Step 1: Replace the `Group` type**

Replace line 10 of `packages/core/src/types.ts`:

```ts
// A project is a CLOUD entity (Supabase `projects`); this shape is the LOCAL row:
// `id` is the cloud project UUID, `localRepoPath` is THIS machine's binding ("" when
// unbound), and the rest is an offline cache of the cloud config so launching never
// needs the network (design D1 / Requirement 7).
export type Project = { id: string; name: string; localRepoPath: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string; createdAt: string };
```

- [ ] **Step 2: Replace the `Session` type**

Replace lines 18-30:

```ts
export type Session = {
  id: string; projectId: string; name: string; task: string;
  // The cloud task this session executes, when it was launched from the board.
  taskId?: string;
  worktreePath: string; branch: string;
  worktree: boolean; baseBranch?: string;
  model?: string; prefix?: BranchPrefix; platform?: Platform;
  kind: "agent" | "discussion" | "task" | "review" | "chat";
  parentSessionId?: string;
  ompSessionId?: string; ompSessionFile?: string;
  status: SessionStatus; currentTool?: string; error?: string;
  todoPhases?: TodoPhase[]; contextPercent?: number; lastEventAt?: number;
  pendingUiRequest?: RpcExtensionUIRequest; archived?: boolean; createdAt: string;
  lastActivityAt: string;
};
```

- [ ] **Step 3: Replace the `ServerEvent` union**

Replace lines 76-84:

```ts
// Server -> client WebSocket messages
export type ServerEvent =
  | { type: "snapshot"; projects: Project[]; sessions: Session[] }
  | { type: "session_update"; session: Session }
  | { type: "transcript_append"; sessionId: string; entry: TranscriptEntry }
  | { type: "transcript_reset"; sessionId: string; entries: TranscriptEntry[] }
  | { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error" }
  | { type: "project_update"; project: Project }
  | { type: "session_removed"; sessionId: string }
  | { type: "project_removed"; projectId: string };
```

- [ ] **Step 4: Build core and confirm it is self-consistent**

Run: `pnpm --filter @kermanych/core exec tsc -p tsconfig.json --noEmit && pnpm --filter @kermanych/core build`
Expected: no type errors. `Project` is re-exported through `packages/core/src/index.ts` (`export * from "./types"`, line 1) with no edit needed. `packages/core/src/status.ts` and `worktree-names.ts` never mention groups, so nothing else in core changes.

The build is REQUIRED, not optional: `apps/api` and `apps/ui` resolve `@kermanych/core` through its built `dist`, so a stale dist makes every later task's typecheck lie.

- [ ] **Step 5: Take the callsite census**

Run:

```bash
grep -rInE '\b(Group|groupId|projectDir|group_id|project_dir|listGroups|createGroup|updateGroup|removeGroup|addGroup|selectedGroupId|groupSessions)\b' \
  packages/core/src apps/api/src apps/ui/src --include='*.ts' --include='*.vue' -c | sort -t: -k2 -rn
```

Expected, exactly (measured 2026-08-21 on `main`, before Steps 1-3; after them `packages/core/src/types.ts` drops off the list):

```
apps/api/src/supervisor/supervisor.service.ts:88
apps/api/src/registry/registry.service.ts:29
apps/ui/src/stores/orchestrator.ts:22
apps/ui/src/pages/WorkspacePage.vue:19
apps/ui/src/lib/api.ts:17
apps/ui/src/layouts/MainLayout.vue:14
apps/api/src/http/groups.controller.ts:11
apps/api/src/env/env-file.service.ts:10
apps/api/src/http/sessions.controller.ts:8
apps/ui/src/pages/KitGalleryPage.vue:6
apps/api/src/preview/seed.ts:6
packages/core/src/types.ts:5
apps/api/src/env/carry-files.ts:3
apps/ui/src/components/kit/KRailItem.vue:2
apps/api/src/preview/preview.service.ts:2
apps/api/src/app.module.ts:1
```

Save this list — it is the checklist the sweep tasks work through: 40+ of the supervisor's 88 hits are `group.projectDir` reads, 13 are `listGroups().find(...)` lookups, `groups.controller.ts` holds 5 group routes plus 2 env routes, and `MainLayout.vue` holds the rail plus three modals. Re-run the same command at the end of Task 14; the expected output there is empty.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): rename Group to Project with localRepoPath, add Session.taskId"
```

---

### Task 2: Registry — versioned v1 migration + the `projects` surface

**Files:**
- Modify: `apps/api/src/registry/registry.service.ts` (type import 8; constructor 14-103; `listGroups` 105-112; `createGroup` 114-121; `updateGroup` 123-131; `removeGroup` 133-136; `listSessions` 138-147; `createSession` 149-192; `updateSession` 194-221)
- Create: `apps/api/test/registry.migration.spec.ts`
- Modify: `apps/api/test/registry.spec.ts`, `apps/api/test/registry.branch.spec.ts`

**Interfaces:**
- Consumes: `Project`, `Session.projectId`, `Session.taskId` (Task 1).
- Produces: `listProjects(): Project[]`; `upsertProject(p: Omit<Project, "createdAt" | "localRepoPath"> & { localRepoPath?: string; createdAt?: string }): Project` (caller supplies the CLOUD id; a refresh that omits `localRepoPath` never clears an existing binding); `patchProject(id: string, patch: { name?: string; localRepoPath?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string }): Project` (throws `project not found`); `removeProject(id: string): void` (deletes the project's session rows first, as `removeGroup` did); `listSessions(projectId?: string): Session[]`; `createSession({ projectId, taskId?, … })`; `updateSession(id, patch)` persists `project_id` and `task_id`. SQLite `user_version` becomes `1`; `sessions.task_id` column and `sessions_project_idx` index exist.

**Migration design (decided here, do not re-litigate):** the baseline `CREATE TABLE IF NOT EXISTS` statements ARE rewritten to the new names (`projects`, `sessions.project_id`). That forces the v1 migration to run **before** them: on a legacy DB, `CREATE TABLE IF NOT EXISTS projects` would create an empty table and make `ALTER TABLE groups RENAME TO projects` fail forever. Legacy detection is explicit, not exception-swallowing — `SELECT name FROM sqlite_master WHERE type = 'table'` for the table rename and `pragma table_info(<table>)` for the two column renames (the first `table_info` use in this repo; justified because a failed `RENAME COLUMN` and a missing table are indistinguishable through a bare `try/catch`). A fresh DB and a legacy DB therefore converge: fresh → the migration is a no-op that only stamps `user_version = 1`, then the baseline `CREATE TABLE`s build the v1 shape; legacy → the three renames run, then the baseline `CREATE TABLE`s are no-ops.

- [ ] **Step 1: Write the failing migration test**

Create `apps/api/test/registry.migration.spec.ts`. It uses a real file in a temp dir (`mkdtempSync`, precedent: `create-guards.spec.ts:20`) — `:memory:` cannot be reopened, and reopening is the whole point of an idempotency test. It asserts through raw SQL as well as through the service so a broken mapping cannot hide a broken schema:

```ts
// apps/api/test/registry.migration.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-migrate-"));
  file = join(dir, "kermanych.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Build the pre-cloud (v0) schema by hand: the two baseline tables plus every additive
// column the old constructor added, i.e. exactly what a real user's DB looks like today.
function seedLegacyDb(path: string): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, project_dir TEXT, created_at TEXT,
    preview_command TEXT, api_command TEXT, carry_files TEXT NOT NULL DEFAULT '[".env"]',
    color TEXT, default_branch TEXT, conventions TEXT)`);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, group_id TEXT, name TEXT, task TEXT,
    worktree_path TEXT, branch TEXT, omp_session_id TEXT, omp_session_file TEXT, status TEXT,
    created_at TEXT, archived INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT,
    worktree INTEGER NOT NULL DEFAULT 1, base_branch TEXT, parent_session_id TEXT,
    kind TEXT NOT NULL DEFAULT 'agent', model TEXT, prefix TEXT, platform TEXT)`);
  db.prepare(
    `INSERT INTO groups (id, name, project_dir, carry_files, color, default_branch, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run("g-legacy", "Acme", "/tmp/acme", '[".env",".env.local"]', "#ff563c", "main", "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, status, created_at, last_activity_at, kind, worktree) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("s-legacy", "g-legacy", "old task", "do it", "/wt/old", "feature/old", "done", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "agent", 1);
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  db.close();
}

test("v0 -> v1 renames groups/project_dir/group_id and preserves every row", () => {
  seedLegacyDb(file);

  const r = new RegistryService(file);

  const projects = r.listProjects();
  expect(projects).toHaveLength(1);
  expect(projects[0]!.id).toBe("g-legacy");
  expect(projects[0]!.name).toBe("Acme");
  expect(projects[0]!.localRepoPath).toBe("/tmp/acme");
  expect(projects[0]!.carryFiles).toEqual([".env", ".env.local"]);
  expect(projects[0]!.color).toBe("#ff563c");
  expect(projects[0]!.defaultBranch).toBe("main");
  expect(projects[0]!.createdAt).toBe("2026-01-01T00:00:00.000Z");

  const sessions = r.listSessions("g-legacy");
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.id).toBe("s-legacy");
  expect(sessions[0]!.projectId).toBe("g-legacy");
  expect(sessions[0]!.branch).toBe("feature/old");
  expect(sessions[0]!.status).toBe("done");
  expect(sessions[0]!.taskId).toBeUndefined();

  const db = new Database(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  expect(tables).toContain("projects");
  expect(tables).not.toContain("groups");
  db.close();
});

test("reopening a migrated DB is a no-op and keeps the data", () => {
  seedLegacyDb(file);
  new RegistryService(file);

  const again = new RegistryService(file);
  expect(again.listProjects().map((p) => p.id)).toEqual(["g-legacy"]);
  expect(again.listProjects()[0]!.localRepoPath).toBe("/tmp/acme");
  expect(again.listSessions().map((s) => s.projectId)).toEqual(["g-legacy"]);

  const db = new Database(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  db.close();
});

test("a fresh DB gets the v1 shape, task_id and the project index without any rename", () => {
  const r = new RegistryService(file);
  const p = r.upsertProject({ id: "cloud-1", name: "Fresh", localRepoPath: "/tmp/fresh" });
  const s = r.createSession({
    projectId: p.id, taskId: "task-1", name: "t", task: "do", worktreePath: "", branch: "b",
  });
  expect(s.taskId).toBe("task-1");
  expect(r.listSessions("cloud-1")[0]!.taskId).toBe("task-1");

  const db = new Database(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((i) => i.name);
  expect(indexes).toContain("sessions_project_idx");
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.migration.spec.ts`
Expected: FAIL — `r.listProjects is not a function` (and the raw `sqlite_master` assertion still sees `groups`).

- [ ] **Step 3: Add the migration and rewrite the baseline schema**

In `apps/api/src/registry/registry.service.ts`, change the type import on line 8:

```ts
import type { Project, Session, SessionStatus } from "@kermanych/core";
```

Then replace lines 21-26 (the two baseline `CREATE TABLE`s) with the migration call followed by the v1-shaped baseline. Replace ONLY those two statements: Plan A added a third `CREATE TABLE IF NOT EXISTS auth_session (…)` immediately after them, and Plan D will append `status_outbox` at the end of the constructor. Both must survive this edit untouched — after the edit the constructor creates three tables, not two.

```ts
    // Versioned migration FIRST: on a legacy DB, `CREATE TABLE IF NOT EXISTS projects`
    // below would create an empty table and make the RENAME impossible forever.
    this.migrateToV1();
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, local_repo_path TEXT, created_at TEXT)`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, task TEXT, worktree_path TEXT, branch TEXT, omp_session_id TEXT, omp_session_file TEXT, status TEXT, created_at TEXT)`,
    );
```

- [ ] **Step 4: Rename `groups` in the existing additive blocks and append the new ones**

Five existing `ALTER TABLE groups` statements target the renamed table. Replace `ALTER TABLE groups` with `ALTER TABLE projects` at line 30 (the `["preview_command", "api_command"]` loop), line 72 (`carry_files`), line 78 (`color`), line 84 (`default_branch`) and line 90 (`conventions`). Leave every `ALTER TABLE sessions` block untouched.

Then, immediately after the `["model", "prefix", "platform"]` loop that ends at line 102 (i.e. as the last statements of the constructor), append:

```ts
    // Additive migration: a session launched from a cloud task remembers which task it is.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN task_id TEXT`);
    } catch {
      /* column already exists */
    }
    // The first index in this schema: listSessions(projectId) filters on project_id on
    // every board render and every supervisor lookup.
    this.db.exec(`CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id)`);
```

- [ ] **Step 5: Add the migration methods**

Insert these two private methods immediately after the constructor's closing `}`, before `listProjects`:

```ts
  // v1 (2026-08-21, team cloud): `groups` becomes `projects`, its id becomes the CLOUD
  // project UUID, `project_dir` becomes `local_repo_path` (this machine's binding) and
  // `sessions.group_id` becomes `sessions.project_id`. Guarded by pragma user_version so
  // it runs exactly once; the shape checks make a second run on a half-migrated DB safe.
  private migrateToV1(): void {
    if (Number(this.db.pragma("user_version", { simple: true })) >= 1) return;
    const tables = new Set(
      (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
    );
    if (tables.has("groups") && !tables.has("projects")) this.db.exec(`ALTER TABLE groups RENAME TO projects`);
    if (this.hasColumn("projects", "project_dir"))
      this.db.exec(`ALTER TABLE projects RENAME COLUMN project_dir TO local_repo_path`);
    if (this.hasColumn("sessions", "group_id"))
      this.db.exec(`ALTER TABLE sessions RENAME COLUMN group_id TO project_id`);
    this.db.pragma("user_version = 1");
  }

  // Exception-swallowing is not enough for RENAME COLUMN: "no such table" (fresh DB) and
  // "no such column" (already migrated) are indistinguishable, and one must not silence
  // the other. `pragma table_info` on a missing table returns no rows.
  private hasColumn(table: string, column: string): boolean {
    return (this.db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
  }
```

- [ ] **Step 6: Replace the four `groups` methods with the `projects` surface**

Replace lines 105-136 (`listGroups`, `createGroup`, `updateGroup`, `removeGroup`) with:

```ts
  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, local_repo_path as localRepoPath, color, preview_command as previewCommand, api_command as apiCommand, carry_files as carryFiles, default_branch as defaultBranch, conventions, created_at as createdAt FROM projects ORDER BY created_at`,
      )
      .all() as (Omit<Project, "carryFiles"> & { carryFiles: string })[];
    // An unbound project stores NULL/"" for its path; hand callers a plain "" so a
    // `!project.localRepoPath` check is all the launch path ever needs.
    return rows.map((r) => ({ ...r, localRepoPath: r.localRepoPath ?? "", carryFiles: JSON.parse(r.carryFiles) as string[], color: r.color ?? undefined, defaultBranch: r.defaultBranch ?? undefined, conventions: r.conventions ?? undefined }));
  }

  // Local project rows MIRROR cloud projects, so the id always comes from the caller —
  // never randomUUID. A cloud refresh omits localRepoPath, and the CASE below keeps this
  // machine's existing binding instead of wiping it (design D1).
  upsertProject(p: Omit<Project, "createdAt" | "localRepoPath"> & { localRepoPath?: string; createdAt?: string }): Project {
    const row: Project = {
      ...p,
      localRepoPath: p.localRepoPath ?? "",
      carryFiles: p.carryFiles ?? [".env"],
      createdAt: p.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, local_repo_path, color, preview_command, api_command, carry_files, default_branch, conventions, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           local_repo_path = CASE WHEN excluded.local_repo_path = '' THEN projects.local_repo_path ELSE excluded.local_repo_path END,
           color = excluded.color,
           preview_command = excluded.preview_command,
           api_command = excluded.api_command,
           carry_files = excluded.carry_files,
           default_branch = excluded.default_branch,
           conventions = excluded.conventions`,
      )
      .run(row.id, row.name, row.localRepoPath, row.color || null, row.previewCommand ?? null, row.apiCommand ?? null, JSON.stringify(row.carryFiles), row.defaultBranch || null, row.conventions || null, row.createdAt);
    // Re-read: the CASE may have kept a binding (and the original created_at) the caller
    // never sent, so the in-memory `row` is not the truth.
    return this.listProjects().find((x) => x.id === row.id)!;
  }

  patchProject(id: string, patch: { name?: string; localRepoPath?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string }): Project {
    const cur = this.listProjects().find((p) => p.id === id);
    if (!cur) throw new Error("project not found");
    const next = { ...cur, ...patch, color: (patch.color ?? cur.color) || undefined, defaultBranch: (patch.defaultBranch ?? cur.defaultBranch) || undefined, conventions: (patch.conventions ?? cur.conventions) || undefined };
    this.db
      .prepare(`UPDATE projects SET name=?, local_repo_path=?, color=?, preview_command=?, api_command=?, carry_files=?, default_branch=?, conventions=? WHERE id=?`)
      .run(next.name, next.localRepoPath, next.color || null, next.previewCommand ?? null, next.apiCommand ?? null, JSON.stringify(next.carryFiles ?? [".env"]), next.defaultBranch || null, next.conventions || null, id);
    return next;
  }

  removeProject(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }
```

- [ ] **Step 7: Rename the session columns**

Replace `listSessions` (lines 138-147):

```ts
  listSessions(projectId?: string): Session[] {
    const sql = `SELECT id, project_id as projectId, task_id as taskId, name, task, worktree_path as worktreePath, branch, worktree, base_branch as baseBranch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, parent_session_id as parentSessionId, kind, model, prefix, platform, status, archived, created_at as createdAt, last_activity_at as lastActivityAt FROM sessions`;
    const rows = (
      projectId
        ? this.db.prepare(sql + ` WHERE project_id = ? ORDER BY created_at`).all(projectId)
        : this.db.prepare(sql + ` ORDER BY created_at`).all()
    ) as (Omit<Session, "archived" | "worktree"> & { archived: number; worktree: number })[];
    // SQLite stores the flag as 0/1; hand callers a real boolean.
    return rows.map((r) => ({ ...r, archived: r.archived !== 0, worktree: r.worktree !== 0, taskId: r.taskId ?? undefined, model: r.model ?? undefined, prefix: r.prefix ?? undefined, platform: r.platform ?? undefined }));
  }
```

In `createSession`, replace the INSERT statement and its bindings (lines 167-190) — the column list gains `project_id`/`task_id` and drops `group_id`:

```ts
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, task_id, name, task, worktree_path, branch, worktree, base_branch, omp_session_id, omp_session_file, parent_session_id, kind, model, prefix, platform, status, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.taskId ?? null,
        row.name,
        row.task,
        row.worktreePath,
        row.branch,
        row.worktree ? 1 : 0,
        row.baseBranch ?? null,
        row.ompSessionId ?? null,
        row.ompSessionFile ?? null,
        row.parentSessionId ?? null,
        row.kind,
        row.model ?? null,
        row.prefix ?? null,
        row.platform ?? null,
        row.status,
        row.createdAt,
        row.lastActivityAt,
      );
```

`createSession`'s parameter type needs no edit: it is `Omit<Session, "id" | "createdAt" | …>`, so `projectId` becomes required and `taskId` optional automatically.

In `updateSession`, replace the UPDATE statement and its bindings (lines 198-219):

```ts
    this.db
      .prepare(
        `UPDATE sessions SET project_id=?, task_id=?, name=?, task=?, worktree_path=?, branch=?, worktree=?, base_branch=?, omp_session_id=?, omp_session_file=?, kind=?, model=?, prefix=?, platform=?, status=?, archived=? WHERE id=?`,
      )
      .run(
        next.projectId,
        next.taskId ?? null,
        next.name,
        next.task,
        next.worktreePath,
        next.branch,
        next.worktree ? 1 : 0,
        next.baseBranch ?? null,
        next.ompSessionId ?? null,
        next.ompSessionFile ?? null,
        next.kind,
        next.model ?? null,
        next.prefix ?? null,
        next.platform ?? null,
        next.status,
        next.archived ? 1 : 0,
        id,
      );
```

- [ ] **Step 8: Run the migration test to verify it passes**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.migration.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Update `registry.spec.ts` to the new surface**

Apply these substitutions to `apps/api/test/registry.spec.ts`. Every group-flavoured occurrence in the file is covered by this list; `upsertProject` needs an explicit id because the registry no longer mints one.

| Find (literal) | Replace with |
|---|---|
| `r.createGroup({ name: "app", projectDir: "/tmp/app" })` (lines 7, 20, 32, 40, 54, 71, 95, 115, 138, 161, 175) | `r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" })` |
| `r.createGroup({ name: "b", projectDir: "/tmp/b", carryFiles: [".env", ".env.local"] })` (75) | `r.upsertProject({ id: "p-b", name: "b", localRepoPath: "/tmp/b", carryFiles: [".env", ".env.local"] })` |
| `r.createGroup({ name: "old", projectDir: "/tmp/app" })` (85) | `r.upsertProject({ id: "p-app", name: "old", localRepoPath: "/tmp/app" })` |
| `r.createGroup({ name: "app2", projectDir: "/tmp/app2", defaultBranch: "main" })` (119) | `r.upsertProject({ id: "p-app2", name: "app2", localRepoPath: "/tmp/app2", defaultBranch: "main" })` |
| `r.createGroup({ name: "app2", projectDir: "/tmp/app2", conventions: "feat: rule" })` (142) | `r.upsertProject({ id: "p-app2", name: "app2", localRepoPath: "/tmp/app2", conventions: "feat: rule" })` |
| `r.createGroup({ name: "backend", projectDir: "/tmp/be" })` (185) | `r.upsertProject({ id: "p-be", name: "backend", localRepoPath: "/tmp/be" })` |
| `r.createGroup({ name: "frontend", projectDir: "/tmp/fe" })` (186) | `r.upsertProject({ id: "p-fe", name: "frontend", localRepoPath: "/tmp/fe" })` |
| `r.listGroups()` (every occurrence) | `r.listProjects()` |
| `r.updateGroup(` (every occurrence) | `r.patchProject(` |
| `groupId: g.id` / `groupId: a.id` | `projectId: g.id` / `projectId: a.id` |
| `{ groupId: b.id }` (189) | `{ projectId: b.id }` |
| `u.groupId` (190) | `u.projectId` |
| title `"group + session round trip"` | `"project + session round trip"` |
| title `"group carryFiles defaults to [.env] and round-trips"` | `"project carryFiles defaults to [.env] and round-trips"` |
| title `"updateGroup renames the group and round-trips"` | `"patchProject renames the project and round-trips"` |
| titles `"group color …"`, `"group defaultBranch …"`, `"group conventions …"` | `"project color …"`, `"project defaultBranch …"`, `"project conventions …"`, and `via updateGroup` → `via patchProject` |
| title `"updateSession moves a session to another group and round-trips"` | `"updateSession moves a session to another project and round-trips"` |

Then append the four new tests that cover the semantics `createGroup` never had — the cloud id, the binding-preserving upsert, `taskId`, and the cascade:

```ts
test("upsertProject takes the cloud id and refreshing config keeps the local binding", () => {
  const r = new RegistryService(":memory:");
  const created = r.upsertProject({ id: "cloud-uuid-1", name: "Acme", localRepoPath: "/tmp/acme" });
  expect(created.id).toBe("cloud-uuid-1");
  expect(created.carryFiles).toEqual([".env"]);

  // A cloud refresh sends config but no path: the binding must survive.
  const refreshed = r.upsertProject({ id: "cloud-uuid-1", name: "Acme Renamed", conventions: "feat: rule", carryFiles: [".env", ".env.local"] });
  expect(refreshed.localRepoPath).toBe("/tmp/acme");
  expect(refreshed.name).toBe("Acme Renamed");
  expect(refreshed.conventions).toBe("feat: rule");
  expect(refreshed.carryFiles).toEqual([".env", ".env.local"]);
  expect(refreshed.createdAt).toBe(created.createdAt);
  expect(r.listProjects()).toHaveLength(1);

  // An explicit path wins.
  expect(r.upsertProject({ id: "cloud-uuid-1", name: "Acme Renamed", localRepoPath: "/tmp/other" }).localRepoPath).toBe("/tmp/other");
});

test("patchProject binds and rebinds a local repo path, and rejects an unknown project", () => {
  const r = new RegistryService(":memory:");
  const p = r.upsertProject({ id: "cloud-uuid-2", name: "Unbound" });
  expect(p.localRepoPath).toBe("");

  expect(r.patchProject(p.id, { localRepoPath: "/tmp/bound" }).localRepoPath).toBe("/tmp/bound");
  expect(r.listProjects()[0]!.localRepoPath).toBe("/tmp/bound");
  // A name-only patch leaves the binding intact.
  r.patchProject(p.id, { name: "Bound" });
  expect(r.listProjects()[0]!.localRepoPath).toBe("/tmp/bound");

  expect(() => r.patchProject("nope", { name: "x" })).toThrow(/project not found/);
});

test("session taskId defaults undefined, round-trips, and survives updateSession", () => {
  const r = new RegistryService(":memory:");
  const p = r.upsertProject({ id: "p-task", name: "app", localRepoPath: "/tmp/app" });
  const plain = r.createSession({ projectId: p.id, name: "a", task: "t", worktreePath: "", branch: "b" });
  expect(plain.taskId).toBeUndefined();
  expect(r.listSessions(p.id).find((s) => s.id === plain.id)!.taskId).toBeUndefined();

  const fromTask = r.createSession({ projectId: p.id, taskId: "cloud-task-9", name: "b", task: "t", worktreePath: "", branch: "c" });
  expect(r.listSessions(p.id).find((s) => s.id === fromTask.id)!.taskId).toBe("cloud-task-9");
  // A status-only update must not drop the task link.
  r.updateSession(fromTask.id, { status: "thinking" });
  expect(r.listSessions(p.id).find((s) => s.id === fromTask.id)!.taskId).toBe("cloud-task-9");
});

test("removeProject deletes the project and its sessions", () => {
  const r = new RegistryService(":memory:");
  const p = r.upsertProject({ id: "p-gone", name: "gone", localRepoPath: "/tmp/gone" });
  r.createSession({ projectId: p.id, name: "a", task: "t", worktreePath: "", branch: "b" });
  r.removeProject(p.id);
  expect(r.listProjects()).toHaveLength(0);
  expect(r.listSessions()).toHaveLength(0);
});
```

- [ ] **Step 10: Update `registry.branch.spec.ts`**

Two substitutions cover every occurrence in the 30-line file: `r.createGroup({ name: "g", projectDir: "/tmp/x" })` (lines 11, 20) → `r.upsertProject({ id: "p-x", name: "g", localRepoPath: "/tmp/x" })`; `groupId: g.id` (lines 12, 21, 23) → `projectId: g.id`.

- [ ] **Step 11: Run the registry specs to verify they pass**

Run: `pnpm --filter @kermanych/api exec vitest run test/registry.spec.ts test/registry.branch.spec.ts test/registry.migration.spec.ts`
Expected: PASS — 17 tests in `registry.spec.ts` (13 renamed + 4 new), 2 in `registry.branch.spec.ts`, 3 in `registry.migration.spec.ts`.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/registry/registry.service.ts apps/api/test/registry.migration.spec.ts apps/api/test/registry.spec.ts apps/api/test/registry.branch.spec.ts
git commit -m "feat(api): versioned v1 migration renaming groups to projects with local_repo_path"
```

---

### Task 3: Supervisor — project lookups, binding and cloud sync

**Files:**
- Modify: `apps/api/src/supervisor/supervisor.service.ts` (type import 23; `snapshot` 77-82; after `pushUpdate` 91; `addGroup` 93-98 — deleted; `removeGroup` 99-103; `updateGroup` 104-113; `projectBranches` 116-125)
- Modify (git mv): `apps/api/test/supervisor.group.spec.ts` → `apps/api/test/supervisor.project.spec.ts`

**Interfaces:**
- Consumes: `Project`, `ServerEvent` (Task 1); `registry.listProjects/upsertProject/patchProject/removeProject/listSessions` (Task 2); `CloudProject` from `@kermanych/cloud` (Plan A's `packages/cloud/src/types.ts`); `WorktreeService.isGitRepo/listBranches/currentBranch`.
- Produces: `private project(projectId: string): Project` (throws `project not found`); `private boundProject(projectId: string): Project` (also throws `project not bound`); `async removeProject(id: string): Promise<void>`; `async updateProject(id, patch): Promise<Project>`; `async bindProject(id: string, localRepoPath: string): Promise<Project>`; `async syncProjects(cloud: CloudProject[], prune = false): Promise<Project[]>`; `async projectBranches(projectId: string): Promise<{ branches: string[]; current: string; default: string | null }>`; `snapshot()` returns `{ projects, sessions }`. `addGroup` is GONE — projects are created in the cloud, never by a local directory pick.

- [ ] **Step 1: Write the failing tests**

Run `git mv apps/api/test/supervisor.group.spec.ts apps/api/test/supervisor.project.spec.ts`, then replace its whole contents:

```ts
// apps/api/test/supervisor.project.spec.ts
import { describe, expect, it, vi } from "vitest";
import type { CloudProject } from "@kermanych/cloud";
import type { ServerEvent } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import type { WorktreeService } from "../src/worktree/worktree.service";

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    prompt() {} followUp() {} steer() {}
  }
  return { RpcSession: FakeRpc };
});
import { SupervisorService } from "../src/supervisor/supervisor.service";

function make() {
  const registry = new RegistryService(":memory:");
  // DI seam: on these paths SupervisorService only touches the worktree ops below,
  // so a partial mock is sufficient; cast once at the boundary.
  const isGitRepo = vi.fn().mockResolvedValue(true);
  const worktree = {
    isGitRepo,
    listBranches: vi.fn().mockResolvedValue(["main", "dev"]),
    currentBranch: vi.fn().mockResolvedValue("main"),
    removeWorktree: vi.fn(),
    removeBranch: vi.fn(),
    checkout: vi.fn(),
  } as unknown as WorktreeService;
  return { sup: new SupervisorService(registry, worktree), registry, worktree, isGitRepo };
}

function cloudProject(id: string, over: Partial<CloudProject> = {}): CloudProject {
  return {
    id, name: `cloud ${id}`, carryFiles: [".env"], envKeys: [],
    ownerId: "owner-1", createdAt: "2026-08-21T00:00:00.000Z", ...over,
  };
}

describe("bindProject", () => {
  it("trims and stores the local repo path and announces it", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "p1", name: "P" });
    const events: ServerEvent[] = [];
    const sub = sup.events$.subscribe((e) => events.push(e));

    const bound = await sup.bindProject("p1", "  /tmp/repo  ");
    sub.unsubscribe();

    expect(bound.localRepoPath).toBe("/tmp/repo");
    expect(registry.listProjects()[0]!.localRepoPath).toBe("/tmp/repo");
    expect(events.some((e) => e.type === "project_update" && e.project.localRepoPath === "/tmp/repo")).toBe(true);
  });

  it("refuses an empty path and a directory that is not a git repo", async () => {
    const { sup, registry, isGitRepo } = make();
    registry.upsertProject({ id: "p1", name: "P" });

    await expect(sup.bindProject("p1", "   ")).rejects.toThrow(/cannot be empty/);
    isGitRepo.mockResolvedValueOnce(false);
    await expect(sup.bindProject("p1", "/tmp/not-a-repo")).rejects.toThrow(/not a git repo/);
    expect(registry.listProjects()[0]!.localRepoPath).toBe("");
  });
});

describe("syncProjects", () => {
  it("upserts cloud config while keeping this machine's binding", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "p1", name: "Old", localRepoPath: "/tmp/bound" });

    const after = await sup.syncProjects([
      cloudProject("p1", { name: "New", conventions: "rule", defaultBranch: "dev", carryFiles: [".env", ".env.local"] }),
    ]);

    const p = after.find((x) => x.id === "p1")!;
    expect(p.localRepoPath).toBe("/tmp/bound");
    expect(p.name).toBe("New");
    expect(p.conventions).toBe("rule");
    expect(p.defaultBranch).toBe("dev");
    expect(p.carryFiles).toEqual([".env", ".env.local"]);
  });

  it("creates an unbound row for a cloud project this machine has never seen", async () => {
    const { sup, registry } = make();
    await sup.syncProjects([cloudProject("p-new")]);
    expect(registry.listProjects()[0]!.localRepoPath).toBe("");
  });

  it("prunes only rows with no sessions, and only when asked", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "gone-empty", name: "Gone", localRepoPath: "/tmp/gone" });
    registry.upsertProject({ id: "gone-busy", name: "Busy", localRepoPath: "/tmp/busy" });
    registry.createSession({ projectId: "gone-busy", name: "a", task: "t", worktreePath: "", branch: "b" });

    // prune=false (default): nothing is removed, because the payload may be partial.
    await sup.syncProjects([cloudProject("kept")]);
    expect(registry.listProjects().map((p) => p.id).sort()).toEqual(["gone-busy", "gone-empty", "kept"]);

    const after = await sup.syncProjects([cloudProject("kept")], true);

    // gone-empty is stale cache and goes; gone-busy still owns local sessions and stays
    // as an orphan row — pruning it would destroy a developer's work.
    expect(after.map((p) => p.id).sort()).toEqual(["gone-busy", "kept"]);
    expect(registry.listSessions("gone-busy")).toHaveLength(1);
  });
});

describe("updateProject", () => {
  it("renames the project, announces it, and refuses an empty name", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "p1", name: "old", localRepoPath: "/tmp/x" });
    const events: ServerEvent[] = [];
    const sub = sup.events$.subscribe((e) => events.push(e));

    const updated = await sup.updateProject("p1", { name: "  renamed  " });
    sub.unsubscribe();

    expect(updated.name).toBe("renamed");
    expect(events.some((e) => e.type === "project_update" && e.project.name === "renamed")).toBe(true);
    await expect(sup.updateProject("p1", { name: "   " })).rejects.toThrow(/empty/);
  });
});

describe("projectBranches", () => {
  it("reads branches from the bound repo and refuses an unbound project", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "bound", name: "B", localRepoPath: "/tmp/repo" });
    registry.upsertProject({ id: "unbound", name: "U" });

    await expect(sup.projectBranches("bound")).resolves.toEqual({ branches: ["main", "dev"], current: "main", default: null });
    await expect(sup.projectBranches("unbound")).rejects.toThrow(/project not bound/);
    await expect(sup.projectBranches("nope")).rejects.toThrow(/project not found/);
  });
});

describe("removeProject cascade", () => {
  it("removes the project, its sessions, and announces both", async () => {
    const { sup, registry, worktree } = make();
    const p = registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({
      projectId: p.id, name: "WT", task: "t", worktreePath: "/tmp/wt", branch: "feature/wt",
    });
    const events: ServerEvent[] = [];
    const sub = sup.events$.subscribe((e) => events.push(e));

    await sup.removeProject(p.id);
    sub.unsubscribe();

    expect(registry.listProjects()).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/tmp/proj", "/tmp/wt");
    expect(events.some((e) => e.type === "session_removed" && e.sessionId === s.id)).toBe(true);
    expect(events.some((e) => e.type === "project_removed" && e.projectId === p.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.project.spec.ts`
Expected: FAIL — `sup.bindProject is not a function`.

- [ ] **Step 3: Swap the type imports and `snapshot()`**

In `apps/api/src/supervisor/supervisor.service.ts`, change line 23 of the `@kermanych/core` type import from `  type Group,` to `  type Project,`, and add the cloud type import immediately after that import block:

```ts
import type { CloudProject } from "@kermanych/cloud";
```

Replace `snapshot()` (lines 77-82):

```ts
  snapshot() {
    return {
      projects: this.registry.listProjects(),
      sessions: this.registry.listSessions().map((s) => this.merge(s)),
    };
  }
```

- [ ] **Step 4: Add the two lookup helpers**

Insert after `pushUpdate` (after line 91), before the old `addGroup`:

```ts
  // Every project lookup used to be an inline `listGroups().find(...)` plus a hand-rolled
  // throw (13 sites). These two helpers are that pair, and `boundProject` additionally
  // enforces Requirement 3: no local execution without a local binding.
  private project(projectId: string): Project {
    const project = this.registry.listProjects().find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    return project;
  }

  private boundProject(projectId: string): Project {
    const project = this.project(projectId);
    if (!project.localRepoPath) throw new Error("project not bound");
    return project;
  }
```

- [ ] **Step 5: Replace `addGroup`/`removeGroup`/`updateGroup` with the project surface**

Delete `addGroup` entirely (lines 93-98) and replace `removeGroup`/`updateGroup` (lines 99-113) with:

```ts
  async removeProject(id: string): Promise<void> {
    for (const s of this.registry.listSessions(id)) await this.deleteSession(s.id);
    this.registry.removeProject(id);
    this.events.next({ type: "project_removed", projectId: id });
  }

  async updateProject(id: string, patch: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string }): Promise<Project> {
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("project name cannot be empty");
      patch = { ...patch, name };
    }
    const project = this.registry.patchProject(id, patch);
    this.events.next({ type: "project_update", project });
    return project;
  }

  // This machine's manual binding (Requirement 3). Kermanych never clones: the path must
  // already be a git repo, and each developer binds their own checkout.
  async bindProject(id: string, localRepoPath: string): Promise<Project> {
    const path = localRepoPath.trim();
    if (!path) throw new Error("local repo path cannot be empty");
    if (!(await this.worktree.isGitRepo(path))) throw new Error("local repo path is not a git repo");
    const project = this.registry.patchProject(id, { localRepoPath: path });
    this.events.next({ type: "project_update", project });
    return project;
  }

  // Refresh the offline config cache from cloud reads (design D1). `prune` is opt-in and
  // only the UI's full-list refresh passes it; even then a row that still owns local
  // sessions survives as an orphan, because dropping it would cascade-delete a
  // developer's worktrees over a transient RLS/network hiccup.
  async syncProjects(cloud: CloudProject[], prune = false): Promise<Project[]> {
    for (const c of cloud) {
      const project = this.registry.upsertProject({
        id: c.id,
        name: c.name,
        color: c.color,
        previewCommand: c.previewCommand,
        apiCommand: c.apiCommand,
        carryFiles: c.carryFiles,
        defaultBranch: c.defaultBranch,
        conventions: c.conventions,
      });
      this.events.next({ type: "project_update", project });
    }
    if (prune) {
      const known = new Set(cloud.map((c) => c.id));
      for (const p of this.registry.listProjects()) {
        if (known.has(p.id) || this.registry.listSessions(p.id).length) continue;
        this.registry.removeProject(p.id);
        this.events.next({ type: "project_removed", projectId: p.id });
      }
    }
    return this.registry.listProjects();
  }
```

- [ ] **Step 6: Replace `projectBranches`**

Replace lines 115-125 (the two comment lines plus the method):

```ts
  // Branch list for the bound repo, used by the project-settings default-branch picker and
  // the worktree fork-base picker in the UI.
  async projectBranches(projectId: string): Promise<{ branches: string[]; current: string; default: string | null }> {
    const project = this.boundProject(projectId);
    const [branches, current] = await Promise.all([
      this.worktree.listBranches(project.localRepoPath),
      this.worktree.currentBranch(project.localRepoPath),
    ]);
    return { branches, current, default: project.defaultBranch ?? null };
  }
```

- [ ] **Step 7: Sweep `deleteSession`'s project lookup (required by this task's own test)**

`removeProject` cascades into `deleteSession`, which still resolves the project
the old way at `supervisor.service.ts:804` — `this.registry.listGroups().find((x) => x.id === s.groupId)`.
`listGroups` no longer exists after Task 2, so the `removeProject` cascade test
in this task would throw `this.registry.listGroups is not a function` before
`worktree.removeWorktree` is ever called. Fix the five lines now (they are
listed again in Task 4's sweep table; by then they are already done — verify
rather than re-edit).

In `deleteSession`, replace lines 804-814 — the lookup plus the five
`g.projectDir` reads. This is byte-for-byte the edit Task 4's sweep table
prescribes for `deleteSession`, pulled forward; when you reach Task 4, verify it
rather than re-editing:

```ts
      const g = this.registry.listProjects().find((x) => x.id === s.projectId);
      if (g?.localRepoPath) {
        if (s.worktree) {
          if (s.worktreePath) await this.worktree.removeWorktree(g.localRepoPath, s.worktreePath);
        } else if (s.baseBranch && (await this.worktree.currentBranch(g.localRepoPath)) === s.branch) {
          // Restore the project to its base branch (delete discards the session's in-progress work).
          await this.worktree
            .checkout(g.localRepoPath, s.baseBranch)
            .catch(() => this.worktree.checkout(g.localRepoPath, s.baseBranch!, { force: true }));
        }
        if (s.branch) await this.worktree.removeBranch(g.localRepoPath, s.branch);
      }
```

`g?.localRepoPath` (not `if (g)`) is deliberate: deleting a session must keep
working when its project row is unbound or orphaned. Everything around the
block — the child cascade, `stopPoll`/`rpc.stop()`, `registry.removeSession`,
`events.next({ type: "session_removed", … })` — stays exactly as it is. The one
remaining `s.groupId` in this method becomes `s.projectId` with the lookup above.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @kermanych/api exec vitest run test/supervisor.project.spec.ts`
Expected: PASS (8 tests), including the `removeProject` worktree cascade — which
only passes because of Step 7. Other supervisor specs are still red: Task 4
fixes the launch path, Task 6 fixes the remaining specs.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/supervisor/supervisor.service.ts apps/api/test/supervisor.project.spec.ts
git commit -m "feat(api): supervisor project surface with local binding and cloud config sync"
```

---

### Task 4: Supervisor launch path + preview/seed/env sweep

**Files:**
- Modify: `apps/api/src/supervisor/supervisor.service.ts` (`createSession` 127-162; `startTask` 167-201; `moveTask` 222-232; `createChat` 238-247; `promoteChatToAgent` 274-317; `resolveLaunchParams` 333-364; `launch` 370-428; the 10 remaining lookup sites listed below)
- Modify: `apps/api/src/preview/preview.service.ts:34-59`
- Modify: `apps/api/src/preview/seed.ts` (lines 1-41)
- Modify: `apps/api/src/env/carry-files.ts:6-9`, `apps/api/src/env/env-file.service.ts:15-46`

**Interfaces:**
- Consumes: `project()`/`boundProject()` (Task 3); `registry.listSessions(projectId)`, `registry.upsertProject`, `registry.listProjects` (Task 2).
- Produces: every launch/git path reads `project.localRepoPath`; a launch against an unbound project fails with `project not bound` before any git side effect. `copyCarryFiles(repoPath, wtDir, files)` and `EnvFileService.read/write(repoPath, …)` keep their behaviour under renamed parameters. `seedDemo` seeds local project rows with synthetic UUIDs and still works with no cloud.

- [ ] **Step 1: Rewrite `createSession`'s project resolution**

In `supervisor.service.ts`, change the first parameter on line 128 to `projectId: string,`, then replace lines 139-156 with:

```ts
    const project = this.project(projectId);

    // A backlog task is just a saved launch config: no branch, no worktree, no omp child.
    // startTask turns it into a running agent later, reusing exactly these fields. It is
    // allowed on an unbound project — only launching needs the binding.
    if (asTask) {
      const session = this.registry.createSession({
        projectId, name, task, worktreePath: "", branch: "",
        worktree, model, prefix, platform, baseBranch, status: "backlog", kind: "task",
      });
      this.pushUpdate(session.id);
      return this.merge(session);
    }

    const { branch, baseBranch: resolvedBase } = await this.resolveLaunchParams(project, name, prefix, worktree, undefined, baseBranch);
    const session = this.registry.createSession({ projectId, name, task, worktreePath: "", branch, worktree, baseBranch: resolvedBase, model, prefix, platform });
    try {
      return await this.launch(session, project, { images });
```

(Lines 142-144 and 150-152 of the original — the comment and the `merge`/`pushUpdate` pair — are folded into the block above; the `catch` at 157 onwards is unchanged.)

- [ ] **Step 2: Rewrite `startTask`'s project resolution**

Replace lines 175-176 with a single line:

```ts
    const project = this.boundProject(cur.projectId);
```

and replace lines 190-193:

```ts
    const { branch, baseBranch } = await this.resolveLaunchParams(project, edited.name, edited.prefix ?? "feature", edited.worktree, id, edited.baseBranch);
    const session = this.registry.updateSession(id, { status: "queued", kind: "agent", branch, baseBranch, worktreePath: "" });
    try {
      return await this.launch(session, project, { images });
```

- [ ] **Step 3: Rewrite `moveTask`**

Replace lines 222-232 (comment included):

```ts
  // Move a backlog task to another project. A backlog row is bound to its project only by
  // project_id (no branch/worktree/omp child yet), so this is a pure re-parent — no git side
  // effects, and the destination does not need a local binding yet.
  moveTask(id: string, projectId: string): Session {
    const cur = this.registry.listSessions().find((x) => x.id === id);
    if (!cur) throw new Error("session not found");
    if (cur.kind !== "task" || cur.status !== "backlog") throw new Error("not a backlog task");
    this.project(projectId);
    const saved = this.registry.updateSession(id, { projectId });
    this.pushUpdate(id);
    return this.merge(saved);
  }
```

- [ ] **Step 4: Rewrite `createChat` and `promoteChatToAgent`**

Replace lines 238-246 (the `createChat` header through the `RpcSession` construction):

```ts
  async createChat(projectId: string): Promise<Session> {
    const project = this.boundProject(projectId);
    const n = this.registry.listSessions(projectId).filter((s) => s.kind === "chat").length + 1;
    const session = this.registry.createSession({
      projectId, name: `чат ${n}`, task: "", worktreePath: "", branch: "",
      worktree: false, kind: "chat", status: "queued",
    });
    const rpc = new RpcSession({ cwd: project.localRepoPath, tools: CHAT_TOOLS });
```

In `promoteChatToAgent`, replace lines 277-278 with:

```ts
    const project = this.boundProject(chat.projectId);
```

replace line 295:

```ts
    const { branch, baseBranch } = await this.resolveLaunchParams(project, name, "feature", true, chatId);
```

and replace line 317:

```ts
      return await this.launch(session, project, { fork: chatFile, firstPrompt: prompt });
```

- [ ] **Step 5: Rewrite `resolveLaunchParams`**

Replace lines 333-364 in full (keep the explanatory comment block above line 333, rewording "group"/"project dir" to "project"/"local repo path"):

```ts
  private async resolveLaunchParams(
    project: Project,
    name: string,
    prefix: BranchPrefix,
    worktree: boolean,
    excludeId?: string,
    requestedBase?: string,
  ): Promise<{ branch: string; baseBranch?: string }> {
    // Belt and braces: every caller already went through boundProject, but this is the last
    // point before git side effects, and an unbound path ("") would resolve to the api's cwd.
    if (!project.localRepoPath) throw new Error("project not bound");
    let baseBranch: string | undefined;
    if (!worktree) {
      if (await this.worktree.hasUncommitted(project.localRepoPath))
        throw new Error("project working tree must be clean to create an in-place (non-worktree) agent");
      // A backlog task hasn't launched, so it never occupies the single in-place slot.
      const activeInPlace = this.registry
        .listSessions(project.id)
        .some((s) => s.id !== excludeId && !s.worktree && s.kind !== "discussion" && s.kind !== "review" && s.status !== "merged" && s.status !== "backlog");
      if (activeInPlace)
        throw new Error("an in-place agent is already active in this project — finish or delete it first");
      baseBranch = await this.worktree.currentBranch(project.localRepoPath);
      if (!baseBranch) throw new Error("project has a detached HEAD — checkout a branch first");
    } else {
      // Worktree agents fork from the chosen base: explicit pick > project default > current HEAD.
      baseBranch = requestedBase ?? project.defaultBranch ?? undefined;
    }
    const existing = new Set(
      this.registry.listSessions(project.id).filter((s) => s.id !== excludeId).map((s) => s.branch).filter(Boolean),
    );
    const branch = uniqueSlug(branchName(slugify(name), prefix), existing);
    return { branch, baseBranch };
  }
```

- [ ] **Step 6: Rewrite `launch`**

Change the second parameter on line 372 to `project: Project,`, then replace lines 375-394 (the destructure through the rollback `throw`):

```ts
    const { id, branch, worktree, baseBranch, task, model } = session;
    if (!project.localRepoPath) throw new Error("project not bound");
    const { images, fork, firstPrompt } = opts;
    let wtDir = "";
    let branchCreated = false;
    try {
      if (worktree) {
        wtDir = worktreeDir(id);
        await this.worktree.addWorktree(project.localRepoPath, wtDir, branch, baseBranch);
        branchCreated = true;
        await copyCarryFiles(project.localRepoPath, wtDir, project.carryFiles ?? [".env"]);
      } else {
        await this.worktree.createBranchHere(project.localRepoPath, branch);
        branchCreated = true;
      }
    } catch (err) {
      if (wtDir) await this.worktree.removeWorktree(project.localRepoPath, wtDir).catch(() => {});
      if (branchCreated) await this.worktree.removeBranch(project.localRepoPath, branch).catch(() => {});
      throw err;
    }
```

(If the original destructure and `opts` unpacking span slightly different lines in your checkout, keep their existing shape and only change the `group.projectDir` reads — the `if (!project.localRepoPath) throw` line must sit before the first git call.)

Replace line 397:

```ts
    const rpc = new RpcSession({ cwd: worktree ? wtDir : project.localRepoPath, model, ...(fork ? { fork } : {}) });
```

and lines 417-422:

```ts
      if (worktree) {
        await this.worktree.removeWorktree(project.localRepoPath, wtDir).catch(() => {});
      } else if (baseBranch) {
        await this.worktree.checkout(project.localRepoPath, baseBranch, { force: true }).catch(() => {});
      }
      await this.worktree.removeBranch(project.localRepoPath, branch).catch(() => {});
```

- [ ] **Step 7: Sweep the remaining lookup sites**

Eight methods still open with the old pair

```ts
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
```

Replace that pair (and only that pair) per the table, keeping the local variable named `g` so each body needs no rename beyond `g.projectDir` → `g.localRepoPath`:

| Method (line of the pair) | Replacement | Why |
|---|---|---|
| `branchSession` (436-437) | `const g = this.boundProject(s.projectId);` | spawns a child omp in the repo |
| `reviewSession` (491-492) | `const g = this.boundProject(s.projectId);` | runs `git diff` in the repo |
| `resolveConflict` (714-715) | `const g = this.boundProject(s.projectId);` | reads unmerged files |
| `createPullRequest` (739-740) | `const g = this.project(s.projectId);` | only reads `defaultBranch`/`conventions` |
| `finishInfo` (838-839) | `const g = this.boundProject(s.projectId);` | `git` on the repo |
| `finishSession` (856-857) | `const g = this.boundProject(s.projectId);` | merges into the repo |
| `reopenSession` (925-926) | `const g = this.boundProject(s.projectId);` | re-adds a worktree |
| `doResume` (1005-1006) | `const g = this.boundProject(s.projectId);` | respawns omp in a dir |

Two sites are deliberately tolerant and must NOT throw on an unbound or orphaned project — deleting or opening a session has to keep working.

`deleteSession` (lines 804-805) — **already applied in Task 3 Step 7**; verify it
now reads

```ts
      const g = this.registry.listProjects().find((x) => x.id === s.projectId);
      if (g?.localRepoPath) {
```

`openInEditor` (lines 949-951): replace

```ts
    const g = this.registry.listGroups().find((x) => x.id === s.groupId);
    if (!g) throw new Error("group not found");
    const dir = s.worktreePath || g.projectDir;
```

with

```ts
    const g = this.registry.listProjects().find((x) => x.id === s.projectId);
    const dir = s.worktreePath || g?.localRepoPath;
    if (!dir) throw new Error("project not bound");
```

Then replace every remaining `g.projectDir` with `g.localRepoPath` — lines 451, 499, 500, 716, 841, 842, 843, 863, 871, 882, 883, 892, 895, 897, 898, 900, 901, 904, 906, 909, 913, 933, 934, 936, 937, 1009, 1010 — and every remaining `s.groupId` with `s.projectId`. (`deleteSession`'s five reads at 807, 808, 811, 812, 814 were already converted in Task 3 Step 7, because that task's `removeProject` cascade test needs them; confirm they read `g.localRepoPath` and move on.) Reword the comment on line 889 (`// In-place: projectDir is checked out on the session branch…`) to `// In-place: the local repo is checked out on the session branch…`, and the `moveTask` comment reference to `group_id` (already done in Step 3).

- [ ] **Step 8: Verify the supervisor itself typechecks**

Run: `pnpm --filter @kermanych/api exec tsc -p tsconfig.json --noEmit`
Expected: errors ONLY in `src/http/groups.controller.ts`, `src/http/sessions.controller.ts`, `src/app.module.ts`, `src/preview/preview.service.ts`, `src/preview/seed.ts` (fixed in Steps 9-11 and Task 5) — zero errors inside `supervisor.service.ts`. If `supervisor.service.ts` still reports errors, a lookup site was missed; the error text names the line.

- [ ] **Step 9: Rename the env helper parameters**

`apps/api/src/env/carry-files.ts` — replace lines 6-9:

```ts
// Copy each declared file that exists in the project's local repo into wtDir at the same
// relative path. Missing entries are skipped (a project may not have `.env`).
export async function copyCarryFiles(repoPath: string, wtDir: string, files: string[]): Promise<void> {
  const base = resolve(repoPath);
```

`apps/api/src/env/env-file.service.ts` — replace lines 15-35:

```ts
  // Resolve `<repoPath>/<file>` and refuse anything that escapes repoPath.
  private target(repoPath: string, file: string): string {
    const base = resolve(repoPath);
    const target = resolve(repoPath, file);
    if (!target.startsWith(base + sep)) throw new Error(`path escapes project directory: ${file}`);
    return target;
  }

  async read(repoPath: string, file = ".env"): Promise<EnvFileView> {
    const target = this.target(repoPath, file);
    const text = existsSync(target) ? await readFile(target, "utf8") : "";
    const ignored = await this.worktree.isIgnored(repoPath, file);
    return { entries: parseEnv(text), ignored };
  }

  async write(
    repoPath: string,
    file = ".env",
    edits: { set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> {
    const target = this.target(repoPath, file);
```

and line 46:

```ts
    return this.read(repoPath, file);
```

- [ ] **Step 10: Follow the rename in `PreviewService`**

Replace lines 34-37 of `apps/api/src/preview/preview.service.ts`:

```ts
    const project = this.registry.listProjects().find((p) => p.id === s.projectId);
    if (!project) throw new Error("project not found");
    const dir = s.worktreePath || project.localRepoPath;
    if (!dir) throw new Error("project not bound");
    if (!project.previewCommand) return { needsCommand: true };
```

Then replace `group.apiCommand` (lines 42, 44) with `project.apiCommand` and `group.previewCommand` (line 59) with `project.previewCommand`.

- [ ] **Step 11: Follow the rename in the offline preview seed**

Replace `apps/api/src/preview/seed.ts` lines 1-41 — the seed must mint its OWN ids now, because `upsertProject` never generates one, and it must keep working with no cloud (it runs inside a Kermanych-on-Kermanych preview):

```ts
// apps/api/src/preview/seed.ts
import { randomUUID } from "node:crypto";
import type { RegistryService } from "../registry/registry.service";
import type { SessionStatus } from "@kermanych/core";

// Demo data for a Kermanych-on-Kermanych preview. The previewed api boots on a fresh,
// isolated DB (KERMANYCH_DB in preview.service.ts), so without this the board comes up
// empty and there's nothing to eyeball. seedDemo fills the registry with INERT rows —
// no git, no omp, no cloud: projects carry no previewCommand, point at an unreachable
// localRepoPath and use synthetic UUIDs that exist on no Supabase project — covering
// every status plus the archived filter so the board, status dots, branch tags and
// project switcher all render. Idempotent: it only touches an empty registry, so a
// persistent preview DB never accumulates duplicates.
type Demo = {
  name: string;
  branch: string;
  status: SessionStatus;
  worktree?: boolean; // default true; false = in-place (carries a baseBranch)
  archived?: boolean;
  baseBranch?: string;
};

export function seedDemo(registry: RegistryService): void {
  if (registry.listProjects().length > 0) return; // already populated — never duplicate

  const acme = registry.upsertProject({ id: randomUUID(), name: "Acme Web", localRepoPath: "/tmp/kermanych-demo/acme-web" });
  const kmq = registry.upsertProject({ id: randomUUID(), name: "Kermanych", localRepoPath: "/tmp/kermanych-demo/kermanych" });

  const seed = (projectId: string, d: Demo) => {
    const s = registry.createSession({
      projectId,
      name: d.name,
      task: d.name,
      // Unreachable path: opening the session shows the dormant notice, and a resume/create
      // attempt fails fast with a toast instead of spawning omp or touching disk.
      worktreePath: d.worktree === false ? "" : `/tmp/kermanych-demo/wt/${d.branch.replace(/\//g, "-")}`,
      branch: d.branch,
      status: d.status,
      worktree: d.worktree ?? true,
      baseBranch: d.baseBranch,
    });
    if (d.archived) registry.updateSession(s.id, { archived: true });
  };
```

The two `Demo[]` arrays and the two `for (const r of …) seed(acme.id, r)` / `seed(kmq.id, r)` loops (lines 43-63) are unchanged.

- [ ] **Step 12: Checkpoint the launch path**

Run: `pnpm --filter @kermanych/api exec vitest run test/create-guards.spec.ts test/seed.spec.ts`
Expected: still FAIL — those specs call `createGroup`/`listGroups` and are migrated in Task 6. This step is a checkpoint, not a gate: confirm the failures are `createGroup is not a function` / `listGroups is not a function` and nothing else (no `project not bound`, no SQL error). A different error means a launch-path edit is wrong.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/supervisor/supervisor.service.ts apps/api/src/preview/preview.service.ts apps/api/src/preview/seed.ts apps/api/src/env/carry-files.ts apps/api/src/env/env-file.service.ts
git commit -m "feat(api): launch path reads project.localRepoPath and refuses unbound projects"
```

---

### Task 5: HTTP surface — `/api/projects`

**Files:**
- Modify (git mv): `apps/api/src/http/groups.controller.ts` → `apps/api/src/http/projects.controller.ts`
- Modify: `apps/api/src/app.module.ts:2,13` (coordinated two-line edit in a Plan-A-owned file)
- Modify: `apps/api/src/http/sessions.controller.ts:16-18,23-27,34-36,78-80`

**Interfaces:**
- Consumes: `sup.updateProject/bindProject/syncProjects/projectBranches` (Task 3); `reg.listProjects` (Task 2); `env.read/write(repoPath, …)` (Task 4); `CloudProject` (Plan A); `SupabaseAuthGuard` already registered as `APP_GUARD` by Plan A, so every route here requires a bearer token with no per-route decorator.
- Produces: `GET /api/projects` → `Project[]`; `PATCH /api/projects/:id` → `Project`; `PUT /api/projects/:id/binding { localRepoPath }` → `Project`; `POST /api/projects/sync { projects: CloudProject[]; prune?: boolean }` → `Project[]`; `GET /api/projects/:id/branches`; `GET|PUT /api/projects/:id/env` → `EnvFileView`. `POST /api/sessions`, `POST /api/sessions/chat` and `POST /api/sessions/:id/move` take `projectId`; `GET /api/sessions?projectId=`.
- Coordinated edit: `apps/api/src/app.module.ts` is Plan A's file (guard + providers). This plan changes exactly two lines in it — the controller import and the `controllers` array entry — because the file rename forces it. Plan A's `providers` and `APP_GUARD` entries are left byte-for-byte alone.
- Declared removals: `POST /api/groups` and `DELETE /api/groups/:id` have NO successor. Projects are created in the CLOUD (`createProject`, Task 7) and their local rows appear through `POST /projects/sync`; stale local rows disappear through the same route's prune.

- [ ] **Step 1: Rename the file and rewrite it**

Run `git mv apps/api/src/http/groups.controller.ts apps/api/src/http/projects.controller.ts`, then replace the whole file:

```ts
// apps/api/src/http/projects.controller.ts
import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import type { CloudProject } from "@kermanych/cloud";
import { SupervisorService } from "../supervisor/supervisor.service";
import { RegistryService } from "../registry/registry.service";
import { EnvFileService } from "../env/env-file.service";

// LOCAL project rows only: the cloud `projects` table is written by the UI under the
// user's JWT (RLS), and these routes cache it, bind it to a local repo, and serve the
// local-only concerns (branches, .env). There is deliberately no create/delete here.
@Controller("projects")
export class ProjectsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
    private env: EnvFileService,
  ) {}

  @Get()
  list() {
    return this.reg.listProjects();
  }

  // Literal segment declared before the `:id` routes (route order matters, cf.
  // @Post("chat") above @Post(":id/start") in sessions.controller.ts).
  @Post("sync")
  async sync(@Body() b: { projects: CloudProject[]; prune?: boolean }) {
    try {
      return await this.sup.syncProjects(b.projects ?? [], b.prune ?? false);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() b: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string },
  ) {
    try {
      return await this.sup.updateProject(id, b);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Put(":id/binding")
  async bind(@Param("id") id: string, @Body() b: { localRepoPath: string }) {
    try {
      return await this.sup.bindProject(id, b.localRepoPath ?? "");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/branches")
  async branches(@Param("id") id: string) {
    try {
      return await this.sup.projectBranches(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/env")
  async getEnv(@Param("id") id: string, @Query("file") file?: string) {
    const p = this.reg.listProjects().find((x) => x.id === id);
    if (!p) throw new BadRequestException("project not found");
    if (!p.localRepoPath) throw new BadRequestException("project not bound");
    try {
      return await this.env.read(p.localRepoPath, file || ".env");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Put(":id/env")
  async putEnv(
    @Param("id") id: string,
    @Body() b: { file?: string; set?: Record<string, string>; remove?: string[] },
  ) {
    const p = this.reg.listProjects().find((x) => x.id === id);
    if (!p) throw new BadRequestException("project not found");
    if (!p.localRepoPath) throw new BadRequestException("project not bound");
    try {
      return await this.env.write(p.localRepoPath, b.file || ".env", { set: b.set, remove: b.remove });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
}
```

- [ ] **Step 2: Point `AppModule` at the renamed controller**

Change line 2 and the `controllers` array on line 13 of `apps/api/src/app.module.ts`, leaving Plan A's `providers`/`APP_GUARD` entries exactly as they are:

```ts
import { ProjectsController } from "./http/projects.controller";
```

```ts
  controllers: [ProjectsController, SessionsController, FsController],
```

- [ ] **Step 3: Rename the session DTOs**

In `apps/api/src/http/sessions.controller.ts`, replace lines 16-18:

```ts
  @Get()
  list(@Query("projectId") projectId?: string) {
    return this.reg.listSessions(projectId);
  }
```

lines 23-27:

```ts
    @Body()
    b: { projectId: string; name: string; task: string; model?: string; images?: ImageInput[]; worktree?: boolean; prefix?: BranchPrefix; platform?: Platform; asTask?: boolean; baseBranch?: string },
  ) {
    try {
      return await this.sup.createSession(b.projectId, b.name, b.task, b.model, b.images, b.worktree ?? true, b.prefix ?? "feature", b.asTask ?? false, b.platform, b.baseBranch);
```

lines 34-36:

```ts
  async createChat(@Body() b: { projectId: string }) {
    try {
      return await this.sup.createChat(b.projectId);
```

and lines 78-80:

```ts
  move(@Param("id") id: string, @Body() b: { projectId: string }) {
    try {
      return this.sup.moveTask(id, b.projectId);
```

- [ ] **Step 4: Verify the api compiles**

Run: `pnpm --filter @kermanych/api exec tsc -p tsconfig.json --noEmit`
Expected: no type errors anywhere in `apps/api/src`.

- [ ] **Step 5: Smoke the routes against a real repo**

Start `pnpm dev:api` in one terminal. In another, with `$TOKEN` set to a valid Supabase access token that has already been handed to the local api via Plan A's `POST /api/auth/session` (the global guard 401s otherwise):

```bash
ID=$(uuidgen)
curl -s -X POST localhost:4317/api/projects/sync -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"projects\":[{\"id\":\"$ID\",\"name\":\"tmp\",\"carryFiles\":[\".env\"],\"envKeys\":[],\"ownerId\":\"u\",\"createdAt\":\"2026-08-21T00:00:00.000Z\"}]}"; echo
curl -s "localhost:4317/api/projects/$ID/env" -H "authorization: Bearer $TOKEN"; echo
curl -s -X PUT "localhost:4317/api/projects/$ID/binding" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"localRepoPath\":\"$(pwd)\"}"; echo
curl -s "localhost:4317/api/projects/$ID/env" -H "authorization: Bearer $TOKEN"; echo
curl -s "localhost:4317/api/projects/$ID/branches" -H "authorization: Bearer $TOKEN"; echo
curl -s -X POST localhost:4317/api/projects/sync -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"projects":[],"prune":true}'; echo
```

Expected, in order: sync returns an array containing the project with `"localRepoPath":""`; the first env GET returns a 400 body containing `project not bound`; the binding PUT returns the project with `localRepoPath` set to the repo; the second env GET returns `{"entries":[…],"ignored":true|false}`; branches returns `{"branches":[…],"current":"…","default":null}`; the final pruning sync returns `[]` (the row had no sessions, so it is swept).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/projects.controller.ts apps/api/src/app.module.ts apps/api/src/http/sessions.controller.ts
git commit -m "feat(api): /api/projects routes with local binding and cloud sync"
```

---

### Task 6: Bring the api suite back to green

**Files:**
- Modify: `apps/api/test/{supervisor.tasks,supervisor.chat,supervisor.review,supervisor.pr,supervisor.discard,supervisor.resume,supervisor.restart,supervisor.branch,supervisor.base-branch,supervisor.merge,preview,create-guards,reopen,finish,seed,carry-files}.spec.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 2-5.
- Produces: `pnpm --filter @kermanych/api exec vitest run` is green. No new test behaviour beyond the two additions called out below — this task migrates existing specs to the renamed surface.

- [ ] **Step 1: See the full damage**

Run: `pnpm --filter @kermanych/api exec vitest run`
Expected: failures in these 16 files (with their group-flavoured reference counts, measured before Task 1): `supervisor.tasks.spec.ts` (14), `supervisor.chat.spec.ts` (11), `supervisor.review.spec.ts` (10), `supervisor.pr.spec.ts` (6), `supervisor.discard.spec.ts` (6), `preview.spec.ts` (6), `create-guards.spec.ts` (5), `supervisor.resume.spec.ts` (4), `supervisor.restart.spec.ts` (4), `supervisor.branch.spec.ts` (4), `supervisor.base-branch.spec.ts` (4), `reopen.spec.ts` (4), `finish.spec.ts` (4), `supervisor.merge.spec.ts` (2), `seed.spec.ts` (2), `carry-files.spec.ts` (1). `registry*.spec.ts` and `supervisor.project.spec.ts` are already green.

- [ ] **Step 2: Apply the mechanical substitutions**

Across those 16 files, in this order:

1. `registry.createGroup({ name: X, projectDir: Y })` → `registry.upsertProject({ id: "p1", name: X, localRepoPath: Y })` (likewise `reg.createGroup(...)` → `reg.upsertProject(...)`). Where a test creates two projects, use `"p1"` and `"p2"`.
2. `.listGroups()` → `.listProjects()`.
3. `.updateGroup(` → `.patchProject(` on a registry receiver; `sup.updateGroup(` → `sup.updateProject(`.
4. `sup.addGroup(name, dir)` → **delete the call** and put a `registry.upsertProject({ id: "p1", name, localRepoPath: dir })` line in its place. If a spec asserted `addGroup`'s "project dir is not a git repo" refusal, move that assertion to `sup.bindProject("p1", dir)` — the guard lives there now, and its message is `local repo path is not a git repo`.
5. `sup.removeGroup(` → `sup.removeProject(`.
6. `groupId:` → `projectId:` inside every `createSession({...})` literal; `.groupId` → `.projectId` on every session object.
7. `"group not found"` / `/group not found/` → `"project not found"` / `/project not found/`.
8. Event assertions: `e.type === "group_update"` → `"project_update"`, `e.group` → `e.project`, `e.type === "group_removed"` → `"project_removed"`, `e.groupId` → `e.projectId`.
9. A local variable literally named `group` or `g` may keep its name; only its member access `.projectDir` → `.localRepoPath` changes. A local `const projectDir = mkdtempSync(...)` becomes `const repoPath = mkdtempSync(...)`.

Two files need more than substitution.

`preview.spec.ts` — the registry stubs are inline object literals cast to the service. Replace the first pair (lines 19-20):

```ts
    listSessions: () => [{ id: "s1", projectId: "g1", worktreePath: "/tmp" }],
    listProjects: () => [{ id: "g1", localRepoPath: "/tmp/repo", previewCommand, apiCommand }],
```

and the second pair (lines 72-73, in the `make()` that uses a real temp dir), after renaming its `projectDir` local to `repoPath`:

```ts
    listSessions: () => [{ id: "s1", projectId: "g1", worktreePath: "", worktree: false }],
    listProjects: () => [{ id: "g1", localRepoPath: repoPath, previewCommand, apiCommand }],
```

`seed.spec.ts` — both `reg.listGroups().length` assertions become `reg.listProjects().length`. Add one assertion (in the first test, after the length check) proving the offline seed still hangs every session off a seeded project, so a future `upsertProject` change cannot silently break the Kermanych-on-Kermanych preview:

```ts
  // The preview has no cloud: seeded projects carry synthetic UUIDs and every seeded
  // session must hang off one of them.
  const ids = new Set(reg.listProjects().map((p) => p.id));
  expect(ids.size).toBe(2);
  expect(reg.listSessions().every((s) => ids.has(s.projectId))).toBe(true);
```

- [ ] **Step 3: Run the full api suite**

Run: `pnpm --filter @kermanych/api exec vitest run`
Expected: PASS — every spec, including `registry.migration.spec.ts` and `supervisor.project.spec.ts`.

- [ ] **Step 4: Run the core suite too**

Run: `pnpm --filter @kermanych/core exec vitest run`
Expected: PASS. Core's specs never touched groups; this proves the type rename did not break `status.ts` / `worktree-names.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test
git commit -m "test(api): migrate the suite to the project surface"
```

---

### Task 7: `@kermanych/cloud` — projects and membership

**Files:**
- Create: `packages/cloud/src/projects.ts`
- Create: `packages/cloud/test/projects.spec.ts`
- Modify: `packages/cloud/src/index.ts` (append ONE line)

**Interfaces:**
- Consumes: `CloudProject`, `ProjectMember`, `Profile` from Plan A's `packages/cloud/src/types.ts`; `SupabaseClient` from `@supabase/supabase-js`; the `projects` / `project_members` / `profiles` tables, the `handle_new_project()` trigger and the RLS policies from Plan A's `supabase/migrations`.
- Produces: `listProjects(client): Promise<CloudProject[]>`; `createProject(client, { name, ownerId, gitRemoteUrl? }): Promise<CloudProject>`; `patchProject(client, id, patch: CloudProjectPatch): Promise<CloudProject>`; `listMembers(client, projectId): Promise<ProjectMember[]>`; `addMember(client, projectId, githubUsername): Promise<ProjectMember>`; `removeMember(client, projectId, userId): Promise<void>`; `type CloudProjectPatch`; `toCloudProject`/`toProjectRow` for tests. Row↔domain mapping (snake_case → camelCase) lives here; nothing outside this package ever sees a Postgres column name.
- Coordinated edit: `packages/cloud/src/index.ts` gains `export * from "./projects";`. Plan A ships that file with three lines (`./types`, `./client`, `./status`) and cannot forward-declare a module that does not exist yet, so each module's author appends its own barrel line. Plan C appends `./tasks` the same way.

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/test/projects.spec.ts`. It drives a hand-rolled fake that records the builder chain — no network, no `supabase start`:

```ts
// packages/cloud/test/projects.spec.ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMember,
  createProject,
  listMembers,
  listProjects,
  patchProject,
  removeMember,
} from "../src/projects";

type Op = [string, ...unknown[]];
type Query = { table: string; ops: Op[] };
type Result = { data: unknown; error: { message: string } | null };

// A PostgrestBuilder is a thenable that collects chained calls; this fake has the same
// shape, so `await client.from(t).select(c).eq(k, v).single()` resolves to the n-th queued
// result while recording every op for assertions.
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
      for (const op of ["select", "insert", "update", "delete", "eq", "order", "single", "maybeSingle"]) {
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

const projectRow = {
  id: "p1",
  name: "Acme",
  git_remote_url: "git@github.com:acme/web.git",
  conventions: null,
  preview_command: "pnpm dev",
  api_command: null,
  default_branch: "main",
  carry_files: [".env", ".env.local"],
  env_keys: ["GITHUB_TOKEN"],
  color: "#ff563c",
  owner_id: "u1",
  created_at: "2026-08-21T00:00:00.000Z",
};

const profileRow = { id: "u2", github_username: "octocat", display_name: "Octo Cat", avatar_url: null };
const memberRow = { project_id: "p1", user_id: "u2", role: "member" as const, added_at: "2026-08-21T01:00:00.000Z", profiles: profileRow };

describe("listProjects", () => {
  it("maps snake_case rows to CloudProject and nulls to absent keys", async () => {
    const { client, queries } = fakeClient({ data: [projectRow], error: null });

    const [p] = await listProjects(client);

    expect(p).toEqual({
      id: "p1",
      name: "Acme",
      gitRemoteUrl: "git@github.com:acme/web.git",
      previewCommand: "pnpm dev",
      defaultBranch: "main",
      carryFiles: [".env", ".env.local"],
      envKeys: ["GITHUB_TOKEN"],
      color: "#ff563c",
      ownerId: "u1",
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops[1]).toEqual(["order", "created_at", { ascending: true }]);
  });

  it("defaults carry_files to [.env] and env_keys to [] when the row has nulls", async () => {
    const { client } = fakeClient({ data: [{ ...projectRow, carry_files: null, env_keys: null }], error: null });
    const [p] = await listProjects(client);
    expect(p!.carryFiles).toEqual([".env"]);
    expect(p!.envKeys).toEqual([]);
  });

  it("throws the postgrest message so the UI can toast an RLS refusal", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table projects" } });
    await expect(listProjects(client)).rejects.toThrow(/permission denied/);
  });
});

describe("createProject", () => {
  it("inserts owner_id with a trimmed name and an empty remote as null", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });

    await createProject(client, { name: "  Acme  ", ownerId: "u1", gitRemoteUrl: "   " });

    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops[0]).toEqual(["insert", { name: "Acme", git_remote_url: null, owner_id: "u1" }]);
    expect(queries[0]!.ops.at(-1)).toEqual(["single"]);
  });

  it("refuses a blank name before touching the network", async () => {
    const { client, queries } = fakeClient();
    await expect(createProject(client, { name: "   ", ownerId: "u1" })).rejects.toThrow(/project name is required/);
    expect(queries).toHaveLength(0);
  });
});

describe("patchProject", () => {
  it("sends only the provided columns, snake-cased, emptied strings as null", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });

    await patchProject(client, "p1", { name: " New ", conventions: "   ", envKeys: ["A", "B"], previewCommand: "pnpm dev" });

    expect(queries[0]!.ops[0]).toEqual([
      "update",
      { name: "New", conventions: null, env_keys: ["A", "B"], preview_command: "pnpm dev" },
    ]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "p1"]);
  });
});

describe("listMembers", () => {
  it("filters by project and folds the embedded profile into `profile`", async () => {
    const { client, queries } = fakeClient({ data: [memberRow], error: null });

    const [m] = await listMembers(client, "p1");

    expect(m).toEqual({
      projectId: "p1",
      userId: "u2",
      role: "member",
      addedAt: "2026-08-21T01:00:00.000Z",
      profile: { id: "u2", githubUsername: "octocat", displayName: "Octo Cat" },
    });
    expect(queries[0]!.table).toBe("project_members");
    expect(queries[0]!.ops[1]).toEqual(["eq", "project_id", "p1"]);
  });
});

describe("addMember", () => {
  it("resolves the github handle to a profile, strips a leading @, then inserts", async () => {
    const { client, queries } = fakeClient({ data: profileRow, error: null }, { data: memberRow, error: null });

    const m = await addMember(client, "p1", " @octocat ");

    expect(queries[0]!.table).toBe("profiles");
    expect(queries[0]!.ops[1]).toEqual(["eq", "github_username", "octocat"]);
    expect(queries[1]!.table).toBe("project_members");
    expect(queries[1]!.ops[0]).toEqual(["insert", { project_id: "p1", user_id: "u2", role: "member" }]);
    expect(m.userId).toBe("u2");
  });

  it("refuses a handle with no Kermanych profile and never inserts", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await expect(addMember(client, "p1", "ghost")).rejects.toThrow(/no Kermanych profile for @ghost/);
    expect(queries).toHaveLength(1);
  });

  it("refuses an empty handle", async () => {
    const { client, queries } = fakeClient();
    await expect(addMember(client, "p1", "  @ ")).rejects.toThrow(/github username is required/);
    expect(queries).toHaveLength(0);
  });
});

describe("removeMember", () => {
  it("deletes by the composite primary key", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });

    await removeMember(client, "p1", "u2");

    expect(queries[0]!.table).toBe("project_members");
    expect(queries[0]!.ops).toEqual([["delete"], ["eq", "project_id", "p1"], ["eq", "user_id", "u2"]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kermanych/cloud exec vitest run test/projects.spec.ts`
Expected: FAIL — "Cannot find module '../src/projects'".

- [ ] **Step 3: Implement the module**

Create `packages/cloud/src/projects.ts`:

```ts
// packages/cloud/src/projects.ts
// Cloud projects + membership. This file owns the snake_case <-> camelCase boundary:
// nothing outside @kermanych/cloud ever sees a Postgres column name. Every call runs
// under the caller's JWT, so RLS — not this code — is the authorization surface; refusals
// surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CloudProject, Profile, ProjectMember } from "./types";

const PROJECT_COLUMNS =
  "id, name, git_remote_url, conventions, preview_command, api_command, default_branch, carry_files, env_keys, color, owner_id, created_at";
const PROFILE_COLUMNS = "id, github_username, display_name, avatar_url";
const MEMBER_COLUMNS = `project_id, user_id, role, added_at, profiles(${PROFILE_COLUMNS})`;

type ProjectRow = {
  id: string;
  name: string;
  git_remote_url: string | null;
  conventions: string | null;
  preview_command: string | null;
  api_command: string | null;
  default_branch: string | null;
  carry_files: string[] | null;
  env_keys: string[] | null;
  color: string | null;
  owner_id: string;
  created_at: string;
};

type ProfileRow = {
  id: string;
  github_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type MemberRow = {
  project_id: string;
  user_id: string;
  role: "owner" | "member";
  added_at: string;
  profiles: ProfileRow | null;
};

// The editable slice of a project. `id`, `ownerId` and `createdAt` are never patched:
// the first two are immutable and ownership transfer is out of scope.
export type CloudProjectPatch = Partial<
  Pick<
    CloudProject,
    "name" | "gitRemoteUrl" | "conventions" | "previewCommand" | "apiCommand" | "defaultBranch" | "carryFiles" | "envKeys" | "color"
  >
>;

export function toCloudProject(row: ProjectRow): CloudProject {
  const p: CloudProject = {
    id: row.id,
    name: row.name,
    // `carry_files` defaults to array['.env'] in Postgres; be defensive so a hand-edited
    // row can never hand the launch path an empty carry list.
    carryFiles: row.carry_files ?? [".env"],
    envKeys: row.env_keys ?? [],
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
  // Optional keys are omitted rather than set to undefined, so a mapped project deep-equals
  // a hand-written literal in tests and JSON round-trips carry no null noise.
  if (row.git_remote_url !== null) p.gitRemoteUrl = row.git_remote_url;
  if (row.conventions !== null) p.conventions = row.conventions;
  if (row.preview_command !== null) p.previewCommand = row.preview_command;
  if (row.api_command !== null) p.apiCommand = row.api_command;
  if (row.default_branch !== null) p.defaultBranch = row.default_branch;
  if (row.color !== null) p.color = row.color;
  return p;
}

function toProfile(row: ProfileRow): Profile {
  const p: Profile = { id: row.id };
  if (row.github_username !== null) p.githubUsername = row.github_username;
  if (row.display_name !== null) p.displayName = row.display_name;
  if (row.avatar_url !== null) p.avatarUrl = row.avatar_url;
  return p;
}

function toProjectMember(row: MemberRow): ProjectMember {
  const m: ProjectMember = { projectId: row.project_id, userId: row.user_id, role: row.role, addedAt: row.added_at };
  if (row.profiles) m.profile = toProfile(row.profiles);
  return m;
}

// Only the keys actually present in the patch are sent, so a partial edit never nulls a
// column the user did not touch. An empty string means "clear it" -> NULL.
export function toProjectRow(patch: CloudProjectPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.gitRemoteUrl !== undefined) row.git_remote_url = patch.gitRemoteUrl.trim() || null;
  if (patch.conventions !== undefined) row.conventions = patch.conventions.trim() || null;
  if (patch.previewCommand !== undefined) row.preview_command = patch.previewCommand.trim() || null;
  if (patch.apiCommand !== undefined) row.api_command = patch.apiCommand.trim() || null;
  if (patch.defaultBranch !== undefined) row.default_branch = patch.defaultBranch.trim() || null;
  if (patch.carryFiles !== undefined) row.carry_files = patch.carryFiles;
  if (patch.envKeys !== undefined) row.env_keys = patch.envKeys;
  if (patch.color !== undefined) row.color = patch.color.trim() || null;
  return row;
}

export async function listProjects(client: SupabaseClient): Promise<CloudProject[]> {
  const { data, error } = await client.from("projects").select(PROJECT_COLUMNS).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ProjectRow[]).map(toCloudProject);
}

export async function createProject(
  client: SupabaseClient,
  input: { name: string; ownerId: string; gitRemoteUrl?: string },
): Promise<CloudProject> {
  const name = input.name.trim();
  if (!name) throw new Error("project name is required");
  // handle_new_project() inserts the owner's project_members row, so no second round trip.
  const { data, error } = await client
    .from("projects")
    .insert({ name, git_remote_url: input.gitRemoteUrl?.trim() || null, owner_id: input.ownerId })
    .select(PROJECT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toCloudProject(data as ProjectRow);
}

export async function patchProject(client: SupabaseClient, id: string, patch: CloudProjectPatch): Promise<CloudProject> {
  const { data, error } = await client
    .from("projects")
    .update(toProjectRow(patch))
    .eq("id", id)
    .select(PROJECT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toCloudProject(data as ProjectRow);
}

export async function listMembers(client: SupabaseClient, projectId: string): Promise<ProjectMember[]> {
  const { data, error } = await client
    .from("project_members")
    .select(MEMBER_COLUMNS)
    .eq("project_id", projectId)
    .order("added_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as MemberRow[]).map(toProjectMember);
}

// Membership is by GitHub handle, because that is what a team knows about each other. The
// handle must already have a `profiles` row, i.e. that person has signed in at least once.
export async function addMember(client: SupabaseClient, projectId: string, githubUsername: string): Promise<ProjectMember> {
  const handle = githubUsername.trim().replace(/^@/, "").trim();
  if (!handle) throw new Error("github username is required");
  const found = await client.from("profiles").select(PROFILE_COLUMNS).eq("github_username", handle).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const profile = found.data as ProfileRow | null;
  if (!profile) throw new Error(`no Kermanych profile for @${handle} — ask them to sign in with GitHub first`);
  const { data, error } = await client
    .from("project_members")
    .insert({ project_id: projectId, user_id: profile.id, role: "member" })
    .select(MEMBER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectMember(data as MemberRow);
}

export async function removeMember(client: SupabaseClient, projectId: string, userId: string): Promise<void> {
  const { error } = await client.from("project_members").delete().eq("project_id", projectId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 4: Append the barrel line**

Add one line to the end of `packages/cloud/src/index.ts`, after Plan A's three:

```ts
export * from "./projects";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kermanych/cloud exec vitest run test/projects.spec.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Typecheck and build the package**

Run: `pnpm --filter @kermanych/cloud exec tsc -p tsconfig.json --noEmit && pnpm --filter @kermanych/cloud build`
Expected: no type errors. The build is REQUIRED: `apps/api` and `apps/ui` resolve `@kermanych/cloud` through its dist, and Task 3's supervisor import of `CloudProject` needs it.

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/projects.ts packages/cloud/src/index.ts packages/cloud/test/projects.spec.ts
git commit -m "feat(cloud): project and membership queries with snake-case mapping"
```

---

### Task 8: UI api client — local project wrappers

**Files:**
- Modify: `apps/ui/src/lib/api.ts` (type import 3-14; a new helper after `put<T>` at 72; `createGroup` 75-76; `deleteGroup` 78-81; `createSession` 83-95; `createChat` 97-98; `updateGroup` 121-132; `listBranches` 134-135; `getEnv` 137-138; `saveEnv` 140-143; `moveTask` 204-205)

**Interfaces:**
- Consumes: `Project` (Task 1); `CloudProject` from `@kermanych/cloud` (Plan A's types, Task 7's queries produce them); the routes from Task 5; the `Authorization: Bearer` header Plan A added to `post`/`get`/`put`.
- Produces: `api.listProjects(): Promise<Project[]>`; `api.patchProject(id, body): Promise<Project>`; `api.setProjectBinding(id, localRepoPath): Promise<Project>`; `api.syncProjects(projects: CloudProject[], prune?: boolean): Promise<Project[]>`; `api.listBranches(id)`, `api.getEnv(id, file?)`, `api.saveEnv(id, patch)` now hit `/projects/...`; `api.createSession(projectId, …)`, `api.createChat(projectId)`, `api.moveTask(id, projectId)`.
- Declared removals: `api.createGroup` and `api.deleteGroup` are GONE. With them, two of the call sites Plan A migrated onto its own helpers disappear (`deleteGroup` → `del`, `updateGroup` → `patchJson`); the rest stay as Plan A left them.

- [ ] **Step 1: Update the type imports**

Replace lines 3-14:

```ts
import type {
  BranchPrefix,
  Platform,
  DirListing,
  ImageInput,
  Project,
  EnvFileView,
  Session,
  TaskDraft,
  TranscriptEntry,
  RpcExtensionUIResponse,
} from '@kermanych/core';
import type { CloudProject } from '@kermanych/cloud';
```

- [ ] **Step 2: Confirm Plan A's `patchJson` helper is what you call**

Do NOT add a PATCH helper. Plan A already replaced the two formerly-inline
`fetch` call sites with two helpers next to `put<T>` — `del(path)` and
`patchJson<T>(path, body)` — both carrying the `Authorization` header and the
401 hook. Open `apps/ui/src/lib/api.ts` and verify both exist before continuing:

Run: `grep -n "async function \(del\|patchJson\|put\)" apps/ui/src/lib/api.ts`
Expected: three matches. If `patchJson` is missing, Plan A was not merged —
stop and merge it first rather than duplicating the helper here (a second PATCH
helper that forgets the header would 401 on every authenticated PATCH).

- [ ] **Step 3: Replace the group members with the local project surface**

Replace lines 75-81 (`createGroup` + `deleteGroup`):

```ts
  // LOCAL project rows. Creation and deletion live in the cloud (see stores/projects.ts);
  // these routes cache cloud config and own this machine's binding.
  listProjects: (): Promise<Project[]> => get<Project[]>('/projects'),

  patchProject: (
    id: string,
    body: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string },
  ): Promise<Project> => patchJson<Project>(`/projects/${id}`, body),

  setProjectBinding: (id: string, localRepoPath: string): Promise<Project> =>
    put<Project>(`/projects/${id}/binding`, { localRepoPath }),

  // `prune` is only safe when `projects` is the FULL cloud list; a single-project refresh
  // must leave it false or it would sweep every other cached row.
  syncProjects: (projects: CloudProject[], prune = false): Promise<Project[]> =>
    post<Project[]>('/projects/sync', { projects, prune }),
```

- [ ] **Step 4: Rename the session-side parameters**

Replace lines 83-98:

```ts
  createSession: (
    projectId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = 'feature',
    asTask = false,
    platform?: Platform,
    baseBranch?: string,
  ): Promise<Session> =>
    post<Session>('/sessions', { projectId, name, task, model, images, worktree, prefix, platform, asTask, baseBranch }),

  createChat: (projectId: string): Promise<Session> =>
    post<Session>('/sessions/chat', { projectId }),
```

Delete the whole `updateGroup` block (lines 121-132) — `patchProject` replaces it — and replace lines 134-143:

```ts
  listBranches: (id: string): Promise<{ branches: string[]; current: string; default: string | null }> =>
    get<{ branches: string[]; current: string; default: string | null }>(`/projects/${id}/branches`),

  getEnv: (id: string, file?: string): Promise<EnvFileView> =>
    get<EnvFileView>(`/projects/${id}/env${file ? `?file=${encodeURIComponent(file)}` : ''}`),

  saveEnv: (
    id: string,
    edits: { file?: string; set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> => put<EnvFileView>(`/projects/${id}/env`, edits),
```

(The `saveEnv` parameter is renamed `patch` → `edits` so the call reads the same way as `patchJson`'s body argument and nothing shadows a helper name.)

Finally replace lines 204-205:

```ts
  moveTask: (id: string, projectId: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/move`, { projectId }),
```

- [ ] **Step 5: Verify (partial — the UI cannot compile yet)**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors reported inside `src/lib/api.ts`. Remaining errors are confined to `src/stores/orchestrator.ts`, `src/layouts/MainLayout.vue`, `src/pages/WorkspacePage.vue`, `src/pages/KitGalleryPage.vue` and `src/components/kit/KRailItem.vue`, all fixed by Tasks 9-14.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/api.ts
git commit -m "feat(ui): api client for local project rows, binding and cloud sync"
```

---

### Task 9: UI orchestrator store — local project state

**Files:**
- Modify: `apps/ui/src/stores/orchestrator.ts` (type import 5-15; state 34-40; reducer 45-92; `selectGroup` 118-121; `createGroup`/`deleteGroup` 128-134; `createSession`/`createChat` 136-153; `moveTask` 167-169; `updateGroup` 226-228; return block 289-333)

**Interfaces:**
- Consumes: `Project`, `ServerEvent` (Task 1); `api.*` (Task 8).
- Produces: store state `projects: Project[]`, `selectedProjectId: string | undefined`; actions `selectProject(id)`, `patchProject(id, body)`, `setProjectBinding(id, localRepoPath)`, `syncProjects(projects, prune?)`, `createSession(projectId, …)`, `createChat(projectId)`, `moveTask(id, projectId)`. `createGroup`/`deleteGroup`/`updateGroup` are GONE.

- [ ] **Step 1: Update the imports and state**

Replace `  Group,` with `  Project,` on line 9 of the type import. Replace lines 34-40:

```ts
  // LOCAL project rows, streamed from the api over the socket. Each row is a cloud
  // project's offline config cache plus this machine's binding (localRepoPath, "" when
  // unbound). Cloud-side project metadata and membership live in stores/projects.ts.
  const projects = ref<Project[]>([]);
  const sessions = ref<Session[]>([]);
  const transcripts = ref<Record<string, TranscriptEntry[]>>({});
  const selectedProjectId = ref<string | undefined>(undefined);
  const selectedSessionId = ref<string | undefined>(undefined);
  const previews = ref<Record<string, string>>({});
  const toasts = ref<Toast[]>([]);
```

- [ ] **Step 2: Update the reducer branches**

Replace lines 45-62:

```ts
  function reduce(e: ServerEvent): void {
    if (e.type === 'snapshot') {
      projects.value = e.projects;
      sessions.value = e.sessions;
    } else if (e.type === 'project_update') {
      projects.value = [
        ...projects.value.filter((p) => p.id !== e.project.id),
        e.project,
      ];
    } else if (e.type === 'project_removed') {
      projects.value = projects.value.filter((p) => p.id !== e.projectId);
      sessions.value = sessions.value.filter((x) => x.projectId !== e.projectId);
      // The selected project just vanished (pruned here or deleted in the cloud) —
      // fall back to the "nothing selected" shell so the header/board don't dangle.
      if (selectedProjectId.value === e.projectId) {
        selectedProjectId.value = undefined;
        selectedSessionId.value = undefined;
      }
```

and, inside the `session_update` branch, the notification click handler (lines 80-84):

```ts
        n.onclick = () => {
          window.kermanych?.focus();
          selectProject(e.session.projectId);
          selectSession(e.session.id);
        };
```

- [ ] **Step 3: Replace the project actions**

Replace lines 118-121:

```ts
  function selectProject(id: string): void {
    selectedProjectId.value = id;
    selectedSessionId.value = undefined;
  }
```

Replace lines 127-134 (the `// Actions delegating to the REST api.` comment plus `createGroup` and `deleteGroup`):

```ts
  // Actions delegating to the REST api. There is deliberately no createProject/
  // deleteProject: projects are born and die in the cloud (stores/projects.ts), and the
  // local rows follow through syncProjects.
  function patchProject(id: string, body: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string }) {
    return api.patchProject(id, body);
  }

  function setProjectBinding(id: string, localRepoPath: string) {
    return api.setProjectBinding(id, localRepoPath);
  }

  function syncProjects(cloud: Parameters<typeof api.syncProjects>[0], prune = false) {
    return api.syncProjects(cloud, prune);
  }
```

Replace lines 136-153 (`createSession` + `createChat`):

```ts
  function createSession(
    projectId: string,
    name: string,
    task: string,
    model?: string,
    images?: ImageInput[],
    worktree = true,
    prefix: BranchPrefix = 'feature',
    asTask = false,
    platform?: Platform,
    baseBranch?: string,
  ) {
    return api.createSession(projectId, name, task, model, images, worktree, prefix, asTask, platform, baseBranch);
  }

  function createChat(projectId: string) {
    return api.createChat(projectId);
  }
```

Replace lines 167-169:

```ts
  function moveTask(id: string, projectId: string) {
    return api.moveTask(id, projectId);
  }
```

Delete the `updateGroup` function (lines 226-228) — `patchProject` replaces it.

- [ ] **Step 4: Update the return block**

In the returned object (lines 289-333) make exactly these changes: `groups,` → `projects,`; `selectedGroupId,` → `selectedProjectId,`; `selectGroup,` → `selectProject,`; `updateGroup,` → `patchProject,`; delete `createGroup,` and `deleteGroup,`; add `setProjectBinding,` and `syncProjects,` immediately after `patchProject,`.

- [ ] **Step 5: Verify (partial)**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors reported inside `src/stores/orchestrator.ts`; remaining errors only in `MainLayout.vue`, `WorkspacePage.vue`, `KitGalleryPage.vue`, `KRailItem.vue`.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/stores/orchestrator.ts
git commit -m "feat(ui): orchestrator store holds local project rows and the binding action"
```

---

### Task 10: UI cloud store — `stores/projects.ts`

**Files:**
- Create: `apps/ui/src/stores/projects.ts`

**Interfaces:**
- Consumes: `useAuth()` from Plan A (`client: SupabaseClient`, `user: { id: string } | null`); `listProjects`/`createProject`/`patchProject`/`listMembers`/`addMember`/`removeMember`/`CloudProjectPatch` from `@kermanych/cloud` (Task 7); `api.syncProjects` (Task 8).
- Produces: `useProjects()` exposing `projects: CloudProject[]`, `members: Record<string, ProjectMember[]>`, `loading: boolean`, `offlineError: string | null`, `byId: Map<string, CloudProject>`, `load()`, `create(name, gitRemoteUrl?)`, `patch(id, patch)`, `loadMembers(id)`, `addMember(id, githubUsername)`, `removeMember(id, userId)`, `isOwner(id)`. Plan C's `stores/board.ts` reads the project list from here and owns tasks + Realtime only.

- [ ] **Step 1: Create the store**

```ts
// apps/ui/src/stores/projects.ts
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { CloudProject, CloudProjectPatch, ProjectMember } from '@kermanych/cloud';
import {
  addMember as cloudAddMember,
  createProject as cloudCreateProject,
  listMembers as cloudListMembers,
  listProjects as cloudListProjects,
  patchProject as cloudPatchProject,
  removeMember as cloudRemoveMember,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { api } from '../lib/api';

// Cloud projects + membership: the source of truth for project CONFIG and who is on a
// project. Every successful read is mirrored into the LOCAL registry
// (POST /api/projects/sync) so launching keeps working with Supabase unreachable
// (design D1 / Requirement 7). Tasks and Realtime live in stores/board.ts.
export const useProjects = defineStore('projects', () => {
  const auth = useAuth();
  const projects = ref<CloudProject[]>([]);
  const members = ref<Record<string, ProjectMember[]>>({});
  const loading = ref(false);
  const offlineError = ref<string | null>(null);

  async function load(): Promise<CloudProject[]> {
    loading.value = true;
    try {
      const list = await cloudListProjects(auth.client);
      projects.value = list;
      offlineError.value = null;
      // This IS the full cloud list, so prune is safe: local rows missing from it are
      // stale cache. The api still refuses to prune a row that owns local sessions.
      await api.syncProjects(list, true);
      return list;
    } catch (e) {
      // Keep whatever is already cached locally: the rail is driven by the LOCAL rows, so
      // a failed cloud read degrades to "no fresh config", not "no projects".
      offlineError.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function create(name: string, gitRemoteUrl?: string): Promise<CloudProject> {
    const userId = auth.user?.id;
    if (!userId) throw new Error('not signed in');
    const created = await cloudCreateProject(auth.client, { name, ownerId: userId, gitRemoteUrl });
    projects.value = [...projects.value, created];
    // prune=false: this is one project, not the full list.
    await api.syncProjects([created], false);
    return created;
  }

  async function patch(id: string, p: CloudProjectPatch): Promise<CloudProject> {
    const updated = await cloudPatchProject(auth.client, id, p);
    projects.value = projects.value.map((x) => (x.id === id ? updated : x));
    await api.syncProjects([updated], false);
    return updated;
  }

  async function loadMembers(id: string): Promise<ProjectMember[]> {
    const list = await cloudListMembers(auth.client, id);
    members.value = { ...members.value, [id]: list };
    return list;
  }

  async function addMember(id: string, githubUsername: string): Promise<ProjectMember> {
    const m = await cloudAddMember(auth.client, id, githubUsername);
    members.value = { ...members.value, [id]: [...(members.value[id] ?? []), m] };
    return m;
  }

  async function removeMember(id: string, userId: string): Promise<void> {
    await cloudRemoveMember(auth.client, id, userId);
    members.value = {
      ...members.value,
      [id]: (members.value[id] ?? []).filter((m) => m.userId !== userId),
    };
  }

  const byId = computed(() => new Map(projects.value.map((p) => [p.id, p])));

  // UX only — RLS is the real gate: the owner-only policies refuse a non-owner write
  // regardless of what this returns.
  function isOwner(id: string): boolean {
    const uid = auth.user?.id;
    return !!uid && byId.value.get(id)?.ownerId === uid;
  }

  return {
    projects,
    members,
    loading,
    offlineError,
    byId,
    load,
    create,
    patch,
    loadMembers,
    addMember,
    removeMember,
    isOwner,
  };
});
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors reported inside `src/stores/projects.ts`. If the `@kermanych/cloud` named imports fail to resolve, `packages/cloud` was not built (Task 7 Step 6) or Plan A's `quasar.config.ts` CJS-interop entry for it is missing — fix that, do not add a workaround here.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/stores/projects.ts
git commit -m "feat(ui): cloud projects and membership store"
```

---
