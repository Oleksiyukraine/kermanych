import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RegistryService } from "../src/registry/registry.service";
import { AuthService, type CloudClientFactory } from "../src/auth/auth.service";
import { SupabaseAuthGuard } from "../src/auth/auth.guard";
import { Public } from "../src/auth/public.decorator";

// cloudEnv("api") reads these; the stub factory never dials out.
process.env.SUPABASE_URL = "http://127.0.0.1:54421";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

// A JWT-shaped string. `getClaims` normally verifies the signature against the
// project's JWKS; the stub below stands in for that, and `jwtExpiry` only ever
// reads the `exp` claim. Deliberately no jose/JWKS dependency (spec D4).
function jwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "ES256", typ: "JWT" })}.${seg(payload)}.sig`;
}

const FRESH = jwt({ sub: "u-1", exp: Math.floor(Date.now() / 1000) + 3600 });
const EXPIRED = jwt({ sub: "u-1", exp: 1_000 });

// getClaims succeeds only for the tokens in `accept`; everything else looks like
// an invalid token, and `offline` makes every call look like a dead network.
// getUser is stubbed too, because AuthService falls back to it when getClaims
// returns `{ data: null, error: null }` (symmetric-secret projects).
function factory(accept: Record<string, string>, offline = false): CloudClientFactory {
  return () =>
    ({
      auth: {
        getClaims: async (token?: string) => {
          if (offline) throw new Error("fetch failed");
          const userId = token ? accept[token] : undefined;
          if (!userId) return { data: null, error: { message: "invalid JWT" } };
          const exp = JSON.parse(
            Buffer.from(token!.split(".")[1]!, "base64url").toString("utf8"),
          ) as { exp?: number };
          return {
            data: {
              claims: { sub: userId, exp: exp.exp, user_metadata: { user_name: "octocat" } },
              header: { alg: "ES256" },
              signature: new Uint8Array(),
            },
            error: null,
          };
        },
        getUser: async (token?: string) => {
          if (offline) throw new Error("fetch failed");
          const userId = token ? accept[token] : undefined;
          if (!userId) return { data: { user: null }, error: { message: "invalid JWT" } };
          return { data: { user: { id: userId, user_metadata: { user_name: "octocat" } } }, error: null };
        },
      },
    }) as unknown as SupabaseClient;
}

function ctx(
  headers: Record<string, string | undefined>,
  handler: object = () => undefined,
): { context: ExecutionContext; req: { headers: typeof headers; user?: { id: string } } } {
  const req: { headers: typeof headers; user?: { id: string } } = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { context, req };
}

class ProbeController {
  @Public()
  open() {
    return "ok";
  }

  guarded() {
    return "ok";
  }
}

test("a request with no Authorization header is rejected", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({}));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context } = ctx({});
  await expect(guard.canActivate(context)).rejects.toThrow("missing bearer token");
});

test("an unknown token with no reachable cloud is rejected", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-1" }, true));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context } = ctx({ authorization: `Bearer ${FRESH}` });
  await expect(guard.canActivate(context)).rejects.toThrow("invalid access token");
});

test("the cached token passes and exposes the user id on the request", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-1" }));
  await auth.setToken(FRESH);
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context, req } = ctx({ authorization: `Bearer ${FRESH}` });
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(req.user).toEqual({ id: "u-1" });
});

test("an EXPIRED cached token still controls the local machine (offline rule)", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [EXPIRED]: "u-1" }));
  await auth.setToken(EXPIRED);
  expect(auth.current()?.expiresAt).toBe(new Date(1_000_000).toISOString());

  // Cloud is gone now, and the token is long expired — local control must survive.
  const offline = new AuthService(reg, factory({}, true));
  const guard = new SupabaseAuthGuard(offline, new Reflector());
  const { context, req } = ctx({ authorization: `Bearer ${EXPIRED}` });
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(req.user).toEqual({ id: "u-1" });
});

test("an unknown but valid token is adopted by one online re-validation", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-9" }));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const { context, req } = ctx({ authorization: `Bearer ${FRESH}` });
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(req.user).toEqual({ id: "u-9" });
  expect(reg.getAuthSession()?.accessToken).toBe(FRESH);
});

test("a @Public() handler bypasses the guard entirely", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({}));
  const guard = new SupabaseAuthGuard(auth, new Reflector());
  const open = ctx({}, ProbeController.prototype.open);
  await expect(guard.canActivate(open.context)).resolves.toBe(true);

  const guarded = ctx({}, ProbeController.prototype.guarded);
  await expect(guard.canActivate(guarded.context)).rejects.toThrow("missing bearer token");
});

test("onToken listeners fire after the row is written, and clear() fires nothing", async () => {
  const reg = new RegistryService(":memory:");
  const auth = new AuthService(reg, factory({ [FRESH]: "u-1" }));
  const seen: { userId: string; accessToken: string; persisted?: string }[] = [];
  auth.onToken((a) => seen.push({ ...a, persisted: reg.getAuthSession()?.accessToken }));

  await auth.setToken(FRESH);
  expect(seen).toEqual([{ userId: "u-1", accessToken: FRESH, persisted: FRESH }]);

  auth.clear();
  expect(seen).toHaveLength(1);
  expect(reg.getAuthSession()).toBeUndefined();
  expect(() => auth.cloudClient()).toThrow("not signed in");
});
