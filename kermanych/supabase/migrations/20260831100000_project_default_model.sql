-- Kermanych team cloud — a project's DEFAULT launch model.
--
-- The «Нова задача» popup carries a Модель picker with a «за замовчуванням» option. This
-- column is what that default resolves to: a new task/agent in this project pre-selects it
-- instead of leaving omp to choose. A card already stores the model it will LAUNCH with
-- (tasks.model); this is the project-wide seed for a card that has not chosen yet.
--
-- Plain TEXT with NO check constraint, exactly like tasks.model: the model id belongs to
-- omp, and a CHECK here would reject a value a future omp release adds while every machine
-- on the board can still run it. A default model a given machine's catalog does not hold is
-- tolerated the same way a cross-machine task's model already is — the picker keeps the
-- stored id and omp clamps.
--
-- Nothing else is needed: the grants in 20260821090200 are table-level and the projects
-- policies predicate on rows rather than on a column list, so the new column is covered by
-- the existing RLS the moment it exists.
alter table public.projects
  add column if not exists default_model text;
