# Team cloud A — Supabase foundation, `@kermanych/cloud`, and authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Supabase coordination backend (schema, triggers, RLS), create the shared `@kermanych/cloud` package, and make GitHub OAuth work end to end — in the browser UI, in the Electron desktop app, and as a bearer-token guard on the previously wide-open local NestJS API.

**Architecture:** Supabase holds four tables (`profiles`, `projects`, `project_members`, `tasks`) whose only authorization surface is RLS; every client acts under the user's JWT and no machine ever holds a service-role key. A new zero-framework package `@kermanych/cloud` is the single place `@supabase/supabase-js` is imported by non-UI code, and is consumed by both `apps/api` and `apps/ui` (exactly how `@kermanych/core` is shared today). The Quasar UI signs in with PKCE GitHub OAuth — a browser redirect in the web build, a one-shot `node:http` loopback listener in Electron — then hands the access token to the local Nest via `POST /api/auth/session`. The local guard validates that token **once** and afterwards compares presented bearers against the cached copy, so local session control keeps working offline.

**Tech Stack:** Supabase CLI 2.x (Postgres 17, GoTrue, Realtime), `@supabase/supabase-js` ^2, NestJS 10 (api), Quasar 2 / Vue 3 / Pinia 2 (ui), Electron 43, `better-sqlite3` ^13, vitest ^2.

**Spec:** `docs/superpowers/specs/2026-08-21-team-cloud-design.md`

**Prerequisite plans:** none. This is Plan **A** of four; execution order is **A → B → C → D**.

- **Plan B** (`2026-08-21-team-cloud-projects-binding.md`) — `Group` → `Project` rename, versioned SQLite migration, `packages/cloud/src/projects.ts`, local-binding flow, members panel.
- **Plan C** (`2026-08-21-team-cloud-board.md`) — `packages/cloud/src/tasks.ts`, `stores/board.ts`, `BoardPage.vue`.
- **Plan D** (`2026-08-21-team-cloud-status-sync.md`) — `status_outbox`, `CloudSyncService`, `POST /api/sessions/from-task`.

Nothing in this plan depends on B/C/D. Three coordinated hand-offs point forward and are named in the relevant `**Interfaces:**` blocks (barrel appends, `app.module.ts` entries, `routes.ts` marker comment).

## Global Constraints

- Node ≥22.12 required (`better-sqlite3` v13 native ABI); pnpm is pinned via `packageManager` (`pnpm@10.33.2`).
- All paths in this plan are relative to the `kermanych/` package root (the pnpm workspace root).
- Code, identifiers, comments, and commit messages in English; every UI-visible string in Ukrainian. No i18n layer — copy stays inline.
- **No service-role key on any client machine.** The service-role key appears in exactly one place in this plan: `packages/cloud/test/rls.spec.ts`, read from `SUPABASE_TEST_SERVICE_KEY`, which is a developer-local test-only variable and is never referenced by shipped code.
- **Env secret VALUES never reach the cloud.** `projects.env_keys` stores key NAMES only.
- RLS is the ONLY authorization surface for cloud data; UI pre-checks are UX, not security.
- `revoke all … from anon` for all four tables; every policy targets `authenticated`.
- No `jose`/JWKS dependency in `apps/api` — validation goes through `supabase.auth.getClaims(token)`, which verifies the JWT locally against the SDK's own cached JWKS (and falls back to a server round trip only for symmetric-secret projects); the result is cached and every later request is a string compare in the guard (spec Deviation D4).
- vitest runs only for `apps/api`, `packages/core`, and the new `packages/cloud`. `apps/ui` has NO component-test harness (its only spec is `apps/ui/test/socket.spec.ts` and there is no `vitest.config.*` in the package), so every UI task is verified by running the app (`pnpm dev:api` + `pnpm dev:ui`, or `pnpm dev:app`) with explicit observable expectations.
- SQL identifiers stay `snake_case`; the snake→camel mapping lives inside `packages/cloud` and inside `RegistryService`. Nothing outside those two ever sees `snake_case`.
- The local API keeps binding `127.0.0.1` only (`apps/api/src/main.ts:24`). The guard is defence in depth on top of that, not a replacement for it.
- Follow existing repo patterns: `@Injectable()` classes listed verbatim in `AppModule`; `try { … } catch { throw new BadRequestException((err as Error).message) }` in controllers; tests construct services directly (`new Service(...)`) — `@nestjs/testing` is NOT installed and must not be added.

## File Structure

**New — Supabase (Plan A owns all of `supabase/**`)**

| Path | Responsibility |
|---|---|
| `supabase/config.toml` | Local stack config: ports, `[auth]` site/redirect allow-list, `[auth.external.github]` provider. |
| `supabase/.gitignore` | Keeps CLI local artifacts and any local secret file out of git. |
| `supabase/migrations/20260821090000_team_cloud_schema.sql` | `task_status` enum, four tables, two indexes, Realtime publication. |
| `supabase/migrations/20260821090100_team_cloud_functions.sql` | `handle_new_user`, `handle_new_project`, `is_project_member`, `tasks_guard` + their triggers. |
| `supabase/migrations/20260821090200_team_cloud_rls.sql` | `enable row level security`, grants, `revoke … from anon`, all 14 policies. |

**New — `packages/cloud` (a new workspace package, conventions copied from `packages/core`)**

| Path | Responsibility |
|---|---|
| `packages/cloud/package.json` | Same shape as `packages/core/package.json`; deps `@kermanych/core` + `@supabase/supabase-js`. |
| `packages/cloud/tsconfig.json` | One-liner extending `../../tsconfig.base.json`, CommonJS → `dist`. |
| `packages/cloud/vitest.config.ts` | Two lines, `include: ["test/**/*.spec.ts"]`. |
| `packages/cloud/src/index.ts` | Barrel. Ships with three lines; B and C each append exactly one. |
| `packages/cloud/src/types.ts` | `TaskStatus`, `Profile`, `CloudProject`, `ProjectMember`, `Task`, `TaskInsert`, `TaskPatch`. |
| `packages/cloud/src/client.ts` | `createCloudClient`, `cloudEnv`, re-exported `SupabaseClient` type. |
| `packages/cloud/src/status.ts` | `taskStatusFromSession`, `isTerminalTaskStatus`. |
| `packages/cloud/test/status.spec.ts` | Unit: identity map + terminal set. |
| `packages/cloud/test/client.spec.ts` | Unit: `cloudEnv` key selection and failure message. |
| `packages/cloud/test/rls.spec.ts` | Integration against `supabase start`; skipped without env. |

**New — `apps/api` auth**

| Path | Responsibility |
|---|---|
| `apps/api/src/auth/auth.service.ts` | Token cache (SQLite-backed), `getClaims`-based validation with a `getUser` fallback, `cloudClient()`, `onToken()`. |
| `apps/api/src/auth/public.decorator.ts` | `IS_PUBLIC_KEY` + `@Public()`. |
| `apps/api/src/auth/auth.guard.ts` | `SupabaseAuthGuard` (`APP_GUARD`): bearer compare, offline acceptance, `req.user`. |
| `apps/api/src/auth/auth.controller.ts` | `POST`/`DELETE`/`GET /api/auth/session`. |
| `apps/api/test/registry.auth.spec.ts` | `auth_session` round-trip. |
| `apps/api/test/auth.guard.spec.ts` | Guard matrix incl. the offline rule. |

**Modified**

| Path | Change |
|---|---|
| `apps/api/src/registry/registry.service.ts` | `auth_session` table after line 26; `getAuthSession`/`setAuthSession`/`clearAuthSession`. |
| `apps/api/src/app.module.ts` | `AuthController`, `AuthService`, `APP_GUARD`. |
| `apps/api/package.json` | `+ @kermanych/cloud`, `+ @supabase/supabase-js`. |
| `apps/ui/package.json` | `+ @kermanych/cloud`, `+ @supabase/supabase-js`. |
| `apps/ui/quasar.config.ts` | `boot: ['tokens','supabase']`; `@kermanych/cloud` CJS-interop entries. |
| `apps/ui/src/env.d.ts` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. |
| `apps/ui/src/lib/api.ts` | `Authorization: Bearer` in every helper and all five inline `fetch` sites; 401 hook; auth endpoints. |
| `apps/ui/src/boot/supabase.ts` (new) | Brings the session up before the first navigation. |
| `apps/ui/src/stores/auth.ts` (new) | `client`, `user`, `profile`, `accessToken`, `ready`, `signInWithGithub`, `signOut`. |
| `apps/ui/src/pages/LoginPage.vue` (new) | «Увійти через GitHub». |
| `apps/ui/src/layouts/AuthLayout.vue` (new) | Hosts `LoginPage` + `KToast`. |
| `apps/ui/src/router/routes.ts` | Named routes, `meta.public`, `/login`, the Plan-C marker. |
| `apps/ui/src/router/index.ts` | `beforeEach` auth guard. |
| `apps/ui/src/types/kermanych-bridge.d.ts` | `startOAuth`. |
| `apps/ui/src-electron/oauth-loopback.ts` (new) | One-shot loopback listener. |
| `apps/ui/src-electron/electron-main.ts` | `shell` import, `ipcMain.handle('kermanych:oauth')`, teardown in `before-quit`. |
| `apps/ui/src-electron/electron-preload.ts` | `startOAuth` on the bridge. |
| `package.json` (root) | `dev:app` also builds `@kermanych/cloud`. |
| `README.md` | New "Cloud prerequisites" section. |

---

### Task 1: `supabase/` scaffold, local stack, GitHub provider

**Files:**
- Create: `supabase/config.toml` (generated by `supabase init`, then edited)
- Create: `supabase/.gitignore`

**Interfaces:**
- Produces: a running local Supabase stack on `http://127.0.0.1:54321` (Postgres on `54322`, Studio on `54323`) with the GitHub provider enabled; the redirect allow-list containing `http://localhost:5317/**` (Quasar dev server) and `http://127.0.0.1:53170/callback` (the Electron loopback of Task 14). The anon key is printed by `supabase start` and becomes `VITE_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY`.

- [ ] **Step 1: Check whether the project is already initialised, then initialise**

`supabase init` is **not** already done — there is no `supabase/` directory in this repo. Verify and initialise from the package root:

```bash
cd kermanych
test -f supabase/config.toml && echo "ALREADY INITIALISED — skip init" || supabase init
```

Expected: prints nothing about "ALREADY INITIALISED" and creates `supabase/config.toml` (414 lines). `supabase init` also derives `project_id` from the working directory, so the first non-comment line must read `project_id = "kermanych"` — confirm with:

```bash
grep '^project_id' supabase/config.toml
```
Expected: `project_id = "kermanych"`.

If you get a different value (you ran `init` from elsewhere), edit it to `kermanych` — the container names derive from it.

- [ ] **Step 2: Point the auth allow-list at Kermanych's dev URLs**

In `supabase/config.toml`, inside the `[auth]` section, replace the two generated lines

```toml
site_url = "http://127.0.0.1:3000"
```
```toml
additional_redirect_urls = ["https://127.0.0.1:3000"]
```

with:

```toml
site_url = "http://localhost:5317"
```
```toml
# The Quasar dev server (hash router, so the callback carries a fragment — glob it),
# plus the fixed loopback the Electron main process listens on (src-electron/oauth-loopback.ts).
additional_redirect_urls = ["http://localhost:5317/**", "http://127.0.0.1:53170/callback"]
```

Leave `jwt_expiry = 3600` and `enable_signup = true` as generated.

- [ ] **Step 3: Enable the GitHub provider**

The generated `config.toml` ships only `[auth.external.apple]` as a template. Insert this block immediately **before** the line `[auth.web3.solana]`:

```toml
[auth.external.github]
enabled = true
# Kermanych signs in with GitHub only. Both values come from the GitHub OAuth App
# created in Step 4; never commit them — env() substitution keeps them out of git.
client_id = "env(GITHUB_CLIENT_ID)"
secret = "env(GITHUB_SECRET)"
# Empty → GoTrue derives http://127.0.0.1:54321/auth/v1/callback locally.
redirect_uri = ""
```

- [ ] **Step 4: Create the GitHub OAuth App(s)**

GitHub allows exactly ONE callback URL per OAuth App, so a local stack and a hosted project need two apps.

For the LOCAL stack — <https://github.com/settings/developers> → **New OAuth App**:
- Application name: `Kermanych (local)`
- Homepage URL: `http://localhost:5317`
- Authorization callback URL: `http://127.0.0.1:54321/auth/v1/callback`

Generate a client secret, then export both values in the shell you will run `supabase start` from:

```bash
export GITHUB_CLIENT_ID=Ov23li...          # from the OAuth App page
export GITHUB_SECRET=ghs_...               # the generated client secret
```

For a HOSTED project, create a second OAuth App with callback `https://<project-ref>.supabase.co/auth/v1/callback`, then in the dashboard set Authentication → Providers → GitHub (client id + secret) and Authentication → URL Configuration → Site URL `http://localhost:5317` with Redirect URLs `http://localhost:5317/**` and `http://127.0.0.1:53170/callback`. The hosted project needs no `config.toml`.

- [ ] **Step 5: Keep CLI artifacts out of git**

`supabase init` (CLI 2.x) does NOT create a `.gitignore`. Create `supabase/.gitignore`:

```gitignore
# Supabase CLI local artifacts — never committed.
.branches
.temp
# Any locally-kept provider secret file. Secrets belong in your shell environment;
# this line exists so an accidental drop here cannot be committed.
.env
.env.local
```

- [ ] **Step 6: Start the stack and record the keys**

Docker must be running.

```bash
cd kermanych
supabase start
```

Expected: a table of URLs and keys. Copy three values — you need them in Tasks 6, 7 and 12:
- `API URL` → `http://127.0.0.1:54321`
- `anon key` → `VITE_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY`
- `service_role key` → `SUPABASE_TEST_SERVICE_KEY` (Task 7 only)

Re-print them at any time with `supabase status`.

- [ ] **Step 7: Verify the GitHub provider actually answers**

```bash
curl -si "http://127.0.0.1:54321/auth/v1/authorize?provider=github&redirect_to=http%3A%2F%2Flocalhost%3A5317%2F" \
  | sed -n '1p;/^location:/Ip'
```

Expected: `HTTP/1.1 302 Found` and a `location:` header beginning `https://github.com/login/oauth/authorize?client_id=Ov23li…`.

If instead you get a 400 with `Unsupported provider: provider is not enabled`, the two env vars were not exported before `supabase start` — export them and run `supabase stop && supabase start`.

- [ ] **Step 8: Commit**

```bash
git add kermanych/supabase/config.toml kermanych/supabase/.gitignore
git commit -m "feat(cloud): supabase local stack config with GitHub OAuth provider"
```

---

### Task 2: Supabase schema migration

**Files:**
- Create: `supabase/migrations/20260821090000_team_cloud_schema.sql`

