-- The board's planning dates: Jira's system `duedate` and the site's «Start date» field
-- (a custom field whose id differs per site — apps/api resolves it from /rest/api/3/field).
-- Mirrored as Jira's own date spelling (YYYY-MM-DD); blank = not set, the mirror's
-- tolerant-blank convention, same as original_estimate.
--
-- text, not date: the mirror keeps what Jira said verbatim and never re-zones a day, and
-- the ticket dialog's <input type="date"> speaks the same ten characters both ways.
alter table public.jira_issues
  add column start_date text not null default '',
  add column due_date   text not null default '';
