# Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace level above projects — a named group that owns projects and carries the team's membership — so the board can be scoped to a whole product and projects can be dragged between groups.

**Architecture:** Membership moves from `project_members` to `workspace_members`; `projects` gains a `not null workspace_id`. `is_project_member(p,u)` survives as a workspace-resolving wrapper, so the four `tasks_*` RLS policies stay textually unchanged. `tasks` gains no column — the workspace is reached through `project_id → projects.workspace_id`. Board scope and both filters are computed client-side; the Realtime channel keeps subscribing to every visible project. `apps/api`, `packages/core` and the local SQLite registry change in **zero source files**.

**Tech Stack:** Postgres 17 + Supabase (RLS, `security definer` functions, triggers); TypeScript (CommonJS `packages/cloud`); Vue 3 `<script setup>` + Quasar 2 + Pinia; vitest; native HTML5 drag-and-drop (no DnD library).

**Spec:** `kermanych/docs/superpowers/specs/2026-08-27-workspaces-design.md`

## Global Constraints

- Node ≥22.12. pnpm 10.33.2 workspaces (`packages/*`, `apps/*`). All commands run from `kermanych/`.
- Migration filenames: `YYYYMMDDHHMMSS_snake_case_topic.sql` — keep the 14-digit prefix width; `supabase db reset` orders by it.
- SQL style: lowercase keywords, `public.`-qualified identifiers, `set search_path = public` on **every** `security definer` function, `revoke all … from anon` before the narrowest `grant … to authenticated`, and a `--` rationale on every non-obvious clause. Migrations are additive/corrective and cite by name the file whose decision they reverse.
- `supabase/config.toml` does not set `auto_expose_new_tables`, so a new table gets **no** grants automatically — they must be written.
- Local stack: API `http://127.0.0.1:54421`, db `54422`. `supabase db reset` re-applies all migrations; `supabase migration up` applies only pending ones.
- `packages/cloud/src/index.ts` uses **explicit named re-exports only**. `export *` breaks named bindings in the Vite-prebundled UI — every new symbol must be listed.
- `packages/cloud` has **no** generated `Database` type. The contract with Postgres is hand-maintained in three places per table: the `*_COLUMNS` select string, the local `*Row` type, and the `to*` / `to*Row` mappers. Keep all three in lockstep.
- TypeScript runs with `exactOptionalPropertyTypes`: an unset optional field is an **absent key**, never `undefined`.
- UI copy is inline Ukrainian; identifiers and comments are English. There is no i18n layer — do not add one.
- `apps/ui` has **no component tests** (no `@vue/test-utils`, no jsdom). `apps/ui/test/*.spec.ts` are pure unit tests over `src/lib/**` with hand-rolled fakes. Logic that needs coverage goes into `src/lib/`.
- RLS integration tests are gated `describe.skipIf(!URL || !ANON || !SERVICE)` on `SUPABASE_TEST_URL` / `SUPABASE_TEST_ANON_KEY` / `SUPABASE_TEST_SERVICE_KEY`, and clients MUST be built in `beforeAll` — `skipIf` still executes the describe callback, and `createClient("")` throws.
- The service-role key is used ONLY by `admin.auth.admin.createUser` in tests. It never appears in shipped code.
- `apps/api/src`, `packages/core/src` and `apps/api/src/registry/registry.service.ts` are **not to be modified**. Only `apps/api/test/sessions.from-task.spec.ts` fixtures change.
- After changing `packages/cloud`, the UI needs `pnpm --filter @kermanych/cloud build` before `quasar dev` picks it up (`pnpm dev:ui` does this for you).

**Test commands:**

```bash
pnpm --filter @kermanych/cloud test       # unit + RLS integration
pnpm --filter @kermanych/api test         # api regression
pnpm --filter @kermanych/ui test          # pure unit
pnpm --filter @kermanych/ui typecheck     # vue-tsc --noEmit
pnpm --filter @kermanych/api typecheck    # tsc --noEmit
```

**RLS suite prerequisites (needed from Task 1 onward):**

```bash
cd kermanych
supabase start && supabase db reset
export SUPABASE_TEST_URL=http://127.0.0.1:54421
export SUPABASE_TEST_ANON_KEY=<anon or publishable key from `supabase status`>
export SUPABASE_TEST_SERVICE_KEY=<service_role key from `supabase status`>
```

---

### Task 1: Workspace tables, membership helper, trigger, RLS

Creates the two new tables and their security boundary. `projects` is untouched here, so the whole existing suite must stay green.

**Files:**
- Create: `kermanych/supabase/migrations/20260827100000_workspaces.sql`
- Modify: `kermanych/packages/cloud/test/rls.spec.ts:74-89` (add a workspace fixture to `beforeAll`) and append tests

**Interfaces:**
- Consumes: nothing.
- Produces: SQL objects `public.workspaces(id, name, color, owner_id, created_at)`, `public.workspace_members(workspace_id, user_id, role, added_at)`, `public.is_workspace_member(w uuid, u uuid) returns boolean`, `public.handle_new_workspace()` + trigger `on_workspace_created`, `public.invite_workspace_member(p_workspace_id uuid, p_email text) returns public.workspace_members`. Test fixture `workspaceId` in `rls.spec.ts`.

- [ ] **Step 1: Add the workspace fixture to `beforeAll`**

In `kermanych/packages/cloud/test/rls.spec.ts`, declare the variable next to `projectId` (near line 38):

```ts
  let workspaceId: string;
```

Then, inside `beforeAll` and **before** the existing `projects` insert at line 74, add:

```ts
    const workspace = await owner.client
      .from("workspaces")
      .insert({ name: "rls-ws", owner_id: owner.id })
      .select()
      .single();
    if (workspace.error) throw workspace.error;
    workspaceId = workspace.data.id as string;
```

- [ ] **Step 2: Write the failing tests**

Append these inside the existing `describe` block, after the last `it`:

```ts
  // handle_new_workspace() is the mirror of the retired handle_new_project(): the
  // creator is owner AND first member in one round trip.
  it("handle_new_workspace inserts the owner's membership row", async () => {
    const { data, error } = await owner.client
      .from("workspace_members")
      .select("workspace_id, user_id, role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", owner.id)
      .single();
    expect(error).toBeNull();
    expect(data?.role).toBe("owner");
  });

  // The `owner_id = auth.uid() or` disjunct in workspaces_select_member is
  // load-bearing: INSERT … RETURNING evaluates the SELECT policy for the new row
  // BEFORE the AFTER-INSERT trigger has written the membership row.
  it("createWorkspace().select() returns the row it just inserted", async () => {
    const fresh = await owner.client
      .from("workspaces")
      .insert({ name: "returning-check", owner_id: owner.id })
      .select("id, name")
      .single();
    expect(fresh.error).toBeNull();
    expect(fresh.data?.name).toBe("returning-check");
  });

  it("a non-member sees no workspaces", async () => {
    const { data, error } = await outsider.client
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // No INSERT policy AND no INSERT grant: the rpc and the trigger are the only
  // writers, so nobody can forge a row with role='owner' or a user_id that never
  // agreed to anything.
  it("nobody can insert a workspace member directly, not even the owner", async () => {
    const ownerTry = await owner.client
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: member.id, role: "member" });
    expect(ownerTry.error?.code).toBe("42501");

    const outsiderTry = await outsider.client
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: outsider.id, role: "member" });
    expect(outsiderTry.error?.code).toBe("42501");
  });

  it("invite_workspace_member refuses an email with no account", async () => {
    const { error } = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: "nobody@kermanych.test",
    });
    expect(error?.message).toMatch(/no Kermanych account/);
  });

  it("invite_workspace_member refuses a plain member and accepts the owner", async () => {
    const added = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: member.email,
    });
    expect(added.error).toBeNull();
    expect((added.data as { user_id: string }).user_id).toBe(member.id);

    // Requirement 2: inviting is OWNER-only here, unlike the project-level rule it
    // replaces — one invitation now opens every project in the workspace.
    const memberTry = await member.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: outsider.email,
    });
    expect(memberTry.error?.message).toMatch(/only the workspace owner can invite/);
  });

  it("re-inviting the same person is an idempotent no-op", async () => {
    const again = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: workspaceId,
      p_email: member.email,
    });
    expect(again.error).toBeNull();
    expect((again.data as { user_id: string }).user_id).toBe(member.id);

    const { data } = await owner.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", member.id);
    expect(data).toHaveLength(1);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kermanych/cloud test -- rls`
Expected: FAIL. `beforeAll` throws on the `workspaces` insert — PostgREST reports `PGRST205 Could not find the table 'public.workspaces' in the schema cache`.

- [ ] **Step 4: Create the migration with the tables, helper and trigger**

Create `kermanych/supabase/migrations/20260827100000_workspaces.sql`:

```sql
-- Kermanych workspaces — a grouping level ABOVE projects.
--
-- This reverses the non-goal "No team/workspace layer above projects (flat
-- owner/member)" from docs/superpowers/specs/2026-08-21-team-cloud-design.md:620.
-- Reason: per-project invitation is O(projects x people) for a team whose projects
-- are one product, and a flat list cannot answer "what is the state of product AAA".
--
-- Membership moves UP: workspace_members replaces project_members, and a project
-- stops having an owner of its own. See
-- docs/superpowers/specs/2026-08-27-workspaces-design.md.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  -- `on delete restrict` mirrors what projects.owner_id used to guarantee: ownership
  -- must be handed over before an account can be deleted. No orphan groups.
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now());

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (workspace_id, user_id));

create index workspace_members_user_idx on public.workspace_members (user_id);

-- The new membership primitive. `security definer` is REQUIRED: a policy on
-- workspace_members that queried workspace_members would recurse. `stable` lets the
-- planner call it once per statement.
create or replace function public.is_workspace_member(w uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = w and user_id = u);
$$;

-- Mirror of handle_new_project() (dropped further down): the creator is owner AND
-- first member without a second round trip. `security definer` because
-- workspace_members has no INSERT policy at all.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- invite_project_member() (20260823130000_invite_members_by_email.sql) one level up,
-- with ONE rule tightened. The first statement IS the authorization rule, because
-- `security definer` disables RLS inside — and here it demands OWNERSHIP rather than
-- mere membership: an invitation now grants access to every project in the
-- workspace, a strictly wider grant than the project-level rule it replaces.
--
-- Email resolution must stay in the database: auth.users is unreachable for the
-- `authenticated` role, and mirroring addresses into profiles would publish every
-- teammate's email, since profiles_select is `using (true)`.
create or replace function public.invite_workspace_member(p_workspace_id uuid, p_email text)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text := lower(nullif(trim(p_email), ''));
  target uuid;
  membership public.workspace_members;
begin
  if norm is null then raise exception 'email is required'; end if;

  if not exists (
       select 1 from public.workspaces w
       where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'only the workspace owner can invite';
  end if;

  -- The join against profiles is what makes "already uses Kermanych" a hard
  -- requirement: only handle_new_user() writes that row.
  select u.id into target
    from auth.users u
    join public.profiles pr on pr.id = u.id
   where lower(u.email) = norm
   limit 1;

  if target is null then
    raise exception 'no Kermanych account for % — ask them to sign in with GitHub first', norm;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (p_workspace_id, target, 'member')
  on conflict (workspace_id, user_id) do nothing
  returning * into membership;

  -- `do nothing` returns no row, so a repeat invite reports the existing membership
  -- instead of failing.
  if membership is null then
    select * into membership from public.workspace_members
     where workspace_id = p_workspace_id and user_id = target;
  end if;

  return membership;
end;
$$;

comment on function public.invite_workspace_member(uuid, text) is
  'Adds the holder of an email address to a workspace as ''member''. Owner-only. The address must already belong to a Kermanych account; no pending-invitation state exists. Idempotent. Never returns an email.';

revoke all on function public.invite_workspace_member(uuid, text) from public, anon;
grant execute on function public.invite_workspace_member(uuid, text) to authenticated;

-- ── RLS for the two new tables ────────────────────────────────────────────────
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;

-- Defensive: config.toml leaves auto_expose_new_tables unset, so nothing is granted to
-- anon implicitly — this revoke is what survives someone turning it back on.
revoke all on table public.workspaces        from anon;
revoke all on table public.workspace_members from anon;

-- workspace_members gets NEITHER insert NOR update: no policy will ever permit either,
-- and a missing grant denies one layer earlier than a missing policy. A membership row
-- is created by the rpc or the trigger and destroyed by the owner — nothing in this
-- design ever edits one, and an owner-scoped UPDATE that pinned neither user_id nor
-- role would have let an owner forge role='owner' or a user_id that never consented.
-- Both functions are `security definer`, so they need no grant here.
grant select, insert, update, delete on table public.workspaces        to authenticated;
grant select,                delete on table public.workspace_members to authenticated;

-- `owner_id = auth.uid() or` is not redundancy: INSERT … RETURNING evaluates the
-- SELECT policy for the returned row BEFORE the AFTER-INSERT trigger has created the
-- owner's membership row, so createWorkspace().select() would come back empty
-- without it. The owner is always a member, so this widens nothing. (Same trick the
-- old projects_select_member needed — it moved up one level.)
create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (owner_id = auth.uid() or public.is_workspace_member(id, auth.uid()));

create policy workspaces_insert_own on public.workspaces
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy workspaces_update_owner on public.workspaces
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy workspaces_delete_owner on public.workspaces
  for delete to authenticated
  using (owner_id = auth.uid());

create policy workspace_members_select_member on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_members_delete_owner on public.workspace_members
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));
```

- [ ] **Step 5: Apply the migration and run the tests**

Run:
```bash
cd kermanych && supabase db reset && pnpm --filter @kermanych/cloud test -- rls
```
Expected: PASS, and every pre-existing test in the file still passes (`projects` was not touched).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260827100000_workspaces.sql packages/cloud/test/rls.spec.ts
git commit -m "feat(db): workspaces and workspace_members with owner-only invite

New membership primitive is_workspace_member(w,u); handle_new_workspace()
mirrors the project trigger; invite_workspace_member() is owner-only because one
invitation now opens every project in the workspace.

workspace_members gets no INSERT grant at all - the rpc and the trigger are the
only writers."
```

---

### Task 2: Re-parent projects, rewrite their policies, retire project-level membership

Appends to the same migration file. This is where the cutover happens.

**Files:**
- Modify: `kermanych/supabase/migrations/20260827100000_workspaces.sql` (append)
- Modify: `kermanych/packages/cloud/test/rls.spec.ts` (fixture switches to `workspace_id`; project-level membership tests become workspace-level; new move/delete/force-stop tests)

**Interfaces:**
- Consumes: `public.workspaces`, `public.workspace_members`, `public.is_workspace_member(uuid, uuid)` from Task 1.
- Produces: `public.projects.workspace_id uuid not null`; `public.is_project_member(p uuid, u uuid)` redefined as a workspace-resolving wrapper; policies `projects_select_member`, `projects_insert_member`, `projects_update_member`, `projects_delete_owner`. Removed: `public.project_members`, `public.projects.owner_id`, `public.handle_new_project()`, trigger `on_project_created`, `public.invite_project_member(uuid, text)`.

- [ ] **Step 1: Point the existing fixture at a workspace**

In `rls.spec.ts`, change the `projects` insert inside `beforeAll` (currently line 74-80) from `owner_id: owner.id` to `workspace_id: workspaceId`:

```ts
    const project = await owner.client
      .from("projects")
      .insert({ name: "rls-suite", workspace_id: workspaceId })
      .select()
      .single();
    if (project.error) throw project.error;
    projectId = project.data.id as string;