**Interfaces:**
- Consumes: the running local stack (Task 1).
- Produces: enum `task_status` (10 labels, mirroring `SessionStatus` in `packages/core/src/types.ts:4-5`); tables `profiles`, `projects`, `project_members`, `tasks`; indexes `tasks_project_idx`, `members_user_idx`; `tasks` added to the `supabase_realtime` publication. Column names consumed by `packages/cloud` mappers in Tasks 5-6 and by Plans B/C.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260821090000_team_cloud_schema.sql`:

```sql
-- Kermanych team cloud — coordination schema.
-- Execution stays local: this database holds users, projects, membership and task
-- cards ONLY. No transcripts, no tool events, no secret values, ever.

-- Mirrors @kermanych/core SessionStatus (packages/core/src/types.ts:4-5) exactly.
-- 'backlog' exists only in the cloud; from 'queued' on, the local session is the
-- source of truth and pushes coarse status back.
create type task_status as enum (
  'backlog','queued','thinking','tool','waiting_input',
  'done','error','stopped','merged','conflict');

-- One row per auth.users row, filled by the handle_new_user trigger.
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  github_username text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now());

-- The cloud project. Its id is ALSO the local SQLite projects.id on every machine
-- (spec D1), so a project is one identity across the team.
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  git_remote_url text,                    -- informational only; no auto-clone
  conventions text,
  preview_command text,
  api_command text,
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

-- A task is a card born in the cloud; a session is its local execution.
-- model/prefix/platform/kind/branch are the launch params the assignee's machine
-- feeds into registry.createSession().
create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  title text not null,
  description text,
  status task_status not null default 'backlog',
  assignee_id uuid references profiles(id),
  created_by uuid not null references profiles(id),
  model text,
  prefix text,
  platform text,
  kind text,
  branch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());

create index tasks_project_idx on tasks (project_id);
create index members_user_idx on project_members (user_id);

-- Realtime is the board engine: a status push from anyone's local Nest, or an
-- assignment from anyone's UI, fans out through this publication. RLS still
-- applies, so a member only ever receives rows from their own projects.
alter publication supabase_realtime add table tasks;
```

- [ ] **Step 2: Apply it**

```bash
cd kermanych
supabase db reset
```

Expected: `Applying migration 20260821090000_team_cloud_schema.sql...` then `Finished supabase db reset.` with no error. (`db reset` drops and rebuilds the local database from `supabase/migrations/`, so it is the standard way to apply and re-apply during this plan.)

- [ ] **Step 3: Verify the objects exist**

```bash
DBURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
psql "$DBURL" -c "select tablename from pg_tables where schemaname='public' order by tablename;"
psql "$DBURL" -c "select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='task_status' order by e.enumsortorder;"
psql "$DBURL" -c "select indexname from pg_indexes where schemaname='public' order by indexname;"
psql "$DBURL" -c "select tablename from pg_publication_tables where pubname='supabase_realtime';"
```

Expected, in order:
- four rows: `profiles`, `project_members`, `projects`, `tasks`;
- ten labels starting `backlog` and ending `conflict`;
- index list including `members_user_idx` and `tasks_project_idx` (plus the primary keys);
- one row: `tasks`.

- [ ] **Step 4: Commit**

```bash
git add kermanych/supabase/migrations/20260821090000_team_cloud_schema.sql
git commit -m "feat(cloud): supabase schema for profiles, projects, members, tasks"
```

---

### Task 3: Triggers, membership helper, and `tasks_guard`

**Files:**
- Create: `supabase/migrations/20260821090100_team_cloud_functions.sql`

**Interfaces:**
- Consumes: the tables from Task 2.
- Produces: `public.handle_new_user()`, `public.handle_new_project()`, `public.is_project_member(p uuid, u uuid) returns boolean` (used by every policy in Task 4), `public.tasks_guard()`. Guard error messages other code asserts on: `task is active` and `only the assignee can change status`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260821090100_team_cloud_functions.sql`:

```sql
-- Kermanych team cloud — triggers and the one policy helper.
-- `security definer` is used in exactly three places, each justified inline.

-- First sign-in provisions the profile from GitHub's OAuth metadata. Must be
-- `security definer`: the inserting role is the auth service, not the new user,
-- and profiles has no INSERT policy at all (spec's RLS matrix: "trigger only").
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, github_username, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'user_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The creator of a project is its owner AND its first member, without the client
-- needing a second round trip. `security definer` because project_members' INSERT
-- policy requires an existing owner row, which does not exist yet at this instant.
create or replace function public.handle_new_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

create trigger on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();

-- The single membership predicate every policy calls. `security definer` is
-- REQUIRED: a policy on project_members that queried project_members would
-- recurse. `stable` lets the planner call it once per statement.
create or replace function public.is_project_member(p uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.project_members
    where project_id = p and user_id = u);
$$;

-- Cross-row invariants RLS cannot express. Deliberately NOT `security definer`:
-- it must see auth.uid() of the actual caller.
create or replace function public.tasks_guard()
returns trigger
language plpgsql
as $$
declare
  active_statuses task_status[] := array['queued','thinking','tool','waiting_input']::task_status[];
begin
  if tg_op = 'UPDATE' then
    -- 1. Only the assignee moves a task's status. The self-assign case is allowed
    --    because claim + status can land in one statement, in which case the new
    --    assignee is the caller.
    if new.status is distinct from old.status
       and auth.uid() is distinct from old.assignee_id
       and auth.uid() is distinct from new.assignee_id then
      raise exception 'only the assignee can change status';
    end if;
    -- 2. An active task cannot be handed to someone else mid-run.
    if new.assignee_id is distinct from old.assignee_id
       and old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    -- 3. updated_at is server-owned; the UI reads its age for the stale hint.
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- 2 (delete half). Stop the board first, then delete the card.
    if old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    return old;
  end if;

  return new;
end;
$$;

create trigger tasks_guard_trigger
  before insert or update or delete on public.tasks
  for each row execute function public.tasks_guard();
```

- [ ] **Step 2: Apply it**

```bash
cd kermanych && supabase db reset
```
Expected: both migrations apply, `Finished supabase db reset.`

- [ ] **Step 3: Verify the four routines and their security mode**

```bash
DBURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
psql "$DBURL" -c "select proname, prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('handle_new_user','handle_new_project','is_project_member','tasks_guard') order by proname;"
psql "$DBURL" -c "select tgname from pg_trigger where not tgisinternal order by tgname;"
```

Expected: four rows with `prosecdef` = `t` for `handle_new_project`, `handle_new_user`, `is_project_member` and `f` for `tasks_guard`; three triggers — `on_auth_user_created`, `on_project_created`, `tasks_guard_trigger`.

- [ ] **Step 4: Verify `tasks_guard` refuses a reassignment of an active task**

Run as `postgres` (RLS is not enabled yet, so this isolates the trigger). `auth.uid()` is NULL here, which is exactly the "not the assignee" case:

```bash
DBURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
psql "$DBURL" <<'SQL'
begin;
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'guard@kermanych.test',
        '{"user_name":"guard","full_name":"Guard Tester"}'::jsonb, now(), now());
select github_username, display_name from profiles where id = '11111111-1111-1111-1111-111111111111';
insert into projects (id, name, owner_id)
values ('22222222-2222-2222-2222-222222222222', 'guard proj', '11111111-1111-1111-1111-111111111111');
select role from project_members where project_id = '22222222-2222-2222-2222-222222222222';
insert into tasks (id, project_id, title, status, assignee_id, created_by)
values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
        'busy', 'thinking', '11111111-1111-1111-1111-111111111111',
        '11111111-1111-1111-1111-111111111111');
update tasks set assignee_id = null where id = '33333333-3333-3333-3333-333333333333';
rollback;
SQL
```

Expected output, in order: `guard | Guard Tester` (proves `handle_new_user`), `owner` (proves `handle_new_project`), then `ERROR:  task is active` followed by `ROLLBACK`.

- [ ] **Step 5: Commit**

```bash
git add kermanych/supabase/migrations/20260821090100_team_cloud_functions.sql
git commit -m "feat(cloud): supabase triggers, membership helper and tasks_guard"
```

---

### Task 4: RLS policies

**Files:**
- Create: `supabase/migrations/20260821090200_team_cloud_rls.sql`

**Interfaces:**
- Consumes: `public.is_project_member` (Task 3).
- Produces: RLS enabled on all four tables; `anon` revoked; 14 policies (`profiles` 2, `projects` 4, `project_members` 4, `tasks` 4). Refusal shapes other code asserts on: PostgREST `error.code = '42501'` for a blocked INSERT, and zero affected rows for an UPDATE/DELETE filtered out by a `using` clause.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260821090200_team_cloud_rls.sql`:

```sql
-- Kermanych team cloud — RLS is the ONLY authorization surface. The UI's
-- pre-checks are UX; this file is the security boundary.

alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;

-- Nothing is reachable with the anon key alone. Supabase's default privileges
-- grant new public tables to anon, so this revoke is load-bearing.
revoke all on table public.profiles        from anon;
revoke all on table public.projects        from anon;
revoke all on table public.project_members from anon;
revoke all on table public.tasks           from anon;

-- Grant only the verbs the policy matrix can ever allow. Belt and braces: a
-- missing policy already denies, but a missing grant denies one layer earlier.
grant select, update                         on table public.profiles        to authenticated;
grant select, insert, update, delete         on table public.projects        to authenticated;
grant select, insert, update, delete         on table public.project_members to authenticated;
grant select, insert, update, delete         on table public.tasks           to authenticated;

-- ── profiles ──────────────────────────────────────────────────────────────────
-- Any authenticated user may read any profile: the board shows assignee names
-- and avatars, and members are added by GitHub username.
create policy profiles_select on public.profiles
  for select to authenticated
  using (true);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No INSERT and no DELETE policy: rows arrive only via handle_new_user()
-- (security definer) and leave only by auth.users cascade.

-- ── projects ──────────────────────────────────────────────────────────────────
-- `owner_id = auth.uid() or` is not redundancy: INSERT … RETURNING evaluates the
-- SELECT policy for the returned row BEFORE the AFTER-INSERT trigger has created
-- the owner's project_members row, so createProject().select() would come back
-- empty without it. The owner is always a member, so this widens nothing.
create policy projects_select_member on public.projects
  for select to authenticated
  using (owner_id = auth.uid() or public.is_project_member(id, auth.uid()));

create policy projects_insert_own on public.projects
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy projects_update_owner on public.projects
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy projects_delete_owner on public.projects
  for delete to authenticated
  using (owner_id = auth.uid());

-- ── project_members ───────────────────────────────────────────────────────────
create policy members_select_member on public.project_members
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy members_insert_owner on public.project_members
  for insert to authenticated
  with check (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()));

create policy members_update_owner on public.project_members
  for update to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()));

create policy members_delete_owner on public.project_members
  for delete to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()));

-- ── tasks ─────────────────────────────────────────────────────────────────────
create policy tasks_select_member on public.tasks
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy tasks_insert_member on public.tasks
  for insert to authenticated
  with check (
    public.is_project_member(project_id, auth.uid())
    and created_by = auth.uid());

-- Any member may update (assign, edit, claim); tasks_guard() enforces the
-- cross-row invariants RLS cannot express (assignee-only status, active lock).
create policy tasks_update_member on public.tasks
  for update to authenticated
  using (public.is_project_member(project_id, auth.uid()))
  with check (public.is_project_member(project_id, auth.uid()));

create policy tasks_delete_member on public.tasks
  for delete to authenticated
  using (public.is_project_member(project_id, auth.uid()));
```

- [ ] **Step 2: Apply it**

```bash
cd kermanych && supabase db reset
```
Expected: all three migrations apply, `Finished supabase db reset.`

- [ ] **Step 3: Verify RLS state, policy counts and the anon revoke**

```bash
DBURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
psql "$DBURL" -c "select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname in ('profiles','projects','project_members','tasks') order by relname;"
psql "$DBURL" -c "select tablename, count(*) from pg_policies where schemaname='public' group by tablename order by tablename;"
psql "$DBURL" -c "select has_table_privilege('anon','public.tasks','select') as anon_tasks_select, has_table_privilege('authenticated','public.tasks','select') as auth_tasks_select;"
```

Expected:
- four rows, `relrowsecurity` = `t` for all;
- `profiles 2`, `project_members 4`, `projects 4`, `tasks 4` (14 total);
- `anon_tasks_select = f`, `auth_tasks_select = t`.

- [ ] **Step 4: Commit**

```bash
git add kermanych/supabase/migrations/20260821090200_team_cloud_rls.sql
git commit -m "feat(cloud): RLS policies and anon revoke for the team cloud tables"
```

---

### Task 5: `packages/cloud` package + types + status mapping

**Files:**
- Create: `packages/cloud/package.json`
- Create: `packages/cloud/tsconfig.json`
- Create: `packages/cloud/vitest.config.ts`
- Create: `packages/cloud/src/index.ts`
- Create: `packages/cloud/src/types.ts`
- Create: `packages/cloud/src/status.ts`
- Test: `packages/cloud/test/status.spec.ts`

**Interfaces:**
- Consumes: `SessionStatus` from `@kermanych/core` (`packages/core/src/types.ts:4-5`).
- Produces: package `@kermanych/cloud`. Types `TaskStatus = SessionStatus`, `Profile`, `CloudProject`, `ProjectMember`, `Task`, `TaskInsert`, `TaskPatch`. Functions `taskStatusFromSession(s: Pick<Session,'status'>): TaskStatus`, `isTerminalTaskStatus(s: TaskStatus): boolean`.
- Produces (coordinated hand-off): `packages/cloud/src/index.ts` ships with exactly three barrel lines. Whoever adds a later module appends its own single line — **Plan B** appends `export * from "./projects";`, **Plan C** appends `export * from "./tasks";`. Plan A must not pre-declare those exports (the files do not exist yet and `tsc` would fail).

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/test/status.spec.ts`. Convention copied verbatim from `packages/core/test/worktree-names.spec.ts`: flat `test(...)`, no `describe`, double quotes, relative `../src/<module>` import.

```ts
import { expect, test } from "vitest";
import { taskStatusFromSession, isTerminalTaskStatus } from "../src/status";
import type { TaskStatus } from "../src/types";

const ALL: TaskStatus[] = [
  "backlog", "queued", "thinking", "tool", "waiting_input",
  "done", "error", "stopped", "merged", "conflict",
];

test("taskStatusFromSession is the identity map today", () => {
  for (const status of ALL) {
    expect(taskStatusFromSession({ status })).toBe(status);
  }
});

test("taskStatusFromSession ignores everything except status", () => {
  expect(taskStatusFromSession({ status: "thinking", contextPercent: 42 } as { status: TaskStatus })).toBe("thinking");
});

test("isTerminalTaskStatus marks exactly the five end states", () => {
  expect(ALL.filter(isTerminalTaskStatus)).toEqual(["done", "error", "stopped", "merged", "conflict"]);
});

test("isTerminalTaskStatus rejects the active and backlog states", () => {
  for (const status of ["backlog", "queued", "thinking", "tool", "waiting_input"] as TaskStatus[]) {
    expect(isTerminalTaskStatus(status)).toBe(false);
  }
});
```

