-- Kermanych team cloud — «Глибокий аналіз» on a task card.
--
-- The second way to start a task (docs/specs/2026-10-08-deep-analysis-task.md): the same agent
-- as «Нова задача», but its opening prompt makes it study the code, interview the operator,
-- write the task document and only then, once approved, write code. The choice lives on the
-- CARD because the card is what every launch reads (createSessionFromTask re-reads it): a card
-- filed into the backlog and started later from «Задачі», from the board's ▶ or by a teammate
-- must still run as a deep analysis.
--
-- NOT NULL with a `false` default, following `hidden` (20260904100000): every existing card
-- is an ordinary task, which is exactly what the default says — no backfill.
--
-- As with `hidden`, the grants in 20260821090200 are table-level and the tasks policies and
-- tasks_guard() predicate on rows rather than on a column list, so the existing RLS covers the
-- new column the moment it exists. The client selects this column on every task read: apply
-- the migration before shipping a client that knows it.
alter table public.tasks
  add column if not exists deep_analysis boolean not null default false;
