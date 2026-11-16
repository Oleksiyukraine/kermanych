// packages/core/test/research.spec.ts
import { expect, test } from "vitest";
import { researchAppend } from "../src";

test("researchAppend names the project, lists the siblings and states the read-only rules", () => {
  const p = researchAppend({ name: "api", localRepoPath: "/r/api" }, [{ name: "ui", localRepoPath: "/r/ui" }]);
  expect(p).toContain("«api»");
  expect(p).toContain("`/r/api`");
  expect(p).toContain("- «ui»: `/r/ui`");
  expect(p).toMatch(/web/);
  expect(p).toMatch(/Never write code or documents/);
  expect(p).toContain("«Нова задача»");
  expect(p).toContain("«Глибокий аналіз»");
});

test("researchAppend without siblings mentions no other projects", () => {
  const p = researchAppend({ name: "api", localRepoPath: "/r/api" }, []);
  expect(p).not.toMatch(/other projects of the same workspace/);
  expect(p).toContain("`/r/api`");
});
