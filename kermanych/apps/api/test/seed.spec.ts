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

  expect(reg.listProjects().length).toBe(2);
  // The preview has no cloud: seeded projects carry synthetic UUIDs and every seeded
  // session must hang off one of them.
  const ids = new Set(reg.listProjects().map((p) => p.id));
  expect(ids.size).toBe(2);
  expect(reg.listSessions().every((s) => ids.has(s.projectId))).toBe(true);
  const sessions = reg.listSessions();
  expect(sessions.length).toBe(16);

  // Every SessionStatus the board can render is present, so no status dot is left untested.
  const ALL: SessionStatus[] = [
    "queued", "thinking", "tool", "waiting_input", "done", "in_review", "error", "stopped", "merged", "conflict",
  ];
  const seen = new Set(sessions.map((s) => s.status));
  for (const st of ALL) expect(seen.has(st)).toBe(true);

  // The archived filter has content, and an in-place (non-worktree) row exists.
  expect(sessions.some((s) => s.archived)).toBe(true);
  expect(sessions.some((s) => !s.worktree)).toBe(true);

  // The board draws a one-level tree, so the seed has to contain one: branches forked off a
  // parent (both kinds), including an agent with more than one — the case where the fork
  // cards have to read as one bracket rather than a chain hanging off each other.
  const forks = sessions.filter((s) => s.parentSessionId);
  expect(forks.length).toBe(3);
  expect(new Set(forks.map((s) => s.kind))).toEqual(new Set(["discussion", "review"]));
  expect(forks.every((s) => !s.worktree && !s.branch)).toBe(true);
  const perParent = new Map<string, number>();
  for (const f of forks) perParent.set(f.parentSessionId!, (perParent.get(f.parentSessionId!) ?? 0) + 1);
  expect(Math.max(...perParent.values())).toBe(2);
  // Every fork hangs off a seeded AGENT — never off another fork or a row that is not there.
  const agents = new Set(sessions.filter((s) => s.kind === "agent").map((s) => s.id));
  expect(forks.every((f) => agents.has(f.parentSessionId!))).toBe(true);

  // The board's accounting line needs both cases on screen: rows that were counted, and at
  // least one that never was — a seed where every row has a figure would hide the absent
  // case that real registries are full of.
  expect(sessions.filter((s) => s.usage).length).toBeGreaterThan(1);
  expect(sessions.some((s) => !s.usage)).toBe(true);
  expect(sessions.every((s) => !s.usage || s.usage.cost > 0)).toBe(true);
  // …and a model to name, since that is the other half of the line.
  expect(sessions.every((s) => !!s.model)).toBe(true);
});

test("seedDemo is idempotent — a populated registry is left untouched", () => {
  const reg = new RegistryService(":memory:");
  seedDemo(reg);
  const before = reg.listSessions().length;
  seedDemo(reg);
  expect(reg.listProjects().length).toBe(2);
  expect(reg.listSessions().length).toBe(before);
});
