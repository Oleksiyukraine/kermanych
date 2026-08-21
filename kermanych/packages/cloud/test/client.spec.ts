import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cloudEnv, createCloudClient } from "../src/client";

// The URL is a literal fixture only: constructing a client opens no socket.
const URL = "http://127.0.0.1:54421";

// supabase-js keeps the resolved global headers and the auth flags as protected
// fields, so there is no public way to observe what createCloudClient configured.
type ClientInternals = {
  headers: Record<string, string | undefined>;
  auth: { persistSession: boolean; autoRefreshToken: boolean; detectSessionInUrl: boolean };
};

function internals(client: SupabaseClient): ClientInternals {
  return client as unknown as ClientInternals;
}

test("cloudEnv('api') reads the unprefixed pair", () => {
  const env = { SUPABASE_URL: URL, SUPABASE_ANON_KEY: "anon-api" };
  expect(cloudEnv("api", env)).toEqual({ url: URL, anonKey: "anon-api" });
});

test("cloudEnv('ui') reads the VITE_ pair and ignores the api pair", () => {
  const env = {
    SUPABASE_URL: "http://wrong",
    SUPABASE_ANON_KEY: "wrong",
    VITE_SUPABASE_URL: URL,
    VITE_SUPABASE_ANON_KEY: "anon-ui",
  };
  expect(cloudEnv("ui", env)).toEqual({ url: URL, anonKey: "anon-ui" });
});

test("cloudEnv names the missing variables it wants", () => {
  expect(() => cloudEnv("ui", {})).toThrow("set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
  expect(() => cloudEnv("api", { SUPABASE_URL: "http://x" })).toThrow(
    "set SUPABASE_URL and SUPABASE_ANON_KEY",
  );
});

test("createCloudClient with an accessToken pins Authorization and stores no session", () => {
  const client = internals(createCloudClient({ url: URL, anonKey: "anon", accessToken: "user-jwt" }));
  // The header is what makes every PostgREST call run under the user's JWT (and
  // therefore under RLS) with no session and no service-role key anywhere.
  expect(client.headers.Authorization).toBe("Bearer user-jwt");
  expect([client.auth.persistSession, client.auth.autoRefreshToken, client.auth.detectSessionInUrl]).toEqual([
    false,
    false,
    false,
  ]);
});

test("createCloudClient without an accessToken leaves Authorization to the session", () => {
  const client = internals(createCloudClient({ url: URL, anonKey: "anon" }));
  expect(client.headers.Authorization).toBeUndefined();
  expect([client.auth.persistSession, client.auth.autoRefreshToken, client.auth.detectSessionInUrl]).toEqual([
    true,
    true,
    true,
  ]);
});
