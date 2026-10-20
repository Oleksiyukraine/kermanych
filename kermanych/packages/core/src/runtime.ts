// The agent-runtime backend a session runs on. Mirrors ThinkingLevel's shape: a frozen
// tuple as the single source of truth, a derived union type, and a boundary guard used
// wherever the value arrives as an unvalidated string (HTTP body, cloud row, env var).
export const AGENT_RUNTIMES = ["omp", "claude-code"] as const;
export type AgentRuntimeKind = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(v: unknown): v is AgentRuntimeKind {
  return typeof v === "string" && (AGENT_RUNTIMES as readonly string[]).includes(v);
}

// The harnesses a NATIVE session can run as its own TUI (docs/specs/2026-10-16-native-codex.md).
// A superset of the managed backends: `codex` exists only natively, so it never becomes an
// account preference, a `KERMANYCH_RUNTIME` value or a `createRuntime` kind. `Session.runtime`
// holds one of these; managed code narrows it with `managedRuntime`.
export const NATIVE_HARNESSES = ["omp", "claude-code", "codex"] as const;
export type NativeHarness = (typeof NATIVE_HARNESSES)[number];

export function isNativeHarness(v: unknown): v is NativeHarness {
  return typeof v === "string" && (NATIVE_HARNESSES as readonly string[]).includes(v);
}

// A session's runtime as a managed backend. Unset is the omp default, as everywhere. A
// native-only harness throws: native rows never take a managed path, and this makes any
// path that would hand one to a managed runtime fail loudly instead of running it as claude.
export function managedRuntime(v: NativeHarness | undefined): AgentRuntimeKind {
  if (v === undefined) return "omp";
  if (isAgentRuntime(v)) return v;
  throw new Error(`${v} runs only as a native session`);
}
