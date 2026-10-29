// apps/api/test/sessions.from-task.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { ModelsService } from "../src/models/models.service";
import type { CloudProject, Task } from "@kermanych/cloud";
import { DEFAULT_DOCS_POLICY, docsPolicyAppend, deepAnalysisPrompt, designDirFor } from "@kermanych/core";
import { todayIso } from "../src/management/management-prompt";

// The runtime-aware model guard (ModelsService.validModel) is not under test here; an identity
// stub returns the wanted model unchanged so createSessionFromTask keeps task.model as before.
function stubModels(): ModelsService {
  return { validModel: async (_r: string, w: string | undefined) => w } as unknown as ModelsService;
}

// Capture every spawned RpcSession so a test can prove whether a launch happened.
const started: unknown[] = [];
// launch() delivers the opening message as rpc.prompt(text, images); the attachments are
// only observable here.
const prompts: unknown[][] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: unknown) {
      started.push(opts);
    }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() {
      return { sessionId: "omp", sessionFile: "/tmp/s.jsonl" };
    }
    async getAllMessages() {
      return [];
    }
    async stop() {}
    prompt(...args: unknown[]) {
      prompts.push(args);
    }
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

// Fake cloud: an in-memory `tasks` map + the project list. Mocked wholesale (no
// importOriginal) so this unit test never needs packages/cloud built and can flip the
// claim race by hand. `claimTaskForLaunch` reproduces the DB's predicate (the status read
// before, assignee null or the caller) and sets `queued` + the assignee in one go: losing the
// race is zero rows, i.e. `undefined`, not an exception. `rival` is what the winner of a lost
// race did to the card. `releaseLaunchClaim` puts the status back, then frees the assignee only
// when the card had none.
const cloudTasks = new Map<string, Task>();
const cloudProjects: CloudProject[] = [];
let claimWins = true;
let rival: Partial<Task> | undefined;
const releases: { taskId: string; previous: { status: Task["status"]; assigneeId?: string } }[] = [];
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_client: unknown, taskId: string) => cloudTasks.get(taskId),
  claimTaskForLaunch: async (_client: unknown, taskId: string, userId: string, from: Task["status"]) => {
    const t = cloudTasks.get(taskId);
    if (t && rival) cloudTasks.set(taskId, { ...t, ...rival });
    if (!t || rival || !claimWins || t.status !== from || (t.assigneeId && t.assigneeId !== userId)) return undefined;
    const next: Task = { ...t, status: "queued", assigneeId: userId };
    cloudTasks.set(taskId, next);
    return next;
  },
  releaseLaunchClaim: async (_client: unknown, taskId: string, previous: { status: Task["status"]; assigneeId?: string }) => {
    releases.push({ taskId, previous });
    const t = cloudTasks.get(taskId);
    if (!t) throw new Error("task not found");
    cloudTasks.set(taskId, { ...t, status: previous.status, ...(previous.assigneeId ? {} : { assigneeId: undefined }) });
  },
  listProjects: async () => cloudProjects,
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { stubSkills } from "./skills-stub";
import type { BranchNameService } from "../src/supervisor/branch-name.service";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const NOW = "2026-08-21T10:00:00.000Z";

