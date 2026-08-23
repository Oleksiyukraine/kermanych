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

// The team's hosted project, committed on purpose. Both values are PUBLIC: the
// publishable key is compiled into the browser bundle every time the ui is
// built, so it is already handed to anyone who opens the app — a public
// repository changes nothing about its exposure. What protects the project is
// RLS plus the sign-in allowlist, and both were verified against this very
// project: an anonymous read of any of the five tables is refused with
// `42501 permission denied`, and a GitHub account outside
// `public.allowed_github_users` is refused at sign-up with `P0001 github user …
// is not on the Kermanych team allowlist`. The dashboard's secret key
// (`sb_secret_…`) is the only value that would matter, and it lives nowhere in
// this repo or on any machine running Kermanych.
//
// So the variables below are not credentials to be provisioned; they exist only
// to POINT Kermanych somewhere else — a local Supabase stack or your own fork.
export const DEFAULT_CLOUD = {
  url: "https://uqqdudlfizfwqfegfrlh.supabase.co",
  apiKey: "sb_publishable_mBwB2TdiWeVvt6C9ry6C9A_Q9n0pX8X",
} as const;

export function cloudEnv(
  source: "api" | "ui",
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): CloudEnv {
  const keys = KEYS[source];
  const url = env[keys.url];
  const [preferred, legacy] = keys.apiKeys;
  const apiKey = env[preferred] || env[legacy];
  if (!url && !apiKey) return { ...DEFAULT_CLOUD };
  // Half an override is a mistake, never a fallback: pairing a custom URL with
  // the team's key (or the reverse) points at a backend that cannot answer, and
  // the failure would surface much later as an unexplained 401 or 42501.
  if (!url) {
    throw new Error(
      `cloud env missing: set ${keys.url} too, or unset ${env[preferred] ? preferred : legacy} to use the built-in default`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `cloud env missing: set ${preferred} (or the legacy ${legacy}) too, or unset ${keys.url} to use the built-in default`,
    );
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
