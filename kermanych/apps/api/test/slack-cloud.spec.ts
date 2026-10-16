// apps/api/test/slack-cloud.spec.ts
// Cloud answers from the desktop side: this machine holds no Slack socket for a workspace in
// cloud mode, and the owner's setup proves the AI key and carries this machine's bot token
// before anything reaches the cloud. Real registry in memory, the cloud rows mocked, the AI
// provider behind a stubbed `fetch`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloud = vi.hoisted(() => ({
  integration: undefined as unknown,
  status: undefined as unknown,
  set: [] as unknown[],
}));
vi.mock("@kermanych/cloud", () => ({
  getSlackIntegration: async () => cloud.integration,
  getSlackCloudStatus: async () => cloud.status,
  setSlackCloud: async (_c: unknown, input: Record<string, unknown>) => {
    cloud.set.push(input);
    cloud.status = { workspaceId: input.workspaceId, enabled: input.enabled, aiProvider: input.aiProvider, aiModel: input.aiModel, aiKeyHint: "1234", updatedAt: "now" };
  },
  deleteSlackCloud: async () => {
    cloud.status = undefined;
  },
  deleteSlackIntegration: async () => undefined,
  upsertSlackIntegration: async () => undefined,
  getDocIndexState: async () => ({ fileCount: 0 }),
  listProjects: async () => [],
  listWorkspaces: async () => [],
  searchProjectDocs: async () => ({ fragments: [] }),
}));

import { RegistryService } from "../src/registry/registry.service";
import type { AuthService } from "../src/auth/auth.service";
import { SlackService } from "../src/slack/slack.service";
import type { SlackClient } from "../src/slack/slack-client";
import type { SlackSocket } from "../src/slack/slack-socket";

let registry: RegistryService;
let svc: SlackService;
let sockets: Array<{ started: boolean; stopped: boolean }>;
let teamId = "T1";

beforeEach(() => {
  registry = new RegistryService(":memory:");
  registry.setSlackToken("u1", { workspaceId: "w1", botToken: "xoxb-1", appToken: "xapp-1", teamId: "T1", teamName: "Acme", botUserId: "UB" });
  sockets = [];
  cloud.integration = { workspaceId: "w1", teamId: "T1", teamName: "Acme", channelId: "C1" };
  cloud.status = undefined;
  cloud.set = [];
  teamId = "T1";
  const auth = { current: () => ({ userId: "u1" }), cloudClient: () => ({}) } as unknown as AuthService;
  svc = new SlackService(
    registry,
    auth,
    () => ({ authTest: async () => ({ teamId, teamName: teamId === "T1" ? "Acme" : "Other", botUserId: "UB" }) }) as unknown as SlackClient,
    () => {
      const s = { started: false, stopped: false };
      sockets.push(s);
      return { start: () => (s.started = true), stop: () => (s.stopped = true), isOpen: () => false } as unknown as SlackSocket;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function stubAi(reply: { status: number; body: unknown }) {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  return calls;
}

describe("sockets follow the mode", () => {
  it("desktop mode opens a socket, cloud mode stops it, off reopens", async () => {
    await svc.refresh();
    expect(sockets).toHaveLength(1);
    cloud.status = { enabled: true };
    await svc.refresh();
    expect(sockets[0]!.stopped).toBe(true);
    await svc.refresh();
    expect(sockets).toHaveLength(1);
    cloud.status = { enabled: false };
    await svc.refresh();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.started).toBe(true);
  });
});

describe("setCloud", () => {
  const setup = { enabled: true, aiProvider: "anthropic" as const, aiModel: "claude-sonnet-5", aiApiKey: "sk-1", signingSecret: "0123456789abcdef0123456789abcdef" };

  it("refuses tokens of another Slack workspace", async () => {
    teamId = "T2";
    await expect(svc.setCloud("w1", setup, "u1")).rejects.toThrow(/belong to «Other»/);
  });
  it("reports a key the provider refuses, storing nothing", async () => {
    stubAi({ status: 401, body: { error: { message: "invalid x-api-key" } } });
    await expect(svc.setCloud("w1", setup, "u1")).rejects.toThrow("the AI key did not answer — anthropic 401: invalid x-api-key");
    expect(cloud.set).toHaveLength(0);
  });
  it("stores the machine's bot token after a one-word check, and closes the socket", async () => {
    await svc.refresh();
    const calls = stubAi({ status: 200, body: { content: [{ type: "text", text: "OK" }] } });
    const s = await svc.setCloud("w1", setup, "u1");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(calls[0]!.body).max_tokens).toBe(16);
    expect(cloud.set[0]).toEqual({ workspaceId: "w1", enabled: true, aiProvider: "anthropic", aiModel: "claude-sonnet-5", aiApiKey: "sk-1", signingSecret: setup.signingSecret, botToken: "xoxb-1" });
    expect(s.enabled).toBe(true);
    expect(sockets[0]!.stopped).toBe(true);
  });
  it("toggling off needs no secrets; changing the model does", async () => {
    cloud.status = { enabled: true, aiProvider: "anthropic", aiModel: "claude-sonnet-5" };
    const fetchSpy = stubAi({ status: 200, body: {} });
    await svc.setCloud("w1", { enabled: false, aiProvider: "anthropic", aiModel: "claude-sonnet-5" }, "u1");
    expect(fetchSpy).toHaveLength(0);
    expect(cloud.set[0]).toEqual({ workspaceId: "w1", enabled: false, aiProvider: "anthropic", aiModel: "claude-sonnet-5", botToken: "xoxb-1" });
    await expect(svc.setCloud("w1", { enabled: true, aiProvider: "openai", aiModel: "gpt-5" }, "u1")).rejects.toThrow(/enter the AI API key again/);
  });
});