- [ ] **Step 2: Create the package manifest, tsconfig and vitest config**

`packages/cloud/package.json` — same script/exports shape as `packages/core/package.json`, plus the two runtime deps:

```json
{
  "name": "@kermanych/cloud", "version": "0.0.0", "private": true,
  "main": "dist/index.js", "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@kermanych/core": "workspace:*",
    "@supabase/supabase-js": "^2"
  },
  "devDependencies": { "vitest": "^2", "typescript": "^5.6", "@types/node": "^22" }
}
```

`packages/cloud/tsconfig.json` — byte-for-byte the same one-liner as `packages/core/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "module": "CommonJS", "moduleResolution": "Node", "outDir": "dist", "rootDir": "src", "declaration": true }, "include": ["src"] }
```

`packages/cloud/vitest.config.ts` — the same two lines as `packages/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.spec.ts"] } });
```

- [ ] **Step 3: Link the package into the workspace**

`pnpm-workspace.yaml` already globs `packages/*`, so nothing to edit there:

```bash
cd kermanych && pnpm install
```

Expected: pnpm reports `+ @kermanych/cloud` and installs `@supabase/supabase-js`.

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm --filter @kermanych/cloud exec vitest run test/status.spec.ts
```
Expected: FAIL — `Cannot find module '../src/status'`.

- [ ] **Step 5: Write `src/types.ts`**

```ts
// packages/cloud/src/types.ts
// Cloud coordination rows in camelCase. Postgres columns are snake_case; the
// mapping lives inside this package (see projects.ts / tasks.ts) and nothing
// outside @kermanych/cloud ever sees a snake_case key.
import type { SessionStatus } from "@kermanych/core";

// Re-exported from core so the cloud enum and the local session enum cannot drift.
// The Postgres type `task_status` carries the same ten labels.
export type TaskStatus = SessionStatus;

export type Profile = {
  id: string;
  githubUsername?: string;
  displayName?: string;
  avatarUrl?: string;
};

export type CloudProject = {
  id: string;
  name: string;
  gitRemoteUrl?: string;
  conventions?: string;
  previewCommand?: string;
  apiCommand?: string;
  defaultBranch?: string;
  carryFiles: string[];
  envKeys: string[]; // key NAMES only — values never leave the bound repo's .env
  color?: string;
  ownerId: string;
  createdAt: string;
};

export type ProjectMember = {
  projectId: string;
  userId: string;
  role: "owner" | "member";
  addedAt: string;
  profile?: Profile; // joined when the caller asks for it
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assigneeId?: string;
  createdBy: string;
  // Launch params the assignee's machine feeds into registry.createSession().
  model?: string;
  prefix?: string;
  platform?: string;
  kind?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskInsert = {
  projectId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  model?: string;
  prefix?: string;
  platform?: string;
  kind?: string;
  branch?: string;
};

export type TaskPatch = {
  title?: string;
  description?: string;
  assigneeId?: string | null; // null clears the assignee
  model?: string;
  prefix?: string;
  platform?: string;
  kind?: string;
  branch?: string;
};
```

- [ ] **Step 6: Write `src/status.ts`**

```ts
// packages/cloud/src/status.ts
// The single seam between the local session vocabulary and the cloud task
// vocabulary. Today it is the identity map; if the two ever diverge, this file is
// the only place that changes.
import type { Session } from "@kermanych/core";
import type { TaskStatus } from "./types";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "done",
  "error",
  "stopped",
  "merged",
  "conflict",
]);

export function taskStatusFromSession(s: Pick<Session, "status">): TaskStatus {
  return s.status;
}

// A terminal task never moves again on its own: the board may stop showing a
// stale-age hint for it, and the outbox may drop pending pushes behind it.
export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return TERMINAL.has(s);
}
```

- [ ] **Step 7: Write the barrel**

`packages/cloud/src/index.ts` — exactly three lines. Plans B and C each append one more (see Interfaces):

```ts
export * from "./types";
export * from "./client";
export * from "./status";
```

`./client` is written in Task 6; until then `tsc` cannot build the package, which is why the build check lives in Task 6 and this task verifies with vitest only (vitest transpiles per file and does not need the barrel).

- [ ] **Step 8: Run tests to verify they pass**

```bash
pnpm --filter @kermanych/cloud exec vitest run test/status.spec.ts
```
Expected: PASS — 4 tests.

- [ ] **Step 9: Commit**

```bash
git add kermanych/packages/cloud kermanych/pnpm-lock.yaml
git commit -m "feat(cloud): new @kermanych/cloud package with task types and status mapping"
```

---

### Task 6: `createCloudClient` / `cloudEnv` + consumer wiring

**Files:**
- Create: `packages/cloud/src/client.ts`
- Test: `packages/cloud/test/client.spec.ts`
- Modify: `apps/api/package.json` (dependencies block)
- Modify: `apps/ui/package.json` (dependencies block)
- Modify: `apps/ui/quasar.config.ts` (`extendViteConf`, lines 25-43)
- Modify: `package.json` (root, `dev:app` script)

**Interfaces:**
- Consumes: `packages/cloud/src/index.ts` (Task 5).
- Produces: `createCloudClient({ url, anonKey, accessToken? }): SupabaseClient`; `cloudEnv(source: 'api' | 'ui', env?): { url: string; anonKey: string }`; re-exported `SupabaseClient` type. `@kermanych/cloud` importable from both `apps/api` and `apps/ui`.

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/test/client.spec.ts`:

```ts
import { expect, test } from "vitest";
import { cloudEnv, createCloudClient } from "../src/client";

test("cloudEnv('api') reads the unprefixed pair", () => {
  const env = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "anon-api" };
  expect(cloudEnv("api", env)).toEqual({ url: "http://127.0.0.1:54321", anonKey: "anon-api" });
});

test("cloudEnv('ui') reads the VITE_ pair and ignores the api pair", () => {
  const env = {
    SUPABASE_URL: "http://wrong",
    SUPABASE_ANON_KEY: "wrong",
    VITE_SUPABASE_URL: "http://127.0.0.1:54321",
    VITE_SUPABASE_ANON_KEY: "anon-ui",
  };
  expect(cloudEnv("ui", env)).toEqual({ url: "http://127.0.0.1:54321", anonKey: "anon-ui" });
});

test("cloudEnv names the missing variables it wants", () => {
  expect(() => cloudEnv("ui", {})).toThrow("set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
  expect(() => cloudEnv("api", { SUPABASE_URL: "http://x" })).toThrow(
    "set SUPABASE_URL and SUPABASE_ANON_KEY",
  );
});

test("createCloudClient with an accessToken pins Authorization and stores no session", () => {
  const client = createCloudClient({
    url: "http://127.0.0.1:54321",
    anonKey: "anon",
    accessToken: "user-jwt",
  });
  // The header is what makes every PostgREST call run under the user's JWT (and
  // therefore under RLS) with no session and no service-role key anywhere.
  const headers = (client as unknown as { headers: Record<string, string> }).headers;
  expect(headers.Authorization).toBe("Bearer user-jwt");
});

test("createCloudClient without an accessToken leaves Authorization to the session", () => {
  const client = createCloudClient({ url: "http://127.0.0.1:54321", anonKey: "anon" });
  const headers = (client as unknown as { headers: Record<string, string> }).headers;
  expect(headers.Authorization).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @kermanych/cloud exec vitest run test/client.spec.ts
```
Expected: FAIL — `Cannot find module '../src/client'`.

- [ ] **Step 3: Implement `src/client.ts`**

```ts
// packages/cloud/src/client.ts
// The only place @supabase/supabase-js is constructed. Two callers, two modes:
//   • ui  — no accessToken: PKCE + persisted session + detectSessionInUrl, so the
//           SDK owns sign-in and refresh.
//   • api — accessToken: a headless client pinned to the user's JWT, no session
//           storage, no refresh. supabase-js only fills Authorization when the
//           request does not already carry it, so this header wins.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

export type CloudEnv = { url: string; anonKey: string };

export type CloudClientOptions = { url: string; anonKey: string; accessToken?: string };

// Vite only inlines VITE_-prefixed variables, and it inlines them into
// import.meta.env — which a CommonJS package cannot read. So the ui passes its
// bag in explicitly (`cloudEnv('ui', import.meta.env)`) while the api falls back
// to process.env.
const KEYS = {
  api: { url: "SUPABASE_URL", anonKey: "SUPABASE_ANON_KEY" },
  ui: { url: "VITE_SUPABASE_URL", anonKey: "VITE_SUPABASE_ANON_KEY" },
} as const;

export function cloudEnv(
  source: "api" | "ui",
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): CloudEnv {
  const keys = KEYS[source];
  const url = env[keys.url];
  const anonKey = env[keys.anonKey];
  if (!url || !anonKey) {
    throw new Error(`cloud env missing: set ${keys.url} and ${keys.anonKey}`);
  }
  return { url, anonKey };
}

export function createCloudClient({ url, anonKey, accessToken }: CloudClientOptions): SupabaseClient {
  const headless = accessToken !== undefined;
  return createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: !headless,
      persistSession: !headless,
      autoRefreshToken: !headless,
    },
    global: headless ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @kermanych/cloud exec vitest run
```
Expected: PASS — 9 tests across `status.spec.ts` and `client.spec.ts`.

- [ ] **Step 5: Build the package**

```bash
pnpm --filter @kermanych/cloud build
```
Expected: no output, and `packages/cloud/dist/{index,types,client,status}.{js,d.ts}` now exist. (`tsconfig.json` has `include: ["src"]`, so `test/` is not compiled.)

- [ ] **Step 6: Add the dependency to `apps/api`**

In `apps/api/package.json`, replace the first two lines of `"dependencies"`:

```json
    "@kermanych/cloud": "workspace:*",
    "@kermanych/core": "workspace:*",
    "@supabase/supabase-js": "^2",
```

(`@supabase/supabase-js` is listed explicitly because `AuthService` imports the `SupabaseClient` type directly rather than relying on a transitive resolution.)

- [ ] **Step 7: Add the dependency to `apps/ui`**

In `apps/ui/package.json`, replace the first three lines of `"dependencies"`:

```json
    "@kermanych/api": "workspace:*",
    "@kermanych/cloud": "workspace:*",
    "@kermanych/core": "workspace:*",
    "@kermanych/tokens": "workspace:*",
    "@supabase/supabase-js": "^2",
```

- [ ] **Step 8: Teach Vite about the new CJS workspace dep**

`@kermanych/cloud` has exactly the problem the existing comment in `apps/ui/quasar.config.ts` describes for `@kermanych/core`: it resolves to a real path outside `node_modules`, so Vite treats it as raw source and skips CJS→ESM interop. Replace the `extendViteConf` body (lines 33-42):

```ts
      extendViteConf(viteConf) {
        viteConf.build ??= {};
        viteConf.build.commonjsOptions = {
          ...viteConf.build.commonjsOptions,
          include: [/node_modules/, /packages[/\\]core[/\\]dist/, /packages[/\\]cloud[/\\]dist/],
        };
        viteConf.optimizeDeps ??= {};
        viteConf.optimizeDeps.include = [
          ...(viteConf.optimizeDeps.include ?? []),
          '@kermanych/core',
          '@kermanych/core/status',
          '@kermanych/cloud',
        ];
      },
```

- [ ] **Step 9: Make the Electron dev script build the new package**

`apps/ui/src-electron/electron-main.ts:5` imports `@kermanych/api` from its `dist`, and that dist now imports `@kermanych/cloud`'s dist. In the root `package.json`, replace the `dev:app` script:

```json
    "dev:app": "pnpm --filter @kermanych/core build && pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/api build && pnpm --filter @kermanych/ui dev -m electron",
```

- [ ] **Step 10: Install and verify both consumers resolve the package**

```bash
cd kermanych && pnpm install
node -e "console.log(Object.keys(require('@kermanych/cloud')))" --input-type=commonjs 2>/dev/null \
  || (cd apps/api && node -e "console.log(Object.keys(require('@kermanych/cloud')))")
pnpm --filter @kermanych/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```

Expected: the `require` prints an array containing `cloudEnv`, `createCloudClient`, `taskStatusFromSession`, `isTerminalTaskStatus`; both type-checks report no errors.

- [ ] **Step 11: Commit**

```bash
git add kermanych/packages/cloud/src/client.ts kermanych/packages/cloud/test/client.spec.ts \
        kermanych/apps/api/package.json kermanych/apps/ui/package.json \
        kermanych/apps/ui/quasar.config.ts kermanych/package.json kermanych/pnpm-lock.yaml
git commit -m "feat(cloud): createCloudClient/cloudEnv and wire @kermanych/cloud into api and ui"
```

---

### Task 7: RLS + trigger integration suite

**Files:**
- Test: `packages/cloud/test/rls.spec.ts`

**Interfaces:**
- Consumes: the local stack and all three migrations (Tasks 1-4); `createClient` from `@supabase/supabase-js`.
- Produces: an opt-in integration suite. It is the ONLY file in the repo that touches a service-role key, read from `SUPABASE_TEST_SERVICE_KEY`; it is a test fixture and is never imported by shipped code.

- [ ] **Step 1: Write the suite**

Create `packages/cloud/test/rls.spec.ts`:

