import { describe, expect, it } from "vitest";
import {
  adfDoc,
  adfText,
  fullJql,
  incrementalJql,
  mapAttachments,
  mapComments,
  mapIssue,
  mapWorklogs,
  pickInProgressTransition,
} from "../src/jira/jira-map";
import type { JiraRawIssue, JiraTransition } from "../src/jira/jira-client";

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
      jiraUpdatedAt: "2026-09-02T07:00:00.000Z",
    });
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

// The whole reason `adfDoc` exists: a ticket written from the Менеджмент chat is several
// lines, and ADF renders a `\n` inside a text node as nothing at all — so the single-node
// description this replaced arrived in Jira as one run-on paragraph.
describe("adfDoc", () => {
  it("splits blank-line-separated blocks into paragraphs", () => {
    const doc = adfDoc("## Контекст\nЗамовник не бачить історію\n\n## Критерії приймання\n- [ ] видно історію");
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    // `adfDoc` returns `Record<string, unknown>` because that is what Jira's `fields` map
    // takes; the ADF paragraph shape is not expressible there and this test is what asserts
    // it, so the cast names what the assertions below then check node by node.
    const content = doc.content as { type: string; content: { type: string; text?: string }[] }[];
    expect(content).toHaveLength(2);
    expect(content[0]?.content.map((n) => n.text ?? n.type)).toEqual([
      "## Контекст",
      "hardBreak",
      "Замовник не бачить історію",
    ]);
    expect(content[1]?.content.map((n) => n.text ?? n.type)).toEqual([
      "## Критерії приймання",
      "hardBreak",
      "- [ ] видно історію",
    ]);
  });

  it("round-trips through adfText with the line structure preserved", () => {
    // `adfText` concatenates text nodes only, so the two sides agree on the WORDS; the
    // paragraph count above is what proves the structure survived.
    expect(adfText(adfDoc("один\n\nдва"))).toBe("одиндва");
  });

  // Jira reads a present-but-empty description as «clear it», which is exactly what an empty
  // string means here.
  it("yields an empty document for blank text", () => {
    expect(adfDoc("   \n  ").content).toEqual([]);
  });
});
