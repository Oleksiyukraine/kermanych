# Team cloud: multi-user Kermanych — design

Date: 2026-08-21
Status: approved (design; hybrid model B1 + shared task board)

## Problem

Kermanych is single-user and machine-local. `Group.projectDir`
(`packages/core/src/types.ts:10`) is an absolute local path; one `Session` is one
git worktree under `~/.kermanych/worktrees/<id>` plus one `omp --mode rpc` child
supervised by `SupervisorService` (`apps/api/src/supervisor/supervisor.service.ts`,
1034 LOC); the API binds `127.0.0.1` only (`apps/api/src/main.ts:24`) with no auth
of any kind; all state is in `~/.kermanych/kermanych.sqlite` (2 tables,
`apps/api/src/registry/registry.service.ts`). Nothing is shared between
developers.

The team needs ONE shared board of agent tasks — who works on what, at what
status — while each AI session keeps executing locally on the assignee's machine.

## Approach — hybrid (execution local, coordination cloud)

- **Execution stays local, per developer.** `omp` children, worktrees, git
  operations, transcripts, live turns and interactive prompts never leave the
  assignee's machine.
- **Supabase holds coordination state only**: users, projects, membership, tasks
  (title, description, status, assignee, launch params). A task is a card born in
  the cloud; a session is its local execution.
- **Direction is Task → Session.** A member creates a task on the board and
  assigns it; the assignee's local Kermanych launches worktree + `omp`; coarse
  status flows back to the cloud.
- **Two Supabase clients, both under the user's JWT, no service-role key on any
  machine.** The UI talks to Supabase directly (auth, board CRUD, Realtime) with
  the anon key; the local Nest holds a second client that acts under the user's
  access token, obtained from the UI. RLS is the single authorization surface.