```ts
// packages/cloud/test/rls.spec.ts
// Integration suite against a LOCAL Supabase stack (`supabase start`). Skipped
// unless the three SUPABASE_TEST_* variables are set, so `pnpm -r test` stays
// green on a machine without Docker.
//
// The service-role key is used ONLY to mint test users through the admin API —
// the same thing GitHub OAuth would do — and never to bypass a policy under
// test. Every assertion below runs through an anon-key client carrying a real
// user JWT, exactly like the shipped app.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;

type TestUser = { id: string; client: SupabaseClient };

describe.skipIf(!URL || !ANON || !SERVICE)("supabase RLS and triggers", () => {
  const admin = createClient(URL ?? "", SERVICE ?? "", {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let projectId: string;
  let taskId: string;

  async function makeUser(tag: string): Promise<TestUser> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${tag}-${stamp}@kermanych.test`;
    const password = "kermanych-test-password";
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        user_name: `${tag}-${stamp}`,
        full_name: `${tag} Tester`,
        avatar_url: `https://example.test/${tag}.png`,
      },
    });
    if (created.error) throw created.error;
    const client = createClient(URL ?? "", ANON ?? "", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    return { id: created.data.user.id, client };
  }

  beforeAll(async () => {
    owner = await makeUser("owner");
    member = await makeUser("member");
    outsider = await makeUser("outsider");

    const project = await owner.client
      .from("projects")
      .insert({ name: "rls-suite", owner_id: owner.id })
      .select()
      .single();
    if (project.error) throw project.error;
    projectId = project.data.id as string;

    const task = await owner.client
      .from("tasks")
      .insert({ project_id: projectId, title: "rls task", created_by: owner.id })
      .select()
      .single();
    if (task.error) throw task.error;
    taskId = task.data.id as string;
  }, 30_000);

  it("handle_new_user fills profiles from the GitHub metadata", async () => {
    const { data, error } = await owner.client
      .from("profiles")
      .select("id, github_username, display_name, avatar_url")
      .eq("id", owner.id)
      .single();
    expect(error).toBeNull();
    expect(data?.display_name).toBe("owner Tester");
    expect(data?.github_username).toMatch(/^owner-/);
    expect(data?.avatar_url).toBe("https://example.test/owner.png");
  });

  it("handle_new_project inserts the creator as owner-member", async () => {
    const { data, error } = await owner.client
      .from("project_members")
      .select("user_id, role")
      .eq("project_id", projectId);
    expect(error).toBeNull();
    expect(data).toEqual([{ user_id: owner.id, role: "owner" }]);
  });

  it("a non-member sees zero projects and zero tasks", async () => {
    const projects = await outsider.client.from("projects").select("id").eq("id", projectId);
    expect(projects.error).toBeNull();
    expect(projects.data).toEqual([]);

    const tasks = await outsider.client.from("tasks").select("id").eq("project_id", projectId);
    expect(tasks.error).toBeNull();
    expect(tasks.data).toEqual([]);
  });

  it("the anon key with no session sees nothing", async () => {
    const anonymous = createClient(URL ?? "", ANON ?? "", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anonymous.from("tasks").select("id");
    // Either a permission error or an empty set is acceptable; a row is not.
    expect(error ? [] : data).toEqual([]);
  });

  it("a non-owner cannot add a project member", async () => {
    const { error } = await outsider.client
      .from("project_members")
      .insert({ project_id: projectId, user_id: outsider.id, role: "member" });
    expect(error?.code).toBe("42501");
  });

  it("the owner can add a member, who then sees the project's tasks", async () => {
    const added = await owner.client
      .from("project_members")
      .insert({ project_id: projectId, user_id: member.id, role: "member" });
    expect(added.error).toBeNull();

    const tasks = await member.client.from("tasks").select("id").eq("project_id", projectId);
    expect(tasks.error).toBeNull();
    expect(tasks.data?.map((t) => t.id)).toEqual([taskId]);
  });

  it("a non-assignee cannot change a task's status", async () => {
    const assigned = await owner.client
      .from("tasks")
      .update({ assignee_id: member.id })
      .eq("id", taskId);
    expect(assigned.error).toBeNull();

    // owner is a member (so the UPDATE policy lets the row through) but not the
    // assignee, so tasks_guard raises.
    const { error } = await owner.client.from("tasks").update({ status: "queued" }).eq("id", taskId);
    expect(error?.message).toContain("only the assignee can change status");
  });

  it("an active task cannot be reassigned", async () => {
    const started = await member.client
      .from("tasks")
      .update({ status: "thinking" })
      .eq("id", taskId);
    expect(started.error).toBeNull();

    const { error } = await owner.client
      .from("tasks")
      .update({ assignee_id: owner.id })
      .eq("id", taskId);
    expect(error?.message).toContain("task is active");
  });

  it("an active task cannot be deleted", async () => {
    const { error } = await owner.client.from("tasks").delete().eq("id", taskId);
    expect(error?.message).toContain("task is active");
  });

  it("a finished task can be deleted", async () => {
    const finished = await member.client.from("tasks").update({ status: "done" }).eq("id", taskId);
    expect(finished.error).toBeNull();

    const { error } = await owner.client.from("tasks").delete().eq("id", taskId);
    expect(error).toBeNull();
  });
});
```

- [ ] **Step 2: Run it skipped, to prove the gate works**

```bash
cd kermanych
env -u SUPABASE_TEST_URL -u SUPABASE_TEST_ANON_KEY -u SUPABASE_TEST_SERVICE_KEY \
  pnpm --filter @kermanych/cloud exec vitest run
```

Expected: `Test Files 3 passed | ... skipped`, with `rls.spec.ts` reporting 10 skipped tests. The unit suites still pass.

- [ ] **Step 3: Run it for real against the local stack**

```bash
cd kermanych
supabase start                       # if not already running
supabase db reset                    # a clean database, all three migrations
export SUPABASE_TEST_URL=http://127.0.0.1:54321
export SUPABASE_TEST_ANON_KEY="<anon key from supabase status>"
export SUPABASE_TEST_SERVICE_KEY="<service_role key from supabase status>"
pnpm --filter @kermanych/cloud exec vitest run test/rls.spec.ts
```

Expected: `✓ test/rls.spec.ts (10 tests)` and `Tests  10 passed (10)` — the ten `it` titles listed above, in order.

If `handle_new_user fills profiles` fails with a null row, the `on_auth_user_created` trigger did not run: `supabase db reset` was skipped after Task 3, or the users were created before that migration.

- [ ] **Step 4: Commit**

```bash
git add kermanych/packages/cloud/test/rls.spec.ts
git commit -m "test(cloud): RLS and trigger integration suite against the local stack"
```

---

### Task 8: `auth_session` in the local registry

**Files:**
- Modify: `apps/api/src/registry/registry.service.ts` (new `CREATE TABLE` after line 26; new methods after `removeSession`, line 229-231)
- Test: `apps/api/test/registry.auth.spec.ts`

**Interfaces:**
- Produces: `AuthSessionRow = { userId: string; accessToken: string; expiresAt?: string; githubUsername?: string }`; `getAuthSession(): AuthSessionRow | undefined`; `setAuthSession(row: AuthSessionRow): void`; `clearAuthSession(): void`.
- Coordinated: **Plan B** later adds a versioned `user_version` 0→1 migration to this same file that renames `groups` → `projects`. The `auth_session` table added here is additive and independent of that rename; keep it in the `CREATE TABLE IF NOT EXISTS` block so Plan B's migration runs after it. **Plan D** later adds `status_outbox` and its four methods to the same file.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/registry.auth.spec.ts`. Convention from `apps/api/test/registry.spec.ts`: a real `new RegistryService(":memory:")` per test, no fixtures, no teardown, always re-read to prove the round-trip.

```ts
import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

test("auth_session starts empty and round-trips a full row", () => {
  const r = new RegistryService(":memory:");
  expect(r.getAuthSession()).toBeUndefined();

  r.setAuthSession({
    userId: "u-1",
    accessToken: "jwt-1",
    expiresAt: "2026-08-21T12:00:00.000Z",
    githubUsername: "octocat",
  });

  expect(r.getAuthSession()).toEqual({
    userId: "u-1",
    accessToken: "jwt-1",
    expiresAt: "2026-08-21T12:00:00.000Z",
    githubUsername: "octocat",
  });
});

test("auth_session holds at most one row — a second set replaces the first", () => {
  const r = new RegistryService(":memory:");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1", expiresAt: "2026-08-21T12:00:00.000Z" });
  r.setAuthSession({ userId: "u-2", accessToken: "jwt-2" });

  const cur = r.getAuthSession();
  expect(cur?.userId).toBe("u-2");
  expect(cur?.accessToken).toBe("jwt-2");
  expect(cur?.expiresAt).toBeUndefined();
  expect(cur?.githubUsername).toBeUndefined();
});

test("clearAuthSession removes the cached token", () => {
  const r = new RegistryService(":memory:");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1" });
  r.clearAuthSession();
  expect(r.getAuthSession()).toBeUndefined();
  // Idempotent: signing out twice must not throw.
  r.clearAuthSession();
  expect(r.getAuthSession()).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @kermanych/api exec vitest run test/registry.auth.spec.ts
```
Expected: FAIL — `r.getAuthSession is not a function`.

- [ ] **Step 3: Create the table**

In `apps/api/src/registry/registry.service.ts`, immediately after the `sessions` `CREATE TABLE IF NOT EXISTS` block (after line 26, before the `// Additive migration: preview commands…` comment at line 27), insert:

```ts
    // The one cached Supabase session for this machine. Single-row by construction
    // (CHECK id = 1): one developer per Kermanych install. The guard compares the
    // presented bearer against access_token; expires_at is informational for the
    // UI, because an expired token must still control the LOCAL machine (spec D4).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS auth_session (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL, access_token TEXT NOT NULL, expires_at TEXT, github_username TEXT)`,
    );
```

- [ ] **Step 4: Add the type and the three methods**

At the top of the file, after the `import type { Group, Session, SessionStatus } from "@kermanych/core";` line (line 8), add:

```ts

// The cached Supabase session. Lives in SQLite so a restarted api still knows who
// its user is without a cloud round trip.
export type AuthSessionRow = {
  userId: string;
  accessToken: string;
  expiresAt?: string;
  githubUsername?: string;
};
```

Then, after `removeSession` (lines 229-231) and before the closing `}` of the class, add:

```ts

  getAuthSession(): AuthSessionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id as userId, access_token as accessToken, expires_at as expiresAt, github_username as githubUsername FROM auth_session WHERE id = 1`,
      )
      .get() as AuthSessionRow | undefined;
    if (!row) return undefined;
    return { ...row, expiresAt: row.expiresAt ?? undefined, githubUsername: row.githubUsername ?? undefined };
  }

  setAuthSession(row: AuthSessionRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO auth_session (id, user_id, access_token, expires_at, github_username) VALUES (1,?,?,?,?)`,
      )
      .run(row.userId, row.accessToken, row.expiresAt ?? null, row.githubUsername ?? null);
  }

  clearAuthSession(): void {
    this.db.prepare(`DELETE FROM auth_session WHERE id = 1`).run();
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @kermanych/api exec vitest run test/registry.auth.spec.ts test/registry.spec.ts
```
Expected: PASS — 3 new tests plus the 13 existing registry tests, all green.

- [ ] **Step 6: Commit**

```bash
git add kermanych/apps/api/src/registry/registry.service.ts kermanych/apps/api/test/registry.auth.spec.ts
git commit -m "feat(api): cache the Supabase session in a single-row auth_session table"
```

---

### Task 9: `AuthService`, `@Public()`, and `SupabaseAuthGuard`

**Files:**
- Create: `apps/api/src/auth/auth.service.ts`
- Create: `apps/api/src/auth/public.decorator.ts`
- Create: `apps/api/src/auth/auth.guard.ts`
- Test: `apps/api/test/auth.guard.spec.ts`

**Interfaces:**
- Consumes: `getAuthSession`/`setAuthSession`/`clearAuthSession` (Task 8); `createCloudClient`, `cloudEnv` (Task 6).
- Produces:
  - `AuthService.setToken(accessToken: string): Promise<{ userId: string; githubUsername?: string }>`
  - `AuthService.clear(): void`
  - `AuthService.current(): { userId: string; accessToken: string; expiresAt?: string; githubUsername?: string } | undefined`
  - `AuthService.cloudClient(): SupabaseClient` — throws `new Error("not signed in")` when no session is cached.
  - `AuthService.onToken(cb: (auth: { userId: string; accessToken: string }) => void): void` — listeners fire at the END of a successful `setToken`, after the `auth_session` row is written. **Plan D**'s `CloudSyncService` registers here in `onModuleInit` to re-drain the status outbox on relogin/token refresh.
  - `CloudClientFactory` — the injectable seam tests use instead of a live network.
  - `IS_PUBLIC_KEY`, `Public()`.
  - `SupabaseAuthGuard` — sets `req.user = { id: string }` on every authorized request.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/auth.guard.spec.ts`. The repo has no `@nestjs/testing` and no HTTP e2e harness (`apps/api/vitest.config.ts` is only an include glob), so the guard is exercised through `canActivate` with a hand-rolled `ExecutionContext`, and `AuthService` gets a stub client factory through its `@Optional()` constructor parameter — the same trick `RegistryService(":memory:")` uses.

```ts
import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RegistryService } from "../src/registry/registry.service";
import { AuthService, type CloudClientFactory } from "../src/auth/auth.service";
import { SupabaseAuthGuard } from "../src/auth/auth.guard";
import { Public } from "../src/auth/public.decorator";

// cloudEnv("api") reads these; the stub factory never dials out.
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

// A JWT-shaped string. `getClaims` normally verifies the signature against the
// project's JWKS; the stub below stands in for that, and `jwtExpiry` only ever
// reads the `exp` claim. Deliberately no jose/JWKS dependency (spec D4).
function jwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "ES256", typ: "JWT" })}.${seg(payload)}.sig`;
}

const FRESH = jwt({ sub: "u-1", exp: Math.floor(Date.now() / 1000) + 3600 });
const EXPIRED = jwt({ sub: "u-1", exp: 1_000 });

// getClaims succeeds only for the tokens in `accept`; everything else looks like
// an invalid token, and `offline` makes every call look like a dead network.
// getUser is stubbed too, because AuthService falls back to it when getClaims
// returns `{ data: null, error: null }` (symmetric-secret projects).
function factory(accept: Record<string, string>, offline = false): CloudClientFactory {
  return () =>
    ({
      auth: {
        getClaims: async (token?: string) => {
          if (offline) throw new Error("fetch failed");
          const userId = token ? accept[token] : undefined;
          if (!userId) return { data: null, error: { message: "invalid JWT" } };
          const exp = JSON.parse(
            Buffer.from(token!.split(".")[1]!, "base64url").toString("utf8"),
          ) as { exp?: number };
          return {
            data: {
              claims: { sub: userId, exp: exp.exp, user_metadata: { user_name: "octocat" } },
              header: { alg: "ES256" },
              signature: new Uint8Array(),
            },
            error: null,
          };
        },
        getUser: async (token?: string) => {
          if (offline) throw new Error("fetch failed");
          const userId = token ? accept[token] : undefined;
          if (!userId) return { data: { user: null }, error: { message: "invalid JWT" } };
          return { data: { user: { id: userId, user_metadata: { user_name: "octocat" } } }, error: null };
        },
      },
    }) as unknown as SupabaseClient;
}

function ctx(
  headers: Record<string, string | undefined>,
  handler: object = () => undefined,
): { context: ExecutionContext; req: { headers: typeof headers; user?: { id: string } } } {
  const req: { headers: typeof headers; user?: { id: string } } = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { context, req };
}

class ProbeController {
  @Public()
  open() {
    return "ok";
  }

  guarded() {
    return "ok";
  }
}

test("a request with no Authorization header is rejected", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({}));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context } = ctx({});
  await expect(guard.canActivate(context)).rejects.toThrow("missing bearer token");
});

test("an unknown token with no reachable cloud is rejected", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-1" }, true));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context } = ctx({ authorization: `Bearer ${FRESH}` });
  await expect(guard.canActivate(context)).rejects.toThrow("invalid access token");
});

test("the cached token passes and exposes the user id on the request", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-1" }));
  await auth.setToken(FRESH);
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context, req } = ctx({ authorization: `Bearer ${FRESH}` });
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(req.user).toEqual({ id: "u-1" });
});

