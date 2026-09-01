-- Kermanych team cloud — the task's reasoning effort (omp's "thinking level").
--
-- A card already carries the MODEL its assignee's machine launches with; this is the
-- other half of that launch parameter, and the operator can change either one on a
-- running session. Stored beside `model` because the pair travels together.
--
-- Plain TEXT with NO check constraint, exactly like `model`: the vocabulary belongs to
-- omp (off/minimal/low/medium/high/xhigh/max today, see @kermanych/core's
-- THINKING_LEVELS), and a CHECK here would reject a level a future omp release adds
-- while every machine on the board is still able to run it.
--
-- Nothing else is needed: the grants in 20260821090200 are table-level, the tasks
-- policies and tasks_guard() predicate on rows rather than on a column list, so the new
-- column is covered by the existing RLS the moment it exists.
alter table public.tasks
  add column if not exists effort text;
