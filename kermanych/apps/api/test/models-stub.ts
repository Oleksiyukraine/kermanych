// apps/api/test/models-stub.ts
// DI stub for the supervisor specs, mirroring `skills-stub.ts`. The real ModelsService forks
// `omp models --json`, which these specs must never do: the answer depends on which provider
// credentials the machine running the suite happens to hold. A fixed one-model catalog is
// enough for every path the supervisor takes through it — resolving the provider `set_model`
// is addressed by, on a mid-run switch and on resume.
import type { ModelsService } from "../src/models/models.service";

export function stubModels(): ModelsService {
  const catalog = [
    { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", efforts: ["low", "medium", "high"] },
  ];
  return {
    list: async () => catalog,
    provider: async (id: string) => catalog.find((m) => m.id === id)?.provider,
  } as unknown as ModelsService;
}
