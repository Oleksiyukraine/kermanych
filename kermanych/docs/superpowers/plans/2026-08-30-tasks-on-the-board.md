# Every task on the workspace board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cloud `tasks` row the only task store, so every task created anywhere in a workspace appears on that workspace's board with an assignee, and make «who may take this card» a database rule instead of a client convention.

**Architecture:** Supabase `tasks` is the single source of truth for a task; the local SQLite `sessions` table only ever holds executions. `POST /sessions/from-task` becomes the one birth path of an agent session. Assignment rules move into `tasks_guard()`: `null → X` is open (that is the claim), `X → anything` belongs to `X` or to the workspace owner, and an assignee must be a member of the task's workspace. The UI mints cards (it is the only cloud writer for `tasks`), and «Агенти» renders my backlog cards instead of local backlog rows.

**Tech Stack:** Supabase/Postgres (RLS + plpgsql triggers), TypeScript, NestJS (`apps/api`), Quasar/Vue 3 + Pinia (`apps/ui`), vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-08-30-tasks-on-the-board-design.md`

## Global Constraints

- Node ≥22.12 (`better-sqlite3` v13 N-API prebuilt). pnpm workspaces; `pnpm@10.33.2`.
- UI copy is Ukrainian inline; identifiers, comments, commit messages are English.
- No i18n layer, no new dependencies.
- `packages/cloud` owns the snake_case ↔ camelCase boundary: nothing outside it sees a Postgres column name.
- Migration file naming: `supabase/migrations/YYYYMMDDHHMMSS_snake_case_topic.sql`. Functions are versioned by `create or replace` under the same name and signature.
- RLS is the only authorization surface; every cloud call runs under the user's own JWT. No service-role key ever reaches shipped code.
- `apps/ui` has **no component test harness**: `apps/ui/test/*.spec.ts` are pure unit tests over `src/lib/**` with injected fakes. Logic that needs a test goes into `src/lib/`; `.vue` files are verified by typecheck plus the manual smoke.
- `@kermanych/cloud` and `@kermanych/core` are consumed as built `dist`. After changing either, run `pnpm --filter @kermanych/cloud build` (and `--filter @kermanych/core build`) before typechecking `apps/api` / `apps/ui`.
- Commit after every task. Never merge into the base branch (the operator does that).

---

### Task 1: Assignment rules in the database

**Files:**
- Create: `kermanych/supabase/migrations/20260830090000_tasks_assignment.sql`
- Test: `kermanych/packages/cloud/test/rls.spec.ts` (append cases after the existing `"a finished task can be deleted"` case, ~line 404)

**Interfaces:**
- Consumes: nothing.
- Produces: column `tasks.worktree boolean not null default true`; two new `tasks_guard()` refusals — `assignee is not a workspace member`, `task assigned to someone else`.

**Prerequisite — a local Supabase stack.** The RLS suite is skipped without it:

```bash
cd kermanych
supabase start                 # needs Docker; prints the local keys
supabase db reset              # applies supabase/migrations/*.sql to a clean DB
export SUPABASE_TEST_URL=http://127.0.0.1:54421
export SUPABASE_TEST_ANON_KEY=<anon or publishable key from `supabase status`>
export SUPABASE_TEST_SERVICE_KEY=<service_role key from `supabase status`>
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/cloud/test/rls.spec.ts`, inside the top-level `describe`. Each case inserts its **own** task — the shared `taskId` fixture is mutated by earlier cases and must not be reused:

```ts
  // ── Assignment (20260830090000_tasks_assignment.sql) ────────────────────────
  // Insert a fresh card per case: the fixture `taskId` carries state from the cases above.
  async function freshTask(assigneeId: string | null): Promise<string> {
    const inserted = await owner.client
      .from("tasks")
      .insert({
        project_id: projectId,
        title: "assignment case",
        created_by: owner.id,
        ...(assigneeId ? { assignee_id: assigneeId } : {}),
      })
      .select("id")
      .single();
    if (inserted.error) throw inserted.error;
    return inserted.data.id as string;
  }

  it("refuses to take a backlog card that is already assigned to someone else", async () => {
    const id = await freshTask(owner.id);

    const stolen = await member.client.from("tasks").update({ assignee_id: member.id }).eq("id", id);

    expect(stolen.error?.message).toMatch(/task assigned to someone else/);
    const after = await owner.client.from("tasks").select("assignee_id").eq("id", id).single();
    expect(after.data!.assignee_id).toBe(owner.id);
  });

  it("still lets any member claim an unassigned card", async () => {
    const id = await freshTask(null);

    const claimed = await member.client
      .from("tasks")
      .update({ assignee_id: member.id })
      .eq("id", id)
      .is("assignee_id", null)
      .select("assignee_id")
      .maybeSingle();

    expect(claimed.error).toBeNull();
    expect(claimed.data!.assignee_id).toBe(member.id);
  });

  it("lets the assignee release or hand over their own card", async () => {
    const id = await freshTask(member.id);

    const released = await member.client.from("tasks").update({ assignee_id: null }).eq("id", id);
    expect(released.error).toBeNull();

    const handedOver = await member.client.from("tasks").update({ assignee_id: owner.id }).eq("id", id);
    expect(handedOver.error).toBeNull();
  });

  // The escape hatch: rule 1 already lets the workspace owner force 'stopped' when an
  // assignee is gone for good; reassigning a settled card is the same situation.
  it("lets the workspace owner reassign a non-active card", async () => {
    const id = await freshTask(member.id);

    const moved = await owner.client
      .from("tasks")
      .update({ assignee_id: owner.id })
      .eq("id", id)
      .select("assignee_id")
      .single();

    expect(moved.error).toBeNull();
    expect(moved.data!.assignee_id).toBe(owner.id);
  });

  it("refuses an assignee who is not a member of the task's workspace", async () => {
    const onInsert = await owner.client
      .from("tasks")
      .insert({
        project_id: projectId,
        title: "outsider assignee",
        created_by: owner.id,
        assignee_id: outsider.id,
      })
      .select("id")
      .maybeSingle();
    expect(onInsert.error?.message).toMatch(/assignee is not a workspace member/);

    const id = await freshTask(null);
    const onUpdate = await owner.client.from("tasks").update({ assignee_id: outsider.id }).eq("id", id);
    expect(onUpdate.error?.message).toMatch(/assignee is not a workspace member/);
  });

  // Requirement 8's storage half: the column the launcher's «Ізолювати у worktree» maps to.
  it("defaults worktree to true and accepts false", async () => {
    const id = await freshTask(null);
    const def = await owner.client.from("tasks").select("worktree").eq("id", id).single();
    expect(def.data!.worktree).toBe(true);

    const inPlace = await owner.client
      .from("tasks")
      .update({ worktree: false })
      .eq("id", id)
      .select("worktree")
      .single();
    expect(inPlace.error).toBeNull();
    expect(inPlace.data!.worktree).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd kermanych && pnpm --filter @kermanych/cloud test -- rls`
Expected: the six new cases FAIL — the steal succeeds (`stolen.error` is `null`), the outsider assignment succeeds, and `worktree` reads back as `undefined` (`column tasks.worktree does not exist` on the select).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260830090000_tasks_assignment.sql`. Rules 1, 2 and 3 are copied **verbatim** from `20260827100000_workspaces.sql:263-315`; only rule 0 and rule 2b are new:

```sql
-- Assignment becomes a database rule.
--
-- Until now `tasks_update_member` let any workspace member write `assignee_id`, and
-- tasks_guard() refused a reassignment only while old.status was active
-- (20260827100000_workspaces.sql:296-299). So a card in 'backlog' — or in any of the five
-- terminal states — could be taken away from its assignee by anyone, silently; the
-- «claim only if unclaimed» rule lived solely in claimTask's client-side
-- `assignee_id is null` predicate, which is race-safe but not an authorization boundary.
--
-- Neither new rule is expressible as a policy: an UPDATE policy evaluates USING against
-- the old row and WITH CHECK against the new one, and no single expression sees both. So
-- `tasks_update_member` stays exactly as it is (membership in RLS) and the cross-row
-- invariants go where the other three already live (the trigger).

-- The launcher's «Ізолювати у worktree». `true` is both the default and the behaviour every
-- card had before this migration (createSessionFromTask hardcoded a worktree), so existing
-- rows need no backfill. NOT offered on the board's create dialog: a team card always
-- isolates, and the API honours `false` only for the card's own author.
alter table public.tasks add column worktree boolean not null default true;

-- Same name, same signature, so the four tasks_* policies stay TEXTUALLY UNCHANGED.
-- Still deliberately NOT `security definer`: it must see auth.uid() of the actual caller,
-- which is what rules 1 and 2b compare against. Restated rather than assumed, because a
-- `create or replace` that merely FORGOT `security definer` would look identical to this
-- one. The consequence is that the two owner sub-selects read public.projects under the
-- CALLER's own RLS, which resolves only because the owner is always a member of their own
-- workspace — the invariant workspace_members_delete_owner enforces.
create or replace function public.tasks_guard()
returns trigger
language plpgsql
as $$
declare
  active_statuses task_status[] := array['queued','thinking','tool','waiting_input']::task_status[];
begin
  -- 0. NEW. An assignee must belong to the task's workspace. `assignee_id` is only
  --    `references profiles(id)`, so before this any profile in the database could be put
  --    on any card. Checked on INSERT and on every CHANGE of assignee_id, never on an
  --    unrelated UPDATE: a member who later leaves the workspace must not freeze the cards
  --    they still hold — their status pushes have to keep landing. is_project_member is
  --    `security definer`, so this sees membership even though the trigger runs as the
  --    caller and the caller cannot read workspace_members rows for other people.
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not public.is_project_member(new.project_id, new.assignee_id) then
    raise exception 'assignee is not a workspace member';
  end if;

  if tg_op = 'UPDATE' then
    -- 1. Only the assignee moves a task's status. The self-assign case is allowed because
    --    claim + status can land in one statement, in which case the new assignee is the
    --    caller. One exception: the WORKSPACE's owner may force 'stopped'.
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
    -- 2. An active task cannot be handed to someone else mid-run.
    if new.assignee_id is distinct from old.assignee_id
       and old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    -- 2b. NEW. A taken card is not up for grabs. `null -> X` stays open to any member —
    --     that IS the claim, and claimTask's `assignee_id is null` predicate keeps making
    --     it race-safe. `X -> anything` is X's own call (release, hand over) or the
    --     workspace owner's, which is the same escape hatch rule 1 grants for an assignee
    --     who is gone for good. Ordered AFTER rule 2 on purpose: while a card is active,
    --     «task is active» is the more specific answer to the same attempt.
    if new.assignee_id is distinct from old.assignee_id
       and old.assignee_id is not null
       and auth.uid() is distinct from old.assignee_id
       and not exists (
         select 1 from public.projects p
         join public.workspaces w on w.id = p.workspace_id
         where p.id = old.project_id and w.owner_id = auth.uid()) then
      raise exception 'task assigned to someone else';
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
```

- [ ] **Step 4: Apply it and run the whole suite**

Run: `cd kermanych && supabase db reset && pnpm --filter @kermanych/cloud test`
Expected: PASS, including the pre-existing cases at `rls.spec.ts:317-404` (`only the assignee can change status`, `task is active` on reassign and delete, the owner force-stop hatch). If `an active task cannot be reassigned` now reports `task assigned to someone else`, rule 2b was placed **before** rule 2 — move it after.

- [ ] **Step 5: Commit**

```bash
git add kermanych/supabase/migrations/20260830090000_tasks_assignment.sql kermanych/packages/cloud/test/rls.spec.ts
git commit -m "feat(db): assignment rules and tasks.worktree in tasks_guard"
```

---

### Task 2: `worktree` and explicit `id` on the cloud task surface

**Files:**
- Modify: `kermanych/packages/cloud/src/types.ts:50-91`
- Modify: `kermanych/packages/cloud/src/tasks.ts:8-115`
- Modify: `kermanych/packages/cloud/test/tasks.spec.ts:46-146`
- Modify: `kermanych/apps/api/test/sessions.from-task.spec.ts:88-102` (fixture gains `worktree`)
- Modify: `kermanych/apps/ui/test/scope.spec.ts:26-33` (fixture gains `worktree`)

**Interfaces:**
- Consumes: `tasks.worktree` from Task 1.
- Produces: `Task.worktree: boolean` (required — the column is `not null`); `TaskInsert.worktree?: boolean`; `TaskInsert.id?: string`; `TaskPatch.worktree?: boolean`.

- [ ] **Step 1: Write the failing tests**

In `packages/cloud/test/tasks.spec.ts`, add `worktree: true` to the shared `taskRow` fixture (line 46-61) and to the expected object in the `listTasks` case (line 69-81, add `worktree: true`), then append these cases:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd kermanych && pnpm --filter @kermanych/cloud test -- tasks`
Expected: FAIL — `worktree` is not on `Task` (TS error) and is never sent.

- [ ] **Step 3: Implement the surface**

`packages/cloud/src/types.ts` — in `Task`, after `platform?: string;`:

```ts
  // `tasks.worktree` is `not null default true`, so unlike every other launch param this
  // key is always present. `false` means the launcher's «Ізолювати у worktree» was cleared:
  // run in the project folder itself. createSessionFromTask honours that only for the
  // card's author (a shared card must never commandeer another developer's checkout).
  worktree: boolean;
```

in `TaskInsert`:

```ts
  // Supplied ONLY by the one-time publication of pre-cutover local backlog rows, which
  // reuses the local session id so a repeated pass collides instead of duplicating. Same
  // trick as CloudProjectInsert.id (projects.ts:95).
  id?: string;
  worktree?: boolean;
```

in `TaskPatch`: `worktree?: boolean;`

`packages/cloud/src/tasks.ts`:

```ts
const TASK_COLUMNS =
  "id, project_id, title, description, status, assignee_id, created_by, model, prefix, platform, kind, branch, worktree, created_at, updated_at";
```

add `worktree: boolean;` to `TaskRow`; in `toTask`, alongside the unconditional keys (NOT in the null-guarded block, because `false` is a real value):

```ts
    worktree: row.worktree,
```

in `toTaskRow`, after the `platform` line:

```ts
  // A boolean, so no trim/blank-to-null step: `false` is a value, not an empty field.
  if (patch.worktree !== undefined) row.worktree = patch.worktree;
```

in `createTask`, extend the row literal:

```ts
  const row: Record<string, unknown> = {
    ...(input.id ? { id: input.id } : {}),
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
      worktree: input.worktree,
    }),
  };
```

- [ ] **Step 4: Fix the two `Task` fixtures the required key breaks**

`apps/api/test/sessions.from-task.spec.ts:89-99` — add `worktree: true,` to the literal.
`apps/ui/test/scope.spec.ts:26-33` — add `worktree: true,` to the returned literal.

- [ ] **Step 5: Run everything that consumes the type**

```bash
cd kermanych
pnpm --filter @kermanych/cloud test
pnpm --filter @kermanych/cloud build
pnpm --filter @kermanych/api test
pnpm --filter @kermanych/ui test
pnpm --filter @kermanych/ui typecheck
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add kermanych/packages/cloud kermanych/apps/api/test/sessions.from-task.spec.ts kermanych/apps/ui/test/scope.spec.ts
git commit -m "feat(cloud): task worktree column and explicit insert id"
```

---

### Task 3: `from-task` carries images and honours the card's worktree flag

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts:307-399`
- Modify: `kermanych/apps/api/src/http/sessions.controller.ts:44-54`
- Modify: `kermanych/apps/ui/src/lib/api.ts:178-181`
- Test: `kermanych/apps/api/test/sessions.from-task.spec.ts`

**Interfaces:**
- Consumes: `Task.worktree`, `Task.createdBy` (Task 2).
- Produces: `createSessionFromTask(taskId: string, userId: string, images?: ImageInput[]): Promise<Session>`; `api.createSessionFromTask(taskId: string, images?: ImageInput[]): Promise<Session>`; `POST /sessions/from-task` body `{ taskId: string; images?: ImageInput[] }`.

- [ ] **Step 1: Write the failing tests**

First make the fake record prompts. `FakeRpc` (`sessions.from-task.spec.ts:9-29`) currently
discards `prompt()` arguments, and `launch()` delivers attachments through
`rpc.prompt(firstPrompt, images)` (`supervisor.service.ts:646-647`), so there is nothing to
assert on yet. Add one array and one line:

```ts
const started: unknown[] = [];
// launch() delivers the opening message as rpc.prompt(text, images); the attachments are
// only observable here.
const prompts: unknown[][] = [];
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
    prompt(...args: unknown[]) {
      prompts.push(args);
    }
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});
```

and reset it in `beforeEach` (`:123-128`) next to `started.length = 0;`:

```ts
  prompts.length = 0;
```

Then append inside `describe("createSessionFromTask", …)`:

```ts
  it("runs in place when the card's own author asks for it", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER, worktree: false });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.worktree).toBe(false);
    expect(worktree.addWorktree).not.toHaveBeenCalled();
  });

  // The invariant the old hardcoded `true` stated: a shared card must never commandeer
  // another developer's checkout.
  it("forces a worktree when the runner did not file the card", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: OTHER, worktree: false });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.worktree).toBe(true);
    expect(worktree.addWorktree).toHaveBeenCalled();
  });

  it("forwards the launcher's images into the first prompt", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER });

    await sup.createSessionFromTask("task-1", USER, [{ data: "aGk=", mimeType: "image/png" }]);

    expect(prompts.at(-1)).toEqual([
      "wire GitHub OAuth",
      [{ data: "aGk=", mimeType: "image/png" }],
    ]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd kermanych && pnpm --filter @kermanych/api test -- from-task`
Expected: FAIL — `worktree` is ignored (always `true`) and `createSessionFromTask` takes two arguments.

- [ ] **Step 3: Implement**

`supervisor.service.ts` — signature and the two changed lines:

```ts
  async createSessionFromTask(taskId: string, userId: string, images?: ImageInput[]): Promise<Session> {
```

replace the hardcoded worktree (currently `supervisor.service.ts:361-377`):

```ts
    // A shared card must never commandeer another developer's checkout, which is what the
    // hardcoded `true` here used to guarantee. The in-place option is personal, so it
    // survives exactly for the person who filed the card — for anybody else the card is
    // isolated, whatever it says.
    const worktree = task.worktree === false && task.createdBy === userId;

    const { branch, baseBranch } = await this.resolveLaunchParams(
      project,
      task.title,
      prefix,
      worktree,
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
      worktree,
      baseBranch,
      model: task.model,
      prefix,
      platform,
    });
    try {
      return await this.launch(session, project, { images });
```

`sessions.controller.ts` — the `from-task` route:

```ts
  // The task id is the ONLY identity input: who may run it comes from the guard's cached
  // token, never from the request body. `images` are the first prompt's attachments; they
  // stay on this machine and never reach the cloud.
  @Post("from-task")
  async createFromTask(@Body() b: { taskId: string; images?: ImageInput[] }, @Req() req: { user: { id: string } }) {
    try {
      return await this.sup.createSessionFromTask(b.taskId, req.user.id, b.images);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
```

`apps/ui/src/lib/api.ts`:

```ts
  createSessionFromTask: (taskId: string, images?: ImageInput[]): Promise<Session> =>
    post<Session>('/sessions/from-task', { taskId, images }),
```

- [ ] **Step 4: Run**

```bash
cd kermanych
pnpm --filter @kermanych/api test
pnpm --filter @kermanych/api typecheck
pnpm --filter @kermanych/ui typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api kermanych/apps/ui/src/lib/api.ts
git commit -m "feat(api): from-task honours the card's worktree flag and images"
```

---

### Task 4: a promoted chat gets a board card

**Files:**
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts:512-560`
- Modify: `kermanych/apps/api/src/http/sessions.controller.ts:69-77`
- Modify: `kermanych/apps/ui/src/lib/api.ts:193-194`
- Modify: `kermanych/apps/ui/src/stores/orchestrator.ts` (`promoteChat`)
- Test: `kermanych/apps/api/test/supervisor.chat.spec.ts:105-184`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `promoteChatToAgent(chatId: string, taskId: string): Promise<Session>`; `POST /sessions/:id/promote` body `{ taskId: string }`; `api.promoteChat(id: string, taskId: string)`.

- [ ] **Step 1: Write the failing test**

Append inside `describe("promoteChatToAgent", …)`:

```ts
  // Without this the promoted row has no cloud identity, and CloudSyncService drops every
  // status it emits on its first line (`if (!s.taskId) return`).
  it("stamps the cloud task id on the row before launching", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");

    const agent = await sup.promoteChatToAgent(chat.id, "card-1");

    expect(agent.taskId).toBe("card-1");
    expect(registry.listSessions(g.id).find((s) => s.id === chat.id)!.taskId).toBe("card-1");
  });
```

Update the existing `promoteChatToAgent(chat.id)` calls in that file (lines 111, 126, 137, 148, 166, 182) to pass a task id, e.g. `"card-1"`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/api test -- supervisor.chat`
Expected: FAIL — `promoteChatToAgent` takes one argument.

- [ ] **Step 3: Implement**

`supervisor.service.ts`:

```ts
  async promoteChatToAgent(chatId: string, taskId: string): Promise<Session> {
```

and immediately before the branch/worktree work (after the `chatFile` and turn-in-progress guards, i.e. after the current line 528):

```ts
    // The cloud identity arrives with the promotion: the UI mints the card (it is the only
    // writer of `tasks`) and hands the id over here, so the row starts mirroring status the
    // moment it stops being a chat. Written BEFORE the launch so a failure leaves a row
    // that is still a chat but already linked — harmless — rather than a running agent the
    // board cannot see.
    this.registry.updateSession(chatId, { taskId });
```

`sessions.controller.ts`:

```ts
  // A chat carries everything else the promotion needs (its conversation, its opening ask);
  // the task id is the card the UI has just minted for it.
  @Post(":id/promote")
  async promote(@Param("id") id: string, @Body() b: { taskId: string }) {
    try {
      return await this.sup.promoteChatToAgent(id, b.taskId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
```

`apps/ui/src/lib/api.ts`:

```ts
  promoteChat: (id: string, taskId: string): Promise<Session> =>
    post<Session>(`/sessions/${id}/promote`, { taskId }),
```

`apps/ui/src/stores/orchestrator.ts` — widen `promoteChat` the same way (`function promoteChat(id: string, taskId: string)`), forwarding both arguments. The single UI call site (`ChatPage.vue:193`) is fixed in Task 8; leave it failing typecheck only if Task 8 lands in the same session — otherwise pass a temporary card in Task 8 and keep this task's typecheck green by updating that call site to `store.promoteChat(id, taskId)` there.

- [ ] **Step 4: Run**

```bash
cd kermanych
pnpm --filter @kermanych/api test
pnpm --filter @kermanych/api typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/api kermanych/apps/ui/src/lib/api.ts kermanych/apps/ui/src/stores/orchestrator.ts
git commit -m "feat(api): promote a chat onto a cloud task"
```

---

### Task 5: pure UI logic for the new task surfaces

**Files:**
- Create: `kermanych/apps/ui/src/lib/tasks-view.ts`
- Create: `kermanych/apps/ui/src/lib/publish-backlog.ts`
- Test: `kermanych/apps/ui/test/tasks-view.spec.ts`
- Test: `kermanych/apps/ui/test/publish-backlog.spec.ts`

**Interfaces:**
- Consumes: `Task`, `TaskInsert` (`@kermanych/cloud`), `Session`, `BranchPrefix`, `Platform` (`@kermanych/core`).
- Produces:
  - `type LauncherDraft = { name: string; task: string; model?: string; prefix: BranchPrefix; platform?: Platform; worktree: boolean; baseBranch?: string }`
  - `taskInsertFromDraft(draft: LauncherDraft, projectId: string, assigneeId: string): TaskInsert & { assigneeId: string }`
  - `taskPatchFromDraft(draft: LauncherDraft): TaskPatch`
  - `myBacklogTasks(tasks: Task[], userId: string, scopedProjectIds: string[]): Task[]`
  - `canRunTask(task: Task, userId: string): boolean`
  - `canAssignTask(task: Task, userId: string, isWorkspaceOwner: boolean): boolean`
  - `type BacklogPublication = { sessionId: string; insert: TaskInsert & { id: string; assigneeId: string } }`
  - `type BacklogPlan = { publish: BacklogPublication[]; stranded: Session[] }`
  - `planBacklogPublication(sessions: Session[], cloudProjectIds: Set<string>, assigneeId: string): BacklogPlan`

- [ ] **Step 1: Write the failing tests for `tasks-view`**

Create `apps/ui/test/tasks-view.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Task } from '@kermanych/cloud';
import {
  canAssignTask,
  canRunTask,
  myBacklogTasks,
  taskInsertFromDraft,
  taskPatchFromDraft,
  type LauncherDraft,
} from '../src/lib/tasks-view';

const ME = 'u-me';
const OTHER = 'u-other';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    projectId: 'p1',
    title: over.id,
    status: 'backlog',
    worktree: true,
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    ...over,
  } as Task;
}

const draft: LauncherDraft = {
  name: '  Add login  ',
  task: '  wire GitHub OAuth  ',
  model: 'opus-5',
  prefix: 'feature',
  platform: 'backend',
  worktree: true,
  baseBranch: 'develop',
};

describe('taskInsertFromDraft', () => {
  // The launcher's vocabulary and the board's columns differ in two places, and both used
  // to be resolved by hand at the call site: `name`/`task` are `title`/`description`, and
  // the base branch is `tasks.branch` (the board labels that field «Базова гілка»).
  it('maps the launcher draft onto a card assigned to its author', () => {
    expect(taskInsertFromDraft(draft, 'p1', ME)).toEqual({
      projectId: 'p1',
      title: 'Add login',
      description: 'wire GitHub OAuth',
      model: 'opus-5',
      prefix: 'feature',
      platform: 'backend',
      worktree: true,
      branch: 'develop',
      assigneeId: ME,
    });
  });

  // An in-place run has no fork base to record, and a blank one must not become the string
  // "undefined" or an empty column value the API would later read as a branch name.
  it('drops the base branch for an in-place card', () => {
    const insert = taskInsertFromDraft({ ...draft, worktree: false }, 'p1', ME);
    expect(insert.worktree).toBe(false);
    expect('branch' in insert).toBe(false);
  });

  it('omits absent optional params instead of sending undefined keys', () => {
    const insert = taskInsertFromDraft(
      { name: 'T', task: 'body', prefix: 'fix', worktree: true },
      'p1',
      ME,
    );
    expect(Object.keys(insert).sort()).toEqual(
      ['assigneeId', 'description', 'prefix', 'projectId', 'title', 'worktree'].sort(),
    );
  });
});

describe('taskPatchFromDraft', () => {
  it('sends every editable field, so clearing one clears the column', () => {
    expect(taskPatchFromDraft({ ...draft, platform: undefined })).toEqual({
      title: 'Add login',
      description: 'wire GitHub OAuth',
      model: 'opus-5',
      prefix: 'feature',
      platform: '',
      worktree: true,
      branch: 'develop',
    });
  });
});

describe('myBacklogTasks', () => {
  it('keeps my backlog cards in scope, newest last', () => {
    const mine = task({ id: 'a', assigneeId: ME });
    const theirs = task({ id: 'b', assigneeId: OTHER });
    const unclaimed = task({ id: 'c' });
    const running = task({ id: 'd', assigneeId: ME, status: 'thinking' });
    const elsewhere = task({ id: 'e', assigneeId: ME, projectId: 'p9' });

    const rows = myBacklogTasks([mine, theirs, unclaimed, running, elsewhere], ME, ['p1']);

    expect(rows.map((t) => t.id)).toEqual(['a']);
  });

  it('is empty for a signed-out reader rather than showing everyone', () => {
    expect(myBacklogTasks([task({ id: 'a', assigneeId: ME })], '', ['p1'])).toEqual([]);
  });
});

describe('canRunTask', () => {
  // Mirrors supervisor.service.ts («task assigned to someone else») so the button is grey
  // BEFORE the POST instead of explaining itself in a toast afterwards.
  it('allows an unclaimed card and my own, refuses somebody else’s', () => {
    expect(canRunTask(task({ id: 'a' }), ME)).toBe(true);
    expect(canRunTask(task({ id: 'b', assigneeId: ME }), ME)).toBe(true);
    expect(canRunTask(task({ id: 'c', assigneeId: OTHER }), ME)).toBe(false);
  });
});

describe('canAssignTask', () => {
  // Mirrors tasks_guard rule 2b: `null -> X` open, `X -> anything` only X or the owner.
  it('follows the database rule, including the owner hatch', () => {
    expect(canAssignTask(task({ id: 'a' }), ME, false)).toBe(true);
    expect(canAssignTask(task({ id: 'b', assigneeId: ME }), ME, false)).toBe(true);
    expect(canAssignTask(task({ id: 'c', assigneeId: OTHER }), ME, false)).toBe(false);
    expect(canAssignTask(task({ id: 'd', assigneeId: OTHER }), ME, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/ui test -- tasks-view`
Expected: FAIL — `src/lib/tasks-view.ts` does not exist.

- [ ] **Step 3: Implement `tasks-view.ts`**

```ts
// apps/ui/src/lib/tasks-view.ts
// The board's task decisions that are worth a test, kept out of the .vue files: the
// launcher-draft ↔ cloud-card mapping, the «Задачі» inbox filter, and the two permission
// mirrors. The permission functions duplicate rules that the API and tasks_guard() enforce
// for real — their job is to grey a control out before the refusal, never to be the
// refusal.
import type { Task, TaskInsert, TaskPatch } from '@kermanych/cloud';
import type { BranchPrefix, Platform } from '@kermanych/core';

export type LauncherDraft = {
  name: string;
  task: string;
  model?: string;
  prefix: BranchPrefix;
  platform?: Platform;
  worktree: boolean;
  baseBranch?: string;
};

// Two renamings live here and nowhere else: name/task are the card's title/description,
// and the fork base is `tasks.branch` (the board labels that field «Базова гілка», and
// createSessionFromTask feeds it in as the base).
export function taskInsertFromDraft(
  draft: LauncherDraft,
  projectId: string,
  assigneeId: string,
): TaskInsert & { assigneeId: string } {
  const base = draft.worktree ? draft.baseBranch?.trim() : undefined;
  return {
    projectId,
    title: draft.name.trim(),
    description: draft.task.trim(),
    ...(draft.model ? { model: draft.model } : {}),
    prefix: draft.prefix,
    ...(draft.platform ? { platform: draft.platform } : {}),
    worktree: draft.worktree,
    ...(base ? { branch: base } : {}),
    assigneeId,
  };
}

// Unlike the insert, a patch sends every editable field: an absent key means «leave the
// column alone», so clearing the platform in the editor has to travel as an empty string,
// which toTaskRow turns into NULL.
export function taskPatchFromDraft(draft: LauncherDraft): TaskPatch {
  return {
    title: draft.name.trim(),
    description: draft.task.trim(),
    model: draft.model ?? '',
    prefix: draft.prefix,
    platform: draft.platform ?? '',
    worktree: draft.worktree,
    branch: (draft.worktree ? draft.baseBranch?.trim() : '') ?? '',
  };
}

// «Задачі» in Агенти is my inbox — the cards I have to work, including ones a colleague
// assigned to me. Unclaimed team cards live on Дошка, so they are deliberately absent.
export function myBacklogTasks(tasks: Task[], userId: string, scopedProjectIds: string[]): Task[] {
  if (!userId) return [];
  const inScope = new Set(scopedProjectIds);
  return tasks.filter(
    (t) => t.status === 'backlog' && t.assigneeId === userId && inScope.has(t.projectId),
  );
}

// supervisor.createSessionFromTask refuses `task assigned to someone else`; this is the
// same question asked before the click.
export function canRunTask(task: Task, userId: string): boolean {
  return !task.assigneeId || task.assigneeId === userId;
}

// tasks_guard rule 2b: `null -> X` is open to any member, `X -> anything` belongs to X or
// to the workspace owner. Whether the card is ACTIVE is a separate question the callers
// already ask (an active card cannot be reassigned at all).
export function canAssignTask(task: Task, userId: string, isWorkspaceOwner: boolean): boolean {
  return !task.assigneeId || task.assigneeId === userId || isWorkspaceOwner;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd kermanych && pnpm --filter @kermanych/ui test -- tasks-view`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for `publish-backlog`**

Create `apps/ui/test/publish-backlog.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Session } from '@kermanych/core';
import { planBacklogPublication } from '../src/lib/publish-backlog';

const ME = 'u-me';

function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: 'p1',
    name: over.id,
    task: 'do it',
    worktreePath: '',
    branch: '',
    worktree: true,
    kind: 'task',
    status: 'backlog',
    createdAt: '2026-08-30T10:00:00.000Z',
    lastActivityAt: '2026-08-30T10:00:00.000Z',
    ...over,
  } as Session;
}

describe('planBacklogPublication', () => {
  it('publishes a local backlog row under its own id so a repeat pass collides', () => {
    const row = session({ id: 's-1', name: 'Add login', task: 'wire OAuth', baseBranch: 'develop', model: 'opus-5', prefix: 'fix' });

    const plan = planBacklogPublication([row], new Set(['p1']), ME);

    expect(plan.stranded).toEqual([]);
    expect(plan.publish).toEqual([
      {
        sessionId: 's-1',
        insert: {
          id: 's-1',
          projectId: 'p1',
          title: 'Add login',
          description: 'wire OAuth',
          model: 'opus-5',
          prefix: 'fix',
          worktree: true,
          branch: 'develop',
          assigneeId: ME,
        },
      },
    ]);
  });

  // A project that lives only on this machine cannot host a card: tasks_insert_member
  // checks membership through project_id. Those rows stay put and are shown as such.
  it('strands rows whose project is not in the cloud', () => {
    const local = session({ id: 's-2', projectId: 'p-local' });
    const plan = planBacklogPublication([local], new Set(['p1']), ME);
    expect(plan.publish).toEqual([]);
    expect(plan.stranded.map((s) => s.id)).toEqual(['s-2']);
  });

  it('ignores everything that is not a local backlog task', () => {
    const rows = [
      session({ id: 'a', status: 'thinking', kind: 'agent' }),
      session({ id: 'b', kind: 'chat', status: 'done' }),
      session({ id: 'c', status: 'backlog', kind: 'task', archived: true }),
    ];
    const plan = planBacklogPublication(rows, new Set(['p1']), ME);
    expect(plan.publish).toEqual([]);
    expect(plan.stranded).toEqual([]);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd kermanych && pnpm --filter @kermanych/ui test -- publish-backlog`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `publish-backlog.ts`**

```ts
// apps/ui/src/lib/publish-backlog.ts
// The one-time move of pre-cutover local backlog rows onto the board. Before this change a
// «В беклог» task was a local SQLite session and nothing else, so every machine holds a few
// that the team has never seen. This decides what to publish and what cannot be published;
// the caller performs the writes.
import type { Session } from '@kermanych/core';
import type { TaskInsert } from '@kermanych/cloud';

export type BacklogPublication = {
  sessionId: string;
  insert: TaskInsert & { id: string; assigneeId: string };
};

export type BacklogPlan = { publish: BacklogPublication[]; stranded: Session[] };

// `id` is the LOCAL session id, which is already a randomUUID (registry.createSession), so
// re-running the pass hits the tasks primary key instead of minting a duplicate card — the
// caller reads `duplicate key` as «already published» and deletes the local row.
export function planBacklogPublication(
  sessions: Session[],
  cloudProjectIds: Set<string>,
  assigneeId: string,
): BacklogPlan {
  const plan: BacklogPlan = { publish: [], stranded: [] };
  for (const s of sessions) {
    if (s.archived || s.kind !== 'task' || s.status !== 'backlog') continue;
    if (!cloudProjectIds.has(s.projectId)) {
      plan.stranded.push(s);
      continue;
    }
    plan.publish.push({
      sessionId: s.id,
      insert: {
        id: s.id,
        projectId: s.projectId,
        title: s.name,
        description: s.task,
        ...(s.model ? { model: s.model } : {}),
        ...(s.prefix ? { prefix: s.prefix } : {}),
        worktree: s.worktree,
        ...(s.worktree && s.baseBranch ? { branch: s.baseBranch } : {}),
        assigneeId,
      },
    });
  }
  return plan;
}
```

- [ ] **Step 8: Run both suites and typecheck**

```bash
cd kermanych
pnpm --filter @kermanych/ui test
pnpm --filter @kermanych/ui typecheck
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add kermanych/apps/ui/src/lib/tasks-view.ts kermanych/apps/ui/src/lib/publish-backlog.ts kermanych/apps/ui/test/tasks-view.spec.ts kermanych/apps/ui/test/publish-backlog.spec.ts
git commit -m "feat(ui): pure logic for cloud-backed tasks and the backlog publication"
```

---

### Task 6: the board subscription becomes app-wide

**Files:**
- Modify: `kermanych/apps/ui/src/layouts/MainLayout.vue`
- Modify: `kermanych/apps/ui/src/pages/BoardPage.vue:290-303`

**Interfaces:**
- Consumes: `useBoard()` (`stores/board.ts`).
- Produces: `board.tasks` populated on every page, not only on `/#/board`.

Why: «Агенти» and the sidebar count read cloud tasks from Task 7 on, so the subscription cannot belong to the board page. `subscribe()` is idempotent by generation counter (`stores/board.ts:131-136`), already rebuilds when the project set changes (`:290-296`) and already tears down on sign-out (`:299-308`), so moving it adds no state.

- [ ] **Step 1: Move the lifecycle**

In `MainLayout.vue`, add `const board = useBoard();` next to the existing stores and, in its `onMounted` (create one if absent, next to the existing setup calls):

```ts
// The board store is app-wide now: Агенти renders my backlog cards from it and the sidebar
// counts them, so it must be live on every route, not only on /#/board. subscribe() is
// idempotent — BoardPage no longer owns this.
onMounted(() => void board.subscribe());
onUnmounted(() => board.unsubscribe());
```

In `BoardPage.vue`, delete `await board.subscribe();` from `open()` (line 295) and the whole `onUnmounted(() => board.unsubscribe());` (line 303). Keep `onMounted(open)` and `loadMembers()`.

- [ ] **Step 2: Typecheck**

Run: `cd kermanych && pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke it**

Run `pnpm dev:app`, sign in. Open «Дошка» — cards still load, the «немає звʼязку» banner behaves as before. Switch to «Агенти» and back twice: no duplicate channels (the console shows no repeated subscribe errors), cards still update.

- [ ] **Step 4: Commit**

```bash
git add kermanych/apps/ui/src/layouts/MainLayout.vue kermanych/apps/ui/src/pages/BoardPage.vue
git commit -m "refactor(ui): own the board subscription in MainLayout"
```

---

### Task 7: the launcher and «Задачі» switch to cloud cards

**Files:**
- Modify: `kermanych/apps/ui/src/pages/AgentsPage.vue` (template 38-59 and the launcher modal 283-439; script 664-736, 1103-1309)
- Modify: `kermanych/apps/ui/src/layouts/MainLayout.vue:540-560`

**Interfaces:**
- Consumes: `taskInsertFromDraft`, `taskPatchFromDraft`, `myBacklogTasks` (Task 5); `api.createSessionFromTask(taskId, images)` (Task 3); `board.createTask`, `board.updateTaskFields`, `board.deleteTask` (`stores/board.ts`).
- Produces: «Нова задача» writes cloud cards; «Задачі» lists them; `taskCards` / `taskGroups` on the page.

**Do NOT touch `lib/buckets.ts`.** `bucketOf` is exported and unit-tested but has **zero
consumers** in `src` (`MainLayout` inlines the same rule) — changing it would be churn on
dead code. Its `backlog → tasks` answer also stays correct: after this cutover a local
`backlog` row is a stranded pre-cutover leftover, and «Задачі» is exactly where the page
shows it (Task 10).

- [ ] **Step 1: Wire the stores and the card the launcher edits**

In `AgentsPage.vue`, add to the script imports:

```ts
import type { Task } from '@kermanych/cloud';
import { useBoard } from '../stores/board';
import { useAuth } from '../stores/auth';
import { myBacklogTasks, taskInsertFromDraft, taskPatchFromDraft } from '../lib/tasks-view';
```

and next to the existing stores (`projects` — the `useProjects()` instance the scope block
already reads — plus `store`):

```ts
const board = useBoard();
const auth = useAuth();
```

`editingTaskId` now holds a **cloud task id**. Replace the existing `editingTask` computed
(the one that resolves a Session from the registry) with:

```ts
// The card `editingTaskId` points at, resolved from the store rather than snapshotted, so a
// realtime edit to the card being edited is not lost behind the modal.
const editingTask = computed<Task | undefined>(() =>
  editingTaskId.value ? board.tasks.find((t) => t.id === editingTaskId.value) : undefined,
);
```

- [ ] **Step 2: Open the launcher on a card**

Replace `openLauncher(task?: Session)` (`:1197-1215`):

```ts
function openLauncher(card?: Task): void {
  // Before loadLaunchBranches(), which reads it. A card being edited stays in its own
  // project; a new one lands in the selected project.
  launchProjectId.value = card?.projectId ?? store.selectedProjectId;
  editingTaskId.value = card?.id ?? null;
  draftName.value = card?.title ?? '';
  draftTask.value = card?.description ?? '';
  draftModel.value = card?.model ?? 'opus-5';
  // The cloud stores launch params as free text; the local vocabularies are the authority,
  // exactly as createSessionFromTask validates them server-side.
  draftPrefix.value = (BRANCH_PREFIXES as readonly string[]).includes(card?.prefix ?? '')
    ? (card!.prefix as BranchPrefix)
    : 'feature';
  draftPlatform.value = (PLATFORMS as readonly string[]).includes(card?.platform ?? '')
    ? (card!.platform as Platform)
    : undefined;
  draftWorktree.value = card?.worktree ?? true;
  // `tasks.branch` IS the base branch (the board labels it «Базова гілка»).
  void loadLaunchBranches(card?.branch);
  nameEdited.value = !!card;
  launcherError.value = null;
  clearLaunchImages();
  launcherOpen.value = true;
  void nextTick(() => taskInput.value?.focus());
}
```

`BRANCH_PREFIXES` and `PLATFORMS` are already imported by the page for its selects; if not,
add them from `@kermanych/core`.

- [ ] **Step 3: Rewrite the submit path**

Replace `submitLauncher` (`:1243-1289`) wholesale. Note `board.updateTaskFields` returns a
`boolean` (`stores/board.ts:203-224`) — the id we need is already in `editingTaskId`, so the
store needs no change:

```ts
// Both buttons write a CLOUD card; «Запустити» then launches it on this machine. Creating
// the card FIRST is what makes the task visible to the team with an assignee, and it also
// means a failed launch loses nothing: the card is saved, assigned to me, and can be retried
// from here or from the board. (It also means from-task's claim rollback never fires on this
// path — the card is already mine, so `claimed` stays false there.)
async function submitLauncher(asTask: boolean): Promise<void> {
  const projectId = launchProjectId.value;
  const userId = auth.user?.id;
  if (!projectId || !canLaunch.value) return;
  if (!userId) {
    launcherError.value = 'Спочатку увійдіть у Kermanych';
    return;
  }
  // A card may be filed for an unbound project — it is a saved plan. Launching may not, and
  // the api would refuse it with `project not bound` anyway.
  if (!asTask && !isBound.value) {
    launcherError.value = BIND_HINT;
    return;
  }
  // A card needs a project the cloud can check membership against; the publish hatch below
  // is the way out of a local-only project.
  if (projects.listRead && !projects.byId.has(projectId)) {
    launcherError.value = PUBLISH_FIRST_HINT;
    return;
  }
  const draft = {
    name: draftName.value.trim(),
    task: draftTask.value.trim(),
    model: draftModel.value.trim() || undefined,
    prefix: draftPrefix.value,
    platform: draftPlatform.value,
    worktree: draftWorktree.value,
    baseBranch: draftBaseBranch.value || undefined,
  };
  const images = launchImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType }));
  launcherError.value = null;
  try {
    let cardId: string;
    if (editingTaskId.value) {
      if (!(await board.updateTaskFields(editingTaskId.value, taskPatchFromDraft(draft)))) return;
      cardId = editingTaskId.value;
    } else {
      const created = await board.createTask(taskInsertFromDraft(draft, projectId, userId));
      if (!created) return; // the store has already said why
      cardId = created.id;
    }
    launcherOpen.value = false;
    clearLaunchImages();
    if (asTask) {
      store.setBucket('tasks');
      return;
    }
    const session = await api.createSessionFromTask(cardId, images);
    store.setBucket('active');
    store.selectSession(session.id);
  } catch (e) {
    // Keep the launcher open so the name and body are not lost. The card, if it was created,
    // is already safe on the board.
    launcherError.value = e instanceof Error ? e.message : String(e);
  }
}
```

Add the hint next to `BIND_HINT`:

```ts
const PUBLISH_FIRST_HINT =
  'Цей проєкт живе лише на цій машині — опублікуйте його у воркспейсі, і тоді задача стане видимою команді.';
```

- [ ] **Step 4: Publish-and-create for a local-only project**

In the launcher modal, above the controls, add the hatch (the workspace select mirrors
`BoardPage.vue:630-632`):

```html
<div v-if="needsPublish" class="agents-launcher__publish">
  <p class="agents__hint mono">{{ PUBLISH_FIRST_HINT }}</p>
  <KSelect
    v-model="publishInto"
    label="Воркспейс"
    :options="workspaceOptions"
    placeholder="виберіть воркспейс"
  />
  <KBtn :disabled="!publishInto || publishing" @click="publishAndFile">
    Опублікувати і створити задачу
  </KBtn>
  <p v-if="!workspaceOptions.length" class="agents__hint mono">
    Спершу створіть воркспейс у лівій панелі.
  </p>
</div>
```

```ts
// `listRead` guards the same false positive BoardPage's `unpublished` guards (:557-561):
// until the cloud project list is an ANSWER, every project looks local-only.
const needsPublish = computed(
  () => !!launchProjectId.value && projects.listRead && !projects.byId.has(launchProjectId.value),
);
const publishInto = ref('');
const publishing = ref(false);
const workspaceOptions = computed(() => projects.workspaces.map((w) => ({ value: w.id, label: w.name })));

// A publish is permanent, so it is asked for explicitly rather than guessed from the
// current scope. It reuses the LOCAL project id, so bindings, sessions and worktrees
// survive (stores/projects.ts:275-308).
async function publishAndFile(): Promise<void> {
  const row = store.projects.find((p) => p.id === launchProjectId.value);
  if (!row || !publishInto.value || publishing.value) return;
  publishing.value = true;
  launcherError.value = null;
  try {
    await projects.publish(row, publishInto.value);
    await submitLauncher(true);
  } catch (e) {
    launcherError.value = e instanceof Error ? e.message : String(e);
  } finally {
    publishing.value = false;
  }
}
```

- [ ] **Step 5: Render «Задачі» from the cloud**

`projectSessions` (`:666-680`) keeps its `tasks` branch as it is — under this bucket it now
yields only stranded pre-cutover rows, which Task 10 labels. Add the card list beside it,
mirroring `boardGroups` (`:721-736`) so the two lists group and sort the same way:

```ts
// My backlog inbox: the cards I have to work, in the same scope the session list uses, so
// one sidebar click narrows both. Unclaimed team cards live on Дошка by design.
const taskCards = computed(() => myBacklogTasks(board.tasks, auth.user?.id ?? '', scopedIds.value));

type TaskGroup = { projectId: string; name: string; rows: Task[] };
// Cards are all `backlog`, so there is no STATUS_RANK to order groups by: project name is
// the only stable order available, and it matches what the rail shows.
const taskGroups = computed<TaskGroup[]>(() => {
  const groups = new Map<string, TaskGroup>();
  for (const t of taskCards.value) {
    let group = groups.get(t.projectId);
    if (!group) {
      group = { projectId: t.projectId, name: projectName(t.projectId), rows: [] };
      groups.set(t.projectId, group);
    }
    group.rows.push(t);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
});

const showTasks = computed(() => store.selectedBucket === 'tasks');
```

In the template, put the card list above the session list and widen the empty check:

```html
<div v-if="showTasks && taskCards.length" class="agents__cards">
  <template v-for="g in taskGroups" :key="g.projectId">
    <div v-if="groupByProject" class="agents__group-label mono">{{ g.name }}</div>
    <KSessionCard
      v-for="t in g.rows"
      :key="t.id"
      :branch="t.branch ?? ''"
      :title="t.title"
      :time="relativeTime(t.updatedAt, now)"
      :status="t.status"
      :status-line="t.description ?? ''"
      :model="t.model"
      :selected="false"
      removable
      :remove-title="`Видалити задачу «${t.title}»`"
      @click="openLauncher(t)"
      @remove="onDeleteCard(t)"
    />
  </template>
</div>
<div v-if="boardRows.length" class="agents__cards">
  <!-- unchanged session list -->
</div>
<div v-else-if="!showTasks || !taskCards.length" class="agents__empty mono">{{ emptyText }}</div>
```

Replace `onDeleteTask` (`:1294-1303`) with the card version and keep a session version for
the stranded rows Task 10 renders:

```ts
// Deleting a card is a cloud row and nothing else — it owns no branch, no worktree and no
// omp child — so one confirm is the whole guard; tasks_guard refuses an active card anyway.
async function onDeleteCard(card: Task): Promise<void> {
  if (!window.confirm(`Видалити задачу «${card.title}»?`)) return;
  if (!(await board.deleteTask(card.id))) return;
  if (editingTaskId.value === card.id) launcherOpen.value = false;
}

// A stranded pre-cutover row: local SQLite and nothing else, so this stays a plain delete.
async function onDeleteStranded(s: Session): Promise<void> {
  if (!window.confirm(`Видалити локальну задачу «${s.name}»?`)) return;
  try {
    await store.deleteSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}
```

In the session-card block, point `@remove` at `onDeleteStranded` and fix `onRowClick`
(`:1305-1309`): a session is never an editable task now.

```ts
function onRowClick(s: Session): void {
  // A stranded backlog row has no chat to open and no cloud card to edit — the note above
  // the list says what to do with it (publish its project).
  if (s.kind === 'task') return;
  store.selectSession(s.id);
}
```

- [ ] **Step 6: Make the sidebar count agree with the list**

`MainLayout.vue:540-560` counts `c.tasks++` for local `backlog` sessions. Keep that (it is
the stranded-row count now) and add the cards, so the badge equals what «Задачі» renders:

```ts
// «Задачі» shows two things now: my cloud backlog cards, and any stranded pre-cutover local
// row. The badge counts both, because a count that disagrees with the list it counts is
// worse than no count (lib/buckets.ts:2-4).
for (const t of myBacklogTasks(board.tasks, auth.user?.id ?? '', [...inScope])) {
  const c = counts.get(t.projectId);
  if (c) c.tasks++;
}
```

Use whatever the surrounding block calls its scope set and its per-project accumulator;
`counts` above is a placeholder for the existing map, not a new one.

- [ ] **Step 7: Run tests and typecheck**

```bash
cd kermanych
pnpm --filter @kermanych/ui test
pnpm --filter @kermanych/ui typecheck
```
Expected: PASS. `agents-view.spec.ts` covers pure helpers from this page — if a case asserts
on the old launcher/bucket behaviour, update the expectation to the new rule rather than
deleting the case.

- [ ] **Step 8: Smoke it**

`pnpm dev:app`, signed in, a published project selected:
1. «Нова задача» → «В беклог»: the card appears under «Задачі» AND on «Дошка» with me as the assignee.
2. Click the card: the launcher opens prefilled; change the body → «Зберегти»; the board card's description updates.
3. «Запустити» from the launcher: an agent starts under «Активні» and the board card leaves `backlog`.
4. Select a local-only project: «Нова задача» shows the publish hatch, and «Опублікувати і створити задачу» files the card.
5. ✕ on a card: it disappears from both surfaces.
6. The «Задачі» badge in the rail equals the number of cards listed.

- [ ] **Step 9: Commit**

```bash
git add kermanych/apps/ui
git commit -m "feat(ui): Агенти creates and lists cloud task cards"
```

### Task 8: chat → backlog and chat → agent write cards

**Files:**
- Modify: `kermanych/apps/ui/src/pages/ChatPage.vue:147-231`

**Interfaces:**
- Consumes: `board.createTask`, `taskInsertFromDraft` (Task 5), `api.promoteChat(id, taskId)` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Implement `toBacklog`**

```ts
// «В беклог» files a CLOUD card assigned to me, so a thought parked in a chat is visible to
// the team exactly like anything else on the board.
async function toBacklog(): Promise<void> {
  const pid = store.selectedProjectId;
  const userId = auth.user?.id;
  const seed = chatSession.value?.task?.trim();
  if (!pid || !userId || !seed) return;
  if (!cloud.byId.has(pid)) {
    store.notify('Проєкт ще не у хмарі — опублікуйте його, щоб створювати задачі.', 'error');
    return;
  }
  const card = await board.createTask(
    taskInsertFromDraft(
      { name: taskNameFromText(seed), task: seed, model: chatSession.value?.model, prefix: 'feature', worktree: true },
      pid,
      userId,
    ),
  );
  if (!card) return;
  store.setBucket('tasks');
  void router.push({ name: 'agents' });
}
```

Keep the existing error handling shape of the function it replaces (`ChatPage.vue:205-231`), including its `try/catch` notify.

- [ ] **Step 2: Implement `promote`**

```ts
// Promotion grows a worktree and starts building, so it is agent work and needs a card. The
// card is minted first and its id travels into the promotion, which stamps it on the row so
// status starts mirroring immediately.
async function promote(): Promise<void> {
  const id = chatId.value;
  const pid = store.selectedProjectId;
  const userId = auth.user?.id;
  const seed = chatSession.value?.task?.trim() ?? '';
  if (!id || !pid || !userId) return;
  if (!cloud.byId.has(pid)) {
    store.notify('Проєкт ще не у хмарі — опублікуйте його, щоб підняти агента.', 'error');
    return;
  }
  promoting.value = true;
  try {
    const card = await board.createTask(
      taskInsertFromDraft(
        { name: taskNameFromText(seed) || chatSession.value?.name || 'чат', task: seed, model: chatSession.value?.model, prefix: 'feature', worktree: true },
        pid,
        userId,
      ),
    );
    if (!card) return;
    await store.promoteChat(id, card.id);
    store.setBucket('active');
    store.selectSession(id);
    void router.push({ name: 'agents' });
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    promoting.value = false;
  }
}
```

Keep the existing `promoting` ref and button wiring; only the body changes.

- [ ] **Step 3: Typecheck and smoke**

```bash
cd kermanych && pnpm --filter @kermanych/ui typecheck
```
Then `pnpm dev:app`: in «Чат» send a message, press ⊕ («Зберегти як задачу в беклог») → the card is on the board assigned to me. Press the promote button on another chat → an agent starts and its card is on the board, leaving `backlog` as the session moves.

- [ ] **Step 4: Commit**

```bash
git add kermanych/apps/ui/src/pages/ChatPage.vue
git commit -m "feat(ui): chat backlog and promotion mint cloud cards"
```

---

### Task 9: the board respects the new assignment rules

**Files:**
- Modify: `kermanych/apps/ui/src/pages/BoardPage.vue` (template 106-171, script 884-975, 794-800)
- Modify: `kermanych/apps/ui/src/lib/cloud-errors.ts`

**Interfaces:**
- Consumes: `canRunTask`, `canAssignTask` (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Offer an assignee at creation**

Add `const draftAssignee = ref('');` next to the other drafts (`:884-897`), reset it in `openCreate()` and `openEditor()` (`= task.assigneeId ?? ''`), render the existing «Виконавець» select for BOTH modes by replacing `v-if="editingTask"` on the wrapper (`:138`) with a two-branch block: when editing, keep `@update:model-value="onAssign"`; when creating, bind `v-model="draftAssignee"` with the same `editorAssigneeOptions`. Then send it:

```ts
  const fields = {
    title: draftTitle.value.trim(),
    description: draftDescription.value,
    model: draftModel.value,
    prefix: draftPrefix.value,
    platform: draftPlatform.value,
    branch: draftBranch.value,
  };
  …
    if (!(await board.createTask({
      projectId,
      ...fields,
      // «не призначено» is still the default: the board is the shared backlog. An assignee
      // picked here is the «this one is yours» case, and tasks_guard refuses a non-member.
      ...(draftAssignee.value ? { assigneeId: draftAssignee.value } : {}),
    })))
```

- [ ] **Step 2: Grey out what the database will refuse**

```ts
// The API refuses `task assigned to someone else` and tasks_guard refuses the reassignment;
// showing that BEFORE the click is the difference between a rule and a surprise.
function canRun(task: Task): boolean {
  return !!auth.user && canRunTask(task, auth.user.id);
}
function canAssign(task: Task): boolean {
  return !!auth.user && canAssignTask(task, auth.user.id, cloud.isOwner(task.projectId));
}
```

«Запустити» (`:164-171`):

```html
<KBtn v-if="editingTask" variant="secondary"
  :disabled="launching !== null || isActiveTask(editingTask) || !canRun(editingTask)"
  :title="launchHint(editingTask)"
  @click="editorOpen = false; launch(editingTask)"
>Запустити</KBtn>
```

and extend `launchHint` (`:768-783`) with the new reason, before its existing branches:

```ts
  if (!canRun(task)) return 'Задача призначена іншому учаснику — запустити її може лише він';
```

The assignee select gains `|| !canAssign(editingTask)` in its `:disabled`.

- [ ] **Step 3: Name the new refusals**

`LAUNCH_ERRORS` (`:794-800`) and `lib/cloud-errors.ts` gain:

```ts
  'task assigned to someone else': 'Задача призначена іншому учаснику — запустити її може лише він.',
  'assignee is not a workspace member': 'Цей користувач не входить у воркспейс задачі.',
```

(the first key already exists in `LAUNCH_ERRORS`; add it to `cloud-errors.ts`, which maps store failures such as a refused `onAssign`).

- [ ] **Step 4: Typecheck and smoke**

```bash
cd kermanych && pnpm --filter @kermanych/ui typecheck
```
With two accounts in one workspace: A files a card for themselves; on B's board «Запустити» is disabled and its tooltip says why, and the assignee select is disabled. B claims an unassigned card by pressing «Запустити». A creates a card with B as the assignee from the create dialog.

- [ ] **Step 5: Commit**

```bash
git add kermanych/apps/ui/src/pages/BoardPage.vue kermanych/apps/ui/src/lib/cloud-errors.ts
git commit -m "feat(ui): board honours the assignment rules up front"
```

---

### Task 10: publish the local backlog rows that already exist

**Files:**
- Modify: `kermanych/apps/ui/src/pages/AgentsPage.vue`

Nothing else: the leftover list is already rendered by Task 7 (the session cards under the
«Задачі» bucket), so this task adds only the publication pass and the note above them.

**Interfaces:**
- Consumes: `planBacklogPublication` (Task 5), `cloudCreateTask` (`@kermanych/cloud`), `store.deleteSession`.
- Produces: nothing new — the stranded rows are the session rows Task 7 already renders under «Задачі»; this task only shrinks that list to the ones that genuinely cannot move.

- [ ] **Step 1: Run the pass once, when it can succeed**

In `AgentsPage.vue`:

```ts
import { createTask as cloudCreateTask } from '@kermanych/cloud';
import { planBacklogPublication } from '../lib/publish-backlog';

// One-time move of pre-cutover local backlog rows onto the board (spec §Migrating existing
// local backlog rows). Runs when the cloud project list is an ANSWER — before that every
// project looks local-only and nothing would move.
//
// cloudCreateTask is called DIRECTLY rather than through board.createTask, because that
// wrapper reports failures with a toast (stores/board.ts:197-199) and the duplicate-key
// collision below is an expected, silent outcome — not something to greet the user with.
let publishedPass = false;

async function publishLegacyBacklog(): Promise<void> {
  const userId = auth.user?.id;
  if (publishedPass || !userId || !projects.listRead || projects.offlineError) return;
  publishedPass = true;
  const plan = planBacklogPublication(
    store.sessions,
    new Set(projects.projects.map((p) => p.id)),
    userId,
  );
  for (const { sessionId, insert } of plan.publish) {
    try {
      await cloudCreateTask(auth.client, { ...insert, createdBy: userId });
    } catch (e) {
      // A primary-key collision means an earlier pass already published this row — the card
      // id IS the local session id — so the local row is safe to drop. Anything else is a
      // real failure: leave the row alone and let a later pass retry rather than deleting
      // work nobody else can see yet.
      const message = e instanceof Error ? e.message : String(e);
      if (!/duplicate key|already exists/i.test(message)) {
        publishedPass = false;
        continue;
      }
    }
    await store.deleteSession(sessionId);
  }
}

// `plan.stranded` needs no state: a row that cannot move stays a local backlog session, and
// Task 7 already renders exactly those under «Задачі». The note below explains them.
watch(
  () => [auth.user?.id, projects.listRead, projects.offlineError] as const,
  () => void publishLegacyBacklog(),
  { immediate: true },
);
```

- [ ] **Step 2: Explain the rows that stayed**

Above the session-card block, inside the «Задачі» bucket only:

```html
<p v-if="showTasks && boardRows.length" class="agents__note mono">
  Лише на цій машині: проєкт цих задач ще не у хмарі, тому команда їх не бачить.
  Опублікуйте проєкт — і вони переїдуть на дошку.
</p>
```

No new list: those rows are the session cards Task 7 left in place, and after the pass the
only ones remaining under this bucket are the stranded ones.

- [ ] **Step 3: Typecheck and smoke**

```bash
cd kermanych && pnpm --filter @kermanych/ui typecheck
```

Smoke, in this order:
1. Before starting, on a machine that has local backlog rows (or create some by checking out the previous commit, filing two «В беклог» tasks, then returning), note their names.
2. Start the app signed in. Those names now appear as cards on «Дошка» assigned to you, and «Задачі» shows them once — not twice.
3. Restart the app: still once (the second pass collides on the id and only deletes).
4. A local-only project's rows stay under «лише на цій машині».

- [ ] **Step 4: Commit**

```bash
git add kermanych/apps/ui
git commit -m "feat(ui): publish pre-cutover local backlog rows onto the board"
```

---

### Task 11: delete the local task store

**Files:**
- Modify: `kermanych/apps/api/src/http/sessions.controller.ts` (remove `@Post()`, `@Post(":id/start")`, `@Patch(":id")`, `@Post(":id/move")`)
- Modify: `kermanych/apps/api/src/supervisor/supervisor.service.ts` (remove `createSession`, `startTask`, `updateTask`, `moveTask`)
- Modify: `kermanych/packages/core/src/types.ts` (remove `TaskDraft` only — see Step 3 for why `"task"` stays in `Session["kind"]`)
- Modify: `kermanych/apps/ui/src/lib/api.ts` (remove `createSession`, `startTask`, `updateTask`, `moveTask`)
- Modify: `kermanych/apps/ui/src/stores/orchestrator.ts` (remove the four pass-throughs)
- Modify: `kermanych/apps/ui/src/pages/AgentsPage.vue` (remove the move modal: template 469-494, `openMove`/`confirmMove` 1551-1566, `moveOpen`/`moveTarget` refs)
- Delete: `kermanych/apps/api/test/supervisor.tasks.spec.ts`
- Modify: `kermanych/apps/api/test/create-guards.spec.ts` (port to `createSessionFromTask`)
- Modify: `kermanych/apps/api/test/supervisor.base-branch.spec.ts` (port to `createSessionFromTask`)

**Interfaces:**
- Consumes: everything above; no UI caller of the four endpoints remains after Tasks 7-10.
- Produces: `from-task` is the only birth path of an agent session.

- [ ] **Step 1: Port the launch-guard tests**

These four cases in `create-guards.spec.ts` (`:37`, `:48`, `:55`, `:63`) test `resolveLaunchParams`/`launch`, not the task store — they must survive on the new path. Add the same cloud mock the from-task suite uses (`sessions.from-task.spec.ts:31-55`) and rewrite each call. Example for the first:

```ts
test("in-place create is refused on a dirty tree", async () => {
  const { sup, reg, repo, g } = await make();          // existing helper
  writeFileSync(join(repo, "dirty.txt"), "x\n");
  // An in-place card, filed by the user who now runs it — the only shape that reaches the
  // in-place path at all (createSessionFromTask forces a worktree for anybody else).
  cloudTask({ assigneeId: USER, createdBy: USER, worktree: false, projectId: g.id });

  await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow(/clean/i);
  expect(reg.listSessions(g.id)).toHaveLength(0);
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev");
});
```

Do the same for the already-active, detached-HEAD and pre-existing-branch cases. In `supervisor.base-branch.spec.ts`, the three `createSession` cases become `createSessionFromTask` with `branch` on the card (that IS the base branch), and the `startTask` case at `:86-91` is deleted — it duplicated the base-branch assertion through the removed path.

- [ ] **Step 2: Run the ported tests to verify they fail for the right reason**

Run: `cd kermanych && pnpm --filter @kermanych/api test -- create-guards base-branch`
Expected: FAIL only where the code still needs changing (they should pass already if Task 3 landed; a failure here means the worktree flag is not being honoured).

- [ ] **Step 3: Delete the endpoints and methods**

Remove the four routes from `sessions.controller.ts` (and its now-unused `TaskDraft` import),
the four methods from `supervisor.service.ts`, and `TaskDraft` from
`packages/core/src/types.ts`.

**`"task"` STAYS in `Session["kind"]`, and this is a deliberate deviation from the spec's
cutover table.** The spec listed the variant as removed; implementing Task 10 showed it
cannot be: a machine whose project is local-only keeps its pre-cutover backlog rows, those
rows are `kind: "task"`, and the registry reads them on every boot. Narrowing the union
would make the type lie about rows that exist on disk. Instead, document what the kind now
means:

```ts
  // "task" is no longer produced: a task is a cloud card and `from-task` is the only way an
  // agent is born. Rows with this kind are pre-cutover backlog leftovers whose project is
  // not in the cloud, so lib/publish-backlog.ts could not move them; AgentsPage lists them
  // under «Задачі» as local-only until their project is published.
  kind: "agent" | "discussion" | "review" | "chat" | "task";
```

Delete `apps/api/test/supervisor.tasks.spec.ts`. Then the UI wrappers: `api.createSession`,
`api.startTask`, `api.updateTask`, `api.moveTask` and the four `orchestrator.ts`
pass-throughs, plus the unreachable move modal in `AgentsPage.vue`.

- [ ] **Step 4: Run everything**

```bash
cd kermanych
pnpm --filter @kermanych/core build
pnpm --filter @kermanych/cloud build
pnpm -r test
pnpm --filter @kermanych/api typecheck
pnpm --filter @kermanych/ui typecheck
```
Expected: PASS. Any leftover reference to `TaskDraft` or the removed api methods surfaces
here — fix each at its call site rather than re-adding the removed symbol. A remaining
`kind === 'task'` read is fine and expected: it is the stranded-leftover branch from Task 7.

Requirement 1's coverage is the pair of per-path assertions, not a new test: `session.taskId`
is asserted for the from-task path (`sessions.from-task.spec.ts`, Task 3) and for the promote
path (`supervisor.chat.spec.ts`, Task 4). Those are the only two paths that produce a
`kind: "agent"` session after this task, so `cloud-sync.spec.ts` passing unchanged means its
`if (!s.taskId) return` guard now only ever fires for chats, discussions and reviews.

- [ ] **Step 5: Smoke the whole path once more**

`pnpm dev:app`: file a card, launch it, let it reach `done`; confirm the board mirrors every status. Then restart the app and confirm nothing 404s in the console.

- [ ] **Step 6: Commit**

```bash
git add -A kermanych
git commit -m "refactor: remove the local task store — from-task is the only birth path"
```

---

### Task 12: documentation

**Files:**
- Modify: `kermanych/README.md` (lines 102-107, 332-361, 362-386, and the «action / who» table at 87-95)

- [ ] **Step 1: Update «Cloud tasks and local sessions»**

Rewrite steps 1-2 so creation is the cloud write it now is:

```markdown
1. **Create** — any member of the project's workspace creates a task, from the board
   (`/#/board`) or from «Агенти» / «Чат». A card filed from the board is unassigned unless
   its author picks someone; a card filed from «Агенти» or «Чат» is assigned to its author,
   because that is the machine about to run it. Either way it is a row in the cloud
   `tasks` — there is no local-only task — so the whole workspace sees it. It starts in
   `backlog`, which exists only in the cloud.
2. **Assign** — the author or the assignee may hand a card over; the workspace owner may
   take one back from someone who is gone. Anyone may claim an UNASSIGNED card, and
   pressing «Запустити» on one self-assigns it atomically. Taking a card assigned to
   somebody else is refused by the database, not just by the UI. An active task
   (`queued`, `thinking`, `tool`, `waiting_input`) can be neither reassigned nor deleted.
```

- [ ] **Step 2: Update the «action / who» table**

Replace the assignment-related rows:

| action | who |
|---|---|
| create a task | any workspace member |
| claim an unassigned task | any workspace member |
| hand over or release an assigned task | its assignee, or the workspace owner |
| force a stuck task to `stopped` | its assignee, or the workspace owner |

- [ ] **Step 3: Correct the offline section**

The line «STARTING a board task is the one step that needs the cloud» is no longer true. Replace with:

```markdown
- CREATING a task and STARTING one are the two steps that need the cloud: a task is a cloud
  card, so Kermanych has to write it and claim it for you. Offline, «Нова задача» and
  «Запустити» fail with a clear error; chats, the sessions you already started, and every
  merge and finish keep working with no network at all.
```

- [ ] **Step 4: Correct the bucket description**

Around line 102-107, state what «Задачі» now shows: the cloud cards in `backlog` assigned
to you, in the current scope — while unclaimed team cards live on «Дошка».

- [ ] **Step 5: Commit**

```bash
git add kermanych/README.md
git commit -m "docs: tasks are cloud cards"
```

---

## Verification (after Task 12)

- [ ] `cd kermanych && pnpm -r test` — green.
- [ ] `pnpm --filter @kermanych/api typecheck && pnpm --filter @kermanych/ui typecheck` — green.
- [ ] With a local stack and the three `SUPABASE_TEST_*` variables exported: `pnpm --filter @kermanych/cloud test` — the RLS suite green, including Task 1's six cases.
- [ ] **Two accounts, one workspace** (the proof of the whole change): A files a task in «Агенти» → it is on B's board with A as assignee; B's «Запустити» is disabled with a reason; B claims an unassigned card by running it; B's attempt to take A's card is refused with the database's message; A offline gets an actionable error; A's local-only project offers publication; one task runs to `done` and the board follows every status.
- [ ] `supabase db push --linked --dry-run` shows exactly one pending migration, then `supabase db push --linked`.
