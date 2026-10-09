// apps/api/src/slack/slack-oauth.ts
// The member-side Slack OAuth: OAuth v2 with PKCE (docs.slack.dev/authentication/using-pkce),
// user scopes only, redirected to the desktop app's loopback listener. With PKCE enabled on
// the app, Slack treats a `localhost` redirect as a desktop redirect and exchanges the code
// against the verifier — no client secret exists anywhere.
import { createHash, randomBytes } from "node:crypto";

// Must match OAUTH_PORT in apps/ui/src-electron/oauth-loopback.ts (the listener that catches
// the redirect) and `redirect_urls` in apps/ui/src/lib/slack-manifest.ts (Slack refuses a
// redirect the app does not list). `localhost`, not 127.0.0.1: it is the host Slack names
// as a desktop redirect.
export const SLACK_OAUTH_REDIRECT = "http://localhost:53170/callback";

// Post as the member, and list the channels they are in (public and private) to pick from.
export const SLACK_USER_SCOPES = ["chat:write", "channels:read", "groups:read"];

// A Slack app's Client ID: two dot-separated numbers (`1234567890.0987654321`).
export const SLACK_CLIENT_ID = /^\d+\.\d+$/;

// RFC 7636 S256: base64url (no padding) of the verifier's SHA-256. Plain base64 would be
// refused by Slack as a challenge mismatch.
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// 32 random bytes → 43 base64url characters, inside RFC 7636's 43–128 range.
export function newPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function slackAuthorizeUrl(clientId: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    scope: "",
    user_scope: SLACK_USER_SCOPES.join(","),
    redirect_uri: SLACK_OAUTH_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://slack.com/oauth/v2/authorize?${q}`;
}
