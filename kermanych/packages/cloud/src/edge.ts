// Calling an Edge Function from either side — the browser with its session, the api with the
// operator's JWT. Shared by docs-rag (doc-rag.ts) and routines-runner (routines.ts).
import type { SupabaseClient } from "@supabase/supabase-js";

// supabase-js functions.invoke resolves { data, error }; a non-2xx becomes a
// FunctionsHttpError whose `context` is the Response. Both functions put their message on
// `{ error }`, so dig it out — otherwise every failure reads "Edge Function
// returned a non-2xx status code" with no cause.
export async function invokeEdge<T>(client: SupabaseClient, fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.functions.invoke(fn, { body });
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
