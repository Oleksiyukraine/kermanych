-- Kermanych workspaces gain an optional emoji marker.
--
-- The sidebar draws each workspace with a coloured dot (workspaces.color). This adds
-- a second, richer marker: an emoji the owner may set INSTEAD of the dot — a flag, a
-- face, a thumbs-up. `null` (the default) keeps the coloured dot, so every existing
-- workspace is unchanged until someone opts in.
--
-- Owner-only, like `color`: workspaces_update_owner already covers every column, so no
-- new policy is needed — the emoji is part of the workspace's shared visual identity,
-- not a per-member preference (the per-member choice on this feature is sidebar ORDER,
-- which lives in the client's localStorage and never reaches the cloud).
alter table public.workspaces add column icon text;

comment on column public.workspaces.icon is
  'Optional emoji shown in place of the sidebar colour dot. Owner-set, team-visible. NULL = show the colour dot.';
