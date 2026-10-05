import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackApiError, SlackClient } from "../src/slack/slack-client";

type Reply = { status?: number; retryAfter?: string; json: unknown };

// Answers each Slack call from `replies` in order and records which methods were asked.
function stubSlack(replies: Reply[]): string[] {
  const methods: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      methods.push(url.slice(url.lastIndexOf("/") + 1));
      const r = replies.shift();
      if (!r) throw new Error("unexpected Slack call");
      const headers = r.retryAfter === undefined ? undefined : { "Retry-After": r.retryAfter };
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers });
    }),
  );
  return methods;
}

afterEach(() => vi.unstubAllGlobals());

describe("SlackClient.memberChannel", () => {
  it("checks the one channel instead of enumerating the Slack workspace", async () => {
    const methods = stubSlack([{ json: { ok: true, channel: { id: "C1", name: "help", is_member: true } } }]);
    await expect(new SlackClient("xoxb-t").memberChannel("C1")).resolves.toEqual({ id: "C1", name: "help", isPrivate: false });
    expect(methods).toEqual(["conversations.info"]);
  });

  it("is null for a channel the bot is not in, archived, or cannot see", async () => {
    stubSlack([
      { json: { ok: true, channel: { id: "C1", name: "help", is_member: false } } },
      { json: { ok: true, channel: { id: "C2", name: "old", is_member: true, is_archived: true } } },
      { json: { ok: false, error: "channel_not_found" } },
    ]);
    const client = new SlackClient("xoxb-t");
    await expect(client.memberChannel("C1")).resolves.toBeNull();
    await expect(client.memberChannel("C2")).resolves.toBeNull();
    await expect(client.memberChannel("G3")).resolves.toBeNull();
  });
});

describe("SlackClient rate limits", () => {
  it("waits Retry-After and retries a rate-limited call", async () => {
    const methods = stubSlack([
      { status: 429, retryAfter: "0", json: { ok: false, error: "ratelimited" } },
      { json: { ok: true, channels: [{ id: "C2", name: "b" }, { id: "C1", name: "a", is_private: true }] } },
    ]);
    await expect(new SlackClient("xoxb-t").memberChannels()).resolves.toEqual([
      { id: "C1", name: "a", isPrivate: true },
      { id: "C2", name: "b", isPrivate: false },
    ]);
    expect(methods).toEqual(["users.conversations", "users.conversations"]);
  });

  it("reports ratelimited instead of hanging on a long Retry-After", async () => {
    const methods = stubSlack([{ status: 429, retryAfter: "120", json: { ok: false, error: "ratelimited" } }]);
    const err = await new SlackClient("xoxb-t").memberChannels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).error).toBe("ratelimited");
    expect(methods).toHaveLength(1);
  });

  it("gives up after its retries", async () => {
    const limited = { status: 429, retryAfter: "0", json: { ok: false, error: "ratelimited" } };
    const methods = stubSlack([limited, limited, limited]);
    await expect(new SlackClient("xoxb-t").memberChannel("C1")).rejects.toThrow("slack conversations.info: ratelimited");
    expect(methods).toHaveLength(3);
  });
});
