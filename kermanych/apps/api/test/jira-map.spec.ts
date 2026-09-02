import { describe, expect, it } from "vitest";
import {
  adfText,
  dateOnly,
  fullJql,
  incrementalJql,
  mapAttachments,
  mapComments,
  mapIssue,
  mapWorklogs,
  pickInProgressTransition,
  pickStartDateFieldId,
  toJiraDate,
} from "../src/jira/jira-map";
import type { JiraFieldSummary, JiraRawIssue, JiraTransition } from "../src/jira/jira-client";

const integration = { id: "i1", workspaceId: "w1" };

const rawIssue: JiraRawIssue = {
  id: "10001",
  key: "KAN-42",
  fields: {
    summary: "Fix the flux capacitor",
    issuetype: { name: "Bug", iconUrl: "https://x/bug.svg" },
    priority: { name: "High", iconUrl: "https://x/high.svg" },
    labels: ["backend", 7],
    assignee: { accountId: "acc1", displayName: "Andrii", avatarUrls: { "48x48": "https://x/a48.png", "16x16": "https://x/a16.png" } },
    reporter: { displayName: "Olha" },
    status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
    parent: { key: "KAN-40" },
    timetracking: { originalEstimate: "2d 4h", remainingEstimate: "1d" },
    duedate: "2026-09-30",
    customfield_10015: "2026-09-05",
    updated: "2026-09-02T10:00:00.000+0300",
    attachment: [
      { id: "att1", filename: "log.txt", mimeType: "text/plain", size: 123, author: { displayName: "Olha" }, created: "2026-09-01T09:00:00.000+0000" },
    ],
  },
  renderedFields: { description: "<p>details</p>" },
};

describe("mapIssue", () => {
  it("maps the standard fields, rendered description, and normalised timestamps", () => {
    const issue = mapIssue(integration, rawIssue);
    expect(issue).toMatchObject({
      integrationId: "i1",
      workspaceId: "w1",
      issueId: "10001",
      key: "KAN-42",
      summary: "Fix the flux capacitor",
      descriptionHtml: "<p>details</p>",
      typeName: "Bug",
      priorityName: "High",
      labels: ["backend"],
      assigneeAccountId: "acc1",
      assigneeName: "Andrii",
      assigneeAvatar: "https://x/a48.png",
      reporterName: "Olha",
      statusId: "3",
      statusCategory: "indeterminate",
      parentKey: "KAN-40",
      originalEstimate: "2d 4h",
      dueDate: "2026-09-30",
      jiraUpdatedAt: "2026-09-02T07:00:00.000Z",
    });
  });

  it("reads the start date out of the field id the caller resolved, and nothing without one", () => {
    expect(mapIssue(integration, rawIssue, "customfield_10015").startDate).toBe("2026-09-05");
    // No resolved id: the payload never carried the field, so the mirror says «not set»
    // rather than guessing which customfield_* held a date.
    expect(mapIssue(integration, rawIssue).startDate).toBe("");
  });

  it("blanks dates Jira left empty", () => {
    const bare = mapIssue(integration, { id: "1", key: "K-1", fields: { updated: "2026-01-01T00:00:00.000Z" } }, "customfield_10015");
    expect(bare.dueDate).toBe("");
    expect(bare.startDate).toBe("");
  });

  it("degrades an unassigned, priority-less issue to blanks instead of crashing", () => {
    const bare = mapIssue(integration, { id: "1", key: "K-1", fields: { updated: "2026-01-01T00:00:00.000Z" } });
    expect(bare.summary).toBe("");
    expect(bare.priorityName).toBe("");
    expect(bare.statusCategory).toBe("new");
    expect("assigneeName" in bare).toBe(false);
    expect("parentKey" in bare).toBe(false);
  });
});

describe("dateOnly", () => {
  it("keeps Jira's calendar day verbatim, whatever time or zone rides along", () => {
    expect(dateOnly("2026-09-30")).toBe("2026-09-30");
    // A datetime-typed start field: the day is the datum, and taking it verbatim is what
    // stops a +03:00 midnight from becoming the previous day.
    expect(dateOnly("2026-09-30T00:30:00.000+0300")).toBe("2026-09-30");
  });

  it("degrades anything that is not a real day to blank", () => {
    expect(dateOnly("2026-02-31")).toBe("");
    expect(dateOnly("30/09/2026")).toBe("");
    expect(dateOnly("")).toBe("");
    expect(dateOnly(null)).toBe("");
    expect(dateOnly(1_759_000_000)).toBe("");
  });
});

