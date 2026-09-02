-- Log work, the visible half. Jira's own time-tracking counters mirrored beside
-- original_estimate, because logging work is exactly what MOVES them: `time_spent` is the
-- sum Jira keeps of the issue's worklogs, `remaining_estimate` is what the log-work
-- dialog's estimate adjustment leaves behind. Both in Jira's display spelling
-- («2w 3d 4h»); blank = Jira tracks none for this issue — the mirror's tolerant-blank
-- convention, same as original_estimate.
alter table public.jira_issues
  add column time_spent         text not null default '',
  add column remaining_estimate text not null default '';
