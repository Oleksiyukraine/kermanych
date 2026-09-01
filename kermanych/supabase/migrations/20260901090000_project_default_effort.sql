-- Kermanych team cloud — a project's DEFAULT launch reasoning effort.
--
-- The reasoning half of 20260831100000's default_model: the «Запуск задач» settings pane
-- carries a Модель picker and an Ефорт picker, each with a «за замовчуванням» option, and
-- this column is what the effort default resolves to. A new task/agent in this project
-- pre-selects it instead of leaving omp to choose. A card already stores the effort it will
-- LAUNCH with (tasks.effort); this is the project-wide seed for a card that has not chosen yet.
--
-- Plain TEXT with NO check constraint, exactly like tasks.effort and projects.default_model:
-- the effort vocabulary belongs to omp (off/minimal/low/medium/high/xhigh/max today, see
-- @kermanych/core's THINKING_LEVELS), and a CHECK here would reject a value a future omp
-- release adds while every machine on the board can still run it. A model with no reasoning
-- ladder makes the picker offer «недоступно» in the UI; the column simply stores whatever the
-- operator picked and omp clamps a level it cannot honour.
--
-- Nothing else is needed: the grants in 20260821090200 are table-level and the projects
-- policies predicate on rows rather than on a column list, so the new column is covered by
-- the existing RLS the moment it exists.
alter table public.projects
  add column if not exists default_effort text;
