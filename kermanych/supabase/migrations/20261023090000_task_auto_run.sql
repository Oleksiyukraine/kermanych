-- Kermanych team cloud — «Посіпака»: auto-run cards and finding-born cards.
--
-- docs/specs/2026-10-23-minion-auto-run.md. «Посіпака» (code id `minion`) is an agent that, on a
-- machine where its owner activated it, takes that owner's own backlog cards marked for
-- automatic execution and runs them to a pull request with nobody watching.
--
-- Two columns, both covered by the existing RLS the moment they exist (the grants in
-- 20260821090200 are table-level, and the tasks policies and tasks_guard() predicate on rows,
-- not on a column list). The client selects both on every task read: apply this migration
-- before shipping a client that knows them.
--
--   auto_run      «Дозволити автовиконання». NOT NULL default false, like `deep_analysis`: every
--                 existing card is an ordinary card, which is what the default says, so no
--                 backfill.
--   finding_kind  The kind of the «Знахідка» a card was filed from (docs/specs/2026-10-13-agent-
--                 findings.md), NULL for every other card. Set once, by the filing dialog, so the
--                 team can count finding-born cards later; frozen by tasks_guard() below.
alter table public.tasks
  add column if not exists auto_run boolean not null default false;
alter table public.tasks
  add column if not exists finding_kind text;
alter table public.tasks
  drop constraint if exists tasks_finding_kind_check;
alter table public.tasks
  add constraint tasks_finding_kind_check
  check (finding_kind is null or finding_kind in ('bug', 'security', 'tech-debt', 'docs'));

-- The minion runs only cards whose `created_by` is the account signed in on its machine — the
-- operator's own words, with the operator's `.env` and `GIT_TOKEN`. Until now nothing guarded
-- that column: tasks_update_member lets any member update any column of any card, so a
-- colleague could put their text under the operator's name. Rules 4-6 make authorship a
-- database fact, the way the passwords, doc links and release notes already treat theirs.
--
-- Same name, same signature, so the four tasks_* policies stay textually unchanged. Still NOT
-- `security definer`: rules 1, 2b, 5 and 6 compare against auth.uid() of the actual caller.
-- Rules 0-3 are reproduced verbatim from 20260830090000_tasks_assignment.sql.
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

    -- 4. NEW. Authorship and origin are facts of the insert. A client that sends them anyway
    --    is ignored rather than refused, so a full-row write from an editor needs no special
    --    case.
    new.created_by := old.created_by;
    new.finding_kind := old.finding_kind;

    -- 5. NEW. Only the author allows automatic execution: the minion runs the card with the
    --    author's account, machine and tokens. Anyone may switch it off.
    if new.auto_run and not old.auto_run
       and auth.uid() is distinct from old.created_by then
      raise exception 'only the author can allow auto-run';
    end if;

    -- 6. NEW. Anyone else who changes WHAT the card asks for takes the author's endorsement
    --    away: colleagues may still edit the card, the minion just stops trusting it. Status,
    --    assignee, `hidden`, the QA checklist and the reports are not content — a status push,
    --    a claim, a tester's tick or a report write never clears the switch.
    if new.auto_run
       and auth.uid() is distinct from old.created_by
       and (new.title, new.description, new.project_id, new.branch, new.model, new.effort,
            new.prefix, new.platform, new.worktree, new.image_paths, new.deep_analysis, new.kind)
           is distinct from
           (old.title, old.description, old.project_id, old.branch, old.model, old.effort,
            old.prefix, old.platform, old.worktree, old.image_paths, old.deep_analysis, old.kind) then
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
