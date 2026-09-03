import { describe, it, expect, vi } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "@kermanych/core";
import { ModelsService } from "../src/models/models.service";
import { mapClaudeModels } from "../src/models/claude-models";

// A ModelsService with both catalog sources faked: the claude side via the injectable
// `claudeCatalog` seam, the omp side by overriding the private `readOmp` spawn with a canned
// `omp models --json` payload. No child process, no SDK query — the branch + cache logic is
// what's under test.
function svcWith(claude: () => Promise<ModelOption[]>, ompRaw: unknown) {
  const svc = new ModelsService();
  svc.claudeCatalog = claude;
  // Test seam: swap the private `omp models --json` spawn for a canned payload. `readOmp` is
  // private, so the compiler cannot see it here — a narrow named cast, not raw external input.
  const seam = svc as unknown as { readOmp: () => Promise<unknown> };
  seam.readOmp = async () => ompRaw;
  return svc;
}

const OMP_RAW = { models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", thinking: ["low", "high"] }] };

describe("ModelsService runtime-aware catalog", () => {
  it("list('claude-code') returns the claude catalog", async () => {
    const claude: ModelOption[] = [{ id: "claude-opus-4-8", name: "Opus 4.8", provider: "anthropic", efforts: ["high", "max"] }];
    const svc = svcWith(async () => claude, OMP_RAW);
    expect(await svc.list("claude-code")).toEqual(claude);
  });

  it("list('omp') still returns the omp catalog", async () => {
    const spy = vi.fn(async (): Promise<ModelOption[]> => []);
    const svc = svcWith(spy, OMP_RAW);
    expect(await svc.list("omp")).toEqual([
      { id: "gpt-5", name: "GPT-5", provider: "openai", efforts: ["low", "high"] },
    ]);
    expect(spy).not.toHaveBeenCalled(); // omp branch never touches the claude fetcher
  });

  it("caches per runtime under one TTL: each backend fetched once, buckets independent", async () => {
    const claudeFetch = vi.fn(async (): Promise<ModelOption[]> => [
      { id: "claude-opus-4-8", name: "Opus 4.8", provider: "anthropic", efforts: [] },
    ]);
    const svc = svcWith(claudeFetch, OMP_RAW);

    const a = await svc.list("claude-code");
    const b = await svc.list("claude-code");
    expect(b).toBe(a); // second read is the cached value, not a re-fetch
    expect(claudeFetch).toHaveBeenCalledTimes(1);

    // The omp bucket is separate: it returns the omp catalog, not the cached claude one.
    const omp = await svc.list("omp");
    expect(omp[0].provider).toBe("openai");
    expect(claudeFetch).toHaveBeenCalledTimes(1);
  });

  it("claude catalog failure degrades to []", async () => {
    const svc = svcWith(async () => { throw new Error("no SDK"); }, OMP_RAW);
    expect(await svc.list("claude-code")).toEqual([]);
  });
});

describe("mapClaudeModels", () => {
  it("maps ModelInfo[] to ModelOption[] with anthropic provider and inverse effort ladder", () => {
    const infos: ModelInfo[] = [
      { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "", supportedEffortLevels: ["low", "high", "max"] },
      { value: "claude-haiku", displayName: "Haiku", description: "" }, // no effort levels → non-reasoning
    ];
    expect(mapClaudeModels(infos)).toEqual([
      { id: "claude-opus-4-8", name: "Opus 4.8", provider: "anthropic", efforts: ["low", "high", "max"] },
      { id: "claude-haiku", name: "Haiku", provider: "anthropic", efforts: [] },
    ]);
  });

  it("drops entries without an addressable value and dedupes by id", () => {
    const infos = [
      { value: "", displayName: "Blank", description: "" },
      { value: "dup", displayName: "First", description: "" },
      { value: "dup", displayName: "Second", description: "" },
    ] as ModelInfo[];
    expect(mapClaudeModels(infos)).toEqual([{ id: "dup", name: "First", provider: "anthropic", efforts: [] }]);
  });
});
