// The Slack app a workspace creates from (one app per workspace), copied from the
// Integrations tile and from the Release Notes Slack settings. It matches the api exactly:
//   * the documentation bot — Socket Mode, message events for public and private channels,
//     and nothing beyond reading/writing the channels it is in (apps/api/src/slack/slack.service.ts);
//   * release notes posted under each member's own name — user scopes granted by OAuth with
//     PKCE to the desktop app's loopback (apps/api/src/slack/slack-oauth.ts, whose
//     SLACK_OAUTH_REDIRECT and SLACK_USER_SCOPES must match `redirect_urls` and `scopes.user`).
// Token rotation stays off: a rotating user token would expire within hours.
export const SLACK_MANIFEST = {
  display_information: {
    name: 'Kermanych',
    description: 'Answers questions about your project documentation and posts release notes',
  },
  features: { bot_user: { display_name: 'Kermanych', always_online: false } },
  oauth_config: {
    redirect_urls: ['http://localhost:53170/callback'],
    scopes: {
      bot: ['channels:history', 'groups:history', 'channels:read', 'groups:read', 'chat:write'],
      user: ['chat:write', 'channels:read', 'groups:read'],
    },
    pkce_enabled: true,
  },
  settings: {
    event_subscriptions: { bot_events: ['message.channels', 'message.groups'] },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};
