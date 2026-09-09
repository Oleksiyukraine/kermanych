import { describe, expect, it } from "vitest";
import {
  categoryFromStateType,
  dateOnly,
  iso,
  mapAttachments,
  mapComments,
  mapIssue,
  orderStates,
  pickInProgressState,
  sinceCursor,
} from "../src/linear/linear-map";
import type { LinearRawIssue, LinearStateSummary } from "../src/linear/linear-client";

const integration = { id: "i1", workspaceId: "w1" };

const rawIssue: LinearRawIssue = {
  id: "10001",
  identifier: "ENG-42",
  title: "Fix the flux capacitor",
  description: "## Context\nit is broken",
  priority: 2,
  priorityLabel: "High",
  estimate: 3,
  url: "https://linear.app/acme/issue/ENG-42",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000+03:00",
  dueDate: "2026-09-30",
  startedAt: "2026-09-05T08:30:00.000Z",
  sortOrder: 1.5,
  parent: { identifier: "ENG-40" },
  assignee: { id: "acc1", name: "andrii", displayName: "Andrii", avatarUrl: "https://x/a.png" },
  state: { id: "s3", name: "In Progress", type: "started" },
  labels: { nodes: [{ id: "l1", name: "backend", color: "#fff" }, { id: "l2", name: "urgent", color: "#f00" }] },
  comments: { nodes: [] },
  attachments: { nodes: [] },
};

