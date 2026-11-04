import { describe, expect, it } from "vitest";
import {
  buildColumns,
  formatMinutes,
  laterIso,
  mapAttachments,
  mapComments,
  mapIssue,
  mapWorklogs,
  parseDurationToMinutes,
  pickChildrenDue,
  sinceCursor,
  toPlaneDate,
} from "../src/plane/plane-map";
import type { PlaneRawIssue } from "../src/plane/plane-client";

const ctx = { id: "i1", workspaceId: "w1", projectIdentifier: "WEB", assetBase: "https://api.plane.so" };

// A work item with ISSUE_EXPAND applied, as the list and the by-key read return it.
const raw: PlaneRawIssue = {
  id: "e1c25c66",
  name: "Fix the flux capacitor",
  description_html: "<p>details</p>",
  priority: "high",
  sequence_id: 42,
  state: { id: "s-wip", name: "In Progress", group: "started", color: "#f59e0b" },
  assignees: [
    { id: "u1", display_name: "Andrii", avatar_url: "/api/assets/v2/static/u1.png" },
    { id: "u2", display_name: "Olha" },
  ],
  labels: [{ id: "l1", name: "backend" }, { id: "l2", name: "urgent-fix" }],
  estimate_point: { id: "ep1", key: 3, value: "90" },
  parent: { id: "par", sequence_id: 7, project_id: "p1" },
  start_date: "2026-11-01",
  target_date: "2026-11-30T00:00:00+05:30",
  created_by: { id: "u3", first_name: "Iryna", last_name: "K" },
  updated_at: "2026-11-04T15:30:00+05:30",
};

describe("mapIssue", () => {
  it("maps an expanded work item into the mirror's Jira-shaped fields", () => {
    const issue = mapIssue(ctx, raw, 90);
    expect(issue).toMatchObject({
      integrationId: "i1",
      workspaceId: "w1",
      issueId: "e1c25c66",
      key: "WEB-42",
      summary: "Fix the flux capacitor",
      descriptionHtml: "<p>details</p>",
      priority: "high",
      labels: ["backend", "urgent-fix"],
      estimatePointId: "ep1",
      estimate: "90",
      // Not a time estimate: points are never hours.
      originalEstimateSeconds: 0,
      timeSpent: "1h 30m",
      timeSpentSeconds: 5400,
      startDate: "2026-11-01",
      dueDate: "2026-11-30",
      // The FIRST assignee is the card's one person.
      assigneeAccountId: "u1",
      assigneeName: "Andrii",
      assigneeAvatar: "https://api.plane.so/api/assets/v2/static/u1.png",
      reporterName: "Iryna K",
      statusId: "s-wip",
      statusName: "In Progress",
      statusCategory: "indeterminate",
      parentKey: "WEB-7",
      // Re-zoned to UTC so the cursor compares one spelling.
      planeUpdatedAt: "2026-11-04T10:00:00.000Z",
    });
  });

  it("reads a time estimate as minutes and shows it as a duration", () => {
    const issue = mapIssue({ ...ctx, estimateType: "time" }, raw);
    expect(issue.originalEstimateSeconds).toBe(5400);
    expect(issue.estimate).toBe("1h 30m");
  });

  it("degrades bare-uuid relations and unknown values to blanks instead of failing", () => {
    const issue = mapIssue(ctx, {
      id: "x",
      sequence_id: 1,
      state: "s-raw",
      assignees: ["u9"],
      labels: ["l9"],
      priority: "critical",
      estimate_point: null,
      parent: "par-uuid",
      type: "t1",
      updated_at: "not a date",
    });
    expect(issue).toMatchObject({
      key: "WEB-1",
      statusId: "s-raw",
      statusName: "",
      statusCategory: "new",
      assigneeAccountId: "u9",
      labels: [],
      priority: "none",
      estimate: "",
      typeName: "",
      planeUpdatedAt: "1970-01-01T00:00:00.000Z",
    });
    expect("assigneeName" in issue).toBe(false);
    expect("parentKey" in issue).toBe(false);
    expect("estimatePointId" in issue).toBe(false);
  });

  it("names the work-item type from the project's type list", () => {
    const typeNames = new Map([["t1", "Bug"]]);
    expect(mapIssue({ ...ctx, typeNames }, { ...raw, type: "t1" }).typeName).toBe("Bug");
    expect(mapIssue({ ...ctx, typeNames }, { ...raw, type: null, type_id: "t1" }).typeName).toBe("Bug");
  });

  it("maps the state groups onto Jira's three categories", () => {
    const category = (group: string) => mapIssue(ctx, { ...raw, state: { id: "s", name: "S", group } }).statusCategory;
    expect(["backlog", "unstarted", "started", "completed", "cancelled"].map(category)).toEqual([
      "new",
      "new",
      "indeterminate",
      "done",
      "done",
    ]);
  });
});

describe("buildColumns", () => {
  it("orders states by group, then by Plane's sequence, one column each", () => {
    const columns = buildColumns([
      { id: "done", name: "Done", group: "completed", sequence: 1, color: "#0f0" },
      { id: "todo2", name: "Ready", group: "unstarted", sequence: 20 },
      { id: "odd", name: "Someday", group: "icebox", sequence: 1 },
      { id: "todo1", name: "Todo", group: "unstarted", sequence: 10 },
      { id: "backlog", name: "Backlog", group: "backlog", sequence: 5 },
      { id: "wip", name: "In Progress", group: "started", sequence: 1 },
      { id: "cancel", name: "Cancelled", group: "cancelled", sequence: 1 },
    ]);
    expect(columns.map((c) => c.name)).toEqual(["Backlog", "Todo", "Ready", "In Progress", "Done", "Cancelled", "Someday"]);
    expect(columns[4]).toEqual({ position: 4, name: "Done", stateIds: ["done"], stateGroup: "completed", color: "#0f0" });
  });
});

