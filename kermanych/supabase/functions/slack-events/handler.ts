// slack-events — the Slack documentation bot's CLOUD host. In cloud mode a workspace's
// Slack app sends its events here over HTTP (Request URL
// `…/functions/v1/slack-events?workspace=<id>`) instead of over Socket Mode to members'
// machines, so a question is answered with nobody online.
//
// The answer itself is packages/core/src/slack-answer.ts — the same pipeline the desktop
// host (apps/api/src/slack/slack.service.ts) runs — so the reply reads the same whichever
// host wrote it. This file only adapts it: Slack's HTTP envelope, the signature, the
// retrieval through the slack_cloud_* functions, and the owner's AI provider.
//
// Runtime-free on purpose: everything Deno- or Supabase-specific comes in through
// SlackEventsDeps (index.ts builds the real ones), so the handler runs under a test too.
//
// SECURITY MODEL (see 20261016090000_slack_cloud_answers.sql):
//   - The workspace id in the URL is a claim. It is trusted only after the request's
//     signature verifies against THAT workspace's signing secret; an unverified request
//     gets 401 and touches nothing else.
//   - Documentation is read only through slack_cloud_indexed_projects /
//     slack_cloud_match_docs, which return nothing unless the workspace's cloud mode is on
//     and only that workspace's projects.
//   - Like docs-rag, it LOGS NEITHER question text nor documentation content — only ids,
//     counts and failure reasons.
import {
  SLACK_MATCH_COUNT,
  SLACK_PLACEHOLDER,
  answerSlackAsk,
  classifyMessage,
  type SlackAsk,
  type SlackCloudAi,
  type SlackDocFragment,
  type SlackPromptDocs,
  type SlackRawMessage,
  type SlackThreadPort,
} from "../../../packages/core/src/slack-answer.ts";

export type SlackCloudConfig = {
  enabled: boolean;
  teamId: string;
  channelId: string;
  botUserId: string;
  workspaceName: string;
  botToken: string;
  signingSecret: string;
  ai: SlackCloudAi;
};

export type SlackEventsDeps = {
  // null = no cloud setup for this workspace.
  config(workspaceId: string): Promise<SlackCloudConfig | null>;
  // Stamps «Slack reached the cloud»; with an event id, false when it was already claimed.
  claimEvent(workspaceId: string, eventId: string | null): Promise<boolean>;
  indexedProjects(workspaceId: string): Promise<Array<{ id: string; name: string }>>;
  matchDocs(input: {
    workspaceId: string;
    projectId: string;
    embedding: number[] | null;
    query: string;
    matchCount: number;
  }): Promise<SlackDocFragment[]>;
  // null = Voyage unavailable; the search degrades to full-text.
  embedQuery(query: string): Promise<number[] | null>;
  slack(botToken: string): SlackThreadPort;
  generate(ai: SlackCloudAi, prompt: string): Promise<string>;
  // Keeps the answer running after the 200 went back to Slack (EdgeRuntime.waitUntil).
  background(work: Promise<unknown>): void;
  nowSeconds(): number;
};

