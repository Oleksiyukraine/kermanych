// apps/api/src/runtime/resolve-language.ts
import { isAgentLanguage, agentLanguageDirective, type AgentLanguage } from "@kermanych/core";

// The agent communication language for a launch: env override (dev) beats the cached cloud
// preference. Unlike the runtime, there is no default — an unset preference resolves to
// undefined, meaning "inject nothing" and let the agent keep its own default.
export function resolveLanguage(
  env: string | undefined,
  cached: AgentLanguage | undefined,
): AgentLanguage | undefined {
  if (isAgentLanguage(env)) return env;
  return cached;
}

// The system-prompt append for a launch, or undefined when no language is chosen. Shared by
// every createRuntime() call site (supervisor, management chat, release notes) so the
// directive text and its resolution precedence live in exactly one place.
export function languageAppendFor(
  cached: AgentLanguage | undefined,
  env: string | undefined = process.env.KERMANYCH_LANGUAGE,
): string | undefined {
  const lang = resolveLanguage(env, cached);
  return lang ? agentLanguageDirective(lang) : undefined;
}
