// packages/cloud/test/account.spec.ts
import { describe, it, expect } from "vitest";
import {
  getMyAgentProvider,
  setMyAgentProvider,
  getMyAgentLanguage,
  setMyAgentLanguage,
  getMySkillImprovementLevel,
  setMySkillImprovementLevel,
} from "../src/account";

// A minimal fake matching the postgrest chain the helpers use. getMyAgentProvider does
// client.from('profiles').select('agent_runtime').eq('id', uid).single(); setMyAgentProvider
// does .from('profiles').update({ agent_runtime }).eq('id', uid).
function fakeClient(row: { agent_runtime: string | null }, sink?: (u: unknown) => void, error?: { message: string }) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from() {
      return {
        select() { return this; },
        update(u: unknown) { sink?.(u); return this; },
        eq() { return this; },
        single: async () => (error ? { data: null, error } : { data: row, error: null }),
        then: undefined,
      } as never;
    },
  } as never;
}

describe("account provider helpers", () => {
  it("reads every provider from the agent_runtime column, an unset or unknown value as null", async () => {
    expect(await getMyAgentProvider(fakeClient({ agent_runtime: "claude-code" }))).toBe("claude-code");
    expect(await getMyAgentProvider(fakeClient({ agent_runtime: "codex" }))).toBe("codex");
    expect(await getMyAgentProvider(fakeClient({ agent_runtime: "omp" }))).toBe("omp");
    expect(await getMyAgentProvider(fakeClient({ agent_runtime: null }))).toBeNull();
    expect(await getMyAgentProvider(fakeClient({ agent_runtime: "bogus" }))).toBeNull();
  });
  // «Not chosen» raises the onboarding gate; an unreadable row must not, so it throws instead.
  it("throws when the row cannot be read", async () => {
    await expect(getMyAgentProvider(fakeClient({ agent_runtime: null }, undefined, { message: "offline" }))).rejects.toThrow("offline");
  });
  it("writes the snake_case column for the current user", async () => {
    let sent: unknown;
    await setMyAgentProvider(fakeClient({ agent_runtime: null }, (u) => (sent = u)), "codex");
    expect(sent).toEqual({ agent_runtime: "codex" });
  });
});

// Same postgrest chain, on the agent_language column.
function fakeLangClient(row: { agent_language: string | null }, sink?: (u: unknown) => void) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from() {
      return {
        select() { return this; },
        update(u: unknown) { sink?.(u); return this; },
        eq() { return this; },
        single: async () => ({ data: row, error: null }),
        then: undefined,
      } as never;
    },
  } as never;
}

describe("account language helpers", () => {
  it("reads a valid language, maps snake_case, and rejects garbage as null", async () => {
    expect(await getMyAgentLanguage(fakeLangClient({ agent_language: "uk" }))).toBe("uk");
    expect(await getMyAgentLanguage(fakeLangClient({ agent_language: null }))).toBeNull();
    expect(await getMyAgentLanguage(fakeLangClient({ agent_language: "klingon" }))).toBeNull();
  });
  it("writes the snake_case column for the current user", async () => {
    let sent: unknown;
    await setMyAgentLanguage(fakeLangClient({ agent_language: null }, (u) => (sent = u)), "en");
    expect(sent).toEqual({ agent_language: "en" });
  });
});

describe("skill improvement level", () => {
  // Same postgrest chain, on the skill_improvement_level column.
  function fakeLevelClient(row: { skill_improvement_level: unknown }, sink?: (u: unknown) => void) {
    return {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
      from() {
        return {
          select() { return this; },
          update(u: unknown) { sink?.(u); return this; },
          eq() { return this; },
          single: async () => ({ data: row, error: null }),
          then: undefined,
        } as never;
      },
    } as never;
  }

  it("reads a known level, and null for anything else", async () => {
    expect(await getMySkillImprovementLevel(fakeLevelClient({ skill_improvement_level: "off" }))).toBe("off");
    expect(await getMySkillImprovementLevel(fakeLevelClient({ skill_improvement_level: "active" }))).toBe("active");
    expect(await getMySkillImprovementLevel(fakeLevelClient({ skill_improvement_level: true }))).toBeNull();
    expect(await getMySkillImprovementLevel(fakeLevelClient({ skill_improvement_level: "eager" }))).toBeNull();
  });
  it("writes the snake_case column for the current user", async () => {
    let sent: unknown;
    await setMySkillImprovementLevel(fakeLevelClient({ skill_improvement_level: "moderate" }, (u) => (sent = u)), "conservative");
    expect(sent).toEqual({ skill_improvement_level: "conservative" });
  });
});