test("an EXPIRED cached token still controls the local machine (offline rule)", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [EXPIRED]: "u-1" }));
  await auth.setToken(EXPIRED);
  expect(auth.current()?.expiresAt).toBe(new Date(1_000_000).toISOString());

  // Cloud is gone now, and the token is long expired — local control must survive.
  const offline = new AuthService(reg, factory({}, true));
  const guard = new SupabaseAuthGuard(offline, new Reflector());
  const { context, req } = ctx({ authorization: `Bearer ${EXPIRED}` });
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(req.user).toEqual({ id: "u-1" });
});

test("an unknown but valid token is adopted by one online re-validation", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-9" }));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context, req } = ctx({ authorization: `Bearer ${FRESH}` });
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(req.user).toEqual({ id: "u-9" });
  expect(reg.getAuthSession()?.accessToken).toBe(FRESH);
});

test("a @Public() handler bypasses the guard entirely", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({}));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const open = ctx({}, ProbeController.prototype.open);
  await expect(guard.canActivate(open.context)).resolves.toBe(true);

  const guarded = ctx({}, ProbeController.prototype.guarded);
  await expect(guard.canActivate(guarded.context)).rejects.toThrow("missing bearer token");
});

test("onToken listeners fire after the row is written, and clear() fires nothing", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-1" }));
  const seen: { userId: string; accessToken: string; persisted?: string }[] = [];
  auth.onToken((a) => seen.push({ ...a, persisted: reg.getAuthSession()?.accessToken }));

  await auth.setToken(FRESH);
  expect(seen).toEqual([{ userId: "u-1", accessToken: FRESH, persisted: FRESH }]);

  auth.clear();
  expect(seen).toHaveLength(1);
  expect(reg.getAuthSession()).toBeUndefined();
  expect(() => auth.cloudClient()).toThrow("not signed in");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @kermanych/api exec vitest run test/auth.guard.spec.ts
```
Expected: FAIL — `Cannot find module '../src/auth/auth.service'`.

- [ ] **Step 3: Implement `public.decorator.ts`**

```ts
// apps/api/src/auth/public.decorator.ts
import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "kermanych:isPublic";

// SupabaseAuthGuard is registered as APP_GUARD, so it covers every route in the
// app. @Public() is the only escape hatch: it marks the handful of endpoints that
// must work before a token exists — today just POST /api/auth/session.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 4: Implement `auth.service.ts`**

```ts
// apps/api/src/auth/auth.service.ts
import { Injectable, Optional } from "@nestjs/common";
import { cloudEnv, createCloudClient } from "@kermanych/cloud";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RegistryService, type AuthSessionRow } from "../registry/registry.service";

export type CloudClientFactory = (opts: {
  url: string;
  anonKey: string;
  accessToken?: string;
}) => SupabaseClient;

export type TokenListener = (auth: { userId: string; accessToken: string }) => void;

// Read the exp claim out of the token text. `getClaims` already VERIFIED the
// signature (locally, against the project's JWKS), so this is pure extraction
// for the fallback path. Deliberately no jose/JWKS dependency (spec D4).
function jwtExpiry(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class AuthService {
  private cached: AuthSessionRow | undefined;
  private client: SupabaseClient | undefined;
  private tokenListeners: TokenListener[] = [];

  // The factory parameter is @Optional() so tests can construct the service
  // directly with a stub, the same way RegistryService takes ":memory:".
  constructor(
    private registry: RegistryService,
    @Optional() private makeClient: CloudClientFactory = createCloudClient,
  ) {
    // A restarted api still knows its user: no cloud round trip on boot.
    this.cached = this.registry.getAuthSession();
  }

  onToken(cb: TokenListener): void {
    this.tokenListeners.push(cb);
  }

  // Validate ONCE, then cache. `getClaims` verifies the JWT locally against the
  // SDK's cached JWKS — no round trip for asymmetric-signing projects — and the
  // guard then only string-compares, so local session control never depends on
  // cloud reachability. A project still on a symmetric JWT secret makes
  // getClaims return `{ data: null, error: null }`; that is the documented
  // "cannot verify locally" signal, and we fall back to getUser().
  async setToken(accessToken: string): Promise<{ userId: string; githubUsername?: string }> {
    const { url, anonKey } = cloudEnv("api");
    const client = this.makeClient({ url, anonKey, accessToken });

    const verified = await client.auth.getClaims(accessToken);
    if (verified.error) throw new Error(verified.error.message);

    let row: AuthSessionRow;
    if (verified.data) {
      const claims = verified.data.claims as {
        sub: string;
        exp?: number;
        user_metadata?: { user_name?: string };
      };
      row = {
        userId: claims.sub,
        accessToken,
        expiresAt: typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined,
        githubUsername: claims.user_metadata?.user_name,
      };
    } else {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data.user) throw new Error(error?.message ?? "invalid access token");
      const meta = (data.user.user_metadata ?? {}) as { user_name?: string };
      row = {
        userId: data.user.id,
        accessToken,
        expiresAt: jwtExpiry(accessToken),
        githubUsername: meta.user_name,
      };
    }

    this.registry.setAuthSession(row);
    this.cached = row;
    this.client = client;
    // Fired last, so a listener that immediately drains the outbox already sees
    // the persisted row and a working cloudClient().
    for (const cb of this.tokenListeners) cb({ userId: row.userId, accessToken });
    return { userId: row.userId, githubUsername: row.githubUsername };
  }

  clear(): void {
    this.registry.clearAuthSession();
    this.cached = undefined;
    this.client = undefined;
  }

  current(): AuthSessionRow | undefined {
    return this.cached;
  }

  // A Supabase client pinned to the user's JWT. RLS is the authorization surface;
  // there is no service-role key on this machine.
  cloudClient(): SupabaseClient {
    const cur = this.cached;
    if (!cur) throw new Error("not signed in");
    if (!this.client) {
      const { url, anonKey } = cloudEnv("api");
      this.client = this.makeClient({ url, anonKey, accessToken: cur.accessToken });
    }
    return this.client;
  }
}
```

- [ ] **Step 5: Implement `auth.guard.ts`**

```ts
// apps/api/src/auth/auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "./auth.service";
import { IS_PUBLIC_KEY } from "./public.decorator";

type GuardedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: { id: string };
};

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private auth: AuthService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<GuardedRequest>();
    const raw = req.headers.authorization ?? req.headers.Authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (!token) throw new UnauthorizedException("missing bearer token");

    const cur = this.auth.current();
    // A cached-token match wins UNCONDITIONALLY — expiry included. The machine's
    // owner is unambiguous, and refusing local session control because a JWT aged
    // out (or because Supabase is unreachable) would break Requirement 7. Cloud
    // freshness only gates cloud pushes, which queue in the outbox instead.
    if (cur && cur.accessToken === token) {
      req.user = { id: cur.userId };
      return true;
    }

    // Unknown token — usually a refresh the UI has not handed over yet. Spend one
    // online validation on it; offline or genuinely invalid means 401.
    try {
      const { userId } = await this.auth.setToken(token);
      req.user = { id: userId };
      return true;
    } catch {
      throw new UnauthorizedException("invalid access token");
    }
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @kermanych/api exec vitest run test/auth.guard.spec.ts
```
Expected: PASS — 7 tests.

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/api/src/auth/auth.service.ts kermanych/apps/api/src/auth/auth.guard.ts \
        kermanych/apps/api/src/auth/public.decorator.ts kermanych/apps/api/test/auth.guard.spec.ts
git commit -m "feat(api): AuthService token cache and SupabaseAuthGuard with offline acceptance"
```

---

### Task 10: `/api/auth/session` routes and global guard registration

**Files:**
- Create: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/app.module.ts` (whole file)

**Interfaces:**
- Consumes: `AuthService`, `SupabaseAuthGuard`, `Public` (Task 9).
- Produces: `POST /api/auth/session { accessToken }` → `{ userId, githubUsername? }` (public); `DELETE /api/auth/session` → `{ ok: true }` (guarded); `GET /api/auth/session` → `{ signedIn: boolean; userId?; githubUsername?; expiresAt? }` (guarded). Every other one of the api's 34 routes now requires `Authorization: Bearer <token>`.
- Coordinated: **Plan B** replaces the `GroupsController` import/entry with `ProjectsController` in this file (forced by its file rename). **Plan D** appends `CloudSyncService` to `providers`. Neither touches the guard wiring added here.

- [ ] **Step 1: Write the controller**

Create `apps/api/src/auth/auth.controller.ts`, following the repo's controller idiom (manual try/catch → `BadRequestException`, no validation pipe — none is installed):

```ts
// apps/api/src/auth/auth.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  // The ONE public route: the UI cannot present a bearer token before it has
  // handed one over. Everything after this is guarded.
  @Public()
  @Post("session")
  async setSession(@Body() body: { accessToken: string }) {
    try {
      if (!body?.accessToken) throw new Error("accessToken is required");
      return await this.auth.setToken(body.accessToken);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // Guarded on purpose: sign-out must be presented by the signed-in token, so a
  // stray request cannot log the machine out. The UI sends this BEFORE it drops
  // its local copy of the token.
  @Delete("session")
  clearSession() {
    this.auth.clear();
    return { ok: true };
  }

  @Get("session")
  getSession() {
    const cur = this.auth.current();
    if (!cur) return { signedIn: false };
    return {
      signedIn: true,
      userId: cur.userId,
      githubUsername: cur.githubUsername,
      expiresAt: cur.expiresAt,
    };
  }
}
```

- [ ] **Step 2: Wire the module**

Replace the whole of `apps/api/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth/auth.controller";
import { GroupsController } from "./http/groups.controller";
import { SessionsController } from "./http/sessions.controller";
import { FsController } from "./http/fs.controller";
import { AuthService } from "./auth/auth.service";
import { RegistryService } from "./registry/registry.service";
import { WorktreeService } from "./worktree/worktree.service";
import { SupervisorService } from "./supervisor/supervisor.service";
import { EventsGateway } from "./ws/events.gateway";
import { PreviewService } from "./preview/preview.service";
import { EnvFileService } from "./env/env-file.service";
import { SupabaseAuthGuard } from "./auth/auth.guard";

@Module({
  controllers: [AuthController, GroupsController, SessionsController, FsController],
  providers: [
    AuthService,
    RegistryService,
    WorktreeService,
    SupervisorService,
    PreviewService,
    EnvFileService,
    EventsGateway,
    // Global by design: the api binds 127.0.0.1 but was previously drivable by
    // anything on the machine, including GET /fs/list (arbitrary local directory
    // enumeration). Opt out per route with @Public(), never per module.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
  ],
})
export class AppModule {}
```

> The spec also names `GET /api/health` as `@Public()`. That route does not exist in this repo (`apps/api` has 34 routes across `SessionsController`, `GroupsController`, `FsController`; none is a health check), so there is nothing to mark. Do not invent one.

- [ ] **Step 3: Type-check and run the full api suite**

```bash
pnpm --filter @kermanych/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @kermanych/api exec vitest run
```
Expected: no type errors; every existing spec still passes (they construct services directly and never go through the HTTP layer, so the guard does not affect them).

- [ ] **Step 4: Smoke the routes against a real api**

The api needs `SUPABASE_URL` / `SUPABASE_ANON_KEY` to validate a token, and a real user JWT. Get one from the local stack (this is the only place in this task where the service key is used, to mint a throwaway user; it never leaves your shell):

```bash
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY="<anon key from supabase status>"
SERVICE="<service_role key from supabase status>"

# Mint a throwaway user and grab its access token.
curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE" -H "authorization: Bearer $SERVICE" -H 'content-type: application/json' \
  -d '{"email":"smoke@kermanych.test","password":"kermanych-test-password","email_confirm":true,"user_metadata":{"user_name":"smoke"}}' > /dev/null
TOKEN=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H 'content-type: application/json' \
  -d '{"email":"smoke@kermanych.test","password":"kermanych-test-password"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).access_token))")
echo "${TOKEN:0:12}…"
```

Then, in one terminal `pnpm dev:api`, and in another:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/groups
curl -s -X POST localhost:4317/api/auth/session -H 'content-type: application/json' \
  -d "{\"accessToken\":\"$TOKEN\"}"; echo
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" localhost:4317/api/groups
curl -s -H "authorization: Bearer $TOKEN" localhost:4317/api/auth/session; echo
curl -s -X DELETE -H "authorization: Bearer $TOKEN" localhost:4317/api/auth/session; echo
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" localhost:4317/api/groups
```

Expected, in order:
1. `401` — unauthenticated read is now refused;
2. `{"userId":"…","githubUsername":"smoke"}` — the public handoff route works;
3. `200` — the same read succeeds with the bearer;
4. `{"signedIn":true,"userId":"…","githubUsername":"smoke","expiresAt":"20…"}`;
5. `{"ok":true}`;
6. `401` — after sign-out the cached token is gone, so the token no longer matches and the offline re-validation attempt is the only path left (it succeeds only while Supabase is reachable — expect `200` if the stack is up and `401` if you stop it; either proves the cache was cleared, so treat a `200` here as pass and re-run with `supabase stop` if you want the strict `401`).

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api/src/auth/auth.controller.ts kermanych/apps/api/src/app.module.ts
git commit -m "feat(api): /api/auth/session routes and a global SupabaseAuthGuard"
```

---

### Task 11: `lib/api.ts` — bearer token on every call, 401 handling

**Files:**
- Modify: `apps/ui/src/lib/api.ts` (BASE block 16-19; `toError` 26-44; `post`/`get`/`put` 46-72; the five inline `fetch` sites — `deleteGroup` 78-81, `deleteSession` 112-113, `updateGroup` 121-132, `stopPreview` 148-149, `updateTask` 194-202)

**Interfaces:**
- Consumes: `POST`/`DELETE`/`GET /api/auth/session` (Task 10).
- Produces: `setAuthToken(token: string | undefined): void`; `setUnauthorizedHandler(fn: () => void): void`; `api.authSession(accessToken): Promise<{ userId: string; githubUsername?: string }>`; `api.clearAuthSession(): Promise<void>`; `api.getAuthSession(): Promise<{ signedIn: boolean; userId?: string; githubUsername?: string; expiresAt?: string }>`. `api.deleteSession` changes from `Promise<Response>` (unchecked!) to `Promise<void>` (checked) — all four call sites (`WorkspacePage.vue:860,881,986,1136`) already ignore the resolved value, so nothing else changes.
- Coordinated: **Plan B** renames the group wrappers in this file to project wrappers and adds `setProjectBinding`; **Plan D** adds `createSessionFromTask`. Both build on the helpers introduced here.

- [ ] **Step 1: Add the token/401 plumbing**

In `apps/ui/src/lib/api.ts`, immediately after the `BASE` constant (after line 19) and before `export type MessageMode`, insert:

```ts
// The local API is guarded by SupabaseAuthGuard: every route except
// POST /auth/session needs the user's Supabase access token. boot/supabase.ts
// pushes the token in here on every auth state change, so this module never
// imports the auth store (that would be circular: store → api → store).
let authToken: string | undefined;
let onUnauthorized: (() => void) | undefined;

export function setAuthToken(token: string | undefined): void {
  authToken = token;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function authHeaders(json: boolean): Record<string, string> {
  const h: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
  if (authToken) h.authorization = `Bearer ${authToken}`;
  return h;
}
```

- [ ] **Step 2: Fire the 401 hook from the single error path**

Replace the first line of `toError`'s body (line 27) so the function starts:

```ts
async function toError(r: Response): Promise<Error> {
  // 401 means the cached token on the api no longer matches ours (expired
  // refresh, another machine signed out, api restarted with a cleared cache).
  // One hook, one place: every helper below funnels its failures through here.
  if (r.status === 401) onUnauthorized?.();
  const text = await r.text();
```

- [ ] **Step 3: Put the header on `post`/`get`/`put` and add `del`/`patchJson`**

Replace the whole helper block (lines 46-72):

```ts
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  // NestJS message/answer endpoints return an empty body; tolerate no-JSON.
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { headers: authHeaders(false) });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'PUT',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}

// DELETE and PATCH used to be hand-rolled at five call sites, two of which never
// checked r.ok. Two helpers instead, so the Authorization header and the 401 hook
// cannot be forgotten at a new call site.
async function del(path: string): Promise<void> {
  const r = await fetch(BASE + path, { method: 'DELETE', headers: authHeaders(false) });
  if (!r.ok) throw await toError(r);
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'PATCH',
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  return (await r.json()) as T;
}
```

- [ ] **Step 4: Migrate the five inline `fetch` call sites**

Replace `deleteGroup` (78-81):

```ts
  deleteGroup: (id: string): Promise<void> => del(`/groups/${id}`),
```

Replace `deleteSession` (112-113):

```ts
  // Was Promise<Response> with no r.ok check; now it throws like every sibling.
  deleteSession: (id: string): Promise<void> => del(`/sessions/${id}`),
```

Replace `updateGroup` (121-132) — the parameter is renamed from `patch` to `body` so it does not shadow the new helper:

```ts
  updateGroup: (
    id: string,
    body: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string },
  ): Promise<Group> => patchJson<Group>(`/groups/${id}`, body),
```

Replace `stopPreview` (148-149):

```ts
  stopPreview: (id: string): Promise<void> => del(`/sessions/${id}/preview`),
```

Replace `updateTask` (194-202):

```ts
  updateTask: (id: string, draft: TaskDraft): Promise<Session> =>
    patchJson<Session>(`/sessions/${id}`, draft),
```

- [ ] **Step 5: Add the auth endpoints**

Inside the `api` object, immediately after `moveTask` (line 204-205) and before the closing `};`:

```ts

  // Token handoff to the local api. POST is @Public() on the server (the UI has
  // no bearer to present yet); DELETE and GET are guarded like everything else.
  authSession: (accessToken: string): Promise<{ userId: string; githubUsername?: string }> =>
    post<{ userId: string; githubUsername?: string }>('/auth/session', { accessToken }),

  clearAuthSession: (): Promise<void> => del('/auth/session'),

  getAuthSession: (): Promise<{
    signedIn: boolean;
    userId?: string;
    githubUsername?: string;
    expiresAt?: string;
  }> => get('/auth/session'),
```

- [ ] **Step 6: Verify it type-checks**

```bash
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```
Expected: no type errors. (`stores/orchestrator.ts:184` returns `api.deleteSession(id)` with an inferred type, so the `Response` → `void` change needs no edit there.)

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/ui/src/lib/api.ts
git commit -m "feat(ui): send the Supabase bearer token on every local API call and handle 401"
```

---

### Task 12: Supabase boot + auth store

**Files:**
- Modify: `apps/ui/src/env.d.ts` (`ImportMetaEnv`, lines 9-11)
- Create: `apps/ui/src/boot/supabase.ts`
- Create: `apps/ui/src/stores/auth.ts`
- Modify: `apps/ui/src/types/kermanych-bridge.d.ts` (whole file)
- Modify: `apps/ui/quasar.config.ts` (`boot`, line 9)

**Interfaces:**
- Consumes: `createCloudClient`, `cloudEnv`, `Profile` (Task 6); `api.authSession`, `api.clearAuthSession`, `setAuthToken`, `setUnauthorizedHandler` (Task 11).
- Produces: `useAuth()` exposing `client: SupabaseClient`, `user: { id: string } | null`, `profile: Profile | null`, `accessToken: string | null`, `ready: Promise<void>`, `init(): Promise<void>`, `signInWithGithub(): Promise<void>`, `signOut(): Promise<void>`. `Window.kermanych.startOAuth?: (authorizeUrl: string) => Promise<{ code: string }>` (the type only; Task 14 implements it).
- Consumed by: **Plan B**'s `stores/projects.ts` and **Plan C**'s `stores/board.ts`, both of which read `useAuth().client` and `useAuth().user.id` and `await useAuth().ready`.

- [ ] **Step 1: Declare the two new Vite variables**

Replace `ImportMetaEnv` in `apps/ui/src/env.d.ts` (lines 9-11):

```ts
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  // The cloud coordination backend. Both are REQUIRED: the app cannot render
  // without a Supabase client. Values come from `supabase status` (local) or the
  // project's API settings (hosted). The anon key is public by design; RLS is the
  // authorization surface.
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
```

- [ ] **Step 2: Extend the Electron bridge type**

Replace the whole of `apps/ui/src/types/kermanych-bridge.d.ts`:

```ts
// Exposed by src-electron/electron-preload.ts via contextBridge. Absent in the browser.
export {};
declare global {
  interface Window {
    kermanych?: {
      apiBase: string;
      focus: () => void;
      // Electron only. The renderer cannot receive a browser redirect, so main
      // runs a one-shot loopback listener and resolves with the PKCE code.
      // Optional so a stale packaged preload degrades to the browser flow
      // instead of throwing.
      startOAuth?: (authorizeUrl: string) => Promise<{ code: string }>;
    };
  }
}
```

- [ ] **Step 3: Write the auth store**

Create `apps/ui/src/stores/auth.ts`:

```ts
// apps/ui/src/stores/auth.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Session as SupabaseSession, SupabaseClient } from '@supabase/supabase-js';
import { cloudEnv, createCloudClient, type Profile } from '@kermanych/cloud';
import { api, setAuthToken, setUnauthorizedHandler } from '../lib/api';

// One Supabase client per renderer, built when this module is first imported —
// which boot/supabase.ts triggers before the first navigation. PKCE, session
// persisted in localStorage, detectSessionInUrl on, so the SDK owns sign-in and
// token refresh. The anon key is public; RLS is the authorization surface.
const client: SupabaseClient = createCloudClient(
  cloudEnv('ui', import.meta.env as unknown as Record<string, string | undefined>),
);

// Must match OAUTH_REDIRECT in src-electron/oauth-loopback.ts and the entry in
// supabase/config.toml additional_redirect_urls. A fixed port, because Supabase
// matches redirect URLs exactly.
const LOOPBACK_REDIRECT = 'http://127.0.0.1:53170/callback';

export const useAuth = defineStore('auth', () => {
  const user = ref<{ id: string } | null>(null);
  const profile = ref<Profile | null>(null);
  const accessToken = ref<string | null>(null);

  let resolveReady: () => void = () => undefined;
  // Resolves once the initial session (if any) has been read and handed to the
  // local api. The router guard awaits it so there is no flash of /login.
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let initialized = false;

  // Mirror the Supabase session into this store AND into the local api. Called
  // on init and on every onAuthStateChange event (SIGNED_IN, TOKEN_REFRESHED,
  // SIGNED_OUT, USER_UPDATED).
  async function apply(session: SupabaseSession | null): Promise<void> {
    if (session) {
      const meta = (session.user.user_metadata ?? {}) as {
        user_name?: string;
        full_name?: string;
        avatar_url?: string;
      };
      user.value = { id: session.user.id };
      profile.value = {
        id: session.user.id,
        githubUsername: meta.user_name,
        displayName: meta.full_name,
        avatarUrl: meta.avatar_url,
      };
      accessToken.value = session.access_token;
      setAuthToken(session.access_token);
      try {
        await api.authSession(session.access_token);
      } catch {
        // The local api may still be booting (Electron starts it in-process).
        // The next auth event — or the guard's own re-validation — recovers.
      }
      return;
    }

    const had = accessToken.value;
    user.value = null;
    profile.value = null;
    accessToken.value = null;
    // Send the sign-out WHILE the token is still installed: DELETE
    // /api/auth/session is guarded. Skip it entirely if we never had one, so a
    // 401 cannot bounce back into signOut() and loop.
    if (had) {
      try {
        await api.clearAuthSession();
      } catch {
        // Already signed out locally, or the api is down. Nothing to undo.
      }
    }
    setAuthToken(undefined);
  }

  async function init(): Promise<void> {
    if (initialized) return ready;
    initialized = true;
    // A 401 from any local call means our token is no longer the one the api
    // trusts. Surfacing it as a sign-out is the honest response; the guard on
    // `user` keeps it from recursing.
    setUnauthorizedHandler(() => {
      if (user.value) void signOut();
    });
    const { data } = await client.auth.getSession();
    await apply(data.session);
    client.auth.onAuthStateChange((_event, session) => {
      void apply(session);
    });
    resolveReady();
    return ready;
  }

  async function signInWithGithub(): Promise<void> {
    const startOAuth = window.kermanych?.startOAuth;
    if (startOAuth) {
      // Desktop: build the authorize URL here (the PKCE verifier must stay in
      // this renderer's storage), let main open the system browser and catch the
      // loopback redirect, then finish the exchange here.
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: LOOPBACK_REDIRECT, skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data.url) throw new Error('Supabase не повернув URL авторизації');
      const { code } = await startOAuth(data.url);
      // Pass the flowId back: v2 stores the PKCE verifier per flow at
      // `${storageKey}-flow-${flowId}-code-verifier`, and the fixed legacy key
      // only mirrors the most recent flow. Same client instance, same storage —
      // that is why the exchange happens here and not in the main process.
      const exchanged = await client.auth.exchangeCodeForSession(
        code,
        data.flowId ? { flowId: data.flowId } : undefined,
      );
      if (exchanged.error) throw exchanged.error;
      return;
    }
    // Browser: a plain redirect. detectSessionInUrl finishes the exchange when
    // the tab comes back (the code arrives as ?code=… ahead of the hash route).
    const { error } = await client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: `${window.location.origin}/#/auth/callback` },
    });
    if (error) throw error;
  }

  async function signOut(): Promise<void> {
    await client.auth.signOut();
    await apply(null);
  }

  return { client, user, profile, accessToken, ready, init, signInWithGithub, signOut };
});
```

- [ ] **Step 4: Write the boot file**

Create `apps/ui/src/boot/supabase.ts`, following the shape of `apps/ui/src/boot/tokens.ts`:

```ts
// apps/ui/src/boot/supabase.ts
import { defineBoot } from '#q-app/wrappers';
import { useAuth } from '../stores/auth';

