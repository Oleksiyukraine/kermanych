// routines-runner/slack.ts — posting as the workspace's Slack bot. The local runner posts as the
// author with their user token; nobody's user token is in the cloud, so a cloud run's message
// comes from the bot (the Q&A bot's app), in a channel the bot was invited to. The formatting is
// the local runner's, byte for byte (_shared/slack-format.ts).
import { splitForSlack, toSlackMrkdwn } from "../_shared/slack-format.ts";

const API = "https://slack.com/api";

type SlackReply = { ok: boolean; error?: string; [k: string]: unknown };

async function call(token: string, method: string, body: Record<string, unknown>, fetchFn: typeof fetch): Promise<SlackReply> {
  const r = await fetchFn(`${API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as SlackReply;
  if (!j.ok) throw new Error(j.error ?? `Slack ${r.status}`);
  return j;
}

// Whose bot this is — the `configure` check, and the Slack workspace a routine's channel must be in.
export async function botIdentity(token: string, fetchFn: typeof fetch = fetch): Promise<{ teamId: string; teamName: string }> {
  const j = await call(token, "auth.test", {}, fetchFn);
  return { teamId: String(j.team_id), teamName: String(j.team) };
}

// The channels the bot is a member of — the only ones it can post to.
export async function botChannels(token: string, fetchFn: typeof fetch = fetch): Promise<{ id: string; name: string; isPrivate: boolean }[]> {
  const out: { id: string; name: string; isPrivate: boolean }[] = [];
  let cursor = "";
  do {
    const j = await call(
      token,
      "users.conversations",
      { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) },
      fetchFn,
    );
    for (const c of (j.channels as { id: string; name: string; is_private?: boolean }[]) ?? [])
      out.push({ id: c.id, name: c.name, isPrivate: !!c.is_private });
    cursor = String((j.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
  } while (cursor);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// One document is one channel message; the rest of a long one continues in its thread.
export async function postDocument(token: string, channelId: string, markdown: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const [first, ...rest] = splitForSlack(toSlackMrkdwn(markdown));
  const posted = await call(token, "chat.postMessage", { channel: channelId, text: first, unfurl_links: false }, fetchFn);
  for (const part of rest) await call(token, "chat.postMessage", { channel: channelId, thread_ts: posted.ts, text: part, unfurl_links: false }, fetchFn);
}
