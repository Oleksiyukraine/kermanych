-- RAG over project documentation. ADDITIVE ONLY: one extension, two tables and one
-- search function. Nothing is dropped, renamed or backfilled, so this is safe for the
-- maintainer to push whenever they choose, with no cutover window (unlike
-- 20260827100000_workspaces.sql). If a future change ever seems to need dropping or
-- rewriting an existing object, stop and say so instead of writing it here.
--
-- This deliberately RELAXES team-cloud decision A (docs read live from each developer's
-- checkout, nothing cached in the cloud) for THIS feature only: chunk text AND embeddings
-- are stored so a teammate WITHOUT a local checkout can still search. RLS keys visibility
-- to project membership, so the relaxation never crosses a workspace boundary.

-- pgvector: halfvec needs >= 0.7, iterative index scan (used by the search function below)
-- needs >= 0.8. Verified 0.8.2 on the local CLI image. The hosted project must ship a
-- pgvector at least this new or `halfvec` / iterative scan fail on push — that is the
-- maintainer's call (change the column type or upgrade), not something to work around.
create extension if not exists vector;

-- One row per chunk. Natural composite PK (project_id, folder, path, chunk_ix): a re-index
-- of a file deletes its rows and re-inserts them, and dedup WITHIN one project is exactly
-- that key. No surrogate id is needed.
--
-- Deliberately NO denormalised workspace_id on this row. projects.workspace_id is mutable
-- (merging a project into another workspace is a supported, deliberate act), so a
-- denormalised copy goes stale the moment a project moves and would keep these chunks
-- visible to the workspace the project has LEFT. Visibility is derived LIVE through
-- is_project_member(), which joins projects -> workspace_members and therefore follows the
-- project automatically. This is the same pattern project_skills uses. If a denormalised
-- column is ever needed for index performance it MUST be maintained by a trigger on
-- projects, and the project-move isolation test must still pass.
--
-- NEVER deduplicate chunks by content hash ACROSS projects. It is a tempting saving —
-- identical READMEs, licences and boilerplate get embedded (and paid for) repeatedly — but
-- a row shared between two projects is shared VISIBILITY, i.e. a direct cross-workspace
-- leak. Deduplication within a single project is fine and the PK already does it. This
-- comment exists because, without it, the saving will be re-proposed later and look
-- reasonable.
--
-- `embedding` is as sensitive as `content`: embeddings are partially invertible back into
-- their source text, so the vector column is not "safe metadata" — it lives behind the same
-- RLS as the text, and there is no shared vector space across workspaces.
create table public.project_doc_chunks (
  project_id      uuid not null references public.projects(id) on delete cascade,
  folder          text not null,
  path            text not null,
  chunk_ix        int  not null,
  -- e.g. '## Setup > ### Prerequisites' — what makes a citation meaningful.
  heading_path    text not null default '',
  -- 1-based inclusive line span, so a citation opens the file at the right place through
  -- useProjectDocs.openFile().
  start_line      int  not null,
  end_line        int  not null,
  content         text not null,
  -- halfvec (float16), not vector (float32): float16 HALVES the storage, and Supabase
  -- storage — not Voyage tokens — is the binding constraint on the free tier. voyage-4-lite
  -- emits 1024 dimensions. Nullable so a row can exist on the full-text path alone if a
  -- future degraded index ever writes text without a vector; the search function treats a
  -- null embedding as "not a vector candidate".
  embedding       halfvec(1024),
  -- Stored PER ROW because vectors from two different models must never be compared.
  -- Changing the embedding model requires a full reindex, and this column is what makes
  -- that detectable instead of silently wrong.
  embedding_model text not null,
  -- The full-text half of the hybrid search, generated from content so it can never drift
  -- from it. Full-text costs nothing and needs no API key, which is also what gives the
  -- feature a real fallback: when Voyage is unavailable, search degrades to this column
  -- rather than failing.
  fts             tsvector generated always as (to_tsvector('english', content)) stored,
  indexed_at      timestamptz not null default now(),
  primary key (project_id, folder, path, chunk_ix)
);

