import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

test("auth_session starts empty and round-trips a full row", () => {
  const r = new RegistryService(":memory:");
  expect(r.getAuthSession()).toBeUndefined();

  r.setAuthSession({
    userId: "u-1",
    accessToken: "jwt-1",
    expiresAt: "2026-08-21T12:00:00.000Z",
    githubUsername: "octocat",
  });

  expect(r.getAuthSession()).toEqual({
    userId: "u-1",
    accessToken: "jwt-1",
    expiresAt: "2026-08-21T12:00:00.000Z",
    githubUsername: "octocat",
  });
});

test("auth_session holds at most one row — a second set replaces the first", () => {
  const r = new RegistryService(":memory:");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1", expiresAt: "2026-08-21T12:00:00.000Z" });
  r.setAuthSession({ userId: "u-2", accessToken: "jwt-2" });

  const cur = r.getAuthSession();
  expect(cur?.userId).toBe("u-2");
  expect(cur?.accessToken).toBe("jwt-2");
  expect(cur?.expiresAt).toBeUndefined();
  expect(cur?.githubUsername).toBeUndefined();
});

test("clearAuthSession removes the cached token", () => {
  const r = new RegistryService(":memory:");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1" });
  r.clearAuthSession();
  expect(r.getAuthSession()).toBeUndefined();
  // Idempotent: signing out twice must not throw.
  r.clearAuthSession();
  expect(r.getAuthSession()).toBeUndefined();
});
