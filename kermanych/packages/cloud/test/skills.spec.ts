// packages/cloud/test/skills.spec.ts
import { expect, test } from "vitest";
import { toProjectSkill } from "../src/skills";

test("maps a row to camelCase and omits a null author", () => {
  const s = toProjectSkill({
    project_id: "p1",
    name: "opening-a-pr",
    description: "d",
    body: "b",
    enabled: true,
    updated_at: "2026-08-27T10:00:00Z",
    updated_by: null,
  });
  expect(s).toEqual({
    projectId: "p1",
    name: "opening-a-pr",
    description: "d",
    body: "b",
    enabled: true,
    updatedAt: "2026-08-27T10:00:00Z",
  });
  // toEqual treats `{ updatedBy: undefined }` as equal to an absent key, so the omission
  // itself — what keeps a mapped skill free of null noise in Vue's reactivity — needs its
  // own assertion.
  expect("updatedBy" in s).toBe(false);
});

test("keeps a present author", () => {
  const s = toProjectSkill({
    project_id: "p1",
    name: "x",
    description: "d",
    body: "b",
    enabled: false,
    updated_at: "2026-08-27T10:00:00Z",
    updated_by: "u1",
  });
  expect(s.updatedBy).toBe("u1");
  expect(s.enabled).toBe(false);
});
