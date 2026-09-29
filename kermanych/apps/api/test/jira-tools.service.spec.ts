import { describe, expect, it, vi } from "vitest";
import type { Notice } from "@kermanych/core";
import type { JiraIntegration } from "@kermanych/cloud";
import { JiraToolsService, type JiraToolScope } from "../src/jira/jira-tools.service";
import type { JiraService } from "../src/jira/jira.service";
import type { JiraClient } from "../src/jira/jira-client";

const board = {
  id: "i1",
  workspaceId: "w1",
  siteUrl: "https://team.atlassian.net",
  projectKey: "KRM",
  boardId: 7,
  boardName: "Kermanych board",
} as JiraIntegration;

const TICKET = { title: "Export invoices", context: "Accounting closes the month from a file.", acceptanceCriteria: ["A CSV downloads"] };

const TYPES = [
  { id: "10001", name: "Story", subtask: false, hierarchyLevel: 0 },
  { id: "10002", name: "Subtask", subtask: true, hierarchyLevel: -1 },
  { id: "10000", name: "Epic", subtask: false, hierarchyLevel: 1 },
];

function setup(client: Partial<Record<keyof JiraClient, unknown>>, jira: Partial<Record<keyof JiraService, unknown>> = {}) {
  const c = { createMetaIssueTypes: vi.fn(async () => TYPES), ...client } as unknown as JiraClient;
  const svc = {
    listIntegrations: vi.fn(async () => [board]),
    clientFor: vi.fn(() => c),
    refreshIssue: vi.fn(async () => ({})),
    startDateFieldId: vi.fn(async () => undefined),
    ...jira,
  } as unknown as JiraService;
  const changes: Notice[] = [];
  const scope: JiraToolScope = {
    userId: "u1",
    workspaceId: "w1",
    file: () => undefined,
    downloadDir: "/tmp/none",
    changed: (n) => changes.push(n),
  };
  return { tools: new JiraToolsService(svc), scope, client: c, changes };
}

