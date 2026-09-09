import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearClient, LinearHttpError } from "../src/linear/linear-client";

type Call = { url: string; init: RequestInit };

// Queue of canned GraphQL responses; every fetch is recorded for assertions on
// url/method/headers/body. A response is either `{ data }` or `{ errors }`.
function mockFetch(...responses: { status?: number; json?: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? {};
    const status = r.status ?? 200;
    const body = r.json === undefined ? "" : JSON.stringify(r.json);
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
  });
  return calls;
}

const client = () => new LinearClient({ apiKey: "lin_key" });

const body = (call: Call) => JSON.parse(String(call.init.body)) as { query: string; variables?: Record<string, unknown> };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LinearClient", () => {
  it("sends the api key RAW in Authorization, never prefixed with Bearer", async () => {
    const calls = mockFetch({
      json: { data: { viewer: { id: "u", name: "X" }, organization: { id: "o", name: "Acme", urlKey: "acme" } } },
    });
    await client().identity();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("lin_key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("returns the viewer's display name and the org's urlKey/name from one query", async () => {
    mockFetch({
      json: {
        data: {
          viewer: { id: "u", name: "andrii", displayName: "Andrii D" },
          organization: { id: "o", name: "Acme", urlKey: "acme" },
        },
      },
    });
    expect(await client().identity()).toEqual({
      viewerId: "u",
      viewerName: "Andrii D",
      orgUrlKey: "acme",
      orgName: "Acme",
    });
  });

  it("surfaces an authentication error as a 401 with Linear's presentable message", async () => {
    mockFetch({
      status: 400,
      json: {
        errors: [
          { message: "raw", extensions: { type: "authentication error", userPresentableMessage: "Invalid API key" } },
        ],
      },
    });
    await expect(client().identity()).rejects.toThrowError(
      expect.objectContaining({
        status: 401,
        message: "Invalid API key",
        type: "authentication error",
      }) as LinearHttpError,
    );
  });

  it("treats a top-level errors[] as failure even on a 200, preferring the raw message when there is no extension", async () => {
    mockFetch({ status: 200, json: { errors: [{ message: "Something failed" }] } });
    await expect(client().identity()).rejects.toThrowError(
      expect.objectContaining({ message: "Something failed" }) as LinearHttpError,
    );
  });

  it("falls back to the status when a non-2xx carries no error body", async () => {
    mockFetch({ status: 502, json: undefined });
    await expect(client().identity()).rejects.toThrowError(
      expect.objectContaining({ status: 502, message: "Linear responded 502" }) as LinearHttpError,
    );
  });

  it("pages teams until hasNextPage stops and carries the cursor forward", async () => {
    const calls = mockFetch(
      {
        json: {
          data: {
            teams: {
              nodes: [{ id: "t1", key: "ENG", name: "Engineering" }],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        },
      },
      {
        json: {
          data: {
            teams: { nodes: [{ id: "t2", key: "OPS", name: "Ops" }], pageInfo: { hasNextPage: false, endCursor: "c2" } },
          },
        },
      },
    );
    const teams = await client().listTeams();
    expect(teams).toEqual([
      { id: "t1", key: "ENG", name: "Engineering" },
      { id: "t2", key: "OPS", name: "Ops" },
    ]);
    expect(body(calls[1]!).variables?.after).toBe("c1");
  });

  it("maps a team's workflow states, dropping the color it only asks for as a courtesy", async () => {
    mockFetch({
      json: {
        data: {
          team: {
            states: {
              nodes: [
                { id: "s1", name: "Todo", type: "unstarted", position: 1, color: "#fff" },
                { id: "s2", name: "Doing", type: "started", position: 0, color: "#0f0" },
              ],
            },
          },
        },
      },
    });
    expect(await client().teamStates("t1")).toEqual([
      { id: "s1", name: "Todo", type: "unstarted", position: 1 },
      { id: "s2", name: "Doing", type: "started", position: 0 },
    ]);
  });

  it("filters the incremental search by team and updatedAt, and asks for the inline children", async () => {
    const calls = mockFetch(
      {
        json: {
          data: {
            issues: {
              nodes: [{ id: "i1", identifier: "ENG-1", updatedAt: "2026-09-02T10:00:00.000Z" }],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        },
      },
      {
        json: {
          data: {
            issues: {
              nodes: [{ id: "i2", identifier: "ENG-2", updatedAt: "2026-09-02T11:00:00.000Z" }],
              pageInfo: { hasNextPage: false, endCursor: "c2" },
            },
          },
        },
      },
    );
    const issues = await client().searchIssues("t1", "2026-09-02T09:00:00.000Z");
    expect(issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);

    const first = body(calls[0]!);
    expect(first.query).toContain("comments(first: 50)");
    expect(first.query).toContain("attachments(first: 50)");
    const filter = first.variables?.filter as { team: { id: { eq: string } }; updatedAt: { gt: string } };
    expect(filter.team.id.eq).toBe("t1");
    expect(filter.updatedAt.gt).toBe("2026-09-02T09:00:00.000Z");
    expect(body(calls[1]!).variables?.after).toBe("c1");
  });

  it("omits the updatedAt filter on a full sweep", async () => {
    const calls = mockFetch({ json: { data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    await client().searchIssues("t1");
    const filter = body(calls[0]!).variables?.filter as { team: unknown; updatedAt?: unknown };
    expect("updatedAt" in filter).toBe(false);
  });

  it("fetches one issue by its identifier and refuses a missing one", async () => {
    mockFetch({ json: { data: { issue: { id: "i1", identifier: "ENG-42", updatedAt: "x" } } } });
    expect((await client().getIssue("ENG-42")).identifier).toBe("ENG-42");

    mockFetch({ json: { data: { issue: null } } });
    await expect(client().getIssue("ENG-99")).rejects.toThrowError(
      expect.objectContaining({ status: 404 }) as LinearHttpError,
    );
  });

  it("creates an issue and returns its id + identifier", async () => {
    const calls = mockFetch({ json: { data: { issueCreate: { success: true, issue: { id: "i9", identifier: "ENG-9" } } } } });
    expect(await client().createIssue({ teamId: "t1", title: "x" })).toEqual({ id: "i9", identifier: "ENG-9" });
    expect(body(calls[0]!).variables?.input).toEqual({ teamId: "t1", title: "x" });
  });

  it("throws when issueCreate reports no success", async () => {
    mockFetch({ json: { data: { issueCreate: { success: false, issue: null } } } });
    await expect(client().createIssue({ teamId: "t1" })).rejects.toThrow(/create failed/);
  });

  it("updates an issue by id with the given input", async () => {
    const calls = mockFetch({ json: { data: { issueUpdate: { success: true } } } });
    await expect(client().updateIssue("ENG-1", { stateId: "s2" })).resolves.toBeUndefined();
    expect(body(calls[0]!).variables).toEqual({ id: "ENG-1", input: { stateId: "s2" } });
  });

  it("deletes (archives) an issue and reports a refusal", async () => {
    mockFetch({ json: { data: { issueDelete: { success: true } } } });
    await expect(client().deleteIssue("ENG-1")).resolves.toBeUndefined();

    mockFetch({ json: { data: { issueDelete: { success: false } } } });
    await expect(client().deleteIssue("ENG-2")).rejects.toThrow(/delete failed/);
  });

  it("posts a markdown comment keyed by the issue identifier", async () => {
    const calls = mockFetch({ json: { data: { commentCreate: { success: true, comment: { id: "c1" } } } } });
    expect(await client().addComment("ENG-1", "готово")).toEqual({ id: "c1" });
    expect(body(calls[0]!).variables?.input).toEqual({ issueId: "ENG-1", body: "готово" });
  });

  it("maps team members and labels", async () => {
    mockFetch({
      json: {
        data: {
          team: {
            members: { nodes: [{ id: "u1", name: "andrii", displayName: "Andrii", avatarUrl: "https://x/a.png" }] },
          },
        },
      },
    });
    expect(await client().teamMembers("t1")).toEqual([
      { id: "u1", name: "andrii", displayName: "Andrii", avatarUrl: "https://x/a.png" },
    ]);

    mockFetch({ json: { data: { team: { labels: { nodes: [{ id: "l1", name: "Bug" }] } } } } });
    expect(await client().teamLabels("t1")).toEqual([{ id: "l1", name: "Bug" }]);
  });
});
