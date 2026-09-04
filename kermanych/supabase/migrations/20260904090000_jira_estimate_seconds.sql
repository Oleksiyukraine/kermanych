-- supabase/migrations/20260904090000_jira_estimate_seconds.sql
-- Team Capacity needs arithmetic on estimates, and the three display strings beside these
-- («2w 3d 4h») cannot be added up without knowing the site's own 1w/1d conversion. Jira's
-- `timetracking` field carries the same three counters in seconds, so the mirror keeps
-- both: the string is what the ticket dialog shows, the number is what capacity sums.
-- 0 = Jira holds none — the tolerant-blank convention of `jira_worklogs.seconds`.
alter table public.jira_issues
  add column original_estimate_seconds  integer not null default 0,
  add column time_spent_seconds         integer not null default 0,
  add column remaining_estimate_seconds integer not null default 0;

-- The capacity screen reads worklogs by calendar range across the whole board, which the
-- per-issue index cannot serve.
create index jira_worklogs_started_idx on public.jira_worklogs (integration_id, started_at);