describe("jira_create_issue", () => {
  // The failure that broke every series: Jira had the issue, the mirror refresh after it
  // failed, and the caller was told «failed» — so no key, no children, and a duplicate on
  // retry. The key must come back whatever happens to the mirror.
  it("returns the new key and reports the write even when the board mirror cannot be refreshed", async () => {
    const createIssue = vi.fn(async () => ({ id: "1", key: "KRM-5" }));
    const { tools, scope, changes } = setup({ createIssue }, { refreshIssue: vi.fn(async () => Promise.reject(new Error("jwt expired"))) });
    const out = await tools.call(scope, "jira_create_issue", { issueType: "story", ticket: TICKET, parentKey: "krm-1" });
    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text) as { key: string; warning?: string };
    expect(body.key).toBe("KRM-5");
    expect(body.warning).toContain("jwt expired");
    const fields = createIssue.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields).toMatchObject({ project: { key: "KRM" }, issuetype: { id: "10001" }, summary: "Export invoices", parent: { key: "KRM-1" } });
    expect(changes).toEqual([
      { text: "Jira: створено KRM-5 — Export invoices", code: "jira_issue_created", params: { key: "KRM-5", summary: "Export invoices" } },
    ]);
  });

  it("names the project's issue types when the one asked for does not exist, and creates nothing", async () => {
    const createIssue = vi.fn();
    const { tools, scope } = setup({ createIssue });
    const out = await tools.call(scope, "jira_create_issue", { issueType: "Sub-task", ticket: TICKET, parentKey: "KRM-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Subtask (id 10002, sub-task)");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("refuses a sub-task without a parent before Jira is asked", async () => {
    const createIssue = vi.fn();
    const { tools, scope } = setup({ createIssue });
    const out = await tools.call(scope, "jira_create_issue", { issueType: "Subtask", ticket: TICKET });
    expect(out).toEqual({ isError: true, text: expect.stringContaining("needs parentKey") });
    expect(createIssue).not.toHaveBeenCalled();
  });

  // The product's ticket rules still gate a NEW Jira issue: an open question never reaches
  // the board, whichever board it is.
  it("refuses a ticket carrying an open question", async () => {
    const { tools, scope } = setup({ createIssue: vi.fn() });
    const out = await tools.call(scope, "jira_create_issue", {
      issueType: "Story",
      ticket: { ...TICKET, acceptanceCriteria: ["Format TBD"] },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("відкрите питання");
  });
});

describe("jira_create_issue_link", () => {
  // Jira documents which end of a stored link reads «blocks», not which end of the POST
  // becomes it. The tool checks the first link it writes and re-creates it the other way
  // round if Jira stored it reversed, so «KRM-1 blocks KRM-2» is what the issue then shows.
  it("reads the stored direction back and fixes a reversed link", async () => {
    const created: { inwardKey: string; outwardKey: string }[] = [];
    let stored: { id: string; type: { name: string; inward: string; outward: string }; inwardIssue?: { key: string }; outwardIssue?: { key: string } }[] = [];
    const blocks = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
    const client = {
      issueLinkTypes: vi.fn(async () => [blocks]),
      createIssueLink: vi.fn(async (x: { inwardKey: string; outwardKey: string }) => {
        created.push(x);
        // This fake Jira stores the POST's inwardIssue as the «blocks» end — the opposite of
        // the tool's first guess — so the read-back from KRM-1 shows KRM-2 as inward.
        stored = [{ id: String(created.length), type: blocks, ...(x.inwardKey === "KRM-1" ? { inwardIssue: { key: "KRM-2" } } : { outwardIssue: { key: "KRM-2" } }) }];
      }),
      issueLinks: vi.fn(async () => stored),
      deleteIssueLink: vi.fn(async () => undefined),
    };
    const { tools, scope } = setup(client);
    const out = await tools.call(scope, "jira_create_issue_link", { issueKey: "KRM-1", type: "Blocks", targetKey: "KRM-2" });
    expect(out.isError).toBe(false);
    expect(client.deleteIssueLink).toHaveBeenCalledWith("1");
    expect(created.at(-1)).toMatchObject({ inwardKey: "KRM-2", outwardKey: "KRM-1" });
    expect(JSON.parse(out.text)).toEqual({ linkId: "2", reads: "KRM-1 blocks KRM-2" });
  });
});

describe("jira_transition_issue", () => {
  const transitions = [
    { id: "21", name: "Start", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } } },
    { id: "31", name: "Finish", to: { id: "4", name: "Done", statusCategory: { key: "done" } } },
  ];

  it("moves by target status name and reports the status reached", async () => {
    const transition = vi.fn(async () => undefined);
    const { tools, scope, changes } = setup({ listTransitions: vi.fn(async () => transitions), transition });
    const out = await tools.call(scope, "jira_transition_issue", { issueKey: "KRM-3", to: "done" });
    expect(out.isError).toBe(false);
    expect(transition).toHaveBeenCalledWith("KRM-3", "31", {});
    expect(changes[0]?.code).toBe("jira_issue_transitioned");
  });

  it("lists the reachable transitions when the target is not one of them", async () => {
    const { tools, scope } = setup({ listTransitions: vi.fn(async () => transitions), transition: vi.fn() });
    const out = await tools.call(scope, "jira_transition_issue", { issueKey: "KRM-3", to: "Review" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Start → In Progress, Finish → Done");
  });
});

describe("scope", () => {
  it("tells the model to hand a missing personal token to the operator instead of retrying", async () => {
    const { tools, scope } = setup(
      {},
      {
        clientFor: vi.fn(() => {
          throw new Error("no jira token");
        }),
      },
    );
    const out = await tools.call(scope, "jira_get_issue", { issueKey: "KRM-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("No personal Jira token for https://team.atlassian.net");
  });
});
