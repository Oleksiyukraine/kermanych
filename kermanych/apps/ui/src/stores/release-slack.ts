// apps/ui/src/stores/release-slack.ts
// Release notes → Slack: the workspace's release-notes channel (a cloud row, owner-set) and
// THIS member's Slack account on this machine (a user token in the local api's registry),
// keyed by workspace for the reason stores/release-notes.ts is.
//
// A note is posted by the local api with the member's own Slack user token, so it appears
// in Slack under their name. Connecting that account is OAuth with PKCE through the
// desktop app's loopback (window.kermanych.startOAuth): the api builds the URL and keeps
// the verifier, main opens the system browser and catches the redirect, the api trades the
// code. The browser build has no loopback, so it can read the setting but not connect.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ReleaseNotesSlack } from '@kermanych/cloud';
import { getReleaseNotesSlack } from '@kermanych/cloud';
import { useAuth } from './auth';
import { api, ApiError, type ReleaseNoteSent, type SlackAccountStatus } from '../lib/api';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';

// What the api's Slack routes answer (403) when Slack refuses the stored token — revoked in
// Slack, an account deactivated (apps/api/src/http/slack.controller.ts).
const TOKEN_INVALID = 'slack token invalid';

export const useReleaseSlack = defineStore('release-slack', () => {
  const auth = useAuth();

  // `null` = loaded, no channel set; absent = not loaded yet.
  const settings = ref<Record<string, ReleaseNotesSlack | null>>({});
  const accounts = ref<Record<string, SlackAccountStatus>>({});

  const canConnect = !!window.kermanych?.startOAuth;

  async function load(workspaceId: string): Promise<void> {
    await auth.ready;
    if (IS_PREVIEW || !auth.user || !workspaceId) {
      settings.value = { ...settings.value, [workspaceId]: null };
      accounts.value = { ...accounts.value, [workspaceId]: { connected: false } };
      return;
    }
    // Each half on its own: an unreachable cloud must not hide this machine's account, and
    // the other way round. Both read as «not set» on failure, the Slack tile's rule.
    const [row, account] = await Promise.allSettled([
      getReleaseNotesSlack(auth.client, workspaceId),
      api.slackAccount(workspaceId),
    ]);
    settings.value = { ...settings.value, [workspaceId]: row.status === 'fulfilled' ? (row.value ?? null) : null };
    accounts.value = {
      ...accounts.value,
      [workspaceId]: account.status === 'fulfilled' ? account.value : { connected: false },
    };
  }

  // The OAuth round trip. `clientId` only while the owner sets the channel up (the row does
  // not exist yet, or names another app); a member authorizes the app the row names.
  async function connect(workspaceId: string, clientId?: string): Promise<SlackAccountStatus> {
    const startOAuth = window.kermanych?.startOAuth;
    if (!startOAuth) throw new Error(globalTr.t('releaseSlack.desktopOnly'));
    const { url } = await api.slackAccountAuthorize(workspaceId, clientId);
    const { code } = await startOAuth(url);
    const account = await api.slackAccountComplete(workspaceId, code);
    accounts.value = { ...accounts.value, [workspaceId]: account };
    return account;
  }

  async function disconnect(workspaceId: string): Promise<void> {
    await api.slackAccountDisconnect(workspaceId);
    accounts.value = { ...accounts.value, [workspaceId]: { connected: false } };
  }

  async function saveChannel(workspaceId: string, channelId: string): Promise<ReleaseNotesSlack> {
    const row = await api.slackSetReleaseNotesChannel(workspaceId, channelId);
    settings.value = { ...settings.value, [workspaceId]: row };
    return row;
  }

  async function removeChannel(workspaceId: string): Promise<void> {
    await api.slackRemoveReleaseNotesChannel(workspaceId);
    settings.value = { ...settings.value, [workspaceId]: null };
  }

  // Connects first when this member has no Slack account here yet, so «Send to Slack» is one
  // press for everyone. A token Slack refuses is forgotten, and the error says to connect
  // again — the next press then starts the round trip instead of failing the same way.
  async function send(workspaceId: string, noteId: string): Promise<ReleaseNoteSent> {
    if (!accounts.value[workspaceId]?.connected) await connect(workspaceId);
    try {
      return await api.slackSendReleaseNote(workspaceId, noteId);
    } catch (e) {
      if (e instanceof ApiError && e.serverMessage === TOKEN_INVALID) {
        await disconnect(workspaceId).catch(() => undefined);
        throw new Error(globalTr.t('releaseSlack.reconnect'));
      }
      throw e;
    }
  }

  return { settings, accounts, canConnect, load, connect, disconnect, saveChannel, removeChannel, send };
});
