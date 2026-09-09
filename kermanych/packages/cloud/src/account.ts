// The signed-in user's per-account settings on the shared cloud. Same JWT-scoped,
// RLS-guarded pattern as workspaces.ts; the snake_case<->camelCase boundary lives here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAgentRuntime, isAgentLanguage, type AgentRuntime, type AgentLanguage } from "@kermanych/core";

// The user's chosen agent runtime, or null when unset ("not chosen yet" → onboarding).
// An unknown/garbage value from a newer or hand-edited row degrades to null rather than
// crashing the picker. Reads the caller's own row (RLS: profiles_select is `using (true)`,
// but we scope to auth.uid() for a single row).
export async function getMyAgentRuntime(client: SupabaseClient): Promise<AgentRuntime | null> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;
  const { data, error } = await client.from("profiles").select("agent_runtime").eq("id", uid).single();
  if (error || !data) return null;
  if (typeof data !== "object" || !("agent_runtime" in data)) return null;
  const v = data.agent_runtime;
  return isAgentRuntime(v) ? v : null;
}

// Persist the caller's choice. RLS `profiles_update_own` permits updating only auth.uid()'s
// row, so the eq() is defence-in-depth plus a single-row target.
export async function setMyAgentRuntime(client: SupabaseClient, kind: AgentRuntime): Promise<void> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("not signed in");
  const { error } = await client.from("profiles").update({ agent_runtime: kind }).eq("id", uid);
  if (error) throw new Error(error.message);
}

// The user's chosen communication language, or null when unset ("no preference" → the agent
// keeps its own default). Same tolerant read as the runtime: a garbage value from a newer or
// hand-edited row degrades to null rather than crashing the picker.
export async function getMyAgentLanguage(client: SupabaseClient): Promise<AgentLanguage | null> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;
  const { data, error } = await client.from("profiles").select("agent_language").eq("id", uid).single();
  if (error || !data) return null;
  if (typeof data !== "object" || !("agent_language" in data)) return null;
  const v = data.agent_language;
  return isAgentLanguage(v) ? v : null;
}

// Persist the caller's choice. RLS `profiles_update_own` permits updating only auth.uid()'s
// row, so the eq() is defence-in-depth plus a single-row target.
export async function setMyAgentLanguage(client: SupabaseClient, lang: AgentLanguage): Promise<void> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("not signed in");
  const { error } = await client.from("profiles").update({ agent_language: lang }).eq("id", uid);
  if (error) throw new Error(error.message);
}
