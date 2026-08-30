# Every task on the workspace board — design

Date: 2026-08-30
Status: approved (design; cloud `tasks` becomes the only task store)

## Problem

A task created in «Агенти» is invisible to the team, and not because RLS hides it:
there is no row to hide. Kermanych has **two** task stores and only one of them is
shared.

`POST /api/sessions` with `asTask: true` writes a local SQLite session
(`apps/api/src/supervisor/supervisor.service.ts:284-291`) with
`status: "backlog", kind: "task"` and **no `taskId`**. Nothing on that path touches
Supabase: the supervisor's only cloud calls (`getTask`, `claimTask`, `listProjects`,
`patchTask`) live exclusively inside `createSessionFromTask`
(`supervisor.service.ts:307-399`), and the status mirror bails out on its first line
for a session with no cloud task — `if (!s.taskId) return;`
(`apps/api/src/cloud/cloud-sync.service.ts:66`). The same holds for the ad-hoc launch
path (`supervisor.service.ts:293-301`), for ChatPage «В беклог»
(`apps/ui/src/pages/ChatPage.vue:221`) and for promoting a chat into an agent
(`supervisor.service.ts:512-560`): real agent work, running with a worktree, that the
board never learns about.

Cloud tasks, by contrast, are **already** workspace-wide. All four `tasks` policies ask
one question — `public.is_project_member(project_id, auth.uid())`
(`supabase/migrations/20260821090200_team_cloud_rls.sql:87-106`) — and since
`20260827100000_workspaces.sql:236-248` that helper resolves through
`workspace_members`, so every task in any project of a workspace is readable by every
member of it (proved live: `packages/cloud/test/rls.spec.ts:206`).

Two further holes, both on the write side of assignment:

1. **A taken card can be stolen, silently.** `tasks_update_member` lets any member write
   `assignee_id`, and `tasks_guard()` refuses a reassignment only while `old.status` is
   active (`20260827100000_workspaces.sql:296-299`). A card in `backlog` — or in any of
   the five terminal states — can be moved from one member to another by anyone. The
   suite even demonstrates it as a precondition of another test
   (`rls.spec.ts:317-322`, `expect(assigned.error).toBeNull()`). The
   «claim only if unclaimed» rule exists solely as the client-side predicate
   `.is('assignee_id', null)` in `claimTask` (`packages/cloud/src/tasks.ts:131-147`,
   asserted at `packages/cloud/test/tasks.spec.ts:171-181`) — race-safe, but not an
   authorization boundary.
2. **An assignee need not be a member.** `assignee_id` is only
   `references profiles(id) on delete set null`
   (`20260821090000_team_cloud_schema.sql:52`); any profile in the database can be put
   on any card.

And the UI never checks the assignee before offering «Запустити»: the button's guard is
`:disabled="launching !== null || isActiveTask(editingTask)"`
(`apps/ui/src/pages/BoardPage.vue:166`). The refusal that does exist —
`supervisor.service.ts:313` — arrives as a toast after the POST fails.

## Approach

**The cloud `tasks` row is the only task store.** Local `sessions` are executions, and
the direction stays the one the team-cloud design already states: task → session,
always. `POST /sessions/from-task` becomes the single birth path of an agent session.

Four decisions, each taken over its alternatives:

- **Creation is a cloud write, and offline it fails honestly.** The alternative — a
  local row plus a cloud twin minted later through a second outbox — buys offline
  creation and pays with two sources of truth for one task (there is no title/description
  mirror today), a mandatory create-before-status ordering, and a reachable existing bug:
  `pushTaskStatus` has no `.select()` (`packages/cloud/src/tasks.ts:151-159`), so a push
  aimed at a task that does not exist yet looks like success and retires the outbox row.
  Rejected. Chats and already-running sessions keep working with no network.
- **Assignment is guarded in the database.** `null → X` stays open to any member (that is
  the claim). `X → anything` is `X`'s own call, or the workspace owner's — the same
  narrow escape hatch rule 1 already grants for a stuck card. Plus: an assignee must be a
  member of the task's workspace.
- **A local-only project refuses, with publication offered inline.** A task needs a
  `project_id` the INSERT policy can check membership against, so an unpublished project
  (`BoardPage.vue:557-561`) cannot host one. Auto-publishing was rejected because a
  publish is permanent (`BoardPage.vue:628`); a local exception was rejected because it
  restores the second store.
- **Existing local backlog rows are published once, automatically**, reusing the local
  session id as the task id so the pass is idempotent without a marker.

