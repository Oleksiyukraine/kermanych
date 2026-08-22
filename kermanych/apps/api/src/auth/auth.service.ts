import { Injectable, Optional } from "@nestjs/common";
import { cloudEnv, createCloudClient } from "@kermanych/cloud";
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
  private client: SupabaseClient | undefined;
  private tokenListeners: TokenListener[] = [];

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
    this.cached = row;
    this.client = client;
    // Fired last, so a listener that immediately drains the outbox already sees
    // the persisted row and a working cloudClient().
    for (const cb of this.tokenListeners) cb({ userId: row.userId, accessToken });
    return { userId: row.userId, githubUsername: row.githubUsername };
  }

  clear(): void {
    this.registry.clearAuthSession();
    this.cached = undefined;
    this.client = undefined;
  }

  current(): AuthSessionRow | undefined {
    return this.cached;
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
