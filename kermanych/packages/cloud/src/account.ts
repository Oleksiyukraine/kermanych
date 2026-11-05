// The signed-in user's per-account settings on the shared cloud. Same JWT-scoped,
// RLS-guarded pattern as workspaces.ts; the snake_case<->camelCase boundary lives here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAgentProvider, isAgentLanguage, type AgentProvider, type AgentLanguage } from "@kermanych/core";

// The user's AI provider (docs/specs/2026-11-05-remove-managed-claude-code.md), stored in the
// column the removed runtime preference used. `null` means the row holds none yet («not
// chosen» → the onboarding gate); an unknown value from a newer or hand-edited row reads as
// `null` too, so the gate asks again rather than crashing the picker. Unlike the language read,
// a failed read THROWS: the gate must not lock out an operator whose cloud is unreachable.
// Reads the caller's own row (RLS: profiles_select is `using (true)`, but we scope to
// auth.uid() for a single row).
export async function getMyAgentProvider(client: SupabaseClient): Promise<AgentProvider | null> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("not signed in");
  const { data, error } = await client.from("profiles").select("agent_runtime").eq("id", uid).single();
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "object" || !("agent_runtime" in data)) throw new Error("profile row has no agent_runtime");
  const v = data.agent_runtime;
  return isAgentProvider(v) ? v : null;
}

// Persist the caller's choice. RLS `profiles_update_own` permits updating only auth.uid()'s
// row, so the eq() is defence-in-depth plus a single-row target.
export async function setMyAgentProvider(client: SupabaseClient, provider: AgentProvider): Promise<void> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("not signed in");
  const { error } = await client.from("profiles").update({ agent_runtime: provider }).eq("id", uid);
  if (error) throw new Error(error.message);
}

// The user's chosen communication language, or null when unset ("no preference" → the agent
// keeps its own default). A garbage value from a newer or hand-edited row degrades to null
// rather than crashing the picker.
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
