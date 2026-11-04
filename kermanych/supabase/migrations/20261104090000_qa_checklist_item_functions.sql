-- «Тестувальник» (docs/specs/2026-11-04-qa-tester-agent.md, decisions 3 and 10).
--
-- Two writers now share tasks.qa_checklist: a person ticking items on the board and the tester
-- agent recording a verdict per item through the local api. Until now every write replaced the
-- whole column from the writer's copy, so a tick from a stale copy silently dropped a verdict
-- written a second earlier, and a second «Створити ПР» wiped every tick. Both functions below
-- change the column inside one UPDATE, so neither can lose the other's work.
--
-- `security invoker`: the caller's RLS and tasks_guard() apply exactly as for a plain UPDATE of
-- the column (any project member may write it; it is not card content for rule 6).

-- 1. Merge `p_patch` into the items whose id is in `p_items`, then drop the keys in `p_drop`
--    (an untick drops checkedBy/checkedAt; a new run drops the old `agent` verdict). Item order
--    and every other item are kept as stored. Returns the checklist as written; raises when the
--    task is not visible to the caller or holds none of the items.
create or replace function public.qa_checklist_patch_items(
  p_task uuid,
  p_items text[],
  p_patch jsonb default '{}'::jsonb,
  p_drop text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_checklist jsonb;
begin
  update public.tasks t
  set qa_checklist = jsonb_set(
    t.qa_checklist,
    '{items}',
    (
      select coalesce(
        jsonb_agg(
          case when e.it->>'id' = any (p_items) then (e.it || p_patch) - p_drop else e.it end
          order by e.ord
        ),
        '[]'::jsonb
      )
      from jsonb_array_elements(t.qa_checklist->'items') with ordinality as e(it, ord)
    )
  )
  where t.id = p_task
    -- CASE, not AND: SQL does not promise short-circuit, and jsonb_array_elements raises on a
    -- non-array (the `{}` «no checklist» default).
    and case
      when jsonb_typeof(t.qa_checklist->'items') = 'array' then exists (
        select 1 from jsonb_array_elements(t.qa_checklist->'items') as x(it)
        where x.it->>'id' = any (p_items)
      )
      else false
    end
  returning t.qa_checklist into v_checklist;

  if not found then
    raise exception 'qa checklist item not found';
  end if;
  return v_checklist;
end;
$$;

revoke all on function public.qa_checklist_patch_items(uuid, text[], jsonb, text[]) from public, anon;
grant execute on function public.qa_checklist_patch_items(uuid, text[], jsonb, text[]) to authenticated;

-- 2. Write a whole checklist only onto a card that has none (`{}` or an empty `items`).
--    Returns whether it wrote. «Створити ПР» and the tester's own checklist both go through it,
--    so an existing checklist — with its ticks and verdicts — is never replaced.
create or replace function public.qa_checklist_set_if_empty(p_task uuid, p_checklist jsonb)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.tasks t
  set qa_checklist = p_checklist
  where t.id = p_task
    -- CASE, not OR: SQL does not promise short-circuit, and jsonb_array_length raises on a
    -- non-array.
    and case
      when jsonb_typeof(t.qa_checklist->'items') = 'array' then jsonb_array_length(t.qa_checklist->'items') = 0
      else true
    end;
  return found;
end;
$$;

revoke all on function public.qa_checklist_set_if_empty(uuid, jsonb) from public, anon;
grant execute on function public.qa_checklist_set_if_empty(uuid, jsonb) to authenticated;
