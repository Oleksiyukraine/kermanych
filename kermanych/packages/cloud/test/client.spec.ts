import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cloudEnv, createCloudClient } from "../src/client";

// The URL is a literal fixture only: constructing a client opens no socket.
const URL = "http://127.0.0.1:54421";

// supabase-js keeps the resolved global headers, the auth flags and the API key
// as protected fields, so there is no public way to observe what
// createCloudClient configured.
type ClientInternals = {
  headers: Record<string, string | undefined>;
  supabaseKey: string;
  auth: { persistSession: boolean; autoRefreshToken: boolean; detectSessionInUrl: boolean };
};

function internals(client: SupabaseClient): ClientInternals {
  return client as unknown as ClientInternals;
}

// A new-format key is not a JWT; only its `sb_publishable_` prefix is meaningful
// to the SDK, so a shaped literal is a faithful fixture.
const PUBLISHABLE = "sb_publishable_TEST0000000000000000000000";

test("cloudEnv('api') reads the publishable pair", () => {
  const env = { SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE };
  expect(cloudEnv("api", env)).toEqual({ url: URL, apiKey: PUBLISHABLE });
});

test("cloudEnv('api') still reads the legacy anon pair", () => {
  const env = { SUPABASE_URL: URL, SUPABASE_ANON_KEY: "anon-api" };
  expect(cloudEnv("api", env)).toEqual({ url: URL, apiKey: "anon-api" });
});

test("cloudEnv('ui') reads the VITE_ pair and ignores the api pair", () => {
  const env = {
    SUPABASE_URL: "http://wrong",
    SUPABASE_ANON_KEY: "wrong",
    VITE_SUPABASE_URL: URL,
    VITE_SUPABASE_ANON_KEY: "anon-ui",
  };
  expect(cloudEnv("ui", env)).toEqual({ url: URL, apiKey: "anon-ui" });
});

test("cloudEnv('ui') reads the publishable VITE_ name too", () => {
  const env = { VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE };
  expect(cloudEnv("ui", env)).toEqual({ url: URL, apiKey: PUBLISHABLE });
});

// A machine that carries both — a leftover local anon key next to a hosted
// publishable one — must use the new key, never the stale legacy value.
test("the publishable name wins when both spellings are set", () => {
  const api = {
    SUPABASE_URL: URL,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    SUPABASE_ANON_KEY: "legacy-anon",
  };
  expect(cloudEnv("api", api).apiKey).toBe(PUBLISHABLE);
  const ui = {
    VITE_SUPABASE_URL: URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    VITE_SUPABASE_ANON_KEY: "legacy-anon",
  };
  expect(cloudEnv("ui", ui).apiKey).toBe(PUBLISHABLE);
});

test("cloudEnv names both accepted spellings of the missing key", () => {
  expect(() => cloudEnv("ui", {})).toThrow(
    "set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or the legacy VITE_SUPABASE_ANON_KEY)",
  );
  expect(() => cloudEnv("api", { SUPABASE_URL: "http://x" })).toThrow(
    "set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or the legacy SUPABASE_ANON_KEY)",
  );
});

test("the resolved key is the key the client sends", async () => {
  const env = {
    SUPABASE_URL: URL,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    SUPABASE_ANON_KEY: "legacy-anon",
  };
  const client = createCloudClient({ ...cloudEnv("api", env), accessToken: "user-jwt" });
  expect(internals(client).supabaseKey).toBe(PUBLISHABLE);

  // Prove it on the wire, not just in a field: supabase-js resolves fetch late,
  // so a stub installed now sees exactly the headers PostgREST would receive. No
  // socket is opened.
  const real = globalThis.fetch;
  let sent: Headers | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    sent = new Headers(init?.headers);
    return Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  try {
    await client.from("tasks").select("id");
  } finally {
    globalThis.fetch = real;
  }
  // The publishable key travels as `apikey`; Authorization stays the user's JWT,
  // so a non-JWT key is never presented as a session token.
  expect(sent?.get("apikey")).toBe(PUBLISHABLE);
  expect(sent?.get("Authorization")).toBe("Bearer user-jwt");
});

test("createCloudClient with an accessToken pins Authorization and stores no session", () => {
  const client = internals(createCloudClient({ url: URL, apiKey: "anon", accessToken: "user-jwt" }));
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
  const client = internals(createCloudClient({ url: URL, apiKey: "anon" }));
  expect(client.headers.Authorization).toBeUndefined();
  expect([client.auth.persistSession, client.auth.autoRefreshToken, client.auth.detectSessionInUrl]).toEqual([
    true,
    true,
    true,
  ]);
});
