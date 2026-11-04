import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaneClient,
  PlaneHttpError,
  flattenPlaneError,
  normalizePlaneSite,
  planeApiBase,
  planeIssueUrl,
} from "../src/plane/plane-client";

type Call = { url: string; init: RequestInit };
type Canned = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

// Queue of canned responses; every fetch is recorded for assertions on url/method/headers.
function mockFetch(...responses: Canned[]) {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? {};
    const status = r.status ?? 200;
    const empty = status === 204 || (status >= 300 && status < 400);
    const body = empty ? null : (r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json)));
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json", ...r.headers } }));
  });
  return calls;
}

const client = () => new PlaneClient({ siteUrl: "app.plane.so", workspaceSlug: "acme", apiToken: "tok" });
const API = "https://api.plane.so/api/v1/workspaces/acme";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("site addressing", () => {
  it("maps every spelling of Plane Cloud to its web app and keeps a self-hosted origin", () => {
    expect(normalizePlaneSite("plane.so")).toBe("https://app.plane.so");
    expect(normalizePlaneSite("https://api.plane.so/")).toBe("https://app.plane.so");
    expect(normalizePlaneSite("https://app.plane.so/my-team/projects/")).toBe("https://app.plane.so");
    expect(normalizePlaneSite(" plane.acme.dev/acme/browse/WEB-1/ ")).toBe("https://plane.acme.dev");
    expect(normalizePlaneSite("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("talks to api.plane.so for Cloud and to the instance itself when self-hosted", () => {
    expect(planeApiBase("https://app.plane.so")).toBe("https://api.plane.so");
    expect(planeApiBase("https://plane.acme.dev")).toBe("https://plane.acme.dev");
  });

  it("links a work item to its browse page in the web app", () => {
    expect(planeIssueUrl("plane.so", "acme", "WEB-42")).toBe("https://app.plane.so/acme/browse/WEB-42/");
  });
});

describe("flattenPlaneError", () => {
  it("reads each of Plane's error shapes as one line", () => {
    expect(flattenPlaneError(404, { error: "The requested resource does not exist." })).toBe(
      "The requested resource does not exist.",
    );
    expect(flattenPlaneError(400, { detail: "Invalid cursor parameter." })).toBe("Invalid cursor parameter.");
    expect(flattenPlaneError(429, { error_code: 5900, error_message: "RATE_LIMIT_EXCEEDED" })).toBe("RATE_LIMIT_EXCEEDED");
    expect(
      flattenPlaneError(400, { name: ["This field is required."], non_field_errors: ["State is not valid please pass a valid state_id"] }),
    ).toBe("name: This field is required.; State is not valid please pass a valid state_id");
    expect(flattenPlaneError(409, { error: "Label with the same name already exists in the project", id: "l1" })).toBe(
      "Label with the same name already exists in the project",
    );
  });

  it("falls back to the status when the body says nothing", () => {
    expect(flattenPlaneError(502, undefined)).toBe("Plane responded 502");
  });
});

describe("PlaneClient", () => {
  it("sends the key in X-API-Key to the Cloud API host, trailing slash included", async () => {
    const calls = mockFetch({ json: { id: "u1", display_name: "Andrii" } });
    await client().me();
    expect(calls[0]!.url).toBe("https://api.plane.so/api/v1/users/me/");
    expect((calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("tok");
  });

  it("normalises an invalid key to 401 whether Plane said 401 or its 403 token refusal", async () => {
    mockFetch({ status: 403, json: { detail: "Given API token is not valid" } });
    await expect(client().me()).rejects.toMatchObject({ status: 401, message: "Given API token is not valid" });
    mockFetch({ status: 401, json: { detail: "Authentication credentials were not provided." } });
    await expect(client().me()).rejects.toMatchObject({ status: 401 });
  });

  it("keeps a permission refusal a 403 — it is not a dead key", async () => {
    mockFetch({ status: 403, json: { error: "Only admin or creator can delete the work item" } });
    await expect(client().deleteIssue("p1", "i1")).rejects.toMatchObject({
      status: 403,
      message: "Only admin or creator can delete the work item",
    });
  });

  it("reports a 429 with Plane's words and the wait it asks for", async () => {
    mockFetch({ status: 429, json: { error_code: 5900, error_message: "RATE_LIMIT_EXCEEDED" }, headers: { "retry-after": "12" } });
    const err = await client().me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaneHttpError);
    expect(err).toMatchObject({ status: 429, message: "RATE_LIMIT_EXCEEDED (retry in 12s)" });
  });

  it("pages the work-item list newest-first with the mirror's expansions until Plane stops", async () => {
    const calls = mockFetch(
      { json: { results: [{ id: "a" }], next_cursor: "100:1:0", next_page_results: true } },
      { json: { results: [{ id: "b" }], next_cursor: "100:2:0", next_page_results: false } },
    );
    const items = await client().listIssues("p1");
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/api/v1/workspaces/acme/projects/p1/work-items/");
    expect(first.searchParams.get("order_by")).toBe("-updated_at");
    expect(first.searchParams.get("per_page")).toBe("100");
    expect(first.searchParams.get("expand")).toBe("assignees,labels,state,created_by,estimate_point,parent");
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("100:1:0");
  });

  it("stops paging as soon as the caller's predicate says the cutoff is reached", async () => {
    const calls = mockFetch({ json: { results: [{ id: "a", updated_at: "2026-11-01T00:00:00Z" }], next_cursor: "100:1:0", next_page_results: true } });
    const items = await client().listIssues("p1", () => true);
    expect(items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("takes a plain-array answer as the whole list, and flattens the docs' doubly wrapped members", async () => {
    mockFetch({ json: [[{ id: "u1", display_name: "A" }, { id: "u2", display_name: "B" }]] });
    expect((await client().listMembers("p1")).map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("returns the existing label's id when Plane answers 409 to a create", async () => {
    mockFetch({ status: 409, json: { error: "Label with the same name already exists in the project", id: "l-existing" } });
    expect(await client().createLabel("p1", "backend")).toEqual({ id: "l-existing", name: "backend" });
  });

  it("reads a missing estimate route as «no estimate» and a paid-only types route as «no types»", async () => {
    mockFetch({ status: 404, json: { error: "Estimate not found" } });
    expect(await client().getEstimate("p1")).toBeUndefined();
    mockFetch({ status: 402, json: { error: "upgrade", error_code: 1999 } });
    expect(await client().listIssueTypes("p1")).toEqual([]);
  });

  it("uploads in three steps and never sends the key to the storage host", async () => {
    const calls = mockFetch(
      {
        json: {
          upload_data: {
            url: "https://storage.example/bucket/",
            fields: { "Content-Type": "image/png", key: "w/abc-shot.png", policy: "p", "x-amz-signature": "s" },
          },
          asset_id: "att1",
        },
      },
      { status: 204 },
      { status: 204 },
    );
    await client().uploadAttachment("p1", "i1", "shot.png", Buffer.from("png-bytes"), "image/png");

    expect(calls[0]!.url).toBe(`${API}/projects/p1/work-items/i1/attachments/`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "shot.png", type: "image/png", size: 9 });

    expect(calls[1]!.url).toBe("https://storage.example/bucket/");
    expect(calls[1]!.init.headers).toBeUndefined();
    const form = calls[1]!.init.body as FormData;
    // Every presigned field first, the file LAST — S3 ignores fields after the file.
    expect([...form.keys()]).toEqual(["Content-Type", "key", "policy", "x-amz-signature", "file"]);

    expect(calls[2]!.url).toBe(`${API}/projects/p1/work-items/i1/attachments/att1/`);
    expect(calls[2]!.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ is_uploaded: true });
  });

  it("surfaces storage's own refusal sentence for a failed upload", async () => {
    mockFetch(
      { json: { upload_data: { url: "https://storage.example/", fields: {} }, asset_id: "att1" } },
      { status: 400, text: "<Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>" },
    );
    await expect(client().uploadAttachment("p1", "i1", "big.bin", Buffer.from("x"), "")).rejects.toMatchObject({
      status: 400,
      message: "Your proposed upload exceeds the maximum allowed size",
    });
  });

  it("follows the download redirect by hand, without the key", async () => {
    const calls = mockFetch(
      { status: 302, headers: { location: "https://storage.example/obj?sig=1" } },
      { text: "file-bytes", headers: { "content-type": "image/png" } },
    );
    const { body, contentType } = await client().downloadAttachment("p1", "i1", "att1");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect((calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("tok");
    expect(calls[1]!.url).toBe("https://storage.example/obj?sig=1");
    expect(calls[1]!.init.headers).toBeUndefined();
    expect(contentType).toBe("image/png");
    expect(await new Response(body).text()).toBe("file-bytes");
  });
});
