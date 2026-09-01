// apps/api/test/omp-models.spec.ts
import { expect, test } from "vitest";
import { mapOmpModels } from "../src/models/omp-models";

// The shape `omp models --json` actually emits, trimmed to the fields the mapper reads —
// the fat ones (selector, maxTokens, cost, input) are present to prove they are ignored.
function model(id: string, name: string, thinking: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    provider: "anthropic",
    id,
    selector: `anthropic/${id}`,
    name,
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: Array.isArray(thinking),
    thinking,
    input: ["text", "image"],
    cost: { input: 3, output: 15 },
    ...extra,
  };
}

// The bug this feature exists for: Claude Fable 5 is in the local catalog and was missing
// from a hardcoded three-item picker. It arrives with the full five-level ladder.
test("a real anthropic catalog maps to id, name, provider and the model's own ladder", () => {
  expect(
    mapOmpModels({
      models: [
        model("claude-fable-5", "Claude Fable 5", ["low", "medium", "high", "xhigh", "max"], {
          contextWindow: 1_000_000,
        }),
        model("claude-opus-4-8", "Claude Opus 4.8", ["minimal", "low", "medium", "high", "max"]),
      ],
    }),
  ).toEqual([
    {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      provider: "anthropic",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      provider: "anthropic",
      efforts: ["minimal", "low", "medium", "high", "max"],
    },
  ]);
});

// A model without reasoning reports `thinking: null`. That is an empty ladder — the model is
// still selectable, the picker just offers it no effort control.
test("a non-reasoning model is selectable with no ladder", () => {
  expect(mapOmpModels({ models: [model("claude-3-5-sonnet-20240620", "Claude Sonnet 3.5", null)] })).toEqual([
    { id: "claude-3-5-sonnet-20240620", name: "Claude Sonnet 3.5", provider: "anthropic", efforts: [] },
  ]);
});

// A newer omp inventing a level this build cannot type must not reach the picker: omp clamps
// an unsupported request and reports success, so the session would silently run elsewhere.
// Its valid neighbours are unaffected, and omp's ascending order is preserved.
test("an unknown effort is filtered out and its neighbours survive in order", () => {
  expect(
    mapOmpModels({ models: [model("claude-x", "Claude X", ["low", "ultra", "high", 7, null, "max"])] })[0]?.efforts,
  ).toEqual(["low", "high", "max"]);
});

// An entry the mapper cannot address is dropped, never defaulted: a guessed id would launch
// the wrong model, and a guessed provider could not be addressed over RPC at all.
test("an entry without a usable id or provider is dropped", () => {
  expect(
    mapOmpModels({
      models: [
        { provider: "anthropic", name: "No id" },
        { provider: "anthropic", id: "   ", name: "Blank id" },
        { id: "orphan-1", name: "No provider" },
        { provider: 42, id: "bad-provider" },
        model("claude-fable-5", "Claude Fable 5", ["max"]),
      ],
    }),
  ).toEqual([{ id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic", efforts: ["max"] }]);
});

// provider+id is the identity omp addresses a model by, and it is also what
// ModelsService.provider() resolves against — the first entry is omp's own precedence.
test("a repeated provider and id keeps the first entry only", () => {
  expect(
    mapOmpModels({
      models: [
        model("claude-fable-5", "Claude Fable 5", ["high", "max"]),
        model("claude-fable-5", "Claude Fable 5 (stale)", []),
        // Same id under another provider is a different model (a bedrock mirror), so it stays.
        model("claude-fable-5", "Claude Fable 5 on Bedrock", ["high"], { provider: "bedrock" }),
      ],
    }),
  ).toEqual([
    { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic", efforts: ["high", "max"] },
    { id: "claude-fable-5", name: "Claude Fable 5 on Bedrock", provider: "bedrock", efforts: ["high"] },
  ]);
});

// Nothing off a separately-versioned binary may throw into a GET: an empty catalog degrades
// the picker to the session's stored model, an exception would be a 500.
test("garbage input yields an empty catalog without throwing", () => {
  expect(mapOmpModels(undefined)).toEqual([]);
  expect(mapOmpModels(null)).toEqual([]);
  expect(mapOmpModels({})).toEqual([]);
  expect(mapOmpModels({ models: "x" })).toEqual([]);
  expect(mapOmpModels({ models: [null, undefined, 7, "claude", []] })).toEqual([]);
});

// The name is cosmetic, so an entry that omits it still reaches the picker under its id —
// unlike id and provider, nothing breaks by falling back.
test("a missing name falls back to the id", () => {
  expect(mapOmpModels({ models: [{ provider: "anthropic", id: "claude-fable-5" }] })).toEqual([
    { id: "claude-fable-5", name: "claude-fable-5", provider: "anthropic", efforts: [] },
  ]);
});
