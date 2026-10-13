-- What a session leaves on its card for the «Документація» and «Сесія» tabs, so the tabs survive
-- an api restart and «Завершити», and every member who can read the card can read them too
-- (docs/specs/2026-10-12-docs-tab-survives-restart.md). Until now both tabs were derived on the
-- author's machine only — off the live transcript and the worktree diff — and emptied the
-- moment either was gone.
--
-- One column per tab, the way tasks.qa_checklist (20260910090000) holds the QA tab:
--   docs_report    { "sessionId", "generatedAt", "read": [path…],
--                    "changed": [ { "path", "added", "removed" } ] }
--   session_report { "sessionId", "generatedAt", "runtime", "native", "model"?, "effort"?,
--                    "branch", "baseBranch"?, "worktree", "skills": [name…], "usage"?,
--                    "providerSessionId"? }
-- Shapes mirror @kermanych/core's DocsReport / SessionReport. The api of the machine that ran
-- the session writes both after every turn and on «Завершити», merging onto the stored value
-- (core mergeTaskReports); a relaunch of the card replaces them with the new session's. `{}` (the
-- default) is «no report yet» — toTask() maps it to an absent key. Not the dropped `doc_report`
-- (20260915120000): that was a free-form librarian list; these are the derived lists themselves.
--
-- jsonb, `not null default '{}'`, exactly like every additive task column before it: the
-- table-level grants in 20260821090200, the row-predicated tasks policies, tasks_guard() and the
-- realtime publication cover the new columns the moment they exist. The client selects them by
-- name, so this migration ships BEFORE any client that reads them.
alter table public.tasks
  add column if not exists docs_report jsonb not null default '{}'::jsonb,
  add column if not exists session_report jsonb not null default '{}'::jsonb;
