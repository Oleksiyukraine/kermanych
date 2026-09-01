// apps/api/src/models/omp-models.ts
// `omp models --json` → ModelOption[]. Pure, and paranoid for the same reason as
// omp-usage.ts: the payload comes from a separately-versioned binary on the user's PATH, so
// every field is treated as unknown. An entry the mapper cannot name and address is DROPPED
// rather than defaulted — a model row with a guessed id would launch a session on the wrong
// model, and one with a guessed provider could not be addressed over RPC at all
// (`set_model` takes provider + modelId).
import { THINKING_LEVELS, type ModelOption, type ThinkingLevel } from "@kermanych/core";

type Raw = {
  models?: unknown;
};

type RawModel = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  thinking?: unknown;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function mapOmpModels(raw: unknown): ModelOption[] {
  const models = Array.isArray((raw as Raw | null)?.models) ? ((raw as Raw).models as RawModel[]) : [];
  const options: ModelOption[] = [];
  // provider/id is what identifies a model to omp; the same id can legitimately appear under
  // two providers (a bedrock mirror of an anthropic model), so only the pair dedupes.
  const seen = new Set<string>();
  for (const model of models) {
    const id = str(model?.id);
    const provider = str(model?.provider);
    if (id === undefined || provider === undefined) continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The thinking ladder in omp's own order — it is ascending, and the picker renders it as
    // a ladder, so re-sorting here would only invent a second source of truth. A
    // non-reasoning model reports `thinking: null`: an empty ladder, not a broken entry. A
    // level this build cannot type (a newer omp adding one) is dropped rather than offered —
    // omp would silently clamp the request and the session would run at another level.
    const thinking = model?.thinking;
    const efforts = Array.isArray(thinking)
      ? thinking.filter((l): l is ThinkingLevel => THINKING_LEVELS.includes(l as ThinkingLevel))
      : [];
    // An entry without a display name is still selectable — the id reads fine in a picker.
    options.push({ id, name: str(model?.name) ?? id, provider, efforts });
  }
  // No sort: omp already groups by provider and orders by id, which is the order its own
  // `--model` fuzzy matcher resolves in.
  return options;
}
