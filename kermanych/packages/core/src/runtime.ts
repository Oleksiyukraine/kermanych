// The agent-runtime backend a session runs on. Mirrors ThinkingLevel's shape: a frozen
// tuple as the single source of truth, a derived union type, and a boundary guard used
// wherever the value arrives as an unvalidated string (HTTP body, cloud row, env var).
export const AGENT_RUNTIMES = ["omp", "claude-code"] as const;
export type AgentRuntimeKind = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(v: unknown): v is AgentRuntimeKind {
  return typeof v === "string" && (AGENT_RUNTIMES as readonly string[]).includes(v);
}
