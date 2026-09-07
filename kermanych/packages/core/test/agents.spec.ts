import { expect, test } from "vitest";
import {
  AGENTS,
  agentById,
  effectiveInstruction,
  instructionErrors,
  instructionHoles,
  renderInstruction,
  PR_CONVENTIONS_FALLBACK,
} from "../src/agents";
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

test("a valid override renders in place of the default", () => {
  const review = agentById("review")!;
  const template = "Огляньте {{task}} на {{branch}} проти {{base}}:\n{{diff}}";
  expect(effectiveInstruction(review, template)).toBe(template);
  const out = renderInstruction(review, { task: "t", base: "main", branch: "b", diff: "d" }, template);
  expect(out).toBe("Огляньте t на b проти main:\nd");
  expect(out).not.toContain(review.instruction!.slice(0, 20));
});

test("an override that drops a declared hole is refused, not silently starved of context", () => {
  const review = agentById("review")!;
  const template = "Огляньте {{task}} на {{branch}} проти {{base}} без дифу.";
  expect(instructionErrors(review, template)).toEqual({ missing: ["diff"], unknown: [] });
  expect(effectiveInstruction(review, template)).toBe(review.instruction);
});

test("an override that invents a hole is refused before it can throw mid-session", () => {
  const resolve = agentById("resolve-conflict")!;
  const template = "Розберіть {{files}} у {{repoRoot}}.";
  expect(instructionErrors(resolve, template)).toEqual({ missing: [], unknown: ["repoRoot"] });
  expect(effectiveInstruction(resolve, template)).toBe(resolve.instruction);
  // What the refusal spares the operator: the launcher would have thrown on the unknown hole.
  expect(() => renderInstruction(resolve, { files: "- a.ts" }, template)).toThrow(/repoRoot/);
});

test("a blank or whitespace override means 'no override'", () => {
  const promote = agentById("promote")!;
  for (const override of ["", "   \n\t", null, undefined]) {
    expect(effectiveInstruction(promote, override)).toBe(promote.instruction);
  }
});

test("an automation agent has no instruction to override", () => {
  const finish = agentById("finish")!;
  expect(effectiveInstruction(finish, "{{anything}}")).toBeUndefined();
  expect(effectiveInstruction(finish)).toBeUndefined();
});

test("holes are listed once each, in the order the template introduces them", () => {
  expect(instructionHoles("{{b}} {{a}} {{b}} {{c}} {{a}}")).toEqual(["b", "a", "c"]);
  expect(instructionHoles("no holes here")).toEqual([]);
  // The registry's declaration order is the template's first-appearance order.
  for (const a of AGENTS) {
    if (!a.instruction) continue;
    expect(instructionHoles(a.instruction)).toEqual([...a.holes!]);
  }
});

test("the PR conventions fallback is the four-line list the supervisor used", () => {
  expect(PR_CONVENTIONS_FALLBACK.split("\n")).toHaveLength(4);
  expect(PR_CONVENTIONS_FALLBACK).toContain("Conventional Commits");
});
