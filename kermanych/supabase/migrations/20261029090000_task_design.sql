-- Kermanych team cloud — «Дизайн» cards.
--
-- «+ Новий дизайн» on the «Дизайн» page (docs/specs/2026-10-29-design-tab.md) files a card and
-- launches it at once, so the workspace sees the design on the board. The card says it is a
-- design because the card is what every launch reads (createSessionFromTask re-reads it): a
-- relaunch must again run the «Дизайнер» on a `design/<slug>` branch and stamp the session's
-- `designDir`.
--
-- NOT NULL with a `false` default, following `deep_analysis` (20261008100000): every existing card
-- is an ordinary task — no backfill. The grants are table-level and the tasks policies and
-- tasks_guard() predicate on rows, so the existing RLS covers the column at once. The client
-- selects this column on every task read: apply the migration before shipping a client that
-- knows it.
alter table public.tasks
  add column if not exists design boolean not null default false;