The workspace binding needs no new column: `projects.workspace_id` is `not null`, so
every task is already bound to exactly one workspace through its project.
`tasks.workspace_id` stays a non-goal (`specs/2026-08-27-workspaces-design.md:682`), and
membership of an assignee is checked through `is_project_member(project_id, …)`.

### What is a task, and what is not

A task — a card on the board, with an assignee — is minted by:

- «Нова задача» in «Агенти», **both** buttons («В беклог» and «Запустити»);
- ChatPage «В беклог» (`ChatPage.vue:221`);
- promoting a chat into an agent (`KPanel.vue:13-19` → `store.promoteChat`), because
  that grows a branch and a worktree and is exactly the work that must stop being
  invisible.

Not a task, deliberately:

- `kind: "chat"` — a git-free conversation with a read-only tool subset
  (`supervisor.service.ts:470-505`). It has no worktree, it is throwaway, and it must
  keep working offline.
- `kind: "discussion"` / `kind: "review"` — forks of an **existing** session. They pour
  their conclusion back into the parent (`AgentsPage.vue:228-237`), are bucketed by the
  parent rather than by their own status (`apps/ui/src/lib/buckets.ts:14-19`), and
  cascade with it on delete. A fork is part of somebody's card, not a card.

## Requirements

1. Every agent session on any machine has a cloud `tasks` row. `sessions.task_id` is
   `not null` for `kind: "agent"` in practice, so the status mirror
   (`cloud-sync.service.ts:66`) can never silently drop a session again.
2. A task created from «Агенти» or from the chat is born with `assignee_id` = its
   creator, so it appears on the workspace board already assigned.
3. A task created on the board is born unassigned unless the creator picks an assignee;
   the create dialog offers «Виконавець» with «не призначено» as the default.
4. Taking an unassigned card self-assigns it atomically (unchanged: `claimTask`).
5. Taking a card assigned to somebody else is refused — by the database, not only by the
   API — and the UI disables the control instead of reporting a failure afterwards.
6. Changing `assignee_id` away from a non-null value is permitted only to the current
   assignee and to the workspace owner. `null → X` remains open to any member.
7. `assignee_id` must reference a member of the task's workspace, on INSERT and on every
   change.
8. The launcher keeps its «Ізолювати у worktree» option, and a shared card can never run
   in-place in somebody else's checkout.
9. «Задачі» in «Агенти» lists the cloud tasks in `backlog` assigned to me, within the
   current sidebar scope; the sidebar count agrees with it.
10. Local backlog rows that exist today are published to the board once, assigned to the
    machine's user, and the local rows are removed.
11. Creating a task with no cloud (offline, signed out) or on an unpublished project
    fails with an actionable message; publication is offered inline in the second case.

## Data model — Supabase

