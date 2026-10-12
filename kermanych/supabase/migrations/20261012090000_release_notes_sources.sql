-- Release notes over several projects. The Release Notes form now lets a member pick more
-- than one project of the workspace — the back-end and the front-end, say — each read from
-- its own branch, and the note gets one section per project.
--
-- Additive: one nullable column. `sources` is the note's provenance as a list, in the order
-- the note writes its sections: `[{ "project_id", "project_name", "branch" }, …]`. Rows written
-- before this migration keep `sources` null and are read as the one project their columns
-- name (packages/cloud/src/release-notes.ts).
--
-- The single-project columns stay and are still written on every insert, as a SUMMARY:
-- `project_id` is the project when there is exactly one and null for several, `project_name`
-- and `branch` are the names and the branches joined with « + ». A build that predates this
-- column, and every reader that only needs a label (the home tile, the assistant's digest),
-- keeps showing something true without knowing the list exists.
--
-- `project_id` inside the list is a snapshot, not a foreign key: like `project_name` beside
-- it, it outlives the project row it described.

alter table public.workspace_release_notes
  add column sources jsonb,
  -- CASE, not AND: SQL does not promise to evaluate AND left to right, and
  -- jsonb_array_length() raises on anything that is not an array.
  add constraint workspace_release_notes_sources check (
    sources is null
    or case when jsonb_typeof(sources) = 'array' then jsonb_array_length(sources) >= 1 else false end
  );

-- The list is provenance, so it is frozen after insert like every other provenance column:
-- an edit changes the TEXT, not what the note was generated from.
create or replace function public.workspace_release_notes_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.workspace_id := old.workspace_id;
    new.project_id   := old.project_id;
    new.project_name := old.project_name;
    new.branch       := old.branch;
    new.sources      := old.sources;
    new.range_from   := old.range_from;
    new.range_to     := old.range_to;
    new.created_at   := old.created_at;
    new.created_by   := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
