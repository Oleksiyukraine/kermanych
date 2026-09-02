import { expect, test } from "vitest";
import { AGENTS, agentById, renderInstruction, PR_CONVENTIONS_FALLBACK } from "../src/agents";
import { SKILL_NAME_RE } from "../src/skills";

test("the registry describes six agents, four of them instruction-bearing", () => {
  expect(AGENTS.map((a) => a.id)).toEqual([
    "review", "promote", "pull-request", "resolve-conflict", "finish", "summary",
  ]);
  for (const a of AGENTS) {
    expect(SKILL_NAME_RE.test(a.id)).toBe(true);
    expect(a.labelKey).toBe(`agents.role.${a.id}`);
  }
  expect(AGENTS.filter((a) => a.instruction).map((a) => a.id)).toEqual([
    "review", "promote", "pull-request", "resolve-conflict",
  ]);
  // `automation` means no model is involved, so there is nothing to display.
  for (const a of AGENTS.filter((a) => a.kind === "automation")) {
    expect(a.instruction).toBeUndefined();
    expect(a.holes).toBeUndefined();
  }
});

test("every hole in an instruction is declared, and every declared hole is used", () => {
  for (const a of AGENTS) {
    if (!a.instruction) continue;
    const used = [...a.instruction.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
    expect(new Set(used)).toEqual(new Set(a.holes ?? []));
    expect(used.length).toBeGreaterThan(0);
  }
});

test("renderInstruction substitutes every hole and leaves no braces behind", () => {
  const out = renderInstruction(agentById("resolve-conflict")!, { files: "- a.ts\n- b.ts" });
  expect(out).toContain("- a.ts\n- b.ts");
  expect(out).not.toMatch(/\{\{/);
});

test("a missing variable is an error, not an unfilled hole in a live prompt", () => {
  expect(() => renderInstruction(agentById("review")!, { task: "t" })).toThrow(/base|branch|diff/);
});

test("an automation agent cannot be rendered", () => {
  expect(() => renderInstruction(agentById("finish")!, {})).toThrow(/finish/);
});

test("the PR conventions fallback is the four-line list the supervisor used", () => {
  expect(PR_CONVENTIONS_FALLBACK.split("\n")).toHaveLength(4);
  expect(PR_CONVENTIONS_FALLBACK).toContain("Conventional Commits");
});
