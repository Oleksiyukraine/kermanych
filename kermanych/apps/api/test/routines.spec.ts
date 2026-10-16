// apps/api/test/routines.spec.ts
// The routine runner (docs/specs/2026-10-16-routines.md): when a run is due, that it is claimed
// exactly once, and what each kind of run does with its result. The cloud rows are mocked; the
// generator, the Slack poster and the launcher are stubs recording what they were asked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRoutine, WorkspaceRoutineRunClaim, WorkspaceRoutineRunResult } from "@kermanych/cloud";

const cloud = vi.hoisted(() => ({
  routines: [] as unknown[],
  claims: [] as unknown[],
  claimAnswer: "run" as "run" | "taken",
  finished: [] as { id: string; result: unknown }[],
  notes: [] as unknown[],
  tasks: [] as unknown[],
  deletedTasks: [] as string[],
  patches: [] as unknown[],
  projects: [] as unknown[],
}));
vi.mock("@kermanych/cloud", () => ({
  listRunnableRoutines: async () => cloud.routines,
  getWorkspaceRoutine: async (_c: unknown, id: string) => (cloud.routines as { id: string }[]).find((r) => r.id === id),
  claimRoutineRun: async (_c: unknown, claim: { routineId: string; trigger: string; scheduledFor?: string; status?: string }) => {
    cloud.claims.push(claim);
    if (cloud.claimAnswer === "taken") return undefined;
    return { id: `run${cloud.claims.length}`, workspaceId: "w1", startedAt: "", status: claim.status ?? "running", ...claim };
  },
  finishRoutineRun: async (_c: unknown, id: string, result: unknown) => {
    cloud.finished.push({ id, result });
    return {};
  },
  patchWorkspaceRoutine: async (_c: unknown, id: string, patch: unknown) => {
    cloud.patches.push({ id, patch });
    return {};
  },
  createWorkspaceReleaseNote: async (_c: unknown, input: unknown) => {
    cloud.notes.push(input);
    return { id: "note1" };
  },
  createTask: async (_c: unknown, input: unknown) => {
    cloud.tasks.push(input);
    return { id: "task1" };
  },
  deleteTask: async (_c: unknown, id: string) => {
    cloud.deletedTasks.push(id);
  },
  listWorkspaces: async () => [{ id: "w1", name: "Acme" }],
  listProjects: async () => cloud.projects,
}));

const oneShot = vi.hoisted(() => ({ calls: [] as { cwd: string; tools?: string[]; prompt: string }[] }));
vi.mock("../src/runtime/one-shot", () => ({
  runOneShot: async (opts: { cwd: string; tools?: string[]; prompt: string }) => {
    oneShot.calls.push(opts);
    return { text: "# Weekly report\n\nAll good.", spend: {} };
  },
}));

import { RegistryService } from "../src/registry/registry.service";
import type { AuthService } from "../src/auth/auth.service";
import type { ReleaseNotesService } from "../src/management/release-notes.service";
import type { SlackReleaseNotesService } from "../src/slack/slack-release-notes.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";
import { CodedError } from "../src/management/coded-error";
import { RoutinesService } from "../src/routines/routines.service";

const KYIV = "Europe/Kyiv";

function routine(over: Partial<WorkspaceRoutine> = {}): WorkspaceRoutine {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "Weekly notes",
    action: { kind: "release_notes", sources: [{ projectId: "p1", branch: "main" }], periodDays: 7, groupBy: "topic" },
    // Mondays 10:00 Kyiv = 07:00Z in October.
    schedule: { kind: "weekly", days: [1], time: "10:00" },
    timezone: KYIV,
    enabled: true,
    armedAt: "2026-10-01T00:00:00Z",
    createdAt: "2026-10-01T00:00:00Z",
    createdBy: "u1",
    updatedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const MONDAY_10 = Date.parse("2026-10-19T07:00:00Z");

let generate: ReturnType<typeof vi.fn>;
let postToChannel: ReturnType<typeof vi.fn>;
let launch: ReturnType<typeof vi.fn>;
let svc: RoutinesService;
let events: { status: string; routineId: string }[];

const lastResult = () => cloud.finished.at(-1)?.result as WorkspaceRoutineRunResult;
const settledRuns = (n: number) => vi.waitFor(() => expect(cloud.finished).toHaveLength(n));

beforeEach(() => {
  Object.assign(cloud, { routines: [], claims: [], claimAnswer: "run", finished: [], notes: [], tasks: [], deletedTasks: [], patches: [], projects: [] });
  oneShot.calls = [];
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "Альфа", localRepoPath: "/repos/alpha" });
  generate = vi.fn(async () => ({
    reply: { title: "Release 42", markdown: "# Release 42\n\n- export", commitCount: 9, ms: 1 },
    sources: [{ projectId: "p1", projectName: "Альфа", branch: "main" }],
  }));
  postToChannel = vi.fn(async () => ({ channelName: "weekly", ts: "1.1" }));
  launch = vi.fn(async () => ({ id: "s1" }));
  svc = new RoutinesService(
    { current: () => ({ userId: "u1", accessToken: "t" }), cloudClient: () => ({}), onToken: () => undefined } as unknown as AuthService,
    registry,
    { generateScheduled: generate } as unknown as ReleaseNotesService,
    { postToChannel } as unknown as SlackReleaseNotesService,
    { createSessionFromTask: launch } as unknown as SupervisorService,
  );
  events = [];
  svc.events$.subscribe((e) => {
    if (e.type === "routine_run") events.push({ status: e.status, routineId: e.routineId });
  });
});

