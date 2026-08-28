# Cutover runbook — `20260827100000_workspaces.sql`

The workspaces migration is the first one in this repository that **drops** things the
shipped client still reads. `supabase db push` on it is a coordinated event with a real
breakage window, not a routine deploy. This is the sequence to follow.

Every other migration to date only added. If you are pushing one of those, the short
recipe in [the README](../README.md#applying-a-migration-to-the-teams-project) is enough
and you do not need this file.

| | |
|---|---|
| migration | `supabase/migrations/20260827100000_workspaces.sql` |
| hosted project ref | `uqqdudlfizfwqfegfrlh` |
| what it drops | `projects.owner_id`, `public.project_members`, `invite_project_member()`, `handle_new_project()` |
| who is affected | every teammate whose checkout predates the merge |
| window length | from `db push` until each teammate has pulled and rebuilt — minutes, but it is per person |

## What breaks, and for how long

A client built before this branch selects `owner_id` in `PROJECT_COLUMNS`
(`packages/cloud/src/projects.ts`). The moment the column is gone, PostgREST answers

```
42703  column projects.owner_id does not exist
```

and `listProjects()` throws. Concretely, on an un-pulled machine:

- **The sidebar project list is empty and the board does not load.** Both go through
  `listProjects()`. The UI reports it as an offline/cloud error, which is misleading —
  the cloud is up, the query is wrong.
- **The local API's project sync fails** the same way, so a running desktop app degrades
  as well, not only a browser tab.
- **The members panel fails** — `project_members` no longer exists (`42P01`) and
  «Запросити» hits `PGRST202 Could not find the function invite_project_member`.
- **Creating or editing a project fails**: the old insert sends `owner_id` and omits
  `workspace_id`, which is now `not null`.

What keeps working through the window:

- **Running sessions.** Worktrees, `omp` children and everything local are untouched.
- **Status mirroring.** `updateTaskStatus()` writes `tasks` only and names no dropped
  column, so a session that is mid-flight keeps pushing `thinking → done` to the board,
  and the offline outbox keeps draining.

There is no way to make the old client tolerate the new schema, so the announcement is
part of the procedure, not a courtesy. **Announce first, push second.**

## Preconditions

- The branch is merged to `dev`, or is about to be, and everyone can `git pull` it.
- `supabase login` done, CLI on your PATH.
- The local rehearsal has been run at least once on this commit — see
  [Appendix: the local rehearsal](#appendix-the-local-rehearsal). It is the only proof
  that the backfill preserves visibility (Requirement 9), and it cannot be a permanent
  test: `supabase db reset` runs the backfill against an empty database.

---

## Step 0 — announce

Tell the team, in whatever channel they actually read:

> Pushing the workspaces migration to Supabase at HH:MM. Kermanych will stop listing
> projects and stop loading the board until you `git pull` and rebuild. Sessions that are
> already running are unaffected and their statuses still reach the board. Pull as soon as
> you see the follow-up message.

Do not start step 1 before this is sent.

## Step 1 — the pre-push visibility gate

Requirement 9 is that nobody gains access they did not already have. The backfill is 1:1 —
each project becomes its own workspace carrying its own former member list — so visibility
is preserved **except in one state**, found by the review of the migration:

> A project whose `owner_id` has **no** `project_members` row. Today its owner sees the
> project (the old `projects_select_member` carried an `owner_id = auth.uid()` disjunct)
> but **not** its tasks, and cannot repair that, because `invite_project_member` requires
> the caller to already be a member. After the migration `handle_new_workspace()` seats
> that owner in the new workspace, `is_project_member()` turns true, and the tasks become
> visible to them.

It is bounded to a project's own owner and it arguably repairs a broken state. But this
migration runs once against real data, so measure instead of assuming. In the hosted
project's SQL editor, **before pushing**:

```sql
select count(*) from projects p
 where not exists (
   select 1 from project_members m
    where m.project_id = p.id and m.user_id = p.owner_id);
```

- **`0`** — the case does not exist in the real data. Requirement 9 holds unconditionally.
  Continue to step 2.
- **anything else** — **stop.** Each such project's owner is about to gain visibility of
  its tasks. List them:

  ```sql
  select p.id, p.name, p.owner_id
    from projects p
   where not exists (
     select 1 from project_members m
      where m.project_id = p.id and m.user_id = p.owner_id);
  ```

  Decide per project whether that is repair or a leak, and write the decision down —
  in this file, under a dated heading — before continuing. Do not push on an unexamined
  non-zero result.

## Step 2 — confirm what is pending

```bash
cd kermanych
supabase link --project-ref uqqdudlfizfwqfegfrlh   # once per clone
supabase migration list --linked
```

Read the output before doing anything else. **`20260827100000` must be the only row with
a local version and no remote version.** If anything else is also pending you are about
to push more than this runbook covers; stop and reconcile.

## Step 3 — dry run

```bash
supabase db push --linked --dry-run
```

It prints the migration it *would* apply. Confirm it names `20260827100000_workspaces.sql`
and nothing else.

## Step 4 — push

```bash
supabase db push --linked
```

`db push` applies only the versions missing from the remote history table, so re-running
it is a no-op — but this one is not idempotent in the sense that matters: after it has
run, `projects.owner_id` is gone and cannot be recreated by running it again.

## Step 5 — verify against the hosted project

From a checkout that **is** on this branch:

```bash
cd kermanych && pnpm install && pnpm dev:app
```

Sign in and confirm, in this order:

1. The sidebar renders workspace groups with their projects nested inside.
2. Every project that existed before the push is present, in a workspace of the same name
   (that is the 1:1 backfill).
3. The board loads and its «Проєкти» / «Виконавці» filters are populated.
4. A workspace's settings list the same people who were members of the corresponding
   project before the push.

If 2 or 4 disagrees with what you remember of the old state, say so immediately — see
[Rollback](#rollback-honestly), because the answer is time-sensitive.

## Step 6 — tell the team to pull

> Done. `git pull && pnpm install` and restart Kermanych. Projects now live inside
> workspaces; your existing projects each became a workspace of the same name, with the
> same people in it. Merge them by dragging one project's row onto another workspace.

Nothing is required of them beyond pulling and rebuilding. Their local registry, worktrees
and sessions are untouched — the local SQLite schema does not change in this branch.

---

## Rollback, honestly

**There is no down migration, and writing one after the fact is only safe for a short
while.** Be clear-eyed about the three separate questions.

**Is information lost?** No, not by the migration itself. Everything the dropped objects
held is carried forward:

| dropped | carried into |
|---|---|
| `projects.owner_id` | `workspaces.owner_id` of the workspace that reused the project's id |
| `project_members.role` | `workspace_members.role` |
| `project_members.added_at` | `workspace_members.added_at` (deliberately, so join dates survive) |
| `project_members.user_id` | `workspace_members.user_id` |

Because each workspace **reuses its project's id**, the mapping back is unambiguous.

**Can the old shape be restored?** Only while the mapping is still 1:1 — that is, until
the first person creates a second project in a workspace, moves a project between
workspaces, or creates a new workspace. From that moment a `workspaces` row no longer
corresponds to exactly one project and there is no `projects.owner_id` value to write
back. **Practically: you have until the team starts using the feature, which is minutes
after step 6.** Treat the push as one-way.

**What does a backup buy?** Take one immediately before step 4:

```bash
supabase db dump --linked -f /tmp/kermanych-pre-workspaces.sql          # schema
supabase db dump --linked --data-only -f /tmp/kermanych-pre-workspaces-data.sql
```

A restore from that dump returns the database to its pre-push state exactly — and
**discards every write made after the dump**: new tasks, status changes pushed by running
sessions, new sign-ins. It is a real escape hatch for "the migration did something wrong",
useful for roughly as long as the team is idle, and it is not an escape hatch for "we
changed our minds next week". Keep the dump anyway; it costs nothing and it is the only
copy of the pre-migration shape that will ever exist.

The Supabase dashboard's own backups (Database → Backups) are the same trade with a
coarser granularity.

---

## Appendix: the local rehearsal

`scripts/verify-workspace-migration.ts` stages the pre-migration world on a **local** stack,
records who can see what, applies the migration on top of the seeded data, and re-asks the
same questions. Any difference is a migration bug and it exits non-zero.

The script refuses any `SUPABASE_TEST_URL` that is not loopback — it seeds data, and a
misfire at the hosted project would mint permanent rows there.

```bash
cd kermanych
supabase start
export SUPABASE_TEST_URL=http://127.0.0.1:54421
export SUPABASE_TEST_ANON_KEY=<local ANON_KEY from `supabase status`>
export SUPABASE_TEST_SERVICE_KEY=<local SERVICE_ROLE_KEY>

mkdir -p /tmp/mig
mv supabase/migrations/20260827100000_workspaces.sql /tmp/mig/   # the pre-cutover world
supabase db reset
env -u NODE_PATH NODE_PATH=apps/api/node_modules \
  ./apps/api/node_modules/.bin/tsx scripts/verify-workspace-migration.ts seed

mv /tmp/mig/20260827100000_workspaces.sql supabase/migrations/
supabase migration up            # NOT db reset — that would wipe the seed
env -u NODE_PATH NODE_PATH=apps/api/node_modules \
  ./apps/api/node_modules/.bin/tsx scripts/verify-workspace-migration.ts check
```

`check` prints one line per question and ends with `visibility preserved`. Exit codes:
`0` preserved, `1` visibility changed (**do not push**), `2` staging error — the usual one
being that the migration has not been applied yet.

`env -u NODE_PATH` in front of every invocation is deliberate. A `NODE_PATH` leaked from
another checkout is the kind of thing that resolves `@supabase/supabase-js` somewhere
surprising; clearing it first makes the command work under either resolver instead of
relying on pnpm's private hoist. Keep the `NODE_PATH=apps/api/node_modules` that follows:
`tsx` and `@supabase/supabase-js` both live in `apps/api`, not at the root.

Finish with `supabase db reset` so the local stack is back on the post-cutover schema.
