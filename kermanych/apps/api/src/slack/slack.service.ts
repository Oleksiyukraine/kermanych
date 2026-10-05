// apps/api/src/slack/slack.service.ts
// The Slack documentation bot's engine: token custody, the connect flow, the Socket Mode
// connections this machine holds, and answering.
//
// Why the api and not the cloud: Slack must reach whoever answers, and answering needs the
// documentation (readable only under a member's JWT — there is no service role) and a model
// (billed to a member's own plan). This machine has both while its user is signed in, so
// it dials OUT to Slack over Socket Mode. The consequence is stated plainly in the spec:
// the bot answers only while a token holder has Kermanych open.
//
// Routing, from the cloud row: a workspace is bound to ONE channel, and an event is
// answered only for the workspace whose row names that channel. The row is read fresh per
// event, so an owner who rebinds or disconnects on another machine takes effect at once.
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { homedir } from "node:os";
import {
  deleteSlackIntegration,
  getDocIndexState,
  getSlackIntegration,
  listProjects,
  listWorkspaces,
  searchProjectDocs,
  upsertSlackIntegration,
} from "@kermanych/cloud";
import type { SlackIntegration } from "@kermanych/cloud";
import { AuthService } from "../auth/auth.service";
import { RegistryService, type SlackTokenRow } from "../registry/registry.service";
import { runOneShot } from "../runtime/one-shot";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { DOCS_MODEL } from "../management/management-chat.service";
import { CodedError } from "../management/coded-error";
import { SlackClient, type SlackChannel, type SlackIdentity } from "./slack-client";
import { SlackSocket } from "./slack-socket";
import { classifyMessage, threadTranscript, toSlackMrkdwn, type SlackAsk, type TranscriptLine } from "./slack-map";
import { buildSlackAnswerPrompt, type SlackPromptDocs } from "./slack-prompt";

// Posted the moment a question is accepted and edited into the answer: an LLM answer takes
// tens of seconds, and a silent channel reads as a bot that did not hear.
const PLACEHOLDER = "_Looking through the documentation…_";

// No index anywhere in the workspace: said without spending a model call, because a model
// handed zero fragments could only say «not built» — which would be a lie about the product.
const NOT_INDEXED =
  "The documentation of this Kermanych workspace is not indexed yet, so there is nothing I can answer from. Index it from a project's Documentation tab in Kermanych.";

// Per project, the same match count the management chat's documentation turns retrieve.
const MATCH_COUNT = 8;

// How much of a long thread the model reads: the root question plus the newest replies
// before the follow-up. The discussion right before a mention is what it is about; the
// middle of a hundred-message thread is not worth the prompt.
const THREAD_CONTEXT = 60;

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
    this.auth.onToken(() => this.refresh());
    this.auth.onClear(() => this.stopAll());
    if (this.auth.current()) this.refresh();
  }

  onModuleDestroy(): void {
    this.stopAll();
  }

  // ── sockets ──────────────────────────────────────────────────────────────────

  // Reconcile the open connections with the signed-in user's stored tokens: open what is
  // missing, stop what is gone. Idempotent and never throws — it runs from listeners that
  // have no one to report to.
  refresh(): void {
    if (process.env.KERMANYCH_PREVIEW === "1") return;
    try {
      const user = this.auth.current();
      const want = new Set((user ? this.registry.listSlackTokens(user.userId) : []).map((r) => r.appToken));
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
    this.refresh();
    return id;
  }

  deleteToken(workspaceId: string, userId: string): void {
    this.registry.deleteSlackToken(workspaceId, userId);
    this.refresh();
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
    this.refresh();
    return integration;
  }

  // The row AND this machine's tokens: an owner disconnecting means «stop answering», and
  // keeping the socket open on their own machine would keep acknowledging events for an
  // integration that no longer exists.
  async disconnect(workspaceId: string, userId: string): Promise<void> {
    await deleteSlackIntegration(this.auth.cloudClient(), workspaceId);
    this.registry.deleteSlackToken(workspaceId, userId);
    this.refresh();
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
        const placeholder = await client.postMessage(ask.channel, ask.threadTs, PLACEHOLDER);
        const job = (): Promise<void> => this.answer(row, ask, client, placeholder.ts);
        this.queue = this.queue.then(job, job);
        return;
      }
    } catch (err) {
      this.log.warn(`slack: handling an event failed — ${(err as Error).message}`);
    }
  }

  private async answer(row: SlackTokenRow, ask: SlackAsk, client: SlackClient, placeholderTs: string): Promise<void> {
    const startedAt = Date.now();
    try {
      let transcript: TranscriptLine[] = [];
      let query = ask.text;
      if (ask.kind === "followup") {
        // Only what was said up to the follow-up: later replies were not part of the
        // question, and the placeholder is the answer being written.
        const before = (await client.replies(ask.channel, ask.threadTs)).filter((m) => Number(m.ts) < Number(ask.ts));
        const kept = before.length > THREAD_CONTEXT ? [before[0]!, ...before.slice(-(THREAD_CONTEXT - 1))] : before;
        transcript = threadTranscript(kept, row.botUserId, placeholderTs);
        // Retrieval sees the root question too: «and on mobile?» alone matches nothing.
        if (transcript[0]) query = `${transcript[0].text}\n${ask.text}`;
      }

      const cloud = this.auth.cloudClient();
      const docs: SlackPromptDocs[] = [];
      for (const project of await listProjects(cloud)) {
        if (project.workspaceId !== row.workspaceId) continue;
        if ((await getDocIndexState(cloud, project.id)).fileCount === 0) continue;
        const found = await searchProjectDocs(cloud, { projectId: project.id, query, matchCount: MATCH_COUNT });
        docs.push({ projectName: project.name, fragments: found.fragments });
      }
      if (docs.length === 0) {
        await client.update(ask.channel, placeholderTs, NOT_INDEXED);
        return;
      }

      // Best-effort: the name only flavours the prompt, it must not cost the answer.
      const workspaceName = (await listWorkspaces(cloud).catch(() => [])).find((w) => w.id === row.workspaceId)?.name;
      const prompt = buildSlackAnswerPrompt({
        ...(workspaceName ? { workspaceName } : {}),
        transcript,
        question: ask.text,
        docs,
      });
      // Tool-less, in the home directory: the answer comes from the fragments in the prompt,
      // and there is no repository this child should be able to wander into.
      const { text } = await runOneShot({
        kind: resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime),
        cwd: homedir(),
        prompt,
        noTools: true,
        model: DOCS_MODEL,
        startedAt,
      });
      await client.update(ask.channel, placeholderTs, toSlackMrkdwn(text));
    } catch (err) {
      const reason = err instanceof CodedError ? err.code : (err as Error).message;
      this.log.warn(`slack: answering in ${ask.channel} failed — ${reason}`);
      await client
        .update(ask.channel, placeholderTs, `_Sorry, I could not answer this one (${reason})._`)
        .catch((e: Error) => this.log.warn(`slack: posting the apology failed — ${e.message}`));
    }
  }
}