describe("toJiraDate", () => {
  it("spells a cleared date as null and a set one as the day itself", () => {
    expect(toJiraDate("2026-09-30")).toBe("2026-09-30");
    expect(toJiraDate("  ")).toBeNull();
    expect(toJiraDate("")).toBeNull();
  });

  it("refuses a day Jira could only reject, instead of sending it", () => {
    expect(() => toJiraDate("30.09.2026")).toThrow(/invalid date/);
    expect(() => toJiraDate("2026-02-31")).toThrow(/invalid date/);
  });
});

describe("pickStartDateFieldId", () => {
  const field = (id: string, name: string, type = "date", custom?: string): JiraFieldSummary => ({
    id,
    name,
    custom: true,
    schema: custom ? { type, custom } : { type },
  });

  it("prefers the field actually named «Start date»", () => {
    const id = pickStartDateFieldId([
      field("customfield_10020", "Target start", "date", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
      field("customfield_10015", "Start date"),
    ]);
    expect(id).toBe("customfield_10015");
  });

  it("falls back to Advanced Roadmaps' baseline start by schema, not by its renameable name", () => {
    const id = pickStartDateFieldId([
      field("customfield_10020", "Початок за планом", "date", "com.atlassian.jpo:jpo-custom-field-baseline-start"),
    ]);
    expect(id).toBe("customfield_10020");
  });

  it("accepts a «Target start» by name when nothing better is on the site", () => {
    expect(pickStartDateFieldId([field("customfield_10031", "Target start", "datetime")])).toBe("customfield_10031");
  });

  it("ignores same-named fields that are not dates, and reports a site with none", () => {
    expect(pickStartDateFieldId([field("customfield_10099", "Start date", "string")])).toBeUndefined();
    expect(pickStartDateFieldId([{ id: "duedate", name: "Due date", schema: { type: "date" } }])).toBeUndefined();
  });
});

describe("children mappers", () => {
  it("maps comments with rendered bodies and avatar fallback", () => {
    const [c] = mapComments([
      { id: "c1", author: { displayName: "Olha", avatarUrls: { "24x24": "https://x/o24.png" } }, renderedBody: "<p>ok</p>", created: "2026-09-01T08:00:00.000+0000", updated: "2026-09-01T08:05:00.000+0000" },
    ]);
    expect(c).toEqual({
      commentId: "c1",
      authorName: "Olha",
      authorAvatar: "https://x/o24.png",
      bodyHtml: "<p>ok</p>",
      jiraCreatedAt: "2026-09-01T08:00:00.000Z",
      jiraUpdatedAt: "2026-09-01T08:05:00.000Z",
    });
  });

  it("flattens a worklog's ADF note to plain text", () => {
    const [w] = mapWorklogs([
      {
        id: "w1",
        timeSpent: "2h",
        timeSpentSeconds: 7200,
        started: "2026-09-01T08:00:00.000+0000",
        comment: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "pair " }, { type: "text", text: "review" }] }] },
      },
    ]);
    expect(w.commentHtml).toBe("pair review");
    expect(w.seconds).toBe(7200);
  });

  it("reads attachment metadata off the issue payload itself", () => {
    expect(mapAttachments(rawIssue)).toEqual([
      { attachmentId: "att1", filename: "log.txt", mime: "text/plain", size: 123, authorName: "Olha", jiraCreatedAt: "2026-09-01T09:00:00.000Z" },
    ]);
  });
});

describe("adfText", () => {
  it("returns empty for absent or malformed trees", () => {
    expect(adfText(undefined)).toBe("");
    expect(adfText("plain")).toBe("");
  });
});

describe("pickInProgressTransition", () => {
  const t = (id: string, key: string): JiraTransition => ({
    id,
    name: id,
    to: { id, name: id, statusCategory: { key } },
  });

  it("picks the first transition into the In-Progress category", () => {
    expect(pickInProgressTransition([t("1", "new"), t("2", "indeterminate"), t("3", "indeterminate")])?.id).toBe("2");
  });

  it("yields undefined when the workflow offers none", () => {
    expect(pickInProgressTransition([t("1", "new"), t("4", "done")])).toBeUndefined();
  });
});

describe("jql builders", () => {
  it("rounds the cursor a minute down into Jira's zone-less minute format", () => {
    expect(incrementalJql("KAN", "2026-09-02T10:30:45.000Z")).toBe(
      'project = "KAN" AND updated >= "2026-09-02 10:29" ORDER BY updated ASC',
    );
  });

  it("sweeps the whole project in updated order", () => {
    expect(fullJql("KAN")).toBe('project = "KAN" ORDER BY updated ASC');
  });
});
