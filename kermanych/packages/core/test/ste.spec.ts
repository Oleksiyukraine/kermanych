import { describe, it, expect } from "vitest";
import { agentLanguageDirective, type AgentLanguage } from "../src/language";
import { STE_GUARD_RAILS, STE_RULES, STE_SCOPE, type SteLevel } from "../src/ste";

// Which list entry means which level is the contract the settings page states.
const LEVEL_OF: [AgentLanguage, SteLevel][] = [
  ["en-ste", 100],
  ["en-ste-80", 80],
  ["en-ste-60", 60],
];

describe("ASD-STE100 levels", () => {
  it.each(LEVEL_OF)("%s carries exactly the rules its level marks, in the level's wording", (code, level) => {
    const directive = agentLanguageDirective(code);
    for (const rule of STE_RULES) {
      const cell = rule.at[level];
      // The full instruction only where the rule is on: a softened or dropped rule must not
      // reach the model in its strict form.
      expect(directive.includes(rule.text), `${rule.id} at ${level}`).toBe(cell === "on");
      if (typeof cell === "object") expect(directive, `${rule.id} at ${level}`).toContain(cell.soft);
    }
  });

  it.each(LEVEL_OF)("%s limits the rules to messages and keeps the guard rails", (code) => {
    const directive = agentLanguageDirective(code);
    expect(directive).toContain(STE_SCOPE);
    for (const rail of STE_GUARD_RAILS) expect(directive).toContain(rail);
  });
});
