-- Kermanych team cloud — a card may carry a person's estimate.
--
-- docs/specs/2026-11-09-task-estimate.md. «Оцінка, год» in «Нова задача» and in the board's
-- editor; a Jira or Plane launch copies the tracker's time estimate onto its shadow card. The
-- launching machine stamps the value on its local session, and «Аналітика» compares it with the
-- time to PR («Оцінка vs факт»).
--
--   tasks.estimate_minutes  NEW. Nullable INTEGER, > 0. NULL is «не оцінено», so no backfill.
--                           The grants are table-level and the tasks policies predicate on
--                           rows, so the existing RLS covers the column at once. The client
--                           selects it on every task read: apply the migration before shipping
--                           a client that knows it.
--
-- tasks_guard() is NOT redefined: an estimate is not what the card asks the agent to do, so a
-- colleague who sets it keeps the author's auto-run switch as it is.

alter table public.tasks
  add column if not exists estimate_minutes integer
    check (estimate_minutes is null or estimate_minutes > 0);
