// routines-runner — the cloud runner of routines (docs/specs/2026-10-16-routines.md, «Cloud
// runner»). Fires the routines whose `runner` is `cloud`, every minute, whether or not anybody
// has Kermanych open. The logic is runner.ts; this file is the platform half.
//
// Two kinds of caller, told apart by how they authenticate (verify_jwt = false in config.toml,
// because the first has no user JWT):
//   • the minute tick and its own run dispatches — `x-routines-secret: <ROUTINES_RUNNER_SECRET>`,
//     sent by public.routines_cloud_tick() (pg_cron + pg_net) and by this function to itself:
//       tick — claim what is due, dispatch one invocation per run
//       run  — do one claimed run (answers 202 at once; the work continues in the background)
//   • a member, with their own JWT (supabase-js functions.invoke from the browser):
//       status         — which keys are set (never a key), the model, the repositories it reads
//       configure      — owner only: check and store the workspace's keys
//       slack-channels — the channels the workspace's bot is in
//       run-now        — the author's «Run now» on a cloud routine
//
// SECURITY MODEL. The agreed exception to docs-rag's «caller's JWT only»: a timer has no caller,
// so the runner reads and writes with the service role, which exists only in this runtime. A
// member action first proves who the caller is and what they may do with THEIR JWT (RLS answers
// «is this my workspace», workspaces.owner_id answers «am I its owner»), and only then touches
// the service role. Keys are never returned and never logged; neither are documents or prompts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/cors.ts";
import { configure, executeRun, runNow, slackChannels, status, tick, type Caller, type Deps } from "./runner.ts";
import { RunFailure } from "./failure.ts";
import { serviceStore } from "./store.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

// The platform's wall clock is 150 s on the free plan (400 s paid); a run keeps a margin for its
// last database write. Raise ROUTINES_RUN_BUDGET_MS on a paid plan for longer investigations.
const DEFAULT_RUN_BUDGET_MS = 130_000;

function background(p: Promise<unknown>): void {
  const guarded = p.catch((e) => console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(guarded);
}

// Constant-time, so the secret cannot be guessed a character at a time.
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(405, { error: "method not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const runnerSecret = Deno.env.get("ROUTINES_RUNNER_SECRET");
  if (!url || !serviceKey || !publicKey || !runnerSecret) return jsonResponse(500, { error: "function not configured" });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object") throw new Error("body must be an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const self = `${url.replace(/\/$/, "")}/functions/v1/routines-runner`;
  const deps: Deps = {
    store: serviceStore(db),
    fetch,
    now: Date.now,
    runBudgetMs: Number(Deno.env.get("ROUTINES_RUN_BUDGET_MS")) || DEFAULT_RUN_BUDGET_MS,
    // One invocation per run: its wall clock is its own, not the tick's.
    dispatch: async (runId) => {
      background(
        fetch(self, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-routines-secret": runnerSecret, Authorization: `Bearer ${publicKey}` },
          body: JSON.stringify({ action: "run", runId }),
        }),
      );
    },
  };

  try {
    // ── the timer and its dispatches ──
    const presented = req.headers.get("x-routines-secret");
    if (presented !== null) {
      if (!sameSecret(presented, runnerSecret)) return jsonResponse(401, { error: "bad secret" });
      if (body.action === "tick") {
        const out = await tick(deps);
        console.log(JSON.stringify({ action: "tick", ...out }));
        return jsonResponse(200, out);
      }
      if (body.action === "run" && typeof body.runId === "string") {
        const runId = body.runId;
        background(
          executeRun(deps, runId).then((r) => console.log(JSON.stringify({ action: "run", runId, status: r?.status ?? "not running", code: r?.errorCode }))),
        );
        return jsonResponse(202, { runId });
      }
      return jsonResponse(400, { error: "unknown action" });
    }

    // ── a member ──
    const auth = req.headers.get("Authorization");
    if (!auth) return jsonResponse(401, { error: "missing authorization" });
    const asCaller = createClient(url, publicKey, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const who = await asCaller.auth.getUser();
    if (who.error || !who.data.user) return jsonResponse(401, { error: "not signed in" });
    const userId = who.data.user.id;
    const caller: Caller = {
      userId,
      // RLS decides: a workspace the caller is not a member of is not there to select.
      isMember: async (ws) => !!(await asCaller.from("workspaces").select("id").eq("id", ws).maybeSingle()).data,
      isOwner: async (ws) => (await asCaller.from("workspaces").select("owner_id").eq("id", ws).maybeSingle()).data?.owner_id === userId,
    };
    const ws = typeof body.workspaceId === "string" ? body.workspaceId : "";
    switch (body.action) {
      case "status":
        return jsonResponse(200, await status(deps, caller, ws));
      case "configure":
        return jsonResponse(
          200,
          await configure(deps, caller, ws, {
            ...(typeof body.anthropicApiKey === "string" ? { anthropicApiKey: body.anthropicApiKey } : {}),
            ...(typeof body.anthropicModel === "string" ? { anthropicModel: body.anthropicModel } : {}),
            ...(typeof body.githubToken === "string" ? { githubToken: body.githubToken } : {}),
            ...(typeof body.slackBotToken === "string" ? { slackBotToken: body.slackBotToken } : {}),
          }),
        );
      case "slack-channels":
        return jsonResponse(200, await slackChannels(deps, caller, ws));
      case "run-now":
        return jsonResponse(200, await runNow(deps, caller, typeof body.routineId === "string" ? body.routineId : ""));
      default:
        return jsonResponse(400, { error: "unknown action" });
    }
  } catch (e) {
    // A refusal the caller can act on is a 400 with its sentence; anything else is a 500 with
    // the message only — never a key, a prompt or a document.
    if (e instanceof RunFailure) return jsonResponse(e.code === "not_found" ? 404 : e.code === "not_owner" || e.code === "not_author" ? 403 : 400, { error: e.message });
    return jsonResponse(500, { error: e instanceof Error ? e.message : "internal error" });
  }
});
