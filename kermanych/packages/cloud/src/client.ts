// The only place @supabase/supabase-js is constructed. Two callers, two modes:
//   • ui  — no accessToken: PKCE + persisted session + detectSessionInUrl, so the
//           SDK owns sign-in and refresh.
//   • api — accessToken: a headless client pinned to the user's JWT, no session
//           storage, no refresh. supabase-js only fills Authorization when the
//           request does not already carry it, so this header wins.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

export type CloudEnv = { url: string; anonKey: string };

export type CloudClientOptions = { url: string; anonKey: string; accessToken?: string };

// Vite only inlines VITE_-prefixed variables, and it inlines them into
// import.meta.env — which a CommonJS package cannot read. So the ui passes its
// bag in explicitly (`cloudEnv('ui', import.meta.env)`) while the api falls back
// to process.env.
const KEYS = {
  api: { url: "SUPABASE_URL", anonKey: "SUPABASE_ANON_KEY" },
  ui: { url: "VITE_SUPABASE_URL", anonKey: "VITE_SUPABASE_ANON_KEY" },
} as const;

export function cloudEnv(
  source: "api" | "ui",
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): CloudEnv {
  const keys = KEYS[source];
  const url = env[keys.url];
  const anonKey = env[keys.anonKey];
  if (!url || !anonKey) {
    throw new Error(`cloud env missing: set ${keys.url} and ${keys.anonKey}`);
  }
  return { url, anonKey };
}

export function createCloudClient({ url, anonKey, accessToken }: CloudClientOptions): SupabaseClient {
  const headless = accessToken !== undefined;
  return createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: !headless,
      persistSession: !headless,
      autoRefreshToken: !headless,
    },
    global: headless ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}
