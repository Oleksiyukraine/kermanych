// packages/core/test/deep-analysis.spec.ts
import { expect, test } from "vitest";
import { DEEP_ANALYSIS_SKILL, DEFAULT_SKILLS, deepAnalysisPrompt } from "../src";

// The task closes the prompt verbatim, so the operator's own words are the last thing read;
// the skill it names must be one Kermanych ships, or the name-resolved block is always empty.
test("deepAnalysisPrompt ends with the task and names the shipped skill", () => {
  const p = deepAnalysisPrompt("X");
  expect(p.endsWith("## Task\n\nX")).toBe(true);
  expect(p).toContain(DEEP_ANALYSIS_SKILL);
  expect(DEFAULT_SKILLS.map((s) => s.name)).toContain(DEEP_ANALYSIS_SKILL);
});
