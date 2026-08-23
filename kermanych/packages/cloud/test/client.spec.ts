import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CLOUD, cloudEnv, createCloudClient } from "../src/client";

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

// Zero-config is the point: a fresh clone has no .env and no exports, and both
// consumers still land on the team's hosted project.
test("an empty environment resolves to the built-in team project", () => {
  expect(cloudEnv("api", {})).toEqual(DEFAULT_CLOUD);
  expect(cloudEnv("ui", {})).toEqual(DEFAULT_CLOUD);
});

test("a full pair overrides the built-in default", () => {
  const env = { SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE };
  expect(cloudEnv("api", env)).toEqual({ url: URL, apiKey: PUBLISHABLE });
  expect(cloudEnv("api", env)).not.toEqual(DEFAULT_CLOUD);
});

// The returned object must never be the shared constant: a caller that mutates
// its own env would poison every later resolution.
test("the default is copied, not handed out", () => {
  const resolved = cloudEnv("api", {});
  expect(resolved).not.toBe(DEFAULT_CLOUD);
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

// Half an override is a wrong backend, not a fallback, so it fails loudly and
// says both how to complete it and how to go back to the default.
test("a URL without a key throws and names the key", () => {
  expect(() => cloudEnv("api", { SUPABASE_URL: URL })).toThrow(
    "cloud env missing: set SUPABASE_PUBLISHABLE_KEY (or the legacy SUPABASE_ANON_KEY) too, or unset SUPABASE_URL to use the built-in default",
  );
  expect(() => cloudEnv("ui", { VITE_SUPABASE_URL: URL })).toThrow(
    "cloud env missing: set VITE_SUPABASE_PUBLISHABLE_KEY (or the legacy VITE_SUPABASE_ANON_KEY) too, or unset VITE_SUPABASE_URL to use the built-in default",
  );
});

test("a key without a URL throws and names the URL, and the key name it saw", () => {
  expect(() => cloudEnv("api", { SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE })).toThrow(
    "cloud env missing: set SUPABASE_URL too, or unset SUPABASE_PUBLISHABLE_KEY to use the built-in default",
  );
  // The legacy spelling is just as much "the key is set" — and the message has
  // to name the variable actually present, or unsetting it would miss.
  expect(() => cloudEnv("api", { SUPABASE_ANON_KEY: "legacy-anon" })).toThrow(
    "cloud env missing: set SUPABASE_URL too, or unset SUPABASE_ANON_KEY to use the built-in default",
  );
  expect(() => cloudEnv("ui", { VITE_SUPABASE_ANON_KEY: "legacy-anon" })).toThrow(
    "cloud env missing: set VITE_SUPABASE_URL too, or unset VITE_SUPABASE_ANON_KEY to use the built-in default",
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

// The default is only useful if it survives the whole path: resolution →
// client → request. Same late-bound fetch stub, so still no socket.
test("the built-in default reaches the constructed client", async () => {
  const client = createCloudClient(cloudEnv("ui", {}));
  const real = globalThis.fetch;
  let seen: { url: string; apikey: string | null } | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), apikey: new Headers(init?.headers).get("apikey") };
    return Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  try {
    await client.from("tasks").select("id");
  } finally {
    globalThis.fetch = real;
  }
  expect(seen?.url.startsWith(`${DEFAULT_CLOUD.url}/rest/v1/tasks`)).toBe(true);
  expect(seen?.apikey).toBe(DEFAULT_CLOUD.apiKey);
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
