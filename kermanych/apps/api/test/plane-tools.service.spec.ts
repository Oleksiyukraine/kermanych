import { describe, expect, it, vi } from "vitest";
import { renderTicketDescription, type Notice } from "@kermanych/core";
import type { PlaneIntegration } from "@kermanych/cloud";
import { PlaneToolsService } from "../src/plane/plane-tools.service";
import type { PlaneService } from "../src/plane/plane.service";
import type { PlaneClient } from "../src/plane/plane-client";
import type { JiraToolsService } from "../src/jira/jira-tools.service";
import { ManagementMcpService } from "../src/management/management-mcp.service";
import type { ManagementToolScope } from "../src/management/tracker-tools";

const web = {
  id: "i1",
  workspaceId: "w1",
  siteUrl: "https://app.plane.so",
  workspaceSlug: "acme",
  projectId: "p-uuid",
  projectIdentifier: "WEB",
  projectName: "Web",
} as PlaneIntegration;

const TICKET = { title: "Export invoices", context: "Accounting closes the month from a file.", acceptanceCriteria: ["A CSV downloads"] };

const STATES = [
  { id: "s-todo", name: "Todo", group: "unstarted", sequence: 1 },
  { id: "s-wip", name: "In Progress", group: "started", sequence: 1 },
  { id: "s-done", name: "Done", group: "completed", sequence: 1 },
];

function setup(client: Partial<Record<keyof PlaneClient, unknown>>, plane: Partial<Record<keyof PlaneService, unknown>> = {}) {
  const c = { createIssue: vi.fn(async () => ({ id: "n1", sequence_id: 7 })), ...client } as unknown as PlaneClient;
  const svc = {
    listIntegrations: vi.fn(async () => [web]),
    clientFor: vi.fn(() => c),
    // The draft the tool hands the board's body rules, echoed so a test can read what it sent.
    draftBody: vi.fn(async (_i: PlaneIntegration, draft: Record<string, unknown>) => ({ draft })),
    mirrorWrite: vi.fn(async () => undefined),
    mirroredIssues: vi.fn(async () => [{ key: "WEB-3", issueId: "x3" }]),
    statesOf: vi.fn(async () => STATES),
    membersOf: vi.fn(async () => []),
    ...plane,
  } as unknown as PlaneService;
  const changes: Notice[] = [];
  const scope: ManagementToolScope = {
    userId: "u1",
    workspaceId: "w1",
    file: () => undefined,
    downloadDir: "/tmp/none",
    changed: (n) => changes.push(n),
  };
  return { tools: new PlaneToolsService(svc), svc, scope, client: c, changes };
}

