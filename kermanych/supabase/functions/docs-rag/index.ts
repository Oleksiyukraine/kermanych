// docs-rag — the one Edge Function behind documentation RAG. Two actions:
//
//   • search — embed the question (Voyage input_type "query") and run the hybrid
//              vector+full-text search. If Voyage is unreachable it searches full-text only
//              and reports status "fulltext" rather than failing. Called by the BROWSER.
//   • index  — embed each chunk (Voyage input_type "document") and write the rows plus the
//              per-file index state. Called by the local API.
//
// SECURITY MODEL (do not weaken):
//   - Runs under the CALLER's JWT, never the service role. The service role bypasses RLS
//     entirely; here it is never used, so Postgres — not a WHERE clause someone might forget
//     — enforces workspace isolation. The Voyage key lives in this function's own secrets,
//     so the function needs no elevated rights for anything.
//   - It sees both query text and chunk content, so it LOGS NEITHER. Logging them would pool
//     every workspace's documents in one place outside the schema that protects them. Only
//     identifiers, counts and latency are logged.
//
// This is the first Edge Function in the repo; its secrets come from supabase/functions/.env
// locally (see .env.example), NOT from `supabase secrets set`.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/cors.ts";

// The product-wide embedding model. Stored on every chunk row (embedding_model) and passed
// to the search RPC so vectors from two models are never compared. Changing it requires a
// full reindex.
const VOYAGE_MODEL = "voyage-4-lite";
const VOYAGE_DIM = 1024;
// Voyage accepts many inputs per request; keep each request modest so one large file cannot
// exceed the per-request input ceiling.
const EMBED_BATCH = 96;
// A hard cap on how many chunks one search returns to the turn.
const DEFAULT_MATCH_COUNT = 12;

type ChunkInput = {
  chunkIx: number;
  headingPath: string;
  startLine: number;
  endLine: number;
  content: string;
};

// pgvector accepts a text literal "[a,b,c]" and casts it to halfvec; that is how the vector
// crosses the PostgREST/JSON boundary as an RPC arg and an insert value.
function halfvecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// Embed a list of texts with Voyage, batched. Returns null when no key is configured, which
// is the deliberate "Voyage unavailable" signal the search path degrades on. THROWS on an
// actual API error so the index path fails loudly (a half-embedded index is worse than none).
async function embed(texts: string[], inputType: "query" | "document"): Promise<number[][] | null> {
  const key = Deno.env.get("VOYAGE_API_KEY");
  if (!key) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: batch, model: VOYAGE_MODEL, input_type: inputType, output_dimension: VOYAGE_DIM }),
    });
    if (!res.ok) throw new Error(`voyage embeddings failed: ${res.status}`);
    const j: unknown = await res.json();
    if (!j || typeof j !== "object" || !("data" in j) || !Array.isArray(j.data)) {
      throw new Error("voyage embeddings: unexpected response shape");
    }
    for (const d of j.data) {
      if (d && typeof d === "object" && "embedding" in d && Array.isArray(d.embedding)) {
        out.push(d.embedding as number[]);
      } else {
        throw new Error("voyage embeddings: missing embedding in response");
      }
    }
  }
  return out;
}

type SearchRow = {
  folder: string;
  path: string;
  chunk_ix: number;
  heading_path: string;
  start_line: number;
  end_line: number;
  content: string;
};

async function handleSearch(client: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const projectId = body.projectId;
  const query = body.query;
  if (typeof projectId !== "string" || typeof query !== "string" || query.trim() === "") {
    return jsonResponse(400, { error: "search requires projectId and a non-empty query" });
  }
  const matchCount = typeof body.matchCount === "number" ? body.matchCount : DEFAULT_MATCH_COUNT;

  // Embed the question. A null result (no key) or a thrown Voyage error both degrade to
  // full-text — the feature's real fallback — rather than failing the turn.
  let embedding: number[] | null = null;
  let status: "ok" | "fulltext" = "fulltext";
  try {
    const vecs = await embed([query], "query");
    if (vecs && vecs[0]) {
      embedding = vecs[0];
      status = "ok";
    }
  } catch {
    embedding = null;
    status = "fulltext";
  }

  const { data, error } = await client.rpc("match_project_doc_chunks", {
    p_project_id: projectId,
    p_query_embedding: embedding ? halfvecLiteral(embedding) : null,
    p_query_text: query,
    p_match_count: matchCount,
    p_embedding_model: VOYAGE_MODEL,
  });
  if (error) return jsonResponse(400, { error: error.message });

  const rows = (data ?? []) as SearchRow[];
  const fragments = rows.map((r) => ({
    folder: r.folder,
    path: r.path,
    headingPath: r.heading_path,
    startLine: r.start_line,
    endLine: r.end_line,
    content: r.content,
  }));
  // Identifiers and counts only — never the query text or the returned content.
  console.log(JSON.stringify({ action: "search", projectId, status, matchCount, hits: fragments.length }));
  return jsonResponse(200, { status, embeddingModel: VOYAGE_MODEL, fragments });
}

