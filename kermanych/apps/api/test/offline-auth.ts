// apps/api/test/offline-auth.ts
// DI stub for the supervisor specs that never sign in. Those tests exercise launch, merge,
// finish and restart — paths that never reach the cloud — but the constructor now requires
// an AuthService, so hand them one that refuses exactly the way the real service does when
// no token is cached. If a test accidentally reaches a cloud path it fails loudly with
// "not signed in" instead of silently talking to a half-mocked object.
import type { AuthService } from "../src/auth/auth.service";

export function offlineAuth(): AuthService {
  return {
    current: () => undefined,
    cloudClient: () => {
      throw new Error("not signed in");
    },
  } as unknown as AuthService;
}