```

- [ ] **Step 2: Delete the tests for objects this task removes**

Remove every `it` in `rls.spec.ts` that references `project_members` or `invite_project_member` — they test objects that stop existing. Their coverage is replaced by the workspace-level equivalents already added in Task 1 plus the new tests in Step 3. Use this to find them:

Run: `grep -n "project_members\|invite_project_member" packages/cloud/test/rls.spec.ts`
Delete the enclosing `it(...)` blocks for each hit outside `beforeAll`.

- [ ] **Step 3: Write the failing tests for the new project rules**

Append inside the same `describe`:

```ts
  // The whole point of the wrapper: a workspace member reaches a project they were
  // never a "project member" of, because that concept no longer exists.
  it("a workspace member sees the workspace's projects and their tasks", async () => {
    const projects = await member.client.from("projects").select("id").eq("id", projectId);
    expect(projects.error).toBeNull();
    expect(projects.data).toHaveLength(1);

    const tasks = await member.client.from("tasks").select("id").eq("id", taskId);
    expect(tasks.error).toBeNull();
    expect(tasks.data).toHaveLength(1);
  });

  it("a non-member sees no projects and no tasks", async () => {
    const projects = await outsider.client.from("projects").select("id").eq("id", projectId);
    expect(projects.data).toEqual([]);
    const tasks = await outsider.client.from("tasks").select("id").eq("id", taskId);
    expect(tasks.data).toEqual([]);
  });

  // USING sees the OLD row and WITH CHECK the NEW one, so one update policy demands
  // membership of BOTH workspaces. No rpc needed.
  it("moving a project requires membership of the source AND the destination", async () => {
    const foreign = await outsider.client
      .from("workspaces")
      .insert({ name: "foreign-ws", owner_id: outsider.id })
      .select("id")
      .single();
    if (foreign.error) throw foreign.error;

    // The two refusals are NOT the same error, and this is verified Postgres 17
    // behaviour, not a guess: WITH CHECK is evaluated against the NEW row and
    // RAISES on violation, while USING simply does not match the OLD row.
    //
    // Member of the source only -> the destination fails WITH CHECK -> 42501
    // "new row violates row-level security policy for table \"projects\"".
    const pushOut = await member.client
      .from("projects")
      .update({ workspace_id: foreign.data.id })
      .eq("id", projectId)
      .select("id")
      .single();
    expect(pushOut.error?.code).toBe("42501");
    expect(pushOut.error?.message).toMatch(/violates row-level security policy/);

    // Non-member of the source -> USING never matches the row, so zero rows come
    // back WITHOUT a Postgres error and `.single()` reports PGRST116.
    const pullOut = await outsider.client
      .from("projects")
      .update({ workspace_id: foreign.data.id })
      .eq("id", projectId)
      .select("id")
      .single();
    expect(pullOut.error?.code).toBe("PGRST116");

    // Owner invites the outsider to a shared destination, then the move lands.
    const shared = await owner.client
      .from("workspaces")
      .insert({ name: "shared-ws", owner_id: owner.id })
      .select("id")
      .single();
    if (shared.error) throw shared.error;
    const invited = await owner.client.rpc("invite_workspace_member", {
      p_workspace_id: shared.data.id,
      p_email: member.email,
    });
    expect(invited.error).toBeNull();

    const moved = await member.client
      .from("projects")
      .update({ workspace_id: shared.data.id })
      .eq("id", projectId)
      .select("workspace_id")
      .single();
    expect(moved.error).toBeNull();
    expect(moved.data?.workspace_id).toBe(shared.data.id);

    // Put it back so later tests keep their fixture.
    const back = await owner.client
      .from("projects")
      .update({ workspace_id: workspaceId })
      .eq("id", projectId)
      .select("workspace_id")
      .single();
    expect(back.error).toBeNull();
  });

  it("only the workspace owner may delete a project", async () => {
    const doomed = await member.client
      .from("projects")
      .insert({ name: "doomed", workspace_id: workspaceId })
      .select("id")
      .single();
    if (doomed.error) throw doomed.error;

    // A refused DELETE matches zero rows WITHOUT an error, so confirm by re-reading.
    await member.client.from("projects").delete().eq("id", doomed.data.id);
    const survived = await owner.client.from("projects").select("id").eq("id", doomed.data.id);
    expect(survived.data).toHaveLength(1);

    await owner.client.from("projects").delete().eq("id", doomed.data.id);
    const gone = await owner.client.from("projects").select("id").eq("id", doomed.data.id);
    expect(gone.data).toEqual([]);
  });

  it("a workspace holding projects cannot be deleted", async () => {
    await owner.client.from("workspaces").delete().eq("id", workspaceId);
    const survived = await owner.client.from("workspaces").select("id").eq("id", workspaceId);
    expect(survived.data).toHaveLength(1);

    const empty = await owner.client
      .from("workspaces")
      .insert({ name: "empty-ws", owner_id: owner.id })
      .select("id")
      .single();
    if (empty.error) throw empty.error;
    await owner.client.from("workspaces").delete().eq("id", empty.data.id);
    const emptyGone = await owner.client.from("workspaces").select("id").eq("id", empty.data.id);
    expect(emptyGone.data).toEqual([]);
  });

  // tasks_guard's single escape hatch now resolves the WORKSPACE owner.
  it("force-stop is the workspace owner's, not a plain member's", async () => {
    const stuck = await owner.client
      .from("tasks")
      .insert({ project_id: projectId, title: "stuck", created_by: owner.id, assignee_id: outsider.id })
      .select("id")
      .single();
    if (stuck.error) throw stuck.error;
    await owner.client.from("tasks").update({ status: "thinking" }).eq("id", stuck.data.id);

    const memberTry = await member.client
      .from("tasks")
      .update({ status: "stopped" })
      .eq("id", stuck.data.id);
    expect(memberTry.error?.message).toMatch(/only the assignee can change status/);

    const ownerForce = await owner.client
      .from("tasks")
      .update({ status: "stopped" })
      .eq("id", stuck.data.id)
      .select("status")
      .single();
    expect(ownerForce.error).toBeNull();
    expect(ownerForce.data?.status).toBe("stopped");
  });

  it("the workspace owner may force only 'stopped', nothing else", async () => {
    const other = await owner.client
      .from("tasks")
      .insert({ project_id: projectId, title: "not yours", created_by: owner.id, assignee_id: outsider.id })
      .select("id")
      .single();
    if (other.error) throw other.error;
    await owner.client.from("tasks").update({ status: "thinking" }).eq("id", other.data.id);

    const ownerTry = await owner.client
      .from("tasks")
      .update({ status: "done" })
      .eq("id", other.data.id);
    expect(ownerTry.error?.message).toMatch(/only the assignee can change status/);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @kermanych/cloud test -- rls`
Expected: FAIL. `beforeAll` throws — `projects` has no `workspace_id` column (`PGRST204`), and `owner_id` is still `not null`.

- [ ] **Step 5: Append the re-parenting, backfill and new policies to the migration**

Append to `kermanych/supabase/migrations/20260827100000_workspaces.sql`:

```sql
-- ── projects gain their parent ────────────────────────────────────────────────
-- `on delete restrict`, NOT cascade: deleting a workspace must not silently take
-- its projects and every task on them with it. The refusal is legible, which is the
-- same choice projects.owner_id already made for account deletion.
alter table public.projects
  add column workspace_id uuid references public.workspaces(id) on delete restrict;

-- 1:1 backfill. The workspace INHERITS the project's id: project names may
-- duplicate, so matching by name is unsafe, and id reuse removes every mapping
-- ambiguity without a temporary column. Reusing an id across tables is already an
-- idiom here — publish() hands a local project's id to its new cloud row.
--
-- Because each project becomes its own workspace carrying its own former member
-- list, visibility after this migration is IDENTICAL to visibility before it.
-- Merging projects into one workspace is then a deliberate act by the team, done
-- with drag-and-drop — never a side effect of deploying this.
insert into public.workspaces (id, name, color, owner_id, created_at)
  select p.id, p.name, p.color, p.owner_id, p.created_at from public.projects p;

update public.projects set workspace_id = id;
alter table public.projects alter column workspace_id set not null;
create index projects_workspace_idx on public.projects (workspace_id);

-- Roles copy across unchanged. `on conflict do nothing` is insurance only:
-- on_workspace_created was created ABOVE, so it already wrote each backfilled
-- workspace's owner row, and this statement must not fail on it.
insert into public.workspace_members (workspace_id, user_id, role, added_at)
  select pm.project_id, pm.user_id, pm.role, pm.added_at from public.project_members pm
  on conflict (workspace_id, user_id) do nothing;

-- ── the wrapper ───────────────────────────────────────────────────────────────
-- Redefined, same name and signature, so the four tasks_* policies stay TEXTUALLY
-- UNCHANGED. Their question — "may this user reach this project?" — is still
-- exactly right; only the derivation moved up a level. Redefined BEFORE
-- project_members is dropped: function bodies are not dependency-tracked, so a
-- stale body would fail at runtime instead of here.
create or replace function public.is_project_member(p uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.projects pr
    join public.workspace_members m on m.workspace_id = pr.workspace_id
    where pr.id = p and m.user_id = u);
$$;

-- ── tasks_guard: the force-stop hatch follows ownership upwards ───────────────
-- Only the owner clause changes. Rules 2 and 3 (no reassign/delete while active,
-- server-owned updated_at) are reproduced verbatim from
-- 20260821090100_team_cloud_functions.sql. Redefined BEFORE projects.owner_id is
-- dropped, for the same dependency-tracking reason as above.
create or replace function public.tasks_guard()
returns trigger
language plpgsql
as $$
declare
  active_statuses task_status[] := array['queued','thinking','tool','waiting_input']::task_status[];
begin
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status
       and auth.uid() is distinct from old.assignee_id
       and auth.uid() is distinct from new.assignee_id
       and not (
         new.status = 'stopped'::task_status
         and exists (
           select 1 from public.projects p
           join public.workspaces w on w.id = p.workspace_id
           where p.id = old.project_id and w.owner_id = auth.uid())) then
      raise exception 'only the assignee can change status';
    end if;
    if new.assignee_id is distinct from old.assignee_id
       and old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    return old;
  end if;

  return new;
end;
$$;

-- ── projects policies ─────────────────────────────────────────────────────────
drop policy projects_select_member on public.projects;
drop policy projects_insert_own    on public.projects;
drop policy projects_update_owner  on public.projects;
drop policy projects_delete_owner  on public.projects;

-- The `owner_id = auth.uid() or` disjunct the old version needed is GONE, and this
-- is not an oversight: the inserter is already a member of the target workspace, so
-- the SELECT policy passes for INSERT … RETURNING without help.
create policy projects_select_member on public.projects
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy projects_insert_member on public.projects
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id, auth.uid()));

-- One policy, two guarantees: USING is evaluated against the OLD row and WITH CHECK
-- against the NEW one, so moving a project needs membership of BOTH the source and
-- the destination workspace. Neither taking a project out of someone else's
-- workspace nor pushing one into it is expressible.
create policy projects_update_member on public.projects
  for update to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy projects_delete_owner on public.projects
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

-- ── retire the project level of membership ────────────────────────────────────
drop trigger on_project_created on public.projects;
drop function public.handle_new_project();
drop function public.invite_project_member(uuid, text);
drop table public.project_members;          -- takes members_* policies with it
alter table public.projects drop column owner_id;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd kermanych && supabase db reset && pnpm --filter @kermanych/cloud test -- rls
```
Expected: PASS for the whole file.

- [ ] **Step 7: Verify the objects are really gone**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:54422/postgres -c "\d public.projects" -c "\df public.invite_project_member" -c "\dt public.project_members"
```
Expected: `projects` lists `workspace_id | uuid | not null` and **no** `owner_id`; the function and the table both report no matches.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260827100000_workspaces.sql packages/cloud/test/rls.spec.ts
git commit -m "feat(db)!: re-parent projects under workspaces, retire project_members

projects.workspace_id is not null, backfilled 1:1 with the workspace inheriting
the project's id so post-migration visibility is identical.

is_project_member() becomes a workspace-resolving wrapper, leaving the four
tasks_* policies textually unchanged. Moving a project needs membership of both
workspaces, enforced by USING (old row) + WITH CHECK (new row).

BREAKING: drops project_members, projects.owner_id, handle_new_project() and
invite_project_member()."
```

---

### Task 3: Migration rehearsal script

Requirement 9 ("visibility is exactly preserved") cannot be covered by a permanent test: `supabase db reset` runs the backfill over an empty database, and after the migration the pre-state is unreachable. This script is the one-time proof, kept in the repo as documentation of the check.

**Files:**
- Create: `kermanych/scripts/verify-workspace-migration.ts`

**Interfaces:**
- Consumes: the migration from Tasks 1-2; `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_KEY`.
- Produces: a CLI that exits non-zero when visibility changed. No exports.

- [ ] **Step 1: Write the script**

Create `kermanych/scripts/verify-workspace-migration.ts`:

```ts
// One-time rehearsal for 20260827100000_workspaces.sql, run against a LOCAL stack
// before `supabase db push --linked`.
//
// Why a script and not a test: `supabase db reset` applies the migration to an
// EMPTY database, so the 1:1 backfill has nothing to prove there, and once the
// migration has run the pre-state is unreachable. So the check is staged by hand:
//
//   git stash                                   # keep the new migration out of the way
//   git checkout HEAD~1 -- supabase/migrations  # or: move the new file aside
//   supabase db reset
//   pnpm tsx scripts/verify-workspace-migration.ts seed
//   git checkout - -- supabase/migrations       # bring the new migration back
//   supabase migration up
//   pnpm tsx scripts/verify-workspace-migration.ts check
//
// `seed` writes two users, two projects and crossed membership, then records who
// can see what into .kermanych-migration-rehearsal.json. `check` re-reads the same
// questions after the migration and diffs. Any difference is a migration bug.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const SNAPSHOT = ".kermanych-migration-rehearsal.json";
const PASSWORD = "kermanych-rehearsal-password";

if (!URL || !ANON || !SERVICE) {
  console.error("set SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_KEY");
  process.exit(2);
}

type Actor = { tag: string; id: string; email: string; client: SupabaseClient };
type Snapshot = { actors: { tag: string; email: string }[]; visibility: Record<string, { projects: string[]; tasks: string[] }> };

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function mint(tag: string): Promise<Actor> {
  const email = `${tag}-rehearsal@kermanych.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { user_name: `${tag}-rehearsal`, full_name: `${tag} Rehearsal` },
  });
  if (created.error) throw created.error;
  return { tag, id: created.data.user.id, email, client: await signIn(email) };
}

// The two questions the migration must not change the answer to. Names, not ids:
// the backfill creates new workspace rows but must not renumber projects.
async function visibilityOf(actor: Actor): Promise<{ projects: string[]; tasks: string[] }> {
  const projects = await actor.client.from("projects").select("name").order("name");
  if (projects.error) throw projects.error;
  const tasks = await actor.client.from("tasks").select("title").order("title");
  if (tasks.error) throw tasks.error;
  return {
    projects: (projects.data as { name: string }[]).map((r) => r.name),
    tasks: (tasks.data as { title: string }[]).map((r) => r.title),
  };
}

async function seed(): Promise<void> {
  const alice = await mint("alice");
  const bob = await mint("bob");

  // alice owns both projects; bob is invited to ONE of them. After the migration bob
  // must still see exactly that one — this is the case a careless merge would widen.
  const visibility: Snapshot["visibility"] = {};
  for (const [name, invitee] of [["alpha", bob], ["beta", null]] as const) {
    const project = await alice.client
      .from("projects")
      .insert({ name, owner_id: alice.id })
      .select("id")
      .single();
    if (project.error) throw project.error;
    const task = await alice.client
      .from("tasks")
      .insert({ project_id: project.data.id, title: `${name}-task`, created_by: alice.id });
    if (task.error) throw task.error;
    if (invitee) {
      const invited = await alice.client.rpc("invite_project_member", {
        p_project_id: project.data.id,
        p_email: invitee.email,
      });
      if (invited.error) throw invited.error;
    }
  }

  for (const actor of [alice, bob]) visibility[actor.tag] = await visibilityOf(actor);
  const snapshot: Snapshot = {
    actors: [alice, bob].map((a) => ({ tag: a.tag, email: a.email })),
    visibility,
  };
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2));
  console.log(`seeded; visibility recorded in ${SNAPSHOT}`);
  console.log(JSON.stringify(visibility, null, 2));
}

async function check(): Promise<void> {
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  let failed = false;

  for (const { tag, email } of before.actors) {
    const client = await signIn(email);
    const after = await visibilityOf({ tag, id: "", email, client });
    const expected = before.visibility[tag];
    if (!expected) throw new Error(`no recorded visibility for ${tag}`);
    for (const key of ["projects", "tasks"] as const) {
      const a = after[key].join(",");
      const b = expected[key].join(",");
      if (a !== b) {
        failed = true;
        console.error(`FAIL ${tag}.${key}: before [${b}] -> after [${a}]`);
      } else {
        console.log(`ok   ${tag}.${key}: [${a}]`);
      }
    }
  }

  // Post-migration invariants the backfill claims.
  const anyone = await signIn(before.actors[0]!.email);
  const orphans = await anyone.client.from("projects").select("id").is("workspace_id", null);
  if (orphans.error) throw orphans.error;
  if ((orphans.data ?? []).length > 0) {
    failed = true;
    console.error(`FAIL: ${orphans.data!.length} project(s) with a null workspace_id`);
  } else {
    console.log("ok   every project has a workspace");
  }

  if (failed) {
    console.error("\nMIGRATION CHANGED VISIBILITY — do not push");
    process.exit(1);
  }
  console.log("\nvisibility preserved");
}

const mode = process.argv[2];
if (mode === "seed") await seed();
else if (mode === "check") await check();
else {
  console.error("usage: verify-workspace-migration.ts seed|check");
  process.exit(2);
}
```

- [ ] **Step 2: Run the rehearsal end to end**

Run, from `kermanych/`, exactly the sequence in the script's header comment. Move the new migration aside with `mkdir -p /tmp/mig && mv supabase/migrations/20260827100000_workspaces.sql /tmp/mig/` for the seed phase, then move it back before `supabase migration up`.

Expected: `seed` prints `alice` seeing `[alpha, beta]` and `bob` seeing `[alpha]`; `check` prints four `ok` lines plus `ok every project has a workspace` and `visibility preserved`.

- [ ] **Step 3: Add the snapshot file to .gitignore**

Append to `kermanych/.gitignore`:

```
# one-off migration rehearsal output (scripts/verify-workspace-migration.ts)
.kermanych-migration-rehearsal.json
```

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-workspace-migration.ts .gitignore
git commit -m "test(db): rehearsal script proving the workspace backfill preserves visibility

A permanent test cannot cover this: db reset runs the backfill over an empty
database and the pre-state is gone afterwards. Seeds crossed membership before
the migration, diffs who sees what after it."
```

---

### Task 4: `Workspace` types and the `workspaces` data-access module

**Files:**
- Modify: `kermanych/packages/cloud/src/types.ts`
- Create: `kermanych/packages/cloud/src/workspaces.ts`
- Create: `kermanych/packages/cloud/test/workspaces.spec.ts`
- Modify: `kermanych/packages/cloud/src/index.ts`

**Interfaces:**
- Consumes: the SQL objects from Tasks 1-2.
- Produces: types `Workspace`, `WorkspaceMember`, `CloudWorkspacePatch`, `CloudWorkspaceInsert`; functions `toWorkspace(row)`, `toWorkspaceRow(patch)`, `listWorkspaces(client)`, `createWorkspace(client, input)`, `patchWorkspace(client, id, patch)`, `deleteWorkspace(client, id)`, `listMembers(client, workspaceId)`, `inviteMember(client, workspaceId, email)`, `removeMember(client, workspaceId, userId)`.

- [ ] **Step 1: Add the types**

In `kermanych/packages/cloud/src/types.ts`, replace the `ProjectMember` block (lines 32-38) with the workspace-level pair, and add `Workspace` above `CloudProject`:

```ts
export type Workspace = {
  id: string;
  name: string;
  color?: string;
  ownerId: string;
  createdAt: string;
};

export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  role: "owner" | "member";
  addedAt: string;
  profile?: Profile; // joined when the caller asks for it
};
```

- [ ] **Step 2: Write the failing tests**

Create `kermanych/packages/cloud/test/workspaces.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createWorkspace,
  deleteWorkspace,
  inviteMember,
  listMembers,
  listWorkspaces,
  patchWorkspace,
  removeMember,
  toWorkspace,
} from "../src/workspaces";

