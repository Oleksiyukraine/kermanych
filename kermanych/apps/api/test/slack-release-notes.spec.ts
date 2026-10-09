// apps/api/test/slack-release-notes.spec.ts
// Release notes → Slack: the PKCE round trip that gets a member's own user token, and the
// send that posts a note under it. Real SlackClient against a stubbed `fetch`, real
// registry in memory, the cloud rows mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseNotesSlack, WorkspaceReleaseNote } from "@kermanych/cloud";

const cloud = vi.hoisted(() => ({
  settings: undefined as ReleaseNotesSlack | undefined,
  note: undefined as WorkspaceReleaseNote | undefined,
  upserted: [] as unknown[],
}));
vi.mock("@kermanych/cloud", () => ({
  getReleaseNotesSlack: async () => cloud.settings,
  getWorkspaceReleaseNote: async () => cloud.note,
  upsertReleaseNotesSlack: async (_c: unknown, input: unknown) => {
    cloud.upserted.push(input);
    return input;
  },
  deleteReleaseNotesSlack: async () => undefined,
}));

import { RegistryService } from "../src/registry/registry.service";
import type { AuthService } from "../src/auth/auth.service";
import { SlackReleaseNotesService } from "../src/slack/slack-release-notes.service";
import { pkceChallenge, SLACK_OAUTH_REDIRECT } from "../src/slack/slack-oauth";

type Call = { method: string; auth: string | null; params: URLSearchParams };

// Answers each Slack call from `replies` in order and records what was asked.
function stubSlack(replies: unknown[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: URLSearchParams }) => {
      calls.push({ method: url.slice(url.lastIndexOf("/") + 1), auth: init.headers.Authorization ?? null, params: init.body });
      const r = replies.shift();
      if (!r) throw new Error("unexpected Slack call");
      return new Response(JSON.stringify(r));
    }),
  );
  return calls;
}

const settings = (over: Partial<ReleaseNotesSlack> = {}): ReleaseNotesSlack => ({
  id: "s1",
  workspaceId: "w1",
  clientId: "111.222",
  teamId: "T1",
  teamName: "Acme",
  channelId: "C9",
  channelName: "releases",
  createdAt: "",
  updatedAt: "",
  ...over,
});

const note = (over: Partial<WorkspaceReleaseNote> = {}): WorkspaceReleaseNote => ({
  id: "n1",
  workspaceId: "w1",
  projectName: "app",
  branch: "main",
  rangeFrom: "2026-09-01",
  rangeTo: "2026-09-30",
  title: "September",
  bodyMd: "# September\n\n**New:** export to PDF",
  createdAt: "",
  updatedAt: "",
  ...over,
});

let registry: RegistryService;
let svc: SlackReleaseNotesService;

function storeToken(teamId = "T1"): void {
  registry.setSlackUserToken("u1", {
    workspaceId: "w1",
    accessToken: "xoxp-me",
    clientId: "111.222",
    teamId,
    teamName: teamId === "T1" ? "Acme" : "Other",
    slackUserId: "U1",
    slackUserName: "andrii",
  });
}

beforeEach(() => {
  cloud.settings = undefined;
  cloud.note = undefined;
  cloud.upserted = [];
  registry = new RegistryService(":memory:");
  svc = new SlackReleaseNotesService(registry, { cloudClient: () => ({}) } as unknown as AuthService);
});

afterEach(() => vi.unstubAllGlobals());

describe("pkceChallenge", () => {
  // RFC 7636 Appendix B, and the example in Slack's PKCE guide. Plain base64 (padding, +/)
  // would be a challenge Slack never matches.
  it("is the base64url SHA-256 of the verifier", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(pkceChallenge("secretpassword")).toBe("ldMBaaWcQYtSATMV_IG8mf3wp7A6EW80arYoSW80ntU");
  });
});

