// apps/api/test/registry.outbox.spec.ts
import { expect, test } from "vitest";
import type { TaskReportsWrite } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";

test("enqueueTaskStatus keeps one latest-wins row per task", () => {
  const r = new RegistryService(":memory:");

  r.enqueueTaskStatus("task-1", "queued", "2026-08-21T10:00:00.000Z");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:05.000Z");

  const rows = r.listOutbox();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    taskId: "task-1",
    status: "thinking",
    updatedAt: "2026-08-21T10:00:05.000Z",
    attempts: 0,
    lastError: undefined,
  });
});

test("listOutbox returns every queued task oldest-first", () => {
  const r = new RegistryService(":memory:");

  r.enqueueTaskStatus("task-b", "done", "2026-08-21T11:00:00.000Z");
  r.enqueueTaskStatus("task-a", "thinking", "2026-08-21T10:00:00.000Z");

  expect(r.listOutbox().map((x) => x.taskId)).toEqual(["task-a", "task-b"]);
});

test("bumpOutboxAttempt increments attempts and persists last_error", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:00.000Z");

  r.bumpOutboxAttempt("task-1", "thinking", "2026-08-21T10:00:00.000Z", "fetch failed");
  expect(r.listOutbox()[0].attempts).toBe(1);
  expect(r.listOutbox()[0].lastError).toBe("fetch failed");

  r.bumpOutboxAttempt("task-1", "thinking", "2026-08-21T10:00:00.000Z", "not signed in");
  expect(r.listOutbox()[0].attempts).toBe(2);
  expect(r.listOutbox()[0].lastError).toBe("not signed in");
});

test("a fresh enqueue resets the retry counter of a failing row", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:00.000Z");
  r.bumpOutboxAttempt("task-1", "thinking", "2026-08-21T10:00:00.000Z", "fetch failed");

  r.enqueueTaskStatus("task-1", "done", "2026-08-21T10:00:30.000Z");

  expect(r.listOutbox()[0]).toEqual({
    taskId: "task-1",
    status: "done",
    updatedAt: "2026-08-21T10:00:30.000Z",
    attempts: 0,
    lastError: undefined,
  });
});

test("dropOutbox removes the row and leaves the rest", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "done", "2026-08-21T10:00:00.000Z");
  r.enqueueTaskStatus("task-2", "error", "2026-08-21T10:00:01.000Z");

  r.dropOutbox("task-1", "done", "2026-08-21T10:00:00.000Z");

  expect(r.listOutbox().map((x) => x.taskId)).toEqual(["task-2"]);
  r.dropOutbox("task-2", "error", "2026-08-21T10:00:01.000Z");
  expect(r.listOutbox()).toEqual([]);
});

test("dropOutbox retires only the version it was given", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:00.000Z");

  // What a mid-flight `session_update` does to the row being pushed.
  r.enqueueTaskStatus("task-1", "done", "2026-08-21T10:00:05.000Z");
  r.dropOutbox("task-1", "thinking", "2026-08-21T10:00:00.000Z");

  expect(r.listOutbox().map((x) => [x.status, x.updatedAt])).toEqual([["done", "2026-08-21T10:00:05.000Z"]]);
});

test("bumpOutboxAttempt charges only the version whose push failed", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:00.000Z");
  r.bumpOutboxAttempt("task-1", "thinking", "2026-08-21T10:00:00.000Z", "fetch failed");

  // A newer status lands while the failed push is still unwinding: it is a new delivery
  // and must start at zero, so the late bump for the old version must not touch it.
  r.enqueueTaskStatus("task-1", "done", "2026-08-21T10:00:05.000Z");
  r.bumpOutboxAttempt("task-1", "thinking", "2026-08-21T10:00:00.000Z", "fetch failed");

  expect(r.listOutbox()[0]).toEqual({
    taskId: "task-1",
    status: "done",
    updatedAt: "2026-08-21T10:00:05.000Z",
    attempts: 0,
    lastError: undefined,
  });
});

// ── report_outbox ────────────────────────────────────────────────────────────────────────
// One pending card-report write per card (docs/specs/2026-10-12-docs-tab-survives-restart.md).

function reportWrite(over: Partial<TaskReportsWrite> = {}): TaskReportsWrite {
  return {
    sessionId: "s1",
    generatedAt: "2026-10-12T10:00:00.000Z",
    session: { runtime: "omp", native: false, branch: "feature/a", worktree: true },
    ...over,
  };
}

test("a later write without a transcript keeps the queued write's reads and skills", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskReport("task-1", reportWrite({ read: ["docs/a.md"], skills: ["librarian"], changed: [{ path: "docs/a.md", added: 1, removed: 0 }] }));

  // «Завершити» on a session dormant after a restart: no transcript, a fresh listing.
  r.enqueueTaskReport("task-1", reportWrite({ generatedAt: "2026-10-12T10:05:00.000Z", changed: [] }));

  const rows = r.listReportOutbox();
  expect(rows).toHaveLength(1);
  expect(rows[0].write).toMatchObject({ sessionId: "s1", generatedAt: "2026-10-12T10:05:00.000Z", read: ["docs/a.md"], skills: ["librarian"], changed: [] });
  expect(rows[0].attempts).toBe(0);
});

test("a newer write of another session replaces the queued one", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskReport("task-1", reportWrite({ read: ["docs/a.md"], skills: ["librarian"] }));

  const relaunch = reportWrite({ sessionId: "s2", generatedAt: "2026-10-12T11:00:00.000Z", read: ["docs/b.md"] });
  r.enqueueTaskReport("task-1", relaunch);

  expect(r.listReportOutbox().map((x) => x.write)).toEqual([relaunch]);
});

test("dropReportOutbox retires only the version it was given", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskReport("task-1", reportWrite({ read: ["docs/a.md"] }));
  const [delivering] = r.listReportOutbox();

  // A turn ends while the first write is being pushed: it coalesces onto the same row.
  r.enqueueTaskReport("task-1", reportWrite({ generatedAt: "2026-10-12T10:01:00.000Z", read: ["docs/b.md"] }));
  r.dropReportOutbox("task-1", delivering.queuedAt);

  const rows = r.listReportOutbox();
  expect(rows).toHaveLength(1);
  expect(rows[0].write.read).toEqual(["docs/a.md", "docs/b.md"]);
});

test("bumpReportOutboxAttempt charges the version and a fresh enqueue resets it", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskReport("task-1", reportWrite());
  const [row] = r.listReportOutbox();

  r.bumpReportOutboxAttempt("task-1", row.queuedAt, "fetch failed");
  expect(r.listReportOutbox()[0]).toMatchObject({ attempts: 1, lastError: "fetch failed" });

  r.enqueueTaskReport("task-1", reportWrite({ generatedAt: "2026-10-12T10:01:00.000Z" }));
  expect(r.listReportOutbox()[0]).toMatchObject({ attempts: 0, lastError: undefined });
});