describe("mapIssue", () => {
  it("maps the standard fields, markdown description, label names and normalised timestamp", () => {
    const issue = mapIssue(integration, rawIssue);
    expect(issue).toMatchObject({
      integrationId: "i1",
      workspaceId: "w1",
      issueId: "10001",
      key: "ENG-42",
      title: "Fix the flux capacitor",
      descriptionMd: "## Context\nit is broken",
      priority: 2,
      priorityName: "High",
      estimate: 3,
      labels: ["backend", "urgent"],
      assigneeId: "acc1",
      assigneeName: "Andrii",
      assigneeAvatar: "https://x/a.png",
      stateId: "s3",
      stateName: "In Progress",
      stateCategory: "indeterminate",
      parentKey: "ENG-40",
      url: "https://linear.app/acme/issue/ENG-42",
      dueDate: "2026-09-30",
      // startedAt's day is read-only, verbatim
      startDate: "2026-09-05",
      // +03:00 normalised through Date to a single UTC spelling
      linearUpdatedAt: "2026-09-02T07:00:00.000Z",
    });
  });

  it("degrades an unassigned, parent-less issue to blanks and absent keys instead of crashing", () => {
    const bare = mapIssue(integration, { id: "1", identifier: "ENG-1", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(bare.title).toBe("");
    expect(bare.descriptionMd).toBe("");
    expect(bare.priority).toBe(0);
    expect(bare.priorityName).toBe("");
    expect(bare.estimate).toBe(0);
    expect(bare.labels).toEqual([]);
    expect(bare.stateCategory).toBe("new");
    expect(bare.dueDate).toBe("");
    expect(bare.startDate).toBe("");
    expect("assigneeId" in bare).toBe(false);
    expect("assigneeName" in bare).toBe(false);
    expect("parentKey" in bare).toBe(false);
  });

  it("prefers the assignee's display name but falls back to the raw name", () => {
    const noDisplay = mapIssue(integration, {
      ...rawIssue,
      assignee: { id: "acc2", name: "olha" },
    });
    expect(noDisplay.assigneeName).toBe("olha");
  });
});

describe("categoryFromStateType", () => {
  it("maps Linear's state types to the three mirror categories", () => {
    expect(categoryFromStateType("started")).toBe("indeterminate");
    expect(categoryFromStateType("completed")).toBe("done");
    expect(categoryFromStateType("canceled")).toBe("done");
    expect(categoryFromStateType("triage")).toBe("new");
    expect(categoryFromStateType("backlog")).toBe("new");
    expect(categoryFromStateType("unstarted")).toBe("new");
    expect(categoryFromStateType("duplicate")).toBe("new");
    // A type Linear invents later degrades to «new» rather than crashing.
    expect(categoryFromStateType("whatever")).toBe("new");
  });
});

describe("dateOnly", () => {
  it("keeps a calendar day verbatim, whatever time or zone rides along", () => {
    expect(dateOnly("2026-09-30")).toBe("2026-09-30");
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

describe("iso", () => {
  it("normalises a zoned instant to a single UTC spelling and degrades garbage to the epoch", () => {
    expect(iso("2026-09-02T10:00:00.000+03:00")).toBe("2026-09-02T07:00:00.000Z");
    expect(iso("nonsense")).toBe(new Date(0).toISOString());
    expect(iso(undefined)).toBe(new Date(0).toISOString());
  });
});

describe("orderStates", () => {
  const s = (id: string, name: string, type: string, position: number): LinearStateSummary => ({ id, name, type, position });

  it("orders columns by workflow type group then position, one state each", () => {
    const cols = orderStates([
      s("s5", "Done", "completed", 0),
      s("s2", "Backlog", "backlog", 0),
      s("s4", "Doing", "started", 0),
      s("s1", "Triage", "triage", 0),
      s("s3", "Todo", "unstarted", 0),
    ]);
    expect(cols).toEqual([
      { position: 0, name: "Triage", stateIds: ["s1"] },
      { position: 1, name: "Backlog", stateIds: ["s2"] },
      { position: 2, name: "Todo", stateIds: ["s3"] },
      { position: 3, name: "Doing", stateIds: ["s4"] },
      { position: 4, name: "Done", stateIds: ["s5"] },
    ]);
  });

  it("breaks ties inside a group by the state's own position", () => {
    const cols = orderStates([s("b", "In Review", "started", 2), s("a", "In Progress", "started", 1)]);
    expect(cols.map((c) => c.name)).toEqual(["In Progress", "In Review"]);
  });
});

describe("pickInProgressState", () => {
  const s = (id: string, type: string): LinearStateSummary => ({ id, name: id, type, position: 0 });

  it("picks the first state in the In-Progress category", () => {
    expect(pickInProgressState([s("s1", "unstarted"), s("s2", "started"), s("s3", "started")])?.id).toBe("s2");
  });

  it("yields undefined when the workflow offers none", () => {
    expect(pickInProgressState([s("s1", "backlog"), s("s2", "completed")])).toBeUndefined();
  });
});

describe("sinceCursor", () => {
  it("rounds the cursor one minute down, the same slack the incremental poll needs", () => {
    expect(sinceCursor("2026-09-02T10:30:45.000Z")).toBe("2026-09-02T10:29:45.000Z");
  });
});

describe("children mappers", () => {
  it("maps comments with the author's name and avatar, and markdown body", () => {
    expect(
      mapComments([
        {
          id: "c1",
          body: "готово",
          user: { id: "u1", name: "Olha", avatarUrl: "https://x/o.png" },
          createdAt: "2026-09-01T08:00:00.000+0000",
          updatedAt: "2026-09-01T08:05:00.000+0000",
        },
      ]),
    ).toEqual([
      {
        commentId: "c1",
        authorName: "Olha",
        authorAvatar: "https://x/o.png",
        bodyMd: "готово",
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:05:00.000Z",
      },
    ]);
  });

  it("blanks a comment whose author Linear omitted (a deleted account)", () => {
    const [c] = mapComments([{ id: "c2", body: null, user: null, createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z" }]);
    expect(c!.authorName).toBe("");
    expect(c!.authorAvatar).toBe("");
    expect(c!.bodyMd).toBe("");
  });

  it("maps attachments as read-only links", () => {
    expect(
      mapAttachments([
        { id: "a1", title: "Design", subtitle: "Figma", url: "https://figma/x", createdAt: "2026-09-01T09:00:00.000+0000" },
      ]),
    ).toEqual([
      { attachmentId: "a1", title: "Design", subtitle: "Figma", url: "https://figma/x", createdAt: "2026-09-01T09:00:00.000Z" },
    ]);
  });
});
