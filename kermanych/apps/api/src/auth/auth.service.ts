import { Injectable, Optional } from "@nestjs/common";
import { cloudEnv, createCloudClient, getMyAgentRuntime, getMyAgentLanguage } from "@kermanych/cloud";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RegistryService, type AuthSessionRow } from "../registry/registry.service";

export type CloudClientFactory = (opts: {
  url: string;
  apiKey: string;
  accessToken?: string;
}) => SupabaseClient;

export type TokenListener = (auth: { userId: string; accessToken: string }) => void;

// Read the exp claim out of the token text. `getClaims` already VERIFIED the
// signature (locally, against the project's JWKS), so this is pure extraction
// for the fallback path. Deliberately no jose/JWKS dependency (spec D4).
function jwtExpiry(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class AuthService {
  private cached: AuthSessionRow | undefined;
  // The token the latest setToken replaced, same user only. The ui keeps presenting it
  // until its handoff of the new one answers — and this method switches `cached` well
  // before it answers (the runtime/language hydration below are cloud round trips) — so
  // refusing it would 401 the ui's own in-flight requests and sign the operator out on
  // every token refresh. Never persisted, dropped by the next rotation and by clear().
  private superseded: { userId: string; accessToken: string } | undefined;
  private client: SupabaseClient | undefined;
  private tokenListeners: TokenListener[] = [];
  private clearListeners: Array<() => void> = [];

  // The factory parameter is @Optional() so tests can construct the service
  // directly with a stub, the same way RegistryService takes ":memory:".
  constructor(
    private registry: RegistryService,
    @Optional() private makeClient: CloudClientFactory = createCloudClient,
  ) {
    // A restarted api still knows its user: no cloud round trip on boot.
    this.cached = this.registry.getAuthSession();
  }

  onToken(cb: TokenListener): void {
    this.tokenListeners.push(cb);
  }

  // Sign-out's counterpart to onToken: whatever a listener opened on the user's behalf
  // (the Slack sockets answer with their documentation) must close with the session.
  onClear(cb: () => void): void {
    this.clearListeners.push(cb);
  }

  // Validate ONCE, then cache. `getClaims` verifies the JWT locally against the
  // SDK's cached JWKS — no round trip for asymmetric-signing projects — and the
  // guard then only string-compares, so local session control never depends on
  // cloud reachability. A project still on a symmetric JWT secret makes
  // getClaims return `{ data: null, error: null }`; that is the documented
  // "cannot verify locally" signal, and we fall back to getUser().
  async setToken(accessToken: string): Promise<{ userId: string; githubUsername?: string }> {
    const { url, apiKey } = cloudEnv("api");
    const client = this.makeClient({ url, apiKey, accessToken });

    const verified = await client.auth.getClaims(accessToken);
    if (verified.error) throw new Error(verified.error.message);

    let row: AuthSessionRow;
    if (verified.data) {
      const claims = verified.data.claims as {
        sub: string;
        exp?: number;
        user_metadata?: { user_name?: string };
      };
      row = {
        userId: claims.sub,
        accessToken,
        expiresAt: typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined,
        githubUsername: claims.user_metadata?.user_name,
      };
    } else {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data.user) throw new Error(error?.message ?? "invalid access token");
      const meta = (data.user.user_metadata ?? {}) as { user_name?: string };
      row = {
        userId: data.user.id,
        accessToken,
        expiresAt: jwtExpiry(accessToken),
        githubUsername: meta.user_name,
      };
    }

    this.registry.setAuthSession(row);
    const prior = this.cached;
    // Re-presenting the cached token (a retried handoff) is no rotation: keep what it replaced.
    if (prior?.accessToken !== accessToken) {
      this.superseded =
        prior && prior.userId === row.userId ? { userId: prior.userId, accessToken: prior.accessToken } : undefined;
    }
    this.cached = row;
    this.client = client;
    // Fired last, so a listener that immediately drains the outbox already sees
    // the persisted row and a working cloudClient().
    for (const cb of this.tokenListeners) cb({ userId: row.userId, accessToken });

    // Bring the user's cloud runtime preference into the local cache so the first launch
    // on a new machine respects it without a network read on the hot path. Best-effort:
    // a failure leaves the cache as-is (runtimeFor falls back to omp), never blocks sign-in.
    try {
      const runtime = await getMyAgentRuntime(this.cloudClient());
      if (runtime) {
        const cur = this.registry.getAuthSession();
        if (cur) this.registry.setAuthSession({ ...cur, agentRuntime: runtime });
      }
    } catch { /* offline or profile unreadable — cache stays, omp default applies */ }

    // Same best-effort hydration for the communication language, so the first launch on a new
    // machine speaks the chosen language without a network read on the hot path.
    try {
      const language = await getMyAgentLanguage(this.cloudClient());
      if (language) {
        const cur = this.registry.getAuthSession();
        if (cur) this.registry.setAuthSession({ ...cur, agentLanguage: language });
      }
    } catch { /* offline or profile unreadable — cache stays, no directive is injected */ }

    return { userId: row.userId, githubUsername: row.githubUsername };
  }

  clear(): void {
    this.registry.clearAuthSession();
    this.cached = undefined;
    this.superseded = undefined;
    this.client = undefined;
    // Fired last, so a listener already sees the signed-out state (current() undefined).
    for (const cb of this.clearListeners) cb();
  }

  current(): AuthSessionRow | undefined {
    return this.cached;
  }

  // The one rule every local entry point applies to a presented bearer — the REST guard
  // and the terminal socket handshake: ONLY the cached token (or the one it just
  // replaced, see `superseded`) is accepted, expiry included. Returns the signed-in
  // user's id, or undefined for anything else.
  userForToken(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const cur = this.cached;
    if (cur && cur.accessToken === token) return cur.userId;
    const old = this.superseded;
    return old && old.accessToken === token ? old.userId : undefined;
  }

  // A Supabase client pinned to the user's JWT. RLS is the authorization surface;
  // there is no service-role key on this machine.
  cloudClient(): SupabaseClient {
    const cur = this.cached;
    if (!cur) throw new Error("not signed in");
    if (!this.client) {
      const { url, apiKey } = cloudEnv("api");
      this.client = this.makeClient({ url, apiKey, accessToken: cur.accessToken });
    }
    return this.client;
  }
}
