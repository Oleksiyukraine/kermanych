// apps/api/src/slack/slack.service.ts
// The Slack documentation bot's DESKTOP host: token custody, the connect flow, the Socket
// Mode connections this machine holds, answering — and the owner's switch to the cloud host.
//
// Why the api: Slack must reach whoever answers, and answering needs the documentation
// (readable under a member's JWT) and a model (billed to a member's own plan). This machine
// has both while its user is signed in, so it dials OUT to Slack over Socket Mode. The
// consequence: in desktop mode the bot answers only while a token holder has Kermanych open.
// A workspace that must answer with nobody online switches to cloud mode
// (supabase/functions/slack-events, docs/specs/2026-10-16-slack-cloud-answers.md); this
// service stores that setup and, while it is on, holds no socket for the workspace.
//
// The answer itself is packages/core's answerSlackAsk, shared with the cloud host so both
// reply the same way; this file supplies only the search (under the operator's JWT) and the
// generation (the operator's agent runtime).
//
// Routing, from the cloud row: a workspace is bound to ONE channel, and an event is
// answered only for the workspace whose row names that channel. The row is read fresh per
// event, so an owner who rebinds or disconnects on another machine takes effect at once.
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { homedir } from "node:os";
import {
  deleteSlackCloud,
  deleteSlackIntegration,
  getDocIndexState,
  getSlackCloudStatus,
  getSlackIntegration,
  listProjects,
  listWorkspaces,
  searchProjectDocs,
  setSlackCloud,
  upsertSlackIntegration,
} from "@kermanych/cloud";
import type { SlackCloudStatus, SlackIntegration } from "@kermanych/cloud";
import {
  SLACK_MATCH_COUNT,
  SLACK_PLACEHOLDER,
  answerSlackAsk,
  classifyMessage,
  slackCloudGenerate,
  type SlackAsk,
  type SlackCloudAiProvider,
  type SlackPromptDocs,
} from "@kermanych/core";
import { AuthService } from "../auth/auth.service";
import { RegistryService, type SlackTokenRow } from "../registry/registry.service";
import { runOneShot } from "../runtime/one-shot";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { DOCS_MODEL } from "../management/management-chat.service";
import { CodedError } from "../management/coded-error";
import { SlackClient, type SlackChannel, type SlackIdentity } from "./slack-client";
import { SlackSocket } from "./slack-socket";

// What the owner's cloud-answers form sends. A secret left empty keeps the stored one.
export type SlackCloudSetup = {
  enabled: boolean;
  aiProvider: SlackCloudAiProvider;
  aiModel: string;
  aiBaseUrl?: string;
  aiApiKey?: string;
  signingSecret?: string;
};

// Slack's signing secret as Basic Information → App Credentials shows it: hex.
const SIGNING_SECRET = /^[0-9a-f]{20,}$/i;

// The AI key is proven before it is stored, like the Slack tokens: a one-word generation
// checks the key, the model and the base URL at once, for a few tokens.
const AI_CHECK_PROMPT = "Reply with the single word OK.";
const AI_CHECK_TIMEOUT_MS = 30_000;

export type SlackClientFactory = (token: string) => SlackClient;
export type SlackSocketFactory = (openUrl: () => Promise<string>, onEvent: (event: unknown, eventId: string) => void) => SlackSocket;

