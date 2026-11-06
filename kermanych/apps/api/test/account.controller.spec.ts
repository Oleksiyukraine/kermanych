// apps/api/test/account.controller.spec.ts
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { AccountController } from "../src/http/account.controller";
import { RegistryService, type AuthSessionRow } from "../src/registry/registry.service";
import type { RuntimeCheckService } from "../src/runtime/runtime-check.service";

function make(getSession?: AuthSessionRow | undefined, setCalled?: (row: AuthSessionRow) => void) {
  const registry = {
    getAuthSession: () => getSession,
    setAuthSession: (row: AuthSessionRow) => setCalled?.(row),
  } as unknown as RegistryService;
  return new AccountController(registry, checks());
}

// The preflight seam; the checkRuntime tests supply their own verdict.
function checks(verdict: { ok: boolean; code?: string } = { ok: true }) {
  return { check: async () => verdict } as unknown as RuntimeCheckService;
}

describe("AccountController", () => {
  // GET /account/runtime/check — the omp preflight. Read-only: it only reports what to fix.
  it("GET /account/runtime/check passes a usable omp through", async () => {
    const controller = new AccountController({} as unknown as RegistryService, checks({ ok: true }));
    expect(await controller.checkRuntime()).toEqual({ ok: true });
  });

  it("GET /account/runtime/check reports the cause of an unusable omp", async () => {
    const controller = new AccountController(
      {} as unknown as RegistryService,
      checks({ ok: false, code: "omp_not_authenticated" }),
    );
    expect(await controller.checkRuntime()).toEqual({ ok: false, code: "omp_not_authenticated" });
  });

  it("GET /account/language returns null when unset", () => {
    expect(make(undefined).getLanguage()).toEqual({ language: null });
    expect(make({ userId: "u1", accessToken: "tok" }).getLanguage()).toEqual({ language: null });
  });

  it("GET /account/language returns cached agentLanguage", () => {
    const controller = make({ userId: "u1", accessToken: "tok", agentLanguage: "uk" });
    expect(controller.getLanguage()).toEqual({ language: "uk" });
  });

  it("POST /account/language rejects an unknown language", () => {
    expect(() => make({ userId: "u1", accessToken: "tok" }).setLanguage({ language: "klingon" })).toThrow(BadRequestException);
  });

  it("POST /account/language throws when not signed in", () => {
    expect(() => make(undefined).setLanguage({ language: "uk" })).toThrow(BadRequestException);
  });

  it("POST /account/language sets agentLanguage and preserves the rest of the session", () => {
    let captured: AuthSessionRow | undefined;
    const existing: AuthSessionRow = { userId: "u1", accessToken: "tok", githubUsername: "alice" };
    const controller = make(existing, (row) => (captured = row));

    const result = controller.setLanguage({ language: "en" });

    expect(result).toEqual({ language: "en" });
    expect(captured).toEqual({ userId: "u1", accessToken: "tok", githubUsername: "alice", agentLanguage: "en" });
  });

  it("GET /account/skill-improvement is the default level until the cache knows otherwise", () => {
    const registry = new RegistryService(":memory:");
    const controller = new AccountController(registry, checks());
    expect(controller.getSkillImprovement()).toEqual({ level: "moderate" });
    registry.setAuthSession({ userId: "u1", accessToken: "tok", skillImprovementLevel: "off" });
    expect(controller.getSkillImprovement()).toEqual({ level: "off" });
  });

  it("POST /account/skill-improvement caches a known level; rejects anything else or signed out", () => {
    let captured: AuthSessionRow | undefined;
    const controller = make({ userId: "u1", accessToken: "tok", agentLanguage: "uk" }, (row) => (captured = row));
    expect(controller.setSkillImprovement({ level: "conservative" })).toEqual({ level: "conservative" });
    expect(captured).toEqual({ userId: "u1", accessToken: "tok", agentLanguage: "uk", skillImprovementLevel: "conservative" });
    expect(() => controller.setSkillImprovement({ level: false })).toThrow(BadRequestException);
    expect(() => controller.setSkillImprovement({ level: "eager" })).toThrow(BadRequestException);
    expect(() => make(undefined).setSkillImprovement({ level: "off" })).toThrow(BadRequestException);
  });
});
