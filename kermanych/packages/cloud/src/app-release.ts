// The cloud's release policy: the oldest app version it still serves
// (supabase/migrations/20261012120000_app_release_policy.sql). Readable with the anon key.
import type { SupabaseClient } from "@supabase/supabase-js";

// null when the policy cannot be read (offline, no row, a table older than this build): the
// caller then blocks nothing.
export async function getMinAppVersion(client: SupabaseClient): Promise<string | null> {
  const { data, error } = await client.from("app_release_policy").select("min_app_version").maybeSingle();
  if (error || !data || typeof data !== "object" || !("min_app_version" in data)) return null;
  return typeof data.min_app_version === "string" ? data.min_app_version : null;
}