function make(branchNames?: BranchNameService) {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(),
    // The launch-failure rollback awaits `.catch()` on these, so they must be thenable.
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
    forkStart: vi.fn(async (_repo: string, base: string) => ({ ref: base, stale: false })),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  // The launch path only forwards this client to @kermanych/cloud, which is mocked above.
  const auth = {
    current: () => ({ userId: USER, accessToken: "token" }),
    cloudClient: () => ({}),
  } as unknown as AuthService;
  // The deep-analysis launch resolves its skill by name; none resolves here, so the wrapper
  // goes out with an empty block (stubSkills leaves the name resolver out on purpose).
  const skills = Object.assign(stubSkills(), { assignedForNames: async () => ({ block: "", view: [], missing: [] }) });
  const sup = new SupervisorService(
    registry,
    worktree as unknown as WorktreeService,
    auth,
    skills,
    stubModels(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    branchNames,
  );
  return { sup, registry, worktree };
}

function task(over: Partial<Task> = {}): Task {
  const t: Task = {
    id: "task-1",
    projectId: PROJECT,
    title: "Add login",
    description: "wire GitHub OAuth",
    status: "backlog",
    createdBy: OTHER,
    createdAt: NOW,
    updatedAt: NOW,
    worktree: true,
    autoRun: false,
    design: false,
    ...over,
  };
  cloudTasks.set(t.id, t);
  return t;
}

function bind(registry: RegistryService, localRepoPath = "/tmp/proj"): void {
  registry.upsertProject({
    id: PROJECT,
    name: "stale local name",
    localRepoPath,
    carryFiles: [".env"],
    createdAt: NOW,
  });
  cloudProjects.push({
    id: PROJECT,
    name: "kermanych",
    carryFiles: [".env", ".env.local"],
    envKeys: ["GITHUB_TOKEN"],
    docFolders: [],
    docsRequired: false,
    docsPolicy: DEFAULT_DOCS_POLICY,
    defaultBranch: "main",
    workspaceId: "00000000-0000-4000-8000-000000000ws1",
    createdAt: NOW,
  });
}

beforeEach(() => {
  started.length = 0;
  prompts.length = 0;
  cloudTasks.clear();
  cloudProjects.length = 0;
  claimWins = true;
  rival = undefined;
  releases.length = 0;
});

describe("createSessionFromTask", () => {
  it("refuses a task assigned to somebody else", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: OTHER });

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task assigned to someone else");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("refuses an unknown task", async () => {
    const { sup } = make();

    await expect(sup.createSessionFromTask("nope", USER)).rejects.toThrow("task not found");
    expect(started).toHaveLength(0);
  });

  it("claims an unassigned task — queued and self-assigned in one update — and launches it", async () => {
    const { sup, registry } = make();
    bind(registry);
    task();

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(cloudTasks.get("task-1")).toMatchObject({ assigneeId: USER, status: "queued" });
    expect(session.taskId).toBe("task-1");
    expect(session.projectId).toBe(PROJECT);
    expect(started).toHaveLength(1);
    expect(registry.listSessions()).toHaveLength(1);
  });

  // docs/specs/2026-10-23-minion-auto-run.md, decision 7: a card already assigned to the runner
  // takes the same claim, so a ▶ here and «Посіпака» on another machine cannot both start it.
  it("claims the runner's own card too: its status goes to queued", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, status: "stopped" });

    await sup.createSessionFromTask("task-1", USER);

    expect(cloudTasks.get("task-1")).toMatchObject({ assigneeId: USER, status: "queued" });
  });

  it("refuses when the atomic claim loses the race", async () => {
    const { sup, registry } = make();
    bind(registry);
    task();
    claimWins = false;

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task already claimed");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
    expect(releases).toHaveLength(0);
  });

  it("says the card is running when the race was lost to a start elsewhere", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER });
    // The minion on another machine of the same user claimed it between the read and the claim.
    rival = { status: "queued" };

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task is already running");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("refuses a task that is already running somewhere", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, status: "thinking" });

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task is already running");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("still launches a task left in a terminal status", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, status: "stopped" });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.taskId).toBe("task-1");
    expect(started).toHaveLength(1);
    expect(registry.listSessions()).toHaveLength(1);
  });

  it("refuses a stale-backlog task this machine is already running", async () => {
    const { sup, registry } = make();
    bind(registry);
    // The cloud still says `backlog` (a push has not landed yet) but the local registry
    // already holds a live session for the card — a second launch would duplicate it.
    task({ assigneeId: USER });
    registry.createSession({
      projectId: PROJECT,
      taskId: "task-1",
      name: "Add login",
      task: "wire GitHub OAuth",
      worktreePath: "/tmp/wt",
      branch: "feature/add-login",
      status: "thinking",
    });

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task is already running");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(1);
  });

  it("refuses when the project has no local binding", async () => {
    const { sup, registry } = make();
    task({ assigneeId: USER });

    // No local row at all.
    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("project not bound");

    // Row exists but the path is empty (created by a cloud sync, never bound on this machine).
    bind(registry, "");
    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("project not bound");
    expect(started).toHaveLength(0);
  });

  it("launches the assignee's task, carrying task fields onto the session", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({
      assigneeId: USER,
      model: "opus-5",
      prefix: "fix",
      platform: "web",
      branch: "release/2026-08",
    });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.name).toBe("Add login");
    expect(session.task).toBe("wire GitHub OAuth");
    expect(session.model).toBe("opus-5");
    expect(session.prefix).toBe("fix");
    expect(session.platform).toBe("web");
    expect(session.kind).toBe("agent");
    expect(session.branch).toBe("fix/add-login");
    expect(session.baseBranch).toBe("release/2026-08");
    expect(session.worktree).toBe(true);
    // Exactly one omp child, spawned in the session's worktree.
    expect(started).toHaveLength(1);
    expect(worktree.addWorktree).toHaveBeenCalledTimes(1);
    // Step 5 of the spec: the local config cache is refreshed from the cloud project.
    const local = registry.listProjects().find((p) => p.id === PROJECT)!;
    expect(local.name).toBe("kermanych");
    expect(local.carryFiles).toEqual([".env", ".env.local"]);
    expect(local.localRepoPath).toBe("/tmp/proj");
  });

  it("names the branch from the task through the namer, under the card's prefix", async () => {
    const suggest = vi.fn(async () => "add-github-oauth");
    const { sup, registry } = make({ suggest } as unknown as BranchNameService);
    bind(registry);
    task({ assigneeId: USER, title: "Додати вхід через GitHub", prefix: "fix" });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(suggest).toHaveBeenCalledWith({ title: "Додати вхід через GitHub", description: "wire GitHub OAuth" });
    expect(session.branch).toBe("fix/add-github-oauth");
  });

  it("falls back to the transliterated title when the namer has no answer", async () => {
    const { sup, registry } = make({ suggest: async () => undefined } as unknown as BranchNameService);
    bind(registry);
    task({ assigneeId: USER, title: "Додати вхід" });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.branch).toBe("feature/dodaty-vkhid");
  });

  it("falls back to the task title and safe launch defaults", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, description: undefined, prefix: "nonsense", platform: "watch" });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.task).toBe("Add login");
    expect(session.prefix).toBe("feature");
    expect(session.platform).toBeUndefined();
    // Cloud task carried no branch → the refreshed project default is used.
    expect(session.baseBranch).toBe("main");
  });

  it("rolls the session row back when the launch fails", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER });
    worktree.addWorktree.mockRejectedValueOnce(new Error("fatal: invalid reference"));

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("fatal: invalid reference");
    expect(registry.listSessions()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("releases a claim it made itself when the launch fails: backlog again, unassigned", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task();
    worktree.addWorktree.mockRejectedValueOnce(new Error("fatal: invalid reference"));

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("fatal: invalid reference");
    // Nobody could pick the card up again if the failed claim stuck to us.
    expect(cloudTasks.get("task-1")).toMatchObject({ status: "backlog", assigneeId: undefined });
    expect(releases).toEqual([{ taskId: "task-1", previous: { status: "backlog", assigneeId: undefined } }]);
    expect(registry.listSessions()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("restores the previous status and leaves a pre-existing assignment alone when the launch fails", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER, status: "stopped" });
    worktree.addWorktree.mockRejectedValueOnce(new Error("fatal: invalid reference"));

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("fatal: invalid reference");
    expect(cloudTasks.get("task-1")).toMatchObject({ status: "stopped", assigneeId: USER });
  });

  it("releases the claim when the project turns out not to be bound here", async () => {
    const { sup, registry } = make();
    bind(registry, "");
    task();

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("project not bound");
    expect(cloudTasks.get("task-1")).toMatchObject({ status: "backlog", assigneeId: undefined });
  });

  it("runs in place when the card's own author asks for it", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER, worktree: false });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.worktree).toBe(false);
    expect(worktree.addWorktree).not.toHaveBeenCalled();
  });

  // The invariant the old hardcoded `true` stated: a shared card must never commandeer
  // another developer's checkout.
  it("forces a worktree when the runner did not file the card", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: OTHER, worktree: false });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.worktree).toBe(true);
    expect(worktree.addWorktree).toHaveBeenCalled();
  });

  it("forwards the launcher's images into the first prompt", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER });

    await sup.createSessionFromTask("task-1", USER, [{ data: "aGk=", mimeType: "image/png" }]);

    const [text, images] = prompts.at(-1) as [string, unknown];
    // The task is the head of the sent prompt; the co-author directive rides behind it so every
    // commit this executor makes credits Kermanych. Images are forwarded untouched.
    expect(text).toMatch(/^wire GitHub OAuth\n\n/);
    expect(text).toMatch(/Co-Authored-By: Kermanych </);
    expect(images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
  });

  // «Глибокий аналіз» (docs/specs/2026-10-08-deep-analysis-task.md): the same launch, but the
  // model's opening turn is the task wrapped in the deep-analysis instruction. The operator's
  // transcript still shows the raw task, and the flag is stamped on the row for good.
  it("opens a deep-analysis card with the wrapped prompt", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER, deepAnalysis: true });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(registry.listSessions().find((s) => s.id === session.id)?.deepAnalysis).toBe(true);
    const [text] = prompts.at(-1) as [string];
    expect(text.startsWith(deepAnalysisPrompt("wire GitHub OAuth"))).toBe(true);
    expect(text).toContain("## Task\n\nwire GitHub OAuth");
    expect(text).toMatch(/Co-Authored-By: Kermanych </);
    const first = sup.getTranscript(session.id).find((e) => e.kind === "user_text");
    expect(first).toMatchObject({ kind: "user_text", text: "wire GitHub OAuth" });
  });

  // «Дизайн» (docs/specs/2026-10-29-design-tab.md): a design card is always a `design/` branch,
  // whatever prefix it carries; the row is stamped with its folder (launch day + branch slug),
  // and the model's opening turn is the Дизайнер's instruction naming that folder and the card.
  it("opens a design card on a design branch with its folder and the Дизайнер instruction", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER, design: true, prefix: "feature" });

    const session = await sup.createSessionFromTask("task-1", USER);

    const row = registry.listSessions().find((s) => s.id === session.id)!;
    expect(row.branch).toBe("design/add-login");
    expect(row.prefix).toBe("design");
    expect(row.designDir).toBe(designDirFor(todayIso(), "add-login"));
    const [text] = prompts.at(-1) as [string];
    expect(text).toMatch(/^You are «Дизайнер»/);
    expect(text).toContain(`${row.designDir}/README.md`);
    expect(text).toContain("## Design\nAdd login\n\nwire GitHub OAuth");
    expect(text).toMatch(/Co-Authored-By: Kermanych </);
    const first = sup.getTranscript(session.id).find((e) => e.kind === "user_text");
    expect(first).toMatchObject({ kind: "user_text", text: "wire GitHub OAuth" });
  });

  // docs/specs/2026-10-14-create-pr-base-sync.md, decision 4: origin could not be asked before
  // the fork, so the session starts from the last-known origin base and the transcript says so.
  it("says in the transcript when the base could not be refreshed from origin", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER });
    worktree.forkStart.mockResolvedValueOnce({ ref: "refs/remotes/origin/main", stale: true });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(worktree.addWorktree).toHaveBeenCalledWith(expect.any(String), expect.any(String), session.branch, "refs/remotes/origin/main");
    expect(registry.listSessions().find((s) => s.id === session.id)!.baseBranch).toBe("main");
    const notice = sup.getTranscript(session.id).find((e) => e.kind === "notice");
    expect(notice).toMatchObject({ level: "warn", code: "base_fetch_failed", params: { base: "main", ref: "origin/main" } });
  });

  it("adds no notice when origin answered", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(sup.getTranscript(session.id).some((e) => e.kind === "notice")).toBe(false);
  });

  it("leaves a plain card's session unflagged", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, createdBy: USER });

    const session = await sup.createSessionFromTask("task-1", USER);

    const plain = registry.listSessions().find((s) => s.id === session.id)!;
    expect("deepAnalysis" in plain).toBe(false);
    expect("designDir" in plain).toBe(false);
    expect((prompts.at(-1) as [string])[0]).toMatch(/^wire GitHub OAuth\n\n/);
  });

  // The from-task refresh is how a teammate's documentation policy reaches this machine
  // before its first launch; the launch then carries the policy in its system prompt.
  it("refreshes the documentation policy from the cloud and launches with it", async () => {
    const { sup, registry } = make();
    bind(registry);
    cloudProjects[0]!.docsRequired = true;
    cloudProjects[0]!.docsPolicy = { ...DEFAULT_DOCS_POLICY, plan: "required" };
    task({ assigneeId: USER, createdBy: USER });

    await sup.createSessionFromTask("task-1", USER);

    expect(registry.listProjects()[0]!.docsRequired).toBe(true);
    expect(registry.listProjects()[0]!.docsPolicy!.plan).toBe("required");
    expect(started.at(-1)).toMatchObject({ appendSystemPrompt: expect.stringContaining(docsPolicyAppend({ ...DEFAULT_DOCS_POLICY, plan: "required" })) });
  });
});