describe("plane_create_issue", () => {
  // The ticket reaches Plane through the same renderer jira_create_issue uses, and the board
  // mirror is refreshed for the new item at once.
  it("files the rendered ticket, hands back the key and refreshes the board mirror", async () => {
    const { tools, svc, scope, client, changes } = setup({});
    const out = await tools.call(scope, "plane_create_issue", { ticket: TICKET, priority: "High" });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text)).toMatchObject({ key: "WEB-7", url: "https://app.plane.so/acme/browse/WEB-7/" });
    expect(svc.draftBody).toHaveBeenCalledWith(
      web,
      expect.objectContaining({ summary: "Export invoices", description: renderTicketDescription(TICKET), priority: "high" }),
      "u1",
      true,
    );
    expect(client.createIssue).toHaveBeenCalledWith("p-uuid", { draft: expect.objectContaining({ summary: "Export invoices" }) });
    expect(svc.mirrorWrite).toHaveBeenCalledWith(web, "n1", "u1", "created");
    expect(changes).toEqual([
      { text: "Plane: створено WEB-7 — Export invoices", code: "plane_issue_created", params: { key: "WEB-7", summary: "Export invoices" } },
    ]);
  });

  // Jira's series failure, Plane's way: Plane had the item, the mirror refresh after it failed,
  // and a «failed» answer would have meant no key for the children and a duplicate on retry.
  it("returns the new key and reports the write even when the board mirror cannot be refreshed", async () => {
    const { tools, scope, changes } = setup({}, { mirrorWrite: vi.fn(async () => Promise.reject(new Error("jwt expired"))) });
    const out = await tools.call(scope, "plane_create_issue", { ticket: TICKET });
    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text) as { key: string; warning?: string };
    expect(body.key).toBe("WEB-7");
    expect(body.warning).toContain("jwt expired");
    expect(changes.map((n) => n.code)).toEqual(["plane_issue_created"]);
  });

  it("refuses a ticket carrying an open question", async () => {
    const { tools, scope, client } = setup({});
    const out = await tools.call(scope, "plane_create_issue", { ticket: { ...TICKET, acceptanceCriteria: ["Format TBD"] } });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("відкрите питання");
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  // Plane assigns project members only, and a name is resolved among them: one that fits
  // several comes back with the candidates, an exact one picks its person.
  it("answers an ambiguous assignee with the candidates and creates nothing", async () => {
    const members = [
      { id: "m1", display_name: "Olha K", email: "olha.k@acme.io" },
      { id: "m2", display_name: "Olha P", email: "olha.p@acme.io" },
    ];
    const { tools, svc, scope, client } = setup({}, { membersOf: vi.fn(async () => members) });
    const out = await tools.call(scope, "plane_create_issue", { ticket: TICKET, assignee: "olha" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Olha K <olha.k@acme.io> (m1)");
    expect(out.text).toContain("Olha P <olha.p@acme.io> (m2)");
    expect(client.createIssue).not.toHaveBeenCalled();

    const exact = await tools.call(scope, "plane_create_issue", { ticket: TICKET, assignee: "Olha P" });
    expect(exact.isError).toBe(false);
    expect(svc.draftBody).toHaveBeenCalledWith(web, expect.objectContaining({ assigneeAccountId: "m2" }), "u1", true);
  });
});

describe("scope", () => {
  it("refuses a key from a project the workspace did not connect, before asking Plane", async () => {
    const { tools, svc, scope } = setup({});
    const out = await tools.call(scope, "plane_get_issue", { issueKey: "OPS-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("OPS-1 is not in a connected Plane project");
    expect(out.text).toContain("«Web» (WEB)");
    expect(svc.clientFor).not.toHaveBeenCalled();
  });

  it("tells the model to hand a missing personal key to the operator instead of retrying", async () => {
    const { tools, scope } = setup(
      {},
      {
        clientFor: vi.fn(() => {
          throw new Error("no plane token");
        }),
      },
    );
    const out = await tools.call(scope, "plane_get_issue", { issueKey: "WEB-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("No personal Plane API key for https://app.plane.so/acme");
    expect(out.text).toContain("do not retry");
  });
});

describe("plane_set_state", () => {
  it("moves by state name and reports the state reached", async () => {
    const updateIssue = vi.fn(async () => ({}));
    const { tools, svc, scope, changes } = setup({ updateIssue });
    const out = await tools.call(scope, "plane_set_state", { issueKey: "web-3", state: "done" });
    expect(out.isError).toBe(false);
    expect(updateIssue).toHaveBeenCalledWith("p-uuid", "x3", { state: "s-done" });
    expect(svc.mirrorWrite).toHaveBeenCalledWith(web, "x3", "u1", "fields");
    expect(changes[0]).toMatchObject({ code: "plane_issue_state_changed", params: { key: "WEB-3", state: "Done" } });
  });

  it("lists the project's states when the target is not one of them", async () => {
    const updateIssue = vi.fn();
    const { tools, scope } = setup({ updateIssue });
    const out = await tools.call(scope, "plane_set_state", { issueKey: "WEB-3", state: "Review" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Todo (unstarted), In Progress (started), Done (completed)");
    expect(updateIssue).not.toHaveBeenCalled();
  });
});

// Both trackers ride ONE MCP server: a child lists Jira's tools and Plane's together and a
// call lands on the tool set its name belongs to.
describe("the management MCP endpoint", () => {
  it("lists Jira's tools then Plane's and routes a plane_* call to the Plane tools", async () => {
    const { tools, scope } = setup({ me: vi.fn(async () => ({ id: "pu1", display_name: "Andrii" })) });
    const jira = { list: () => [{ name: "jira_get_myself" }], call: vi.fn() } as unknown as JiraToolsService;
    const mcp = new ManagementMcpService(jira, tools);

    const listed = (await mcp.handle(scope, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    const names = listed.result.tools.map((t) => t.name);
    expect(names[0]).toBe("jira_get_myself");
    expect(names.slice(1).every((n) => n.startsWith("plane_"))).toBe(true);
    expect(names).toEqual(expect.arrayContaining(["plane_search", "plane_get_issue", "plane_create_issue", "plane_set_state", "plane_add_issues_to_cycle"]));

    const called = (await mcp.handle(scope, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "plane_get_myself", arguments: {} },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(called.result.isError).toBe(false);
    expect(JSON.parse(called.result.content[0]!.text)).toEqual({ id: "pu1", name: "Andrii" });
    expect(jira.call).not.toHaveBeenCalled();
  });
});
