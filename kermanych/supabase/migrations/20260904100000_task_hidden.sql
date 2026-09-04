-- Kermanych team cloud — «приховати» on a task card.
--
-- The launcher's «Приховати з дошки». A hidden card is a FULL task in every other
-- respect: its assignee still sees it in «Задачі», it still launches a session, it still
-- pushes status back and it still belongs to the project's members. The flag only removes
-- it from the kanban columns, so a developer can file and run their own small errands
-- without adding noise to the team's board.
--
-- NOT NULL with a `false` default, following `worktree` (20260830090000): a boolean whose
-- absence has a meaning is a third state nobody wants, and every existing row was visible,
-- which is exactly what the default says — no backfill.
--
-- Visibility is a VIEW decision, not an authorization one, so this is deliberately not
-- enforced in RLS: hiding a card from the board must never hide it from its own assignee,
-- and the API launches a hidden card through the same getTask/claimTask path. As with
-- `effort` and `jira_key`, the grants in 20260821090200 are table-level and the tasks
-- policies and tasks_guard() predicate on rows rather than on a column list, so the new
-- column is covered by the existing RLS the moment it exists.
alter table public.tasks
  add column if not exists hidden boolean not null default false;
