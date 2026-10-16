// slack-events entry: wires handler.ts to the Edge Runtime and to Postgres.
//
// verify_jwt = false (config.toml): the caller is Slack, which carries no Supabase JWT; the
// Slack signature, checked in the handler, is what authenticates a request.
//
// The client below holds the platform-injected service-role key, and the migration grants
// that role nothing but EXECUTE on the slack_cloud_* functions — no table is read or written
// directly here. VOYAGE_API_KEY is the product-wide key docs-rag uses (../.env.example).
import { createClient } from "npm:@supabase/supabase-js@2";
import { VOYAGE_MODEL, embedQuery, halfvecLiteral } from "../_shared/voyage.ts";
import { isSlackCloudAiProvider, slackCloudGenerate, type SlackDocFragment } from "../../../packages/core/src/slack-answer.ts";
import { handleSlackEvents, slackWebApi, type SlackCloudConfig } from "./handler.ts";

declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void } | undefined;

// The model call's deadline, inside the Edge Function's wall-clock limit, so a hung provider
// becomes an apology in the thread rather than a placeholder left forever.
const GENERATE_TIMEOUT_MS = 120_000;

type ConfigRow = {
  enabled: boolean;
  team_id: string;
  channel_id: string;
  bot_user_id: string;
  workspace_name: string;
  bot_token: string;
  signing_secret: string;
  ai_provider: string;
  ai_model: string;
  ai_base_url: string | null;
  ai_api_key: string;
};

type MatchRow = {
  folder: string;
  path: string;
  heading_path: string;
  start_line: number;
  end_line: number;
  content: string;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");

Deno.serve(async (req: Request): Promise<Response> => {
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "function not configured" }), { status: 500 });
  }
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    return await handleSlackEvents(req, {
      async config(workspaceId) {
        const { data, error } = await db.rpc("slack_cloud_config", { p_workspace_id: workspaceId });
        if (error) throw new Error(error.message);
        const row = (data as ConfigRow[] | null)?.[0];
        if (!row || !isSlackCloudAiProvider(row.ai_provider)) return null;
        const config: SlackCloudConfig = {
          enabled: row.enabled,
          teamId: row.team_id,
          channelId: row.channel_id,
          botUserId: row.bot_user_id,
          workspaceName: row.workspace_name,
          botToken: row.bot_token,
          signingSecret: row.signing_secret,
          ai: {
            provider: row.ai_provider,
            model: row.ai_model,
            apiKey: row.ai_api_key,
            ...(row.ai_base_url ? { baseUrl: row.ai_base_url } : {}),
          },
        };
        return config;
      },
      async claimEvent(workspaceId, eventId) {
        const { data, error } = await db.rpc("slack_cloud_claim_event", { p_workspace_id: workspaceId, p_event_id: eventId });
        if (error) throw new Error(error.message);
        return data === true;
      },
      async indexedProjects(workspaceId) {
        const { data, error } = await db.rpc("slack_cloud_indexed_projects", { p_workspace_id: workspaceId });
        if (error) throw new Error(error.message);
        return ((data ?? []) as Array<{ project_id: string; project_name: string }>).map((r) => ({ id: r.project_id, name: r.project_name }));
      },
      async matchDocs({ workspaceId, projectId, embedding, query, matchCount }) {
        const { data, error } = await db.rpc("slack_cloud_match_docs", {
          p_workspace_id: workspaceId,
          p_project_id: projectId,
          p_query_embedding: embedding ? halfvecLiteral(embedding) : null,
          p_query_text: query,
          p_match_count: matchCount,
          p_embedding_model: VOYAGE_MODEL,
        });
        if (error) throw new Error(error.message);
        return ((data ?? []) as MatchRow[]).map(
          (r): SlackDocFragment => ({
            folder: r.folder,
            path: r.path,
            headingPath: r.heading_path,
            startLine: r.start_line,
            endLine: r.end_line,
            content: r.content,
          }),
        );
      },
      embedQuery,
      slack: (botToken) => slackWebApi(botToken),
      generate: (ai, prompt) => slackCloudGenerate(ai, prompt, { signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS) }),
      background(work) {
        if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
      },
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    // A database failure before the answer started. Slack retries a 5xx, and the event-id
    // claim keeps a retry from answering twice.
    console.warn(`slack-events: ${e instanceof Error ? e.message : "internal error"}`);
    return new Response(JSON.stringify({ error: "internal error" }), { status: 500 });
  }
});
