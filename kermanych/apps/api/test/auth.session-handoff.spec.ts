import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RegistryService } from "../src/registry/registry.service";
import { AuthService, type CloudClientFactory } from "../src/auth/auth.service";
import { SupabaseAuthGuard } from "../src/auth/auth.guard";
import { AuthController } from "../src/auth/auth.controller";
import { DEV_UI_ORIGINS, setUiProof, uiProofFor, UI_KEY_HEADER } from "../src/auth/ui-proof";

// POST /api/auth/session is the api's one @Public() route, and the api answers CORS `*`.
// Every token below verifies (the stub stands in for the project's JWKS): what decides is
// only whether the request proves it comes from the app's own ui.

process.env.SUPABASE_URL = "http://127.0.0.1:54421";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

// esbuild (vitest's transformer) emits no design:paramtypes.
Reflect.defineMetadata("design:paramtypes", [AuthService], AuthController);

function jwt(sub: string, ttl: number): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "ES256", typ: "JWT" })}.${seg({ sub, exp: Math.floor(Date.now() / 1000) + ttl })}.sig`;
}

const OPERATOR = jwt("u-operator", 3600);
const OPERATOR_ROTATED = jwt("u-operator", 7200);
const ATTACKER = jwt("u-attacker", 3600);
const USERS: Record<string, string> = {
  [OPERATOR]: "u-operator",
  [OPERATOR_ROTATED]: "u-operator",
  [ATTACKER]: "u-attacker",
};

const factory: CloudClientFactory = () =>
  ({
    auth: {
      getClaims: async (token?: string) => {
        const sub = token ? USERS[token] : undefined;
        if (!sub) return { data: null, error: { message: "invalid JWT" } };
        return { data: { claims: { sub }, header: { alg: "ES256" }, signature: new Uint8Array() }, error: null };
      },
    },
  }) as unknown as SupabaseClient;

const KEY = "a".repeat(64);
const EVIL = "https://evil.example";

describe("POST /auth/session over HTTP", () => {
  let app: INestApplication;
  let base: string;
  let auth: AuthService;

  beforeAll(async () => {
    auth = new AuthService(new RegistryService(":memory:"), factory);

    @Module({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useFactory: () => new SupabaseAuthGuard(auth, new Reflector()) },
      ],
    })
    class HandoffModule {}

    app = await NestFactory.create(HandoffModule, { logger: false });
    app.enableCors({ origin: "*" });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });

  afterAll(() => app?.close());

  // What the desktop app configures: its per-launch key, no trusted origin.
  beforeEach(() => setUiProof(uiProofFor(KEY, undefined)));
  afterEach(() => {
    auth.clear();
    setUiProof({ origins: [] });
  });

  const handoff = (token: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ accessToken: token }),
    });

  const whoAmI = (token: string) => fetch(`${base}/auth/session`, { headers: { authorization: `Bearer ${token}` } });

  it("refuses a foreign page establishing a session on a signed-out api", async () => {
    const r = await handoff(ATTACKER, { origin: EVIL });
    expect(r.status).toBe(403);
    expect(auth.current()).toBeUndefined();
    expect((await whoAmI(ATTACKER)).status).toBe(401);
  });

  it("refuses a foreign page replacing the signed-in operator with another valid account", async () => {
    expect((await handoff(OPERATOR, { [UI_KEY_HEADER]: KEY })).status).toBe(201);

    const r = await handoff(ATTACKER, { origin: EVIL });
    expect(r.status).toBe(403);
    expect(auth.current()?.userId).toBe("u-operator");
    // The attacker's bearer opens nothing; the operator's still does.
    expect((await whoAmI(ATTACKER)).status).toBe(401);
    expect((await whoAmI(OPERATOR)).status).toBe(200);
  });

  it("refuses a wrong key, and a null Origin (file://, sandboxed iframe)", async () => {
    expect((await handoff(ATTACKER, { [UI_KEY_HEADER]: "b".repeat(64) })).status).toBe(403);
    expect((await handoff(ATTACKER, { origin: "null" })).status).toBe(403);
    expect(auth.current()).toBeUndefined();
  });

  it("does not let a stale bearer that is not the cached session prove anything", async () => {
    expect((await handoff(ATTACKER, { authorization: `Bearer ${ATTACKER}` })).status).toBe(403);
    expect(auth.current()).toBeUndefined();
  });

  it("refreshes the token with the current bearer, without the key", async () => {
    expect((await handoff(OPERATOR, { [UI_KEY_HEADER]: KEY })).status).toBe(201);
    const r = await handoff(OPERATOR_ROTATED, { authorization: `Bearer ${OPERATOR}` });
    expect(r.status).toBe(201);
    expect(auth.current()?.accessToken).toBe(OPERATOR_ROTATED);
  });

  it("lets the ui switch to another account only with its key", async () => {
    expect((await handoff(OPERATOR, { [UI_KEY_HEADER]: KEY })).status).toBe(201);
    expect((await handoff(ATTACKER, { [UI_KEY_HEADER]: KEY })).status).toBe(201);
    expect(auth.current()?.userId).toBe("u-attacker");
    expect((await whoAmI(OPERATOR)).status).toBe(401);
  });

  it("a standalone api trusts the dev ui's origin and nothing else", async () => {
    setUiProof(uiProofFor(undefined, undefined));
    expect((await handoff(OPERATOR, { origin: EVIL })).status).toBe(403);
    expect((await handoff(OPERATOR, { origin: "http://localhost:5318" })).status).toBe(403);
    for (const origin of DEV_UI_ORIGINS) {
      auth.clear();
      expect((await handoff(OPERATOR, { origin })).status).toBe(201);
    }
  });

  it("the desktop app does not trust the dev ui's origin unless KERMANYCH_UI_ORIGINS lists it", async () => {
    expect((await handoff(OPERATOR, { origin: "http://localhost:5317" })).status).toBe(403);
    setUiProof(uiProofFor(KEY, " http://localhost:9000 , null"));
    expect((await handoff(OPERATOR, { origin: "null" })).status).toBe(403);
    expect((await handoff(OPERATOR, { origin: "http://localhost:9000" })).status).toBe(201);
  });
});
