// apps/api/test/registry.schedules.spec.ts
// The scheduled tasks' local tables (docs/specs/2026-11-06-scheduled-tasks.md): the claim that
// makes an occurrence fire exactly once, manual runs beside it, retention of runs and slips, and
// a scheduled run's session carrying its task.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { SCHEDULE_RUNS_KEEP, SCHEDULE_SLIPS_KEEP, type ScheduleRun, type ScheduleSlip } from "@kermanych/core";
import { RegistryService, type ScheduleRow } from "../src/registry/registry.service";

const task: ScheduleRow = {
  id: "t1",
  name: "Звіт",
  kind: "agent",
  prompt: "Згенеруй звіт",
  projectId: "p1",
  skills: ["weekly-report"],
  schedule: { type: "weekly", days: [1, 4], time: "10:00" },
  timeZone: "Europe/Kyiv",
  enabled: true,
  armedAt: "2026-11-06T08:00:00.000Z",
  createdAt: "2026-11-06T08:00:00.000Z",
  updatedAt: "2026-11-06T08:00:00.000Z",
};

const run = (over: Partial<ScheduleRun> & { id: string }): ScheduleRun => ({
  scheduleId: "t1",
  trigger: "schedule",
  status: "done",
  startedAt: "2026-11-06T08:00:00.000Z",
  ...over,
});

