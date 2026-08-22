// apps/api/test/registry.outbox.spec.ts
import { expect, test } from "vitest";
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

  r.bumpOutboxAttempt("task-1", "fetch failed");
  expect(r.listOutbox()[0].attempts).toBe(1);
  expect(r.listOutbox()[0].lastError).toBe("fetch failed");

  r.bumpOutboxAttempt("task-1", "not signed in");
  expect(r.listOutbox()[0].attempts).toBe(2);
  expect(r.listOutbox()[0].lastError).toBe("not signed in");
});

test("a fresh enqueue resets the retry counter of a failing row", () => {
  const r = new RegistryService(":memory:");
  r.enqueueTaskStatus("task-1", "thinking", "2026-08-21T10:00:00.000Z");
  r.bumpOutboxAttempt("task-1", "fetch failed");

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
