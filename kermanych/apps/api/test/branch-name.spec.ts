// apps/api/test/branch-name.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OneShotInput } from "../src/runtime/one-shot";

const calls: OneShotInput[] = [];
let answer: () => Promise<{ text: string }> = async () => ({ text: "add-oauth-login" });
vi.mock("../src/runtime/one-shot", () => ({
  runOneShot: async (opts: OneShotInput) => {
    calls.push(opts);
    return answer();
  },
}));

import { BranchNameService, branchNamePrompt, modelBranchSlug } from "../src/supervisor/branch-name.service";

function service(): BranchNameService {
  return new BranchNameService();
}

describe("modelBranchSlug", () => {
  it("keeps a clean slug as it is", () => {
    expect(modelBranchSlug("add-oauth-login")).toBe("add-oauth-login");
  });
  it("takes the first non-empty line and drops quotes and backticks", () => {
    expect(modelBranchSlug("\n  `generate-branch-name`\nBecause the task…")).toBe("generate-branch-name");
  });
  it("drops a prefix the model wrote anyway", () => {
    expect(modelBranchSlug("feature/Generate Branch Name")).toBe("generate-branch-name");
  });
  it("caps a long answer on a whole word", () => {
    expect(modelBranchSlug("generate-git-branch-names-from-the-task-context-automatically")).toBe(
      "generate-git-branch-names-from-the-task",
    );
  });
  it("is no answer when nothing usable is left", () => {
    expect(modelBranchSlug("")).toBeUndefined();
    expect(modelBranchSlug("feature/")).toBeUndefined();
    expect(modelBranchSlug("—")).toBeUndefined();
  });
});

describe("branchNamePrompt", () => {
  it("carries the title and the description, the description capped", () => {
    const p = branchNamePrompt({ title: "Експорт CSV", description: "x".repeat(5000) });
    expect(p).toContain("<task-title>\nЕкспорт CSV\n</task-title>");
    expect(p).toContain(`<task-description>\n${"x".repeat(4000)}\n</task-description>`);
  });
  it("leaves out a description that only repeats the title", () => {
    expect(branchNamePrompt({ title: "Fix login", description: "Fix login" })).not.toContain("<task-description>");
  });
});

describe("BranchNameService.suggest", () => {
  beforeEach(() => {
    calls.length = 0;
    answer = async () => ({ text: "add-oauth-login" });
  });

  it("asks omp's smol role, tool-less, with the launch bounds", async () => {
    expect(await service().suggest({ title: "Додати вхід через GitHub", description: "OAuth" })).toBe("add-oauth-login");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "pi/smol", noTools: true, startTimeoutMs: 15_000, turnTimeoutMs: 15_000 });
  });

  it("answers undefined when the model fails, so the launch falls back", async () => {
    answer = async () => {
      throw new Error("generation_timeout");
    };
    expect(await service().suggest({ title: "Add login" })).toBeUndefined();
  });

  it("answers undefined when the answer holds no slug", async () => {
    answer = async () => ({ text: "—" });
    expect(await service().suggest({ title: "Add login" })).toBeUndefined();
  });

  it("asks nothing for an empty task", async () => {
    expect(await service().suggest({ title: "  " })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