describe("RoutinesService — when a run is due", () => {
  it("claims the occurrence it is due for, once, and not again on the next minute", async () => {
    cloud.routines = [routine()];
    await svc.tick(MONDAY_10 + 30_000);
    await svc.tick(MONDAY_10 + 90_000);
    expect(cloud.claims).toEqual([{ routineId: "r1", trigger: "schedule", scheduledFor: "2026-10-19T07:00:00.000Z" }]);
    await settledRuns(1);
  });

  it("labels a late start a catch-up, and runs nothing when the occurrence is claimed elsewhere", async () => {
    cloud.routines = [routine()];
    cloud.claimAnswer = "taken";
    await svc.tick(MONDAY_10 + 3 * 60 * 60 * 1000);
    expect((cloud.claims[0] as WorkspaceRoutineRunClaim).trigger).toBe("catch_up");
    expect(generate).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("does nothing while nobody is signed in", async () => {
    cloud.routines = [routine()];
    (svc as unknown as { auth: { current: () => undefined } }).auth.current = () => undefined;
    await svc.tick(MONDAY_10 + 30_000);
    expect(cloud.claims).toEqual([]);
  });

  it("records an occurrence that comes due while the previous run still works as skipped", async () => {
    const gate = Promise.withResolvers<void>();
    generate.mockImplementationOnce(async () => {
      await gate.promise;
      return { reply: { title: "t", markdown: "m", commitCount: 1, ms: 1 }, sources: [] };
    });
    cloud.routines = [routine({ schedule: { kind: "hourly", minute: 0 } })];
    await svc.tick(MONDAY_10 + 30_000);
    await svc.tick(MONDAY_10 + 60 * 60 * 1000 + 30_000);
    expect(cloud.claims[1]).toMatchObject({ status: "skipped", errorCode: "routine_previous_running" });
    gate.resolve();
    await settledRuns(1);
  });

  it("switches a one-off schedule off once it has fired", async () => {
    cloud.routines = [routine({ schedule: { kind: "once", date: "2026-10-19", time: "10:00" } })];
    await svc.tick(MONDAY_10 + 30_000);
    expect(cloud.patches).toEqual([{ id: "r1", patch: { enabled: false } }]);
    await settledRuns(1);
  });
});

describe("RoutinesService — release notes", () => {
  it("writes the note for the week ending on the run's day, stores it and posts it to the routine's channel", async () => {
    cloud.routines = [routine({ slack: { teamId: "T1", channelId: "C42", channelName: "weekly" } })];
    await svc.tick(MONDAY_10 + 30_000);
    await settledRuns(1);
    expect(generate).toHaveBeenCalledWith({
      sources: [{ projectId: "p1", branch: "main" }],
      workspaceName: "Acme",
      rangeFrom: "2026-10-13",
      rangeTo: "2026-10-19",
      groupBy: "topic",
    });
    expect(cloud.notes).toEqual([
      {
        workspaceId: "w1",
        sources: [{ projectId: "p1", projectName: "Альфа", branch: "main" }],
        rangeFrom: "2026-10-13",
        rangeTo: "2026-10-19",
        title: "Release 42",
        bodyMd: "# Release 42\n\n- export",
      },
    ]);
    expect(postToChannel).toHaveBeenCalledWith("w1", "u1", { teamId: "T1", channelId: "C42", channelName: "weekly" }, "# Release 42\n\n- export");
    expect(lastResult()).toEqual({ status: "succeeded", noteId: "note1", commitCount: 9, slackChannelName: "weekly" });
    expect(events.map((e) => e.status)).toEqual(["running", "succeeded"]);
  });

  it("skips a quiet period instead of failing it", async () => {
    generate.mockRejectedValueOnce(new CodedError("no_commits_in_range", "немає комітів", { project: "Альфа", branch: "main", from: "a", to: "b" }));
    cloud.routines = [routine()];
    await svc.tick(MONDAY_10 + 30_000);
    await settledRuns(1);
    expect(lastResult()).toMatchObject({ status: "skipped", errorCode: "no_commits_in_range", errorParams: { project: "Альфа" } });
    expect(cloud.notes).toEqual([]);
  });

  it("keeps the stored note when Slack refuses the post", async () => {
    postToChannel.mockRejectedValueOnce(new Error("you are not a member of #weekly — join it in Slack first"));
    cloud.routines = [routine({ slack: { teamId: "T1", channelId: "C42", channelName: "weekly" } })];
    await svc.tick(MONDAY_10 + 30_000);
    await settledRuns(1);
    expect(lastResult()).toMatchObject({
      status: "failed",
      noteId: "note1",
      errorCode: "routine_slack_failed",
      errorParams: { channel: "weekly", reason: "you are not a member of #weekly — join it in Slack first" },
    });
  });
});

describe("RoutinesService — prompts", () => {
  it("a project prompt files a card for the author and launches it", async () => {
    cloud.routines = [routine({ projectId: "p1", action: { kind: "prompt", prompt: "Bump the dependencies", hideFromBoard: true } })];
    await svc.tick(MONDAY_10 + 30_000);
    await settledRuns(1);
    expect(cloud.tasks).toEqual([
      { projectId: "p1", title: "Weekly notes · 2026-10-19", description: "Bump the dependencies", assigneeId: "u1", createdBy: "u1", hidden: true },
    ]);
    expect(launch).toHaveBeenCalledWith("task1", "u1");
    expect(lastResult()).toEqual({ status: "succeeded", taskId: "task1" });
  });

  it("a failed launch takes its card with it and fails the run", async () => {
    launch.mockRejectedValueOnce(new Error("project not bound"));
    cloud.routines = [routine({ projectId: "p1", action: { kind: "prompt", prompt: "Bump" } })];
    await svc.tick(MONDAY_10 + 30_000);
    await settledRuns(1);
    expect(cloud.deletedTasks).toEqual(["task1"]);
    expect(lastResult()).toEqual({ status: "failed", errorMessage: "project not bound" });
  });

  it("a workspace prompt is a read-only report over the workspace's repositories", async () => {
    cloud.projects = [
      { id: "p1", workspaceId: "w1", name: "Альфа" },
      { id: "p9", workspaceId: "w9", name: "Чужий" },
    ];
    cloud.routines = [routine({ action: { kind: "prompt", prompt: "Summarise open TODOs" } })];
    await svc.tick(MONDAY_10 + 30_000);
    await settledRuns(1);
    expect(oneShot.calls).toHaveLength(1);
    expect(oneShot.calls[0]!.cwd).toBe("/repos/alpha");
    expect(oneShot.calls[0]!.tools).toEqual(["read", "grep", "glob"]);
    expect(oneShot.calls[0]!.prompt).toContain("Summarise open TODOs");
    expect(oneShot.calls[0]!.prompt).toContain("/repos/alpha");
    expect(lastResult()).toEqual({ status: "succeeded", outputMd: "# Weekly report\n\nAll good." });
  });
});

describe("RoutinesService — Run now", () => {
  it("runs for its author without a scheduled time", async () => {
    cloud.routines = [routine({ schedule: { kind: "manual" } })];
    const run = await svc.runNow("r1", "u1");
    expect(run.status).toBe("running");
    expect(cloud.claims).toEqual([{ routineId: "r1", trigger: "manual" }]);
    await settledRuns(1);
  });

  it("refuses anyone but the author", async () => {
    cloud.routines = [routine()];
    await expect(svc.runNow("r1", "u2")).rejects.toThrow("only the author");
    expect(cloud.claims).toEqual([]);
  });
});
