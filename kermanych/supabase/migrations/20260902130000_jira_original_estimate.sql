-- The ticket dialog's «Оцінка» field: Jira's timetracking.originalEstimate, mirrored as
-- the display string Jira itself uses («2w 3d 4h»). Blank = no estimate — the mirror's
-- tolerant-blank convention, same as priority_name.
alter table public.jira_issues
  add column original_estimate text not null default '';