type IndexUpsert = { folder: string; path: string; fileHash: string; chunks: ChunkInput[] };
type IndexDelete = { folder: string; path: string };

async function handleIndex(client: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const projectId = body.projectId;
  if (typeof projectId !== "string") return jsonResponse(400, { error: "index requires projectId" });
  const upserts = Array.isArray(body.upserts) ? (body.upserts as IndexUpsert[]) : [];
  const deletes = Array.isArray(body.deletes) ? (body.deletes as IndexDelete[]) : [];

  // indexed_by is the caller. getUser reads the JWT the client is pinned to.
  const who = await client.auth.getUser();
  const userId = who.data.user?.id ?? null;

  let deletedFiles = 0;
  for (const d of deletes) {
    const dc = await client.from("project_doc_chunks").delete().eq("project_id", projectId).eq("folder", d.folder).eq("path", d.path);
    if (dc.error) return jsonResponse(400, { error: dc.error.message });
    const ds = await client.from("project_doc_index_state").delete().eq("project_id", projectId).eq("folder", d.folder).eq("path", d.path);
    if (ds.error) return jsonResponse(400, { error: ds.error.message });
    deletedFiles++;
  }

  let indexedFiles = 0;
  let chunkCount = 0;
  for (const u of upserts) {
    const texts = u.chunks.map((c) => c.content);
    let embeddings: number[][] | null = null;
    if (texts.length > 0) {
      embeddings = await embed(texts, "document");
      // Indexing MUST embed — there is no full-text-only index. No key / Voyage down here is
      // a hard failure so the caller retries rather than storing vectorless rows.
      if (!embeddings) return jsonResponse(503, { error: "voyage_unavailable" });
    }

    // Replace the file's chunks atomically enough for a re-index: delete then insert. The
    // natural PK (project_id, folder, path, chunk_ix) makes this dedup within the project.
    const del = await client.from("project_doc_chunks").delete().eq("project_id", projectId).eq("folder", u.folder).eq("path", u.path);
    if (del.error) return jsonResponse(400, { error: del.error.message });

    const rows = u.chunks.map((c, i) => ({
      project_id: projectId,
      folder: u.folder,
      path: u.path,
      chunk_ix: c.chunkIx,
      heading_path: c.headingPath,
      start_line: c.startLine,
      end_line: c.endLine,
      content: c.content,
      embedding: embeddings ? halfvecLiteral(embeddings[i]!) : null,
      embedding_model: VOYAGE_MODEL,
    }));
    if (rows.length > 0) {
      const ins = await client.from("project_doc_chunks").insert(rows);
      if (ins.error) return jsonResponse(400, { error: ins.error.message });
    }

    const st = await client.from("project_doc_index_state").upsert(
      {
        project_id: projectId,
        folder: u.folder,
        path: u.path,
        file_hash: u.fileHash,
        chunk_count: u.chunks.length,
        indexed_at: new Date().toISOString(),
        indexed_by: userId,
      },
      { onConflict: "project_id,folder,path" },
    );
    if (st.error) return jsonResponse(400, { error: st.error.message });

    indexedFiles++;
    chunkCount += u.chunks.length;
  }

  console.log(JSON.stringify({ action: "index", projectId, indexedFiles, deletedFiles, chunkCount }));
  return jsonResponse(200, { indexedFiles, deletedFiles, chunkCount, embeddingModel: VOYAGE_MODEL });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { error: "method not allowed" });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse(401, { error: "missing authorization" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!supabaseUrl || !anonKey) return jsonResponse(500, { error: "function not configured" });

  // The caller-scoped client: the public key satisfies the apikey slot, the caller's JWT
  // rides in Authorization and wins. Every table read/write and the RPC below run under this
  // user's RLS.
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object") throw new Error("body must be an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  try {
    if (body.action === "search") return await handleSearch(client, body);
    if (body.action === "index") return await handleIndex(client, body);
    return jsonResponse(400, { error: "unknown action" });
  } catch (e) {
    // Never echo content in an error. A message string is fine; the body is not.
    const msg = e instanceof Error ? e.message : "internal error";
    return jsonResponse(500, { error: msg });
  }
});
