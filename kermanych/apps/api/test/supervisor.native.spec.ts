// apps/api/test/supervisor.native.spec.ts
// The supervisor's routing of a native session (docs/specs/2026-10-05-native-sessions.md): a
// from-task launch starts the harness in the new worktree with the card's text alone, nothing
// managed is spawned, managed-only actions answer `native_unsupported`, and the live overlay
// comes from NativeSessionService.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { join } from "node:path";
import { Subject } from "rxjs";
import type { HttpAdapterHost } from "@nestjs/core";
import type { CloudProject, Task } from "@kermanych/cloud";
import { deepAnalysisPrompt, type ApiErrorBody, type ServerEvent, type TerminalInfo } from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { ModelsService } from "../src/models/models.service";
import type { TerminalEvent, TerminalService } from "../src/terminal/terminal.service";

const runtimes: unknown[] = [];
vi.mock("../src/runtime/agent-runtime", () => ({
  createRuntime: (...args: unknown[]) => {
    runtimes.push(args);
    throw new Error("a native session must never spawn a managed runtime");
  },
}));

const cloudTasks = new Map<string, Task>();
const cloudProjects: CloudProject[] = [];
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_c: unknown, id: string) => cloudTasks.get(id),
  claimTaskForLaunch: async (_c: unknown, id: string, userId: string, from: Task["status"]) => {
    const t = cloudTasks.get(id);
    if (!t || t.status !== from || (t.assigneeId && t.assigneeId !== userId)) return undefined;
    const next = { ...t, status: "queued" as const, assigneeId: userId };
    cloudTasks.set(id, next);
    return next;
  },
  releaseLaunchClaim: async (_c: unknown, id: string, previous: { status: Task["status"]; assigneeId?: string }) => {
    const t = cloudTasks.get(id);
    if (t) cloudTasks.set(id, { ...t, status: previous.status, ...(previous.assigneeId ? {} : { assigneeId: undefined }) });
  },
  listProjects: async () => cloudProjects,
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { NativeSessionService } from "../src/native/native-session.service";
import { sessionFailure } from "../src/http/session-failure";
import { stubSkills } from "./skills-stub";

const USER = "11111111-1111-1111-1111-111111111111";
const PROJECT = "33333333-3333-3333-3333-333333333333";

function make() {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: PROJECT, name: "p", localRepoPath: "/tmp/proj", carryFiles: [] });
  const worktree = {
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue("main"),
    forkStart: vi.fn(async (_repo: string, base: string) => ({ ref: base, stale: false })),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    unmergedFiles: vi.fn().mockResolvedValue([] as string[]),
    // A task-born native turn also queues its card report, which lists the changed files.
    changedFiles: vi.fn().mockResolvedValue([]),
  };
  const auth = { current: () => ({ userId: USER, accessToken: "t" }), cloudClient: () => ({}) } as unknown as AuthService;
  const models = { validModel: async (_r: string, m: string | undefined) => m } as unknown as ModelsService;
  const events$ = new Subject<TerminalEvent>();
  const terminal = {
    events$,
    openSession: vi.fn(
      (o: { sessionId: string; projectId: string; cwd: string; file: string }): TerminalInfo => ({ id: "t1", projectId: o.projectId, cwd: o.cwd, shell: o.file, pid: 1, createdAt: "", sessionId: o.sessionId }),
    ),
    write: vi.fn(),
    kill: vi.fn((id: string) => queueMicrotask(() => events$.next({ type: "exit", id, exitCode: 0 }))),
  };
  const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;
  const native = new NativeSessionService(registry, terminal as unknown as TerminalService, http);
  // The deep-analysis launch resolves its skill by name; none resolves here (empty block).
  const skills = Object.assign(stubSkills(), { assignedForNames: async () => ({ block: "", view: [], missing: [] }) });
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth, skills, models, native);
  const out: ServerEvent[] = [];
  sup.events$.subscribe((e) => out.push(e));
  return { sup, registry, terminal, worktree, out, native };
}

