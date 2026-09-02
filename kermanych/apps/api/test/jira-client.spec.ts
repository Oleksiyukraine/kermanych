import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraClient, JiraHttpError, flattenJiraError, normalizeSiteUrl } from "../src/jira/jira-client";

type Call = { url: string; init: RequestInit };

// Queue of canned responses; every fetch is recorded for assertions on url/method/headers.
function mockFetch(...responses: { status?: number; json?: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? {};
    const status = r.status ?? 200;
    const body = status === 204 ? null : r.json === undefined ? "" : JSON.stringify(r.json);
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
  });
  return calls;
}

const client = () => new JiraClient({ siteUrl: "team.atlassian.net", email: "a@b.c", apiToken: "tok" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeSiteUrl", () => {
  it("prefixes https and strips trailing slashes", () => {
    expect(normalizeSiteUrl(" team.atlassian.net/ ")).toBe("https://team.atlassian.net");
    expect(normalizeSiteUrl("http://jira.local")).toBe("http://jira.local");
  });
});

describe("flattenJiraError", () => {
  it("joins errorMessages and field errors into one line", () => {
    expect(
      flattenJiraError(400, { errorMessages: ["It is broken"], errors: { summary: "required" } }),
    ).toBe("It is broken; summary: required");
  });

  it("falls back to the status when the body says nothing", () => {
    expect(flattenJiraError(502, undefined)).toBe("Jira responded 502");
  });
});

describe("JiraClient", () => {
  it("sends Basic auth built from email:token", async () => {
    const calls = mockFetch({ json: { accountId: "x", displayName: "X" } });
    await client().myself();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
    expect(calls[0]!.url).toBe("https://team.atlassian.net/rest/api/3/myself");
  });

  it("throws JiraHttpError with the flattened Jira message", async () => {
    mockFetch({ status: 401, json: { errorMessages: ["Client must be authenticated"] } });
    await expect(client().myself()).rejects.toThrowError(
      expect.objectContaining({ status: 401, message: "Client must be authenticated" }) as JiraHttpError,
    );
  });

  it("pages boards until isLast and keeps only located project keys", async () => {
    const calls = mockFetch(
      {
        json: {
          values: [{ id: 1, name: "KAN board", type: "kanban", location: { projectKey: "KAN" } }],
          isLast: false,
        },
      },
      { json: { values: [{ id: 2, name: "Ops", type: "scrum" }], isLast: true } },
    );
    const boards = await client().listBoards();
    expect(boards).toEqual([
      { id: 1, name: "KAN board", type: "kanban", projectKey: "KAN" },
      { id: 2, name: "Ops", type: "scrum" },
    ]);
    expect(calls[1]!.url).toContain("startAt=50");
  });

  it("maps a board configuration to name + statusIds pairs", async () => {
    mockFetch({
      json: {
        columnConfig: {
          columns: [
            { name: "To Do", statuses: [{ id: "1" }] },
            { name: "In Progress", statuses: [{ id: "3" }, { id: "4" }] },
          ],
        },
      },
    });
    expect(await client().boardConfiguration(7)).toEqual([
      { name: "To Do", statusIds: ["1"] },
      { name: "In Progress", statusIds: ["3", "4"] },
    ]);
  });

  it("follows the search nextPageToken until Jira stops issuing one", async () => {
    const calls = mockFetch(
      { json: { issues: [{ id: "1", key: "K-1", fields: {} }], nextPageToken: "t2" } },
      { json: { issues: [{ id: "2", key: "K-2", fields: {} }] } },
    );
    const issues = await client().searchIssues("project = K");
    expect(issues.map((i) => i.key)).toEqual(["K-1", "K-2"]);
    const second = JSON.parse(String(calls[1]!.init.body)) as { nextPageToken?: string; expand?: string };
    expect(second.nextPageToken).toBe("t2");
    expect(second.expand).toBe("renderedFields");
    expect(calls[0]!.url).toBe("https://team.atlassian.net/rest/api/3/search/jql");
  });

  it("names the standard fields plus the site's start-date field on both issue fetches", async () => {
    const calls = mockFetch({ json: { issues: [] } }, { json: { id: "1", key: "K-1", fields: {} } });
    await client().searchIssues("project = K", "customfield_10015");
    await client().getIssue("K-1", "customfield_10015");

    const searched = JSON.parse(String(calls[0]!.init.body)) as { fields: string[] };
    expect(searched.fields).toContain("duedate");
    expect(searched.fields).toContain("customfield_10015");
    expect(calls[1]!.url).toContain("duedate");
    expect(calls[1]!.url).toContain("customfield_10015");
  });

  it("asks for no start-date field when the site has none", async () => {
    const calls = mockFetch({ json: { issues: [] } });
    await client().searchIssues("project = K");
    const searched = JSON.parse(String(calls[0]!.init.body)) as { fields: string[] };
    expect(searched.fields).toContain("duedate");
    expect(searched.fields.some((f) => f.startsWith("customfield_"))).toBe(false);
  });

  it("de-duplicates project statuses shared across issue types", async () => {
    mockFetch({
      json: [
        { statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }] },
        {
          statuses: [
            { id: "1", name: "To Do", statusCategory: { key: "new" } },
            { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
          ],
        },
      ],
    });
    expect(await client().projectStatuses("KAN")).toEqual([
      { id: "1", name: "To Do", categoryKey: "new" },
      { id: "3", name: "In Progress", categoryKey: "indeterminate" },
    ]);
  });

  it("wraps a plain comment into a one-paragraph ADF document", async () => {
    const calls = mockFetch({ json: { id: "c1" } });
    await client().addComment("KAN-1", "готово");
    const body = JSON.parse(String(calls[0]!.init.body)) as { body: { content: unknown[] } };
    expect(body.body).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "готово" }] }],
    });
  });

  it("tolerates Jira's empty 204 answers on transition", async () => {
    mockFetch({ status: 204 });
    await expect(client().transition("KAN-1", "31")).resolves.toBeUndefined();
  });
});
