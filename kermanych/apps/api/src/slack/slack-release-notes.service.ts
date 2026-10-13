// apps/api/src/slack/slack-release-notes.service.ts
// Release notes → Slack, posted under the sending member's own name.
//
// Each member authorizes the workspace's Slack app once (OAuth v2 with PKCE, user scopes
// only — slack-oauth.ts); the resulting user token (`xoxp-`) stays in this machine's
// registry, and `chat.postMessage` with it is the member speaking, not a bot. The cloud row
// (`workspace_release_notes_slack`) names the app and the channel; the owner sets it.
//
// Separate from SlackService on purpose: that one is a long-lived bot with sockets and a
// queue, this one is a handful of request/response calls the UI makes.
import { Injectable, Optional } from "@nestjs/common";
import { getReleaseNotesSlack, getWorkspaceReleaseNote, upsertReleaseNotesSlack, deleteReleaseNotesSlack } from "@kermanych/cloud";
import type { ReleaseNotesSlack } from "@kermanych/cloud";
import { AuthService } from "../auth/auth.service";
import { RegistryService, type SlackUserTokenRow } from "../registry/registry.service";
import { SlackApiError, SlackClient, type SlackChannel } from "./slack-client";
import { splitForSlack, toSlackMrkdwn } from "./slack-map";
import { SLACK_CLIENT_ID, SLACK_OAUTH_REDIRECT, newPkceVerifier, pkceChallenge, slackAuthorizeUrl } from "./slack-oauth";
import type { SlackClientFactory } from "./slack.service";

// `clientId`: the Slack app this account authorized — the owner's settings compare it with
// the Client ID being set, since the channel row takes its app from the owner's token.
export type SlackAccountStatus =
  | { connected: false }
  | { connected: true; teamName: string; userName: string; clientId: string };

export type ReleaseNoteSent = { channelName: string; ts: string };

@Injectable()
export class SlackReleaseNotesService {
  // The verifier of the authorization each (workspace, user) has in flight. One at a time:
  // starting again replaces it, and finishing consumes it.
  private pending = new Map<string, { verifier: string; clientId: string }>();

  constructor(
    private registry: RegistryService,
    private auth: AuthService,
    // Test seam, SlackService's idiom.
    @Optional() private clientFactory: SlackClientFactory = (token) => new SlackClient(token),
  ) {}

  // ── this member's Slack account ──────────────────────────────────────────────

  account(workspaceId: string, userId: string): SlackAccountStatus {
    const row = this.registry.getSlackUserToken(workspaceId, userId);
    return row
      ? { connected: true, teamName: row.teamName, userName: row.slackUserName, clientId: row.clientId }
      : { connected: false };
  }

  // The URL the desktop app opens in the system browser. A member authorizes the app the
  // workspace's row names; the owner setting the row up for the first time (or moving it to
  // another app) passes the Client ID they are about to save.
  async authorize(workspaceId: string, userId: string, clientId?: string): Promise<{ url: string }> {
    const id = clientId?.trim() || (await getReleaseNotesSlack(this.auth.cloudClient(), workspaceId))?.clientId;
    if (!id) throw new Error("set the Slack app's Client ID first");
    if (!SLACK_CLIENT_ID.test(id)) throw new Error(`«${id}» is not a Slack Client ID (it looks like 1234567890.1234567890)`);
    const verifier = newPkceVerifier();
    this.pending.set(`${workspaceId}:${userId}`, { verifier, clientId: id });
    return { url: slackAuthorizeUrl(id, pkceChallenge(verifier)) };
  }