function card(over: Partial<Task> = {}): Task {
  const t = {
    id: "task-1",
    projectId: PROJECT,
    title: "Add login",
    description: "wire GitHub OAuth",
    status: "backlog",
    createdBy: USER,
    createdAt: "",
    updatedAt: "",
    worktree: true,
    design: false,
    model: "claude-opus-4-8",
    effort: "high",
    ...over,
  } as Task;
  cloudTasks.set(t.id, t);
  return t;
}

beforeEach(() => {
  cloudTasks.clear();
  runtimes.length = 0;
});

describe("a native launch", () => {
  it("starts the harness in the new worktree with the card's text and nothing else", async () => {
    const { sup, terminal, worktree, out } = make();
    card();
    const s = await sup.createSessionFromTask("task-1", USER, undefined, "claude-code");

    expect(runtimes).toEqual([]);
    expect(s).toMatchObject({ native: true, runtime: "claude-code", status: "queued", terminalId: "t1" });
    expect(s.model).toBeUndefined();
    expect(s.effort).toBeUndefined();
    const wt = join(process.env.HOME ?? "", ".kermanych", "worktrees", s.id);
    // No base on the card or the project: the branch the project checkout is on (decision 4).
    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", wt, s.branch, "main");
    expect(terminal.openSession).toHaveBeenCalledTimes(1);
    const opts = terminal.openSession.mock.calls[0][0] as { cwd: string; file: string; args: string[] };
    expect(opts.cwd).toBe(wt);
    expect(opts.file).toBe("claude");
    expect(opts.args).toEqual(["--session-id", s.ompSessionId, "--settings", join(tmpdir(), "kermanych-native", "claude-settings.json"), "--", "wire GitHub OAuth"]);
    expect(out.some((e) => e.type === "session_update" && e.session.id === s.id && e.session.terminalId === "t1")).toBe(true);
  });

  it("omp: `omp launch --hook … -- <task>`", async () => {
    const { sup, terminal } = make();
    card();
    await sup.createSessionFromTask("task-1", USER, undefined, "omp");
    const opts = terminal.openSession.mock.calls[0][0] as { file: string; args: string[] };
    expect(opts.file).toBe("omp");
    expect(opts.args).toEqual(["launch", "--hook", join(tmpdir(), "kermanych-native", "omp-native.js"), "--", "wire GitHub OAuth"]);
  });

  // The one thing of Kermanych's a native harness receives: a deep-analysis card's wrapped
  // prompt, because it is part of the task the operator chose (the stub skill block is empty).
  it("a deep-analysis card opens the harness with the wrapped prompt", async () => {
    const { sup, terminal } = make();
    card({ deepAnalysis: true });
    const s = await sup.createSessionFromTask("task-1", USER, undefined, "omp");
    expect(s.deepAnalysis).toBe(true);
    const opts = terminal.openSession.mock.calls[0][0] as { args: string[] };
    expect(opts.args.at(-2)).toBe("--");
    expect(opts.args.at(-1)).toBe(deepAnalysisPrompt("wire GitHub OAuth"));
  });

  // A design card opened natively: the harness starts on the design branch with the Дизайнер's
  // instruction naming the stamped folder (docs/specs/2026-10-29-design-tab.md).
  it("a design card opens the harness with the Дизайнер instruction", async () => {
    const { sup, terminal } = make();
    card({ design: true });
    const s = await sup.createSessionFromTask("task-1", USER, undefined, "omp");
    expect(s.branch).toBe("design/add-login");
    expect(s.designDir).toMatch(/^docs\/design\/\d{4}-\d{2}-\d{2}-add-login$/);
    const opts = terminal.openSession.mock.calls[0][0] as { args: string[] };
    expect(opts.args.at(-1)).toMatch(/^You are «Дизайнер»/);
    expect(opts.args.at(-1)).toContain(`${s.designDir}/README.md`);
  });

  // docs/specs/2026-10-14-create-pr-base-sync.md, decision 6: the harness stopped with the tree
  // mid-merge, so the card reads «конфлікт» — and the harness, idle at its prompt, still takes
  // «Вирішити автоматично». A later turn that leaves no unmerged files settles as usual.
  it("rests at conflict after a turn that ends mid-merge, and takes the resolve helper there", async () => {
    const { sup, terminal, worktree, native } = make();
    card();
    const s = await sup.createSessionFromTask("task-1", USER, undefined, "omp");
    const status = () => sup.snapshot().sessions.find((x) => x.id === s.id)!.status;

    worktree.unmergedFiles.mockResolvedValue(["src/a.ts"]);
    native.ompEvent(s.id, { event: "working" });
    native.ompEvent(s.id, { event: "idle" });
    await vi.waitFor(() => expect(status()).toBe("conflict"));

    await sup.resolveConflict(s.id);
    expect(terminal.write).toHaveBeenCalledWith("t1", expect.stringContaining("src/a.ts"));

    worktree.unmergedFiles.mockResolvedValue([]);
    native.ompEvent(s.id, { event: "working" });
    native.ompEvent(s.id, { event: "idle" });
    await vi.waitFor(() => expect(worktree.unmergedFiles).toHaveBeenCalledTimes(3));
    await nextMacrotask();
    expect(status()).toBe("done");
  });

  it("refuses images before touching the card", async () => {
    const { sup, registry } = make();
    card();
    const err = await sup.createSessionFromTask("task-1", USER, [{ data: "x", mimeType: "image/png" }], "omp").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "native_unsupported" });
    expect(registry.listSessions()).toEqual([]);
    expect(cloudTasks.get("task-1")?.assigneeId).toBeUndefined();
  });

  it("a harness that cannot start leaves no row and no worktree", async () => {
    const { sup, registry, terminal, worktree } = make();
    card();
    terminal.openSession.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    await expect(sup.createSessionFromTask("task-1", USER, undefined, "omp")).rejects.toThrow("spawn failed");
    expect(registry.listSessions()).toEqual([]);
    expect(worktree.removeWorktree).toHaveBeenCalled();
    expect(worktree.removeBranch).toHaveBeenCalled();
  });
});