// Bring the Supabase session up BEFORE the first navigation: importing the auth
// store constructs the client, and init() reads any persisted session, hands the
// token to the local api, and subscribes to future auth changes. The router guard
// awaits `ready`, so there is no flash of /login for an already-signed-in user.
export default defineBoot(async ({ store }) => {
  await useAuth(store).init();
});
```

- [ ] **Step 5: Register the boot file**

In `apps/ui/quasar.config.ts`, replace line 9:

```ts
    boot: ['tokens', 'supabase'],
```

- [ ] **Step 6: Verify it type-checks**

```bash
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 7: Verify the app boots and the store is live**

Create `apps/ui/.env` with the local stack values (Vite loads `.env` from the app root; it holds only public values — URL and anon key):

```bash
cd kermanych/apps/ui
cat > .env <<'EOF'
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key from supabase status>
EOF
```

Then run `pnpm dev:api` and `pnpm dev:ui` and open <http://localhost:5317>.

Expected: the app renders. The rail and the Workspace board still populate — the socket.io gateway is deliberately unauthenticated and local, so the `snapshot` event still arrives — but any REST call (opening a session's transcript, for example) now fails with `401`, because there is no token yet and no way to sign in until Task 13. That is the correct mid-plan state.

Critically, the console must show NO error mentioning `cloud env missing: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY`. If it does, `.env` was not picked up — restart `pnpm dev:ui`.

Then confirm the client was actually constructed, by checking that the SDK created its storage key:

```js
Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
```
Expected: an array with at least one `sb-…-auth-token` entry — the SDK writes it during `init()` even before sign-in. Sign-in itself is Task 13.

- [ ] **Step 8: Commit**

`apps/ui/.env` is deliberately NOT committed; Task 15 documents it in the README instead.

```bash
git add kermanych/apps/ui/src/env.d.ts kermanych/apps/ui/src/boot/supabase.ts \
        kermanych/apps/ui/src/stores/auth.ts kermanych/apps/ui/src/types/kermanych-bridge.d.ts \
        kermanych/apps/ui/quasar.config.ts
git commit -m "feat(ui): Supabase boot, auth store, and token handoff to the local API"
```

---

### Task 13: Login page, auth layout, routes and the navigation guard

**Files:**
- Create: `apps/ui/src/pages/LoginPage.vue`
- Create: `apps/ui/src/layouts/AuthLayout.vue`
- Modify: `apps/ui/src/router/routes.ts` (whole file)
- Modify: `apps/ui/src/router/index.ts` (whole file)

**Interfaces:**
- Consumes: `useAuth()` (Task 12); `KBtn` (`apps/ui/src/components/kit/KBtn.vue`, props `variant`/`disabled`); `KToast` (props `toasts`, emit `dismiss`); `useOrchestrator().toasts`/`.dismissToast`.
- Produces: named routes `login`, `workspace`, `kit`, `not-found`; `RouteMeta.public?: boolean`; a `beforeEach` guard that sends unauthenticated traffic to `/login` and signed-in traffic away from it, plus a `watch` on `auth.user` that leaves the app shell the moment a session is lost (sign-out, or a 401 that forced one) — `beforeEach` cannot see that, because nothing navigated.
- Coordinated: `routes.ts` carries the literal comment `// Plan C (cloud board) adds the /board child here.` inside the `MainLayout` children array. **Plan C** inserts `{ path: 'board', name: 'board', component: () => import('pages/BoardPage.vue'), meta: { public: false } }` at that marker and touches nothing else in the file.

- [ ] **Step 1: Write the login page**

Create `apps/ui/src/pages/LoginPage.vue`:

```vue
<template>
  <main class="login">
    <section class="login__card">
      <h1 class="login__brand">KERMANYCH</h1>
      <p class="login__hint">
        Спільна дошка задач команди. Увійдіть, щоб побачити проєкти та задачі.
      </p>
      <KBtn variant="primary" :disabled="busy" @click="signIn">
        {{ busy ? 'Входимо…' : 'Увійти через GitHub' }}
      </KBtn>
      <p v-if="error" class="login__error" role="alert">{{ error }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
// The only screen reachable without a Supabase session. GitHub OAuth is the sole
// provider: in the browser this redirects away and comes back signed in; in
// Electron the store routes through the loopback bridge instead.
import { ref } from 'vue';
import { useAuth } from 'stores/auth';
import KBtn from 'components/kit/KBtn.vue';

const auth = useAuth();
const busy = ref(false);
const error = ref<string | null>(null);

async function signIn(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await auth.signInWithGithub();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    // In the browser the page navigates away before this runs; in Electron the
    // promise resolves once the exchange finished, so the button must recover.
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--k-canvas);
  padding: 24px;
}

.login__card {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 32px;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: 0;
}

.login__brand {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.14em;
  color: var(--k-text);
}

.login__hint {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--k-muted);
}

.login__error {
  margin: 0;
  font-family: var(--k-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-accent);
}
</style>
```

- [ ] **Step 2: Write the auth layout**

`KToast` is mounted only inside `MainLayout.vue:153`, so a screen outside that layout has no toast surface. Create `apps/ui/src/layouts/AuthLayout.vue`:

```vue
<template>
  <div class="auth-layout">
    <LoginPage />
    <!-- KToast lives in MainLayout for the app shell; /login sits outside it and
         needs its own surface so sign-in failures are visible. -->
    <KToast :toasts="store.toasts" @dismiss="store.dismissToast" />
  </div>
</template>

<script setup lang="ts">
import { useOrchestrator } from 'stores/orchestrator';
import KToast from 'components/kit/KToast.vue';
import LoginPage from 'pages/LoginPage.vue';

// Reads the toast queue only; unlike MainLayout it never calls store.connect(),
// so no socket is opened before sign-in.
const store = useOrchestrator();
</script>

<style scoped lang="scss">
.auth-layout {
  min-height: 100vh;
  background: var(--k-canvas);
}
</style>
```

- [ ] **Step 3: Name the routes and mark the public ones**

Replace the whole of `apps/ui/src/router/routes.ts`:

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
      // Plan C (cloud board) adds the /board child here.
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

- [ ] **Step 4: Add the navigation guard**

Replace the whole of `apps/ui/src/router/index.ts`:

```ts
import { watch } from 'vue';
import { defineRouter } from '#q-app/wrappers';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';
import routes from './routes';
import { useAuth } from '../stores/auth';

export default defineRouter(({ store }) => {
  const createHistory = process.env.SERVER
    ? createMemoryHistory
    : process.env.VUE_ROUTER_MODE === 'history'
      ? createWebHistory
      : createWebHashHistory;

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,

    // Leave as is and change quasar.config.ts -> build -> vueRouterMode instead.
    history: createHistory(process.env.VUE_ROUTER_BASE),
  });

  // Auth gate. `ready` resolves once boot/supabase.ts has read the persisted
  // session, so a signed-in user never sees /login flash by. The pinia instance
  // comes from defineRouter's context because guards run outside a component.
  let watching = false;
  Router.beforeEach(async (to) => {
    const auth = useAuth(store);
    await auth.ready;

    // Losing the session must leave the app shell immediately — on sign-out, or
    // when a 401 from the local api forces one. beforeEach cannot do that on its
    // own, because nothing navigated. Installed on the first navigation so the
    // store is guaranteed to exist.
    if (!watching) {
      watching = true;
      watch(
        () => auth.user,
        (u) => {
          if (!u && Router.currentRoute.value.name !== 'login') {
            void Router.replace({ name: 'login' });
          }
        },
      );
    }

    const isPublic = to.matched.some((r) => r.meta.public === true);
    if (!auth.user && !isPublic) return { name: 'login' };
    if (auth.user && to.name === 'login') return { name: 'workspace' };
    return true;
  });

  return Router;
});
```

- [ ] **Step 5: Verify it type-checks**

```bash
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 6: Verify the browser OAuth round trip**

`supabase start` must be running, and `apps/ui/.env` must hold the local URL + anon key (Task 12 Step 7). Run `pnpm dev:api` and `pnpm dev:ui`, then open <http://localhost:5317>.

Expected, in order:
1. You land on `#/login` — the dark card with «Увійти через GitHub», no rail, no board.
2. Clicking the button leaves for `github.com/login/oauth/authorize`; authorise the app.
3. GitHub returns you to `http://localhost:5317/?code=…#/auth/callback`; the SDK exchanges the code, the guard re-runs, and you land on the Workspace board (rail + `KTable`).
4. The api terminal shows no `401`s after that point; `curl -s localhost:4317/api/auth/session` (no header) returns `401`, while the UI's own calls succeed.
5. Verify the profile row exists: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select github_username, display_name from profiles;"` → one row with your GitHub handle (proving `handle_new_user` fired for a real OAuth sign-in).
6. Reload the page: you stay on the board (persisted session + `ready` await), with no `/login` flash.
7. Type `http://localhost:5317/#/login` into the address bar: the guard bounces you straight back to the board, proving the signed-in redirect.
8. Sign out from the console and confirm the round trip closes cleanly:

```js
// The store is reachable through the app's pinia instance; grab it off the root
// component so this works without adding a sign-out button (that lands with the
// board header in Plan C).
const pinia = document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia;
await pinia._s.get('auth').signOut();
```
Expected: you land back on `#/login`; the api terminal logs a `DELETE /api/auth/session` that returns `200` (it was sent while the token was still installed); `curl -s -H "authorization: Bearer <the old token>" localhost:4317/api/auth/session` is no longer answered from the cache; and the console shows no repeating 401 loop.

- [ ] **Step 7: Commit**

```bash
git add kermanych/apps/ui/src/pages/LoginPage.vue kermanych/apps/ui/src/layouts/AuthLayout.vue \
        kermanych/apps/ui/src/router/routes.ts kermanych/apps/ui/src/router/index.ts
git commit -m "feat(ui): GitHub login page, auth layout and a router auth guard"
```

---

### Task 14: Electron loopback OAuth

**Files:**
- Create: `apps/ui/src-electron/oauth-loopback.ts`
- Modify: `apps/ui/src-electron/electron-main.ts` (import line 1; new handler after the `kermanych:focus` block, lines 76-81; `before-quit`, lines 106-116)
- Modify: `apps/ui/src-electron/electron-preload.ts` (whole file)

**Interfaces:**
- Consumes: `Window.kermanych.startOAuth` type and the `LOOPBACK_REDIRECT` constant in `stores/auth.ts` (Task 12) — the port here MUST equal the port there and the entry in `supabase/config.toml` `additional_redirect_urls` (Task 1).
- Produces: `startLoopbackOAuth(authorizeUrl: string, open: (url: string) => Promise<unknown>): Promise<{ code: string }>`; `closeLoopback(): void`; `OAUTH_PORT = 53170`; `OAUTH_REDIRECT`. IPC channel `kermanych:oauth` — the first `ipcMain.handle`/`ipcRenderer.invoke` pair in the app (the only existing channel is the one-way `ipcMain.on('kermanych:focus')`).

- [ ] **Step 1: Write the loopback listener**

Create `apps/ui/src-electron/oauth-loopback.ts`. It imports nothing from `electron` — main injects `shell.openExternal` — so the listener stays a plain `node:http` unit.

```ts
// apps/ui/src-electron/oauth-loopback.ts
// One-shot loopback listener for the desktop OAuth round trip. Electron's window
// cannot receive a browser redirect, and no custom protocol is registered
// (app.setAsDefaultProtocolClient / protocol.handle / open-url are all absent),
// so a loopback redirect is the only wired-up-able path.
//
// The port is FIXED, not probed. It is baked into Supabase's redirect allow-list
// (supabase/config.toml additional_redirect_urls) and into LOOPBACK_REDIRECT in
// src/stores/auth.ts; a drifting port would produce a redirect URL Supabase
// refuses. If 53170 is taken we fail loudly with EADDRINUSE instead.
import { createServer, type Server } from 'node:http';

export const OAUTH_PORT = 53170;
export const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`;

const TIMEOUT_MS = 120_000;

let active: Server | undefined;

// Called on completion, on failure, and from before-quit — a stray listener would
// keep a handle open and block the app from quitting.
export function closeLoopback(): void {
  active?.close();
  active = undefined;
}

export async function startLoopbackOAuth(
  authorizeUrl: string,
  open: (url: string) => Promise<unknown>,
): Promise<{ code: string }> {
  closeLoopback();
  const { promise, resolve, reject } = Promise.withResolvers<{ code: string }>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', OAUTH_REDIRECT);
    const code = url.searchParams.get('code');
    const failure = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      code
        ? '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">Готово. Повертайтесь до Kermanych.</body>'
        : '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">Не вдалося увійти. Повертайтесь до Kermanych.</body>',
    );
    if (code) resolve({ code });
    else reject(new Error(failure ?? 'oauth callback carried no code'));
  });

  active = server;
  server.once('error', (err) => reject(err));
  server.listen(OAUTH_PORT, '127.0.0.1');

  const timer = setTimeout(
    () => reject(new Error(`oauth timed out after ${TIMEOUT_MS / 1000}s`)),
    TIMEOUT_MS,
  );

  void open(authorizeUrl);

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    closeLoopback();
  }
}
```

- [ ] **Step 2: Import `shell` and the loopback in main**

In `apps/ui/src-electron/electron-main.ts`, replace line 1:

```ts
import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron';
```

and add, after the `import type { INestApplication } from '@nestjs/common';` line (line 6):

```ts
import { closeLoopback, startLoopbackOAuth } from './oauth-loopback';
```

- [ ] **Step 3: Add the IPC handler**

Immediately after the existing `ipcMain.on('kermanych:focus', …)` block (after line 81), add:

```ts