@Injectable()
export class SlackService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SlackService.name);
  // Keyed by APP token: one Slack app is one Socket Mode stream, whichever workspaces (in
  // the normal case exactly one) store it. An event is matched to its workspace by the
  // token rows that carry that app token (onEvent).
  private sockets = new Map<string, SlackSocket>();
  // One model child at a time. Answers are cheap to wait for and expensive to run in
  // parallel (each is a full agent process on the operator's plan); the placeholder already
  // told the asker they were heard.
  private queue: Promise<void> = Promise.resolve();
  // Refreshes run one after another: each reads the cloud, and two interleaved could open a
  // socket the later one just decided against.
  private reconciling: Promise<void> = Promise.resolve();

  constructor(
    private registry: RegistryService,
    private auth: AuthService,
    // Test seams, the LinearService clientFactory idiom: @Optional so Nest builds the
    // service with the real client and socket.
    @Optional() private clientFactory: SlackClientFactory = (token) => new SlackClient(token),
    @Optional()
    private socketFactory: SlackSocketFactory = (openUrl, onEvent) => new SlackSocket(openUrl, onEvent),
  ) {}

  onModuleInit(): void {
    // A preview api (auth.guard.ts) has no signed-in user and no business answering a real
    // Slack channel from a throwaway database.
    if (process.env.KERMANYCH_PREVIEW === "1") return;
    // Every token push, not only sign-in: a refresh is a no-op when nothing changed, and a
    // different user signing in must swap the sockets to their own tokens.
    this.auth.onToken(() => void this.refresh());
    this.auth.onClear(() => this.stopAll());
    if (this.auth.current()) void this.refresh();
  }

  onModuleDestroy(): void {
    this.stopAll();
  }

  // ── sockets ──────────────────────────────────────────────────────────────────

  // Reconcile the open connections with the signed-in user's stored tokens: open what is
  // missing, stop what is gone — and hold none for a workspace in cloud mode, whose Slack
  // app delivers to the Edge Function instead. Idempotent and never throws — it runs from
  // listeners that have no one to report to.
  refresh(): Promise<void> {
    if (process.env.KERMANYCH_PREVIEW === "1") return Promise.resolve();
    const run = (): Promise<void> => this.reconcile();
    this.reconciling = this.reconciling.then(run, run);
    return this.reconciling;
  }

  private async reconcile(): Promise<void> {
    try {
      const user = this.auth.current();
      const rows = user ? this.registry.listSlackTokens(user.userId) : [];
      const want = new Set<string>();
      for (const row of rows) {
        // An unreadable cloud keeps the desktop answering: a socket that receives nothing
        // costs little, a channel nobody answers costs the asker.
        const cloud = await getSlackCloudStatus(this.auth.cloudClient(), row.workspaceId).catch(() => undefined);
        if (!cloud?.enabled) want.add(row.appToken);
      }
      // Signed out (or someone else signed in) while the cloud was being read: that sign-out
      // already stopped the sockets, and these rows are not the current user's.
      if (this.auth.current()?.userId !== user?.userId) return;
      for (const [appToken, socket] of this.sockets)
        if (!want.has(appToken)) {
          socket.stop();
          this.sockets.delete(appToken);
        }
      for (const appToken of want) {
        if (this.sockets.has(appToken)) continue;
        const socket = this.socketFactory(
          () => this.clientFactory(appToken).openConnection(),
          (event) => void this.onEvent(appToken, event),
        );
        this.sockets.set(appToken, socket);
        socket.start();
      }
    } catch (err) {
      this.log.warn(`slack: refreshing sockets failed — ${(err as Error).message}`);
    }
  }

  private stopAll(): void {
    for (const socket of this.sockets.values()) socket.stop();
    this.sockets.clear();
  }

  // ── tokens ───────────────────────────────────────────────────────────────────

  tokenStatus(workspaceId: string, userId: string): { present: boolean; listening: boolean } {
    const row = this.registry.getSlackToken(workspaceId, userId);
    return { present: !!row, listening: !!row && !!this.sockets.get(row.appToken)?.isOpen() };
  }

  // Both tokens are proven BEFORE storing: the bot token by `auth.test` (which also says
  // which Slack workspace and bot user it is), the app token by minting a Socket Mode URL —
  // the one thing it is for. A Slack workspace other than the one already bound would put
  // the bot in a channel the integration row does not name, so it is refused by name.
  async setToken(workspaceId: string, botToken: string, appToken: string, userId: string): Promise<SlackIdentity> {
    const id = await this.clientFactory(botToken).authTest();
    await this.clientFactory(appToken).openConnection();
    const integration = await getSlackIntegration(this.auth.cloudClient(), workspaceId);
    if (integration && integration.teamId !== id.teamId)
      throw new Error(
        `these tokens belong to the Slack workspace «${id.teamName}», but this workspace is connected to «${integration.teamName}»`,
      );
    this.registry.setSlackToken(userId, { workspaceId, botToken, appToken, ...id });
    void this.refresh();
    return id;
  }

  deleteToken(workspaceId: string, userId: string): void {
    this.registry.deleteSlackToken(workspaceId, userId);
    void this.refresh();
  }

  private tokenRow(workspaceId: string, userId: string): SlackTokenRow {
    const row = this.registry.getSlackToken(workspaceId, userId);
    if (!row) throw new Error("no slack token");
    return row;
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  channels(workspaceId: string, userId: string): Promise<SlackChannel[]> {
    return this.clientFactory(this.tokenRow(workspaceId, userId).botToken).memberChannels();
  }

  // Owner action (RLS enforces it). The channel is re-checked against the bot's own
  // membership: a channel the bot is not in delivers no events, and binding to it would be
  // an integration that silently never answers.
  async connect(workspaceId: string, channelId: string, userId: string): Promise<SlackIntegration> {
    const row = this.tokenRow(workspaceId, userId);
    const channel = await this.clientFactory(row.botToken).memberChannel(channelId);
    if (!channel) throw new Error("the bot is not a member of that channel — invite it to the channel first");
    const integration = await upsertSlackIntegration(this.auth.cloudClient(), {
      workspaceId,
      teamId: row.teamId,
      teamName: row.teamName,
      channelId: channel.id,
      channelName: channel.name,
      botUserId: row.botUserId,
    });
    void this.refresh();
    return integration;
  }

  // The row AND this machine's tokens: an owner disconnecting means «stop answering», and
  // keeping the socket open on their own machine would keep acknowledging events for an
  // integration that no longer exists. The cloud-answers row and its secrets go with the
  // integration row (on delete cascade).
  async disconnect(workspaceId: string, userId: string): Promise<void> {
    await deleteSlackIntegration(this.auth.cloudClient(), workspaceId);
    this.registry.deleteSlackToken(workspaceId, userId);
    void this.refresh();
  }

  // ── cloud answers (owner) ────────────────────────────────────────────────────

  // Stores the cloud host's setup through set_slack_cloud, which refuses anyone but the
  // owner. Everything is proven before it is stored, the setToken rule: the bot token is
  // this machine's, checked against the connected Slack workspace; the AI key, model and
  // base URL by a one-word answer. The signing secret cannot be proven from here — the
  // card's «Slack reaches the cloud» stamp is its proof, once Slack sends a signed request.
  async setCloud(workspaceId: string, setup: SlackCloudSetup, userId: string): Promise<SlackCloudStatus> {
    const cloud = this.auth.cloudClient();
    const integration = await getSlackIntegration(cloud, workspaceId);
    if (!integration) throw new Error("connect a Slack channel before setting up cloud answers");
    const current = await getSlackCloudStatus(cloud, workspaceId);

    // The bot token the cloud posts with is this machine's, re-sent on every save so a token
    // replaced here reaches the cloud too. Without one, the stored token stays.
    const row = this.registry.getSlackToken(workspaceId, userId);
    if (row) {
      const id = await this.clientFactory(row.botToken).authTest();
      if (id.teamId !== integration.teamId)
        throw new Error(
          `this machine's Slack tokens belong to «${id.teamName}», but this workspace is connected to «${integration.teamName}»`,
        );
    } else if (!current) {
      throw new Error("this machine holds no Slack tokens — save the bot and app tokens on this card first");
    }

    const signingSecret = setup.signingSecret?.trim() || undefined;
    if (signingSecret && !SIGNING_SECRET.test(signingSecret))
      throw new Error("that is not a signing secret — copy it from Basic Information → App Credentials");
    if (!signingSecret && !current) throw new Error("the signing secret is required");

    const aiModel = setup.aiModel.trim();
    if (!aiModel) throw new Error("the model is required");
    const aiBaseUrl = setup.aiProvider === "openai" ? setup.aiBaseUrl?.trim() || undefined : undefined;
    if (aiBaseUrl && !aiBaseUrl.startsWith("https://")) throw new Error("the base URL must start with https://");
    const aiApiKey = setup.aiApiKey?.trim() || undefined;
    // The stored key cannot be read back to test it against another provider, model or URL.
    const aiChanged =
      !current || current.aiProvider !== setup.aiProvider || current.aiModel !== aiModel || current.aiBaseUrl !== aiBaseUrl;
    if (aiChanged && !aiApiKey) throw new Error("enter the AI API key again to change the provider, model or base URL");
    if (aiApiKey) {
      const ai = { provider: setup.aiProvider, model: aiModel, apiKey: aiApiKey, ...(aiBaseUrl ? { baseUrl: aiBaseUrl } : {}) };
      try {
        await slackCloudGenerate(ai, AI_CHECK_PROMPT, { maxTokens: 16, signal: AbortSignal.timeout(AI_CHECK_TIMEOUT_MS) });
      } catch (err) {
        throw new Error(`the AI key did not answer — ${(err as Error).message}`);
      }
    }

    await setSlackCloud(cloud, {
      workspaceId,
      enabled: setup.enabled,
      aiProvider: setup.aiProvider,
      aiModel,
      ...(aiBaseUrl ? { aiBaseUrl } : {}),
      ...(aiApiKey ? { aiApiKey } : {}),
      ...(signingSecret ? { signingSecret } : {}),
      ...(row ? { botToken: row.botToken } : {}),
    });
    await this.refresh();
    const saved = await getSlackCloudStatus(cloud, workspaceId);
    if (!saved) throw new Error("cloud answers were not saved");
    return saved;
  }

  // «Remove cloud keys»: the secrets leave the cloud and this machine's sockets come back.
  async deleteCloud(workspaceId: string): Promise<void> {
    await deleteSlackCloud(this.auth.cloudClient(), workspaceId);
    await this.refresh();
  }

  // ── answering ────────────────────────────────────────────────────────────────

  // Never throws: it is a socket callback, and the socket has already acknowledged the
  // envelope — there is nobody left to hand an error to except the log.
  private async onEvent(appToken: string, event: unknown): Promise<void> {
    try {
      const user = this.auth.current();
      if (!user) return;
      for (const row of this.registry.listSlackTokens(user.userId)) {
        if (row.appToken !== appToken) continue;
        const ask = classifyMessage(event, row.botUserId);
        if (!ask) continue;
        const integration = await getSlackIntegration(this.auth.cloudClient(), row.workspaceId);
        if (!integration || integration.channelId !== ask.channel) continue;

        const client = this.clientFactory(row.botToken);
        const placeholder = await client.postMessage(ask.channel, ask.threadTs, SLACK_PLACEHOLDER);
        const job = (): Promise<void> => this.answer(row, ask, client, placeholder.ts);
        this.queue = this.queue.then(job, job);
        return;
      }
    } catch (err) {
      this.log.warn(`slack: handling an event failed — ${(err as Error).message}`);
    }
  }

  // The shared answer, with this host's search (the docs-rag search under the operator's
  // JWT) and generation (a tool-less one-shot child on the operator's agent runtime).
  private answer(row: SlackTokenRow, ask: SlackAsk, client: SlackClient, placeholderTs: string): Promise<void> {
    const startedAt = Date.now();
    const cloud = this.auth.cloudClient();
    return answerSlackAsk(ask, placeholderTs, {
      slack: client,
      botUserId: row.botUserId,
      searchDocs: async (query) => {
        const docs: SlackPromptDocs[] = [];
        for (const project of await listProjects(cloud)) {
          if (project.workspaceId !== row.workspaceId) continue;
          if ((await getDocIndexState(cloud, project.id)).fileCount === 0) continue;
          const found = await searchProjectDocs(cloud, { projectId: project.id, query, matchCount: SLACK_MATCH_COUNT });
          docs.push({ projectName: project.name, fragments: found.fragments });
        }
        return docs;
      },
      workspaceName: async () => (await listWorkspaces(cloud)).find((w) => w.id === row.workspaceId)?.name,
      // Tool-less, in the home directory: the answer comes from the fragments in the prompt,
      // and there is no repository this child should be able to wander into.
      generate: async (prompt) =>
        (
          await runOneShot({
            kind: resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime),
            cwd: homedir(),
            prompt,
            noTools: true,
            model: DOCS_MODEL,
            startedAt,
          })
        ).text,
      failureReason: (err) => (err instanceof CodedError ? err.code : (err as Error).message),
      warn: (message) => this.log.warn(message),
    });
  }
}