- **Realtime is the board engine.** A status push (from anyone's local Nest) or
  an assignment (from anyone's UI) fans out through Supabase Realtime. No custom
  WebSocket fan-out between machines; the existing socket.io gateway
  (`apps/api/src/ws/events.gateway.ts`) stays strictly local.

```
Supabase: Auth (GitHub OAuth) · Postgres (profiles, projects, project_members,
          tasks) · Realtime · RLS
   ▲ anon key + RLS (auth, board CRUD, realtime)      ▲ user JWT (status push only)
   │                                                  │
 Quasar UI ──── local REST (JWT) ────► local NestJS ──┴── SQLite (sessions,
 (per machine)                         (per machine)      projects, outbox)
                                            │
                                            └── git worktrees + omp children
```

## Requirements

1. GitHub OAuth sign-in (PKCE) in both the browser UI and the Electron desktop
   app; first sign-in provisions `auth.users` and, via trigger, `profiles`.
2. Projects are cloud entities with `owner`/`member` roles. Any authenticated
   user may create a project (becoming owner); owners manage membership and
   project config.
3. Each machine binds a cloud project to a LOCAL repo path (manual, via the
   existing directory picker). Tasks are visible without a binding; launching is
   refused until it exists.
4. The board is shared: create, assign (self or member), describe, carry launch
   params (`model`, `prefix`, `platform`, `kind`, `branch`); Realtime updates
   every member's board live.
5. Only the assignee launches a task's local session; launching an unassigned
   task atomically self-assigns.
6. Status flows local → cloud: only `status` (+ `updated_at`), only on coarse
   changes. Transcripts, `currentTool`, `contextPercent`, `todoPhases` and
   interactive prompts never leave the machine.
7. Local work never blocks on cloud availability. Precisely: a session that
   exists locally keeps running, answering, merging and finishing with Supabase
   unreachable, because the local `projects` row caches everything `launch()`
   reads; status pushes queue in a local outbox and retry. The one cloud-bound
   step is STARTING a board task (read the task, claim it, refresh config) — an
   offline machine cannot claim a shared task, and pretending otherwise would
   let two developers claim the same one.
8. An active task cannot be reassigned or deleted. "Active" is the existing local
   definition, `ACTIVE_STATUSES` in `packages/core/src/status.ts:10`
   (`queued`, `thinking`, `tool`, `waiting_input`); the repo has no
   `isActiveStatus()` helper, callers use `ACTIVE_STATUSES.includes(status)`. The
   cloud-side copy of the list lives in the `tasks_guard` trigger.
9. Env secret VALUES never reach the cloud. `projects.env_keys` stores key NAMES
   only, as a checklist; values stay in the bound repo's `.env` (unchanged from
   the 2026-08-11 per-project-env design).
10. No service-role key on any client machine; every cloud write is under the
    user's JWT + RLS.
11. Local mutating REST endpoints require a valid user token, so the local API
    acts as a known user (today it is fully unauthenticated with `CORS: *`).

## Deviations from the approved design log

The design log was written without write access to the repo; five of its
statements do not survive contact with the code. The corrections below are part
of this spec.

- **D1 — no separate `project_bindings` table; `groups` is RENAMED to
  `projects`.** `group.projectDir` is read at 40+ call sites in
  `supervisor.service.ts` alone, and `Group` also carries `carryFiles`,
  `defaultBranch`, `conventions`, `previewCommand`, `apiCommand`, `color`.
  Dropping the table would force every launch to read config from Supabase,
  breaking Requirement 7 (offline launch). Instead the local table becomes
  `projects` with `id` = the CLOUD project UUID, `local_repo_path` replacing
  `project_dir`, and the cloud config cached in the remaining columns. That row
  IS the binding, plus an offline config cache. Cloud stays the source of truth
  for config; the local row is refreshed on every successful cloud read.
- **D2 — transcripts are NOT in SQLite today and this design does not add
  them.** They live in `SupervisorService.map[id].transcript` (process memory,
  `supervisor.service.ts:36`) and are rehydrated from `omp` via
  `getAllMessages()` (lines 403, 467, 1019). The log's "SQLite keeps
  transcripts" is wrong; nothing changes here.
- **D3 — the status push hooks into `events$`, not into the 18
  `updateSession({status})` call sites.** `pushUpdate`
  (`supervisor.service.ts:88-91`) is the single point where a fully merged
  `Session` (durable ∪ live) is emitted. A new `CloudSyncService` subscribes to
  `supervisor.events$` exactly like `EventsGateway` does, keeps the last pushed
  status per task, and enqueues only on an edge change. Zero edits inside the
  supervisor's status paths.
- **D4 — the local JWT guard validates once, then works offline.** Validating
  every request through `supabase.auth.getUser()` would make local session
  control depend on cloud reachability (violating Requirement 7). The token is
  validated once at `POST /api/auth/session`, then cached (SQLite) with its
  `expires_at`; the guard compares the presented bearer token against the cached
  one. No `jose`/JWKS dependency.
- **D5 — local session deletion pushes a terminal status.** `session_removed`
  does not pass through `pushUpdate`; if the removed session's task was active,
  `CloudSyncService` enqueues `stopped` so the board cannot hang on `thinking`.
- **D6 — the cloud board is a NEW page.** `WorkspacePage.vue` is a 1830-line
  monolith rendering a `KTable`, not kanban columns; it keeps rendering LOCAL
  sessions. The shared board lands in a new `BoardPage.vue` with status columns.

## Data model — Supabase (Postgres)

`kermanych/supabase/migrations/*.sql`, applied with the Supabase CLI.

```sql
create type task_status as enum
  ('backlog','queued','thinking','tool','waiting_input',
   'done','error','stopped','merged','conflict');   -- mirrors core SessionStatus

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  github_username text, display_name text, avatar_url text,
  created_at timestamptz not null default now());

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  git_remote_url text,                    -- informational; no auto-clone
  conventions text, preview_command text, api_command text,
  default_branch text,
  carry_files text[] not null default array['.env'],
  env_keys text[] not null default '{}',  -- NAMES only, never values
  color text,
  owner_id uuid not null references profiles(id),
  created_at timestamptz not null default now());

create table project_members (
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  role text not null check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (project_id, user_id));

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  title text not null, description text,
  status task_status not null default 'backlog',
  assignee_id uuid references profiles(id),
  created_by uuid not null references profiles(id),
  model text, prefix text, platform text, kind text, branch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());

create index tasks_project_idx on tasks (project_id);
create index members_user_idx on project_members (user_id);
alter publication supabase_realtime add table tasks;
```

Triggers and helpers:

- `handle_new_user()` — `after insert on auth.users`, `security definer`:
  inserts `profiles` from `raw_user_meta_data` (`user_name` → `github_username`,
  `full_name` → `display_name`, `avatar_url`).
- `handle_new_project()` — `after insert on projects`, `security definer`:
  inserts the owner's `project_members` row (`role='owner'`), so the creator is a
  member without a second round trip.
- `is_project_member(p uuid, u uuid) returns boolean`, `security definer`,
  `stable` — `exists (select 1 from project_members where project_id=p and
  user_id=u)`. `security definer` is REQUIRED: policies on `project_members`
  would otherwise recurse.
- `tasks_guard()` — `before insert or update or delete on tasks`, enforces the
  cross-row invariants RLS cannot express:
  1. `update` changing `status` requires `auth.uid() = old.assignee_id`
     (self-assign transitions are allowed because the assign happens in the same
     statement — see the atomic self-assign below);
  2. `update` changing `assignee_id`, or `delete`, is refused when `old.status`
     is active (`queued`, `thinking`, `tool`, `waiting_input`) — message
     `task is active`;
  3. sets `new.updated_at = now()` on every update.

## RLS policies

| table | select | insert | update | delete |
|---|---|---|---|---|
| `profiles` | any authenticated | trigger only (`security definer`) | own row | — |
| `projects` | `owner_id = auth.uid() or is_project_member(id, auth.uid())` | any authenticated, `owner_id = auth.uid()` | owner | owner |
| `project_members` | `is_project_member(project_id, auth.uid())` | project owner (+ trigger) | owner | owner |
| `tasks` | `is_project_member(project_id, auth.uid())` | member, `created_by = auth.uid()` | member (policy) + `tasks_guard` (invariants) | member; `tasks_guard` refuses active |

The `projects` SELECT disjunct is load-bearing, not belt-and-braces:
`insert … returning` evaluates the SELECT policy for the new row BEFORE the
`after insert` trigger has written the owner's `project_members` row, so a bare
`is_project_member(...)` would make `createProject().select()` come back empty.
The owner is always a member, so the disjunct widens nothing.

`revoke all on … from anon` for the four tables; every policy targets
`authenticated`. RLS is the ONLY authorization surface — the UI's pre-checks are
UX, not security.

## Data model — local SQLite

One versioned migration (`user_version` 0 → 1) plus the existing additive
`try { ALTER TABLE … ADD COLUMN } catch {}` idiom
(`registry.service.ts:27-103`). Verified on this repo's dependency tree:
`better-sqlite3` 13.0.3 bundles SQLite 3.53.4, so `ALTER TABLE … RENAME TO`,
`RENAME COLUMN` and `PRAGMA user_version` all work.

```sql
-- migration v1, guarded by pragma user_version
ALTER TABLE groups   RENAME TO projects;
ALTER TABLE projects RENAME COLUMN project_dir TO local_repo_path;
ALTER TABLE sessions RENAME COLUMN group_id TO project_id;
PRAGMA user_version = 1;

-- additive (existing idiom)
ALTER TABLE sessions ADD COLUMN task_id TEXT;
CREATE TABLE IF NOT EXISTS status_outbox (
  task_id TEXT PRIMARY KEY,      -- one row per task: latest-wins dedupe
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT);
CREATE TABLE IF NOT EXISTS auth_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL, access_token TEXT NOT NULL,
  expires_at TEXT, github_username TEXT);
CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id);
```

`projects.id` now holds the cloud project UUID; rows are created/refreshed from
cloud reads, not by a local "create project" flow. `sessions.project_id` +
`sessions.task_id` tie a local session to its cloud task. Everything else about
`sessions` (19 columns, in-memory live overlay via `merge()`) is unchanged.

Shared types (`packages/core/src/types.ts`): `Group` → `Project`
(`{ id, name, localRepoPath, color?, previewCommand?, apiCommand?, carryFiles?,
defaultBranch?, conventions?, createdAt }`); `Session.groupId` →
`Session.projectId`, plus `Session.taskId?: string`. `ServerEvent`'s
`group_update`/`group_removed` become `project_update`/`project_removed`. This is
a clean cutover — no `Group` alias survives (rename via LSP across core, api, ui).

## New package `@kermanych/cloud`

`packages/cloud` — the only place `@supabase/supabase-js` is imported by
non-UI code; consumed by both `apps/api` and `apps/ui` (mirrors how
`@kermanych/core` is shared). Zero Nest/Quasar coupling.

- `src/types.ts` — `CloudProject`, `ProjectMember`, `Task`, `TaskInsert`,
  `TaskPatch`; `TaskStatus = SessionStatus` re-exported from `@kermanych/core`
  so the enum cannot drift.
- `src/client.ts` — `createCloudClient({ url, anonKey, accessToken? })`
  returning a typed `SupabaseClient`; `cloudEnv()` reads
  `SUPABASE_URL`/`SUPABASE_ANON_KEY` (api) or
  `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (ui).
- `src/tasks.ts` — `listTasks`, `createTask`, `assignTask`, `claimTask`
  (atomic self-assign: `update … set assignee_id = uid where id = ? and
  assignee_id is null`), `patchTask`, `pushTaskStatus(client, taskId, status,
  updatedAt)`, `subscribeTasks(client, projectIds, onChange)`.
- `src/projects.ts` — `listProjects`, `createProject`, `patchProject`,
  `listMembers`, `addMember`, `removeMember`.
- `src/status.ts` — `taskStatusFromSession(session): TaskStatus` (identity map
  today; the single seam if the vocabularies ever diverge) and
  `isTerminalTaskStatus`.

## Auth

All API facts below were verified against `@supabase/supabase-js` 2.112.3
source (see `## Verified upstream behaviour`).

- Supabase Auth + GitHub provider, `flowType: 'pkce'`, no client secret on any
  client.
- **Browser**: `signInWithOAuth({ provider: 'github', options: { redirectTo:
  <origin>/#/auth/callback } })`; the SDK exchanges the code on return
  (`detectSessionInUrl` on).
- **Electron**: the RENDERER owns the flow, because the PKCE verifier lives in
  the storage of the client instance that built the URL (key
  `${storageKey}-flow-${flowId}-code-verifier`) — a code redeemed by a different
  process fails and burns the single-use code. So: renderer calls
  `signInWithOAuth({ …, options: { redirectTo: 'http://127.0.0.1:53170/callback',
  skipBrowserRedirect: true } })` → gets `data.url` (+ `data.flowId`) → hands the
  URL to main via `window.kermanych.startOAuth(url)` /
  `ipcMain.handle('kermanych:oauth')` (the app's first `invoke`/`handle` pair) →
  main runs a one-shot `node:http` listener, `shell.openExternal`s the URL,
  resolves the `code`, closes the listener (and on `before-quit`), 120 s timeout
  → renderer calls `exchangeCodeForSession(code, { flowId })`.
  The loopback port is FIXED at 53170, not `freePort()`: GoTrue validates the
  redirect against the allow-list (`additional_redirect_urls` /
  `http://127.0.0.1:53170/callback` in the dashboard), so a random port cannot
  be whitelisted.
- **Token handoff to the local Nest**: mirroring supabase-js's own realtime
  guard, the UI forwards the token on `SIGNED_IN` / `TOKEN_REFRESHED` /
  `INITIAL_SESSION` (dedupe by token inequality; `INITIAL_SESSION` may carry a
  null session) via `POST /api/auth/session { accessToken }`, and calls
  `DELETE /api/auth/session` on `SIGNED_OUT`.
- **Server-side validation**: `AuthService.setToken` calls
  `auth.getClaims(token)` — local WebCrypto verification against the cached
  `/auth/v1/.well-known/jwks.json` — and falls back to `getUser(token)` (a
  `GET /auth/v1/user` round trip) when the project signs with a symmetric
  secret. It then stores `{ userId (claims.sub), accessToken, expiresAt
  (claims.exp), githubUsername }` in `auth_session`.
- **Client for pushes**: `createCloudClient({ url, anonKey, accessToken })`
  builds a client with `global.headers.Authorization = Bearer <token>` and
  `auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl:
  false }`. NOT `auth.setSession()` — that mutates shared client state and races
  across concurrent requests. The anon key still travels as the `apikey` header,
  so RLS sees the user's role.
- **Local guard**: `SupabaseAuthGuard` registered as `APP_GUARD` in
  `AppModule`; `@Public()` marks exactly one route, `POST /api/auth/session`
  (there is no health route in `apps/api` today, and this design does not add
  one).
  It requires `Authorization: Bearer <token>` equal to the cached token;
  an unknown token is re-validated (network) and accepted if it verifies;
  unknown token while offline → 401. Requests without a token get 401, so the
  loopback API is no longer anonymously drivable.
- **Offline**: because `getClaims` verifies locally against a cached JWKS, an
  already-known token needs no network at all. An EXPIRED cached token is still
  accepted for LOCAL session control (the machine's owner is unambiguous) while
  cloud pushes stay queued — this is what keeps Requirement 7 true with
  `Authorization` enforced.

## Task lifecycle and status sync

`backlog` → (assign) → `queued` → `thinking`/`tool` → `waiting_input` →
`done` | `error` | `stopped` | `merged` | `conflict`. `backlog` lives only in the
cloud; from `queued` the local session is the source of truth.

Launch (`POST /api/sessions/from-task { taskId }`):

1. Guard resolves `userId` from the cached token.
2. Read the task via the user's cloud client; refuse if
   `assignee_id ∉ {null, userId}` → `task assigned to someone else`.
3. If unassigned, `claimTask` (atomic `where assignee_id is null`); losing the
   race → `task already claimed`.
4. Resolve the local project row; missing `local_repo_path` → `project not bound`
   (the UI then opens `KDirPicker`).
5. Refresh the local `projects` row from the cloud project (name, conventions,
   carry_files, default_branch, preview/api command, color).
6. `registry.createSession({ projectId, taskId, name: task.title, task:
   task.description ?? task.title, model, prefix, platform, kind, baseBranch:
   task.branch ?? project.defaultBranch })`, then the existing
   `launch()` path (worktree + carry files + `omp --mode rpc`), unchanged.

Sync (local → cloud) — `CloudSyncService implements OnModuleInit`:

- subscribes to `supervisor.events$` (same shape as `EventsGateway`);
- on `session_update` with a `taskId`: `taskStatusFromSession`, compare against
  the in-memory last-pushed map, and on change `registry.enqueueTaskStatus(taskId,
  status)` then `void this.drain()`;
- on `session_removed` for a session whose task was active: enqueue `stopped`;
- `onModuleDestroy`: enqueue `stopped` for every live session with a task, so a
  clean shutdown never leaves the board on `thinking`;
- `drain()` walks `status_outbox`, calls `pushTaskStatus` under the user's JWT,
  deletes the row on success, and on failure bumps `attempts`/`last_error` and
  re-arms with exponential backoff (first retry ~2 s, doubling to a 60 s cap). A
  push is retried on the next token handoff too, so relogin resumes the queue.

Reads are UI-side only: each UI subscribes with `subscribeTasks` to its
projects' `tasks` rows — ONE channel, one `postgres_changes` binding with
`filter: 'project_id=in.(<uuid>,…)'`. The local Nest never subscribes to
Realtime.

`waiting_input` is a deliberate constraint: everyone SEES that a task waits for
input, only the owner can answer it locally (model B1).

## Verified upstream behaviour

Checked against `@supabase/supabase-js` 2.112.3 source; these are the facts the
implementation depends on, with their consequences.

- **Realtime filters accept `in`** (13 operators total; comma = AND), so one
  binding covers every project a user belongs to:
  `filter: 'project_id=in.(a,b,c)'`. Server cap is 100 values — beyond that,
  drop the filter and rely on the `tasks` SELECT policy to scope rows.
- **RLS is enforced per subscriber** for `postgres_changes` provided the table
  is in the `supabase_realtime` publication, `authenticated` has `SELECT`, and a
  SELECT policy exists. `realtime.messages` / private channels are for
  Broadcast/Presence and are NOT part of this design.
- **The realtime socket's token is refreshed automatically** by supabase-js from
  `onAuthStateChange` (`SIGNED_IN` / `TOKEN_REFRESHED` / `INITIAL_SESSION` →
  `realtime.setAuth(token)`); the app MUST NOT call `setAuth` itself, which
  would pin the token and disable that refresh.
- **RLS is NOT applied to `DELETE` events** (Postgres cannot authorize a deleted
  row). Accepted limitation: a non-member who guesses a project UUID and
  subscribes could observe task-deletion primary keys — ids only, no content.
  Deletion is rare (owner/author, non-active tasks) and carries no secret.
- **Bindings must be registered before `subscribe()`** and duplicate identical
  `postgres_changes` filters on one channel are silently dropped, so
  `subscribeTasks` builds exactly one binding and tears down with
  `removeChannel`.
- **`.is('assignee_id', null)` + `.select().maybeSingle()`** is a genuine atomic
  claim (one `UPDATE … WHERE id = $1 AND assignee_id IS NULL`); zero matched
  rows yield `{ data: null, error: null }` — that is the "lost the race" signal,
  not an error.
- **`getClaims(jwt)` supersedes `getUser(jwt)`** for server-side validation
  (local JWKS verification vs. a round trip per call) — see `## Auth`.
- **PKCE verifiers are per client instance and per flow**; in Node/Electron main
  the default storage is in-memory, which is why the renderer, not main, runs
  both `signInWithOAuth` and `exchangeCodeForSession`.
- **`supabase/config.toml`**: `[auth.external.github]` with `enabled`,
  `client_id = "env(GITHUB_CLIENT_ID)"`, `secret = "env(GITHUB_SECRET)"`;
  `env()` resolves from a `.env` beside `supabase/`, the variable name is
  arbitrary. Local provider callback is
  `http://127.0.0.1:54321/auth/v1/callback`; the loopback redirect
  `http://127.0.0.1:53170/callback` must be in `additional_redirect_urls`.
  `supabase db reset` re-applies `supabase/migrations/*.sql` ordered by the
  14-digit version prefix — keep that width.

## Local API changes

- `src/auth/auth.service.ts` (token cache + `cloudClient()` getter),
  `auth.guard.ts` (`APP_GUARD`), `public.decorator.ts`, `auth.controller.ts`
  (`POST`/`DELETE /api/auth/session`, `GET /api/auth/session`).
- `src/cloud/cloud-sync.service.ts` (subscriber + outbox drain).
- `http/groups.controller.ts` → `http/projects.controller.ts`: `/api/projects`
  (list/patch local rows + `PUT /api/projects/:id/binding { localRepoPath }` +
  the existing `GET|PUT /:id/env` and `GET /:id/branches`). Local project rows
  are UPSERTed from the cloud, so `POST /projects` (create) disappears — cloud
  creation happens in the UI.
- `http/sessions.controller.ts`: new literal route `POST /sessions/from-task`
  declared ABOVE the `:id` block (route-order matters, cf. `@Post("chat")` at
  line 33); `GET /sessions?projectId=`.
- `registry.service.ts`: versioned migration, renamed methods
  (`listProjects`/`upsertProject`/`patchProject`/`removeProject`,
  `listSessions(projectId?)`), plus `enqueueTaskStatus`, `listOutbox`,
  `dropOutbox`, `bumpOutboxAttempt`, `getAuthSession`, `setAuthSession`,
  `clearAuthSession`.
- `preview/seed.ts` and `PreviewService` follow the rename; the seed keeps
  working offline (it seeds local project rows with synthetic UUIDs).

## UI changes

- `boot/supabase.ts` — creates the client from `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` (added to `src/env.d.ts`), installs
  `onAuthStateChange` → token handoff to the local API, and exposes it via the
  auth store. `quasar.config.ts` `boot: ['tokens', 'supabase']`.
- `stores/auth.ts` — `user`, `profile`, `accessToken`, `signInWithGithub()`
  (branch on `window.kermanych?.startOAuth`), `signOut()`, `ready` promise.
- `stores/projects.ts` (`useProjects`) — cloud projects + membership, mirrored
  into the local registry on every successful read so launching stays offline.
- `stores/board.ts` (`useBoard`) — tasks only: `subscribeTasks` lifecycle,
  `offline` flag, optimistic create/assign with rollback on an RLS or
  `tasks_guard` refusal.
- `pages/LoginPage.vue` (`/login`, outside `MainLayout`) — "Увійти через
  GitHub"; `layouts/AuthLayout.vue` hosts it plus `KToast` (today `KToast` is
  mounted only in `MainLayout.vue:153`).
- `router/index.ts` — `beforeEach` guard: unauthenticated → `/login`,
  authenticated on `/login` → `/`; routes gain `meta.public` and names.
- `pages/BoardPage.vue` (`/board`) — status columns, task cards (title,
  assignee avatar, status badge, stale hint from `updated_at`), create/assign
  modals, launch-params form, "Запустити" (disabled without a binding),
  members panel for owners.
- `pages/WorkspacePage.vue` — unchanged board of LOCAL sessions; its header
  gains a link to the cloud board and its rows show the task title when
  `taskId` is set.
- `lib/api.ts` — `Authorization: Bearer` in `post`/`get`/`put` AND in the five
  inline `fetch` calls (`deleteGroup` 79, `deleteSession` 113, `updateGroup` 125,
  `stopPreview` 149, `updateTask` 195); 401 → `store.notify` + sign-out.
  `createSessionFromTask(taskId)`, `setProjectBinding(id, path)`,
  `authSession(token)` added; group wrappers renamed to project.
- `stores/orchestrator.ts` — rename group→project state/actions, add
  `disconnect()`/`reset()` so sign-out tears the socket down.
- Binding flow reuses `KDirPicker` (`api.listDirs` → local `GET /fs/list`),
  which keeps pointing at the local API while everything else goes to Supabase.
- Offline banner driven by the Realtime channel state; RLS refusals surface as
  error toasts.

## Electron changes

`src-electron/oauth-loopback.ts` (`startLoopbackOAuth(authorizeUrl): Promise<{
code: string }>`), wired in `electron-main.ts` via `ipcMain.handle`
('kermanych:oauth'), `shell` added to the L1 import, listener closed in
`before-quit`; `electron-preload.ts` + `src/types/kermanych-bridge.d.ts` gain
`startOAuth(authorizeUrl)`.

## Verification

- `packages/cloud` unit (vitest, `test/**/*.spec.ts`): `taskStatusFromSession`
  identity + terminal set; `claimTask` builds the `assignee_id is null`
  predicate; `subscribeTasks` filter string per project set.
- `apps/api` unit (existing conventions: real `RegistryService(":memory:")`,
  `vi.mock("../src/rpc/rpc-session")` FakeRpc, partial `WorktreeService` cast):
  - `registry.migration.spec.ts` — v0 DB with `groups`/`group_id` migrates to
    `projects`/`project_id`, rows preserved, `user_version = 1`, idempotent on
    reopen.
  - `registry.outbox.spec.ts` — enqueue/latest-wins upsert/drop/attempt bump;
    `auth_session` round-trip.
  - `auth.guard.spec.ts` — no header → 401; wrong token → 401; cached token →
    passes with `userId`; `@Public()` route bypasses; expired cached token still
    passes (offline rule).
  - `cloud-sync.spec.ts` — status edge dedupe (two identical `session_update`s →
    one outbox row); non-status updates (`contextPercent`) push nothing;
    offline push → row survives with `attempts = 1`; reconnect → drained;
    `session_removed` on an active task → `stopped`; `onModuleDestroy` → `stopped`.
  - `sessions.from-task.spec.ts` — assignee check, atomic claim on unassigned,
    `project not bound` refusal, happy path creates a session with
    `taskId`/`projectId` and spawns one child.
- RLS + trigger integration (`packages/cloud/test/rls.spec.ts`, against
  `supabase start`; skipped unless `SUPABASE_TEST_URL` is set): member sees only
  own-project tasks; non-member SELECT returns 0 rows; non-owner cannot insert
  `project_members`; non-assignee status update refused; active task
  reassign/delete refused; `handle_new_user` fills `profiles`;
  `handle_new_project` inserts the owner membership.
- Manual smoke (required pre-merge): full GitHub OAuth in the browser AND in
  Electron (loopback); two machines/two accounts — A creates and assigns, B sees
  the card live, B binds the repo, B launches, A watches
  `queued → thinking → done`; kill B's Kermanych mid-run → A sees the stale hint,
  restart B → terminal status arrives; block Supabase (hosts entry) → B's session
  keeps running and the status lands after unblocking.

## Non-goals

- No B3 remote control of someone else's session; sessions stay private to their
  machine (only `status` is shared).
- No transcripts, `currentTool`, `contextPercent`, `todoPhases` or interactive
  prompts in the cloud.
- No auto-clone of repos; binding is manual (`git_remote_url` is informational).
- No heartbeat in v1 — stale detection is `updated_at` age in the UI only.
- No team/workspace layer above projects (flat owner/member).
- No service-role key, and no secret VALUES, on any machine or in the cloud.
- No transcript persistence (see D2), no new WS fan-out, no cloud-side
  scheduling or auto-assignment.
- No i18n layer; UI copy stays Ukrainian inline, code/identifiers English.
