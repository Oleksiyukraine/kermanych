// The only place @supabase/supabase-js is constructed. Two callers, two modes:
//   • ui  — no accessToken: PKCE + persisted session + detectSessionInUrl, so the
//           SDK owns sign-in and refresh.
//   • api — accessToken: a headless client pinned to the user's JWT, no session
//           storage, no refresh. supabase-js only fills Authorization when the
//           request does not already carry it, so this header wins.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

export type CloudEnv = { url: string; apiKey: string };

export type CloudClientOptions = { url: string; apiKey: string; accessToken?: string };

// Vite only inlines VITE_-prefixed variables, and it inlines them into
// import.meta.env — which a CommonJS package cannot read. So the ui passes its
// bag in explicitly (`cloudEnv('ui', import.meta.env)`) while the api falls back
// to process.env.
//
// Two spellings per source, newest first. Supabase replaced the legacy `anon`
// JWT with a publishable key (`sb_publishable_…`): same public role — RLS is
// still the authorization surface — but a modern dashboard shows only the new
// name, while a local CLI stack still hands out the legacy `anon` JWT too.
// supabase-js takes either, because the key's only fixed home is the `apikey`
// header; the Authorization slot belongs to the user's JWT (pinned below for the
// api, taken from the session for the ui). So the key's format never matters
// here — both names are read, and the new one wins.
const KEYS = {
  api: { url: "SUPABASE_URL", apiKeys: ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"] },
  ui: {
    url: "VITE_SUPABASE_URL",
    apiKeys: ["VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_ANON_KEY"],
  },
} as const;

export function cloudEnv(
  source: "api" | "ui",
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): CloudEnv {
  const keys = KEYS[source];
  const url = env[keys.url];
  const [preferred, legacy] = keys.apiKeys;
  const apiKey = env[preferred] || env[legacy];
  if (!url || !apiKey) {
    throw new Error(`cloud env missing: set ${keys.url} and ${preferred} (or the legacy ${legacy})`);
  }
  return { url, apiKey };
}

export function createCloudClient({ url, apiKey, accessToken }: CloudClientOptions): SupabaseClient {
  const headless = accessToken !== undefined;
  return createClient(url, apiKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: !headless,
      persistSession: !headless,
      autoRefreshToken: !headless,
    },
    global: headless ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}