type Result = { data: unknown; error: { message: string } | null };
type Query = { table: string; ops: [string, ...unknown[]][] };

// The house postgrest fake: a thenable builder that records every chained call, so a
// test asserts the QUERY, not a mock's return value. Mirrors test/projects.spec.ts.
function fakeClient(...results: Result[]) {
  const queries: Query[] = [];
  function enqueue(table: string): { q: Query; result: Result } {
    const q: Query = { table, ops: [] };
    queries.push(q);
    return { q, result: results[queries.length - 1] ?? { data: null, error: null } };
  }
  const thenable = (result: Result) => ({
    then: (resolve: (v: Result) => unknown) => Promise.resolve(result).then(resolve),
  });
  const client = {
    from(table: string) {
      const { q, result } = enqueue(table);
      const builder: Record<string, unknown> = { ...thenable(result) };
      for (const op of ["select", "insert", "update", "delete", "eq", "order", "single", "maybeSingle"]) {
        builder[op] = (...args: unknown[]) => {
          q.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
    rpc(fn: string, args: unknown) {
      const { q, result } = enqueue(`rpc:${fn}`);
      q.ops.push(["rpc", args]);
      return thenable(result);
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const workspaceRow = {
  id: "w1",
  name: "AAA",
  color: "#ff8800",
  owner_id: "u1",
  created_at: "2026-08-27T00:00:00.000Z",
};

const memberRow = {
  workspace_id: "w1",
  user_id: "u2",
  role: "member" as const,
  added_at: "2026-08-27T01:00:00.000Z",
  profiles: { id: "u2", github_username: "octocat", display_name: "Octo Cat", avatar_url: null },
};

describe("toWorkspace", () => {
  it("maps snake_case and omits absent optionals rather than setting undefined", () => {
    expect(toWorkspace(workspaceRow)).toEqual({
      id: "w1",
      name: "AAA",
      color: "#ff8800",
      ownerId: "u1",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    expect(toWorkspace({ ...workspaceRow, color: null })).not.toHaveProperty("color");
  });
});

describe("listWorkspaces", () => {
  it("selects every column and orders by creation", async () => {
    const { client, queries } = fakeClient({ data: [workspaceRow], error: null });
    const list = await listWorkspaces(client);
    expect(list).toHaveLength(1);
    expect(queries[0]!.table).toBe("workspaces");
    expect(queries[0]!.ops[0]).toEqual(["select", "id, name, color, owner_id, created_at"]);
    expect(queries[0]!.ops[1]).toEqual(["order", "created_at", { ascending: true }]);
  });
});

describe("createWorkspace", () => {
  it("refuses a blank name before any round trip", async () => {
    const { client, queries } = fakeClient();
    await expect(createWorkspace(client, { name: "   ", ownerId: "u1" })).rejects.toThrow(
      "workspace name is required",
    );
    expect(queries).toHaveLength(0);
  });

  it("sends owner_id and the trimmed name", async () => {
    const { client, queries } = fakeClient({ data: workspaceRow, error: null });
    await createWorkspace(client, { name: "  AAA  ", ownerId: "u1", color: "#ff8800" });
    expect(queries[0]!.ops[0]).toEqual(["insert", { name: "AAA", color: "#ff8800", owner_id: "u1" }]);
  });
});

describe("patchWorkspace", () => {
  it("sends only the keys present and clears with an empty string", async () => {
    const { client, queries } = fakeClient({ data: workspaceRow, error: null });
    await patchWorkspace(client, "w1", { color: "" });
    expect(queries[0]!.ops[0]).toEqual(["update", { color: null }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "w1"]);
  });
});

describe("listMembers", () => {
  it("filters by workspace and folds the embedded profile into `profile`", async () => {
    const { client, queries } = fakeClient({ data: [memberRow], error: null });
    const [m] = await listMembers(client, "w1");
    expect(m).toEqual({
      workspaceId: "w1",
      userId: "u2",
      role: "member",
      addedAt: "2026-08-27T01:00:00.000Z",
      profile: { id: "u2", githubUsername: "octocat", displayName: "Octo Cat" },
    });
    expect(queries[0]!.table).toBe("workspace_members");
    expect(queries[0]!.ops[1]).toEqual(["eq", "workspace_id", "w1"]);
  });
});

describe("inviteMember", () => {
  it("normalizes the address, calls the rpc, then re-reads for the joined profile", async () => {
    const { client, queries } = fakeClient(
      { data: { user_id: "u2" }, error: null },
      { data: memberRow, error: null },
    );
    const m = await inviteMember(client, "w1", "  Octo@Example.COM ");
    expect(queries[0]!.table).toBe("rpc:invite_workspace_member");
    expect(queries[0]!.ops[0]).toEqual([
      "rpc",
      { p_workspace_id: "w1", p_email: "octo@example.com" },
    ]);
    expect(queries[1]!.table).toBe("workspace_members");
    expect(m.profile?.githubUsername).toBe("octocat");
  });

  it("rejects an obvious non-email without calling the rpc", async () => {
    const { client, queries } = fakeClient();
    await expect(inviteMember(client, "w1", "octocat")).rejects.toThrow("is not a valid email address");
    expect(queries).toHaveLength(0);
  });

  it("surfaces the rpc's refusal message unchanged", async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: "only the workspace owner can invite" },
    });
    await expect(inviteMember(client, "w1", "octo@example.com")).rejects.toThrow(
      "only the workspace owner can invite",
    );
  });
});

describe("removeMember", () => {
  it("deletes by the composite key", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await removeMember(client, "w1", "u2");
    expect(queries[0]!.ops[0]).toEqual(["delete"]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "workspace_id", "w1"]);
    expect(queries[0]!.ops[2]).toEqual(["eq", "user_id", "u2"]);
  });
});

describe("deleteWorkspace", () => {
  it("deletes by id", async () => {
    const { client, queries } = fakeClient({ data: null, error: null });
    await deleteWorkspace(client, "w1");
    expect(queries[0]!.table).toBe("workspaces");
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "w1"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kermanych/cloud test -- workspaces`
Expected: FAIL — `Cannot find module '../src/workspaces'`.

- [ ] **Step 4: Write the module**

Create `kermanych/packages/cloud/src/workspaces.ts`:

```ts
// Cloud workspaces + membership. A workspace is the group that owns projects AND
// carries the team: `workspace_members` is the single membership surface, so one
// invitation opens every project in the group. Same shape as projects.ts — this file
// owns the snake_case <-> camelCase boundary and every call runs under the caller's
// JWT, so RLS is the authorization surface and refusals arrive as thrown messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile, Workspace, WorkspaceMember } from "./types";

const WORKSPACE_COLUMNS = "id, name, color, owner_id, created_at";
const PROFILE_COLUMNS = "id, github_username, display_name, avatar_url";
const MEMBER_COLUMNS = `workspace_id, user_id, role, added_at, profiles(${PROFILE_COLUMNS})`;

type WorkspaceRow = {
  id: string;
  name: string;
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
  workspace_id: string;
  user_id: string;
  role: "owner" | "member";
  added_at: string;
  profiles: ProfileRow | null;
};

// `id`, `ownerId` and `createdAt` are never patched: the first two are immutable and
// ownership transfer is out of scope.
export type CloudWorkspacePatch = Partial<Pick<Workspace, "name" | "color">>;

export type CloudWorkspaceInsert = { name: string; ownerId: string; id?: string } & CloudWorkspacePatch;

export function toWorkspace(row: WorkspaceRow): Workspace {
  const w: Workspace = {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
  // Optional keys are omitted rather than set to undefined, so a mapped workspace
  // deep-equals a hand-written literal in tests and carries no null noise.
  if (row.color !== null) w.color = row.color;
  return w;
}

function toProfile(row: ProfileRow): Profile {
  const p: Profile = { id: row.id };
  if (row.github_username !== null) p.githubUsername = row.github_username;
  if (row.display_name !== null) p.displayName = row.display_name;
  if (row.avatar_url !== null) p.avatarUrl = row.avatar_url;
  return p;
}

function toWorkspaceMember(row: MemberRow): WorkspaceMember {
  const m: WorkspaceMember = {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    addedAt: row.added_at,
  };
  if (row.profiles) m.profile = toProfile(row.profiles);
  return m;
}

// Only the keys actually present are sent, so a partial edit never nulls a column the
// user did not touch. An empty string means "clear it" -> NULL.
export function toWorkspaceRow(patch: CloudWorkspacePatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.color !== undefined) row.color = patch.color.trim() || null;
  return row;
}

export async function listWorkspaces(client: SupabaseClient): Promise<Workspace[]> {
  const { data, error } = await client
    .from("workspaces")
    .select(WORKSPACE_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as WorkspaceRow[]).map(toWorkspace);
}

export async function createWorkspace(client: SupabaseClient, input: CloudWorkspaceInsert): Promise<Workspace> {
  const name = input.name.trim();
  if (!name) throw new Error("workspace name is required");
  // handle_new_workspace() inserts the owner's membership row, so no second round trip.
  const { data, error } = await client
    .from("workspaces")
    .insert({ ...toWorkspaceRow(input), ...(input.id ? { id: input.id } : {}), owner_id: input.ownerId })
    .select(WORKSPACE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspace(data as WorkspaceRow);
}

export async function patchWorkspace(
  client: SupabaseClient,
  id: string,
  patch: CloudWorkspacePatch,
): Promise<Workspace> {
  const { data, error } = await client
    .from("workspaces")
    .update(toWorkspaceRow(patch))
    .eq("id", id)
    .select(WORKSPACE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspace(data as WorkspaceRow);
}

export async function listMembers(client: SupabaseClient, workspaceId: string): Promise<WorkspaceMember[]> {
  const { data, error } = await client
    .from("workspace_members")
    .select(MEMBER_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("added_at", { ascending: true });
  if (error) throw new Error(error.message);
  // postgrest-js has no generated Database type here, so it widens every embed to an
  // array. `workspace_members.user_id references profiles` is to-one, so the wire
  // shape is a single object; go through `unknown` rather than weaken MemberRow.
  return (data as unknown as MemberRow[]).map(toWorkspaceMember);
}

// Membership is by EMAIL, and OWNER-only: unlike the project-level rule this
// replaces, one invitation now opens every project in the workspace, so it belongs to
// the role that already administers the group. Resolution happens entirely inside
// `invite_workspace_member` (a `security definer` rpc) because auth.users.email is
// unreachable for `authenticated`, and because workspace_members has no INSERT policy
// — the rpc and the creation trigger are the only writers.
export async function inviteMember(
  client: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<WorkspaceMember> {
  const address = email.trim().toLowerCase();
  if (!address) throw new Error("email is required");
  // Deliberately loose: the authority on whether an address exists is the rpc's
  // lookup, so this only catches the obvious typo — a github handle in the field.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(`"${address}" is not a valid email address`);
  const invited = await client.rpc("invite_workspace_member", {
    p_workspace_id: workspaceId,
    p_email: address,
  });
  if (invited.error) throw new Error(invited.error.message);
  const row = invited.data as { user_id: string } | null;
  if (!row) throw new Error(`invite for ${address} returned no membership row`);
  // Re-read for the joined profile: the rpc returns a bare row, and every consumer
  // expects the shape listMembers() hands out.
  const { data, error } = await client
    .from("workspace_members")
    .select(MEMBER_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", row.user_id)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspaceMember(data as unknown as MemberRow);
}

export async function removeMember(client: SupabaseClient, workspaceId: string, userId: string): Promise<void> {
  const { error } = await client
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Owner-only by policy (workspaces_delete_owner), AND refused by the FK from
// projects.workspace_id while the workspace still holds any. Callers must confirm
// with a re-read: a DELETE the policy refuses matches zero rows WITHOUT an error.
export async function deleteWorkspace(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("workspaces").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 5: Export the new symbols from the barrel**

In `kermanych/packages/cloud/src/index.ts`, add `Workspace` and `WorkspaceMember` to the `./types` type block and append a workspaces block after the projects block. Note `listMembers` / `inviteMember` / `removeMember` are re-exported from `./workspaces` here — Task 5 removes them from `./projects`, so do not export both:

```ts
export type { CloudWorkspacePatch, CloudWorkspaceInsert } from "./workspaces";
export {
  toWorkspace,
  toWorkspaceRow,
  listWorkspaces,
  createWorkspace,
  patchWorkspace,
  deleteWorkspace,
  listMembers,
  inviteMember,
  removeMember,
} from "./workspaces";
```

Also delete `listMembers`, `inviteMember` and `removeMember` from the existing `./projects` export list (lines 29-31) — they move in Task 5 and leaving them here is a duplicate-binding compile error.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @kermanych/cloud test -- workspaces && pnpm --filter @kermanych/cloud build`
Expected: PASS, and `tsc` reports no errors. (`projects.ts` still exports the three membership functions; the barrel no longer re-exports them, which is legal.)

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/types.ts packages/cloud/src/workspaces.ts packages/cloud/src/index.ts packages/cloud/test/workspaces.spec.ts
git commit -m "feat(cloud): Workspace types and the workspaces data-access module

Mirrors projects.ts. ProjectMember becomes WorkspaceMember; the membership trio
moves to the workspace level, keyed by workspace_id, with an owner-only invite."
```

---

### Task 5: Re-shape `CloudProject` around `workspaceId`

**Files:**
- Modify: `kermanych/packages/cloud/src/types.ts` (`CloudProject`)
- Modify: `kermanych/packages/cloud/src/projects.ts`
- Modify: `kermanych/packages/cloud/test/projects.spec.ts`
- Modify: `kermanych/apps/api/test/sessions.from-task.spec.ts` (fixtures only)

**Interfaces:**
- Consumes: `Workspace` types from Task 4.
- Produces: `CloudProject` with `workspaceId: string` and no `ownerId`; `CloudProjectPatch` including `workspaceId`; `CloudProjectInsert = { name: string; workspaceId: string; id?: string } & CloudProjectPatch`. Moving a project is `patchProject(client, id, { workspaceId })` — there is no `moveProject`.

- [ ] **Step 1: Write the failing tests**

In `kermanych/packages/cloud/test/projects.spec.ts`, replace `owner_id: "u1"` with `workspace_id: "w1"` in the `projectRow` fixture, drop the `project_members` / `inviteMember` / `removeMember` describes (they moved to `workspaces.spec.ts` in Task 4), and add:

```ts
describe("toCloudProject", () => {
  it("carries workspaceId and has no ownerId", () => {
    const p = toCloudProject(projectRow);
    expect(p.workspaceId).toBe("w1");
    expect(p).not.toHaveProperty("ownerId");
  });
});

describe("createProject", () => {
  it("sends workspace_id, not owner_id", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });
    await createProject(client, { name: "back-end", workspaceId: "w1" });
    expect(queries[0]!.ops[0]).toEqual(["insert", { name: "back-end", workspace_id: "w1" }]);
  });

  it("adopts a caller-supplied id so publishing keeps the local identity", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });
    await createProject(client, { name: "back-end", workspaceId: "w1", id: "p-local" });
    expect(queries[0]!.ops[0]).toEqual([
      "insert",
      { name: "back-end", id: "p-local", workspace_id: "w1" },
    ]);
  });
});

describe("patchProject", () => {
  it("moves a project by patching workspace_id", async () => {
    const { client, queries } = fakeClient({ data: projectRow, error: null });
    await patchProject(client, "p1", { workspaceId: "w2" });
    expect(queries[0]!.ops[0]).toEqual(["update", { workspace_id: "w2" }]);
    expect(queries[0]!.ops[1]).toEqual(["eq", "id", "p1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kermanych/cloud test -- projects`
Expected: FAIL — `workspaceId` is not a property of `CloudProject`, and `createProject` still requires `ownerId`.

- [ ] **Step 3: Re-shape `CloudProject`**

In `kermanych/packages/cloud/src/types.ts`, in `CloudProject` (lines 17-30) replace the `ownerId: string;` line with:

```ts
  // The group that owns this project AND supplies its member list. `not null` in
  // Postgres: there are no workspace-less projects in the cloud.
  workspaceId: string;
```

- [ ] **Step 4: Re-shape `projects.ts`**

Make these five edits in `kermanych/packages/cloud/src/projects.ts`:

1. `PROJECT_COLUMNS` (line 8-9) — swap `owner_id` for `workspace_id`:

```ts
const PROJECT_COLUMNS =
  "id, name, workspace_id, git_remote_url, conventions, preview_command, api_command, default_branch, carry_files, env_keys, color, created_at";
```

2. `ProjectRow` (lines 13-26) — replace `owner_id: string;` with `workspace_id: string;`.

3. `CloudProjectPatch` (lines 43-50) — add `"workspaceId"` to the `Pick`, and rewrite the comment:

```ts
// The editable slice of a project. `id` and `createdAt` are never patched. `workspaceId`
// IS patchable — that is how a project moves between workspaces, and projects_update_member
// (USING on the old row, WITH CHECK on the new) requires membership of both.
export type CloudProjectPatch = Partial<
  Pick<
    CloudProject,
    "name" | "workspaceId" | "gitRemoteUrl" | "conventions" | "previewCommand" | "apiCommand" | "defaultBranch" | "carryFiles" | "envKeys" | "color"
  >
>;
```

4. `toCloudProject` (line 60) — replace `ownerId: row.owner_id,` with `workspaceId: row.workspace_id,`; and `toProjectRow` — add, right after the `name` line:

```ts
  if (patch.workspaceId !== undefined) row.workspace_id = patch.workspaceId;
```

5. `CloudProjectInsert` + `createProject` (lines 110-134) — the owner disappears, the workspace arrives:

```ts
// A new cloud project. `workspaceId` must be a workspace the caller belongs to —
// projects_insert_member checks nothing else — and every editable column may be
// seeded at birth, because PUBLISHING an existing local project has to carry that
// project's config across: syncProjects() then overwrites the local columns from the
// cloud row, so a bare-name insert would wipe the commands, carry files and branch
// the user already had.
//
// `id` is why this is not just a patch with a name. Omitted, Postgres mints a fresh
// uuid. Supplied, the insert adopts an identity that already exists on a machine: the
// schema makes `projects.id` the same value in the cloud and in every local registry,
// so publishing under the local id is what keeps that machine's binding, sessions and
// worktrees attached to the project instead of stranding them on an orphan row.
export type CloudProjectInsert = { name: string; workspaceId: string; id?: string } & CloudProjectPatch;

export async function createProject(client: SupabaseClient, input: CloudProjectInsert): Promise<CloudProject> {
  const name = input.name.trim();
  if (!name) throw new Error("project name is required");
  const { data, error } = await client
    .from("projects")
    .insert({ ...toProjectRow(input), ...(input.id ? { id: input.id } : {}) })
    .select(PROJECT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toCloudProject(data as ProjectRow);
}
```

6. Delete `listMembers` (147-158), the comment block at 160-170, `inviteMember` (171-191) and `removeMember` (193-196) — they now live in `workspaces.ts`. Remove `MEMBER_COLUMNS` (line 11), `PROFILE_COLUMNS` (line 10), `ProfileRow` (28-33), `MemberRow` (35-41), `toProfile` (74-80), `toProjectMember` (82-86), and drop `Profile` and `ProjectMember` from the `./types` import on line 6.

7. Update `deleteProject`'s comment (198-202): `project_members` no longer exists, and the gate is now the workspace owner:

```ts
// Workspace-owner-only by policy (projects_delete_owner). `tasks` cascade, so this takes
// the whole card wall with it for every member; the LOCAL row on each machine disappears
// through the next full sync's prune, unless it still owns sessions. A DELETE the policy
// refuses matches zero rows WITHOUT an error, so callers must confirm with a re-read —
// see `remove()` in apps/ui/src/stores/projects.ts.
```

- [ ] **Step 5: Run the cloud tests**

Run: `pnpm --filter @kermanych/cloud test && pnpm --filter @kermanych/cloud build`
Expected: PASS for all five spec files, and no `tsc` errors.

- [ ] **Step 6: Fix the api fixtures**

`apps/api/src` does not change — `syncProjects` copies a whitelist that never included `ownerId`. Only the typed fixtures need it. In `kermanych/apps/api/test/sessions.from-task.spec.ts`, find the `cloudProjects` fixture and replace `ownerId: <...>` with `workspaceId: "00000000-0000-4000-8000-000000000ws1"` (any uuid-shaped string; nothing reads it).

Run: `grep -n "ownerId" apps/api/test/sessions.from-task.spec.ts`
Expected after the edit: no matches.

- [ ] **Step 7: Run the api suite as a regression gate**

Run: `pnpm --filter @kermanych/api typecheck && pnpm --filter @kermanych/api test`
Expected: PASS, with **zero** files changed under `apps/api/src`.

- [ ] **Step 8: Commit**

```bash
git add packages/cloud/src/types.ts packages/cloud/src/projects.ts packages/cloud/test/projects.spec.ts apps/api/test/sessions.from-task.spec.ts
git commit -m "feat(cloud)!: CloudProject carries workspaceId instead of ownerId

Moving a project is patchProject(id, { workspaceId }) - no dedicated mutation,
and an RLS-refused move throws rather than silently doing nothing: 42501 when the
destination fails WITH CHECK, PGRST116 when USING never matched the source.

apps/api/src is untouched: syncProjects copies a field whitelist that never
included ownerId. Only its test fixtures move."
```

---

### Task 6: Free the name `workspace` — rename the local-sessions route to `agents`

Mechanical cutover, done before the feature work so `workspace` means the cloud entity everywhere. The UI already labels this view «Агенти» (`MainLayout.vue:504`); only the route name and filename were out of step.

> **Execution order:** run this task **immediately after Task 3, before Task 4.** Its
> gate is a clean `ui typecheck`, and that is only achievable while the UI still
> compiles — Task 5 removes `CloudProject.ownerId`, which `stores/projects.ts` reads
> until Task 8 repairs it. Nothing in this task depends on the cloud package, so
> moving it earlier costs nothing. Task numbering is unchanged; only the dispatch
> order differs.

**Files:**
- Rename: `kermanych/apps/ui/src/pages/WorkspacePage.vue` → `kermanych/apps/ui/src/pages/AgentsPage.vue`
- Modify: `kermanych/apps/ui/src/router/routes.ts:47`
- Modify: `kermanych/apps/ui/src/layouts/MainLayout.vue:443,449,504,521,542`
- Modify: `kermanych/apps/ui/src/pages/BoardPage.vue:236-238`
- Modify: `kermanych/apps/ui/src/router/index.ts:50,66`
- Modify: `kermanych/apps/ui/src/pages/ChatPage.vue:196`
- Modify: `kermanych/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: route `name: 'agents'` at path `''`; component `pages/AgentsPage.vue`. No route named `workspace` remains.

- [ ] **Step 1: Find every reference**

Run: `grep -rn "WorkspacePage\|'workspace'\|\"workspace\"" apps/ui/src README.md`
Expected: the 10 sites listed above, plus `VIEWS`' `section: 'workspace'` at `MainLayout.vue:504`.

- [ ] **Step 2: Rename the file with the language server so imports follow**

Use the `lsp` tool's `rename_file` action (it rewrites importers, which a plain `git mv` does not):

```json
{"action": "rename_file", "file": "apps/ui/src/pages/WorkspacePage.vue", "new_name": "apps/ui/src/pages/AgentsPage.vue"}
```

If the server does not handle `.vue` moves, fall back to `git mv` and fix `routes.ts` by hand — it is the only importer (the route uses a dynamic `import('pages/WorkspacePage.vue')`).

- [ ] **Step 3: Rename the route and its references**

`routes.ts:47`:

```ts
      { path: '', name: 'agents', component: () => import('pages/AgentsPage.vue'), meta: { public: false } },
```

`MainLayout.vue:443` and `:504` — the constant and the view descriptor:

```ts
const PROJECT_SCOPED_VIEWS: readonly string[] = ['agents', 'management'];
```
```ts
  { value: 'agents', label: 'Агенти', route: 'agents', section: 'agents' },
```

Then replace the remaining `{ name: 'workspace' }` / `'workspace'` route pushes with `'agents'` at `MainLayout.vue:449,521,542`, `BoardPage.vue:237`, `router/index.ts:50,66`, `ChatPage.vue:196`.

- [ ] **Step 4: Update the README wording**

In `kermanych/README.md`, line ~303 says a from-task session "appears on the workspace board". Change to "appears on the Агенти board" so the docs stop using `workspace` for the local view.

- [ ] **Step 5: Verify nothing refers to the old name**

Run: `grep -rn "WorkspacePage\|name: 'workspace'\|'workspace'" apps/ui/src`
Expected: no matches.

- [ ] **Step 6: Typecheck and smoke the app**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: no errors.

Then run `pnpm dev:api` in one terminal and `pnpm dev:ui` in another, open <http://localhost:5317>, sign in, and check: the app lands on Агенти; the top nav switches Агенти / Дошка / Чат; clicking a project in the sidebar still selects it; a hard reload of `/#/` still lands on Агенти.

- [ ] **Step 7: Commit**

```bash
git add -A apps/ui/src README.md
git commit -m "refactor(ui): rename the local-sessions route from workspace to agents

The view has been labelled «Агенти» in the UI since v3 (MainLayout VIEWS); only
route.name and the filename still said workspace. Frees the name for the cloud
workspace entity."
```

---

### Task 7: Pure scope logic in `src/lib/scope.ts`

`apps/ui` has no component tests, so every decision the tree and the board make lives here, where the house convention can test it.

**Files:**
- Create: `kermanych/apps/ui/src/lib/scope.ts`
- Create: `kermanych/apps/ui/test/scope.spec.ts`

**Interfaces:**
- Consumes: `Workspace`, `CloudProject`, `Task` from `@kermanych/cloud`.
- Produces: `UNASSIGNED`, `type ScopeInput`, `type TaskFilters`, `type WorkspaceGroup`, `groupProjectsByWorkspace(workspaces, cloudProjects)`, `scopedProjectIds(scope, cloudProjects)`, `filterTasks(tasks, filters)`, `canDropProject(draggedProjectId, targetWorkspaceId, cloudProjects)`, `projectWorkspaceMap(cloudProjects)`.

- [ ] **Step 1: Write the failing tests**

Create `kermanych/apps/ui/test/scope.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CloudProject, Task, Workspace } from '@kermanych/cloud';
import {
  UNASSIGNED,
  canDropProject,
  filterTasks,
  groupProjectsByWorkspace,
  projectWorkspaceMap,
  scopedProjectIds,
} from '../src/lib/scope';

function ws(id: string, name: string, createdAt = '2026-01-01T00:00:00.000Z'): Workspace {
  return { id, name, ownerId: 'u1', createdAt };
}
function proj(id: string, workspaceId: string, name = id): CloudProject {
  return {
    id,
    name,
    workspaceId,
    carryFiles: ['.env'],
    envKeys: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
function task(id: string, projectId: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectId,
    title: id,
    status: 'backlog',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('groupProjectsByWorkspace', () => {
  it('keeps workspace order and puts each project under its own group', () => {
    const groups = groupProjectsByWorkspace(
      [ws('w1', 'AAA'), ws('w2', 'BBB')],
      [proj('p1', 'w2'), proj('p2', 'w1'), proj('p3', 'w1')],
    );
    expect(groups.map((g) => g.workspace.id)).toEqual(['w1', 'w2']);
    expect(groups[0]!.projects.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(groups[1]!.projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('keeps an empty workspace visible so it can be filled or deleted', () => {
    const groups = groupProjectsByWorkspace([ws('w1', 'AAA')], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projects).toEqual([]);
  });

  // A project whose workspace this user cannot see must not be invented into a group:
  // RLS decides which workspaces are visible, and rendering a name that does not exist
  // would be a lie. The sidebar shows such a project in its local-only bucket instead,
  // which MainLayout computes separately.
  it('drops projects whose workspace is not in the list', () => {
    const groups = groupProjectsByWorkspace([ws('w1', 'AAA')], [proj('p1', 'w-gone')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projects).toEqual([]);
  });
});

describe('projectWorkspaceMap', () => {
  it('maps project id to workspace id', () => {
    expect(projectWorkspaceMap([proj('p1', 'w1'), proj('p2', 'w2')])).toEqual({ p1: 'w1', p2: 'w2' });
  });
});

describe('scopedProjectIds', () => {
  const projects = [proj('p1', 'w1'), proj('p2', 'w1'), proj('p3', 'w2')];

  it('returns every project when nothing is selected', () => {
    expect(scopedProjectIds({}, projects)).toEqual(['p1', 'p2', 'p3']);
  });

  it('narrows to the selected workspace', () => {
    expect(scopedProjectIds({ workspaceId: 'w1' }, projects)).toEqual(['p1', 'p2']);
  });

  // A selected project always carries its workspace, so the scope stays the workspace
  // and the project filter does the narrowing. That keeps «Проєкти» meaningful.
  it('stays at the workspace even when a project is selected', () => {
    expect(scopedProjectIds({ workspaceId: 'w1', projectId: 'p1' }, projects)).toEqual(['p1', 'p2']);
  });

  it('falls back to every project for a workspace it does not know', () => {
    expect(scopedProjectIds({ workspaceId: 'w-gone' }, projects)).toEqual([]);
  });
});

describe('filterTasks', () => {
  const tasks = [
    task('t1', 'p1', { assigneeId: 'u1' }),
    task('t2', 'p1'),
    task('t3', 'p2', { assigneeId: 'u2' }),
    task('t4', 'p3', { assigneeId: 'u1' }),
  ];

  it('keeps only tasks inside the scope', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2'] });
    expect(out.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('applies the project filter on top of the scope', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2'], projectFilter: 'p2' });
    expect(out.map((t) => t.id)).toEqual(['t3']);
  });

  it('filters by assignee', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2', 'p3'], assigneeFilter: 'u1' });
    expect(out.map((t) => t.id)).toEqual(['t1', 't4']);
  });

  it('filters unassigned tasks with the UNASSIGNED sentinel', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2'], assigneeFilter: UNASSIGNED });
    expect(out.map((t) => t.id)).toEqual(['t2']);
  });

  it('treats an empty filter string as no filter', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1'], projectFilter: '', assigneeFilter: '' });
    expect(out.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('canDropProject', () => {
  const projects = [proj('p1', 'w1'), proj('p2', 'w2')];

  it('refuses a drop onto the workspace the project is already in', () => {
    expect(canDropProject('p1', 'w1', projects)).toBe(false);
  });

  it('allows a drop onto a different workspace', () => {
    expect(canDropProject('p1', 'w2', projects)).toBe(true);
  });

  it('refuses when nothing is being dragged or the project is unknown', () => {
    expect(canDropProject(undefined, 'w2', projects)).toBe(false);
    expect(canDropProject('p-gone', 'w2', projects)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kermanych/ui test -- scope`
Expected: FAIL — `Cannot find module '../src/lib/scope'`.

- [ ] **Step 3: Write the module**

Create `kermanych/apps/ui/src/lib/scope.ts`:

```ts
// The board's and the sidebar's decisions, as pure functions. apps/ui has no
// component tests (see apps/ui/test/*.spec.ts — pure unit only), so anything that can
// be wrong lives here rather than inside a .vue file.
import type { CloudProject, Task, Workspace } from '@kermanych/cloud';

// The «Не призначено» option's value. '' already means "no filter" throughout the UI
// (KSelect renders the placeholder as <option value="">), so unassigned needs a
// sentinel that cannot collide with a uuid.
export const UNASSIGNED = '\u0000unassigned';

export type WorkspaceGroup = { workspace: Workspace; projects: CloudProject[] };

// A project selection always carries its workspace (stores/orchestrator keeps that
// invariant), so both fields being set is normal, not a conflict.
export type ScopeInput = { workspaceId?: string | undefined; projectId?: string | undefined };

export type TaskFilters = {
  scopedProjectIds: string[];
  projectFilter?: string | undefined;
  assigneeFilter?: string | undefined;
};

// Workspace order is the cloud's (created_at); project order inside a group is the
// cloud's too. A project whose workspace is absent from `workspaces` is DROPPED, not
// re-homed: RLS decides which workspaces this user sees, and inventing a group for one
// they cannot read would render a name that does not exist.
export function groupProjectsByWorkspace(
  workspaces: Workspace[],
  cloudProjects: CloudProject[],
): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const workspace of workspaces) groups.set(workspace.id, { workspace, projects: [] });
  for (const project of cloudProjects) groups.get(project.workspaceId)?.projects.push(project);
  return [...groups.values()];
}

// Pushed into stores/orchestrator so selectProject() can resolve a project's workspace
// without importing the projects store (which already depends on orchestrator).
export function projectWorkspaceMap(cloudProjects: CloudProject[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of cloudProjects) map[p.id] = p.workspaceId;
  return map;
}

// Scope stays at the WORKSPACE even when a project is selected: the project narrows
// the board through the «Проєкти» filter instead, which is what keeps that filter
// meaningful and lets the user widen back to the whole group in one click.
export function scopedProjectIds(scope: ScopeInput, cloudProjects: CloudProject[]): string[] {
  if (!scope.workspaceId) return cloudProjects.map((p) => p.id);
  return cloudProjects.filter((p) => p.workspaceId === scope.workspaceId).map((p) => p.id);
}

export function filterTasks(tasks: Task[], filters: TaskFilters): Task[] {
  const inScope = new Set(filters.scopedProjectIds);
  const project = filters.projectFilter || undefined;
  const assignee = filters.assigneeFilter || undefined;
  return tasks.filter((t) => {
    if (!inScope.has(t.projectId)) return false;
    if (project && t.projectId !== project) return false;
    if (assignee === UNASSIGNED) return !t.assigneeId;
    if (assignee && t.assigneeId !== assignee) return false;
    return true;
  });
}

// Drop validity, decided from the dragged id held in component state — NOT from
// dataTransfer, whose getData() is unreadable during `dragover` (protected mode
// exposes only the types). Membership is not checked here: the user only ever sees
// workspaces they belong to, and projects_update_member has the final say.
export function canDropProject(
  draggedProjectId: string | undefined,
  targetWorkspaceId: string,
  cloudProjects: CloudProject[],
): boolean {
  if (!draggedProjectId) return false;
  const project = cloudProjects.find((p) => p.id === draggedProjectId);
  if (!project) return false;
  return project.workspaceId !== targetWorkspaceId;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kermanych/ui test -- scope`
Expected: PASS.

Do **not** run `pnpm --filter @kermanych/ui typecheck` here. `vue-tsc` checks the whole
app, and `stores/projects.ts` still reads the `CloudProject.ownerId` that Task 5 removed
— that store is repaired in Task 8, which owns the whole-project typecheck gate. A
failing typecheck at this point says nothing about `scope.ts`, whose own suite just passed.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/scope.ts apps/ui/test/scope.spec.ts
git commit -m "feat(ui): pure scope logic for the workspace tree and the board

groupProjectsByWorkspace, scopedProjectIds, filterTasks and canDropProject live
in lib/ because apps/ui has no component tests. Scope stays at the workspace
when a project is selected; the project narrows through the Проєкти filter."
```

---

### Task 8: Stores — workspace selection and workspace CRUD

**Files:**
- Modify: `kermanych/apps/ui/src/stores/orchestrator.ts:38-49,122-126,319-323`
- Modify: `kermanych/apps/ui/src/stores/projects.ts` (whole file)

**Interfaces:**
- Consumes: `scope.ts` from Task 7; `workspaces.ts` from Task 4; the re-shaped `CloudProject` from Task 5.
- Produces: on `useOrchestrator` — `selectedWorkspaceId`, `projectWorkspace`, `setProjectWorkspaces(map)`, `selectWorkspace(id)`, and `selectProject(id)` resolving the workspace. On `useProjects` — `workspaces`, `workspaceById`, `projectsByWorkspace`, `members` keyed by workspace id, `createWorkspace(name, color?)`, `patchWorkspace(id, patch)`, `removeWorkspace(id)`, `moveProject(projectId, workspaceId)`, `create(workspaceId, name, gitRemoteUrl?)`, `publish(local, workspaceId)`, `isOwner(projectId)` resolving through the workspace, `isWorkspaceOwner(workspaceId)`.

- [ ] **Step 1: Add the selection state to `orchestrator.ts`**

After `selectedProjectId` (line 41) add:

```ts
  const selectedWorkspaceId = ref<string | undefined>(undefined);
  // projectId -> workspaceId, pushed in by useProjects.load(). This store must NOT
  // import useProjects — that store already depends on this one for notify() and the
  // registry sync — so the map travels one way, downwards.
  const projectWorkspace = ref<Record<string, string>>({});
```

Replace `selectProject` (lines 123-126) with:

```ts
  function setProjectWorkspaces(map: Record<string, string>): void {
    projectWorkspace.value = map;
  }

  // Scope = a workspace. Clears the project so every project-scoped screen falls back
  // to its "nothing selected" shell instead of showing a stale project.
  function selectWorkspace(id: string): void {
    selectedWorkspaceId.value = id;
    selectedProjectId.value = undefined;
    selectedSessionId.value = undefined;
  }

  // Scope = a project, which ALWAYS carries its own workspace: both rows highlight in
  // the tree, and the board's scope stays the group while «Проєкти» narrows it.
  // One argument on purpose — the notification handler above has only a projectId, and
  // an optional workspace argument would let it highlight a group that does not
  // contain this project. A local-only project has no cloud row, so the map has no
  // entry and the workspace clears, which is the honest answer.
  function selectProject(id: string): void {
    selectedProjectId.value = id;
    selectedWorkspaceId.value = projectWorkspace.value[id];
    selectedSessionId.value = undefined;
  }
```

Add to the returned object (near line 320): `selectedWorkspaceId,`, `projectWorkspace,`, `setProjectWorkspaces,`, `selectWorkspace,`.

- [ ] **Step 2: Verify the existing `project_removed` handler still holds**

`orchestrator.ts:67-71` clears `selectedProjectId` when the selected project disappears. Add the workspace to that reset so the tree cannot keep a highlighted group with no project:

```ts
      if (selectedProjectId.value === e.projectId) {
        selectedProjectId.value = undefined;
        selectedWorkspaceId.value = undefined;
        selectedSessionId.value = undefined;
      }
```

- [ ] **Step 3: Rewrite `stores/projects.ts`**

Replace the imports (lines 4-16) with:

```ts
import type { Project } from '@kermanych/core';
import type {
  CloudProject,
  CloudProjectPatch,
  CloudWorkspacePatch,
  Workspace,
  WorkspaceMember,
} from '@kermanych/cloud';
import {
  createProject as cloudCreateProject,
  createWorkspace as cloudCreateWorkspace,
  deleteProject as cloudDeleteProject,
  deleteWorkspace as cloudDeleteWorkspace,
  inviteMember as cloudInviteMember,
  listMembers as cloudListMembers,
  listProjects as cloudListProjects,
  listWorkspaces as cloudListWorkspaces,
  patchProject as cloudPatchProject,
  patchWorkspace as cloudPatchWorkspace,
  removeMember as cloudRemoveMember,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { api } from '../lib/api';
import { projectWorkspaceMap } from '../lib/scope';
```

Replace the state block (lines 23-27) with:

```ts
  const auth = useAuth();
  const local = useOrchestrator();
  const workspaces = ref<Workspace[]>([]);
  const projects = ref<CloudProject[]>([]);
  // Keyed by WORKSPACE id now: membership is a workspace concept.
  const members = ref<Record<string, WorkspaceMember[]>>({});
  const loading = ref(false);
  const offlineError = ref<string | null>(null);

  // The tree, cached so the sidebar renders grouped before the first network call and
  // stays grouped when that call fails. Presentation state only — the local SQLite
  // registry deliberately knows nothing about workspaces (design D1: it caches what
  // LAUNCHING reads, and launching never reads a workspace).
  const TREE_CACHE_KEY = 'kermanych.workspace-tree';
  type TreeCache = { workspaces: Workspace[]; projectWorkspace: Record<string, string> };

  function readTreeCache(): void {
    try {
      const raw = localStorage.getItem(TREE_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as TreeCache;
      if (Array.isArray(cached.workspaces)) workspaces.value = cached.workspaces;
      if (cached.projectWorkspace) local.setProjectWorkspaces(cached.projectWorkspace);
    } catch {
      /* a corrupt cache is not worth a crash; the next load() overwrites it */
    }
  }

  function writeTreeCache(): void {
    const cache: TreeCache = {
      workspaces: workspaces.value,
      projectWorkspace: projectWorkspaceMap(projects.value),
    };
    try {
      localStorage.setItem(TREE_CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* storage full or blocked: the tree just falls back to a network read */
    }
  }

  readTreeCache();
```

Replace `load()` (lines 29-48) with:

```ts
  async function load(): Promise<CloudProject[]> {
    loading.value = true;
    try {
      // Workspaces first: the tree cannot place a project without its group, and RLS
      // scopes both reads to what this user belongs to.
      const [wsList, list] = await Promise.all([
        cloudListWorkspaces(auth.client),
        cloudListProjects(auth.client),
      ]);
      workspaces.value = wsList;
      projects.value = list;
      local.setProjectWorkspaces(projectWorkspaceMap(list));
      writeTreeCache();
      // This IS the full cloud list, so prune is safe: local rows missing from it are
      // stale cache. The api still refuses to prune a row that owns local sessions.
      await api.syncProjects(list, true);
      offlineError.value = null;
      return list;
    } catch (e) {
      // Offline degrades, it does not crash: record why and keep whatever is already
      // cached. The rail is driven by the LOCAL rows, so a failed cloud read means "no
      // fresh config", not "no projects" — and the caller gets a list, not an exception.
      offlineError.value = e instanceof Error ? e.message : String(e);
      return projects.value;
    } finally {
      loading.value = false;
    }
  }
```

Replace `create` (lines 50-63) with the workspace-scoped version, and add the workspace mutations next to it:

```ts
  async function createWorkspace(name: string, color?: string): Promise<Workspace> {
    const userId = auth.user?.id;
    if (!userId) throw new Error('not signed in');
    // exactOptionalPropertyTypes: an absent colour is an absent KEY, not `undefined`.
    const created = await cloudCreateWorkspace(auth.client, {
      name,
      ownerId: userId,
      ...(color ? { color } : {}),
    });
    workspaces.value = [...workspaces.value, created];
    writeTreeCache();
    return created;
  }

  async function patchWorkspace(id: string, patch: CloudWorkspacePatch): Promise<Workspace> {
    const updated = await cloudPatchWorkspace(auth.client, id, patch);
    workspaces.value = workspaces.value.map((w) => (w.id === id ? updated : w));
    writeTreeCache();
    return updated;
  }

  // Refused two ways, and the caller must be told which: workspaces_delete_owner
  // matches zero rows without an error for a non-owner, and the FK from
  // projects.workspace_id raises while the group still holds any.
  async function removeWorkspace(id: string): Promise<void> {
    if (projects.value.some((p) => p.workspaceId === id)) {
      throw new Error('спершу перенесіть або видаліть проєкти цього воркспейсу');
    }
    await cloudDeleteWorkspace(auth.client, id);
    const before = workspaces.value.length;
    workspaces.value = await cloudListWorkspaces(auth.client);
    if (workspaces.value.length === before) {
      throw new Error('хмара відмовила: видалити воркспейс може лише власник');
    }
    const rest = { ...members.value };
    delete rest[id];
    members.value = rest;
    writeTreeCache();
  }

  async function create(workspaceId: string, name: string, gitRemoteUrl?: string): Promise<CloudProject> {
    const created = await cloudCreateProject(auth.client, {
      name,
      workspaceId,
      ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    });
    projects.value = [...projects.value, created];
    local.setProjectWorkspaces(projectWorkspaceMap(projects.value));
    writeTreeCache();
    // prune=false: this is one project, not the full list.
    await api.syncProjects([created], false);
    return created;
  }

  // Moving a project between workspaces. No dedicated cloud call: it is a patch of
  // workspace_id, and projects_update_member (USING on the old row, WITH CHECK on the
  // new) is what requires membership of BOTH groups. A refused move always throws,
  // in one of two ways: 42501 when the DESTINATION fails WITH CHECK, PGRST116 when
  // USING never matched the SOURCE. The caller rolls back on either.
  async function moveProject(projectId: string, workspaceId: string): Promise<CloudProject> {
    return patch(projectId, { workspaceId });
  }
```

Replace `publish` (lines 77-98) — it now needs a destination:

```ts
  async function publish(localRow: Project, workspaceId: string): Promise<CloudProject> {
    const created = await cloudCreateProject(auth.client, {
      id: localRow.id,
      name: localRow.name,
      workspaceId,
      carryFiles: localRow.carryFiles ?? ['.env'],
      ...(localRow.color ? { color: localRow.color } : {}),
      ...(localRow.previewCommand ? { previewCommand: localRow.previewCommand } : {}),
      ...(localRow.apiCommand ? { apiCommand: localRow.apiCommand } : {}),
      ...(localRow.defaultBranch ? { defaultBranch: localRow.defaultBranch } : {}),
      ...(localRow.conventions ? { conventions: localRow.conventions } : {}),
    });
    projects.value = [...projects.value, created];
    local.setProjectWorkspaces(projectWorkspaceMap(projects.value));
    writeTreeCache();
    await api.syncProjects([created], false);
    return created;
  }
```

Rename the `local` parameter to `localRow` throughout `publish` (the store now binds `local` to the orchestrator). In `patch()` (lines 100-105) add the map refresh after the list update, because a patch may carry `workspaceId`:

```ts
    projects.value = projects.value.map((x) => (x.id === id ? updated : x));
    local.setProjectWorkspaces(projectWorkspaceMap(projects.value));
    writeTreeCache();
```

Re-key the three membership functions from project id to workspace id — rename the parameter and update the comment on `inviteMember`:

```ts
  async function loadMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const list = await cloudListMembers(auth.client, workspaceId);
    members.value = { ...members.value, [workspaceId]: list };
    return list;
  }

  // Re-inviting someone already in the workspace succeeds (invite_workspace_member is
  // idempotent), so merge by user id — appending would show them twice.
  async function inviteMember(workspaceId: string, email: string): Promise<WorkspaceMember> {
    const m = await cloudInviteMember(auth.client, workspaceId, email);
    const current = members.value[workspaceId] ?? [];
    members.value = {
      ...members.value,
      [workspaceId]: current.some((x) => x.userId === m.userId)
        ? current.map((x) => (x.userId === m.userId ? m : x))
        : [...current, m],
    };
    return m;
  }

  async function removeMember(workspaceId: string, userId: string): Promise<void> {
    await cloudRemoveMember(auth.client, workspaceId, userId);
    members.value = {
      ...members.value,
      [workspaceId]: (members.value[workspaceId] ?? []).filter((m) => m.userId !== userId),
    };
  }
```

Replace `byId` / `isOwner` (lines 157-164) and add the computeds the tree needs:

```ts
  const byId = computed(() => new Map(projects.value.map((p) => [p.id, p])));
  const workspaceById = computed(() => new Map(workspaces.value.map((w) => [w.id, w])));
  const projectsByWorkspace = computed(() =>
    groupProjectsByWorkspace(workspaces.value, projects.value),
  );

  // UX only — RLS is the real gate: the owner-only policies refuse a non-owner write
  // regardless of what these return.
  function isWorkspaceOwner(workspaceId: string): boolean {
    const uid = auth.user?.id;
    return !!uid && workspaceById.value.get(workspaceId)?.ownerId === uid;
  }

  // Keeps its name and signature: the question "may I administer this project" is
  // still the right one, only the answer now comes from the project's workspace. That
  // leaves its three callers (MainLayout, BoardPage, AgentsPage) unrewritten.
  function isOwner(projectId: string): boolean {
    const workspaceId = byId.value.get(projectId)?.workspaceId;
    return !!workspaceId && isWorkspaceOwner(workspaceId);
  }
```

Add `groupProjectsByWorkspace` to the `../lib/scope` import, and extend the returned object with `workspaces`, `workspaceById`, `projectsByWorkspace`, `createWorkspace`, `patchWorkspace`, `removeWorkspace`, `moveProject`, `isWorkspaceOwner`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/ui typecheck`
Expected: errors ONLY in `MainLayout.vue`, `BoardPage.vue` and `AgentsPage.vue`, where `create()`, `publish()` and `projects.members[...]` callers still use the old signatures. Those are Tasks 9-13. Note the specific lines the compiler names — they are the checklist for the remaining tasks.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/stores/orchestrator.ts apps/ui/src/stores/projects.ts
git commit -m "feat(ui): workspace selection and workspace CRUD in the stores

orchestrator gains selectedWorkspaceId plus a projectId->workspaceId map pushed
down by useProjects.load(), so selectProject() keeps one argument and the
notification handler cannot highlight the wrong group.

projects store gains workspaces, grouping, workspace-keyed membership, and a
localStorage tree cache so the sidebar stays grouped offline.

Callers in MainLayout/BoardPage/AgentsPage break here and are fixed in the
following tasks."
```

---

### Task 9: Kit components — option objects, workspace row, draggable rail item

**Files:**
- Modify: `kermanych/apps/ui/src/components/kit/KSelect.vue`
- Modify: `kermanych/apps/ui/src/components/kit/KRailItem.vue`
- Create: `kermanych/apps/ui/src/components/kit/KWorkspaceRow.vue`
- Modify: `kermanych/apps/ui/src/pages/KitGalleryPage.vue` (gallery entry for the new component)

**Interfaces:**
- Consumes: nothing.
- Produces: `KSelect` accepting `options: string[] | { value: string; label: string }[]` (backwards compatible); `KRailItem` with new props `indent?: boolean` and `draggable?: boolean` plus emits `dragstart` / `dragend`; `KWorkspaceRow` with props `{ workspace: { id: string; name: string; color?: string }, active?: boolean, expanded?: boolean, count?: number, dropTarget?: boolean }` and emits `select`, `toggle`, `add-project`.

- [ ] **Step 1: Teach `KSelect` option objects**

In `KSelect.vue`, replace the props, `mergedOptions` and the `<option>` loop. The string form must keep working — `KField`-style callers pass `string[]` in five places today:

```ts
// Options are either bare strings (label === value) or {value,label} pairs. The pair
// form exists because a filter keyed by NAME breaks on duplicates, and duplicate
// workspace names are entirely plausible.
export type KSelectOption = { value: string; label: string };

const props = defineProps<{
  label?: string;
  modelValue?: string;
  options: string[] | KSelectOption[];
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const normalized = computed<KSelectOption[]>(() =>
  props.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)),
);

// The current value is always kept as an option so a stale selection still renders —
// e.g. a workspace that was just deleted by someone else.
const mergedOptions = computed<KSelectOption[]>(() => {
  const v = props.modelValue;
  if (!v || normalized.value.some((o) => o.value === v)) return normalized.value;
  return [{ value: v, label: v }, ...normalized.value];
});
```

And the template loop:

```html
      <option v-for="opt in mergedOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
```

- [ ] **Step 2: Verify no existing KSelect caller broke**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: no NEW errors from the six `<KSelect>` usages (`MainLayout.vue:200`, `BoardPage.vue:9` and the launcher/editor selects) — they pass `string[]`, which still satisfies the union.

- [ ] **Step 3: Make `KRailItem` indentable and draggable**

In `KRailItem.vue`, extend the props:

```ts
const props = withDefaults(
  defineProps<{
    project: RailProject;
    active?: boolean;
    count?: number;
    // Nested under a workspace row in the tree.
    indent?: boolean;
    // Draggable so it can be moved to another workspace. Off by default: a local-only
    // project has no cloud row and therefore nowhere to move to.
    draggable?: boolean;
  }>(),
  { count: 0, indent: false, draggable: false },
);

const emit = defineEmits<{ dragstart: [id: string]; dragend: [] }>();
```

And the button — HTML5 drag needs the attribute plus the two handlers. `setData` is required for a standards-conformant drag even though the drop reads component state instead (`getData()` is unreadable during `dragover`):

```html
  <button
    class="k-rail"
    :class="{ 'k-rail--active': active, 'k-rail--indent': indent }"
    type="button"
    :title="title"
    :aria-label="title"
    :aria-pressed="active"
    :draggable="draggable"
    @dragstart="onDragStart"
    @dragend="emit('dragend')"
  >
```

```ts
function onDragStart(e: DragEvent): void {
  if (!props.draggable) return;
  e.dataTransfer?.setData('application/x-kermanych-project', props.project.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  emit('dragstart', props.project.id);
}
```

Add the indent rule to the `<style scoped>` block:

```scss
.k-rail--indent {
  padding-left: 26px;
}
```

- [ ] **Step 4: Create `KWorkspaceRow.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue';

// A workspace row in the left sidebar: the group header that is also the scope
// selector and the drop target for projects.
//
// THREE hit areas, deliberately separate — conflating them is the bug this comment
// exists to prevent:
//   chevron      -> toggle expansion only, never changes scope
//   add button   -> create a project INSIDE this workspace
//   rest of row  -> set the workspace scope, never toggles expansion
// Both buttons therefore stop propagation.
const props = withDefaults(
  defineProps<{
    workspace: { id: string; name: string; color?: string | undefined };
    active?: boolean;
    expanded?: boolean;
    count?: number;
    dropTarget?: boolean;
  }>(),
  { count: 0, active: false, expanded: true, dropTarget: false },
);

const emit = defineEmits<{ select: []; toggle: []; 'add-project': [] }>();

// Count-agnostic phrasing, because Ukrainian would need three plural forms.
const title = computed(
  () =>
    props.workspace.name +
    (props.count > 0 ? ` · запущено агентів: ${props.count}` : ' · немає запущених агентів'),
);
</script>

<template>
  <div
    class="k-ws"
    :class="{ 'k-ws--active': active, 'k-ws--drop': dropTarget }"
    :title="title"
  >
    <button
      class="k-ws__chevron"
      type="button"
      :aria-expanded="expanded"
      :aria-label="expanded ? `Згорнути ${workspace.name}` : `Розгорнути ${workspace.name}`"
      @click.stop="emit('toggle')"
    >{{ expanded ? '▾' : '▸' }}</button>
    <button
      class="k-ws__body"
      type="button"
      :aria-pressed="active"
      :aria-label="title"
      @click="emit('select')"
    >
      <span
        class="k-ws__dot"
        :style="workspace.color ? { background: workspace.color } : undefined"
        aria-hidden="true"
      ></span>
      <span class="k-ws__name">{{ workspace.name }}</span>
      <span v-if="count > 0" class="k-ws__count mono" aria-hidden="true">{{ count }}</span>
    </button>
    <button
      class="k-ws__add"
      type="button"
      v-tip="'Новий проєкт у цьому воркспейсі'"
      :aria-label="`Новий проєкт у ${workspace.name}`"
      @click.stop="emit('add-project')"
    >+</button>
  </div>
</template>

<style scoped lang="scss">
.k-ws {
  display: flex;
  align-items: center;
  gap: 2px;
  font-family: var(--k-font-ui);
  border-radius: var(--k-r);
  border: 1px solid transparent;
}

.k-ws--active {
  background: var(--k-surface-2);
}

/* The drop affordance has to read at a glance mid-drag, so it is a border, not a
   background: a background change is indistinguishable from the active row. */
.k-ws--drop {
  border-color: var(--k-accent);
}

.k-ws__chevron,
.k-ws__add {
  background: none;
  border: none;
  color: var(--k-text-dim);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 6px 4px;

  &:hover {
    color: var(--k-text);
  }
}

.k-ws__add {
  opacity: 0;
  font-size: 15px;
}

.k-ws:hover .k-ws__add {
  opacity: 1;
}

.k-ws__body {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  color: var(--k-text);
  cursor: pointer;
  font-size: 13px;
  padding: 7px 2px;
  text-align: left;
}

.k-ws__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--k-line-strong);
}

.k-ws__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.k-ws__count {
  font-size: 11px;
  color: var(--k-text-dim);
}
</style>
```

- [ ] **Step 5: Typecheck and eyeball the new row in the kit gallery**

Add `KWorkspaceRow` to `kermanych/apps/ui/src/pages/KitGalleryPage.vue` alongside the existing `KRailItem` sample, with two rows (one active/expanded, one collapsed with a colour and a count).

Run: `pnpm --filter @kermanych/ui typecheck`, then `pnpm dev:ui`, open <http://localhost:5317/#/kit> and check: the chevron toggles without highlighting the row, the `+` appears on hover only, and the colour dot renders.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/kit/KSelect.vue apps/ui/src/components/kit/KRailItem.vue apps/ui/src/components/kit/KWorkspaceRow.vue apps/ui/src/pages/KitGalleryPage.vue
git commit -m "feat(ui): KWorkspaceRow, draggable KRailItem, KSelect option objects

KSelect now takes {value,label} pairs as well as strings, so filters can be keyed
by id - a name-keyed filter breaks on duplicates.

KWorkspaceRow keeps its three hit areas separate: chevron toggles, + creates a
project, the row body sets scope."
```

---

### Task 10: The sidebar tree

**Files:**
- Modify: `kermanych/apps/ui/src/layouts/MainLayout.vue` — template lines 18-36, and the script's `railProjects` (564-586), `selectProject` (443-450), create-project modal state (655-686)

**Interfaces:**
- Consumes: `KWorkspaceRow`, `KRailItem` (Task 9); `useProjects.projectsByWorkspace`, `createWorkspace`, `create(workspaceId, …)` (Task 8); `groupProjectsByWorkspace` (Task 7).
- Produces: the grouped sidebar; `expanded` state persisted at `kermanych.workspace-collapsed`; `createWorkspaceOpen` / `createProjectFor` modal state.

- [ ] **Step 1: Replace the flat list in the template**

Replace lines 18-36 with the tree. The local-only bucket reuses the existing `orphan`/`unbound` states rather than inventing a new concept:

```html
        <div class="shell__side-label shell__side-label--row">
          <span>Воркспейси</span>
          <button
            class="shell__label-add"
            v-tip="'Новий воркспейс'"
            aria-label="Новий воркспейс"
            @click="openCreateWorkspace"
          >+</button>
        </div>
        <div class="shell__projects">
          <template v-for="group in tree" :key="group.workspace.id">
            <KWorkspaceRow
              :workspace="group.workspace"
              :active="store.selectedWorkspaceId === group.workspace.id && !store.selectedProjectId"
              :expanded="isExpanded(group.workspace.id)"
              :count="workspaceRunningCount(group)"
              :drop-target="dropTargetId === group.workspace.id"
              @select="selectWorkspace(group.workspace.id)"
              @toggle="toggleWorkspace(group.workspace.id)"
              @add-project="openCreateProject(group.workspace.id)"
              @dragover.prevent="onDragOver($event, group.workspace.id)"
              @dragleave="onDragLeave(group.workspace.id)"
              @drop.prevent="onDrop(group.workspace.id)"
            />
            <KRailItem
              v-for="p in isExpanded(group.workspace.id) ? railProjectsOf(group) : []"
              :key="p.id"
              :project="p"
              indent
              draggable
              :active="p.id === store.selectedProjectId"
              :count="runningCount(p.id)"
              @click="selectProject(p.id)"
              @dragstart="draggingProjectId = $event"
              @dragend="onDragEnd"
            />
          </template>
          <template v-if="localOnlyProjects.length">
            <div class="shell__side-label shell__side-label--sub">
              <span>Лише на цій машині</span>
            </div>
            <KRailItem
              v-for="p in localOnlyProjects"
              :key="p.id"
              :project="p"
              indent
              :active="p.id === store.selectedProjectId"
              :count="runningCount(p.id)"
              @click="selectProject(p.id)"
            />
          </template>
        </div>
```

- [ ] **Step 2: Build the tree in the script**

Import `KWorkspaceRow` next to `KRailItem`, and replace `railProjects` (564-586) with:

```ts
// The tree: cloud workspaces with their cloud projects. `groupProjectsByWorkspace`
// keeps cloud order and drops projects whose workspace this user cannot see.
const tree = computed(() => projects.projectsByWorkspace);

// A KRailItem view model for one cloud project, joined with the LOCAL row so the tile
// can render the binding state. Same join the flat list used to do, one group at a time.
function railProjectsOf(group: { projects: { id: string; name: string; color?: string | undefined }[] }): RailProject[] {
  return group.projects.map((c) => {
    const row = localById.value.get(c.id);
    return {
      id: c.id,
      name: c.name,
      color: c.color ?? row?.color,
      state: row?.localRepoPath ? 'bound' : 'unbound',
    };
  });
}

const localById = computed(() => new Map(store.projects.map((p) => [p.id, p])));

// Local rows with no cloud project: made before the team cloud, or while Supabase was
// unreachable. They have no workspace, so they get their own bucket instead of being
// hidden — the board's «Опублікувати в хмарі» section is how they get one.
const localOnlyProjects = computed<RailProject[]>(() => {
  const cloudIds = new Set(projects.projects.map((p) => p.id));
  return store.projects
    .filter((row) => !cloudIds.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      state: cloudSynced.value ? 'orphan' : row.localRepoPath ? 'bound' : 'unbound',
    }));
});

function workspaceRunningCount(group: { projects: { id: string }[] }): number {
  return group.projects.reduce((n, p) => n + runningCount(p.id), 0);
}
```

- [ ] **Step 3: Selection and expansion state**

Replace `PROJECT_SCOPED_VIEWS` and `selectProject` (443-450) — a sidebar click no longer navigates (Requirement 5):

```ts
// A sidebar click changes SCOPE and never navigates: both the board and Агенти read
// the scope, so yanking the user to another view on every click was pure friction.
function selectProject(id: string): void {
  store.selectProject(id);
}
function selectWorkspace(id: string): void {
  store.selectWorkspace(id);
}
```

Delete the now-unused `PROJECT_SCOPED_VIEWS` constant and, if `route` / `router` become unused in this file, their imports too (the compiler will say).

Add the expansion state next to the existing `collapsed` ref (line 434), reusing its localStorage idiom:

```ts
// Collapsed workspace ids. Stored as a list because a Set does not survive JSON.
const COLLAPSED_KEY = 'kermanych.workspace-collapsed';
const collapsedWorkspaces = ref<string[]>(
  (() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  })(),
);
function isExpanded(id: string): boolean {
  return !collapsedWorkspaces.value.includes(id);
}
function toggleWorkspace(id: string): void {
  collapsedWorkspaces.value = isExpanded(id)
    ? [...collapsedWorkspaces.value, id]
    : collapsedWorkspaces.value.filter((x) => x !== id);
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedWorkspaces.value));
}
```

- [ ] **Step 4: Split the create modal in two**

The existing create-project modal (template 169-192, state 655-686) becomes two: one for a workspace, one for a project inside a known workspace. Replace the state block with:

```ts
const createWorkspaceOpen = ref(false);
const createWorkspaceName = ref('');
const createProjectFor = ref<string | undefined>(undefined);
const createName = ref('');
const createRemote = ref('');
const createError = ref<string | null>(null);
const createBusy = ref(false);

function openCreateWorkspace(): void {
  createWorkspaceName.value = '';
  createError.value = null;
  createWorkspaceOpen.value = true;
}
function openCreateProject(workspaceId: string): void {
  createName.value = '';
  createRemote.value = '';
  createError.value = null;
  createProjectFor.value = workspaceId;
}

const canCreateWorkspace = computed(() => createWorkspaceName.value.trim() !== '');
const canCreate = computed(() => createName.value.trim() !== '');

async function submitCreateWorkspace(): Promise<void> {
  if (!canCreateWorkspace.value) return;
  createBusy.value = true;
  createError.value = null;
  try {
    const created = await projects.createWorkspace(createWorkspaceName.value.trim());
    createWorkspaceOpen.value = false;
    store.selectWorkspace(created.id);
    store.notify(`Воркспейс «${created.name}» створено`);
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
  }
}

async function submitCreate(): Promise<void> {
  const workspaceId = createProjectFor.value;
  if (!workspaceId || !canCreate.value) return;
  createBusy.value = true;
  createError.value = null;
  try {
    const created = await projects.create(
      workspaceId,
      createName.value.trim(),
      createRemote.value.trim() || undefined,
    );
    createProjectFor.value = undefined;
    store.selectProject(created.id);
    store.notify(`Проєкт «${created.name}» створено у хмарі`);
  } catch (e) {
    // Keep the modal open. The two real refusals are `not signed in` (the session
    // expired) and an RLS refusal on a workspace this user just lost access to.
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
  }
}
```

In the template, retitle the existing project modal and bind it to `createProjectFor`, then add the workspace modal beside it:

```html
    <KModal
      :model-value="createProjectFor !== undefined"
      :title="`Новий проєкт у «${projects.workspaceById.get(createProjectFor ?? '')?.name ?? ''}»`"
      @update:model-value="createProjectFor = undefined"
    >
```

```html
    <KModal v-model="createWorkspaceOpen" title="Новий воркспейс">
      <KField v-model="createWorkspaceName" label="Назва" placeholder="AAA" />
      <p class="shell__hint">
        Воркспейс групує проєкти й тримає склад команди: одне запрошення відкриває
        доступ до всіх його проєктів.
      </p>
      <p v-if="createError" class="shell__error" role="alert">{{ createError }}</p>
      <template #controls>
        <KBtn variant="ghost" @click="createWorkspaceOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canCreateWorkspace || createBusy" @click="submitCreateWorkspace">
          {{ createBusy ? 'Створюємо…' : 'Створити' }}
        </KBtn>
      </template>
    </KModal>
```

Add the sub-label style next to `.shell__side-label`:

```scss
.shell__side-label--sub {
  margin-top: 10px;
  opacity: 0.75;
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: the tree compiles. Remaining errors are confined to the settings modal (`members`, `isOwnerOfSelected`) — Task 11 — and `publish()` in `BoardPage.vue` — Task 13.

- [ ] **Step 6: Smoke the tree**

Run `pnpm dev:api` and `pnpm dev:ui`, sign in, and verify at <http://localhost:5317>:
1. Existing projects appear each under a same-named workspace (that is what the 1:1 backfill produces).
2. `+` beside «Воркспейси» creates a workspace; it appears and becomes the scope.
3. `+` on a workspace row creates a project inside it; the modal title names the workspace.
4. The chevron collapses/expands without changing the highlighted scope; reload the page and the collapsed state survives.
5. Clicking a project no longer navigates away from the current view.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue
git commit -m "feat(ui): grouped sidebar tree with per-workspace project creation

Workspaces are collapsible groups; projects nest under them. A sidebar click now
changes scope only and never navigates. Local-only projects get their own bucket
instead of disappearing from a tree that has no group for them."
```

---

### Task 11: Workspace settings modal, and relaxed project gates

**Files:**
- Modify: `kermanych/apps/ui/src/layouts/MainLayout.vue` — settings modal template (169-296), env modal (339-341), and the `members` / `isOwnerOfSelected` computeds (710-719), `saveSettings` (843-855), `saveEnv` (932-947), `submitMember` (747), `removeMemberOf` (765)

**Interfaces:**
- Consumes: `useProjects.loadMembers/inviteMember/removeMember` keyed by workspace id, `isWorkspaceOwner`, `patchWorkspace`, `removeWorkspace` (Task 8).
- Produces: a workspace settings modal; project settings with only «Видалити проєкт» owner-gated.

- [ ] **Step 1: Move the members panel to the workspace**

Cut the members block out of the project settings modal (`MainLayout.vue:250-286`, the member list plus the invite field) and the `Видалити воркспейс`-free footer, and paste it into a new modal. Requirement 2 makes invite and remove **owner-only**, so a plain member sees the roster read-only:

```html
    <KModal v-model="workspaceSettingsOpen" :title="`Воркспейс «${workspaceSettingsName}»`">
      <KField v-model="wsNameEdit" label="Назва" :disabled="!isOwnerOfWorkspace" />
      <KColorPicker
        v-model="wsColorEdit"
        label="Колір воркспейсу"
        :class="{ 'shell__readonly': !isOwnerOfWorkspace }"
      />
      <div class="shell__members">
        <div v-for="m in workspaceMembers" :key="m.userId" class="shell__member">
          <span class="shell__member-name">
            @{{ m.profile?.githubUsername ?? m.profile?.displayName ?? m.userId }}
          </span>
          <span class="shell__member-role mono">{{ m.role }}</span>
          <KBtn
            v-if="isOwnerOfWorkspace && m.role !== 'owner'"
            variant="ghost"
            title="Вилучити з воркспейсу"
            @click="removeMemberOf(m)"
          >×</KBtn>
        </div>
      </div>
      <template v-if="isOwnerOfWorkspace">
        <KField v-model="memberEmail" label="Запросити за email" placeholder="colleague@example.com" />
        <KBtn variant="secondary" :disabled="memberBusy || !memberEmail.trim()" @click="submitMember">
          {{ memberBusy ? 'Запрошуємо…' : 'Запросити' }}
        </KBtn>
      </template>
      <p v-else class="shell__hint">
        Склад воркспейсу змінює його власник. Одне запрошення відкриває доступ до всіх
        проєктів воркспейсу, тому воно й належить власнику.
      </p>
      <p v-if="wsError" class="shell__error" role="alert">{{ wsError }}</p>
      <template #controls>
        <KBtn
          v-if="isOwnerOfWorkspace"
          variant="ghost"
          class="shell__danger"
          :disabled="workspaceHasProjects"
          :title="workspaceHasProjects
            ? 'Спершу перенесіть або видаліть проєкти цього воркспейсу'
            : 'Видалити воркспейс'"
          @click="deleteWorkspace"
        >Видалити воркспейс</KBtn>
        <KBtn variant="ghost" @click="workspaceSettingsOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!isOwnerOfWorkspace" @click="saveWorkspace">Зберегти</KBtn>
      </template>
    </KModal>
```

- [ ] **Step 2: Wire its script**

Replace the `members` and `isOwnerOfSelected` computeds (710-719) with workspace-scoped ones, and add the modal's state:

```ts
const workspaceSettingsOpen = ref(false);
const workspaceSettingsId = ref<string | undefined>(undefined);
const wsNameEdit = ref('');
const wsColorEdit = ref('');
const wsError = ref<string | null>(null);

const workspaceSettingsName = computed(
  () => projects.workspaceById.get(workspaceSettingsId.value ?? '')?.name ?? '',
);
const workspaceMembers = computed<WorkspaceMember[]>(() =>
  workspaceSettingsId.value ? projects.members[workspaceSettingsId.value] ?? [] : [],
);
// UX only. Every owner-only path is refused by RLS regardless of what this returns.
const isOwnerOfWorkspace = computed(
  () => !!workspaceSettingsId.value && projects.isWorkspaceOwner(workspaceSettingsId.value),
);
const workspaceHasProjects = computed(() =>
  projects.projects.some((p) => p.workspaceId === workspaceSettingsId.value),
);

async function openWorkspaceSettings(id: string): Promise<void> {
  workspaceSettingsId.value = id;
  const ws = projects.workspaceById.get(id);
  wsNameEdit.value = ws?.name ?? '';
  wsColorEdit.value = ws?.color ?? '';
  wsError.value = null;
  workspaceSettingsOpen.value = true;
  try {
    await projects.loadMembers(id);
  } catch (e) {
    wsError.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveWorkspace(): Promise<void> {
  const id = workspaceSettingsId.value;
  if (!id) return;
  wsError.value = null;
  try {
    await projects.patchWorkspace(id, { name: wsNameEdit.value.trim(), color: wsColorEdit.value });
    workspaceSettingsOpen.value = false;
  } catch (e) {
    wsError.value = e instanceof Error ? e.message : String(e);
  }
}

async function deleteWorkspace(): Promise<void> {
  const id = workspaceSettingsId.value;
  if (!id) return;
  const name = workspaceSettingsName.value;
  if (!window.confirm(`Видалити воркспейс «${name}»?`)) return;
  wsError.value = null;
  try {
    await projects.removeWorkspace(id);
    workspaceSettingsOpen.value = false;
    store.notify(`Воркспейс «${name}» видалено`);
  } catch (e) {
    wsError.value = e instanceof Error ? e.message : String(e);
  }
}
```

Re-point `submitMember` (747) and `removeMemberOf` (765) at `workspaceSettingsId` instead of `store.selectedProjectId`, and change `removeMemberOf`'s confirm text to `Вилучити @${who} з воркспейсу «${workspaceSettingsName.value}»?`. Import `WorkspaceMember` from `@kermanych/cloud` and drop the `ProjectMember` import.

Open the modal from the workspace row — add to the `KWorkspaceRow` usage in Task 10's template a settings affordance. The row has no fourth button by design, so reuse the existing pattern: a click on the row's name while it is already the scope is a no-op, so wire it to the header gear that already exists for projects. Concretely, in the `shell__actions` block (95-96) add beside the project gear:

```html
        <KBtn
          v-if="store.selectedWorkspaceId"
          variant="icon"
          title="Налаштування воркспейсу"
          @click="openWorkspaceSettings(store.selectedWorkspaceId)"
        >⚙</KBtn>
```

- [ ] **Step 3: Relax the project gates**

In the project settings modal, delete `:disabled="!isOwnerOfSelected"` from lines 193, 213, 219, 225, 231, the `:class` binding on 198, `!isOwnerOfSelected` from the `:disabled` on 204 (keep `!isBound`), and `:disabled="!isOwnerOfSelected"` from the save button on 294. Delete the hint paragraph at 233-236 entirely. Change the `v-if` on the env-keys field (340) from `isOwnerOfSelected` to `true` — i.e. remove the `v-if`. Keep `v-if="isOwnerOfSelected"` on the delete button (288).

In `saveSettings` (843-855) delete the owner pre-check block:

```ts
  if (!isOwnerOfSelected.value) {
    settingsError.value = 'Змінювати налаштування проєкту може лише власник';
    return;
  }
```

In `saveEnv` (932-947) delete the `if (isOwnerOfSelected.value)` wrapper and always patch `envKeys` when it changed.

Then define `isOwnerOfSelected` in terms of the project's workspace so the delete button keeps working:

```ts
// Only «Видалити проєкт» is owner-only now: per the role matrix, any workspace member
// edits project config. Resolves through the project's workspace.
const isOwnerOfSelected = computed(
  () => !!store.selectedProjectId && projects.isOwner(store.selectedProjectId),
);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: clean, except `publish()` in `BoardPage.vue` (Task 13).

- [ ] **Step 5: Smoke both modals**

With two accounts if available, otherwise one:
1. Select a workspace, open ⚙ → rename it and set a colour → the sidebar row updates.
2. As owner: invite an email with no account → the rpc's message «no Kermanych account for …» is shown; invite a real teammate → they appear with role `member`.
3. «Видалити воркспейс» is disabled while it has projects, with the tooltip explaining why; empty the workspace and it deletes.
4. Open project settings as a **non-owner member**: every config field is editable and Save works; «Видалити проєкт» is absent.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue
git commit -m "feat(ui): workspace settings modal; project config is member-editable

Membership moves into workspace settings, owner-only for invite and remove
because one invitation now opens every project in the group.

Project config loses its owner gate on eight controls and env key names per the
role matrix; only «Видалити проєкт» stays owner-only."
```

---

### Task 12: Drag a project into another workspace

**Files:**
- Modify: `kermanych/apps/ui/src/layouts/MainLayout.vue` (drag handlers + the project settings «Воркспейс» select)

**Interfaces:**
- Consumes: `canDropProject` (Task 7); `useProjects.moveProject` (Task 8); `KRailItem`'s `dragstart`/`dragend` and `KWorkspaceRow`'s drop-target styling (Task 9).
- Produces: `draggingProjectId`, `dropTargetId`, `onDragOver`, `onDragLeave`, `onDrop`, `onDragEnd`; a «Воркспейс» select in project settings.

- [ ] **Step 1: Add the drag state and handlers**

```ts
// HTML5 drag-and-drop, hand-rolled: one gesture, and a library would bring its own
// reactivity model for it.
//
// The dragged id lives HERE, not in dataTransfer: getData() is unreadable during
// `dragover` (protected mode exposes only the types), so a drop-validity decision
// taken from dataTransfer would always see an empty payload. dataTransfer still
// carries it, for a standards-conformant drag.
const draggingProjectId = ref<string | undefined>(undefined);
const dropTargetId = ref<string | undefined>(undefined);

function onDragOver(e: DragEvent, workspaceId: string): void {
  if (!canDropProject(draggingProjectId.value, workspaceId, projects.projects)) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dropTargetId.value = workspaceId;
}

function onDragLeave(workspaceId: string): void {
  if (dropTargetId.value === workspaceId) dropTargetId.value = undefined;
}

function onDragEnd(): void {
  draggingProjectId.value = undefined;
  dropTargetId.value = undefined;
}

async function onDrop(workspaceId: string): Promise<void> {
  const projectId = draggingProjectId.value;
  onDragEnd();
  if (!projectId || !canDropProject(projectId, workspaceId, projects.projects)) return;
  const from = projects.byId.get(projectId)?.workspaceId;
  const name = projects.byId.get(projectId)?.name ?? projectId;
  try {
    await projects.moveProject(projectId, workspaceId);
    store.notify(`«${name}» перенесено у «${projects.workspaceById.get(workspaceId)?.name ?? ''}»`);
  } catch (e) {
    // projects_update_member refuses a move into a workspace the user does not belong
    // to with 42501 (WITH CHECK is evaluated against the new row and raises), and a
    // source it cannot see with zero rows -> PGRST116. Both mean the same thing to
    // the user, so say that rather than echoing either code.
    const raw = e instanceof Error ? e.message : String(e);
    store.notify(
      /42501|violates row-level security|PGRST116/.test(raw)
        ? 'Хмара відмовила: переносити проєкт можна лише між воркспейсами, у яких ви учасник'
        : raw,
      'error',
    );
    if (from) await projects.load();
  }
}
```

Import `canDropProject` from `../lib/scope`.

- [ ] **Step 2: Add the non-mouse path**

Drag is mouse-only, and a collapsed or off-screen destination has no drop target, so project settings gets a select. Add it to the project settings modal after the name field:

```html
        <KSelect
          v-model="workspaceEdit"
          label="Воркспейс"
          :options="workspaceOptions"
        />
```

```ts
// {value,label} form: two workspaces may share a name, and a name-keyed select would
// move the project into whichever one matched first.
const workspaceOptions = computed(() =>
  projects.workspaces.map((w) => ({ value: w.id, label: w.name })),
);
const workspaceEdit = ref('');
```

Set it in `openSettings` (807): `workspaceEdit.value = selectedCloud.value?.workspaceId ?? '';`, and in `saveSettings` include it in the patch only when it changed:

```ts
    const moved = workspaceEdit.value && workspaceEdit.value !== selectedCloud.value?.workspaceId;
    await projects.patch(id, {
      name,
      // …the existing fields…
      ...(moved ? { workspaceId: workspaceEdit.value } : {}),
    });
```

- [ ] **Step 3: Smoke the drag**

Run `pnpm dev:api` + `pnpm dev:ui` and verify:
1. Create a second workspace. Drag a project onto its row — the row shows an accent border only while a valid drop is possible.
2. Dragging a project onto **its own** workspace shows no border and does nothing on release.
3. Release on the other workspace → the project moves in the tree and a toast confirms it; reload the page and it is still there.
4. Collapse the destination workspace, then move a project into it through project settings → «Воркспейс» select → Save.
5. If a second account is available: have A create a workspace B is not in, then have B attempt the move via the select → the refusal toast appears and the tree snaps back.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/layouts/MainLayout.vue
git commit -m "feat(ui): drag a project into another workspace

Hand-rolled HTML5 DnD. The dragged id is component state, not dataTransfer,
because getData() is unreadable during dragover. Project settings gains a
Воркспейс select as the non-mouse path and for collapsed destinations.

A refused move (42501 from WITH CHECK, or PGRST116 from USING) is reported in
plain words and the tree refetches."
```

---

### Task 13: Board scope and the two filters

**Files:**
- Modify: `kermanych/apps/ui/src/pages/BoardPage.vue` — header (8-19), `projectFilter` / `visibleTasks` / `byColumn` (336-360), the publish section (27-44) and `publishProject`, the create/edit modal project pickers, `memberHandles` (651-667)
- Modify: `kermanych/packages/cloud/src/types.ts` — delete the now-unused `ProjectMember` type
- Modify: `kermanych/packages/cloud/src/index.ts` — drop `ProjectMember` from the `./types` re-export block

**Interfaces:**
- Consumes: `scopedProjectIds`, `filterTasks`, `UNASSIGNED` (Task 7); `useProjects.workspaces/members/loadMembers` (Task 8); `KSelect` option objects (Task 9).
- Produces: an id-keyed «Проєкти» filter, an «Виконавці» filter, and a scope heading. Also retires `ProjectMember` from `@kermanych/cloud`.

> **This task owns the last consumer of `ProjectMember`, so it retires the type.** Task 4
> added `WorkspaceMember` beside it rather than replacing it, because `projects.ts` still
> imported it; Task 5 then dropped that import. The remaining consumers are
> `MainLayout.vue` (Task 11) and `BoardPage.vue` — this file. Once the `memberHandles`
> rewrite below is done, nothing references it, so delete the type and its barrel export
> here and confirm with `grep -rn "ProjectMember" kermanych/` that only historical docs
> under `docs/superpowers/` still mention it.

- [ ] **Step 1: Replace the single filter with two**

Template, lines 8-19:

```html
      <div class="board__controls">
        <KSelect
          v-model="projectFilter"
          :options="projectOptions"
          placeholder="Усі проєкти"
        />
        <KSelect
          v-model="assigneeFilter"
          :options="assigneeOptions"
          placeholder="Усі виконавці"
        />
        <KBtn
          variant="primary"
          :disabled="!cloud.projects.length"
          :title="newTaskHint"
          @click="openCreate"
        >Нова задача</KBtn>
      </div>
```

And the heading (4-7) gains the scope:

```html
      <div class="board__title">
        <h1 class="board__heading">{{ scopeHeading }}</h1>
        <span class="board__count mono">{{ visibleTasks.length }} задач</span>
      </div>
```

- [ ] **Step 2: Replace the filter logic**

Replace lines 336-360:

```ts
// Scope comes from the sidebar: a workspace narrows to its projects, nothing selected
// means every project this user can see. Note this does NOT narrow the Realtime
// channel — see stores/board.ts.
const scoped = computed(() =>
  scopedProjectIds(
    {
      ...(store.selectedWorkspaceId ? { workspaceId: store.selectedWorkspaceId } : {}),
      ...(store.selectedProjectId ? { projectId: store.selectedProjectId } : {}),
    },
    cloud.projects,
  ),
);

const projectFilter = ref('');
const assigneeFilter = ref('');

// Id-keyed, not name-keyed: two projects may share a name.
const projectOptions = computed(() =>
  cloud.projects
    .filter((p) => scoped.value.includes(p.id))
    .map((p) => ({ value: p.id, label: p.name })),
);

// The members of the scoped workspace, plus the category that had no representation
// before: tasks nobody has picked up.
const assigneeOptions = computed(() => {
  const roster = store.selectedWorkspaceId ? cloud.members[store.selectedWorkspaceId] ?? [] : [];
  return [
    { value: UNASSIGNED, label: 'Не призначено' },
    ...roster.map((m) => ({
      value: m.userId,
      label: m.profile?.githubUsername ?? m.profile?.displayName ?? m.userId,
    })),
  ];
});

const scopeHeading = computed(() => {
  const ws = store.selectedWorkspaceId
    ? cloud.workspaceById.get(store.selectedWorkspaceId)?.name
    : undefined;
  return ws ? `Дошка · ${ws}` : 'Дошка команди';
});

const visibleTasks = computed(() =>
  filterTasks(board.tasks, {
    scopedProjectIds: scoped.value,
    projectFilter: projectFilter.value,
    assigneeFilter: assigneeFilter.value,
  }),
);

const byColumn = computed<Record<string, Task[]>>(() => {
  const out: Record<string, Task[]> = {};
  for (const col of COLUMNS) out[col.key] = visibleTasks.value.filter((t) => col.statuses.includes(t.status));
  return out;
});

// Requirement 6: clicking a project in the sidebar pre-selects it here. A manual
// change afterwards is not clobbered, because only a NEW sidebar selection fires this.
watch(
  () => store.selectedProjectId,
  (id) => {
    projectFilter.value = id ?? '';
  },
);

// A filter naming a project outside the new scope would silently empty the board.
watch(scoped, (ids) => {
  if (projectFilter.value && !ids.includes(projectFilter.value)) projectFilter.value = '';
});
```

Import `scopedProjectIds`, `filterTasks` and `UNASSIGNED` from `../lib/scope`.

- [ ] **Step 3: Load the roster for the scoped workspace**

The board used to load members per project. Replace that `loadMembers()` loop with one keyed on the workspace, and re-run it when the scope changes:

```ts
// The assignee picker and the «Виконавці» filter both read the workspace roster.
async function loadRoster(): Promise<void> {
  const id = store.selectedWorkspaceId;
  if (!id || cloud.members[id]) return;
  try {
    await cloud.loadMembers(id);
  } catch {
    /* the roster is a nicety; the board still renders without it */
  }
}
watch(() => store.selectedWorkspaceId, () => void loadRoster(), { immediate: true });
```

Then update `memberHandles(projectId)` in the task editor (651-667) to resolve the project's workspace first:

```ts
function memberHandles(projectId: string) {
  const workspaceId = cloud.byId.get(projectId)?.workspaceId;
  return workspaceId ? cloud.members[workspaceId] ?? [] : [];
}
```

- [ ] **Step 4: Give the publish flow a destination workspace**

`publishProject(p)` now needs a workspace. Add a select to the publish row and pass it:

```html
      <div v-for="p in unpublished" :key="p.id" class="board__publish-row">
        <span class="board__publish-name">{{ p.name }}</span>
        <span class="board__publish-path mono">{{ p.localRepoPath || 'не прив’язано' }}</span>
        <KSelect
          v-model="publishInto[p.id]"
          :options="workspaceOptions"
          placeholder="— виберіть воркспейс —"
        />
        <KBtn
          variant="primary"
          :disabled="!!publishing || !publishInto[p.id]"
          :title="`Створити «${p.name}» у хмарі — id, тека й сесії не змінюються`"
          @click="publishProject(p)"
        >{{ publishing === p.id ? 'Публікуємо…' : 'Опублікувати в хмарі' }}</KBtn>
      </div>
```

```ts
const publishInto = ref<Record<string, string>>({});
const workspaceOptions = computed(() =>
  cloud.workspaces.map((w) => ({ value: w.id, label: w.name })),
);
```

And inside `publishProject`, pass `publishInto.value[p.id]` as `publish()`'s second argument, refusing early when it is empty.

- [ ] **Step 5: Scope the create-task project picker**

In the create/edit task modal, the project select's options become `projectOptions` (already scoped and id-keyed). Because it was name-keyed before, delete `projectIdByName` and any `draftProject` name↔id conversion, storing the id directly.

- [ ] **Step 6: Typecheck and smoke**

Run: `pnpm --filter @kermanych/ui typecheck && pnpm --filter @kermanych/ui test`
Expected: clean, and the `scope.spec.ts` suite still passes.

Then with the app running:
1. Select a workspace in the sidebar → the heading reads `Дошка · <name>`, and only its tasks show.
2. «Проєкти» lists only that workspace's projects; picking one narrows the board.
3. Click a project in the sidebar → «Проєкти» is already set to it; change the filter by hand and it stays changed.
4. «Виконавці» lists the workspace roster; «Не призначено» shows only unclaimed cards.
5. Switch to another workspace → the project filter resets rather than emptying the board.
6. A local-only project shows the publish row with a workspace select; publishing into a workspace makes it appear in the tree under that group.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/pages/BoardPage.vue
git commit -m "feat(ui): board scope plus Проєкти and Виконавці filters

Scope comes from the sidebar and is client-side only - the Realtime channel still
covers every visible project, because a postgres_changes filter cannot be edited
in place and would be torn down on every workspace click.

Both filters are id-keyed; the old name-keyed project filter broke on duplicate
names. Adds a «Не призначено» option, which had no representation before."
```

---

### Task 14: Agents page scope

**Files:**
- Modify: `kermanych/apps/ui/src/pages/AgentsPage.vue` — blank state (3-7), session filter (592-600), `selectedProject` (620-622)

**Interfaces:**
- Consumes: `scopedProjectIds` (Task 7); `useOrchestrator.selectedWorkspaceId`, `useProjects.projects` (Task 8).
- Produces: sessions filtered by scope rather than by a single project id.

- [ ] **Step 1: Generalise the filter**

Replace the equality test at line 594:

```ts
// Scope, not a single project: selecting a workspace shows the agents of every project
// in it, which is the same question the board answers one level up.
const scoped = computed(() =>
  scopedProjectIds(
    {
      ...(store.selectedWorkspaceId ? { workspaceId: store.selectedWorkspaceId } : {}),
      ...(store.selectedProjectId ? { projectId: store.selectedProjectId } : {}),
    },
    projects.projects,
  ),
);
const inScope = computed(() => new Set(store.selectedProjectId ? [store.selectedProjectId] : scoped.value));
```

and in the `.filter((s) => { … })` chain change the first line to:

```ts
      if (!inScope.value.has(s.projectId)) return false;
```

Import `scopedProjectIds` from `../lib/scope`, and `useProjects` if the page does not already have it.

- [ ] **Step 2: Update the blank state**

Line 4-7:

```html
    <div v-if="!store.selectedProjectId && !store.selectedWorkspaceId" class="ws__blank">
      <div class="ws__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="ws__blank-text">Виберіть воркспейс або проєкт у лівій панелі, щоб побачити агентів.</p>
    </div>
```

- [ ] **Step 3: Guard the project-only actions**

The launcher, folder binding and git sync all need a single project (`canLaunch` at 945 already requires `store.selectedProjectId`). Verify no action becomes reachable with only a workspace selected:

Run: `grep -n "selectedProjectId" apps/ui/src/pages/AgentsPage.vue`
Every hit must either be inside `inScope`/`scoped`, or already guarded by `!projectId → return`. Fix any that is not.

- [ ] **Step 4: Typecheck and smoke**

Run: `pnpm --filter @kermanych/ui typecheck`

Then, with the app running:
1. Select a workspace → Агенти lists sessions from all its projects; the launcher is unavailable (no single project).
2. Select a project inside it → only that project's sessions, launcher available as before.
3. Deselect by reloading with nothing selected → the blank state mentions both.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/AgentsPage.vue
git commit -m "feat(ui): Агенти follows the workspace scope

A workspace selection lists the agents of every project in it; a project
selection behaves exactly as before. Project-only actions stay guarded on
selectedProjectId."
```

---

### Task 15: Documentation and the pre-merge smoke run

**Files:**
- Modify: `kermanych/README.md`
- Modify: `kermanych/docs/superpowers/specs/2026-08-21-team-cloud-design.md` (one line: the superseded non-goal)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation matching the shipped behaviour, and a recorded smoke run.

- [ ] **Step 1: Document workspaces in the README**

In the «The shared board (cloud)» section, replace the paragraph beginning "**Membership is by email.**" with:

```markdown
**Projects live in workspaces, and membership is per workspace.** A workspace groups
the projects of one product — `back-end`, `admin`, `mobile` — and holds the team: its
owner invites a colleague by the email address their account signed in with, and that
one invitation opens every project in the workspace. There are no pending invitations:
the address must already belong to an account, so ask a newcomer to press **Увійти
через GitHub** once before inviting them. Removing a member is the owner's call too.

Any member may create projects in a workspace, edit their config and work the board.
Only the owner deletes a project or the workspace itself — and a workspace holding
projects cannot be deleted at all, so nothing disappears by cascade. Drag a project
onto another workspace's row in the sidebar to move it; you must be a member of both,
which the database enforces, not just the UI.
```

- [ ] **Step 2: Retire the superseded non-goal**

In `docs/superpowers/specs/2026-08-21-team-cloud-design.md`, line 620, replace the non-goal with a pointer so the old spec does not contradict the new one:

```markdown
- ~~No team/workspace layer above projects (flat owner/member).~~ **Superseded**
  2026-08-27 by `2026-08-27-workspaces-design.md`: membership moved up to a
  `workspaces` level and `project_members` was retired.
```

- [ ] **Step 3: Run every suite**

Run:
```bash
cd kermanych
supabase db reset
pnpm -r test
pnpm --filter @kermanych/ui typecheck
pnpm --filter @kermanych/api typecheck
pnpm build
```
Expected: all green.

- [ ] **Step 4: Confirm the untouched-layer claim**

Run: `git diff --stat main -- apps/api/src packages/core/src`
Expected: **no output**. If anything appears there, the design was violated — stop and reconcile with the spec before merging.

- [ ] **Step 5: Two-account manual smoke**

Required before merge. With accounts A and B:
1. A creates workspace «AAA» and projects `back-end`, `admin`, `mobile` in it.
2. A opens workspace settings and invites B by email. B reloads and sees all three projects under «AAA» without a single project-level invitation.
3. B creates a task in `admin`, A assigns it to B, B binds the repo and presses «Запустити»; A watches `queued → thinking → done` on the board.
4. B selects «AAA» → the board heading names it and shows tasks from all three projects; «Проєкти» and «Виконавці» both filter; «Не призначено» shows only unclaimed cards.
5. B clicks `admin` → «Проєкти» is pre-selected to it.
6. A creates workspace «BBB» (B not invited). B drags `admin` onto «BBB» — no drop affordance appears, because B cannot see «BBB» at all. A drags `admin` into «BBB» → it moves; B's tree loses `admin` after a reload, and its tasks leave B's board.
7. A tries to delete «AAA» while it holds projects → refused with the explanation; A moves the projects out, then deletes it.
8. As a plain member, B edits `back-end`'s conventions and saves → accepted. B looks for «Видалити проєкт» → absent.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-21-team-cloud-design.md
git commit -m "docs: workspaces in the README; retire the superseded non-goal"
```

- [ ] **Step 7: Pre-push gate — prove the backfill's one visibility exception is absent**

Task 2's review found the single state in which the backfill *widens* visibility, contrary
to Requirement 9. For a project whose `owner_id` has **no** `project_members` row, the
owner today sees the project (the old `projects_select_member` carried an
`owner_id = auth.uid()` disjunct) but **not** its tasks, and cannot repair that, because
`invite_project_member` requires the caller to already be a member. After the migration
`handle_new_workspace` seats that owner, so `is_project_member` turns true and the tasks
become visible to them.

It is bounded to a project's own owner and it arguably repairs a broken state — but this
migration runs once against real data, so measure instead of assuming. Against the hosted
project, BEFORE pushing:

```sql
select count(*) from projects p
 where not exists (
   select 1 from project_members m
    where m.project_id = p.id and m.user_id = p.owner_id);
```

Zero rules the case out entirely and you push with Requirement 9 intact. Non-zero means
each such project's owner is about to gain visibility of its tasks: list them
(`select id, name, owner_id from projects p where not exists (…)`), decide per project
whether that is repair or leak, and record the decision before pushing. Do not push on an
unexamined non-zero result.

- [ ] **Step 8: Push the migration to the team's project**

**This is the coordinated cutover — the breakage window is real.** The migration drops `projects.owner_id`, which every not-yet-updated client still selects in `PROJECT_COLUMNS`; those clients will fail on the project list and the board until they pull. Announce first, then:

```bash
cd kermanych
supabase link --project-ref uqqdudlfizfwqfegfrlh   # once per clone
supabase migration list --linked                   # confirm only 20260827100000 is missing
supabase db push --linked --dry-run
supabase db push --linked
```

Then tell the team to `git pull` immediately. Verify against the hosted project: sign in, confirm the tree renders and the board loads.

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task:

| Spec section | Task |
|---|---|
| Data model — Supabase (tables, backfill, functions) | 1, 2 |
| RLS policies | 1, 2 |
| Naming (`workspace` → `agents`) | 6 |
| Data model — local SQLite ("no change") | verified in 5 step 7 and 15 step 4 |
| `@kermanych/cloud` | 4, 5 |
| UI — Selection | 8 |
| UI — `src/lib/scope.ts` | 7 |
| UI — Sidebar tree | 10 |
| UI — Drag-and-drop | 12 |
| UI — Board | 13 |
| UI — Agents | 14 |
| UI — Stores | 8 |
| UI — Permission gates relaxed | 11 |
| Rollout | 15 step 7 |
| Verification — rehearsal script | 3 |
| Verification — cloud unit, RLS, ui unit, api regression | 4, 5, 1, 2, 7 |
| Verification — manual smoke | 15 step 5 |

**2. Requirement coverage.** R1 → Task 1; R2 (owner-only invite) → Task 1 step 2 test + Task 11 UI; R3 (`not null`) → Task 2; R4 (role matrix) → Tasks 2, 11; R5 (click never navigates) → Task 10 step 3; R6 (board scope + pre-selection) → Task 13; R7 (DnD + non-mouse path) → Task 12; R8 (non-empty workspace undeletable) → Task 2 test + Task 8 `removeWorkspace` + Task 11 disabled button; R9 (visibility preserved) → Task 3.

**3. Type consistency.** `Workspace`/`WorkspaceMember` are defined in Task 4 and consumed unchanged in 5, 8, 11. `CloudProjectPatch` gains `workspaceId` in Task 5 and is used by `moveProject` (8) and the settings select (12). `scopedProjectIds`/`filterTasks`/`canDropProject`/`groupProjectsByWorkspace`/`projectWorkspaceMap` are defined in Task 7 and consumed in 8, 10, 12, 13, 14 with matching signatures. `setProjectWorkspaces(map)` is defined in Task 8 step 1 and called in Task 8 step 3. `KSelect`'s option-object form arrives in Task 9 and is first used in Task 12.

**4. Local-only projects are not `groupProjectsByWorkspace`'s problem.** It takes two arguments and drops any project whose workspace is not in the list. The «Лише на цій машині» bucket is computed in `MainLayout` (Task 10 step 2, `localOnlyProjects`) from the local registry rows that have no cloud row at all — a different input, so folding it into the grouping function would have meant passing a parameter it never reads.
