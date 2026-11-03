-- Kermanych team cloud — the platform moves from the task to the project; the preview commands
-- leave the cloud.
--
-- docs/specs/2026-11-03-session-browser-preview.md, decisions 2, 9 and 10.
--
--   projects.platform        NEW. What the project ships: 'web', 'backend' or 'mobile'. Back-end
--                            and mobile projects get no session «Браузер» and no live preview.
--                            NULL is «Не визначено» and keeps both, so every existing project
--                            needs no backfill. Plain TEXT with NO check constraint, exactly like
--                            projects.default_effort: the vocabulary belongs to @kermanych/core
--                            (PLATFORMS in platform.ts), and the client reads a value it does not
--                            know as «Не визначено» instead of the database refusing a future one.
--   projects.preview_command DROPPED. The preview config now lives in the repo, in
--   projects.api_command     `.kermanych/preview.json`, versioned with the branch — one source of
--                            truth, so the cloud columns are not kept as a fallback.
--   tasks.platform           DROPPED. A card no longer picks a platform, and nothing ever read it
--                            to change behaviour.
--
-- DESTRUCTIVE, and dropped in this change rather than after a release (decision 10). Accepted
-- risk: a teammate on an older build cannot load the board or the project list until they
-- update, because those builds select the dropped columns by name.
--
-- The grants in 20260821090200 are table-level and the projects policies predicate on rows
-- rather than on a column list, so the new column is covered by the existing RLS the moment it
-- exists.

-- ── 1. tasks_guard without the platform ──────────────────────────────────────

-- Redefined BEFORE the column goes: plpgsql does not track the columns a function names, so the
-- drop below would succeed and leave rule 6 failing on every UPDATE of an auto-run card. Same
-- name, same signature, so the four tasks_* policies and the trigger stay textually unchanged.
-- Reproduced verbatim from 20261023090000_task_auto_run.sql minus `platform` in rule 6.
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
       and (new.title, new.description, new.project_id, new.branch, new.model, new.effort,
            new.prefix, new.worktree, new.image_paths, new.deep_analysis, new.kind)
           is distinct from
           (old.title, old.description, old.project_id, old.branch, old.model, old.effort,
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

-- ── 2. the columns ────────────────────────────────────────────────────────────

alter table public.projects
  add column if not exists platform text;

alter table public.projects
  drop column if exists preview_command,
  drop column if exists api_command;

alter table public.tasks
  drop column if exists platform;
