-- Kermanych team cloud — «Обовʼязкова документація», a project's mandatory-documentation switch.
--
-- When on, every session of the project gets the documentation policy in its system prompt
-- (docs/specs, docs/plans, docs/schemas, docs/handoffs), and the machine refuses to open a PR,
-- commit to it, or finish a session until the branch carries its task document and either a
-- living-doc change or an explicit `## Documentation impact: None — …` declaration (see
-- docs/specs/2026-09-28-mandatory-documentation-design.md).
--
-- NOT NULL DEFAULT false: switching an existing project to blocking its PRs has to be the
-- operator's choice, so every row that predates the column reads as "off".
--
-- Nothing else is needed: the grants in 20260821090200 are table-level and the projects
-- policies predicate on rows rather than on a column list, so the new column is covered by
-- the existing RLS the moment it exists.
alter table public.projects
  add column if not exists docs_required boolean not null default false;