describe("a native session refuses managed-only actions", () => {
  it("answers native_unsupported, coded through sessionFailure", async () => {
    const { sup, registry } = make();
    const s = registry.createSession({ projectId: PROJECT, name: "n", task: "t", worktreePath: "/tmp/wt", branch: "b", runtime: "omp", native: true, status: "done" });
    const attempts: (() => unknown)[] = [
      () => sup.setEffort(s.id, "high"),
      () => sup.setSessionModel(s.id, { model: "m", provider: "p" }),
      () => sup.branchSession(s.id),
      () => sup.reviewSession(s.id),
      () => sup.answerUi(s.id, { type: "extension_ui_response", id: "x", cancelled: true } as never),
      () => sup.sendMessage(s.id, "/compact", "prompt"),
      () => sup.sendMessage(s.id, "look", "prompt", [{ data: "x", mimeType: "image/png" }]),
    ];
    for (const attempt of attempts) {
      const err = await Promise.resolve().then(attempt).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "native_unsupported" });
      expect(sessionFailure(err).getResponse() as ApiErrorBody).toMatchObject({ code: "native_unsupported" });
    }
    expect(runtimes).toEqual([]);
  });

  it("a helper into a busy harness answers native_busy", async () => {
    const { sup, registry } = make();
    const s = registry.createSession({ projectId: PROJECT, name: "n", task: "t", worktreePath: "/tmp/wt", branch: "b", runtime: "omp", native: true, status: "stopped" });
    await sup.resume(s.id);
    // Started without a prompt: idle, so the first message is pasted…
    await sup.sendMessage(s.id, "first", "prompt");
    // …and the harness is busy with it until it settles.
    const err = await sup.sendMessage(s.id, "second", "prompt").catch((e: unknown) => e);
    expect(sessionFailure(err).getResponse()).toMatchObject({ code: "native_busy" });
  });
});

