// apps/api/src/slack/slack-client.ts
// The one place that speaks HTTP to Slack's Web API. No SDK on purpose (the Jira/Linear
// precedent): the bot needs seven methods, and each is one form-encoded POST.
//
// A client is built per TOKEN: the bot token (`xoxb-`) signs everything the bot reads and
// writes; the app-level token (`xapp-`) is good for exactly one call here,
// `apps.connections.open`, which mints the Socket Mode URL.
//
// Slack answers HTTP 200 with `{ ok: false, error: "<code>" }` for almost every failure, so
// the code string — not the status — is what callers branch on (`invalid_auth`,
// `not_authed`, `channel_not_found`, …).
import { setTimeout as sleep } from "node:timers/promises";

const API_URL = "https://slack.com/api";

// users.conversations/conversations.replies page size. 200 is Slack's documented recommended maximum.
const PAGE = 200;

// Slack answers a rate-limited call with HTTP 429 and `Retry-After` (seconds). Waits up to
// this long are taken and the call retried; a longer one is reported, because these calls
// sit behind a UI request (or an answer) that would otherwise look hung.
const MAX_RETRY_AFTER_S = 30;
const RATE_LIMIT_RETRIES = 2;

// A hard stop on paging a runaway thread. What reaches the prompt is trimmed further by the
// service (root + the newest replies), so this only bounds the requests, not the context.
const MAX_THREAD_MESSAGES = 1_000;

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly error: string,
  ) {
    super(`slack ${method}: ${error}`);
  }
}

// The two codes that mean «this token is not a token» — the controller maps them to 401
// like a Linear authentication error.
export function isSlackAuthError(err: unknown): boolean {
  return err instanceof SlackApiError && (err.error === "invalid_auth" || err.error === "not_authed");
}

export type SlackIdentity = { teamId: string; teamName: string; botUserId: string };

export type SlackChannel = { id: string; name: string; isPrivate: boolean };

// A message as conversations.replies (and the Events API) carry it. Typed loosely on
// purpose — slack-map.ts is the tolerant boundary that decides what a message means.
export type SlackRawMessage = {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
};

type Envelope = { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } };

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = API_URL,
  ) {}

  private async call<T>(method: string, params: Record<string, string | number | boolean | undefined>): Promise<T & Envelope> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body,
      });
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const wait = Number(res.headers.get("retry-after") ?? 1);
        if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_AFTER_S) {
          await res.body?.cancel();
          await sleep(wait * 1000);
          continue;
        }
      }
      // A non-JSON body (an HTML 5xx from an edge) still has to become an error a toast can
      // show, so the status stands in for Slack's missing code.
      const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as T & Envelope;
      if (!json.ok) throw new SlackApiError(method, json.error ?? `http_${res.status}`);
      return json;
    }
  }

  // Validates a BOT token and reports which Slack workspace and bot user it belongs to.
  async authTest(): Promise<SlackIdentity> {
    const r = await this.call<{ team_id?: string; team?: string; user_id?: string }>("auth.test", {});
    return { teamId: r.team_id ?? "", teamName: r.team ?? "", botUserId: r.user_id ?? "" };
  }

  // APP-level token only: the single-use wss:// URL of a fresh Socket Mode connection.
  async openConnection(): Promise<string> {
    const r = await this.call<{ url?: string }>("apps.connections.open", {});
    if (!r.url) throw new SlackApiError("apps.connections.open", "no_url");
    return r.url;
  }

  // The channels the bot can actually hear: Slack delivers message events only for
  // conversations the bot is a member of, so offering any other one would bind the
  // integration to silence. `users.conversations` returns exactly those — unlike
  // `conversations.list`, which pages every channel of the Slack workspace on a Tier 2
  // budget and runs a large workspace into `ratelimited`.
  async memberChannels(): Promise<SlackChannel[]> {
    const out: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call<{ channels?: Array<{ id: string; name?: string; is_private?: boolean }> }>(
        "users.conversations",
        { types: "public_channel,private_channel", exclude_archived: true, limit: PAGE, cursor },
      );
      for (const c of r.channels ?? []) out.push({ id: c.id, name: c.name ?? c.id, isPrivate: c.is_private === true });
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // One channel, if the bot can hear it; `null` otherwise. A private channel the bot is not
  // in is invisible to it, so Slack answers `channel_not_found` — the same «not a member».
  async memberChannel(id: string): Promise<SlackChannel | null> {
    try {
      const r = await this.call<{
        channel?: { id: string; name?: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean };
      }>("conversations.info", { channel: id });
      const c = r.channel;
      if (!c?.is_member || c.is_archived) return null;
      return { id: c.id, name: c.name ?? c.id, isPrivate: c.is_private === true };
    } catch (err) {
      if (err instanceof SlackApiError && err.error === "channel_not_found") return null;
      throw err;
    }
  }

  // The whole thread, root first, in Slack's own chronological order.
  async replies(channel: string, ts: string): Promise<SlackRawMessage[]> {
    const out: SlackRawMessage[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call<{ messages?: SlackRawMessage[] }>("conversations.replies", {
        channel,
        ts,
        limit: PAGE,
        cursor,
      });
      out.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor && out.length < MAX_THREAD_MESSAGES);
    return out.slice(0, MAX_THREAD_MESSAGES);
  }

  async postMessage(channel: string, threadTs: string, text: string): Promise<{ ts: string }> {
    const r = await this.call<{ ts?: string }>("chat.postMessage", { channel, thread_ts: threadTs, text });
    return { ts: r.ts ?? "" };
  }

  async update(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel, ts, text });
  }
}
