-- Remove tasks.doc_report. The «Документація» tab is now fed by ONE mechanism — the session's
-- own transcript (docs READ) and the Зміни diff (docs CHANGED, filtered by isDocPath) — derived
-- entirely in the UI, so the list is identical before and after «Створити ПР» and never leaks a
-- non-doc path. The «Бібліотекар» doc-report artifact that this column stored (a free-form list
-- that drifted from the derived view and pulled in source files) is gone, so the column has no
-- writer or reader left. This reverses the additive migration that introduced it
-- (20260910100000_task_doc_report). Idempotent, like every task-column migration before it.
alter table public.tasks
  drop column if exists doc_report;
