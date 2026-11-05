import { describe, it, expect } from "vitest";
import { ModelsService } from "../src/models/models.service";

// A ModelsService whose private `readOmp` spawn is swapped for a canned `omp models --json`
// payload, counting reads. No child process — the cache and validation logic is under test.
function svcWith(ompRaw: unknown) {
  const svc = new ModelsService();
  let reads = 0;
  // `readOmp` is private, so the compiler cannot see it here — a narrow named cast.
  const seam = svc as unknown as { readOmp: () => Promise<unknown> };
  seam.readOmp = async () => {
    reads++;
    return ompRaw;
  };
  return { svc, reads: () => reads };
}

const OMP_RAW = { models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", thinking: ["low", "high"] }] };

describe("ModelsService catalog", () => {
  it("list() returns the omp catalog", async () => {
    const { svc } = svcWith(OMP_RAW);
    expect(await svc.list()).toEqual([{ id: "gpt-5", name: "GPT-5", provider: "openai", efforts: ["low", "high"] }]);
  });

  it("caches the catalog under the TTL", async () => {
    const { svc, reads } = svcWith(OMP_RAW);
    const a = await svc.list();
    const b = await svc.list();
    expect(b).toBe(a);
    expect(reads()).toBe(1);
  });
});

describe("ModelsService.validModel", () => {
  it("drops a model omp's catalog does not list", async () => {
    const { svc } = svcWith(OMP_RAW);
    expect(await svc.validModel("claude-opus-4-8")).toBeUndefined();
  });

  it("keeps a model omp lists", async () => {
    const { svc } = svcWith(OMP_RAW);
    expect(await svc.validModel("gpt-5")).toBe("gpt-5");
  });

  it("returns undefined when no model is wanted", async () => {
    const { svc } = svcWith(OMP_RAW);
    expect(await svc.validModel(undefined)).toBeUndefined();
  });

  it("keeps the wanted id when the catalog is unreadable ([]), never clobbering on a transient failure", async () => {
    const { svc } = svcWith({ models: [] });
    expect(await svc.validModel("gpt-5")).toBe("gpt-5");
  });
});
