-- Kermanych team cloud — the documentation policy loses its `ask` rule.
--
-- `ask` put a checkbox for the kind into the «Завершити сесію» sheet («Хендоф для фронта»,
-- «Запит на розширення API»); ticked, the gate required the document. The operator now asks
-- for either document by name, mid-session, from the session's «Документація» tab, so the
-- sheet has no checkboxes and `docs_policy` takes `"off"|"optional"|"required"` for
-- `handoff` and `"off"|"optional"` for `apiRequest` (see
-- docs/specs/2026-10-05-finish-sheet-without-doc-checkboxes.md).
--
-- A kind stored as `ask` becomes `optional`: the agent writes it where it applies, nothing
-- blocks. Without this backfill the client would read `ask` as the kind's default, which for
-- `apiRequest` is `off` and would silently drop it from the policy. A machine still on the
-- previous build reads `optional` as it always did.
--
-- DATA ONLY: no schema change; the column, grants and policies are untouched.
update public.projects
set docs_policy = (
  select jsonb_object_agg(e.key, case when e.value = '"ask"'::jsonb then '"optional"'::jsonb else e.value end)
  from jsonb_each(docs_policy) e
)
-- CASE, not AND: Postgres may evaluate AND operands in any order, and jsonb_each refuses a
-- non-object (a hand-edited row).
where case
  when jsonb_typeof(docs_policy) = 'object'
    then exists (select 1 from jsonb_each(docs_policy) e where e.value = '"ask"'::jsonb)
  else false
end;