-- One row per indexed FILE: the hash the indexer diffs against so a re-index re-embeds only
-- files whose content changed, plus the provenance the tab shows ("indexed N files, last
-- at …").
create table public.project_doc_index_state (
  project_id  uuid not null references public.projects(id) on delete cascade,
  folder      text not null,
  path        text not null,
  file_hash   text not null,
  chunk_count int  not null,
  indexed_at  timestamptz not null default now(),
  indexed_by  uuid references public.profiles(id) on delete set null,
  primary key (project_id, folder, path)
);

alter table public.project_doc_chunks      enable row level security;
alter table public.project_doc_index_state enable row level security;

-- Defensive: config.toml leaves auto_expose_new_tables unset, so nothing is granted to
-- anon implicitly — this revoke survives someone turning it back on.
revoke all on table public.project_doc_chunks      from anon;
revoke all on table public.project_doc_index_state from anon;
grant select, insert, update, delete on table public.project_doc_chunks      to authenticated;
grant select, insert, update, delete on table public.project_doc_index_state to authenticated;

-- Read AND write = any project member, derived LIVE through is_project_member() and never a
-- denormalised workspace_id. Writes are member-level (not owner-only like project_skills)
-- because indexing is an ordinary member action, the same way project_risks lets any member
-- write. Crucially this means the Edge Function needs NO elevated rights: it runs both
-- search and writes under the CALLER's JWT and Postgres — not a WHERE clause the function
-- author must never forget — enforces isolation. The service role, which bypasses RLS
-- entirely, must never touch these tables.
create policy project_doc_chunks_member on public.project_doc_chunks
  for all to authenticated
  using      (public.is_project_member(project_id, auth.uid()))
  with check (public.is_project_member(project_id, auth.uid()));

create policy project_doc_index_state_member on public.project_doc_index_state
  for all to authenticated
  using      (public.is_project_member(project_id, auth.uid()))
  with check (public.is_project_member(project_id, auth.uid()));

-- HNSW over the halfvec, cosine distance. An ANN index returns its top-k BEFORE the row
-- policy is applied, so on a GLOBAL index a filtered search could hand back k rows that all
-- belong to other projects and leave the caller's own project short after RLS. The correct
-- remedy is pgvector 0.8 iterative index scan (enabled inside match_project_doc_chunks),
-- NOT routing around the policy with the service role — that would be the very leak the RLS
-- above exists to prevent.
create index project_doc_chunks_embedding_idx on public.project_doc_chunks
  using hnsw (embedding halfvec_cosine_ops);

-- The full-text half of the hybrid search.
create index project_doc_chunks_fts_idx on public.project_doc_chunks using gin (fts);

-- Hybrid retrieval: vector search and full-text search fused with Reciprocal Rank Fusion.
-- Vector search loses on exact terms (function names, file names, risk codes like R-004);
-- full-text search loses on rephrased questions. RRF keeps the strengths of both.
--
-- SECURITY INVOKER, deliberately and not by omission: published pgvector RAG examples
-- routinely declare the match function `security definer`, which silently disables RLS on
-- the chunk rows and turns this into a cross-workspace leak. It must run with the caller's
-- own row policy. (is_project_member, by contrast, is correctly `security definer` for the
-- opposite reason: a membership policy that queried the membership table would recurse.)
--
-- A NULL p_query_embedding is the Voyage-unavailable fallback: the vector CTE contributes
-- nothing and the result degrades to pure full-text rather than failing. Only vectors from
-- the SAME embedding model are compared (p_embedding_model), because cross-model vectors
-- are meaningless.
create or replace function public.match_project_doc_chunks(
  p_project_id      uuid,
  p_query_embedding halfvec(1024),
  p_query_text      text,
  p_match_count     int  default 12,
  p_embedding_model text default 'voyage-4-lite'
)
returns table (
  folder       text,
  path         text,
  chunk_ix     int,
  heading_path text,
  start_line   int,
  end_line     int,
  content      text,
  score        double precision
)
language plpgsql
security invoker
-- volatile, not stable: the SET LOCAL below (iterative scan) is a statement Postgres
-- forbids inside a non-volatile function. It costs nothing here — the function is only
-- ever called once per turn, never inlined into a larger query.
volatile
set search_path = public
as $$
declare
  -- RRF damping constant. 60 is the value from the original Cormack et al. RRF paper and
  -- the one pgvector's own hybrid-search guide uses.
  k    constant int := 60;
  -- Over-fetch from each arm so the fusion has candidates to work with and so iterative
  -- scan has room to reach p_match_count RLS-visible rows.
  pool constant int := greatest(p_match_count * 4, 40);
begin
  -- pgvector 0.8 iterative index scan: keep pulling from the HNSW index until enough
  -- RLS-visible rows are found, instead of a single top-k that the row policy can shrink
  -- below p_match_count. This is the sanctioned fix for HNSW-vs-RLS; the alternative
  -- (service role) is the leak the policies above prevent.
  set local hnsw.iterative_scan = 'relaxed_order';

  return query
  with vec as (
    select c.folder, c.path, c.chunk_ix,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from public.project_doc_chunks c
    where c.project_id = p_project_id
      and p_query_embedding is not null
      and c.embedding is not null
      and c.embedding_model = p_embedding_model
    order by c.embedding <=> p_query_embedding
    limit pool
  ),
  fts as (
    select c.folder, c.path, c.chunk_ix,
           row_number() over (order by ts_rank_cd(c.fts, q) desc) as rnk
    from public.project_doc_chunks c,
         websearch_to_tsquery('english', p_query_text) q
    where c.project_id = p_project_id
      and c.fts @@ q
    order by ts_rank_cd(c.fts, q) desc
    limit pool
  ),
  fused as (
    select coalesce(v.folder, f.folder)       as folder,
           coalesce(v.path, f.path)           as path,
           coalesce(v.chunk_ix, f.chunk_ix)   as chunk_ix,
           -- 1.0/(k+rnk) is numeric; the return column is double precision, so cast the
           -- fused score once here rather than leaking numeric out of the function.
           (coalesce(1.0 / (k + v.rnk), 0.0)
             + coalesce(1.0 / (k + f.rnk), 0.0))::double precision as score
    from vec v
    full outer join fts f
      on v.folder = f.folder and v.path = f.path and v.chunk_ix = f.chunk_ix
  )
  select c.folder, c.path, c.chunk_ix, c.heading_path,
         c.start_line, c.end_line, c.content, fu.score
  from fused fu
  join public.project_doc_chunks c
    on  c.project_id = p_project_id
    and c.folder = fu.folder
    and c.path = fu.path
    and c.chunk_ix = fu.chunk_ix
  order by fu.score desc
  limit p_match_count;
end;
$$;

revoke all on function public.match_project_doc_chunks(uuid, halfvec, text, int, text) from public, anon;
grant execute on function public.match_project_doc_chunks(uuid, halfvec, text, int, text) to authenticated;

comment on function public.match_project_doc_chunks(uuid, halfvec, text, int, text) is
  'Hybrid (vector + full-text, RRF-fused) search over one project''s documentation chunks. security invoker so RLS isolates the caller to their own projects. A null embedding degrades to full-text only (Voyage fallback).';
