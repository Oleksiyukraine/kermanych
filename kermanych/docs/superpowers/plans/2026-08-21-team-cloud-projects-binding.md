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

### Task 11: MainLayout rail — cloud projects joined with local rows

**Files:**
- Modify: `apps/ui/src/components/kit/KRailItem.vue:1-106` (whole file)
- Modify: `apps/ui/src/layouts/MainLayout.vue:1-155` (template), `:157-345` (script), `:423-448` (style tail)
- Modify: `apps/ui/src/pages/KitGalleryPage.vue:135-141` (rail block), `:220-222` (type import), `:251-254` (session fixture), `:301-305` (rail fixture)

**Interfaces:**
- Consumes: `Project`, `SessionStatus`, `EnvFileView` (Task 1); `useOrchestrator()` — state `projects`, `sessions`, `selectedProjectId`, `toasts`, actions `connect()`, `selectProject(id)`, `patchProject(id, body)`, `listBranches(id)`, `getEnv(id, file?)`, `saveEnv(id, edits)`, `notify(message, kind, ms)`, `dismissToast(id)` (Task 9); `useProjects()` — `projects: CloudProject[]`, `byId`, `load()`, `create(name, gitRemoteUrl?)` (Task 10); `useAuth().ready` (Plan A).
- Produces: `RailProject = { id: string; name: string; color?: string | undefined; state: 'bound' | 'unbound' | 'orphan' }`, exported from `KRailItem.vue` (same dual-`<script>` pattern as `KTableColumn` in `KTable.vue:1-12`). In `MainLayout.vue`: `railProjects: RailProject[]`, `selectedProject` (the LOCAL row), `selectedCloud` (the `CloudProject`), `selectedName`, `isBound`, `runningCount(id)`, `openSettings()`, `saveSettings()`, `openEnv()`, `saveEnv()`, and the refs `settingsOpen`/`settingsError`/`nameEdit`/`colorEdit`/`defaultBranchEdit`/`conventionsEdit`/`settingsBranches`/`envOpen`/`envError`/`envView`/`carryFilesText`/`envEditor`. Tasks 12-14 extend exactly these; they add no second source of project state.
- Declared removals: the add-project modal's directory picker (`groupDir`, `pickerOpen`, the `KDirPicker` import and tag) and `deleteProject()` are GONE from this task's file. The picker comes back in Task 12 as the BINDING flow; deletion moves to the CLOUD in Task 15 — there is still no `DELETE /api/projects/:id`, a project dies in Supabase and its local row disappears through sync's prune.

Read `apps/ui/src/components/kit/KTable.vue:1-12` first: that is the pattern for exporting a type from an SFC (a plain `<script lang="ts">` block above `<script setup>`), and `KitGalleryPage.vue:234` is the matching import form.

- [ ] **Step 1: Rewrite `KRailItem.vue`**

Replace the whole file (all 106 lines):

```vue
<script lang="ts">
// The rail tile's view model. MainLayout builds it by joining the CLOUD project list (what
// exists for the whole team) with the LOCAL project rows (what this machine can actually
// run), so the tile renders the binding state without importing either store:
//   bound   — a local row with a localRepoPath; agents can be launched here.
//   unbound — the project exists in the cloud, this machine has no repo for it yet.
//   orphan  — a local row whose cloud project is gone (sync's prune kept it because it
//             still owns sessions); its agents stay usable, nothing new should start.
export type RailProject = {
  id: string;
  name: string;
  color?: string | undefined;
  state: 'bound' | 'unbound' | 'orphan';
};
</script>

<script setup lang="ts">
import { computed } from 'vue';

// A project tile in the left rail (design-system section 07). Initials stand in for the
// project, the count badge is the number of running agents, and the corner glyph is the
// binding state. Active tile gets surface2 and a 2px accent strip on the left edge.
const props = defineProps<{ project: RailProject; active?: boolean; count?: number }>();

const count = computed(() => props.count ?? 0);

// Ukrainian copy for the two states worth naming; a bound project needs no explanation.
const STATE_HINT: Record<RailProject['state'], string> = {
  bound: '',
  unbound: ' · не прив’язано',
  orphan: ' · поза хмарою',
};

const STATE_GLYPH: Record<RailProject['state'], string> = {
  bound: '',
  unbound: '○',
  orphan: '⚠',
};

const title = computed(() => props.project.name + STATE_HINT[props.project.state]);

const initials = computed(() => {
  const words = props.project.name.trim().split(/[\s/_-]+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return '·';
  if (!second) return first.slice(0, 2).toUpperCase();
  return ((first[0] ?? '') + (second[0] ?? '')).toUpperCase();
});
</script>

<template>
  <button
    class="k-rail"
    :class="{
      'k-rail--active': active,
      'k-rail--colored': !!project.color,
      'k-rail--unbound': project.state === 'unbound',
      'k-rail--orphan': project.state === 'orphan',
    }"
    type="button"
    :title="title"
    :aria-pressed="active"
    :style="project.color ? { '--rail-color': project.color } : undefined"
  >
    <span class="k-rail__initials mono">{{ initials }}</span>
    <span v-if="count > 0" class="k-rail__count mono">{{ count }}</span>
    <span v-if="project.state !== 'bound'" class="k-rail__state mono" aria-hidden="true">
      {{ STATE_GLYPH[project.state] }}
    </span>
  </button>
</template>

<style scoped lang="scss">
.k-rail {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-muted);
  cursor: pointer;
  border-radius: 0;
  transition: background 0.12s, border-color 0.12s, color 0.12s;

  &:hover:not(.k-rail--active) {
    border-color: var(--k-line-strong);
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// left strip — project color when set (always shown), else the accent when active.
.k-rail--active {
  background: var(--k-surface2);
  border-color: var(--k-line-strong);
  color: var(--k-text);
}

.k-rail--active::before,
.k-rail--colored::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--k-accent);
}

.k-rail--colored::before {
  background: var(--rail-color);
}

// binding state — dashed frame while this machine has no repo, accent frame for a row the
// cloud no longer lists.
.k-rail--unbound {
  border-style: dashed;
}

.k-rail--orphan {
  border-color: var(--k-accent);
}

.k-rail__state {
  position: absolute;
  bottom: -1px;
  right: 1px;
  font-size: 9px;
  line-height: 1;
  color: var(--k-muted);
}

.k-rail__initials {
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.04em;
}

// count badge — accent square, top-right, machine number.
.k-rail__count {
  position: absolute;
  top: -1px;
  right: -1px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  color: var(--k-canvas);
  background: var(--k-accent);
}
</style>
```

- [ ] **Step 2: Replace the `MainLayout.vue` template**

Replace lines 1-155 (`<template>` … `</template>`):

```vue
<template>
  <q-layout view="lHh Lpr lFf" class="shell">
    <!-- LEFT RAIL — one tile per CLOUD project, plus any orphan local row (07) -->
    <q-drawer
      model-value
      side="left"
      :width="60"
      :breakpoint="0"
      bordered
      class="shell__rail"
    >
      <div class="shell__rail-inner">
        <div class="shell__rail-items">
          <KRailItem
            v-for="p in railProjects"
            :key="p.id"
            :project="p"
            :active="p.id === store.selectedProjectId"
            :count="runningCount(p.id)"
            @click="store.selectProject(p.id)"
          />
        </div>
        <KBtn
          variant="icon"
          class="shell__add"
          title="Новий проєкт у хмарі"
          @click="openCreate"
        >
          +
        </KBtn>
      </div>
    </q-drawer>

    <!-- TOP HEADER — logo + selected-project context + project actions (07) -->
    <q-header class="shell__header">
      <div class="shell__brand">
        <span class="shell__logo">КЕРМАНИЧ</span>
        <span class="shell__ver mono">v0.1</span>
      </div>
      <div class="shell__context mono">{{ contextLabel }}</div>
      <div v-if="store.selectedProjectId" class="shell__actions">
        <KBtn
          variant="icon"
          title="Змінні середовища (.env)"
          @click="openEnv"
        >$</KBtn>
        <KBtn
          variant="icon"
          class="shell__settings"
          title="Редагувати проєкт"
          @click="openSettings"
        >⚙</KBtn>
      </div>
    </q-header>

    <!-- PAGE -->
    <q-page-container>
      <router-view />
    </q-page-container>

    <!-- BOTTOM STATUS BAR — fleet aggregate for the selected project (07) -->
    <q-footer class="shell__footer">
      <KStatusBar :counts="counts" />
    </q-footer>

    <!-- CREATE-PROJECT MODAL — a project is born in the CLOUD (Requirement 2: any signed-in
         user may create one and becomes its owner). The local row arrives through
         POST /api/projects/sync and starts out UNBOUND — no directory picker here. -->
    <KModal v-model="createOpen" title="Новий проєкт у хмарі">
      <div class="shell__form">
        <KField v-model="createName" label="Назва" placeholder="my-project" />
        <KField
          v-model="createRemote"
          label="Git remote (необовʼязково, лише довідково)"
          placeholder="git@github.com:org/repo.git"
        />
        <p class="shell__hint">
          Проєкт створюється у хмарі й одразу видимий команді. Керманич нічого не клонує —
          локальну теку цієї машини приєднаєте окремо.
        </p>
        <p v-if="createError" class="shell__error" role="alert">{{ createError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="createOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canCreate || createBusy" @click="submitCreate">
          Створити
        </KBtn>
      </template>
    </KModal>

    <!-- PROJECT-SETTINGS MODAL — identity + launch defaults. These writes still go to the
         LOCAL row; Task 14 moves them to the cloud and re-syncs. -->
    <KModal v-model="settingsOpen" :title="`Редагувати проєкт · ${selectedName}`">
      <div class="shell__form">
        <KField v-model="nameEdit" label="Назва проєкту" placeholder="my-project" />
        <KColorPicker v-model="colorEdit" label="Колір проєкту" />
        <KSelect
          v-model="defaultBranchEdit"
          label="Гілка за замовчуванням"
          :options="settingsBranches"
          :disabled="!isBound"
          placeholder="— поточна гілка репозиторію —"
        />
        <KField
          v-model="conventionsEdit"
          label="Конвенції PR/комітів (фолбек, якщо в репо немає)"
          placeholder="Порожнє — Керманич підставить власні дефолти"
          multiline
          :rows="6"
        />
        <KField
          :model-value="selectedProject?.localRepoPath || 'не прив’язано'"
          label="Локальна тека цієї машини"
          disabled
        />
        <p v-if="settingsError" class="shell__error" role="alert">{{ settingsError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="settingsOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" @click="saveSettings">Зберегти</KBtn>
      </template>
    </KModal>

    <!-- ENV MODAL — the BOUND repo's .env plus the per-session carry files. Values are read
         and written on this machine only (Requirement 9). -->
    <KModal v-model="envOpen" :title="`Змінні середовища · ${selectedName}`">
      <div class="shell__form">
        <KEnvEditor
          ref="envEditor"
          :entries="envView.entries"
          :ignored="envView.ignored"
        />
        <KField
          v-model="carryFilesText"
          label="Файли для сесії (через кому або з нового рядка)"
          placeholder=".env"
        />
        <p v-if="envError" class="shell__error" role="alert">{{ envError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="envOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" @click="saveEnv">Зберегти</KBtn>
      </template>
    </KModal>

    <!-- TOAST STACK — transient notifications (errors etc.) -->
    <KToast :toasts="store.toasts" @dismiss="store.dismissToast" />
  </q-layout>
</template>
```

- [ ] **Step 3: Replace the `MainLayout.vue` script**

Replace lines 157-345 (`<script setup lang="ts">` … `</script>`):

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { SessionStatus, EnvFileView } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useAuth } from 'stores/auth';
import KRailItem, { type RailProject } from 'components/kit/KRailItem.vue';
import KStatusBar from 'components/kit/KStatusBar.vue';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KToast from 'components/kit/KToast.vue';
import KEnvEditor from 'components/kit/KEnvEditor.vue';
import KColorPicker from 'components/kit/KColorPicker.vue';
import KSelect from 'components/kit/KSelect.vue';

