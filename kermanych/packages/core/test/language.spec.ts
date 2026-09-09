import { describe, it, expect } from "vitest";
import { AGENT_LANGUAGES, isAgentLanguage, agentLanguageDirective } from "../src/language";

describe("agent language", () => {
  it("guard accepts every listed code and rejects everything else", () => {
    for (const l of AGENT_LANGUAGES) expect(isAgentLanguage(l)).toBe(true);
    expect(isAgentLanguage("klingon")).toBe(false);
    expect(isAgentLanguage("")).toBe(false);
    expect(isAgentLanguage(undefined)).toBe(false);
    expect(isAgentLanguage(null)).toBe(false);
    expect(isAgentLanguage(42)).toBe(false);
  });

  it("directive names the language and instructs the agent to always use it", () => {
    const uk = agentLanguageDirective("uk");
    expect(uk).toContain("Ukrainian");
    expect(uk).toContain("Українська");
    expect(uk.toLowerCase()).toContain("always");

    const ja = agentLanguageDirective("ja");
    expect(ja).toContain("Japanese");
    expect(ja).toContain("日本語");
  });
});
