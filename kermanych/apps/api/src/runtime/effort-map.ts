import type { ThinkingLevel } from "@kermanych/core";
import type { EffortLevel, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

// omp's 7-rung ladder collapses onto claude's 5 effort levels. `off` disables thinking and
// carries no effort; `minimal` (no claude counterpart) folds to `low`; the top five are 1:1.
export function toClaudeEffort(level: ThinkingLevel): EffortLevel | null {
  switch (level) {
    case "off": return null;
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "xhigh": return "xhigh";
    case "max": return "max";
  }
}

export function toClaudeThinking(level: ThinkingLevel): ThinkingConfig {
  return level === "off" ? { type: "disabled" } : { type: "adaptive" };
}

// claude reports its effort; the five values are all valid ThinkingLevel members, so a
// non-null effort passes through, and absence reads as `off`. A session launched at
// `minimal` reads back as `low` — accepted (documented in the spec).
export function fromClaudeEffort(effort: EffortLevel | null | undefined): ThinkingLevel {
  return effort ?? "off";
}
