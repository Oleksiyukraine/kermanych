import { expect, test } from "vitest";
import { DEFAULT_SKILLS, isSkillName, renderSkillFile, SKILL_NAME_RE } from "../src/skills";

test("skill names are safe directory names", () => {
  for (const ok of ["kermanych-session", "a", "a1-b2"]) expect(isSkillName(ok)).toBe(true);
  for (const bad of ["", "-lead", "UPPER", "with space", "a/b", "../evil", "a".repeat(65), "dot.name"])
    expect(isSkillName(bad)).toBe(false);
  // The service re-checks with the same source of truth, so it must be exported.
  expect(SKILL_NAME_RE.test("kermanych-pull-request")).toBe(true);
});

test("renderSkillFile emits the two frontmatter keys omp requires", () => {
  const out = renderSkillFile({ name: "x-y", description: 'a: colon, "quote"', body: "line one\n\n" });
  expect(out).toBe('---\nname: x-y\ndescription: "a: colon, \\"quote\\""\n---\n\nline one\n');
});

test("every shipped default is discoverable by omp", () => {
  expect(DEFAULT_SKILLS.length).toBeGreaterThan(0);
  const names = DEFAULT_SKILLS.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
  for (const s of DEFAULT_SKILLS) {
    expect(isSkillName(s.name)).toBe(true);
    expect(s.description.trim()).not.toBe("");
    expect(s.body.trim()).not.toBe("");
    // A skill that applies itself without being read would be invisible in the chat.
    expect(s.body).not.toMatch(/alwaysApply|globs:/);
  }
});