// The renderer builds the authorize URL (the PKCE verifier must stay in its own
// storage) and we run the round trip: open the system browser, catch the
// loopback redirect, hand back the code. First invoke/handle pair in the app.
ipcMain.handle('kermanych:oauth', async (_event, authorizeUrl: string) => {
  return await startLoopbackOAuth(authorizeUrl, (url) => shell.openExternal(url));
});
```

- [ ] **Step 4: Tear the listener down on quit**

Replace the `before-quit` handler (lines 106-116):

```ts
app.on('before-quit', (e) => {
  // A half-finished OAuth round trip would otherwise keep an HTTP handle open
  // and stop the app from quitting.
  closeLoopback();
  if (nest) {
    e.preventDefault();
    const closing = nest;
    nest = undefined;
    // nest.close() runs each module's onModuleDestroy: SupervisorService stops the omp
    // rpc children and PreviewService stops preview children. finally() guarantees quit
    // even if a child's stop() rejects, so the app can never get stuck un-quittable.
    void closing.close().finally(() => app.quit());
  }
});
```

- [ ] **Step 5: Expose it on the bridge**

Replace the whole of `apps/ui/src-electron/electron-preload.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

// main passes --api-base=<url> via webPreferences.additionalArguments.
const arg = process.argv.find((a) => a.startsWith('--api-base='));
const apiBase = arg ? arg.slice('--api-base='.length) : 'http://localhost:4317/api';

contextBridge.exposeInMainWorld('kermanych', {
  apiBase,
  focus: () => ipcRenderer.send('kermanych:focus'),
  // Resolves { code } once the loopback listener in main catches the redirect.
  // Its presence is how stores/auth.ts detects the desktop build.
  startOAuth: (authorizeUrl: string): Promise<{ code: string }> =>
    ipcRenderer.invoke('kermanych:oauth', authorizeUrl),
});
```

- [ ] **Step 6: Verify it type-checks**

```bash
pnpm --filter @kermanych/ui exec vue-tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 7: Verify the desktop round trip**

Add `http://127.0.0.1:53170/callback` to the Supabase redirect allow-list if you skipped it in Task 1 Step 2, then:

```bash
cd kermanych && pnpm dev:app
```

(`dev:app` builds core → cloud → api before launching Electron; the cloud build was added in Task 6 Step 9.)

Expected, in order:
1. The Kermanych window opens on the login card («Увійти через GitHub»), not on the board.
2. Clicking the button opens your **system browser** (not an in-app window) at `github.com/login/oauth/authorize`.
3. After authorising, the browser tab shows «Готово. Повертайтесь до Kermanych.» and the Electron window is already on the Workspace board.
4. `lsof -nP -iTCP:53170` prints nothing — the listener closed itself.
5. Quit the app (⌘Q). It exits cleanly, with no hang.
6. Relaunch `pnpm dev:app`: you land on the board directly (the session persisted in the renderer's localStorage) with no login card.

- [ ] **Step 8: Commit**

```bash
git add kermanych/apps/ui/src-electron/oauth-loopback.ts \
        kermanych/apps/ui/src-electron/electron-main.ts \
        kermanych/apps/ui/src-electron/electron-preload.ts
git commit -m "feat(ui): Electron loopback GitHub OAuth via ipcMain.handle"
```

---

### Task 15: README — cloud prerequisites

**Files:**
- Modify: `README.md` (insert after the existing `## Prerequisites` section, which ends at line 27, before `## Setup & run` at line 29)

**Interfaces:**
- Consumes: everything Tasks 1-14 require an operator to have.
- Produces: the documented list of four environment variables (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) plus the two test-only ones, so no later plan has to re-explain them.

- [ ] **Step 1: Write the section**

In `README.md`, insert after line 27 (the last bullet of `## Prerequisites`) and before the `## Setup & run` heading on line 29. The section content — note the outer fence below is four backticks because the section itself contains fenced blocks:

````markdown

## Cloud prerequisites

Kermanych's task board is shared through Supabase (auth, projects, membership,
tasks, Realtime). Execution stays local — worktrees, `omp` children and
transcripts never leave your machine — but you need a Supabase backend to sign
in and to see the board.

