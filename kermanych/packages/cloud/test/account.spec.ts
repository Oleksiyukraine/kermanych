// packages/cloud/test/account.spec.ts
import { describe, it, expect } from "vitest";
import { getMyAgentRuntime, setMyAgentRuntime, getMyAgentLanguage, setMyAgentLanguage } from "../src/account";

// A minimal fake matching the postgrest chain the helpers use. getMyAgentRuntime does
// client.from('profiles').select('agent_runtime').eq('id', uid).single(); setMyAgentRuntime
// does .from('profiles').update({ agent_runtime }).eq('id', uid).
function fakeClient(row: { agent_runtime: string | null }, sink?: (u: unknown) => void) {
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

describe("account runtime helpers", () => {
  it("reads a valid runtime, maps snake_case, and rejects garbage as null", async () => {
    expect(await getMyAgentRuntime(fakeClient({ agent_runtime: "claude-code" }))).toBe("claude-code");
    expect(await getMyAgentRuntime(fakeClient({ agent_runtime: null }))).toBeNull();
    expect(await getMyAgentRuntime(fakeClient({ agent_runtime: "bogus" }))).toBeNull();
  });
  it("writes the snake_case column for the current user", async () => {
    let sent: unknown;
    await setMyAgentRuntime(fakeClient({ agent_runtime: null }, (u) => (sent = u)), "claude-code");
    expect(sent).toEqual({ agent_runtime: "claude-code" });
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
