// apps/api/src/runtime/resolve-runtime.ts
import { isAgentRuntime, type AgentRuntimeKind } from "@kermanych/core";

// Increment-2 preference resolution: env override (dev) beats cached preference beats omp default.
// Called by supervisor.runtimeFor() to stamp Session.runtime at creation; the stamped value then
// controls launch/resume (avoiding preference-switch breaking resume when the stamped and cached
// runtimes differ).
export function resolveRuntime(
  env: string | undefined,
  cached: AgentRuntimeKind | undefined,
): AgentRuntimeKind {
  if (isAgentRuntime(env)) return env;
  return cached ?? "omp";
}
