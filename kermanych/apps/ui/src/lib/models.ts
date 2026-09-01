// What the three model pickers offer, as pure functions. Same reason as lib/members.ts:
// apps/ui has no component tests, so the part that can be WRONG — how a model is labelled
// and which efforts a model admits — lives here and is unit-tested, while the .vue files
// only place it on screen.
//
// Three surfaces read these: the Агенти launcher, the board's task editor, and the live
// picker on a running session (KPanel). They MUST agree — a task filed on the board and an
// agent started by hand have to name the same models — and a shared rule is the only way
// that stays true, since a comment asking for it has no way to fail.
import { THINKING_LEVELS, type ModelOption, type ThinkingLevel } from '@kermanych/core';

// Structural on purpose: this is KSelect's `{value,label}` option, but lib/ must not import
// a .vue file to say so. Assignability does the rest.
export type PickOption = { value: string; label: string };

// The catalog is whatever providers this machine holds credentials for, so on a normal
// install it is 26 anthropic models and nothing else — suffixing every row with
// «· anthropic» would distinguish nothing and cost the model name its width. The provider
// only earns a place once there is more than one to tell apart.
//
// omp's display names are NOT unique: a pinned snapshot carries the same name as its moving
// alias (`claude-haiku-4-5` and `claude-haiku-4-5-20251001` are both «Claude Haiku 4.5»).
// Two identical rows in a picker are a coin toss over which model the session launches on,
// so a name shared by more than one entry gets its id appended — the id is the thing omp
// resolves, and it is the only text that tells the pair apart.
export function modelOptions(models: readonly ModelOption[]): PickOption[] {
  const multi = new Set(models.map((m) => m.provider)).size > 1;
  const seen = new Map<string, number>();
  for (const m of models) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);
  return models.map((m) => {
    const name = (seen.get(m.name) ?? 0) > 1 ? `${m.name} · ${m.id}` : m.name;
    return { value: m.id, label: multi ? `${name} · ${m.provider}` : name };
  });
}

// The thinking ladder a model accepts. Three answers, and the difference matters:
//   • a known model  → its own `efforts`, which for a non-reasoning model is EMPTY, and an
//     empty list is what makes the picker say «недоступно» instead of offering seven levels
//     omp would refuse;
//   • nothing chosen → the full ladder, because «за замовчуванням» means the operator has
//     not narrowed the choice yet;
//   • a model the catalog does not know → also the full ladder. That is an operator alias
//     stored before this feature («opus-5») or an omp we could not read; omp clamps a level
//     it cannot honour and the session row reports back what it settled on, so offering the
//     ladder is more useful than offering nothing.
export function effortOptions(
  models: readonly ModelOption[],
  modelId: string | undefined,
): readonly ThinkingLevel[] {
  if (!modelId) return THINKING_LEVELS;
  return models.find((m) => m.id === modelId)?.efforts ?? THINKING_LEVELS;
}