  // The loopback caught Slack's redirect; trade its code for the member's token.
  async completeAuthorize(workspaceId: string, userId: string, code: string): Promise<SlackAccountStatus> {
    const key = `${workspaceId}:${userId}`;
    const flow = this.pending.get(key);
    if (!flow) throw new Error("no Slack authorization is in progress — start again");
    this.pending.delete(key);

    const grant = await this.clientFactory("").oauthUserAccess({
      clientId: flow.clientId,
      code,
      codeVerifier: flow.verifier,
      redirectUri: SLACK_OAUTH_REDIRECT,
    });
    if (!grant.scope.split(",").includes("chat:write"))
      throw new Error("Slack did not grant chat:write — update the Slack app from the manifest and connect again");
    const me = await this.clientFactory(grant.accessToken).userIdentity();

    // A token from another Slack workspace than the channel's could never post there. Only
    // checked against the app the row names: an owner moving the setting to another app is
    // about to rewrite the team along with it.
    const settings = await getReleaseNotesSlack(this.auth.cloudClient(), workspaceId);
    if (settings && settings.clientId === flow.clientId && settings.teamId !== me.teamId)
      throw new Error(`you signed in to the Slack workspace «${me.teamName}», but release notes go to «${settings.teamName}»`);

    this.registry.setSlackUserToken(userId, {
      workspaceId,
      accessToken: grant.accessToken,
      clientId: flow.clientId,
      teamId: me.teamId,
      teamName: me.teamName,
      slackUserId: me.userId,
      slackUserName: me.userName,
    });
    return this.account(workspaceId, userId);
  }

  disconnect(workspaceId: string, userId: string): void {
    this.registry.deleteSlackUserToken(workspaceId, userId);
  }

  private token(workspaceId: string, userId: string): SlackUserTokenRow {
    const row = this.registry.getSlackUserToken(workspaceId, userId);
    if (!row) throw new Error("connect your Slack account first");
    return row;
  }

  // ── the channel (owner) ──────────────────────────────────────────────────────

  // Only channels the owner is in: a user token cannot post anywhere else, so any other
  // channel would be a setting that fails on its first send.
  channels(workspaceId: string, userId: string): Promise<SlackChannel[]> {
    return this.clientFactory(this.token(workspaceId, userId).accessToken).memberChannels();
  }

  // Owner action (RLS enforces it). The app and team are the ones the owner's own token was
  // granted by, so the row can never name an app nobody has authorized.
  async setChannel(workspaceId: string, userId: string, channelId: string): Promise<ReleaseNotesSlack> {
    const row = this.token(workspaceId, userId);
    const channel = await this.clientFactory(row.accessToken).memberChannel(channelId);
    if (!channel) throw new Error("you are not a member of that channel — join it in Slack first");
    return upsertReleaseNotesSlack(this.auth.cloudClient(), {
      workspaceId,
      clientId: row.clientId,
      teamId: row.teamId,
      teamName: row.teamName,
      channelId: channel.id,
      channelName: channel.name,
    });
  }

  async removeChannel(workspaceId: string): Promise<void> {
    await deleteReleaseNotesSlack(this.auth.cloudClient(), workspaceId);
  }

  // ── sending ──────────────────────────────────────────────────────────────────

  // The note is read here, under the member's JWT, rather than taken from the request: what
  // goes to Slack is what the workspace stores, and only a note of THIS workspace.
  // One note is one channel message; a note longer than a Slack message continues in that
  // message's thread, in order.
  async send(workspaceId: string, userId: string, noteId: string): Promise<ReleaseNoteSent> {
    const cloud = this.auth.cloudClient();
    const settings = await getReleaseNotesSlack(cloud, workspaceId);
    if (!settings) throw new Error("no Slack channel is set for this workspace's release notes");
    const token = this.token(workspaceId, userId);
    if (token.teamId !== settings.teamId)
      throw new Error(`your Slack account is in «${token.teamName}», but release notes go to «${settings.teamName}» — connect again`);
    const note = await getWorkspaceReleaseNote(cloud, noteId);
    if (!note || note.workspaceId !== workspaceId) throw new Error("this release note is not in the workspace");

    const client = this.clientFactory(token.accessToken);
    const [first, ...rest] = splitForSlack(toSlackMrkdwn(note.bodyMd));
    let posted: { ts: string };
    try {
      posted = await client.postMessage(settings.channelId, undefined, first!);
    } catch (err) {
      if (err instanceof SlackApiError && (err.error === "not_in_channel" || err.error === "channel_not_found"))
        throw new Error(`you are not a member of #${settings.channelName} — join it in Slack first`);
      throw err;
    }
    for (const part of rest) await client.postMessage(settings.channelId, posted.ts, part);
    return { channelName: settings.channelName, ts: posted.ts };
  }
}
