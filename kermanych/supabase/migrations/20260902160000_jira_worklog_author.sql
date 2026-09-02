-- Whose entry this is, in Jira's own terms. Jira gates editing and deleting a worklog on
-- «own» versus «all» permissions, so the ticket dialog cannot decide which controls an
-- entry may wear from a display name — it needs the author's accountId, the same
-- identifier the acting member's token reports from /myself.
--
-- Blank for rows mirrored before this column existed; they simply read as «not mine»
-- until the next poll rewrites them, which is the tolerant-blank convention everywhere
-- else in the mirror.
alter table public.jira_worklogs
  add column author_account_id text not null default '';
