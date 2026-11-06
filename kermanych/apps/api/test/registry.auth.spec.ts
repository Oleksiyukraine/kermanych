import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

test("auth_session round-trips agentLanguage", () => {
  const r = new RegistryService(":memory:");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1", agentLanguage: "uk" });
  const cur = r.getAuthSession();
  expect(cur?.agentLanguage).toBe("uk");

  // A garbage stored value degrades to undefined rather than surfacing to the launch path.
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1" });
  expect(r.getAuthSession()?.agentLanguage).toBeUndefined();
});

test("auth_session round-trips the skill improvement level; never set counts as the default", () => {
  const r = new RegistryService(":memory:");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1" });
  expect(r.getAuthSession()?.skillImprovementLevel).toBeUndefined();
  expect(r.skillImprovementLevel()).toBe("moderate");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1", skillImprovementLevel: "off" });
  expect(r.skillImprovementLevel()).toBe("off");
  r.setAuthSession({ userId: "u-1", accessToken: "jwt-1", skillImprovementLevel: "active" });
  expect(r.skillImprovementLevel()).toBe("active");
});

test("a cached «off» of the old on/off switch carries over to the level, and the old column goes", () => {
  const dir = mkdtempSync(join(tmpdir(), "kermanych-auth-level-"));
  const file = join(dir, "k.sqlite");
  try {
    new RegistryService(file).setAuthSession({ userId: "u-1", accessToken: "jwt-1" });
    // The database as the previous version left it: the switch column, turned off.
    const old = new Database(file);
    old.exec(`ALTER TABLE auth_session ADD COLUMN skill_improvement INTEGER`);
    old.exec(`UPDATE auth_session SET skill_improvement = 0, skill_improvement_level = NULL`);
    old.close();

    expect(new RegistryService(file).skillImprovementLevel()).toBe("off");
    const db = new Database(file);
    const cols = (db.prepare(`PRAGMA table_info(auth_session)`).all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(cols).toContain("skill_improvement_level");
    expect(cols).not.toContain("skill_improvement");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
