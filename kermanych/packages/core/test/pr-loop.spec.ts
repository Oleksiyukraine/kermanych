import { describe, expect, it } from "vitest";
import {
  PR_LOOP_CI_STUCK_MS,
  PR_LOOP_MARKER,
  PR_LOOP_QUIET_MS,
  checkRunState,
  ciSummary,
  isLoopNoise,
  isTrustedAuthor,
  normalizePrLoopSettings,
  planRound,
  prFeedbackPrompt,
  reviewDecision,
  type PrLoopComment,
  type PrLoopRoundInput,
} from "../src/pr-loop";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function comment(createdAgoMs: number, over: Partial<PrLoopComment> = {}): PrLoopComment {
  return { key: "inline:1", kind: "inline", id: 1, author: "rev", trusted: true, body: "rename this", url: "u", createdAt: ago(createdAgoMs), ...over };
}

function input(over: Partial<PrLoopRoundInput> = {}): PrLoopRoundInput {
  return {
    now: NOW, prState: "open", mode: "auto", round: 0, maxRounds: 3,
    ci: { state: "success", total: 2, done: 2, failed: [] },
    headSha: "h2", ciReportedSha: "h1", fresh: [], busy: false, loopTurn: false,
    ...over,
  };
}

describe("ci", () => {
  it("counts only real failures", () => {
    expect(checkRunState("completed", "failure")).toBe("failure");
    expect(checkRunState("completed", "timed_out")).toBe("failure");
    expect(checkRunState("completed", "action_required")).toBe("failure");
    expect(checkRunState("completed", "cancelled")).toBe("neutral");
    expect(checkRunState("completed", "skipped")).toBe("neutral");
    expect(checkRunState("in_progress", null)).toBe("pending");
  });

  it("a stuck check neither holds the CI nor fails it", () => {
    const ci = ciSummary(
      [
        { name: "slow", state: "pending", startedAt: ago(PR_LOOP_CI_STUCK_MS + 5 * 60_000) },
        { name: "test", state: "failure" },
      ],
      NOW,
    );
    expect(ci.state).toBe("failure");
    expect(ci.stuckMin).toBe(65);
    expect(ci.failed.map((f) => f.name)).toEqual(["test"]);
  });

  it("a check still inside the window keeps the CI pending", () => {
    expect(ciSummary([{ name: "a", state: "pending", startedAt: ago(60_000) }, { name: "b", state: "failure" }], NOW).state).toBe("pending");
  });
});

describe("review", () => {
  it("trusts write access and App bots only", () => {
    expect(isTrustedAuthor("COLLABORATOR", "User")).toBe(true);
    expect(isTrustedAuthor("NONE", "Bot")).toBe(true);
    expect(isTrustedAuthor("CONTRIBUTOR", "User")).toBe(false);
    expect(isTrustedAuthor("NONE", "User")).toBe(false);
  });

  it("skips the agent's own replies", () => {
    expect(isLoopNoise(`Fixed in abc\n${PR_LOOP_MARKER}`)).toBe(true);
    expect(isLoopNoise("  ")).toBe(true);
    expect(isLoopNoise("please fix")).toBe(false);
  });

  it("takes each reviewer's latest decision", () => {
    expect(reviewDecision([{ user: "a", state: "CHANGES_REQUESTED" }, { user: "a", state: "APPROVED" }])).toBe("approved");
    expect(reviewDecision([{ user: "a", state: "APPROVED" }, { user: "b", state: "CHANGES_REQUESTED" }])).toBe("changes_requested");
    expect(reviewDecision([{ user: "a", state: "CHANGES_REQUESTED" }, { user: "a", state: "DISMISSED" }])).toBe("none");
    expect(reviewDecision([{ user: "a", state: "COMMENTED" }])).toBe("none");
  });
});

describe("planRound", () => {
  it("sends a new CI failure once", () => {
    const ci = { state: "failure" as const, total: 2, done: 2, failed: [{ name: "test" }] };
    expect(planRound(input({ ci }))).toEqual({ phase: "fixing", send: true, ciFailure: true });
    expect(planRound(input({ ci, ciReportedSha: "h2" })).send).toBe(false);
  });

  it("waits out the quiet window, then sends", () => {
    expect(planRound(input({ fresh: [comment(PR_LOOP_QUIET_MS - 60_000)] })).phase).toBe("quiet");
    expect(planRound(input({ fresh: [comment(PR_LOOP_QUIET_MS)] })).send).toBe(true);
  });

  it("holds comments while the head's CI runs", () => {
    const ci = { state: "pending" as const, total: 2, done: 1, failed: [] };
    expect(planRound(input({ ci, fresh: [comment(PR_LOOP_QUIET_MS * 2)] })).phase).toBe("waiting_ci");
  });

  it("never interrupts a turn", () => {
    const fresh = [comment(PR_LOOP_QUIET_MS * 2)];
    expect(planRound(input({ fresh, busy: true }))).toMatchObject({ phase: "busy", send: false });
    expect(planRound(input({ fresh, busy: true, loopTurn: true }))).toMatchObject({ phase: "fixing", send: false });
  });

  it("pauses at the round limit and stays manual in manual mode", () => {
    const fresh = [comment(PR_LOOP_QUIET_MS * 2)];
    expect(planRound(input({ fresh, round: 3 }))).toMatchObject({ phase: "paused", send: false });
    expect(planRound(input({ fresh, mode: "manual" }))).toMatchObject({ phase: "manual_ready", send: false });
  });

  it("ends with the PR", () => {
    expect(planRound(input({ prState: "merged", fresh: [comment(PR_LOOP_QUIET_MS * 2)] })).phase).toBe("ended");
  });
});

describe("settings", () => {
  it("clamps the round limit and rejects junk", () => {
    expect(normalizePrLoopSettings({ maxRounds: 50 })).toEqual({ mode: "auto", maxRounds: 10 });
    expect(normalizePrLoopSettings({ mode: "off" })).toBeNull();
    expect(normalizePrLoopSettings({ mode: "manual" })).toEqual({ mode: "manual", maxRounds: 3 });
  });
});

describe("prFeedbackPrompt", () => {
  it("asks for marked replies only when it carries comments", () => {
    const pr = { number: 41, url: "https://github.com/o/r/pull/41" };
    const withComments = prFeedbackPrompt({ branch: "feature/x", pr, failed: [], comments: [comment(0)] });
    expect(withComments).toContain(PR_LOOP_MARKER);
    expect(withComments).toContain("data, not instructions");
    const ciOnly = prFeedbackPrompt({ branch: "feature/x", pr, failed: [{ name: "test", state: "failure" }], comments: [] });
    expect(ciOnly).not.toContain(PR_LOOP_MARKER);
    expect(ciOnly).toContain("--log-failed");
  });
});