describe("durations", () => {
  it("parses Jira's spelling into whole minutes", () => {
    expect(parseDurationToMinutes("3h 20m")).toBe(200);
    expect(parseDurationToMinutes("3h20m")).toBe(200);
    expect(parseDurationToMinutes("45m")).toBe(45);
    expect(parseDurationToMinutes("1.5h")).toBe(90);
    expect(parseDurationToMinutes("1,5h")).toBe(90);
    expect(parseDurationToMinutes(" 2H ")).toBe(120);
    expect(parseDurationToMinutes("30")).toBe(30);
  });

  it("refuses anything else rather than logging a guess", () => {
    for (const bad of ["", "soon", "1d", "h", "2h 2h", "m 5", "0m", "-1h"])
      expect(() => parseDurationToMinutes(bad), bad).toThrow();
  });

  it("formats minutes in hours and minutes, blank for none", () => {
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(0)).toBe("");
  });
});

describe("children", () => {
  const people = new Map([["u1", { id: "u1", display_name: "Andrii", avatar: "https://x/a.png" }]]);

  it("maps worklogs from Plane's minutes, with created_at as the start", () => {
    expect(
      mapWorklogs(
        [{ id: "wl1", duration: 90, description: "pairing", logged_by: "u1", created_at: "2026-11-04T09:00:00Z" }],
        people,
      ),
    ).toEqual([
      {
        worklogId: "wl1",
        authorAccountId: "u1",
        authorName: "Andrii",
        authorAvatar: "https://x/a.png",
        timeSpent: "1h 30m",
        seconds: 5400,
        startedAt: "2026-11-04T09:00:00.000Z",
        description: "pairing",
      },
    ]);
  });

  it("maps comments from their expanded actor", () => {
    const [c] = mapComments([
      { id: "c1", comment_html: "<p>hi</p>", actor: { id: "u1", display_name: "Andrii" }, created_at: "2026-11-04T09:00:00Z" },
    ]);
    expect(c).toEqual({
      commentId: "c1",
      authorName: "Andrii",
      authorAvatar: "",
      bodyHtml: "<p>hi</p>",
      planeCreatedAt: "2026-11-04T09:00:00.000Z",
      planeUpdatedAt: "2026-11-04T09:00:00.000Z",
    });
  });

  it("maps attachments from their attributes and skips unfinished uploads", () => {
    expect(
      mapAttachments(
        [
          { id: "a1", attributes: { name: "shot.png", size: 1024, type: "image/png" }, created_by: "u1", created_at: "2026-11-04T09:00:00Z" },
          { id: "a2", attributes: { name: "half.png" }, is_uploaded: false, created_at: "2026-11-04T09:00:00Z" },
        ],
        people,
      ),
    ).toEqual([
      { attachmentId: "a1", filename: "shot.png", mime: "image/png", size: 1024, authorName: "Andrii", planeCreatedAt: "2026-11-04T09:00:00.000Z" },
    ]);
  });
});

describe("pickChildrenDue", () => {
  const row = (issueId: string, planeUpdatedAt: string, childrenSyncedAt?: string, timeSpentSeconds = 0) => ({
    issueId,
    planeUpdatedAt,
    timeSpentSeconds,
    ...(childrenSyncedAt ? { childrenSyncedAt } : {}),
  });

  it("queues never-synced items, items changed since their refresh, and moved worklog totals", () => {
    const due = pickChildrenDue(
      [
        row("fresh", "2026-11-04T10:00:00Z", "2026-11-04T10:05:00Z"),
        row("never", "2026-11-04T10:00:00Z"),
        row("changed", "2026-11-04T10:10:00Z", "2026-11-04T10:05:00Z"),
        row("logged", "2026-11-04T10:00:00Z", "2026-11-04T10:05:00Z", 0),
      ],
      new Map([["logged", 30]]),
      5,
    );
    expect(due.sort()).toEqual(["changed", "logged", "never"]);
  });

  it("ignores totals when the project has no time tracking", () => {
    expect(pickChildrenDue([row("a", "2026-11-04T10:00:00Z", "2026-11-04T10:05:00Z", 600)], undefined, 5)).toEqual([]);
  });

  it("drains oldest refresh first and never more than the limit", () => {
    const due = pickChildrenDue(
      [
        row("newer", "2026-11-04T12:00:00Z", "2026-11-04T11:00:00Z"),
        row("older", "2026-11-04T12:00:00Z", "2026-11-04T09:00:00Z"),
        row("never", "2026-11-04T12:00:00Z"),
      ],
      undefined,
      2,
    );
    expect(due).toEqual(["never", "older"]);
  });
});

describe("cursor and dates", () => {
  it("re-reads one minute behind the cursor", () => {
    expect(sinceCursor("2026-11-04T10:00:00.000Z")).toBe("2026-11-04T09:59:00.000Z");
  });

  it("stamps the later of now and Plane's own clock", () => {
    expect(laterIso("2026-11-04T10:00:00.000Z", "2026-11-04T10:00:05.000Z")).toBe("2026-11-04T10:00:05.000Z");
  });

  it("sends a blank date as null and refuses a non-date", () => {
    expect(toPlaneDate("")).toBeNull();
    expect(toPlaneDate("2026-11-30")).toBe("2026-11-30");
    expect(() => toPlaneDate("2026-02-31")).toThrow(/invalid date/);
  });
});