// The Kermanych app shell (design-system section 07): project rail, brand header, page
// container, fleet status bar. Two stores back it — `store` (useOrchestrator) owns the LOCAL
// rows and sessions streamed over the socket, `projects` (useProjects) owns the CLOUD project
// list and membership. The rail is the join of the two.
const store = useOrchestrator();
const projects = useProjects();
const auth = useAuth();

// True only once a cloud read has actually succeeded on this run. Until then a local row
// absent from the (still empty) cloud list is an unread cache, not an orphan — labelling
// every project «поза хмарою» on a cold or offline boot would be a lie.
const cloudSynced = ref(false);

onMounted(async () => {
  // Socket first: the snapshot, and the project_update events the sync inside load() emits,
  // are how LOCAL rows reach the rail. Connecting afterwards would race those events.
  store.connect();
  // The router guard already keeps this layout signed-in-only, but on a cold start `ready`
  // may still be pending, and useProjects() needs the session for RLS to return any row.
  await auth.ready;
  try {
    // load() reads the cloud list and mirrors it into the local registry itself
    // (api.syncProjects(list, true), see stores/projects.ts) — that mirror is what keeps
    // launching possible with Supabase unreachable (Requirement 7). Do not sync again here.
    await projects.load();
    cloudSynced.value = true;
  } catch (e) {
    store.notify(
      `Хмара недоступна — працюємо з локальним кешем: ${e instanceof Error ? e.message : String(e)}`,
      'error',
      6000,
    );
  }
});

// A session is "running" while it is queued or actively working; waiting means it is blocking
// on an interactive UI request; done is terminal-success.
const RUNNING: readonly SessionStatus[] = ['queued', 'thinking', 'tool'];

function sessionsOf(projectId: string | undefined) {
  return store.sessions.filter((s) => s.projectId === projectId && !s.archived);
}

function runningCount(projectId: string): number {
  return sessionsOf(projectId).filter((s) => RUNNING.includes(s.status)).length;
}

const counts = computed(() => {
  let running = 0;
  let waiting = 0;
  let done = 0;
  let error = 0;
  for (const s of sessionsOf(store.selectedProjectId)) {
    if (RUNNING.includes(s.status)) running++;
    else if (s.status === 'waiting_input') waiting++;
    else if (s.status === 'done') done++;
    else if (s.status === 'error') error++;
  }
  return { running, waiting, done, error };
});

// The rail: the CLOUD list (what exists, for everyone) in cloud order, then every LOCAL row
// the cloud list does not contain. Those trailing rows matter — sync's prune deliberately
// keeps a row that still owns sessions, and agents you cannot select are agents you cannot
// stop. A cloud project with no local row at all (the mount-time sync failed) shows as
// unbound, which is exactly what it is: nothing on this machine can run it yet.
const railProjects = computed<RailProject[]>(() => {
  const local = new Map(store.projects.map((p) => [p.id, p]));
  const out: RailProject[] = [];
  for (const c of projects.projects) {
    const row = local.get(c.id);
    local.delete(c.id);
    out.push({
      id: c.id,
      name: c.name,
      color: c.color ?? row?.color,
      state: row?.localRepoPath ? 'bound' : 'unbound',
    });
  }
  for (const row of local.values()) {
    out.push({
      id: row.id,
      name: row.name,
      color: row.color,
      state: cloudSynced.value ? 'orphan' : row.localRepoPath ? 'bound' : 'unbound',
    });
  }
  return out;
});

// The LOCAL row carries this machine's binding and the offline config cache; the CLOUD
// project is the source of truth for config. Same id, two lookups.
const selectedProject = computed(() =>
  store.projects.find((p) => p.id === store.selectedProjectId),
);

const selectedCloud = computed(() =>
  store.selectedProjectId ? projects.byId.get(store.selectedProjectId) : undefined,
);

// Prefer the cloud name, fall back to the cached row, so a project whose sync failed still
// shows a name rather than a UUID.
const selectedName = computed(
  () => selectedCloud.value?.name ?? selectedProject.value?.name ?? '',
);

// Requirement 3: only a bound project can touch the repo. Task 12 hangs every disabled
// affordance off this one computed.
const isBound = computed(() => !!selectedProject.value?.localRepoPath);

const contextLabel = computed(() => {
  if (!store.selectedProjectId) return 'Проєкт не вибрано';
  return `${selectedName.value} · ${selectedProject.value?.localRepoPath || 'не прив’язано'}`;
});

// Create-in-the-cloud modal. No directory field: creating a project and binding a repo are
// different acts on different machines (Requirement 3).
const createOpen = ref(false);
const createName = ref('');
const createRemote = ref('');
const createError = ref<string | null>(null);
const createBusy = ref(false);
const canCreate = computed(() => createName.value.trim() !== '');

function openCreate(): void {
  createName.value = '';
  createRemote.value = '';
  createError.value = null;
  createBusy.value = false;
  createOpen.value = true;
}

async function submitCreate(): Promise<void> {
  if (!canCreate.value) return;
  createError.value = null;
  createBusy.value = true;
  try {
    const remote = createRemote.value.trim();
    // create() inserts under the user's JWT (handle_new_project adds the owner membership)
    // and mirrors the one new project into the local registry, so its tile appears without a
    // second full sync.
    const created = await projects.create(createName.value.trim(), remote || undefined);
    createOpen.value = false;
    store.selectProject(created.id);
    store.notify(`Проєкт «${created.name}» створено у хмарі`);
  } catch (e) {
    // Keep the modal open. The two real refusals are `not signed in` (the session expired
    // between the router guard and this click) and a postgrest/RLS or network failure; both
    // are fixable without retyping the name.
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
  }
}

const settingsOpen = ref(false);
const settingsError = ref<string | null>(null);
const nameEdit = ref('');
const colorEdit = ref('');
const defaultBranchEdit = ref('');
const conventionsEdit = ref('');
const settingsBranches = ref<string[]>([]);

const envOpen = ref(false);
const envError = ref<string | null>(null);
const envView = ref<EnvFileView>({ entries: [], ignored: true });
const carryFilesText = ref('.env');
const envEditor = ref<{ collect: () => { set: Record<string, string>; remove: string[] } } | null>(null);

// Settings modal. Seeded from the cloud project when we have it, from the cached row when we
// do not, so the form is never blank just because Supabase is down.
async function openSettings(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  const cloud = selectedCloud.value;
  const row = selectedProject.value;
  settingsError.value = null;
  nameEdit.value = cloud?.name ?? row?.name ?? '';
  colorEdit.value = cloud?.color ?? row?.color ?? '';
  defaultBranchEdit.value = cloud?.defaultBranch ?? row?.defaultBranch ?? '';
  conventionsEdit.value = cloud?.conventions ?? row?.conventions ?? '';
  settingsBranches.value = [];
  settingsOpen.value = true;
  // GET /projects/:id/branches answers `project not bound` without a binding, so do not ask.
  if (!isBound.value) return;
  try {
    settingsBranches.value = (await store.listBranches(id)).branches;
  } catch {
    // Non-fatal: the picker degrades to the value already selected.
  }
}

async function saveSettings(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  settingsError.value = null;
  const name = nameEdit.value.trim();
  if (!name) {
    settingsError.value = 'Назва проєкту не може бути порожньою';
    return;
  }
  try {
    // LOCAL write for now — Task 14 sends this to the cloud and re-syncs. Until then an edit
    // here lives only until the next full sync overwrites the cached row.
    await store.patchProject(id, {
      name,
      color: colorEdit.value,
      defaultBranch: defaultBranchEdit.value,
      conventions: conventionsEdit.value,
    });
    settingsOpen.value = false;
  } catch (e) {
    settingsError.value = e instanceof Error ? e.message : String(e);
  }
}

// Env modal: the bound repo's .env plus the carry-files list copied into every session.
async function openEnv(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  envError.value = null;
  carryFilesText.value = (
    selectedCloud.value?.carryFiles ??
    selectedProject.value?.carryFiles ?? ['.env']
  ).join('\n');
  envView.value = { entries: [], ignored: true };
  envOpen.value = true;
  try {
    envView.value = await store.getEnv(id);
  } catch (e) {
    envError.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveEnv(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  envError.value = null;
  try {
    const carryFiles = carryFilesText.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    await store.patchProject(id, { carryFiles: carryFiles.length ? carryFiles : ['.env'] });
    const edits = envEditor.value?.collect();
    if (edits && (Object.keys(edits.set).length || edits.remove.length)) {
      await store.saveEnv(id, edits);
    }
    envOpen.value = false;
  } catch (e) {
    envError.value = e instanceof Error ? e.message : String(e);
  }
}
</script>
```

- [ ] **Step 4: Adjust the style block**

In the `<style scoped lang="scss">` block, add `.shell__hint` after `.shell__error` (line 434):

```scss
.shell__hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-muted);
}
```

Keep `.shell__dir` (436-440), `.shell__browse` (442-444) and `.shell__danger` (446-448) exactly as they are: Task 12's binding row reuses the first two, and Task 15's owner-only «Видалити проєкт» control reuses the third. Nothing else in the style block changes.

- [ ] **Step 5: Follow the rename through `KitGalleryPage.vue`**

This page is the other `KRailItem` call site, so it changes with the prop. Replace lines 135-141:

```vue
        <KRailItem
          v-for="r in railProjects"
          :key="r.project.id"
          :project="r.project"
          :active="r.active"
          :count="r.count"
        />
```

Replace lines 220-222 (drop `Group`, which no longer exists):

```ts
import type {
  SessionStatus, Session, TranscriptEntry, RpcExtensionUIResponse,
} from '@kermanych/core';
```

Add the rail view-model import after line 232 (`import KRailItem from 'components/kit/KRailItem.vue';` becomes):

```ts
import KRailItem, { type RailProject } from 'components/kit/KRailItem.vue';
```

Replace lines 251-254 (`groupId` → `projectId`):

```ts
  return {
    id: 's', projectId: 'p1', name: 'api-gateway', task: '',
    worktreePath: '', worktree: true, branch: 'main', kind: 'agent', status: 'thinking', createdAt: now, lastActivityAt: now, ...over,
  };
```

Replace lines 301-305 — the gallery now shows all three tile states, which is the point of a gallery:

```ts
const railProjects: { project: RailProject; active: boolean; count: number }[] = [
  { project: { id: 'p1', name: 'api-gateway', state: 'bound' }, active: true, count: 4 },
  { project: { id: 'p2', name: 'web client', state: 'unbound' }, active: false, count: 0 },
  { project: { id: 'p3', name: 'billing', state: 'orphan' }, active: false, count: 1 },
];
```

(`now` is still used by `mkSession` above, so the `const now` on line 249 stays.)

- [ ] **Step 6: Verify the shell typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no errors in `src/layouts/MainLayout.vue`, `src/components/kit/KRailItem.vue` or `src/pages/KitGalleryPage.vue`. The only remaining errors are in `src/pages/WorkspacePage.vue` (`store.groups`, `s.groupId`, `store.selectedGroupId`, `store.updateGroup`), which Task 12 fixes.

- [ ] **Step 7: Smoke the rail against a real stack**

Terminal 1: `pnpm dev:api`. Terminal 2: `pnpm dev:ui`. Sign in, then:

1. The rail shows one tile per cloud project you are a member of; a project with no local binding has a **dashed** frame and an `○` in its bottom-right corner, and hovering it shows «<назва> · не прив’язано».
2. The header for a selected unbound project reads `<назва> · не прив’язано`.
3. Click `+`, type a name, press «Створити» → the modal closes, a new dashed tile appears and is selected, and the toast reads «Проєкт «…» створено у хмарі».
4. Reload the page → the new tile is still there (it came back through `projects.load()` → `POST /api/projects/sync`), and `sqlite3 ~/.kermanych/kermanych.sqlite 'select id, name, local_repo_path from projects'` shows the row with an empty `local_repo_path`.
5. Stop `supabase stop`, reload → the error toast «Хмара недоступна — працюємо з локальним кешем: …» appears and the rail still lists the cached projects by their binding state (no `⚠`, because `cloudSynced` stayed false). Start Supabase again before continuing.

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue apps/ui/src/components/kit/KRailItem.vue apps/ui/src/pages/KitGalleryPage.vue
git commit -m "feat(ui): rail joins cloud projects with local rows and projects are created in the cloud"
```

