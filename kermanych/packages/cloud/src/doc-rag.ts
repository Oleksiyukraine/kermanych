// Data access for the documentation RAG index. Two tables (project_doc_chunks,
// project_doc_index_state) and one Edge Function (docs-rag). Every call runs under the
// CALLER's JWT — the api passes the operator's token, the browser its session — so the RLS
// policies (read AND write = project member) are the only authorization surface. There is
// no service-role path here on purpose: the Edge Function needs no elevated rights because
// its Voyage key lives in its own secrets, so Postgres, not a forgotten WHERE clause,
// enforces workspace isolation.
//
// Chunk text and embeddings are the parts that make search work for a teammate without a
// local checkout; they are stored, but only ever behind is_project_member(). Nothing here
// denormalises workspace_id, so a project that moves between workspaces takes its
// visibility with it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocChunk, ManagementDocFragment } from "@kermanych/core";

// The one Edge Function. `action` discriminates search from index inside it, so the browser
// (search) and the api (index) share a single deployed function and a single caller-JWT
// authorization path.
const EDGE_FUNCTION = "docs-rag";

// ── Index state (per indexed file) ──────────────────────────────────────────────

// One indexed file. `fileHash` is what the api diffs against to re-embed only what changed;
// the rest is what the tab shows ("indexed N files, last at …").
export type DocIndexFile = {
  folder: string;
  path: string;
  fileHash: string;
  chunkCount: number;
  indexedAt: string;
};

// The whole index for one project, plus the aggregates the tab renders. `lastIndexedAt` is
// null exactly when the project has never been indexed — which the assistant must be told
// so it says so plainly instead of grepping.
export type DocIndexState = {
  files: DocIndexFile[];
  fileCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
};

type IndexStateRow = {
  folder: string;
  path: string;
  file_hash: string;
  chunk_count: number;
  indexed_at: string;
};

// The full per-file index state for a project. The api uses `files` to diff hashes; the ui
// uses the aggregates. RLS returns rows only for a project the caller is a member of, so an
// outsider gets an empty (never-indexed-looking) state — which is correct: to them it is.
export async function getDocIndexState(client: SupabaseClient, projectId: string): Promise<DocIndexState> {
  const { data, error } = await client
    .from("project_doc_index_state")
    .select("folder, path, file_hash, chunk_count, indexed_at")
    .eq("project_id", projectId)
    .order("path", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as IndexStateRow[];
  const files: DocIndexFile[] = rows.map((r) => ({
    folder: r.folder,
    path: r.path,
    fileHash: r.file_hash,
    chunkCount: r.chunk_count,
    indexedAt: r.indexed_at,
  }));
  let lastIndexedAt: string | null = null;
  let chunkCount = 0;
  for (const f of files) {
    chunkCount += f.chunkCount;
    if (lastIndexedAt === null || f.indexedAt > lastIndexedAt) lastIndexedAt = f.indexedAt;
  }
  return { files, fileCount: files.length, chunkCount, lastIndexedAt };
}

// ── Search (browser -> Edge Function, one round trip) ────────────────────────────

// "ok" — the hybrid vector+full-text search ran. "fulltext" — Voyage was unreachable, so
// the query was not embedded and search degraded to full-text only; the answer must say so.
export type DocSearchStatus = "ok" | "fulltext";

export type DocSearchResult = {
  status: DocSearchStatus;
  // The model the CHUNKS were embedded with, echoed back so the caller can surface a model
  // mismatch. Absent on the full-text path.
  embeddingModel?: string;
  fragments: ManagementDocFragment[];
};

// Embed the question and search, in ONE Edge Function round trip. The function embeds with
// Voyage input_type "query" and calls match_project_doc_chunks under the caller's JWT; if
// Voyage is down it searches full-text and returns status "fulltext" rather than failing.
export async function searchProjectDocs(
  client: SupabaseClient,
  input: { projectId: string; query: string; matchCount?: number },
): Promise<DocSearchResult> {
  return invokeEdge<DocSearchResult>(client, {
    action: "search",
    projectId: input.projectId,
    query: input.query,
    ...(input.matchCount === undefined ? {} : { matchCount: input.matchCount }),
  });
}

// ── Index (api -> Edge Function) ─────────────────────────────────────────────────

// One changed file: its new hash and its chunks. The api chunks locally (so the chunker is
// unit-tested in @kermanych/core); the Edge Function embeds each chunk with Voyage
// input_type "document" and writes the rows.
export type DocIndexUpsert = {
  folder: string;
  path: string;
  fileHash: string;
  chunks: DocChunk[];
};

// A file that was indexed before and is now gone from the checkout: its chunks and its
// state row are removed.
export type DocIndexDelete = { folder: string; path: string };

export type DocIndexRequest = {
  projectId: string;
  upserts: DocIndexUpsert[];
  deletes: DocIndexDelete[];
};

export type DocIndexResult = {
  indexedFiles: number;
  deletedFiles: number;
  chunkCount: number;
  embeddingModel: string;
};

// Send changed files to the Edge Function to be embedded and written. Runs under the
// caller's JWT (the api passes the operator's token), so a member who cannot write the
// project's chunks is refused by RLS, not by this code.
export async function indexProjectDocs(client: SupabaseClient, req: DocIndexRequest): Promise<DocIndexResult> {
  return invokeEdge<DocIndexResult>(client, { action: "index", ...req });
}

// supabase-js functions.invoke resolves { data, error }; a non-2xx becomes a
// FunctionsHttpError whose `context` is the Response. The function bodies below put their
// message on `{ error }`, so dig it out — otherwise every failure reads "Edge Function
// returned a non-2xx status code" with no cause.
async function invokeEdge<T>(client: SupabaseClient, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.functions.invoke(EDGE_FUNCTION, { body });
  if (error) {
    let detail = error.message;
    const ctx = "context" in error ? error.context : undefined;
    if (ctx instanceof Response) {
      try {
        const j: unknown = await ctx.clone().json();
        if (j && typeof j === "object" && "error" in j && typeof j.error === "string") detail = j.error;
      } catch {
        // non-JSON body — keep the generic message
      }
    }
    throw new Error(detail);
  }
  return data as T;
}
