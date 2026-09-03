// apps/api/src/models/claude-models.ts
// SDK `ModelInfo[]` (the claude runtime's own catalog) → `ModelOption[]`, the same shape
// `omp models --json` yields via omp-models.ts, so the picker (KComposer.vue) is unchanged.
// Paranoid for the same reason as omp-models.ts: the rows come from a separately-versioned
// SDK, so an entry the mapper cannot address (no `value`) is DROPPED rather than defaulted —
// a guessed id would launch a session on the wrong model. Every claude model is anthropic,
// so the provider is a constant, not a field to guess.
import type { ModelOption } from "@kermanych/core";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { fromClaudeEffort } from "../runtime/effort-map";
import { ClaudeCodeRuntime } from "../runtime/claude-code-runtime";

export function mapClaudeModels(models: ModelInfo[]): ModelOption[] {
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = typeof model?.value === "string" && model.value.trim() !== "" ? model.value.trim() : undefined;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    // The SDK effort levels (`low|medium|high|xhigh|max`) are the top rungs of the same ladder
    // omp reports; `fromClaudeEffort` is the inverse of `toClaudeEffort`, so each maps 1:1 back
    // to a ThinkingLevel. Absent → a non-reasoning model, i.e. an empty ladder.
    const efforts = (model.supportedEffortLevels ?? []).map(fromClaudeEffort);
    const name = typeof model.displayName === "string" && model.displayName.trim() !== "" ? model.displayName.trim() : id;
    options.push({ id, name, provider: "anthropic", efforts });
  }
  return options;
}

// The default claude catalog fetcher wired into ModelsService: ask the SDK over a throwaway
// query, then map. Kept here (not inline in the service) so the service depends on a plain
// `() => Promise<ModelOption[]>` seam a test can replace without touching the SDK.
export function fetchClaudeCatalog(): Promise<ModelOption[]> {
  return ClaudeCodeRuntime.supportedModels().then(mapClaudeModels);
}