describe("SlackReleaseNotesService — connecting a member's Slack account", () => {
  it("exchanges the code with the verifier of the URL it handed out, without a token or secret", async () => {
    cloud.settings = settings();
    const { url } = await svc.authorize("w1", "u1");
    const authorize = new URL(url);
    expect(authorize.searchParams.get("client_id")).toBe("111.222");
    expect(authorize.searchParams.get("redirect_uri")).toBe(SLACK_OAUTH_REDIRECT);

    const calls = stubSlack([
      { ok: true, authed_user: { id: "U1", access_token: "xoxp-me", scope: "chat:write,channels:read,groups:read" }, team: { id: "T1", name: "Acme" } },
      { ok: true, team_id: "T1", team: "Acme", user_id: "U1", user: "andrii" },
    ]);
    await expect(svc.completeAuthorize("w1", "u1", "the-code")).resolves.toEqual({
      connected: true,
      teamName: "Acme",
      userName: "andrii",
      clientId: "111.222",
    });

    const exchange = calls[0]!;
    expect(exchange.method).toBe("oauth.v2.access");
    expect(exchange.auth).toBeNull();
    expect(exchange.params.get("client_secret")).toBeNull();
    expect(pkceChallenge(exchange.params.get("code_verifier")!)).toBe(authorize.searchParams.get("code_challenge"));
    expect(registry.getSlackUserToken("w1", "u1")?.accessToken).toBe("xoxp-me");
  });

  it("refuses an account from another Slack workspace than the channel's", async () => {
    cloud.settings = settings();
    await svc.authorize("w1", "u1");
    stubSlack([
      { ok: true, authed_user: { id: "U7", access_token: "xoxp-x", scope: "chat:write" }, team: { id: "T2", name: "Other" } },
      { ok: true, team_id: "T2", team: "Other", user_id: "U7", user: "x" },
    ]);
    await expect(svc.completeAuthorize("w1", "u1", "c")).rejects.toThrow("«Other», but release notes go to «Acme»");
    expect(registry.getSlackUserToken("w1", "u1")).toBeUndefined();
  });

  it("needs a Client ID to start", async () => {
    await expect(svc.authorize("w1", "u1")).rejects.toThrow("Client ID first");
    await expect(svc.authorize("w1", "u1", "my-app")).rejects.toThrow("is not a Slack Client ID");
  });
});

describe("SlackReleaseNotesService — sending a note", () => {
  it("posts the note as one channel message, as the member, in Slack's markup", async () => {
    cloud.settings = settings();
    cloud.note = note();
    storeToken();
    const calls = stubSlack([{ ok: true, ts: "100.1" }]);
    await expect(svc.send("w1", "u1", "n1")).resolves.toEqual({ channelName: "releases", ts: "100.1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe("Bearer xoxp-me");
    expect(calls[0]!.params.get("channel")).toBe("C9");
    expect(calls[0]!.params.get("thread_ts")).toBeNull();
    expect(calls[0]!.params.get("text")).toBe("*September*\n\n*New:* export to PDF");
  });

  it("continues a note longer than one message in that message's thread", async () => {
    cloud.settings = settings();
    const para = "word ".repeat(500).trim();
    cloud.note = note({ bodyMd: `${para}\n\n${para}\n\n${para}` });
    storeToken();
    const calls = stubSlack([{ ok: true, ts: "100.1" }, { ok: true, ts: "100.2" }, { ok: true, ts: "100.3" }]);
    await svc.send("w1", "u1", "n1");
    expect(calls.map((c) => c.params.get("thread_ts"))).toEqual([null, "100.1", "100.1"]);
  });

  it("refuses a note of another workspace", async () => {
    cloud.settings = settings();
    cloud.note = note({ workspaceId: "w2" });
    storeToken();
    stubSlack([]);
    await expect(svc.send("w1", "u1", "n1")).rejects.toThrow("not in the workspace");
  });

  it("says to join the channel when the member is not in it", async () => {
    cloud.settings = settings();
    cloud.note = note();
    storeToken();
    stubSlack([{ ok: false, error: "not_in_channel" }]);
    await expect(svc.send("w1", "u1", "n1")).rejects.toThrow("you are not a member of #releases");
  });

  it("refuses an account of another Slack workspace instead of posting there", async () => {
    cloud.settings = settings();
    cloud.note = note();
    storeToken("T2");
    stubSlack([]);
    await expect(svc.send("w1", "u1", "n1")).rejects.toThrow("connect again");
  });
});