**Either** a hosted project (<https://supabase.com/dashboard>) **or** a local
stack (Docker + the [Supabase CLI](https://supabase.com/docs/guides/local-development)):

```bash
supabase start        # from the repo root; prints the API URL, anon key, service_role key
supabase db reset     # apply supabase/migrations/*.sql to a clean database
supabase status       # re-print the URLs and keys at any time
```

**GitHub OAuth App** — GitHub allows one callback URL per app, so a local stack
and a hosted project need one each (<https://github.com/settings/developers>):

| target | Authorization callback URL |
|---|---|
| local stack | `http://127.0.0.1:54321/auth/v1/callback` |
| hosted project | `https://<project-ref>.supabase.co/auth/v1/callback` |

For the local stack, export the app's credentials **before** `supabase start` —
`supabase/config.toml` substitutes them into `[auth.external.github]`:

```bash
export GITHUB_CLIENT_ID=Ov23li…
export GITHUB_SECRET=ghs_…
```

For a hosted project, set the same pair under Authentication → Providers →
GitHub, and add both redirect URLs (`http://localhost:5317/**` and
`http://127.0.0.1:53170/callback`) under Authentication → URL Configuration.
The second one is the fixed loopback the desktop app listens on.

**Four environment variables** — the API and the UI each need the same pair,
under different names (Vite only inlines `VITE_`-prefixed variables). All four
hold public values; the anon key is safe to expose because RLS is the
authorization surface. **No service-role key ever belongs on a machine running
Kermanych.**

| variable | consumer | value |
|---|---|---|
| `SUPABASE_URL` | `apps/api` | the API URL |
| `SUPABASE_ANON_KEY` | `apps/api` | the anon key |
| `VITE_SUPABASE_URL` | `apps/ui` | the same API URL |
| `VITE_SUPABASE_ANON_KEY` | `apps/ui` | the same anon key |

Export the first pair in the shell that runs `pnpm dev:api` (or `pnpm dev:app`,
which hosts the API in-process), and put the second pair in `apps/ui/.env`:

```bash
# apps/ui/.env — public values only, not committed
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key>
```

**Running the cloud tests.** `packages/cloud`'s unit suite needs nothing. Its
RLS/trigger integration suite is skipped unless all three of these are set, and
`SUPABASE_TEST_SERVICE_KEY` is a *test fixture only* — it mints throwaway users
through the admin API and is never read by shipped code:

```bash
supabase start && supabase db reset
export SUPABASE_TEST_URL=http://127.0.0.1:54321
export SUPABASE_TEST_ANON_KEY=<anon key>
export SUPABASE_TEST_SERVICE_KEY=<service_role key>
pnpm --filter @kermanych/cloud test
```
````

- [ ] **Step 2: Verify the section renders and the links resolve**

```bash
sed -n '17,40p' kermanych/README.md
```
Expected: the existing `## Prerequisites` bullets, then the new `## Cloud prerequisites` heading, then `## Setup & run` — no heading-level or fence corruption.

- [ ] **Step 3: Commit**

```bash
git add kermanych/README.md
git commit -m "docs: cloud prerequisites — Supabase stack, GitHub OAuth app, env vars"
```

---

### Task 16: End-to-end auth smoke

**Files:** none (manual verification).

- [ ] **Step 1: Start everything clean**

```bash
cd kermanych
supabase start && supabase db reset
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY="$(supabase status -o json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ANON_KEY))")"
echo "${SUPABASE_ANON_KEY:0:12}…"
pnpm dev:api        # this terminal
```
In a second terminal: `pnpm dev:ui`.

Expected: the api prints `Kermanych API on http://127.0.0.1:4317`; the anon key echo is non-empty.

- [ ] **Step 2: Browser OAuth round trip**

Open <http://localhost:5317>.

Expected:
1. `#/login` with «Увійти через GitHub».
2. Click → system browser at `github.com/login/oauth/authorize` → authorise.
3. Back at `localhost:5317`, you land on the Workspace board.
4. `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select github_username from profiles;"` → exactly one row, your GitHub handle.

- [ ] **Step 3: Confirm the local API is now guarded**

Copy the access token out of the running UI (browser console):

```js
JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith('-auth-token')))).access_token
```

Then, in a terminal:

```bash
TOKEN='<paste the access_token>'

# 1. No token at all → refused.
curl -s -o /dev/null -w 'no-header  %{http_code}\n' \
  -X POST localhost:4317/api/sessions -H 'content-type: application/json' \
  -d '{"groupId":"nope","name":"smoke","task":"smoke"}'

# 2. Garbage token → refused.
curl -s -o /dev/null -w 'bad-token  %{http_code}\n' \
  -X POST localhost:4317/api/sessions -H 'content-type: application/json' \
  -H 'authorization: Bearer not-a-token' \
  -d '{"groupId":"nope","name":"smoke","task":"smoke"}'

# 3. Real token → the guard lets it through; the 400 is the SERVICE rejecting the
#    bogus groupId, which is exactly the proof the request got past auth.
curl -s -w '\nreal-token %{http_code}\n' \
  -X POST localhost:4317/api/sessions -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"groupId":"nope","name":"smoke","task":"smoke"}'

# 4. The previously wide-open directory lister is closed too.
curl -s -o /dev/null -w 'fs-no-hdr  %{http_code}\n' 'localhost:4317/api/fs/list?path=/'
curl -s -o /dev/null -w 'fs-token   %{http_code}\n' -H "authorization: Bearer $TOKEN" 'localhost:4317/api/fs/list?path=/'
```

Expected exactly:
```
no-header  401
bad-token  401
{"message":"group not found","error":"Bad Request","statusCode":400}
real-token 400
fs-no-hdr  401
fs-token   200
```

- [ ] **Step 4: Confirm the offline rule**

```bash
supabase stop
curl -s -o /dev/null -w 'offline-cached %{http_code}\n' -H "authorization: Bearer $TOKEN" localhost:4317/api/groups
curl -s -o /dev/null -w 'offline-other  %{http_code}\n' -H 'authorization: Bearer some-other-token' localhost:4317/api/groups
supabase start
```

Expected: `offline-cached 200` (the cached token still controls the local machine with Supabase unreachable — Requirement 7 / spec D4) and `offline-other 401` (an unknown token cannot be validated offline).

- [ ] **Step 5: Electron loopback round trip**

Quit the browser dev servers, then:

```bash
cd kermanych && pnpm dev:app
```

Expected:
1. The window opens on the login card.
2. «Увійти через GitHub» opens the **system browser**, not an in-app window.
3. The browser tab ends on «Готово. Повертайтесь до Kermanych.» and the app window is already on the board.
4. `lsof -nP -iTCP:53170` prints nothing.
5. ⌘Q quits cleanly; relaunching lands straight on the board.

- [ ] **Step 6: Full suites**

```bash
cd kermanych
export SUPABASE_TEST_URL=http://127.0.0.1:54321
export SUPABASE_TEST_ANON_KEY="$SUPABASE_ANON_KEY"
export SUPABASE_TEST_SERVICE_KEY="<service_role key from supabase status>"
supabase db reset
pnpm --filter @kermanych/cloud exec vitest run
pnpm --filter @kermanych/api exec vitest run
pnpm --filter @kermanych/core exec vitest run
```

Expected: cloud — 19 passed (4 status + 5 client + 10 RLS); api — every existing spec plus the 3 registry-auth and 7 guard tests, all passing; core — unchanged and green.

- [ ] **Step 7: Clean up the smoke artifacts**

```bash
cd kermanych && supabase db reset
```
Expected: the throwaway users, profiles and any test project are gone; the schema is intact. (`apps/ui/.env` stays — it is your local config and is not committed.)

---

## Self-Review

**Spec coverage — requirements this plan owns:**

- **Requirement 1** (GitHub OAuth PKCE in browser AND Electron; first sign-in provisions `auth.users` + `profiles` via trigger) → Task 1 (provider config + GitHub OAuth Apps), Task 3 (`handle_new_user`), Task 12 (`stores/auth.ts` PKCE client, both branches), Task 13 (login page + guard, browser round trip verified), Task 14 (Electron loopback), Task 16 Steps 2 and 5.
- **Requirement 10** (no service-role key on any client machine; every cloud write under the user's JWT + RLS) → Task 4 (RLS + `revoke … from anon` + verb-scoped grants), Task 6 (`createCloudClient` pins `Authorization: Bearer <user jwt>`, asserted in `client.spec.ts`), Task 9 (`AuthService.cloudClient()` only ever builds an anon-key client with the user's token). The service-role key appears in exactly two places, both operator-local and never in shipped code: `packages/cloud/test/rls.spec.ts` (Task 7, `SUPABASE_TEST_SERVICE_KEY`) and the throwaway-user shell snippets in Tasks 10/16.
- **Requirement 11** (local mutating REST requires a valid user token; today it is fully unauthenticated with `CORS: *`) → Task 8 (`auth_session`), Task 9 (`SupabaseAuthGuard`), Task 10 (`APP_GUARD` covering all 34 routes, `@Public()` on the one handoff route), Task 11 (UI sends the bearer on all helpers **and** all five formerly-inline `fetch` sites), Task 16 Step 3 (401 → 200 proof, including `GET /fs/list`, the highest-risk read route).
- **Deviation D4** (validate once, then work offline; no `jose`/JWKS) → Task 9: `AuthService.setToken` is the single validation call — `getClaims` verifies the JWT locally against the SDK's cached JWKS (a symmetric-secret project falls back to `getUser`); the guard then only compares strings, and `jwtExpiry` extracts `exp` on the fallback path. Tested by `an EXPIRED cached token still controls the local machine (offline rule)` and `an unknown token with no reachable cloud is rejected`; proven end to end in Task 16 Step 4 with Supabase stopped.
- **Spec sections fully implemented here:** "Data model — Supabase (Postgres)" (Tasks 2-3), "RLS policies" (Task 4), "New package `@kermanych/cloud`" — the `types.ts`/`client.ts`/`status.ts` third of it (Tasks 5-6), "Auth" in its entirety (Tasks 8-14), "Electron changes" (Task 14), and the `packages/cloud` unit + RLS-integration bullets of "Verification" (Tasks 5-7).

**Deliberately deferred to sibling plans** (declared as `Consumes`/coordinated edits, never silently dropped):

- **Requirements 2, 3, 9** — cloud projects, membership management, per-machine binding, `env_keys` checklist → **Plan B**. Plan A creates the `projects`/`project_members` tables and their policies; `packages/cloud/src/projects.ts`, `stores/projects.ts`, the `projects.controller.ts` rename and the `Group` → `Project` cutover are Plan B's.
- **Requirements 4, 5, 8** — the shared board, launch params, Realtime fan-out, atomic self-assign, the active-task lock as a UI affordance → **Plan C**. Plan A creates the `tasks` table, the Realtime publication, `tasks_guard` and the four task policies; `packages/cloud/src/tasks.ts`, `stores/board.ts` and `BoardPage.vue` are Plan C's.
- **Requirements 6, 7** — status flowing local → cloud, the outbox, offline queueing and retry → **Plan D**. Plan A provides the two seams Plan D needs: `AuthService.cloudClient()` and `AuthService.onToken(cb)` (fired after the `auth_session` row is written, so relogin re-drains the queue), plus the offline guard behaviour that keeps local control working while pushes are queued. `status_outbox`, `CloudSyncService` and `POST /api/sessions/from-task` are Plan D's.
- `packages/cloud/src/index.ts` ships with three barrel lines; Plan B appends `export * from "./projects";` and Plan C appends `export * from "./tasks";` — declared in Task 5's Interfaces as coordinated one-line appends, not shared ownership. Plan D touches the barrel not at all.
- `apps/api/src/app.module.ts`: Plan B swaps `GroupsController` → `ProjectsController`, Plan D appends `CloudSyncService`. Declared in Task 10's Interfaces.
- `apps/ui/src/router/routes.ts`: Plan C inserts the `/board` child at the literal marker comment written in Task 13 Step 3.
- `apps/api/src/registry/registry.service.ts`: Plan B adds the `user_version` 0→1 rename migration, Plan D adds `status_outbox`. Declared in Task 8's Interfaces.
- `apps/ui/src/lib/api.ts`: Plan B renames the group wrappers and adds `setProjectBinding`; Plan D adds `createSessionFromTask`. Both sit on the `post`/`get`/`put`/`del`/`patchJson` helpers Task 11 establishes.

**Two documented departures from the spec's letter, both verified against the code:**

1. `projects_select_member` (Task 4) reads `owner_id = auth.uid() or is_project_member(id, auth.uid())` rather than the matrix's bare `is_project_member(...)`. `INSERT … RETURNING` evaluates the SELECT policy for the returned row **before** the `AFTER INSERT` trigger has created the owner's membership row, so `createProject().select()` would come back empty. The owner is always a member, so the disjunct widens nothing. Rationale is in a SQL comment at the policy.
2. The spec (`## Auth`) now fixes the loopback port at 53170 rather than probing with `freePort()`, and this plan implements exactly that: `oauth-loopback.ts` binds 53170 and fails loudly on `EADDRINUSE`. The reason is in the file header — the port is part of an exact-match redirect URL registered with Supabase, so a probe that silently drifted to an OS-assigned port would produce a redirect GoTrue refuses. (`freePort` itself stays where it is, `electron-main.ts:31`, still probing 4317 for the Nest API.)

Also noted rather than invented: the spec marks `GET /api/health` `@Public()`, but no health route exists in `apps/api` (34 routes across three controllers, none a health check), so Task 10 marks only `POST /api/auth/session` and says so explicitly.

**Placeholder scan:** clean. Every code step carries the literal file content; every SQL object body is written out in full (four routines, three triggers, fourteen policies, five tables/enum); every verification step gives the exact command and an `Expected:` line. The angle-bracket values that remain — `<anon key from supabase status>`, `<service_role key…>`, `<project-ref>`, `<paste the access_token>`, `Ov23li…`/`ghs_…` — are runtime secrets the operator substitutes, never code to be written.

**Type consistency:** `TaskStatus = SessionStatus` (Task 5) is the same ten labels as the Postgres `task_status` enum (Task 2) and `packages/core/src/types.ts:4-5`, asserted label-by-label in `status.spec.ts`. `AuthSessionRow` (Task 8) is the exact return of `AuthService.current()` and the exact input of `setAuthSession` (Task 9), and its four fields match the four `auth_session` columns. `AuthService.setToken` returns `{ userId, githubUsername? }`, which is what `POST /api/auth/session` returns (Task 10) and what `api.authSession` is typed to receive (Task 11). `req.user = { id: string }` is written only by the guard (Task 9) and is the shape Plan D's `from-task` route reads. `CloudClientFactory` (Task 9) is structurally identical to `createCloudClient`'s signature (Task 6), which is what makes the guard spec's stub type-check. `useAuth()`'s surface — `client`, `user`, `profile`, `accessToken`, `ready`, `init`, `signInWithGithub`, `signOut` — is used identically by `boot/supabase.ts` (Task 12), `router/index.ts` (Task 13), `LoginPage.vue` (Task 13) and, per the coordination above, by Plan B's `stores/projects.ts` and Plan C's `stores/board.ts`. The loopback port 53170 appears in exactly three places and they agree: `supabase/config.toml` `additional_redirect_urls` (Task 1), `LOOPBACK_REDIRECT` in `stores/auth.ts` (Task 12), `OAUTH_PORT`/`OAUTH_REDIRECT` in `oauth-loopback.ts` (Task 14).

**Open follow-ups (non-blocking, out of scope per spec):** the socket.io gateway still has no handshake auth and broadcasts every event to every local client — harmless while the server is loopback-only and single-user, and explicitly a non-goal here; `safeStorage`/Keychain hardening for the persisted renderer session; a real `GET /api/health` if a `@Public()` liveness probe is ever wanted.