test("a task round-trips, and a row with a spec this build cannot read is left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "kmq-registry-schedules-"));
  try {
    const file = join(dir, "k.sqlite");
    const r = new RegistryService(file);
    r.putSchedule(task);
    r.putSchedule({ ...task, id: "t2", kind: "reminder", projectId: undefined, skills: [], schedule: { type: "daily", time: "19:00" } });
    expect(r.getSchedule("t1")).toEqual(task);
    expect(r.listSchedules().map((t) => t.id)).toEqual(["t1", "t2"]);
    // Another version wrote a schedule type this build does not know.
    const other = new Database(file);
    other.prepare(`UPDATE schedules SET spec = ? WHERE id = ?`).run(JSON.stringify({ type: "cron", expr: "* * * * *" }), "t2");
    other.close();
    expect(r.listSchedules().map((t) => t.id)).toEqual(["t1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an occurrence is claimed once; manual runs never collide", () => {
  const r = new RegistryService(":memory:");
  r.putSchedule(task);
  expect(r.claimScheduleRun(run({ id: "a", scheduledFor: "2026-11-09T08:00:00.000Z" }))).toBe(true);
  expect(r.claimScheduleRun(run({ id: "b", scheduledFor: "2026-11-09T08:00:00.000Z" }))).toBe(false);
  expect(r.claimScheduleRun(run({ id: "m1", trigger: "manual" }))).toBe(true);
  expect(r.claimScheduleRun(run({ id: "m2", trigger: "manual" }))).toBe(true);
  expect(r.lastScheduledFor("t1")).toBe("2026-11-09T08:00:00.000Z");
  expect(r.listScheduleRuns("t1").map((x) => x.id).sort()).toEqual(["a", "m1", "m2"]);
});

test("runs keep the newest SCHEDULE_RUNS_KEEP per task, never one in flight", () => {
  const r = new RegistryService(":memory:");
  r.putSchedule(task);
  r.claimScheduleRun(run({ id: "live", status: "running", startedAt: "2026-01-01T00:00:00.000Z" }));
  for (let i = 0; i < SCHEDULE_RUNS_KEEP + 5; i++)
    r.claimScheduleRun(run({ id: `r${i}`, scheduledFor: new Date(Date.UTC(2026, 10, 1, i)).toISOString(), startedAt: new Date(Date.UTC(2026, 10, 1, i)).toISOString() }));
  const runs = r.listScheduleRuns("t1");
  expect(runs.some((x) => x.id === "live")).toBe(true);
  expect(runs.some((x) => x.id === "r0")).toBe(false);
  expect(runs[0]!.id).toBe(`r${SCHEDULE_RUNS_KEEP + 4}`);
  expect(r.listRunningScheduleRuns().map((x) => x.id)).toEqual(["live"]);
});

test("retention keeps the latest claimed occurrence, however many manual runs came after it", () => {
  const r = new RegistryService(":memory:");
  r.putSchedule(task);
  r.claimScheduleRun(run({ id: "claim", scheduledFor: "2026-11-09T08:00:00.000Z", startedAt: "2026-11-09T08:00:00.000Z" }));
  for (let i = 0; i < SCHEDULE_RUNS_KEEP + 5; i++)
    r.claimScheduleRun(run({ id: `m${i}`, trigger: "manual", startedAt: new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString() }));
  expect(r.lastScheduledFor("t1")).toBe("2026-11-09T08:00:00.000Z");
  expect(r.claimScheduleRun(run({ id: "again", scheduledFor: "2026-11-09T08:00:00.000Z" }))).toBe(false);
});

test("disableSchedule writes the switch alone and never brings a deleted task back", () => {
  const r = new RegistryService(":memory:");
  r.putSchedule(task);
  r.putSchedule({ ...task, name: "Перейменовано" });
  r.disableSchedule("t1", "2026-11-09T08:00:00.000Z");
  expect(r.getSchedule("t1")).toMatchObject({ name: "Перейменовано", enabled: false, updatedAt: "2026-11-09T08:00:00.000Z" });
  r.deleteSchedule("t1");
  r.disableSchedule("t1", "2026-11-09T08:01:00.000Z");
  expect(r.getSchedule("t1")).toBeUndefined();
});

test("deleting a task takes its runs and leaves its slips", () => {
  const r = new RegistryService(":memory:");
  r.putSchedule(task);
  r.claimScheduleRun(run({ id: "a", scheduledFor: "2026-11-09T08:00:00.000Z" }));
  r.putScheduleSlip({ id: "s1", kind: "run", scheduleId: "t1", scheduleName: "Звіт", at: "2026-11-09T08:05:00.000Z", text: "ok", late: false, seen: false });
  r.deleteSchedule("t1");
  expect(r.getSchedule("t1")).toBeUndefined();
  expect(r.listScheduleRuns("t1")).toEqual([]);
  expect(r.listScheduleSlips().map((s) => s.id)).toEqual(["s1"]);
});

test("slips keep the newest SCHEDULE_SLIPS_KEEP, mark seen, snooze and fire again", () => {
  const r = new RegistryService(":memory:");
  const slip = (i: number): ScheduleSlip => ({
    id: `s${i}`,
    kind: "reminder",
    scheduleId: "t1",
    scheduleName: "Вітаміни",
    at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    text: "Випити вітаміни",
    late: false,
    seen: false,
  });
  for (let i = 0; i < SCHEDULE_SLIPS_KEEP + 3; i++) r.putScheduleSlip(slip(i));
  const all = r.listScheduleSlips();
  expect(all).toHaveLength(SCHEDULE_SLIPS_KEEP);
  expect(all[0]!.id).toBe(`s${SCHEDULE_SLIPS_KEEP + 2}`);

  const id = all[0]!.id;
  r.markScheduleSlipsSeen([id]);
  expect(r.getScheduleSlip(id)!.seen).toBe(true);
  expect(r.snoozeScheduleSlip(id, "2026-11-10T10:00:00.000Z")).toBe(true);
  expect(r.dueSnoozedScheduleSlips("2026-11-10T09:59:00.000Z")).toEqual([]);
  expect(r.dueSnoozedScheduleSlips("2026-11-10T10:00:00.000Z").map((s) => s.id)).toEqual([id]);
  expect(r.refireScheduleSlip(id, "2026-11-10T10:00:30.000Z")).toMatchObject({ id, seen: false, at: "2026-11-10T10:00:30.000Z" });
  expect(r.getScheduleSlip(id)!.snoozedUntil).toBeUndefined();
  r.markScheduleSlipsSeen();
  expect(r.listScheduleSlips().every((s) => s.seen)).toBe(true);
});

test("a scheduled run's session carries its task", () => {
  const r = new RegistryService(":memory:");
  r.upsertProject({ id: "p1", name: "p1", localRepoPath: "/tmp/p1" });
  const s = r.createSession({ projectId: "p1", name: "Розклад · Звіт", task: "Згенеруй звіт", worktreePath: "", branch: "chore/schedule-t1", schedule: { id: "t1", name: "Звіт" } });
  const plain = r.createSession({ projectId: "p1", name: "x", task: "x", worktreePath: "", branch: "feature/x" });
  const rows = r.listSessions();
  expect(rows.find((x) => x.id === s.id)!.schedule).toEqual({ id: "t1", name: "Звіт" });
  expect(rows.find((x) => x.id === plain.id)!.schedule).toBeUndefined();
});
