-- Multiple Jira boards per workspace (up to 10), replacing the one-board-per-workspace
-- rule of 20260902090000_jira_integration.sql.
--
-- Nothing else in the mirror changes: every jira_* child table was already keyed by
-- integration_id, so a second board is simply a second workspace_jira_integrations row
-- with its own columns/issues/children/sync_state cascade. Only the workspace_id UNIQUE
-- constraint (which forced re-pointing an existing row instead of adding one) and the
-- upsert key have to move.

-- ── one board per (workspace, board) instead of one per workspace ───────────────
-- Drop the workspace-wide uniqueness…
alter table public.workspace_jira_integrations
  drop constraint workspace_jira_integrations_workspace_id_key;

-- …and forbid only the honest duplicate: the SAME Jira board added twice. Re-connecting
-- a board (a board-name/site refresh) is still an upsert on this key, so it updates the
-- existing row rather than creating a twin.
alter table public.workspace_jira_integrations
  add constraint workspace_jira_integrations_workspace_board_key
  unique (workspace_id, board_id);

-- ── the cap: at most 10 boards per workspace ───────────────────────────────────
-- A ceiling, not a policy: the mirror, the sync ticker and the board switcher all stay
-- cheap at ten, and a workspace with fifty boards is a mistake we refuse loudly rather
-- than let it degrade every poll. Enforced in a trigger because a CHECK cannot count
-- sibling rows. `upsertJiraIntegration` re-connects an existing board as INSERT … ON
-- CONFLICT DO UPDATE, and the BEFORE INSERT trigger fires for that too — so the count
-- EXCLUDES the board being written (`board_id <> new.board_id`): re-connecting one of ten
-- boards is unaffected, only a genuinely new eleventh is refused.
create or replace function public.workspace_jira_integrations_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.workspace_jira_integrations
        where workspace_id = new.workspace_id and board_id <> new.board_id) >= 10 then
    raise exception 'a workspace may connect at most 10 Jira boards'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger workspace_jira_integrations_limit
  before insert on public.workspace_jira_integrations
  for each row execute function public.workspace_jira_integrations_limit();