describe("native lifecycle through the supervisor", () => {
  it("stop kills the harness and settles the row on stopped; resume relaunches it", async () => {
    const { sup, registry, terminal } = make();
    const s = registry.createSession({ projectId: PROJECT, name: "n", task: "t", worktreePath: "/tmp/wt", branch: "b", runtime: "claude-code", native: true, ompSessionId: "11111111-2222-3333-4444-555555555555", status: "stopped" });
    await sup.resume(s.id);
    expect((terminal.openSession.mock.calls[0][0] as { args: string[] }).args.slice(0, 2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
    expect(sup.snapshot().sessions[0]).toMatchObject({ status: "done", terminalId: "t1" });
    await sup.stopSession(s.id);
    expect(terminal.kill).toHaveBeenCalledWith("t1");
    expect(sup.snapshot().sessions[0].status).toBe("stopped");
    expect(sup.snapshot().sessions[0].terminalId).toBeUndefined();
  });
});

describe("a native chat (docs/specs/2026-10-06-native-chats.md)", () => {
  it("opens the harness idle in the project folder, read-only, with no managed runtime", async () => {
    const { sup, terminal } = make();
    const s = await sup.createChat(PROJECT, "claude-code");

    expect(runtimes).toEqual([]);
    expect(s).toMatchObject({ kind: "chat", native: true, runtime: "claude-code", status: "done", terminalId: "t1", task: "" });
    const opts = terminal.openSession.mock.calls[0][0] as { cwd: string; file: string; args: string[] };
    expect(opts.cwd).toBe("/tmp/proj");
    expect(opts.args).toEqual(["--session-id", s.ompSessionId, "--tools", "Read,Grep,Glob", "--settings", join(tmpdir(), "kermanych-native", "claude-settings.json")]);

    await sup.createChat(PROJECT, "omp");
    const omp = terminal.openSession.mock.calls[1][0] as { args: string[] };
    expect(omp.args).toEqual(["launch", "--tools", "read,grep,glob", "--hook", join(tmpdir(), "kermanych-native", "omp-native.js")]);
  });

  it("a harness that cannot start leaves no row", async () => {
    const { sup, registry, terminal } = make();
    terminal.openSession.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    await expect(sup.createChat(PROJECT, "omp")).rejects.toThrow("spawn failed");
    expect(registry.listSessions()).toEqual([]);
  });

  it("cannot be promoted: there is no fork of a native conversation", async () => {
    const { sup, registry } = make();
    const s = await sup.createChat(PROJECT, "omp");
    const err = await sup.promoteChatToAgent(s.id, "task-1").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "native_unsupported" });
    expect(registry.listSessions()[0]).toMatchObject({ kind: "chat", taskId: undefined });
  });

  it("archiving stops its harness; a native agent's archive leaves its harness running", async () => {
    const { sup, registry, terminal } = make();
    const chat = await sup.createChat(PROJECT, "omp");
    await sup.setArchived(chat.id, true);
    expect(terminal.kill).toHaveBeenCalledWith("t1");
    expect(sup.snapshot().sessions.find((x) => x.id === chat.id)).toMatchObject({ archived: true, status: "stopped" });

    terminal.kill.mockClear();
    const agent = registry.createSession({ projectId: PROJECT, name: "n", task: "t", worktreePath: "/tmp/wt", branch: "b", runtime: "omp", native: true, status: "stopped" });
    await sup.resume(agent.id);
    await sup.setArchived(agent.id, true);
    expect(terminal.kill).not.toHaveBeenCalled();
  });
});
