-- Kermanych team cloud — a card may name its own branch.
--
-- docs/specs/2026-11-04-custom-branch-name.md. The launcher's «Гілка» box takes the part after the
-- prefix (`feature/<this>`). Empty is the default: the launching machine asks a model to name the
-- branch from the task, as before (docs/specs/2026-10-26-branch-name-from-task.md). It lives on
-- the card because the card is what every launch reads — «В беклог», a teammate's ▶ on the board
-- and «Посіпака» all start from the saved row, not from the form that filed it.
--
--   tasks.branch_slug  NEW. Plain nullable TEXT, no check constraint: the launch runs it through
--                      @kermanych/core's slugify, so a value git would refuse still yields a valid
--                      branch. NULL is «згенерувати», so no backfill. The grants are table-level
--                      and the tasks policies predicate on rows, so the existing RLS covers the
--                      column at once. The client selects it on every task read: apply the
--                      migration before shipping a client that knows it.
--
-- tasks_guard() is redefined so rule 6 counts the branch name as WHAT the card asks for: a
-- colleague who renames an auto-run card's branch takes the author's endorsement away, exactly as
-- a changed prefix does. Reproduced verbatim from 20261103100000_project_platform.sql plus
-- `branch_slug` in rule 6. Same name, same signature, so the policies and the trigger stay as
-- they are. The column is added first: rule 6 names it on every UPDATE of an auto-run card.

alter table public.tasks
  add column if not exists branch_slug text;

create or replace function public.tasks_guard()
returns trigger
language plpgsql
as $$
declare
  active_statuses task_status[] := array['queued','thinking','tool','waiting_input']::task_status[];
begin
  -- 0. An assignee must belong to the task's workspace. Checked on INSERT and on every CHANGE
  --    of assignee_id, never on an unrelated UPDATE: a member who later leaves the workspace
  --    must not freeze the cards they still hold.
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not public.is_project_member(new.project_id, new.assignee_id) then
    raise exception 'assignee is not a workspace member';
  end if;

  if tg_op = 'UPDATE' then
    -- 1. Only the assignee moves a task's status. The self-assign case is allowed because
    --    claim + status can land in one statement, in which case the new assignee is the
    --    caller — which is exactly how a launch now claims a card (claimTaskForLaunch,
    --    claimMinionTask). One exception: the WORKSPACE's owner may force 'stopped'.
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
    -- 2b. A taken card is not up for grabs. `null -> X` stays open to any member (the claim);
    --     `X -> anything` is X's own call or the workspace owner's.
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

    -- 4. Authorship and origin are facts of the insert. A client that sends them anyway
    --    is ignored rather than refused, so a full-row write from an editor needs no special
    --    case.
    new.created_by := old.created_by;
    new.finding_kind := old.finding_kind;

    -- 5. Only the author allows automatic execution: the minion runs the card with the
    --    author's account, machine and tokens. Anyone may switch it off.
    if new.auto_run and not old.auto_run
       and auth.uid() is distinct from old.created_by then
      raise exception 'only the author can allow auto-run';
    end if;

    -- 6. Anyone else who changes WHAT the card asks for takes the author's endorsement
    --    away: colleagues may still edit the card, the minion just stops trusting it. Status,
    --    assignee, `hidden`, the QA checklist and the reports are not content — a status push,
    --    a claim, a tester's tick or a report write never clears the switch.
    if new.auto_run
       and auth.uid() is distinct from old.created_by
       and (new.title, new.description, new.project_id, new.branch, new.branch_slug, new.model, new.effort,
            new.prefix, new.worktree, new.image_paths, new.deep_analysis, new.kind)
           is distinct from
           (old.title, old.description, old.project_id, old.branch, old.branch_slug, old.model, old.effort,
            old.prefix, old.worktree, old.image_paths, old.deep_analysis, old.kind) then
      new.auto_run := false;
    end if;
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