---

### Task 12: the binding flow — «Прив’язати теку» and the unbound guards

**Files:**
- Modify: `apps/ui/src/layouts/MainLayout.vue` — **the file as Task 11 Step 2/3 left it.** Task 11 replaced the whole template and the whole script, so the pre-plan line numbers are void; the anchors below are the marker comments and function names Task 11 wrote. Read the file before editing.
- Modify: `apps/ui/src/pages/WorkspacePage.vue` — still untouched by this plan, so the line numbers are the real ones: template `:4`, `:10`, `:14`, `:16-21`, `:24`, `:67`, `:70`, `:93-97`, `:185`, `:317-324`, `:361-367`; script `:480`, `:513-525`, `:528`, `:530`, `:540-542`, `:676`, `:699-705`, `:713-718`, `:723-735`, `:815-817`, `:838-840`, `:866-870`, `:1108`, `:1117-1126`, `:1226`, `:1238`, `:1256`
- Modify: `apps/ui/src/components/kit/KDirPicker.vue:48-49` (its header comment still says "New-Project modal")

**Interfaces:**
- Consumes: `store.setProjectBinding(id, localRepoPath)` (Task 9); `store.projects`, `store.patchProject`, `store.listBranches`, `store.notify` (Task 9); `isBound`, `selectedProject`, `selectedName` (Task 11); `KDirPicker`'s existing contract — `v-model:modelValue: boolean`, `start?: string`, `@select: [path: string]` (`KDirPicker.vue:50-51`, unchanged).
- Produces: in `MainLayout.vue` — `BIND_HINT`, `BIND_ERRORS`, `pickerOpen`, `openBinding()`, `bindTo(path)`. In `WorkspacePage.vue` — `projectSessions`, `selectedProject`, `BIND_HINT`, `isBound`, `isBoundFor(projectId)`; `store.patchProject(s.projectId, patch)` replaces the old `store.updateGroup` call in `submitPreviewConfig()` (Task 14 moves that one call to the cloud).
- After this task `apps/ui` typechecks end to end for the first time since Task 1.

The three refusals `PUT /api/projects/:id/binding` really returns, verbatim, and where they come from:

| API message | Source | Ukrainian toast |
|---|---|---|
| `local repo path cannot be empty` | `supervisor.service.ts:130` | «Шлях до теки не може бути порожнім» |
| `local repo path is not a git repo` | `supervisor.service.ts:131` (`worktree.isGitRepo`) | «Обрана тека не є git-репозиторієм — виберіть корінь репозиторію (той, що містить .git)» |
| `project not found` | `registry.service.ts:200` via `patchProject` — this machine has no row for the project, i.e. the mount-time sync did not land | «Цього проєкту немає в локальному реєстрі — перезапустіть Керманич, щоб синхронізувати список із хмари» |

- [ ] **Step 1: Bring `KDirPicker` back, as the binding picker**

In `MainLayout.vue`, add the import next to the other kit imports in the `<script setup>` block Task 11 wrote:

```ts
import KDirPicker from 'components/kit/KDirPicker.vue';
```

Then, immediately before the `<!-- TOAST STACK … -->` comment in the template, add:

```vue
    <!-- DIRECTORY PICKER — server-side browser (GET /api/fs/list, still the LOCAL api). Its
         choice becomes THIS machine's binding for the selected project. -->
    <KDirPicker
      v-model="pickerOpen"
      :start="selectedProject?.localRepoPath ?? ''"
      @select="bindTo"
    />
```

- [ ] **Step 2: Add the binding action to the header**

Replace the whole `<div v-if="store.selectedProjectId" class="shell__actions">` block Task 11 wrote (the `$` and `⚙` buttons) with:

```vue
      <div v-if="store.selectedProjectId" class="shell__actions">
        <KBtn
          variant="secondary"
          :title="isBound ? 'Змінити локальну теку цього проєкту' : BIND_HINT"
          @click="openBinding"
        >{{ isBound ? 'Змінити теку' : 'Прив’язати теку' }}</KBtn>
        <KBtn
          variant="icon"
          :disabled="!isBound"
          :title="isBound ? 'Змінні середовища (.env)' : BIND_HINT"
          @click="openEnv"
        >$</KBtn>
        <KBtn
          variant="icon"
          class="shell__settings"
          title="Редагувати проєкт"
          @click="openSettings"
        >⚙</KBtn>
      </div>
```

The `⚙` button is deliberately NOT guarded: project settings are CLOUD config and a member with no local checkout must still be able to read and (if owner) edit them. Only `.env` — a file in the bound repo — needs the binding.

- [ ] **Step 3: Add the binding state and the error mapping**

In the `<script setup>` block, immediately after the `isBound` computed Task 11 wrote, add:

```ts
// Requirement 3: the binding is manual and per machine. Kermanych never clones — the path
// must already be a git repo, and each teammate binds their own checkout. One string for
// every disabled affordance, so the copy cannot drift.
const BIND_HINT = 'Прив’яжіть локальну теку репозиторію';

// The three refusals PUT /api/projects/:id/binding actually returns — the first two thrown by
// bindProject (supervisor.service.ts:130-131), the third by registry.patchProject when this
// machine has no row for the project at all. Anything else is shown verbatim: the api's own
// message beats a guess.
const BIND_ERRORS: Record<string, string> = {
  'local repo path cannot be empty': 'Шлях до теки не може бути порожнім',
  'local repo path is not a git repo':
    'Обрана тека не є git-репозиторієм — виберіть корінь репозиторію (той, що містить .git)',
  'project not found':
    'Цього проєкту немає в локальному реєстрі — перезапустіть Керманич, щоб синхронізувати список із хмари',
};

const pickerOpen = ref(false);

function openBinding(): void {
  pickerOpen.value = true;
}

async function bindTo(path: string): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  try {
    const bound = await store.setProjectBinding(id, path);
    // project_update streams back over the socket, so the rail tile drops its dashed frame and
    // the header picks up the path on their own — nothing to refresh here.
    store.notify(`Проєкт прив’язано до ${bound.localRepoPath}`);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    store.notify(BIND_ERRORS[raw] ?? raw, 'error', 6000);
  }
}
```

- [ ] **Step 4: Fix `KDirPicker`'s header comment**

Replace `apps/ui/src/components/kit/KDirPicker.vue:48-49`:

```ts
// Directory browser. Two callers, one contract: it stacks over whatever modal opened it
// (QDialog handles the layering) and emits the chosen absolute path. In MainLayout it picks
// THIS machine's binding for a cloud project; `⑂` marks the git repos.
```

- [ ] **Step 5: Rename sweep — `WorkspacePage.vue` template**

Line 4:

```vue
    <div v-if="!store.selectedProjectId" class="ws__blank">
```

Line 10:

```vue
      <!-- BOARD — one card per session in the selected project -->
```

Line 14:

```vue
            <h1 class="ws__heading">{{ selectedProject?.name ?? 'Проєкт' }}</h1>
```

Line 24:

```vue
          v-if="projectSessions.length"
```

Line 70:

```vue
                <KIconButton v-if="store.projects.length > 1" title="Перемістити в інший проєкт" @click.stop="openMove(row)">→</KIconButton>
```

Line 185:

```vue
          <span v-if="selectedProject" class="ws-launcher__tag mono">{{ selectedProject.name }}</span>
```

Lines 361-367 (the move list — `g` was a group):

```vue
            v-for="p in moveTargets"
            :key="p.id"
            type="button"
            class="ws__move-option"
            :disabled="moveBusy"
            @click="confirmMove(p.id)"
          >{{ p.name }}</button>
```

- [ ] **Step 6: Rename sweep — `WorkspacePage.vue` script**

Line 480:

```ts
// for the selected project + the full panel for the selected session, plus the
```

Lines 513-525:

```ts
const projectSessions = computed(() =>
  store.sessions
    .filter((s) => {
      if (s.projectId !== store.selectedProjectId) return false;
      if (showArchived.value) return !!s.archived;
      if (s.archived) return false;
      return showTasks.value ? s.status === 'backlog' : s.status !== 'backlog';
    })
    .sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      return byStatus !== 0 ? byStatus : a.createdAt.localeCompare(b.createdAt);
    }),
);
```

Line 528:

```ts
// tree). Orphans (parent filtered out by the archived/project view) still render.
```

Line 530:

```ts
  const all = projectSessions.value;
```

Lines 540-542:

```ts
const selectedProject = computed(() =>
  store.projects.find((p) => p.id === store.selectedProjectId),
);
```

Line 676:

```ts
    ? `нова worktree, чекаут від ${draftBaseBranch.value || selectedProject.value?.defaultBranch || 'HEAD'}`
```

Line 1108:

```ts
const moveTargets = computed(() => store.projects.filter((p) => p.id !== moveFor.value?.projectId));
```

Lines 1117-1126:

```ts
async function confirmMove(projectId: string): Promise<void> {
  const s = moveFor.value;
  if (!s) return;
  moveBusy.value = true;
  moveError.value = null;
  try {
    await store.moveTask(s.id, projectId);
    moveOpen.value = false;
    const dest = store.projects.find((p) => p.id === projectId);
    store.notify(`Задачу «${s.name}» перенесено в «${dest?.name ?? 'проєкт'}»`);
```

Line 1226:

```ts
  const p = store.projects.find((x) => x.id === s.projectId);
```

Line 1227 reads `if (!g?.previewCommand) {` — change it to `if (!p?.previewCommand) {`.

Lines 1238-1240:

```ts
  const p = store.projects.find((x) => x.id === s.projectId);
  draftWebCmd.value = (forceDefaults ? '' : p?.previewCommand ?? '') || DEFAULT_WEB_CMD;
  draftApiCmd.value = (forceDefaults ? '' : p?.apiCommand ?? '') || DEFAULT_API_CMD;
```

Line 1256:

```ts
    await store.patchProject(s.projectId, patch);
```

- [ ] **Step 7: Add the unbound guards to `WorkspacePage.vue`**

Insert after the `selectedProject` computed (the block that was lines 540-542):

```ts
// Requirement 3 in the UI: a task can be created, edited and moved without a binding, but
// nothing that touches the repo may run. `BIND_HINT` is the same string MainLayout uses; both
// copies are the operator's next action, not an apology.
const BIND_HINT = 'Прив’яжіть локальну теку репозиторію';
const isBound = computed(() => !!selectedProject.value?.localRepoPath);

// Row-level check: the board can show sessions of an orphan project whose row is still here
// but whose binding was never made, so per-row actions ask about the row's own project.
function isBoundFor(projectId: string): boolean {
  return !!store.projects.find((p) => p.id === projectId)?.localRepoPath;
}
```

Replace lines 16-21 (the board controls). «Нова задача» stays enabled on purpose — it opens the launcher, and saving a task to the backlog is explicitly allowed without a binding (`supervisor.service.ts:191-193`); the launch button inside the launcher is what gets guarded, in Step 8. «Швидкий чат» creates a live session immediately, so it is disabled:

```vue
          <div class="ws__board-controls">
            <KToggle :options="viewOptions" v-model="viewMode" />
            <KBtn
              variant="ghost"
              :disabled="!isBound"
              :title="isBound ? 'Сесія-чат без worktree' : BIND_HINT"
              @click="onNewChat"
            >+ Швидкий чат</KBtn>
            <KBtn variant="primary" @click="openLauncher()">Нова задача</KBtn>
          </div>
```

Replace line 67 (run a backlog task) — `KIconButton` passes `disabled` straight through to its native `<button>`, exactly as line 74 already does:

```vue
                <KIconButton
                  :disabled="!isBoundFor(row.projectId)"
                  :title="isBoundFor(row.projectId) ? 'Запустити задачу як агента' : BIND_HINT"
                  @click.stop="openLauncher(row)"
                >▶</KIconButton>
```

Replace lines 93-97 (the preview toggle — a preview runs `previewCommand` inside the session's worktree, and falls back to the project's repo path):