// Slack's replay window: a signed request older (or newer) than this is refused.
const MAX_SKEW_S = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// docs.slack.dev/authentication/verifying-requests-from-slack: HMAC-SHA256 of
// `v0:<timestamp>:<raw body>` under the signing secret, hex, prefixed `v0=`. Compared in
// constant time; the timestamp bounds replay.
export async function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds: number;
}): Promise<boolean> {
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(input.nowSeconds - Number(timestamp)) > MAX_SKEW_S) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(input.signingSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${input.rawBody}`)));
  const expected = `v0=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function handleSlackEvents(req: Request, deps: SlackEventsDeps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const workspaceId = new URL(req.url).searchParams.get("workspace") ?? "";
  if (!UUID.test(workspaceId)) return json(404, { error: "unknown workspace" });

  const rawBody = await req.text();
  const config = await deps.config(workspaceId);
  if (!config) return json(404, { error: "unknown workspace" });
  const verified = await verifySlackSignature({
    signingSecret: config.signingSecret,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    rawBody,
    nowSeconds: deps.nowSeconds(),
  });
  if (!verified) return json(401, { error: "invalid signature" });

  let body: { type?: string; challenge?: string; team_id?: string; event_id?: string; event?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  // Slack checks the Request URL when it is saved, with a signed challenge to echo.
  if (body.type === "url_verification") {
    await deps.claimEvent(workspaceId, null);
    return json(200, { challenge: body.challenge ?? "" });
  }
  if (body.type !== "event_callback") return json(200, { ok: true });

  // Everything below answers Slack 200: a refusal would only make it redeliver.
  const ask = config.enabled && body.team_id === config.teamId ? classifyMessage(body.event, config.botUserId) : null;
  if (!ask || ask.channel !== config.channelId || !body.event_id) {
    await deps.claimEvent(workspaceId, null);
    return json(200, { ok: true });
  }
  if (!(await deps.claimEvent(workspaceId, body.event_id))) return json(200, { ok: true });

  deps.background(answer(workspaceId, config, ask, deps));
  return json(200, { ok: true });
}

async function answer(
  workspaceId: string,
  config: SlackCloudConfig,
  ask: SlackAsk,
  deps: SlackEventsDeps,
): Promise<void> {
  const slack = deps.slack(config.botToken);
  try {
    const placeholder = await slack.postMessage(ask.channel, ask.threadTs, SLACK_PLACEHOLDER);
    await answerSlackAsk(ask, placeholder.ts, {
      slack,
      botUserId: config.botUserId,
      searchDocs: async (query) => {
        const projects = await deps.indexedProjects(workspaceId);
        if (projects.length === 0) return [];
        // One embedding for every project's search, as the desktop's per-project searches
        // each embed the same text.
        const embedding = await deps.embedQuery(query);
        const docs: SlackPromptDocs[] = [];
        for (const p of projects) {
          const fragments = await deps.matchDocs({ workspaceId, projectId: p.id, embedding, query, matchCount: SLACK_MATCH_COUNT });
          docs.push({ projectName: p.name, fragments });
        }
        console.log(JSON.stringify({ action: "slack-search", workspaceId, projects: projects.length, vector: !!embedding }));
        return docs;
      },
      workspaceName: async () => config.workspaceName || undefined,
      generate: (prompt) => deps.generate(config.ai, prompt),
      failureReason: (err) => (err instanceof Error ? err.message : String(err)),
      warn: (message) => console.warn(message),
    });
  } catch (err) {
    // Only the placeholder post can land here (answerSlackAsk never throws): Slack refused
    // the bot token or the channel, so there is nowhere to apologise.
    console.warn(`slack: posting the placeholder in ${ask.channel} failed — ${(err as Error).message}`);
  }
}

// ── Slack Web API: the three calls an answer makes ────────────────────────────
// The desktop's apps/api/src/slack/slack-client.ts, cut to what the answer pipeline needs:
// one form-encoded POST per method, Slack's `{ ok:false, error }` as the thrown reason,
// and a short Retry-After honoured on 429.

const API_URL = "https://slack.com/api";
const PAGE = 200;
const MAX_RETRY_AFTER_S = 30;
const RATE_LIMIT_RETRIES = 2;
const MAX_THREAD_MESSAGES = 1_000;

type Envelope = { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } };

export function slackWebApi(token: string, baseUrl = API_URL): SlackThreadPort {
  const call = async <T>(method: string, params: Record<string, string | number | undefined>): Promise<T & Envelope> => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body,
      });
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const wait = Number(res.headers.get("retry-after") ?? 1);
        if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_AFTER_S) {
          await res.body?.cancel();
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, wait * 1000);
          await promise;
          continue;
        }
      }
      const j = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as T & Envelope;
      if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? `http_${res.status}`}`);
      return j;
    }
  };
  return {
    async replies(channel, ts) {
      const out: SlackRawMessage[] = [];
      let cursor: string | undefined;
      do {
        const r = await call<{ messages?: SlackRawMessage[] }>("conversations.replies", { channel, ts, limit: PAGE, cursor });
        out.push(...(r.messages ?? []));
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor && out.length < MAX_THREAD_MESSAGES);
      return out.slice(0, MAX_THREAD_MESSAGES);
    },
    async postMessage(channel, threadTs, text) {
      const r = await call<{ ts?: string }>("chat.postMessage", { channel, thread_ts: threadTs, text });
      return { ts: r.ts ?? "" };
    },
    async update(channel, ts, text) {
      await call("chat.update", { channel, ts, text });
    },
  };
}
