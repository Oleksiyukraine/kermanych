// The harnesses a NATIVE session can run as its own TUI (docs/specs/2026-10-16-native-codex.md).
// A frozen tuple as the single source of truth, a derived union type, and a boundary guard used
// wherever the value arrives as an unvalidated string (HTTP body, cloud row). `Session.runtime`
// holds one of these. A managed («Керманич») session always runs omp: the managed claude-code
// backend was removed (docs/specs/2026-11-05-remove-managed-claude-code.md), so a managed row
// stamped with anything else is a leftover the supervisor refuses to spawn.
export const NATIVE_HARNESSES = ["omp", "claude-code", "codex"] as const;
export type NativeHarness = (typeof NATIVE_HARNESSES)[number];

export function isNativeHarness(v: unknown): v is NativeHarness {
  return typeof v === "string" && (NATIVE_HARNESSES as readonly string[]).includes(v);
}

// The operator's AI provider: Settings → «ШІ-провайдер», stored in `profiles.agent_runtime`.
// The same ids as NativeHarness with a different meaning: the provider picks the launch mode
// wherever the operator does not pick one, and provider `omp` means «Керманич» (the managed omp
// session), not native omp. Kermanych's own AI functions run on omp whatever the provider.
export const AGENT_PROVIDERS = ["omp", "claude-code", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function isAgentProvider(v: unknown): v is AgentProvider {
  return typeof v === "string" && (AGENT_PROVIDERS as readonly string[]).includes(v);
}

// The native harness a provider launches by default; undefined is «Керманич». An unset provider
// (not chosen yet, or unreadable) is «Керманич» too.
export function providerHarness(p: AgentProvider | null | undefined): NativeHarness | undefined {
  return p === "claude-code" || p === "codex" ? p : undefined;
}
