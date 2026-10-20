import { describe, expect, it } from "vitest";
import { FINDING_TITLE_MAX, findingIssueTypeName, renderFindingDescription, validateFindingReport } from "../src/findings";

const good = {
  title: "Session deletion leaves its preview port bound",
  kind: "bug",
  context: "Deleting a session does not stop its preview, so the port stays taken until restart.",
  evidence: ["apps/api/src/supervisor/supervisor.service.ts:1869", "  apps/api/src/preview/preview.service.ts:40 ", ""],
  acceptanceCriteria: ["Deleting a session frees its preview port", "Deleting a session frees its preview port"],
};

describe("validateFindingReport", () => {
  it("accepts a complete report, trimming and de-duplicating its lists", () => {
    const r = validateFindingReport({ ...good, suggestedFix: "  call preview.stop() in deleteSession " });
    expect(r).toEqual({
      ok: true,
      report: {
        title: good.title,
        kind: "bug",
        context: good.context,
        evidence: ["apps/api/src/supervisor/supervisor.service.ts:1869", "apps/api/src/preview/preview.service.ts:40"],
        acceptanceCriteria: ["Deleting a session frees its preview port"],
        suggestedFix: "call preview.stop() in deleteSession",
      },
    });
  });

  it("names the first missing or malformed field", () => {
    const err = (v: unknown) => {
      const r = validateFindingReport(v);
      if (r.ok) throw new Error("expected a refusal");
      return r.error;
    };
    expect(err(null)).toMatch(/object/);
    expect(err({ ...good, title: "  " })).toMatch(/`title` is required/);
    expect(err({ ...good, title: "a\nb" })).toMatch(/one line/);
    expect(err({ ...good, title: "x".repeat(FINDING_TITLE_MAX + 1) })).toMatch(/at most 120/);
    expect(err({ ...good, kind: "style" })).toMatch(/bug, security, tech-debt, docs/);
    expect(err({ ...good, context: "" })).toMatch(/`context`/);
    expect(err({ ...good, evidence: ["", " "] })).toMatch(/`evidence`/);
    expect(err({ ...good, evidence: "file.ts:1" })).toMatch(/`evidence`/);
    expect(err({ ...good, acceptanceCriteria: [] })).toMatch(/`acceptanceCriteria`/);
    expect(err({ ...good, suggestedFix: 3 })).toMatch(/`suggestedFix`/);
  });

  it("accepts a title of exactly the limit", () => {
    expect(validateFindingReport({ ...good, title: "x".repeat(FINDING_TITLE_MAX) }).ok).toBe(true);
  });
});

describe("renderFindingDescription", () => {
  const origin = { project: "kermanych", branch: "feature/x", session: "fix login" };

  it("renders the ticket sections, evidence, the fix and the origin, in that order", () => {
    const r = validateFindingReport({ ...good, suggestedFix: "Stop it." });
    if (!r.ok) throw new Error(r.error);
    const md = renderFindingDescription(r.report, origin);
    const order = ["## Context", "## Acceptance criteria", "- [ ] Deleting a session", "## Evidence", "## Suggested fix", "Reported by a Kermanych agent"];
    const at = order.map((s) => md.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md).toContain("- `apps/api/src/preview/preview.service.ts:40`");
    expect(md).toContain("branch `feature/x`");
  });

  it("omits Suggested fix when there is none and keeps backticks from breaking evidence code spans", () => {
    const r = validateFindingReport({ ...good, evidence: ["run `pnpm test`"] });
    if (!r.ok) throw new Error(r.error);
    const md = renderFindingDescription(r.report, origin);
    expect(md).not.toContain("## Suggested fix");
    expect(md).toContain("- `run 'pnpm test'`");
  });
});

describe("findingIssueTypeName", () => {
  it("files bugs and vulnerabilities as Bug, everything else as Task", () => {
    expect(findingIssueTypeName("bug")).toBe("Bug");
    expect(findingIssueTypeName("security")).toBe("Bug");
    expect(findingIssueTypeName("tech-debt")).toBe("Task");
    expect(findingIssueTypeName("docs")).toBe("Task");
  });
});
