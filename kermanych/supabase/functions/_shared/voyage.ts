// Voyage embeddings, shared by the Edge Functions that search documentation: docs-rag
// (search and index, under the caller's JWT) and slack-events (search for a cloud answer).
// One product-wide key in the functions' own secrets (VOYAGE_API_KEY, see ../.env.example).

// The product-wide embedding model. Stored on every chunk row (embedding_model) and passed
// to the search RPC so vectors from two models are never compared. Changing it requires a
// full reindex.
export const VOYAGE_MODEL = "voyage-4-lite";
const VOYAGE_DIM = 1024;
// Voyage accepts many inputs per request; keep each request modest so one large file cannot
// exceed the per-request input ceiling.
const EMBED_BATCH = 96;

// pgvector accepts a text literal "[a,b,c]" and casts it to halfvec; that is how the vector
// crosses the PostgREST/JSON boundary as an RPC arg and an insert value.
export function halfvecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// Embed a list of texts with Voyage, batched. Returns null when no key is configured, which
// is the deliberate "Voyage unavailable" signal the search path degrades on. THROWS on an
// actual API error so the index path fails loudly (a half-embedded index is worse than none).
export async function embed(texts: string[], inputType: "query" | "document"): Promise<number[][] | null> {
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

// A search query's vector, or null when Voyage is unavailable (no key, or an API error):
// the search then degrades to full-text rather than failing.
export async function embedQuery(query: string): Promise<number[] | null> {
  try {
    return (await embed([query], "query"))?.[0] ?? null;
  } catch {
    return null;
  }
}