One migration, `supabase/migrations/20260830090000_tasks_assignment.sql`. Additive plus
one `create or replace`; no drops, so it is safe to push whenever
(`README.md` → «Applying a migration to the team's project»).

```sql
-- The launcher's «Ізолювати у worktree». `true` is both the column default and the
-- behaviour every card had before this migration, so existing rows need no backfill.
alter table public.tasks add column worktree boolean not null default true;
```

`baseBranch` needs no column: `tasks.branch` already IS the base branch — the board
labels it «Базова гілка» (`BoardPage.vue:137`) and `createSessionFromTask` feeds it in as
one (`supervisor.service.ts:368`, `task.branch ?? project.defaultBranch`).

### `tasks_guard()` — two new rules

Rules 1, 2 and 3 (assignee-only status with the workspace-owner force-stop hatch; no
reassign or delete while active; server-owned `updated_at`) are reproduced verbatim from
`20260827100000_workspaces.sql:263-315`. The function stays **not** `security definer`
for the reason stated there: it must observe the real `auth.uid()`.

```sql
create or replace function public.tasks_guard()
returns trigger
language plpgsql
as $$
declare
  active_statuses task_status[] := array['queued','thinking','tool','waiting_input']::task_status[];
begin
  -- 0. NEW (Requirement 7). An assignee must belong to the task's workspace. Checked on
  --    INSERT and on every change of assignee_id, never on an unrelated UPDATE: a member
  --    who later leaves the workspace must not freeze the cards they still hold — status
  --    pushes for those keep flowing. is_project_member is `security definer`, so this
  --    sees membership even though the trigger itself runs as the caller.
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not public.is_project_member(new.project_id, new.assignee_id) then
    raise exception 'assignee is not a workspace member';
  end if;

  if tg_op = 'UPDATE' then
    -- 1. (unchanged) Only the assignee moves a task's status; the workspace owner may
    --    force 'stopped' and nothing else. Elided here, copied verbatim from
    --    20260827100000_workspaces.sql:284-294.
    -- 2. (unchanged) An active task cannot be handed to someone else mid-run.
    if new.assignee_id is distinct from old.assignee_id
       and old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    -- 2b. NEW (Requirements 5, 6). A taken card is not up for grabs. `null -> X` stays
    --     open to any member — that IS the claim, and claimTask's `assignee_id is null`
    --     predicate keeps making it race-safe. `X -> anything` is X's own call (release,
    --     hand over) or the workspace owner's, which is the same escape hatch rule 1
    --     grants for an assignee who is gone for good. Ordered AFTER rule 2 on purpose:
    --     for an active card «task is active» is the more specific answer.
    if new.assignee_id is distinct from old.assignee_id
       and old.assignee_id is not null
       and auth.uid() is distinct from old.assignee_id
       and not exists (
         select 1 from public.projects p
         join public.workspaces w on w.id = p.workspace_id
         where p.id = old.project_id and w.owner_id = auth.uid()) then
      raise exception 'task assigned to someone else';
    end if;
    -- 3. (unchanged) updated_at is server-owned.
    new.updated_at := now();
    return new;
  end if;

  -- (unchanged) DELETE refuses an active row. Elided here, copied verbatim from
  -- 20260827100000_workspaces.sql:305-311.
  if tg_op = 'DELETE' then ... end if;
  return new;
end;
$$;
```

**Why a trigger and not a policy.** An UPDATE policy cannot express rules 2b or 0: `USING`
is evaluated against the old row and `WITH CHECK` against the new one, and no single
expression sees both. `tasks_update_member` therefore stays exactly as it is
(`20260821090200_team_cloud_rls.sql:99-102`) — membership in RLS, cross-row invariants in
the trigger, which is the split the file's own comment already describes.

**Compatibility with the paths that write `tasks` today**, checked one by one:

| writer | touches `assignee_id`? | verdict |
|---|---|---|
| `pushTaskStatus` (outbox) | no — `status` + `updated_at` | unaffected |
| `claimTask` | `null → caller` | rule 2b's open case |
| claim rollback, `patchTask(assigneeId: null)` (`supervisor.service.ts:392-395`) | `caller → null`, by the claimer | allowed (caller is `old.assignee_id`) |
| `forceStopTask` | no | unaffected |
| board editor `onAssign` (`BoardPage.vue:702-707`) | any → any | now bounded by 2b and 0 |

Existing rows are untouched: no backfill, and a card whose assignee has since left the
workspace keeps working because rule 0 fires only when `assignee_id` changes.

## `@kermanych/cloud`

- `src/types.ts`: `Task.worktree: boolean` (the column is `not null`, so the key is
  always present); `TaskInsert.worktree?: boolean`; `TaskPatch.worktree?: boolean`;
  **`TaskInsert.id?: string`**, for the one-time publication in
  «[Migrating existing local backlog rows](#migrating-existing-local-backlog-rows)» —
  the same trick `CloudProjectInsert.id?` already uses so a published project keeps its
  local identity (`src/projects.ts:95`).
- `src/tasks.ts`: `worktree` joins `TASK_COLUMNS`, `TaskRow`, `toTask` (unconditional
  assignment, not the null-guarded optional pattern) and `toTaskRow`
  (`if (patch.worktree !== undefined) row.worktree = patch.worktree` — a boolean, so no
  `trim()`/empty-to-null step); `createTask` forwards `id` when present.
- `status` stays absent from `createTask`'s row: a task is born `backlog` by column
  default, and the «Запустити» path reaches `queued` through the ordinary mirror.

## `apps/api` — the cutover

Removed. Every call site is enumerated below, and there are no others (verified by
grepping `store.createSession|startTask|updateTask|moveTask` and
`api.createSession|startTask|updateTask|moveTask` across `apps/ui/src`):

| removed | replaced by | call sites |
|---|---|---|
| `POST /sessions` + `supervisor.createSession` | `createTask` (UI) → `from-task` | `AgentsPage.vue:1272`, `ChatPage.vue:221` |
| `POST /sessions/:id/start` + `startTask` | `from-task` | `AgentsPage.vue:1270` |
| `PATCH /sessions/:id` + `updateTask` | `patchTask` (UI) | `AgentsPage.vue:1269` |
| `POST /sessions/:id/move` + `moveTask` | nothing | `AgentsPage.vue:1564`, reachable only from `openMove`, which has **zero** call sites — dead UI (`AgentsPage.vue:469-494`, `:1551-1566`) |
| `TaskDraft` (`packages/core/src/types.ts:43-45`) | — | the two methods above |
| `Session["kind"]` variant `"task"` | — | `AgentsPage.vue:52`, `:1307` |

`SessionStatus`'s `'backlog'` label stays: cloud cards carry it and
`TaskStatus = SessionStatus` (`packages/cloud/src/types.ts:8`). What disappears is any
local row that holds it.

Changed:

- **`POST /sessions/from-task` takes `{ taskId, images? }`.** Images are the first
  prompt's attachments; they stay local and never reach the cloud, exactly as they do on
  today's ad-hoc path (`launch(session, project, { images })`).
- **`from-task` honours `task.worktree`, but only for the card's author** (Requirement 8):

  ```ts
  // A shared card must never commandeer another developer's checkout — the invariant the
  // hardcoded `true` used to state (supervisor.service.ts:361). The in-place option is a
  // personal one, so it survives only for the person who filed the card.
  const worktree = task.worktree === false && task.createdBy === userId;
  ```

  and that value flows into `resolveLaunchParams(project, task.title, prefix, worktree,
  undefined, task.branch ?? project.defaultBranch)` and `registry.createSession`, the
  same way the removed `createSession` used it.
- **`POST /sessions/:id/promote` takes `{ taskId }`** and writes
  `registry.updateSession(id, { taskId })` **before** launching, so the mirror starts
  pushing for the promoted row. The chat's own row keeps its id and conversation
  (`supervisor.service.ts:507-511`); the only addition is the cloud identity.

## UI

**Board store lifecycle moves up.** `board.subscribe()` / `unsubscribe()` are owned by
`BoardPage` today (`BoardPage.vue:295`, `:303`), but «Агенти» and the sidebar count now
read cloud tasks, so the pair moves to `MainLayout.vue`. `subscribe()` is idempotent by
generation counter (`stores/board.ts:131-136`), already rebuilds on a project-set change
(`:290-296`) and already tears down on sign-out (`:299-308`), so hoisting adds no new
state; `BoardPage` keeps only `loadMembers`.

**Launcher (`AgentsPage.vue`).** «В беклог» →
`board.createTask({ projectId, title: name, description: task, model, prefix, platform, worktree, branch: baseBranch, assigneeId: me })`.
«Запустити» → the same call, then `api.createSessionFromTask(task.id, images)`. If the
launch fails (project not bound, spawn error) the card is already saved in `backlog`
assigned to me, so the retry is available from either surface — strictly better than
today's «the plan is lost unless the spawn worked». Note this also means `from-task`'s
claim rollback never fires on this path: `assignee_id` is already set, so `claimed` stays
`false` and a failed launch cannot unassign the card from its own author.

Gating is unchanged in shape: «В беклог» works on an unbound project (a card is just a
saved plan), «Запустити» still requires the local binding — `canLaunch`
(`AgentsPage.vue:1155-1157`) keeps its `isBound` term, and the API re-checks it
(`project not bound`). Edit mode (a click on a card in «Задачі»,
`AgentsPage.vue:1307`) patches the cloud task (`board.updateTaskFields`) and deletes
through `board.deleteTask`.

**Unpublished project.** When the launcher's project is not in `cloud.byId`, the modal
shows a workspace select and «Опублікувати і створити задачу» (`cloud.publish`,
`stores/projects.ts:287-308`, which reuses the local id so bindings and sessions
survive). With no workspace at all: «спершу створи воркспейс».

**«Задачі» bucket.** Source becomes `board.tasks`, predicate
`status === 'backlog' && assigneeId === me`, narrowed by the same `scopedProjectIds` the
rest of the page uses. That is my inbox — including what a colleague assigned to me —
while unclaimed team cards live on «Дошка». `bucketOf` loses its `backlog` branch
(`lib/buckets.ts:29`); `MainLayout.vue:549` counts my cloud backlog cards in scope
instead of local rows. Transitional group «лише на цій машині» for rows the
one-time publication could not move (see below).

**ChatPage.** «В беклог» → `board.createTask({ projectId, title: taskNameFromText(seed),
description: seed, model: chat.model, prefix: 'feature', assigneeId: me })`, the same
field mapping today's `createSession` call performs (`ChatPage.vue:221-223`). Promote →
mint a task the same way from the chat's opening ask (title
`taskNameFromText(chat.task)`, description `chat.task`), assignee me — the promoter is by
definition the person whose machine will run it — then `promote({ taskId })`.

**BoardPage.**

- «Виконавець» appears in the create dialog too, defaulting to «не призначено»
  (Requirement 3); today it renders only for an existing card (`:138-150`).
- «Запустити» is disabled when `assigneeId && assigneeId !== me`, with the reason in its
  title (Requirement 5) — the check the button lacks today (`:166`).
- The assignee select is disabled unless I am the current assignee, the card is
  unassigned, or I own the workspace — mirroring rule 2b instead of letting the user
  discover it through a refusal.
- `LAUNCH_ERRORS` (`:794-800`) and `lib/cloud-errors.ts` gain the two new database
  messages: `task assigned to someone else`, `assignee is not a workspace member`.

## Migrating existing local backlog rows

Runs in the UI, once, after `cloud.listRead && auth.user`. For every local session with
`status === 'backlog' && kind === 'task'` whose `projectId` is in `cloud.byId`:

```
createTask({ id: session.id, projectId, title: name, description: task,
             model, prefix, platform, worktree, branch: baseBranch, assigneeId: me })
→ deleteSession(session.id)
```

**Idempotent without a marker:** the card's id IS the local session id, which is already
a `randomUUID()` (`apps/api/src/registry/registry.service.ts:268`). A second pass gets
`duplicate key`, reads it as «already published» and proceeds to delete the local row.
The order — create, then delete — is deliberate: a duplicate card is a nuisance, a lost
task is not recoverable.

Rows in unpublished projects stay where they are and surface in the «Задачі» bucket under
«лише на цій машині — опублікуйте проєкт», with the publish control from the launcher.

## Rollout

The migration only adds, so `supabase db push --linked` needs no window. The client
cutover does: after it, a shipped UI without this change would call
`POST /sessions` and get a 404.

Known consequences, accepted:

- **Creating a task now needs the cloud.** README's offline section must stop saying
  «STARTING a board task is the one step that needs the cloud». Everything else offline is
  unchanged: running sessions, answering, merging, chats, and the status outbox.
- **Preview mode loses task creation.** `KERMANYCH_PREVIEW=1` signs in against a cloudless
  API (`lib/preview.ts`, `auth.guard.ts:44-47`) where `AuthService.current()` is undefined
  and every cloud call refuses with `not signed in`; `board.load()` returns early on
  `IS_PREVIEW` (`stores/board.ts:103`). The launcher is inert there.
- **Docs:** README «Cloud tasks and local sessions» steps 1-2, the «action / who» table
  (assignment rights change), the offline section, and the «Задачі» bucket description.

## Verification

**Unit — `packages/cloud/test/tasks.spec.ts`:** `worktree` in `TASK_COLUMNS`, mapped by
`toTask`, sent by `toTaskRow` as a boolean (including `false`, which must not be dropped
as «blank»); `createTask` forwards `id` and `assigneeId`; `status` still never sent.

**Integration — `packages/cloud/test/rls.spec.ts`** (local stack, alongside the existing
`:317`-`:404` cases): stealing a `backlog` card is refused with
`task assigned to someone else`; the assignee may release or hand over their own card;
the workspace owner may reassign a non-active card; assigning a non-member is refused on
INSERT and on UPDATE with `assignee is not a workspace member`; claiming an unassigned
card still succeeds; the active-task and force-stop cases are unchanged.

**API — `apps/api/test`:** `supervisor.tasks.spec.ts` goes away with the behaviour it
covers; `sessions.from-task.spec.ts` gains the worktree rule (honoured for the author,
forced otherwise) and `images`; `cloud-sync.spec.ts` and `create-guards.spec.ts` assert
that every agent session is born with a `taskId`.

**UI — `apps/ui/test`:** `buckets.spec.ts` and `agents-view.spec.ts` follow the bucket's
new source; a new case covers «backlog assigned to me, in scope».

**Manual smoke, two accounts in one workspace — this is the proof of the whole change.**
A creates a task in «Агенти»; B's board shows it with A as the assignee. B's «Запустити»
is disabled with a reason. An unassigned card claims itself on B's «Запустити». B tries to
take A's card in the editor and is refused with the database's own message. A creates a
task offline and gets an actionable error. A selects a local-only project and is offered
publication. One task runs to `done` end to end, proving the mirror still works for a
session born through the new path.

## Non-goals

- No `workspace_id` on `tasks` — the project already determines the workspace, and
  `projects.workspace_id` is `not null`.
- No touching the dead `tasks.kind` column: this change does not obsolete it (it is
  plumbed through the mappers and written by nobody), and removing it is a separate
  cleanup.
- No retroactive cards for sessions that already exist without a `taskId` — that would
  flood the board's «закриті» column with past runs.
- No cards for chats, discussions or reviews.
- No offline task creation, no second outbox.
- No manual ordering, no dragging cards between columns (unchanged).
- No change to `omp` execution, worktree mechanics, the status enum, or the outbox
  protocol.
