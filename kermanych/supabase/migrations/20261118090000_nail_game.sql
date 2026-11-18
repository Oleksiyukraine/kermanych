-- «Гвіздки», the one-minute break game (docs/specs/2026-11-18-nail-hammer-minigame.md).
--
-- One row per finished round. A signed-in user may only INSERT, and only as themselves; nobody
-- reads the table from a client. The leaderboard is `nail_game_leaderboard()`, which returns each
-- player's best score with the name and avatar `profiles` already shows to every signed-in user.
--
-- Additive only: no older client reads any of this.

create table public.nail_game_scores (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  -- 400 is above what perfect play can reach: the round spawns fewer nails than that, a bent one
  -- scores 2 (apps/ui/src/lib/nail-game.ts, and its test proves the bound).
  score       integer not null check (score between 0 and 400),
  created_at  timestamptz not null default now()
);

comment on table public.nail_game_scores is
  'Finished rounds of «Гвіздки» (docs/specs/2026-11-18-nail-hammer-minigame.md): insert-only for the player, read through nail_game_leaderboard().';

create index nail_game_scores_user_created on public.nail_game_scores (user_id, created_at desc);
create index nail_game_scores_user_score on public.nail_game_scores (user_id, score desc, created_at);

alter table public.nail_game_scores enable row level security;

-- Supabase's default privileges grant new public tables to anon and authenticated in full;
-- narrow them to one INSERT by a signed-in user.
revoke all on table public.nail_game_scores from anon, authenticated;
grant insert on table public.nail_game_scores to authenticated;

create policy nail_game_scores_insert_own on public.nail_game_scores for insert to authenticated
  with check (user_id = auth.uid());

-- ── one score per round ───────────────────────────────────────────────────────
-- A round is a 3 s countdown and 60 s of play, so two honest scores are at least 63 s apart.
-- The trigger stamps created_at itself (a client-supplied timestamp would dodge the window) and
-- takes a per-user advisory lock, so two parallel inserts cannot both pass the check.
-- security definer: the player cannot SELECT the table, and the check must see their rows.
create or replace function public.nail_game_scores_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('nail_game_scores:' || new.user_id::text, 0));
  new.created_at := now();
  if exists (
    select 1 from public.nail_game_scores
    where user_id = new.user_id and created_at > now() - interval '50 seconds'
  ) then
    raise exception 'nail_game_too_soon' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.nail_game_scores_guard() from public, anon, authenticated;

create trigger nail_game_scores_guard
  before insert on public.nail_game_scores
  for each row execute function public.nail_game_scores_guard();

-- ── the leaderboard ───────────────────────────────────────────────────────────
-- Each player's best score; a tie goes to who reached it first. Returns the top `p_limit`
-- (1…50) and, when it is outside them, the caller's own row, so «your place» needs no second
-- call. `players` is how many players the scope ranks.
--
-- `p_workspace` null ranks everyone. A workspace id ranks only its members, and only for a
-- caller who is one: an outsider gets no rows, not a list of who is in it.
create or replace function public.nail_game_leaderboard(p_workspace uuid default null, p_limit integer default 10)
returns table (
  place           integer,
  user_id         uuid,
  github_username text,
  display_name    text,
  avatar_url      text,
  best_score      integer,
  achieved_at     timestamptz,
  players         integer
)
language sql
stable
security definer
set search_path = public
as $$
  with best as (
    select distinct on (s.user_id) s.user_id, s.score, s.created_at
    from public.nail_game_scores s
    where p_workspace is null
       or (
         public.is_workspace_member(p_workspace, auth.uid())
         and exists (
           select 1 from public.workspace_members m
           where m.workspace_id = p_workspace and m.user_id = s.user_id
         )
       )
    order by s.user_id, s.score desc, s.created_at asc
  ),
  ranked as (
    select
      b.user_id,
      b.score,
      b.created_at,
      (rank() over (order by b.score desc))::integer as place,
      row_number() over (order by b.score desc, b.created_at asc, b.user_id) as pos,
      (count(*) over ())::integer as players
    from best b
  )
  select r.place, r.user_id, p.github_username, p.display_name, p.avatar_url, r.score, r.created_at, r.players
  from ranked r
  join public.profiles p on p.id = r.user_id
  where auth.uid() is not null
    and (r.pos <= least(greatest(coalesce(p_limit, 10), 1), 50) or r.user_id = auth.uid())
  order by r.pos;
$$;

revoke all on function public.nail_game_leaderboard(uuid, integer) from public, anon;
grant execute on function public.nail_game_leaderboard(uuid, integer) to authenticated;
