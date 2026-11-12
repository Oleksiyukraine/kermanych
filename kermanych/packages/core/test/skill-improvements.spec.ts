import { describe, expect, it } from "vitest";
import {
  SKILL_EDITS_MAX,
  SKILL_IMPROVEMENT_SUMMARY_MAX,
  applySkillEdits,
  copyOrigin,
  rollbackPlan,
  shareTarget,
  skillTextDiff,
  validateImproveSkillArgs,
  skillLessonRule,
  skillReflectionBlock,
  isSkillImprovementLevel,
  type SkillImprovement,
} from "../src/skill-improvements";

const good = {
  skill: "qa-tester",
  edits: [{ find: "2. Run the suite.", replace: "2. Run the suite with --maxWorkers=4." }],
  summary: "  run tests with\n at most four workers ",
  reason: "The operator stopped a run that used every core.",
};

describe("validateImproveSkillArgs", () => {
  it("accepts a well-formed call and folds the summary onto one line", () => {
    const v = validateImproveSkillArgs(good);
    expect(v).toEqual({ ok: true, args: { ...good, summary: "run tests with at most four workers" } });
  });

  it("keeps find and replace verbatim, whitespace included", () => {
    const v = validateImproveSkillArgs({ ...good, edits: [{ find: "  - item\n", replace: "" }] });
    expect(v.ok && v.args.edits).toEqual([{ find: "  - item\n", replace: "" }]);
  });

  it.each([
    ["a name that is not a skill name", { ...good, skill: "../etc" }, /`skill`/],
    ["no edits", { ...good, edits: [] }, /at least one/],
    ["too many edits", { ...good, edits: Array.from({ length: SKILL_EDITS_MAX + 1 }, (_, i) => ({ find: `a${i}`, replace: "b" })) }, /at most/],
    ["an edit that is not a pair", { ...good, edits: [{ find: "a" }] }, /edit 1 must be/],
    ["an empty find", { ...good, edits: [{ find: "", replace: "x" }] }, /empty `find`/],
    ["an edit that changes nothing", { ...good, edits: [{ find: "x", replace: "x" }] }, /changes nothing/],
    ["a blank summary", { ...good, summary: " \n " }, /`summary` is required/],
    ["a long summary", { ...good, summary: "x".repeat(SKILL_IMPROVEMENT_SUMMARY_MAX + 1) }, /at most/],
    ["no reason", { ...good, reason: "" }, /`reason` is required/],
  ])("refuses %s, naming what to fix", (_label, args, error) => {
    const v = validateImproveSkillArgs(args);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toMatch(error);
  });
});