```vue
                <KIconButton
                  :active="!!store.previews[row.id]"
                  :disabled="!isBoundFor(row.projectId)"
                  :title="
                    __omp_shell("isBoundFor(row.projectId)")
                      ? BIND_HINT
                      : store.previews[row.id]
                        ? 'Зупинити превʼю'
                        : 'Превʼю гілки в браузері'
                  "
                  @click.stop="togglePreview(row)"
                >{{ store.previews[row.id] ? '◼' : '▶' }}</KIconButton>
```

Replace lines 317-324 (the launcher's two submit buttons — «В беклог»/«Зберегти» stays enabled, «Запустити» does not):

```vue
          <KBtn
            variant="secondary"
            :disabled="!canLaunch"
            @click="submitLauncher(true)"
          >{{ editingTaskId ? 'Зберегти' : 'В беклог' }}</KBtn>
          <KBtn
            variant="primary"
            :disabled="!canLaunch || !isBound"
            :title="isBound ? '' : BIND_HINT"
            @click="submitLauncher(false)"
          >
            Запустити<span class="ws-launcher__kbd mono">⌘⏎</span>
          </KBtn>
```

Replace lines 699-705 (`canLaunch` keeps meaning "the form is complete"; the hint carries the binding):

```ts
const canLaunch = computed(
  () => !!store.selectedProjectId && draftName.value.trim() !== '' && draftTask.value.trim() !== '',
);

const launcherTitle = computed(() => (editingTaskId.value ? 'Задача' : 'Нова задача'));
// Footer status: the binding first (it blocks launching outright), then the form nudge,
// then silence once launchable.
const footHint = computed(() => {
  if (!isBound.value) return BIND_HINT;
  return canLaunch.value ? '' : 'опиши завдання, щоб запустити';
});
```

Replace lines 713-718 (⌘⏎ must respect the same gate as the button it stands for):

```ts
function onLauncherKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (canLaunch.value && isBound.value) void submitLauncher(false);
  }
}
```

Replace lines 723-735 (`GET /projects/:id/branches` answers `project not bound` without a binding, so do not ask):

```ts
async function loadLaunchBranches(preferred: string | undefined): Promise<void> {
  const projectId = store.selectedProjectId;
  launchBranches.value = [];
  draftBaseBranch.value = preferred ?? selectedProject.value?.defaultBranch ?? '';
  if (!projectId || !isBound.value) return;
  try {
    const info = await store.listBranches(projectId);
    launchBranches.value = info.branches;
    if (!draftBaseBranch.value) draftBaseBranch.value = info.default ?? info.current ?? '';
  } catch {
    // Non-fatal: the picker degrades to the preferred/default value only.
  }
}
```

Replace lines 815-817 (the launch path refuses without a binding even if a stale DOM state got past the disabled button):

```ts
async function submitLauncher(asTask: boolean): Promise<void> {
  const projectId = store.selectedProjectId;
  if (!projectId || !canLaunch.value) return;
  // Saving to the backlog is allowed unbound; starting an agent is not, and the api would
  // refuse it with `project not bound` anyway.
  if (!asTask && !isBound.value) {
    launcherError.value = BIND_HINT;
    return;
  }
```

Replace lines 838-840:

```ts
      session = await store.createSession(
        projectId, draft.name, draft.task, model, images, draft.worktree, draft.prefix, asTask, draft.platform, draft.baseBranch,
      );
```

Replace lines 866-870 (`createChat` goes through `boundProject`, `supervisor.service.ts:289`):

```ts
async function onNewChat(): Promise<void> {
  const projectId = store.selectedProjectId;
  if (!projectId || !isBound.value) return;
  try {
    const chat = await store.createChat(projectId);
```

- [ ] **Step 8: Verify the whole UI typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: **no output, exit 0.** This is the gate Task 1 deliberately broke: `packages/core`, `apps/api` and `apps/ui` now all compile against `Project`/`projectId`.

- [ ] **Step 9: Smoke the binding against a real stack**

With `pnpm dev:api` + `pnpm dev:ui` running and signed in, on a project with no binding:

1. «Швидкий чат» is greyed out and its tooltip reads «Прив’яжіть локальну теку репозиторію»; «Нова задача» still opens, its footer shows the same hint, «Запустити» is greyed out and «В беклог» is not. Save a task to the backlog → it appears under «Задачі» with a greyed-out `▶`.
2. `$` (env) is greyed out with the same tooltip; `⚙` (settings) still opens, and its «Гілка за замовчуванням» select is disabled.
3. Press «Прив’язати теку», navigate to a directory that is NOT a git repo, press «Обрати цю теку» → error toast «Обрана тека не є git-репозиторієм — виберіть корінь репозиторію (той, що містить .git)», and the rail tile stays dashed.
4. Press «Прив’язати теку» again, pick a real repo → toast «Проєкт прив’язано до /…», the tile's dashed frame and `○` disappear, the header shows the path, and every control from steps 1-2 becomes live. The button now reads «Змінити теку».
5. `sqlite3 ~/.kermanych/kermanych.sqlite "select name, local_repo_path from projects"` shows the path.
6. Launch a task → it runs (this is the same launch path as before the plan; the binding is the only thing that changed).

- [ ] **Step 10: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue apps/ui/src/pages/WorkspacePage.vue apps/ui/src/components/kit/KDirPicker.vue
git commit -m "feat(ui): manual per-machine repo binding and unbound-project guards"
```

---

### Task 13: members panel in the project settings (owner-only writes)

**Files:**
- Modify: `apps/ui/src/layouts/MainLayout.vue` — the file as Tasks 11-12 left it; anchors are the `<!-- PROJECT-SETTINGS MODAL … -->` block, the `openSettings()` function and the `<style scoped>` block.

**Interfaces:**
- Consumes: `useProjects()` — `members: Record<string, ProjectMember[]>`, `loadMembers(id)`, `addMember(id, githubUsername)`, `removeMember(id, userId)`, `isOwner(id)` (Task 10); `ProjectMember` and `Profile` from `@kermanych/cloud` (Plan A's types); `store.notify` (Task 9); `KTag` (`KTag.vue`, existing).
- Produces: in `MainLayout.vue` — `members`, `membersLoading`, `canManageMembers`, `memberHandle`, `memberBusy`, `memberErrorText(e)`, `submitMember()`, `removeMemberOf(m)`.

Requirement 2: owners manage membership. `isOwner()` is a UX gate only — the real gate is RLS. `members_insert_owner`, `members_update_owner` and `members_delete_owner` (`supabase/migrations/20260821090200_team_cloud_rls.sql:65-84`) each require an owner row in `project_members`, so a non-owner's write is refused by Postgres whatever this component renders. The two shapes that refusal takes are different and both must be handled:

| Failure | What the client sees | Ukrainian toast |
|---|---|---|
| the handle has no `profiles` row (never signed in) | `Error: no Kermanych profile for @<handle> — ask them to sign in with GitHub first` — thrown by `addMember` itself (`packages/cloud/src/projects.ts:158`) | «Немає профілю з таким GitHub-логіном — попросіть колегу спершу увійти в Керманич через GitHub» |
| non-owner INSERT | postgrest error whose message contains `violates row-level security policy` | «Хмара відмовила: керувати складом учасників може лише власник проєкту» |
| the person is already a member | postgrest error containing `duplicate key value` (`project_members_pkey`) | «Цей користувач уже в проєкті» |
| non-owner DELETE | **no error at all** — a DELETE the policy refuses simply matches zero rows, and `removeMember` has already filtered the local list optimistically | re-read the list; if the member is still there, «Хмара відмовила: керувати складом учасників може лише власник проєкту» |

- [ ] **Step 1: Add the members block to the settings modal**

In the `<!-- PROJECT-SETTINGS MODAL … -->` block, insert this between the read-only «Локальна тека цієї машини» field and the `<p v-if="settingsError" …>` line:

```vue
        <!-- MEMBERS — cloud membership. Writes are owner-only; RLS enforces it, this is UX. -->
        <div class="shell__members">
          <span class="shell__members-label">Учасники</span>
          <div v-if="membersLoading" class="shell__hint mono">Завантаження…</div>
          <div v-for="m in members" :key="m.userId" class="shell__member">
            <img
              v-if="m.profile?.avatarUrl"
              class="shell__member-avatar"
              :src="m.profile.avatarUrl"
              :alt="m.profile.githubUsername ?? ''"
            />
            <span v-else class="shell__member-avatar shell__member-avatar--blank mono">?</span>
            <span class="shell__member-name mono">
              @{{ m.profile?.githubUsername ?? m.userId.slice(0, 8) }}
            </span>
            <KTag>{{ m.role === 'owner' ? 'власник' : 'учасник' }}</KTag>
            <KBtn
              v-if="canManageMembers && m.role !== 'owner'"
              variant="ghost"
              title="Вилучити з проєкту"
              @click="removeMemberOf(m)"
            >✕</KBtn>
          </div>
          <div v-if="canManageMembers" class="shell__member-add">
            <KField
              v-model="memberHandle"
              label="Додати за GitHub-логіном"
              placeholder="octocat"
            />
            <KBtn
              variant="secondary"
              :disabled="memberHandle.trim() === '' || memberBusy"
              @click="submitMember"
            >Додати</KBtn>
          </div>
          <p v-else class="shell__hint">
            Змінювати склад учасників може лише власник проєкту.
          </p>
        </div>
```

- [ ] **Step 2: Add the members state and actions**

In the `<script setup>` block, add `KTag` to the kit imports and the member type to the type imports:

```ts
import type { ProjectMember } from '@kermanych/cloud';
import KTag from 'components/kit/KTag.vue';
```

Then, immediately after the `settingsBranches` ref, add:

```ts
const membersLoading = ref(false);
const memberHandle = ref('');
const memberBusy = ref(false);

// `members` is keyed by project id and may be missing entirely before the first read, so the
// `?? []` is load-bearing (noUncheckedIndexedAccess is on).
const members = computed<ProjectMember[]>(() =>
  store.selectedProjectId ? projects.members[store.selectedProjectId] ?? [] : [],
);

// UX only. The owner-only policies on project_members refuse a non-owner write regardless of
// what this returns — see memberErrorText() for what that refusal looks like.
const canManageMembers = computed(
  () => !!store.selectedProjectId && projects.isOwner(store.selectedProjectId),
);

// The three refusals a membership write really produces. Everything else is shown verbatim.
function memberErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.startsWith('no Kermanych profile for @')) {
    return 'Немає профілю з таким GitHub-логіном — попросіть колегу спершу увійти в Керманич через GitHub';
  }
  if (raw.includes('violates row-level security policy')) {
    return 'Хмара відмовила: керувати складом учасників може лише власник проєкту';
  }
  if (raw.includes('duplicate key value')) {
    return 'Цей користувач уже в проєкті';
  }
  return raw;
}

async function submitMember(): Promise<void> {
  const id = store.selectedProjectId;
  const handle = memberHandle.value.trim();
  if (!id || !handle) return;
  memberBusy.value = true;
  try {
    const added = await projects.addMember(id, handle);
    memberHandle.value = '';
    store.notify(`@${added.profile?.githubUsername ?? handle} додано до проєкту`);
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  } finally {
    memberBusy.value = false;
  }
}

