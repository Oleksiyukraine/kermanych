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
