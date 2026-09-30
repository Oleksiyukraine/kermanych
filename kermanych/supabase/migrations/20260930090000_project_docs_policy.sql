-- Kermanych team cloud — the per-kind rules of a project's documentation policy.
--
-- `docs_required` (20260928090000) stays the master switch. `docs_policy` says, per document
-- kind, how hard the policy asks for it:
--   { "spec": "off"|"optional"|"required",        -- docs/specs, the task document
--     "plan": "off"|"optional"|"required",        -- docs/plans
--     "schemas": "off"|"optional"|"required",     -- docs/schemas, living docs
--     "handoff": "off"|"optional"|"ask"|"required", -- docs/handoffs, backend → frontend
--     "apiRequest": "off"|"optional"|"ask" }      -- docs/api-requests, frontend → backend
-- (mirrors @kermanych/core's DocsPolicy; see docs/specs/2026-09-30-documentation-settings.md).
--
-- `{}` (the default) reads as core's DEFAULT_DOCS_POLICY, which is exactly what the single
-- switch meant before this column existed — so no backfill, and a machine still on the
-- previous build keeps reading `docs_required` alone and behaves as it did. A missing key or
-- an unknown value reads as that kind's default; the client normalises, not Postgres.
--
-- ADDITIVE ONLY: the table-level grants in 20260821090200 and the row-predicated projects
-- policies cover the new column the moment it exists.
alter table public.projects
  add column if not exists docs_policy jsonb not null default '{}'::jsonb;
