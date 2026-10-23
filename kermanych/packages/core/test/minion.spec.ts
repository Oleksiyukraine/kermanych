import { describe, expect, test } from "vitest";
import {
  MINION_CAP_MAX,
  MINION_SUMMARY_MAX,
  clampMinionCap,
  readMinionResult,
  validateOutcomeReport,
} from "../src/minion";
import { readSessionReport, taskReportsWrite, type ReportSource } from "../src/task-reports";

describe("validateOutcomeReport", () => {
  test("accepts the two verdicts and trims the summary", () => {
    expect(validateOutcomeReport({ outcome: "ready", summary: "  Fixed the off-by-one.\n" })).toEqual({
      ok: true,
      report: { outcome: "ready", summary: "Fixed the off-by-one." },
    });
    expect(validateOutcomeReport({ outcome: "needs_decision", summary: "Which API version?" })).toMatchObject({ ok: true });
  });

  test("refuses an unknown verdict, a blank summary and a non-object, naming the field", () => {
    expect(validateOutcomeReport({ outcome: "done", summary: "x" })).toEqual({ ok: false, error: expect.stringMatching(/outcome/) });
    expect(validateOutcomeReport({ outcome: "ready", summary: "   " })).toEqual({ ok: false, error: expect.stringMatching(/summary/) });
    expect(validateOutcomeReport({ outcome: "ready" })).toEqual({ ok: false, error: expect.stringMatching(/summary/) });
    expect(validateOutcomeReport(["ready", "x"])).toMatchObject({ ok: false });
    expect(validateOutcomeReport(null)).toMatchObject({ ok: false });
  });

  test("cuts an essay down to the summary limit instead of refusing it", () => {
    const r = validateOutcomeReport({ outcome: "ready", summary: "a".repeat(MINION_SUMMARY_MAX + 50) });
    expect(r.ok && r.report.summary.length).toBe(MINION_SUMMARY_MAX);
  });
});

describe("clampMinionCap", () => {
  test("keeps an integer in range and caps a large one", () => {
    expect(clampMinionCap(1)).toBe(1);
    expect(clampMinionCap(3)).toBe(3);
    expect(clampMinionCap(MINION_CAP_MAX + 5)).toBe(MINION_CAP_MAX);
  });

  test("refuses zero, negatives, fractions and non-numbers", () => {
    for (const v of [0, -1, 1.5, "2", null, undefined, Number.NaN]) expect(clampMinionCap(v)).toBeUndefined();
  });
});

describe("readMinionResult", () => {
  test("keeps a known outcome with its code and reason", () => {
    expect(readMinionResult({ outcome: "needs_decision", code: "no_pr", reason: "push refused" })).toEqual({
      outcome: "needs_decision",
      code: "no_pr",
      reason: "push refused",
    });
  });

  test("drops an unknown code or a blank reason, and refuses an unknown outcome", () => {
    expect(readMinionResult({ outcome: "pr", code: "lunar", reason: "" })).toEqual({ outcome: "pr" });
    expect(readMinionResult({ outcome: "merged" })).toBeUndefined();
    expect(readMinionResult("pr")).toBeUndefined();
  });
});

describe("the card's session report", () => {
  const base: ReportSource = { id: "s1", runtime: "omp", branch: "fix/x", worktree: true };

  test("carries the minion's result only for a minion session", () => {
    const result = { outcome: "needs_decision", reason: "Which locale?" } as const;
    expect(taskReportsWrite({ session: { ...base, minion: true, minionResult: result }, at: "t" }).session.minion).toEqual(result);
    expect("minion" in taskReportsWrite({ session: { ...base, minionResult: result }, at: "t" }).session).toBe(false);
    expect("minion" in taskReportsWrite({ session: { ...base, minion: true }, at: "t" }).session).toBe(false);
  });

  test("reads the result back and ignores a malformed one", () => {
    const head = { sessionId: "s1", generatedAt: "t", runtime: "omp", branch: "fix/x" };
    expect(readSessionReport({ ...head, minion: { outcome: "pr" } })?.minion).toEqual({ outcome: "pr" });
    expect(readSessionReport({ ...head, minion: { outcome: "won" } })).not.toHaveProperty("minion");
  });
});
