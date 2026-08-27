import { expect, test } from "vitest";
import { DEFAULT_SKILLS, isSkillName, renderSkillFile, SKILL_NAME_RE, skillsUsed } from "../src/skills";
import type { TranscriptEntry } from "../src/types";

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

test("renderSkillFile refuses a name that would break out of the frontmatter", () => {
  expect(() => renderSkillFile({ name: "x\n---\nalwaysApply: true", description: "d", body: "b" })).toThrow(
    /invalid skill name/,
  );
  expect(() => renderSkillFile({ name: "", description: "d", body: "b" })).toThrow(/invalid skill name/);
  expect(renderSkillFile({ name: "x-y", description: "d", body: "b" })).toBe("---\nname: x-y\ndescription: \"d\"\n---\n\nb\n");
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

test("skillsUsed lists unique skills in order of first use", () => {
  const entries = [
    { kind: "tool", id: "1", at: 1, tool: "read", status: "ok", target: "src/a.ts" },
    { kind: "tool", id: "2", at: 2, tool: "skill", status: "ok", target: "kermanych-session" },
    { kind: "tool", id: "3", at: 3, tool: "skill", status: "ok", target: "kermanych-pull-request" },
    { kind: "tool", id: "4", at: 4, tool: "skill", status: "ok", target: "kermanych-session" },
    // A sub-resource read counts as its parent skill, not a second entry.
    { kind: "tool", id: "5", at: 5, tool: "skill", status: "ok", target: "kermanych-session/refs/x.md" },
    { kind: "tool", id: "6", at: 6, tool: "skill", status: "pending" },
  ] as TranscriptEntry[];
  expect(skillsUsed(entries)).toEqual(["kermanych-session", "kermanych-pull-request"]);
});
