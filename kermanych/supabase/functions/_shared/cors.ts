// Shared CORS headers for the RAG Edge Function. The browser invokes docs-rag directly
// (the only functions.invoke in the product), so the preflight and the actual response both
// need these. `apikey` and `authorization` are the headers supabase-js sends; `x-client-info`
// is its own version tag.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