describe("the level's lesson rule", () => {
  const on = ["conservative", "moderate", "active"] as const;

  it("raises the bar step by step: moderate keeps every conservative case, and no level sets a quota", () => {
    const [, conservativeWhen] = /^(Improve a skill when:.*?not obvious\.)/.exec(skillLessonRule("conservative"))!;
    expect(skillLessonRule("moderate")).toContain(conservativeWhen);
    expect(skillLessonRule("moderate")).toMatch(/Repeated friction/);
    expect(skillLessonRule("conservative")).not.toMatch(/Repeated friction/);
    expect(skillLessonRule("active")).toMatch(/Review every library skill you used/);
    for (const level of on) expect(skillLessonRule(level)).not.toMatch(/at least one|Most sessions/);
  });

  it.each(on)("keeps the shared exclusions at %s", (level) => {
    const rule = skillLessonRule(level);
    expect(rule).toMatch(/rests on something that happened in this session/);
    expect(rule).toMatch(/a risk that could have happened is not a lesson/);
    expect(rule).toMatch(/Kermanych's own turn instruction .* report it with report_finding and leave the skills alone/);
    expect(rule).toMatch(/one-off task/);
    expect(rule).toMatch(/report_finding/);
    expect(rule).toMatch(/secrets, tokens or personal data/);
  });

  it.each(on)("frames the reflection step at %s so an overridden instruction does not cancel it", (level) => {
    const block = skillReflectionBlock(level);
    expect(block).toContain(skillLessonRule(level));
    expect(block).toMatch(/applies whatever the instruction above says/);
    expect(block).toMatch(/not yet made in this session, call `improve_skill`/);
  });

  it("knows the four stored levels and nothing else", () => {
    expect(["off", "conservative", "moderate", "active"].every(isSkillImprovementLevel)).toBe(true);
    expect([true, "on", "", null].some(isSkillImprovementLevel)).toBe(false);
  });
});

describe("applySkillEdits", () => {
  const text = "1. Read the task.\n2. Run the suite.\n3. Report.";

  it("applies edits in order, each to the result of the one before", () => {
    const r = applySkillEdits(text, [
      { find: "2. Run the suite.", replace: "2. Run the suite.\n2a. Check the console." },
      { find: "2a. Check", replace: "2a. Then check" },
    ]);
    expect(r).toEqual({ ok: true, text: "1. Read the task.\n2. Run the suite.\n2a. Then check the console.\n3. Report." });
  });

  it("an empty replace removes the fragment", () => {
    expect(applySkillEdits(text, [{ find: "\n3. Report.", replace: "" }])).toEqual({ ok: true, text: "1. Read the task.\n2. Run the suite." });
  });

  it("fails on a fragment that is not there, naming the edit", () => {
    expect(applySkillEdits(text, [{ find: "1. Read", replace: "1. Study" }, { find: "4. Ship.", replace: "" }])).toEqual({
      ok: false,
      index: 1,
      reason: "missing",
    });
  });

  it("fails on a fragment that occurs twice, overlapping occurrences included", () => {
    expect(applySkillEdits(text, [{ find: ". ", replace: ") " }])).toMatchObject({ ok: false, index: 0, reason: "ambiguous" });
    expect(applySkillEdits("aaa", [{ find: "aa", replace: "b" }])).toMatchObject({ ok: false, reason: "ambiguous" });
  });
});

function record(over: Partial<SkillImprovement> & Pick<SkillImprovement, "id" | "createdAt">): SkillImprovement {
  return {
    userId: "u1",
    skillName: "qa-tester",
    summary: "s",
    sessionName: "session",
    sessionId: "s1",
    reason: "r",
    beforeBody: "v0",
    edits: [{ find: "v0", replace: "v1" }],
    createdCopy: false,
    teamScope: "default",
    state: "applied",
    stateAt: over.createdAt,
    ...over,
  };
}

describe("rollbackPlan", () => {
  // The personal copy's history: A made it (v0 → v1), B and C changed it further.
  const a = record({ id: "a", createdAt: "2026-11-04T10:00:00Z", createdCopy: true, beforeBody: "v0", edits: [{ find: "v0", replace: "v1" }] });
  const b = record({ id: "b", createdAt: "2026-11-04T11:00:00Z", beforeBody: "v1", edits: [{ find: "v1", replace: "v2" }] });
  const c = record({ id: "c", createdAt: "2026-11-04T12:00:00Z", beforeBody: "v2", edits: [{ find: "v2", replace: "v3" }] });
  const other = record({ id: "x", createdAt: "2026-11-04T13:00:00Z", skillName: "librarian" });
  const all = [c, other, a, b];

  it("restores the text before the change and takes the later changes with it", () => {
    const plan = rollbackPlan(all, "b", "v3");
    expect(plan?.records.map((r) => r.id)).toEqual(["b", "c"]);
    expect(plan?.later).toBe(1);
    expect(plan?.action).toEqual({ kind: "restore", text: "v1" });
    expect(plan?.handEdited).toBe(false);
  });

  it("rolling back the change that made the copy deletes the copy", () => {
    const plan = rollbackPlan(all, "a", "v3");
    expect(plan?.records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(plan?.action).toEqual({ kind: "delete-copy" });
  });

  it("says when the copy was edited by hand after the latest change", () => {
    expect(rollbackPlan(all, "c", "v3 plus a line typed in «Навички»")?.handEdited).toBe(true);
  });

  it("only marks the records when the copy is already gone", () => {
    const plan = rollbackPlan(all, "b", undefined);
    expect(plan?.action).toEqual({ kind: "none" });
    expect(plan?.handEdited).toBe(false);
  });

  it("skips changes already rolled back and refuses a settled target", () => {
    const settled = [a, { ...b, state: "rolled_back" as const }, c];
    expect(rollbackPlan(settled, "a", "v3")?.records.map((r) => r.id)).toEqual(["a", "c"]);
    expect(rollbackPlan(settled, "b", "v3")).toBeUndefined();
    expect(rollbackPlan(settled, "missing", "v3")).toBeUndefined();
  });

  it("finds the change the current copy started from, and none once it was pruned", () => {
    expect(copyOrigin(all, "qa-tester")?.id).toBe("a");
    expect(copyOrigin([b, c], "qa-tester")).toBeUndefined();
  });
});

describe("shareTarget", () => {
  it("writes back to the project or workspace the skill came from", () => {
    expect(shareTarget({ teamScope: "project", teamOwnerId: "p1", workspaceId: "w1" })).toEqual({ scope: "project", id: "p1" });
    expect(shareTarget({ teamScope: "workspace", teamOwnerId: "w2", workspaceId: "w1" })).toEqual({ scope: "workspace", id: "w2" });
  });

  it("sends a default or a personal-only skill to the session's workspace, and nowhere without one", () => {
    expect(shareTarget({ teamScope: "default", workspaceId: "w1" })).toEqual({ scope: "workspace", id: "w1" });
    expect(shareTarget({ teamScope: "none", workspaceId: "w1" })).toEqual({ scope: "workspace", id: "w1" });
    expect(shareTarget({ teamScope: "none" })).toBeUndefined();
  });
});

describe("skillTextDiff", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it("has no hunks for equal texts", () => {
    expect(skillTextDiff("a\nb", "a\nb")).toEqual({ hunks: [] });
  });

  it("pairs a replaced line opposite its replacement, with three lines of context", () => {
    const before = lines(10).join("\n");
    const after = lines(10).map((l) => (l === "line 5" ? "line five" : l)).join("\n");
    const [hunk, ...rest] = skillTextDiff(before, after).hunks;
    expect(rest).toEqual([]);
    expect(hunk?.header).toBe("@@ -2,7 +2,7 @@");
    expect(hunk?.rows.map((r) => r.kind)).toEqual(["ctx", "ctx", "ctx", "mod", "ctx", "ctx", "ctx"]);
    expect(hunk?.rows[3]).toEqual({ kind: "mod", old: { no: 5, text: "line 5" }, new: { no: 5, text: "line five" } });
  });

  it("shows an added line with nothing opposite and renumbers what follows", () => {
    const before = "a\nb\nc";
    const after = "a\nb\nnew\nc";
    const rows = skillTextDiff(before, after).hunks[0]?.rows;
    expect(rows?.find((r) => r.kind === "add")).toEqual({ kind: "add", old: null, new: { no: 3, text: "new" } });
    expect(rows?.at(-1)).toEqual({ kind: "ctx", old: { no: 3, text: "c" }, new: { no: 4, text: "c" } });
  });

  it("splits changes far apart into separate hunks", () => {
    const before = lines(30);
    const after = [...before];
    after[2] = "changed 3";
    after[25] = "changed 26";
    expect(skillTextDiff(before.join("\n"), after.join("\n")).hunks.map((h) => h.header)).toEqual(["@@ -1,6 +1,6 @@", "@@ -23,7 +23,7 @@"]);
  });
});
