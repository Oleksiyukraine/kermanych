// apps/api/test/seed.spec.ts
import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";
import { seedDemo } from "../src/preview/seed";
import type { SessionStatus } from "@kermanych/core";

// RegistryService accepts ":memory:" explicitly (it skips the mkdir), so each test runs
// on a throwaway DB with no disk footprint — the same isolation a real preview api gets.

test("seedDemo populates an empty registry across every status, both modes, and the archive", () => {
  const reg = new RegistryService(":memory:");
  seedDemo(reg);

  expect(reg.listGroups().length).toBe(2);
  const sessions = reg.listSessions();
  expect(sessions.length).toBe(12);

  // Every SessionStatus the board can render is present, so no status dot is left untested.
  const ALL: SessionStatus[] = [
    "queued", "thinking", "tool", "waiting_input", "done", "error", "stopped", "merged", "conflict",
  ];
  const seen = new Set(sessions.map((s) => s.status));
  for (const st of ALL) expect(seen.has(st)).toBe(true);

  // The archived filter has content, and an in-place (non-worktree) row exists.
  expect(sessions.some((s) => s.archived)).toBe(true);
  expect(sessions.some((s) => !s.worktree)).toBe(true);
});

test("seedDemo is idempotent — a populated registry is left untouched", () => {
  const reg = new RegistryService(":memory:");
  seedDemo(reg);
  const before = reg.listSessions().length;
  seedDemo(reg);
  expect(reg.listGroups().length).toBe(2);
  expect(reg.listSessions().length).toBe(before);
});
