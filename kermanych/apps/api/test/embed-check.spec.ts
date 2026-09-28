import { describe, expect, it } from "vitest";
import { checkEmbeddable, frameRefusal } from "../src/docs/embed-check";

const h = (init: Record<string, string>) => new Headers(init);

describe("frameRefusal", () => {
  it("allows a page that sends neither header", () => expect(frameRefusal(h({}))).toBeNull());
  it("refuses X-Frame-Options DENY and SAMEORIGIN, case-insensitively", () => {
    expect(frameRefusal(h({ "x-frame-options": "DENY" }))).toBe("x-frame-options");
    expect(frameRefusal(h({ "x-frame-options": "sameorigin" }))).toBe("x-frame-options");
  });
  it("ignores the obsolete ALLOW-FROM", () =>
    expect(frameRefusal(h({ "x-frame-options": "ALLOW-FROM https://a.example" }))).toBeNull());
  it("refuses frame-ancestors that lists only specific origins", () =>
    expect(frameRefusal(h({ "content-security-policy": "default-src 'self'; frame-ancestors 'self' https://a.example" }))).toBe(
      "frame-ancestors",
    ));
  it("lets a frame-ancestors wildcard override X-Frame-Options", () =>
    expect(frameRefusal(h({ "content-security-policy": "frame-ancestors *", "x-frame-options": "DENY" }))).toBeNull());
  it("refuses when any one of several CSP policies excludes the app", () =>
    expect(frameRefusal(h({ "content-security-policy": "frame-ancestors *, script-src 'self'; frame-ancestors 'none'" }))).toBe(
      "frame-ancestors",
    ));
  it("does not treat a CSP without frame-ancestors as a refusal", () =>
    expect(frameRefusal(h({ "content-security-policy": "script-src 'self'" }))).toBeNull());
});

describe("checkEmbeddable", () => {
  it("reads the headers of the page the request finally landed on", async () => {
    const fetchImpl = (async () => new Response("", { status: 200, headers: { "x-frame-options": "DENY" } })) as typeof fetch;
    await expect(checkEmbeddable("https://docs.google.com/document/d/x/preview", fetchImpl)).resolves.toEqual({
      embeddable: false,
      reason: "x-frame-options",
      status: 200,
    });
  });

  it("reports an unreachable page as unknown rather than refused", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(checkEmbeddable("https://nowhere.invalid/", fetchImpl)).resolves.toEqual({ embeddable: null, reason: "unreachable" });
  });

  it("refuses a non-web URL without fetching it", async () => {
    await expect(checkEmbeddable("file:///etc/passwd", (() => { throw new Error("fetched"); }) as typeof fetch)).rejects.toThrow(
      "only http(s)",
    );
  });
});
