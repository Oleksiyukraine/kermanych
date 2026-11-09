-- Kermanych team cloud — a card that continues a «Синергія» prototype.
--
-- docs/specs/2026-11-09-merge-design-into-synergy.md, decision 5. «Задача →» on the «Синергія»
-- page pushes the prototype's `synergy/<slug>` branch and files a card for whoever builds it
-- properly, later or on another machine. The card names that branch here; `tasks.branch` keeps
-- the base the prototype forked from, so the pull request still targets it.
--
--   tasks.synergy_branch  NEW. Plain nullable TEXT, NULL for every other card, so no backfill.
--                         Written on insert only by the client. The grants are table-level and
--                         the tasks policies predicate on rows, so the existing RLS covers the
--                         column at once. The client selects it on every task read: apply the
--                         migration before shipping a client that knows it.
--
-- `tasks.design` (20261029090000) stays: the «Дизайн» tab is gone, but older clients still select
-- the column by name. A later migration drops it once no client reads it.
alter table public.tasks
  add column if not exists synergy_branch text;