async function removeMemberOf(m: ProjectMember): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  const who = m.profile?.githubUsername ?? m.userId;
  if (!window.confirm(`Вилучити @${who} з проєкту «${selectedName.value}»?`)) return;
  try {
    await projects.removeMember(id, m.userId);
    // A DELETE the owner-only policy refuses does NOT error — it matches zero rows, while the
    // store has already dropped the row locally. Re-read so the panel cannot show a removal
    // that never happened.
    const after = await projects.loadMembers(id);
    if (after.some((x) => x.userId === m.userId)) {
      store.notify('Хмара відмовила: керувати складом учасників може лише власник проєкту', 'error', 6000);
      return;
    }
    store.notify(`@${who} вилучено з проєкту`);
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  }
}
```

- [ ] **Step 3: Load the members when the settings modal opens**

In `openSettings()`, replace the tail — the `if (!isBound.value) return;` line and the `try { settingsBranches.value = … }` block Task 11 wrote — with:

```ts
  memberHandle.value = '';
  membersLoading.value = true;
  try {
    await projects.loadMembers(id);
  } catch (e) {
    // Non-fatal: the panel stays empty and says why. Config editing still works.
    store.notify(`Не вдалось прочитати учасників: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    membersLoading.value = false;
  }
  // GET /projects/:id/branches answers `project not bound` without a binding, so do not ask.
  if (!isBound.value) return;
  try {
    settingsBranches.value = (await store.listBranches(id)).branches;
  } catch {
    // Non-fatal: the picker degrades to the value already selected.
  }
```

- [ ] **Step 4: Style the panel**

Add to the `<style scoped lang="scss">` block, after `.shell__hint`:

```scss
.shell__members {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--k-line);
}

.shell__members-label {
  text-align: left;
  font-size: 13px;
  color: var(--k-text);
}

.shell__member {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shell__member-avatar {
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid var(--k-line);
  border-radius: 0; // no circles anywhere in this system
  object-fit: cover;
}

.shell__member-avatar--blank {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--k-muted);
  background: var(--k-surface2);
}

.shell__member-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--k-text);
}

.shell__member-add {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
```

- [ ] **Step 5: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no output, exit 0. If `projects.members[...]` errors with "possibly undefined", the `?? []` in the `members` computed was dropped — put it back rather than turning off `noUncheckedIndexedAccess`.

- [ ] **Step 6: Smoke the panel with two accounts**

You need two profiles in the local Supabase. Both flows are covered in Task 16 Steps 5-6; the shortest path here is the throwaway-user recipe from Plan A (Task 10 Step 4): create `alice@kermanych.test` and `bob@kermanych.test` through the admin API with `user_metadata.user_name` set to `alice` / `bob`, so `handle_new_user` fills `profiles.github_username`.

As alice (the owner of a project):

1. Open `⚙` → the «Учасники» block lists exactly one row, `@alice`, tagged «власник», with no `✕` (an owner cannot remove themselves here).
2. Type `bob`, press «Додати» → the row `@bob` / «учасник» appears with a `✕`, toast «@bob додано до проєкту».
3. Press «Додати» with `bob` again → error toast «Цей користувач уже в проєкті».
4. Type `nosuchuser`, «Додати» → error toast «Немає профілю з таким GitHub-логіном — попросіть колегу спершу увійти в Керманич через GitHub».
5. Press `✕` on `@bob`, confirm → toast «@bob вилучено з проєкту» and the row goes.

As bob (a member of a project alice owns), signed in on the second machine or a second browser profile:

6. Open `⚙` → the same two rows render, there is no «Додати за GitHub-логіном» field and no `✕`; instead: «Змінювати склад учасників може лише власник проєкту.»
7. Prove RLS is the real gate, not the hidden button — in bob's devtools console:

```js
const { useProjects } = await import('/src/stores/projects.ts');
await useProjects().addMember('<project id>', 'alice').catch((e) => e.message);
```
Expected: a rejected promise whose message contains `violates row-level security policy for table "project_members"`. Doing the same through `removeMember` resolves but changes nothing — re-open `⚙` and both rows are still there, which is exactly the silent-refusal path Step 2 re-reads for.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue
git commit -m "feat(ui): project members panel with owner-only membership writes"
```

---

### Task 14: project settings write to the CLOUD; env stays on this machine

**Files:**
- Modify: `apps/ui/src/layouts/MainLayout.vue` — the file as Tasks 11-13 left it; anchors are the `<!-- PROJECT-SETTINGS MODAL … -->` and `<!-- ENV MODAL … -->` blocks, `saveSettings()`, `openEnv()`, `saveEnv()`, `canManageMembers` and the `<style scoped>` block.
- Modify: `apps/ui/src/pages/WorkspacePage.vue` — `submitPreviewConfig()` (the `store.patchProject(s.projectId, patch)` line Task 12 Step 6 wrote) plus the store import next to `useOrchestrator`.

**Interfaces:**
- Consumes: `useProjects().patch(id, patch)` and `isOwner(id)` (Task 10); `CloudProjectPatch` — `Partial<Pick<CloudProject, 'name' | 'gitRemoteUrl' | 'conventions' | 'previewCommand' | 'apiCommand' | 'defaultBranch' | 'carryFiles' | 'envKeys' | 'color'>>` (`packages/cloud/src/projects.ts:45-50`, Task 7); `CloudProject.envKeys: string[]` (Plan A's types); `store.getEnv`/`store.saveEnv` (Task 9); `selectedCloud`, `isBound`, `envView`, `envEditor`, `carryFilesText` (Task 11).
- Produces: in `MainLayout.vue` — `isOwnerOfSelected` (the single owner predicate, renamed from Task 13's `canManageMembers`), `parseList(text)`, `previewCommandEdit`, `apiCommandEdit`, `envKeysText`, `envKeyState`, `missingEnvKeys`.
- Declared removals: `store.patchProject` has no caller left in `apps/ui` after this task. It stays on the store (Task 9) because the binding route is the only local project write the UI still makes — but every CONFIG write now goes to the cloud, which then mirrors itself into the local row.

Why config cannot stay local: `registry.upsertProject` overwrites `preview_command`, `api_command`, `carry_files`, `default_branch`, `conventions`, `color` and `name` from the cloud row on every sync (`registry.service.ts:182-190` — only `local_repo_path` is protected by the `CASE`). A local-only config edit therefore survives exactly until the next `projects.load()`. Cloud-first, mirror-after is the only consistent order (design D1).

The consequence to accept, not paper over: `projects_update_owner` (`supabase/migrations/20260821090200_team_cloud_rls.sql:51-55`) makes ALL project config owner-only, preview commands included. A non-owner's `patchProject` sends `update … eq(id) … select().single()`, which matches zero rows under RLS, so postgrest answers with a "no rows returned" error rather than a policy message. That is unreadable copy, so the UI gates on `isOwnerOfSelected` first and says plainly who may edit; the raw message is only ever appended when a write we believed was allowed still failed.

- [ ] **Step 1: Unify the owner predicate and add the list parser**

Rename Task 13's `canManageMembers` to `isOwnerOfSelected` — membership, config and env-key names are all owner-only, and one predicate cannot be allowed to drift into two names:

```ts
// UX only. Every owner-only path (membership, project config, env-key names) is enforced by
// the owner-scoped RLS policies; this just keeps the UI from offering a write that Postgres
// will refuse.
const isOwnerOfSelected = computed(
  () => !!store.selectedProjectId && projects.isOwner(store.selectedProjectId),
);
```

Update its two uses in the members block (`v-if="canManageMembers && m.role !== 'owner'"` → `v-if="isOwnerOfSelected && m.role !== 'owner'"`, and `v-if="canManageMembers"` → `v-if="isOwnerOfSelected"` on the add row, with the `v-else` hint unchanged).

Add the parser next to it — three fields now take «через кому або з нового рядка»:

```ts
function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 2: Extend the settings form**

Add these refs next to `conventionsEdit`:

```ts
const previewCommandEdit = ref('');
const apiCommandEdit = ref('');
```

In the `<!-- PROJECT-SETTINGS MODAL … -->` block, insert after the «Конвенції PR/комітів» field and before the read-only «Локальна тека цієї машини» field:

```vue
        <KField
          v-model="previewCommandEdit"
          label="Команда превʼю (веб)"
          placeholder="pnpm dev --port $PORT"
          :disabled="!isOwnerOfSelected"
        />
        <KField
          v-model="apiCommandEdit"
          label="Команда превʼю (API, необовʼязково)"
          placeholder="pnpm dev:api"
          :disabled="!isOwnerOfSelected"
        />
        <KField
          v-model="carryFilesText"
          label="Файли для сесії (через кому або з нового рядка)"
          placeholder=".env"
          :disabled="!isOwnerOfSelected"
        />
        <p v-if="!isOwnerOfSelected" class="shell__hint">
          Налаштування проєкту спільні для команди — змінювати їх може лише власник.
        </p>
```

Then close the other four controls to a non-owner. Add `:disabled="!isOwnerOfSelected"` to the `nameEdit` and `conventionsEdit` `KField`s and to the modal's «Зберегти» button; the branch `KSelect` already carries `:disabled="!isBound"` from Task 11 and needs both reasons, so it becomes:

```vue
          :disabled="!isBound || !isOwnerOfSelected"
```

`KColorPicker` has no `disabled` prop at all (`KColorPicker.vue:38`), so grey the whole swatch row instead:

```vue
        <KColorPicker
          v-model="colorEdit"
          label="Колір проєкту"
          :class="{ 'shell__readonly': !isOwnerOfSelected }"
        />
```

with

```scss
// A non-owner sees the value, cannot change it, and gets the same greyed-out signal as a
// disabled KField (which is why the opacity matches KField's :disabled rule).
.shell__readonly {
  opacity: 0.45;
  pointer-events: none;
}
```

- [ ] **Step 3: Seed the new fields and carry files from the cloud project**

In `openSettings()`, after the `conventionsEdit.value = …` line, add:

```ts
  previewCommandEdit.value = cloud?.previewCommand ?? row?.previewCommand ?? '';
  apiCommandEdit.value = cloud?.apiCommand ?? row?.apiCommand ?? '';
  carryFilesText.value = (cloud?.carryFiles ?? row?.carryFiles ?? ['.env']).join('\n');
```

- [ ] **Step 4: Point `saveSettings()` at the cloud**

Replace the whole `saveSettings()` function Task 11 wrote:

```ts
async function saveSettings(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  settingsError.value = null;
  const name = nameEdit.value.trim();
  if (!name) {
    settingsError.value = 'Назва проєкту не може бути порожньою';
    return;
  }
  if (!isOwnerOfSelected.value) {
    settingsError.value = 'Змінювати налаштування проєкту може лише власник';
    return;
  }
  const carryFiles = parseList(carryFilesText.value);
  try {
    // CLOUD first (design D1: it is the source of truth for config), and patch() then mirrors
    // the returned row into the local registry via api.syncProjects([updated], false) — so the
    // offline cache the launch path reads matches what the team sees. Empty strings are turned
    // into NULLs by toProjectRow(), which is how a field gets cleared.
    await projects.patch(id, {
      name,
      color: colorEdit.value,
      defaultBranch: defaultBranchEdit.value,
      conventions: conventionsEdit.value,
      previewCommand: previewCommandEdit.value,
      apiCommand: apiCommandEdit.value,
      // Never store an empty carry list: the launch path would copy nothing into the worktree.
      carryFiles: carryFiles.length ? carryFiles : ['.env'],
    });
    settingsOpen.value = false;
  } catch (e) {
    // We believed this write was allowed, so the raw message is the useful part: an expired
    // session, an unreachable cloud, or ownership that changed under us.
    settingsError.value = `Хмара відмовила у записі: ${e instanceof Error ? e.message : String(e)}`;
  }
}
```

- [ ] **Step 5: Add the env-keys checklist to the env modal**

Add next to the other env refs:

```ts
const envKeysText = ref('');

// Requirement 9: the cloud holds key NAMES only. This is the checklist — which required names
// the BOUND repo's .env actually carries a value for. It reflects the file as loaded, so save
// and reopen to re-check after editing.
const envKeyState = computed(() => {
  const present = new Set(envView.value.entries.map((e) => e.key));
  return (selectedCloud.value?.envKeys ?? []).map((key) => ({ key, present: present.has(key) }));
});

const missingEnvKeys = computed(() =>
  envKeyState.value.filter((k) => !k.present).map((k) => k.key),
);
```

In the `<!-- ENV MODAL … -->` block, DELETE the «Файли для сесії …» `KField` (it moved to the settings modal in Step 2) and put this in its place:

```vue
        <div v-if="envKeyState.length" class="shell__keys">
          <span class="shell__keys-label">Обовʼязкові ключі (перелік імен із хмари)</span>
          <div class="shell__keys-list">
            <KTag v-for="k in envKeyState" :key="k.key">
              {{ k.present ? '✓' : '✕' }} {{ k.key }}
            </KTag>
          </div>
          <p v-if="missingEnvKeys.length" class="shell__error" role="alert">
            Немає значень для: {{ missingEnvKeys.join(', ') }}
          </p>
        </div>
        <KField
          v-if="isOwnerOfSelected"
          v-model="envKeysText"
          label="Обовʼязкові ключі — лише ІМЕНА (через кому або з нового рядка)"
          placeholder="GITHUB_TOKEN, DATABASE_URL"
          multiline
          :rows="3"
        />
        <p class="shell__hint">
          У хмарі зберігаються лише імена ключів. Значення живуть у `.env` цієї машини й нікуди
          не передаються.
        </p>
```

- [ ] **Step 6: Rewrite `openEnv()` and `saveEnv()`**

Replace both functions Task 11 wrote:

```ts
// Env modal: the BOUND repo's .env (values never leave this machine) plus the cloud's
// names-only checklist.
async function openEnv(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  envError.value = null;
  envKeysText.value = (selectedCloud.value?.envKeys ?? []).join('\n');
  envView.value = { entries: [], ignored: true };
  envOpen.value = true;
  try {
    envView.value = await store.getEnv(id);
  } catch (e) {
    envError.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveEnv(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  envError.value = null;
  try {
    // VALUES: local file only, through the api's path-confined atomic writer.
    const edits = envEditor.value?.collect();
    if (edits && (Object.keys(edits.set).length || edits.remove.length)) {
      await store.saveEnv(id, edits);
    }
    // NAMES: the cloud checklist, owner-only. Sent only when the owner actually changed it, so
    // a member saving values never attempts a project write it cannot make.
    if (isOwnerOfSelected.value) {
      const next = parseList(envKeysText.value);
      const current = selectedCloud.value?.envKeys ?? [];
      if (next.join('\n') !== current.join('\n')) await projects.patch(id, { envKeys: next });
    }
    envOpen.value = false;
  } catch (e) {
    envError.value = e instanceof Error ? e.message : String(e);
  }
}
```

- [ ] **Step 7: Style the checklist**

Add to the `<style scoped lang="scss">` block:

```scss
.shell__keys {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shell__keys-label {
  text-align: left;
  font-size: 13px;
  color: var(--k-text);
}

.shell__keys-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
```

- [ ] **Step 8: Send the preview config to the cloud too**

`submitPreviewConfig()` in `WorkspacePage.vue` writes `previewCommand`/`apiCommand`, which are cloud config. Add the store import next to `useOrchestrator`:

```ts
import { useProjects } from 'stores/projects';
```

and next to `const store = useOrchestrator();` (line 482):

```ts
const projects = useProjects();
```

Then replace the `store.patchProject(s.projectId, patch)` line Task 12 Step 6 wrote with:

```ts
    await projects.patch(s.projectId, patch);
```

`patch` is already typed `{ previewCommand: string; apiCommand?: string }`, which is a valid `CloudProjectPatch`. A non-owner's attempt lands in the existing `catch`, which already alerts `Не вдалось зберегти: <message>` and closes the preview window — the honest outcome, since only the owner may set a shared project's commands.

- [ ] **Step 9: Verify it typechecks**

Run: `pnpm --filter @kermanych/ui exec vue-tsc --noEmit`
Expected: no output, exit 0. If `projects.patch(...)` complains about `carryFiles`, the argument is `string[]` and `CloudProjectPatch.carryFiles` is `string[]` — check you passed `carryFiles.length ? carryFiles : ['.env']` and not the raw `parseList` result typed as `string[] | undefined`.

- [ ] **Step 10: Smoke the round trip**

With `pnpm dev:api` + `pnpm dev:ui` running, as the OWNER of a bound project:

1. `⚙` → change the name, pick a colour, set «Команда превʼю (веб)» to `pnpm dev`, set «Файли для сесії» to `.env` and `.env.local`, «Зберегти».
2. `sqlite3 ~/.kermanych/kermanych.sqlite "select name, color, preview_command, carry_files from projects"` → all four values are there (the local mirror `patch()` wrote).
3. Reload the page → the values survive, now having come back from the cloud through `projects.load()`.
4. `⚙` → «Обовʼязкові ключі» in the env modal: type `GITHUB_TOKEN` and `DATABASE_URL`, «Зберегти». Reopen `$` → the checklist shows `✕ GITHUB_TOKEN` and `✕ DATABASE_URL` plus «Немає значень для: GITHUB_TOKEN, DATABASE_URL».
5. Add `GITHUB_TOKEN=abc` in the editor, «Зберегти», reopen `$` → `✓ GITHUB_TOKEN`, `✕ DATABASE_URL`, and the warning lists only `DATABASE_URL`.
6. `grep -c GITHUB_TOKEN <bound repo>/.env` → 1, and in Supabase Studio `select env_keys from projects` → `{GITHUB_TOKEN,DATABASE_URL}` with **no values anywhere** (Requirement 9).

As a MEMBER of that project (second account):

7. `⚙` → every config field is greyed out, «Зберегти» is disabled, and the hint reads «Налаштування проєкту спільні для команди — змінювати їх може лише власник.»
8. `$` → the `.env` editor is fully usable (their own machine, their own file) and the checklist renders, but there is no env-keys field.

- [ ] **Step 11: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): project config lives in the cloud, env values stay on the machine"
```

---

### Task 15: deleting a cloud project

**Files:**
- Modify: `packages/cloud/src/projects.ts:168-171` (append after `removeMember`)
- Modify: `packages/cloud/test/projects.spec.ts:3-10` (import list) and append after `:179`
- Modify: `apps/ui/src/stores/projects.ts` — the file Task 10 created; anchors are its import list, the `removeMember` function and the returned object
- Modify: `apps/ui/src/layouts/MainLayout.vue` — the file as Tasks 11-14 left it; anchors are the settings modal's `#controls` slot, the `<!-- ENV MODAL … -->` block (the new modal goes before it) and the script's create/settings state

**Interfaces:**
- Consumes: `SupabaseClient` (Plan A); `auth.client` and the existing `load()` inside `useProjects` (Task 10); `isOwnerOfSelected`, `selectedName`, `store.notify` (Tasks 11-14).
- Produces: `deleteProject(client, id): Promise<void>` exported from `@kermanych/cloud`; `useProjects().remove(id): Promise<void>`; `MainLayout.vue`'s `deleteOpen`, `deleteError`, `deleteBusy`, `openDelete()`, `confirmDelete()`.

Why this task exists at all: the spec's RLS matrix grants `projects` DELETE to the owner (`projects_delete_owner`, `supabase/migrations/20260821090200_team_cloud_rls.sql:56-58`), and the pre-plan UI had a «Видалити проєкт» button wired to the now-deleted `api.deleteGroup`. There is deliberately still **no** `DELETE /api/projects/:id` — a project dies in the cloud, and each machine's local row follows through the next full sync's prune.

The four outcomes this task must state in the UI, all of them from the schema rather than from hope:

| Fact | Source | Consequence |
|---|---|---|
| `tasks.project_id references projects on delete cascade` | `20260821090000_team_cloud_schema.sql:47` | every board card of the project disappears for every member |
| `project_members.project_id … on delete cascade` | same file, `:37` | memberships go with it |
| prune skips a local row that still owns sessions | `supervisor.service.ts:155-162` | this machine's row survives as «поза хмарою» (the orphan tile from Task 11) and its agents stay usable |
| `projects.owner_id references profiles(id) on delete restrict` | `20260821090000_team_cloud_schema.sql:32` | deleting the ACCOUNT of an owner is refused while it owns projects. That is a different operation, it is not offered anywhere in this UI, and ownership transfer is out of scope (`CloudProjectPatch` deliberately excludes `ownerId`, `packages/cloud/src/projects.ts:43-50`) — delete the projects first. |

And the failure shape: `projects_delete_owner` refuses a non-owner by matching **zero rows, with no error**. `remove()` therefore confirms with a re-read instead of trusting the call, and a refused delete leaves both the cloud and the local registry exactly as they were.

- [ ] **Step 1: Add `deleteProject` to the cloud package**

Append to `packages/cloud/src/projects.ts` (after `removeMember`, line 171):

```ts
// Owner-only by policy (projects_delete_owner). `tasks` and `project_members` cascade, so this
// takes the whole card wall with it for every member; the LOCAL row on each machine disappears
// through the next full sync's prune, unless it still owns sessions. A DELETE the policy refuses
// matches zero rows WITHOUT an error, so callers must confirm with a re-read — see
// `remove()` in apps/ui/src/stores/projects.ts.
export async function deleteProject(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 2: Write the unit test**

Add `deleteProject` to the import list at `packages/cloud/test/projects.spec.ts:3-10`:

```ts
import {
  addMember,
  createProject,
  deleteProject,
  listMembers,
  listProjects,
  patchProject,
  removeMember,
} from "../src/projects";
```

and append this describe block:

```ts
describe("deleteProject", () => {
  it("deletes by id and nothing else", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });

    await deleteProject(client, "p1");

    expect(queries[0]!.table).toBe("projects");
    expect(queries[0]!.ops).toEqual([["delete"], ["eq", "id", "p1"]]);
  });

  it("throws the postgrest message so the UI can toast a refusal", async () => {
    const { client } = fakeClient({ data: null, error: { message: "permission denied for table projects" } });
    await expect(deleteProject(client, "p1")).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 3: Run the cloud suite**

Run: `pnpm --filter @kermanych/cloud exec vitest run test/projects.spec.ts`
Expected: the two new tests pass alongside the existing ones; `deleteProject` records exactly `[["delete"], ["eq", "id", "p1"]]` — an accidental `.select()` or a missing `.eq` would fail here rather than in production, where a missing `.eq` would try to delete every project the policy allows.

- [ ] **Step 4: Add `remove()` to the cloud store**

In `apps/ui/src/stores/projects.ts`, add the import (keeping the list alphabetical, as Task 10 wrote it):

```ts
  createProject as cloudCreateProject,
  deleteProject as cloudDeleteProject,
```

and add this after `removeMember`:

```ts
  // Deleting a project is a CLOUD act — there is no local delete route. The local rows follow
  // through load()'s prune, which never drops a row that still owns sessions.
  async function remove(id: string): Promise<void> {
    await cloudDeleteProject(auth.client, id);
    // projects_delete_owner refuses a non-owner by matching zero rows and never errors, so
    // re-read rather than trust the call. load() is also the drop-and-prune: it replaces
    // `projects` with the cloud truth and mirrors it into the registry with prune=true.
    const after = await load();
    if (after.some((p) => p.id === id)) {
      throw new Error('cloud refused the delete: only the project owner may delete a project');
    }
    const rest = { ...members.value };
    delete rest[id];
    members.value = rest;
  }
```

Add `remove,` to the returned object, immediately after `patch,`.

- [ ] **Step 5: Add the owner-only affordance to `MainLayout.vue`**

Replace the settings modal's `#controls` slot (the one Task 11 wrote, whose «Зберегти» button Task 14 gave `:disabled="!isOwnerOfSelected"`):

```vue
      <template #controls>
        <KBtn
          v-if="isOwnerOfSelected"
          variant="ghost"
          class="shell__danger"
          @click="openDelete"
        >Видалити проєкт</KBtn>
        <KBtn variant="ghost" @click="settingsOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!isOwnerOfSelected" @click="saveSettings">Зберегти</KBtn>
      </template>
```

Insert this modal immediately before the `<!-- ENV MODAL … -->` comment:

```vue
    <!-- DELETE-PROJECT MODAL — owner only. The project dies in the CLOUD; each machine's local
         row follows through the next sync's prune, except where it still owns sessions. -->
    <KModal v-model="deleteOpen" :title="`Видалити проєкт · ${selectedName}`">
      <div class="shell__form">
        <p class="shell__error" role="alert">
          Проєкт «{{ selectedName }}» буде видалено у хмарі для ВСІХ учасників, разом з усіма
          його задачами на дошці. Це не відкотити.
        </p>
        <p class="shell__hint">
          Локальні сесії й робочі дерева на цій машині нікуди не зникнуть: якщо в проєкта є
          сесії, його локальний рядок залишиться як «поза хмарою», і агентів можна довести до
          кінця. Порожній локальний рядок буде прибрано синхронізацією.
        </p>
        <p v-if="deleteError" class="shell__error" role="alert">{{ deleteError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="deleteOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="deleteBusy" @click="confirmDelete">Видалити</KBtn>
      </template>
    </KModal>
```

- [ ] **Step 6: Add the delete state and action**

In the `<script setup>` block, after the settings refs:

```ts
const deleteOpen = ref(false);
const deleteError = ref<string | null>(null);
const deleteBusy = ref(false);

function openDelete(): void {
  deleteError.value = null;
  deleteBusy.value = false;
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  deleteError.value = null;
  deleteBusy.value = true;
  try {
    await projects.remove(id);
    deleteOpen.value = false;
    settingsOpen.value = false;
    // The prune emits project_removed over the socket, which clears the selection and the
    // session list; a row that still owns sessions survives instead and its tile turns into
    // the «поза хмарою» state.
    store.notify('Проєкт видалено у хмарі');
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    deleteError.value = raw.startsWith('cloud refused the delete')
      ? 'Хмара відмовила: видалити проєкт може лише власник'
      : raw;
  } finally {
    deleteBusy.value = false;
  }
}
```

No new styles: the destructive statement reuses `.shell__error`, the survival note reuses `.shell__hint`, and the button reuses `.shell__danger` (kept in Task 11 Step 4 for exactly this).

- [ ] **Step 7: Verify**

```bash
pnpm --filter @kermanych/cloud exec vitest run
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```
Expected: the cloud suite is green including the two new tests; `vue-tsc` prints nothing, exit 0.

- [ ] **Step 8: Smoke the deletion**

With `pnpm dev:api` + `pnpm dev:ui`, as the OWNER:

1. Create a throwaway cloud project, bind nothing, `⚙` → «Видалити проєкт» → the modal names the project → «Видалити». The tile disappears, the toast reads «Проєкт видалено у хмарі», and `sqlite3 ~/.kermanych/kermanych.sqlite "select count(*) from projects where id='<id>'"` → `0` (prune removed the empty row).
2. Create a second throwaway project, bind it to a repo, launch one agent, then delete the project the same way. Expected: the tile stays but turns into the orphan state (accent frame, `⚠`, tooltip «… · поза хмарою»), the agent's session is still listed and still answers, and `select name, local_repo_path from projects` still shows the row — prune refuses to cascade into local work. Delete the session, reload → the row and the tile are gone.
3. As a MEMBER (second account) of a project you do not own: `⚙` shows no «Видалити проєкт» button at all. Prove RLS is the gate, in the member's devtools console:

```js
const { useProjects } = await import('/src/stores/projects.ts');
await useProjects().remove('<project id>').catch((e) => e.message);
```
Expected: the string `cloud refused the delete: only the project owner may delete a project`, and the project is still in the rail for both accounts — a refused delete changed nothing anywhere.

- [ ] **Step 9: Commit**

```bash
git add packages/cloud/src/projects.ts packages/cloud/test/projects.spec.ts apps/ui/src/stores/projects.ts apps/ui/src/layouts/MainLayout.vue
git commit -m "feat: owner-only cloud project deletion with local rows pruned by sync"
```

---

### Task 16: verification — typecheck, cutover sweep, and the two-account smoke

**Files:**
- Modify: `apps/ui/.env` (local config, not committed — `VITE_API_BASE` is stale)
- No source changes. If a step fails, fix it in the task that owns the file and re-run this one.

**Interfaces:**
- Consumes: everything Tasks 1-15 produced.
- Produces: the evidence that this plan is done. Plan C (board) and Plan D (status sync) start from this state.

- [ ] **Step 1: Fix the stale local api base**

`apps/ui/.env` currently carries `VITE_API_BASE=http://127.0.0.1:4417/api`, left over from a test harness; the api listens on 4317 (`apps/api/src/main.ts:23`, `PORT` or 4317). Either delete the line — `lib/api.ts:16-19` already falls back to `http://localhost:4317/api` — or set it to:

```
VITE_API_BASE=http://127.0.0.1:4317/api
```

Run: `grep -n VITE_ apps/ui/.env`
Expected: `VITE_SUPABASE_URL=http://127.0.0.1:54421`, `VITE_SUPABASE_ANON_KEY=…`, and either no `VITE_API_BASE` or the 4317 one. A 4417 here makes every local call fail with a network error that looks exactly like "the api is down".

- [ ] **Step 2: Typecheck every package**

```bash
cd kermanych
pnpm --filter @kermanych/core exec tsc -p tsconfig.json --noEmit
pnpm --filter @kermanych/cloud exec tsc -p tsconfig.json --noEmit
pnpm --filter @kermanych/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```
Expected: four silent commands, exit 0 each. This is the gate Task 1 deliberately broke.

- [ ] **Step 3: Prove the cutover left nothing behind**

```bash
cd kermanych
grep -rniE 'group|projectdir|project_dir' apps/ui/src apps/ui/test apps/ui/src-electron
```
Expected: **exactly one** match —

```
apps/ui/src/components/kit/KPanel.vue:74:    <div v-if="userMsgCount > 1" class="k-panel__nav" role="group" aria-label="Навігація по моїх повідомленнях">
```

`role="group"` is the WAI-ARIA role name, not our identifier; it stays. Note the pattern deliberately has **no** `\b` anchors: `\bgroup\b` would not match `selectedGroupId` or `railGroups` (no word boundary inside camelCase), so an anchored grep would pass while the identifiers were still there.

Then the two places where the old names legitimately survive outside `apps/ui`:

```bash
grep -rniE 'group|project_dir' apps/api/src packages/core/src packages/cloud/src
```
Expected: exactly ten matches in two files, all of them correct —
- `apps/api/src/registry/registry.service.ts:133-136` (the `migrateToV1` doc comment) and `:142-146` (the three `ALTER TABLE … RENAME` statements) — the v0→v1 migration must name `groups`, `project_dir` and `sessions.group_id`, because those are precisely the things it renames; a migration that stopped mentioning the old names would have stopped migrating;
- `apps/api/src/preview/preview.service.ts:84` and `:196` — "process group" comments about `process.kill(-pid)`, an unrelated meaning of the word.

`packages/core/src` and `packages/cloud/src` contribute zero matches.

(`apps/api/test/registry.migration.spec.ts` also builds a v0 schema on purpose; that is the point of the test.)

- [ ] **Step 4: Run every automated suite**

```bash
cd kermanych
export SUPABASE_TEST_URL=http://127.0.0.1:54421
export SUPABASE_TEST_ANON_KEY="<anon key from supabase status>"
export SUPABASE_TEST_SERVICE_KEY="<service_role key from supabase status>"
supabase db reset
pnpm --filter @kermanych/core exec vitest run
pnpm --filter @kermanych/cloud exec vitest run
pnpm --filter @kermanych/api exec vitest run
```
Expected: core unchanged and green; cloud green including `projects.spec.ts` (mapping, patch, membership, and the two `deleteProject` tests from Task 15) and the RLS integration spec; api green including `registry.migration.spec.ts` and `supervisor.project.spec.ts`. `apps/ui` has no vitest config and no component harness — its verification is Steps 2, 3, 6 and 7.

- [ ] **Step 5: Seed two accounts without GitHub**

`kermanych/.env` holds `GITHUB_CLIENT_ID=local-dev-placeholder` / `GITHUB_SECRET=local-dev-placeholder`, so the real OAuth round trip cannot run until someone pastes credentials from a GitHub OAuth App whose "Authorization callback URL" is exactly `http://127.0.0.1:54421/auth/v1/callback`. Everything this plan added is reachable without them, because `[auth.email] enable_signup = true` and `enable_confirmations = false` (`supabase/config.toml`), so two password users can stand in for two GitHub identities:

```bash
export SUPABASE_URL=http://127.0.0.1:54421
export SUPABASE_ANON_KEY="<anon key from supabase status>"
SERVICE="<service_role key from supabase status>"

for u in alice bob; do
  curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
    -H "apikey: $SERVICE" -H "authorization: Bearer $SERVICE" -H 'content-type: application/json' \
    -d "{\"email\":\"$u@kermanych.test\",\"password\":\"kermanych-test-password\",\"email_confirm\":true,\"user_metadata\":{\"user_name\":\"$u\"}}" \
    > /dev/null
done
```

Expected: `select github_username from profiles order by github_username;` in Supabase Studio returns `alice` and `bob` — `handle_new_user` reads `raw_user_meta_data ->> 'user_name'`, which is the same key GitHub fills, so membership-by-handle works exactly as it will in production.

Sign either account in from the app's devtools console (the renderer holds the one Supabase client; Vite serves the store as a module, so this is the same instance the app uses, not a second client):

```js
const { useAuth } = await import('/src/stores/auth.ts');
await useAuth().client.auth.signInWithPassword({
  email: 'alice@kermanych.test',
  password: 'kermanych-test-password',
});
```
Expected: the app leaves `/login` on its own (`router/index.ts` watches `auth.user`), and the header shows the shell.

- [ ] **Step 6: Stand up two machines on one host**

Machine A is the default pair. Machine B needs its own registry and its own origin (a separate origin is also what gives it a separate `localStorage`, hence a separate session):

```bash
# terminal 1 — machine A api (registry ~/.kermanych/kermanych.sqlite, port 4317)
cd kermanych && pnpm dev:api
# terminal 2 — machine A ui (http://localhost:5317)
cd kermanych && pnpm dev:ui
# terminal 3 — machine B api: its OWN sqlite file and port
cd kermanych && KERMANYCH_DB=/tmp/kermanych-bob.sqlite PORT=4318 pnpm dev:api
# terminal 4 — machine B ui (http://localhost:5318), pointed at machine B's api
cd kermanych && PORT=5318 VITE_API_BASE=http://127.0.0.1:4318/api pnpm dev:ui
```

Expected: `Kermanych API on http://127.0.0.1:4317` and `…:4318`, two dev servers. Sign in as `alice` on 5317 and as `bob` on 5318, using Step 5's console snippet in each. (Only the injected session works on 5318: `additional_redirect_urls` in `supabase/config.toml` allows `http://localhost:5317/**` and the Electron loopback, not 5318. Do not widen it just for a smoke.)

Also prepare two DIFFERENT checkouts of the same repo, e.g. `/tmp/smoke-a` and `/tmp/smoke-b` (`git clone` the same repo twice, or `git init` two throwaway repos).

- [ ] **Step 7: The two-account smoke**

As **alice** (5317):

1. `+` → «Новий проєкт у хмарі» → name `demo`, no remote → «Створити». The tile appears dashed, selected; the header reads `demo · не прив’язано`.
2. While still unbound, confirm every local action refuses with the same hint: «Швидкий чат» disabled with tooltip «Прив’яжіть локальну теку репозиторію»; `$` disabled with the same tooltip; «Нова задача» opens, its footer shows the hint, «Запустити» is disabled, «В беклог» is not — save a task called `later`, it lands under «Задачі» with a disabled `▶`. Confirm the api agrees, not just the DOM:
   ```bash
   TOKEN="<alice's access_token — copy from the devtools console: (await useAuth().client.auth.getSession()).data.session.access_token>"
   curl -s -X POST localhost:4317/api/sessions/chat -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"projectId":"<project id>"}'
   ```
   Expected: `{"statusCode":400,"message":"project not bound",…}`.
3. «Прив’язати теку» → pick `/tmp` (not a repo) → error toast «Обрана тека не є git-репозиторієм — виберіть корінь репозиторію (той, що містить .git)». Pick `/tmp/smoke-a` → toast «Проєкт прив’язано до /tmp/smoke-a», the tile goes solid, every control from step 2 comes alive.
4. `⚙` → colour, «Гілка за замовчуванням» = `main`, «Команда превʼю (веб)» = `pnpm dev`, «Файли для сесії» = `.env`, «Зберегти». Then «Учасники» → add `bob` → the `@bob` / «учасник» row appears.
5. `$` → «Обовʼязкові ключі» = `DEMO_TOKEN`, add `DEMO_TOKEN=alice-value` in the editor, «Зберегти». Reopen `$` → `✓ DEMO_TOKEN`.

As **bob** (5318):

6. Reload → the `demo` tile is in the rail, **dashed** (bob has no binding of his own — Requirement 3 is per machine). The header reads `demo · не прив’язано`.
7. `⚙` → name, colour, branch, conventions, preview command and carry files all show alice's values and are all greyed out, «Зберегти» is disabled, the hint reads «Налаштування проєкту спільні для команди — змінювати їх може лише власник.» The «Учасники» block lists `@alice` (власник) and `@bob` (учасник) with no `✕` and no add field.
8. «Прив’язати теку» → `/tmp/smoke-b`. The tile goes solid. `sqlite3 /tmp/kermanych-bob.sqlite "select name, local_repo_path from projects"` → `demo|/tmp/smoke-b`, while `sqlite3 ~/.kermanych/kermanych.sqlite "select name, local_repo_path from projects"` still says `/tmp/smoke-a`. One cloud project, two bindings.
9. `$` → the checklist shows `✕ DEMO_TOKEN` (bob's repo has no `.env` yet — names are shared, values are not). Add `DEMO_TOKEN=bob-value`, «Зберегти». Then:
   ```bash
   cat /tmp/smoke-b/.env   # DEMO_TOKEN=bob-value
   cat /tmp/smoke-a/.env   # DEMO_TOKEN=alice-value — untouched
   ```
   Expected: exactly that. And in Supabase Studio, `select env_keys from projects` → `{DEMO_TOKEN}` with no value anywhere in the database (Requirement 9).
10. «Нова задача» → name `smoke`, task `echo hi`, keep «нова worktree», «Запустити». The agent starts. Then:
    ```bash
    ls /tmp/smoke-b/../  # find the worktree dir printed in the session panel
    cat <worktree path>/.env
    ```
    Expected: `DEMO_TOKEN=bob-value` — the carry-files list from the CLOUD config, applied to BOB's `.env`, in bob's worktree.
11. Back on alice's window: the rail still shows one tile, alice's own sessions only. Nothing of bob's execution crossed over (that is Plan D's job, and it is deliberately absent here).

- [ ] **Step 8: What still needs real GitHub credentials**

State this in the PR description rather than pretending the smoke was complete:

- **Covered by Step 7 with injected sessions:** cloud project creation and ownership, membership by handle (`profiles.github_username` is filled from the same metadata key GitHub uses), RLS owner/member behaviour, per-machine binding and every unbound refusal, cloud config + local env split, the env-keys checklist, carry files into a worktree, project deletion (Task 15 Step 8).
- **Needs the real OAuth app** (`kermanych/.env` holds `local-dev-placeholder` today, and `supabase/config.toml:343-351` expects a GitHub OAuth App with callback `http://127.0.0.1:54421/auth/v1/callback`): the sign-in flow itself in the browser, the Electron loopback exchange on `http://127.0.0.1:53170/callback`, and real avatars/display names in the members panel (a password user has `avatar_url` null, so the panel renders its `?` placeholder — which is itself worth seeing once).
- Requirement 1 and both OAuth paths are **Plan A's** verification (its Task 16), not this plan's. This plan must not re-litigate them; it must only avoid breaking them, which Step 2 and Step 7's sign-in prove.

- [ ] **Step 9: Clean up the smoke artifacts**

```bash
cd kermanych && supabase db reset
rm -f /tmp/kermanych-bob.sqlite
rm -rf /tmp/smoke-a /tmp/smoke-b
```
Expected: the throwaway users, profiles and projects are gone and the schema is intact. `~/.kermanych/kermanych.sqlite` keeps whatever local rows you made — delete the `demo` project from the UI first if you want a clean registry, or leave it: after `db reset` it simply has no cloud project, so its tile shows «поза хмарою» if it still owns sessions and is pruned away otherwise. Both are correct behaviour, and seeing it is a free extra check.

- [ ] **Step 10: Nothing to commit**

`apps/ui/.gitignore:6` is `.env*`, so Step 1 edits local config that git never sees (`git check-ignore -v apps/ui/.env` prints the rule). This plan's last commit is Task 15's; this task produces evidence, not a diff.

---

## Self-Review

**1. Spec coverage.** The four spec items this plan owns, each mapped to the tasks that implement it:

- **Requirement 2** (projects are cloud entities with owner/member roles; any authenticated user may create one and becomes owner; owners manage membership and project config) → Task 7 (`createProject` sets `owner_id`, `handle_new_project` adds the owner membership; `listMembers`/`addMember`/`removeMember`), Task 10 (`useProjects.create/patch/loadMembers/addMember/removeMember/isOwner`), Task 11 (the cloud create modal — no local create path survives), Task 13 (the members panel, owner-only writes, all three refusal shapes named), Task 14 (config edits go to the cloud, owner-gated), Task 15 (owner-only deletion, the last piece of the RLS matrix that had a UI affordance). Task 5 is the negative half: `POST /api/projects` and `DELETE /api/projects/:id` do not exist, so a project cannot be born or die locally.
- **Requirement 3** (each machine binds a cloud project to a LOCAL repo path, manual, through the existing directory picker; tasks visible without a binding; launching refused until it exists) → Task 2 (`local_repo_path`, `""` when unbound), Task 3 (`bindProject` + `boundProject`, the two error strings), Task 4 (the launch path reads `localRepoPath` and refuses unbound), Task 5 (`PUT /api/projects/:id/binding`), Task 9 (`setProjectBinding`), Task 11 (the rail's bound/unbound/orphan affordance), Task 12 (the picker wired to the binding, the three refusals mapped to Ukrainian, and every repo-touching control disabled with one hint — while «В беклог» and task editing stay live, which is the "tasks are visible without a binding" half), Task 16 Step 7.2 and 7.8 (the api refuses `project not bound` even when the DOM is bypassed; two machines, two different paths, one project).
- **Requirement 9** (env secret VALUES never reach the cloud; `projects.env_keys` is a NAMES-only checklist) → Task 4 (`EnvFileService` keyed on the bound repo path), Task 5 (`GET|PUT /api/projects/:id/env`, refused without a binding), Task 7 (`env_keys` is `string[]` on `CloudProject` with the comment that says so, and `toProjectRow` only ever sends names), Task 14 (the checklist rendered from `CloudProject.envKeys`, the owner-only names editor, and the standing note in the modal), Task 16 Step 7.9 (`alice-value` and `bob-value` in two different files, `env_keys` in Postgres holding a name and no value).
- **Deviation D1** (no `project_bindings` table; the local `projects` row IS the binding plus an offline config cache; cloud is the source of truth for config and the local row is refreshed on every successful cloud read) → Task 2 (the v0→v1 migration and `upsertProject`'s `CASE` that protects `local_repo_path`), Task 3 (`syncProjects`, prune that never cascades into local sessions), Task 10 (`load()` mirrors with `prune=true`, `create`/`patch` mirror the single row with `prune=false`), Task 11 (mount order: socket, `auth.ready`, `load()`; and the rail's honesty about a cloud read that has not succeeded yet), Task 14 (cloud-first, mirror-after, with the reason spelled out: `upsertProject` overwrites every config column, so a local-only config edit cannot survive a sync).

Task-by-task, so nothing is orphaned: **1** shared types · **2** registry migration + local project surface · **3** supervisor project/bind/sync · **4** launch path + preview/seed/env sweep · **5** `/api/projects` · **6** api suite green · **7** `@kermanych/cloud` projects + membership · **8** ui api client · **9** ui orchestrator store · **10** ui cloud store · **11** rail + cloud create · **12** binding + unbound guards · **13** members panel · **14** cloud config + local env + env-keys checklist · **15** cloud deletion · **16** verification.

Two forward references in the front matter were written before the UI half was decomposed and now resolve one task later: the Global Constraints say "Task 14 verifies" the zero-`Group` sweep and Task 1 says "repaired by Tasks 2-6 (api) and 8-14 (ui)". The sweep gate is **Task 16 Step 3**, and the UI repair spans **Tasks 8-15**. Nothing else in Tasks 1-10 needs amending.

**2. Placeholder scan.** Clean. Every code step carries the literal content to type — three whole files (`KRailItem.vue`, and `MainLayout.vue`'s template and script), and named-function replacements everywhere else. No step says "add error handling": each failure path names the exact string the code produces and the exact Ukrainian copy that answers it —

- binding: `local repo path cannot be empty`, `local repo path is not a git repo`, `project not found` (Task 12, table + `BIND_ERRORS`);
- membership: `no Kermanych profile for @<handle> — ask them to sign in with GitHub first`, `violates row-level security policy`, `duplicate key value`, and the silent zero-row DELETE (Task 13, table + `memberErrorText` + the re-read);
- config: the owner gate first, because a non-owner UPDATE matches zero rows and postgrest reports "no rows", not a policy name (Task 14);
- deletion: the same silent zero-row shape, caught by `remove()`'s re-read and surfaced as «Хмара відмовила: видалити проєкт може лише власник» (Task 15);
- mount: a failed cloud read degrades to the local cache with a named toast, and `cloudSynced` keeps the rail from lying about orphans (Task 11).

The angle-bracket values that remain are runtime secrets and per-run values the operator substitutes — `<anon key from supabase status>`, `<service_role key…>`, `<project id>`, `<worktree path>`, `<alice's access_token…>` — never code to be written.

**3. Type consistency.** `RailProject` is declared once (Task 11, exported from `KRailItem.vue` in the same dual-`<script>` shape as `KTableColumn`) and consumed by both call sites, `MainLayout.vue` and `KitGalleryPage.vue`; its `color?: string | undefined` is deliberate — `exactOptionalPropertyTypes` is on in `.quasar/tsconfig.json`, so a plain `color?: string` would reject `c.color ?? row?.color`. `store.patchProject(id, body)` keeps the exact seven-field body of Task 8/9 and Task 5's `PATCH` DTO; `projects.patch(id, patch)` takes `CloudProjectPatch` (Task 7) and every key Task 14 sends — `name`, `color`, `defaultBranch`, `conventions`, `previewCommand`, `apiCommand`, `carryFiles`, `envKeys` — is in that `Pick`. The owner predicate exists once and is named once: Task 13 introduces `canManageMembers`, Task 14 renames it to `isOwnerOfSelected` in the same commit that adds its second and third caller, so no two names for one check survive. `BIND_HINT` is the same literal in `MainLayout.vue` (Task 12 Step 3) and `WorkspacePage.vue` (Task 12 Step 7) — two files, one string, because the copy is an instruction the operator can act on and it must read identically wherever it appears. `members[projectId]` and `projects.members[...]` are always `?? []`-guarded because `noUncheckedIndexedAccess` is on. `deleteProject(client, id)` (Task 15) matches the signature shape of its five siblings in `packages/cloud/src/projects.ts` — client first, `Promise<void>` like `removeMember`.

**4. Deliberately left to Plans C and D.** Declared, not dropped:

- **Requirements 4, 5, 8** — the shared board, task cards, Realtime fan-out, assignment, atomic self-assign, the active-task lock → **Plan C** (`packages/cloud/src/tasks.ts`, `stores/board.ts`, `BoardPage.vue`, and the `export * from "./tasks"` line appended to `packages/cloud/src/index.ts`). This plan's Task 10 decomposition note is the seam: `useProjects()` owns projects and membership, `useBoard()` will own tasks and Realtime and read the project list from here. `Session.taskId` (Task 1) is the field Plan C's launcher fills.
- **Requirements 6, 7 (the push half)** — status flowing local → cloud, `status_outbox`, `CloudSyncService`, `POST /api/sessions/from-task` → **Plan D**. The offline half of Requirement 7 is this plan's and is done: the local row caches everything `launch()` reads, and nothing on the launch path calls Supabase.
- `WorkspacePage.vue` keeps rendering LOCAL sessions only (spec D6). Its header link to the cloud board, and showing a task title when `taskId` is set, are Plan C's — Task 12 renames identifiers and adds binding guards there and nothing else.
- Ownership transfer is out of scope by construction: `CloudProjectPatch` excludes `ownerId`, and `projects.owner_id` is `on delete restrict`, so an account that owns projects cannot be deleted until its projects are (Task 15 states this in one line and offers no UI for it).
- Avatars in the members panel are whatever `profiles.avatar_url` holds; there is no upload, no cache, no fallback service — a null renders the `?` placeholder (Task 13).
- The socket.io gateway still has no handshake auth and still broadcasts every local event to every local client — untouched here, exactly as Plan A left it, and harmless while the server is loopback-only.
