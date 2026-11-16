import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import type { WorktreeService } from "../src/worktree/worktree.service";

// The subset of RpcSession constructor options the tests assert on.
type SpawnOpts = { cwd: string; model?: string; fork?: string; noTools?: boolean; tools?: string[]; appendSystemPrompt?: string };

// Capture every spawned RpcSession and every prompt written to it, so a test can prove how a
// chat / promotion spawns omp and what work it kicks off.
const started: SpawnOpts[] = [];
const prompts: string[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: SpawnOpts) {
      started.push(opts);
    }
    onEvent() {}
    onExit() {}
    async start() {}
    isAlive() {
      return true;
    }
    async getState() {
      return { sessionId: "omp-child", sessionFile: "/tmp/chat.jsonl" };
    }
    async getAllMessages() {
      return [{ role: "assistant", content: [{ type: "text", text: "planned" }] }];
    }
    async switchSession() {}
    async stop() {}
    prompt(text: string) {
      prompts.push(text);
    }
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

// Fake cloud: the promote trigger is the one place apps/api writes `tasks`, and a promotion
// reads its card (`getTask`) for the target project and the deep-analysis flag. Mocked
// wholesale (no importOriginal) so this unit test never needs packages/cloud built; any other
// cloud call from this path would fail loudly as an undefined export rather than reach the
// network. A card not seeded in `cards` is an ordinary card of project p1.
const createdCards: Record<string, unknown>[] = [];
const cards = new Map<string, { id: string; projectId: string; deepAnalysis: boolean }>();
vi.mock("@kermanych/cloud", () => ({
  createTask: async (_client: unknown, input: Record<string, unknown>) => {
    createdCards.push(input);
    return { ...input, id: `card-${createdCards.length}` };
  },
  getTask: async (_client: unknown, id: string) => cards.get(id) ?? { id, projectId: "p1", deepAnalysis: false },
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import type { AiScopeSet, SkillsService } from "../src/skills/skills.service";
import type { AuthService } from "../src/auth/auth.service";
import type { AiTrigger } from "@kermanych/cloud";
import { stubSkills } from "./skills-stub";

// Signed out, but with a cloud client: the only cloud calls on these paths are the mocked ones.
const auth = { current: () => undefined, cloudClient: () => ({}) } as unknown as AuthService;
const skills = {
  ...stubSkills(),
  assignedForNames: async (_scope: AiScopeSet, names: readonly string[]) => ({ block: `\n\n<skill ${names.join(",")}>`, view: [], missing: [] }),
} as unknown as SkillsService;

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    // Every WorktreeService method is async — the stubs must resolve, or the supervisor's
    // `.catch()` cleanup paths blow up on `undefined`.
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue("main"),
    forkStart: vi.fn(async (_repo: string, base: string) => ({ ref: base, stale: false })),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth, skills);
  return { sup, registry, worktree };
}

beforeEach(() => {
  started.length = 0;
  prompts.length = 0;
  createdCards.length = 0;
  cards.clear();
});

// A chat that has already been talked to: a live omp child, a recorded session file, and its
// opening message on the row — the state the "start implementing" button promotes from.
async function discussedChat(sup: SupervisorService, projectId: string, opening: string) {
  const chat = await sup.createChat(projectId);
  await sup.sendMessage(chat.id, opening, "prompt");
  return chat;
}

describe("createChat", () => {
  it("creates a read-only research in the project dir with no git", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });

    const chat = await sup.createChat(g.id);

    expect(chat.kind).toBe("chat");
    expect(chat.name).toBe("дослідження 1");
    expect(chat.worktree).toBe(false);
    expect(chat.branch).toBe("");
    // Spawned in the project dir with the research toolset — no worktree/branch touched.
    expect(started.at(-1)).toMatchObject({ cwd: "/tmp/proj", tools: ["read", "grep", "glob", "web_search"] });
    expect(worktree.addWorktree).not.toHaveBeenCalled();
    expect(worktree.createBranchHere).not.toHaveBeenCalled();
  });

  it("wakes with the same research toolset", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = registry.createSession({
      projectId: g.id, name: "дослідження 1", task: "q", worktreePath: "", branch: "",
      worktree: false, kind: "chat", runtime: "omp", status: "done", ompSessionFile: "/tmp/chat.jsonl",
    });

    await sup.resume(chat.id);

    expect(started.at(-1)).toMatchObject({ cwd: "/tmp/proj", tools: ["read", "grep", "glob", "web_search"] });
    expect(started.at(-1)!.appendSystemPrompt).toContain("«Дослідження»");
  });

  // docs/specs/2026-11-16-research-mode.md, decision 5: the append lists the other projects of
  // the same workspace bound on this machine, and nothing else.
  it("tells the research which projects of its workspace it may read", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "api", workspaceId: "w1", localRepoPath: "/tmp/proj" });
    registry.upsertProject({ id: "p2", name: "ui", workspaceId: "w1", localRepoPath: "/tmp/ui" });
    registry.upsertProject({ id: "p3", name: "unbound", workspaceId: "w1" });
    registry.upsertProject({ id: "p4", name: "foreign", workspaceId: "w2", localRepoPath: "/tmp/foreign" });
    registry.upsertProject({ id: "p5", name: "loose", localRepoPath: "/tmp/loose" });

    await sup.createChat(g.id);
    const append = started.at(-1)!.appendSystemPrompt ?? "";
    expect(append).toContain("«api», whose repository is at `/tmp/proj`");
    expect(append).toContain("- «ui»: `/tmp/ui`");
    expect(append).not.toContain("unbound");
    expect(append).not.toContain("/tmp/foreign");
    expect(append).not.toContain("/tmp/loose");

    // A project with no workspace gets itself only.
    await sup.createChat("p5");
    const loose = started.at(-1)!.appendSystemPrompt ?? "";
    expect(loose).toContain("`/tmp/loose`");
    expect(loose).not.toContain("/tmp/proj");
    expect(loose).not.toContain("other projects of the same workspace");
  });
});

describe("chat opening message", () => {
  it("is recorded on the row so a promoted agent carries a task", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    await sup.sendMessage(chat.id, "Додати експорт у CSV", "prompt");
    await sup.sendMessage(chat.id, "і ще фільтри", "follow_up");

    // The opener is the ask; later turns refine it and must not overwrite it.
    expect(registry.listSessions(g.id).find((s) => s.id === chat.id)!.task).toBe("Додати експорт у CSV");
  });
});

describe("promoteChatToAgent", () => {
  it("turns the chat row itself into a worktree agent", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");

    const agent = await sup.promoteChatToAgent(chat.id, "card-1");

    expect(agent.id).toBe(chat.id); // the same task, matured — not a twin row
    expect(registry.listSessions(g.id)).toHaveLength(1);
    expect(agent.kind).toBe("agent");
    expect(agent.worktree).toBe(true);
    expect(agent.worktreePath).toBe(join("/tmp/proj", ".worktrees", ...agent.branch.split("/")));
    expect(worktree.addWorktree).toHaveBeenCalledTimes(1);
  });

  it("names the agent and its branch after the chat's opening message", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV\nдеталі нижче");

    const agent = await sup.promoteChatToAgent(chat.id, "card-1");

    expect(agent.name).toBe("Додати експорт у CSV");
    expect(agent.branch).toBe("feature/dodaty-eksport-u-csv");
  });

  it("falls back to the chat's own name when nothing was asked yet", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    const agent = await sup.promoteChatToAgent(chat.id, "card-1");

    expect(agent.name).toBe("дослідження 1");
    expect(agent.branch).toBe("feature/doslidzhennia-1");
  });

  it("continues the chat's conversation with full tools and starts implementing at once", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");

    const agent = await sup.promoteChatToAgent(chat.id, "card-1");

    const opts = started.at(-1)!;
    expect(opts).toMatchObject({ cwd: agent.worktreePath, fork: "/tmp/chat.jsonl" });
    expect(opts.tools).toBeUndefined(); // no longer the read-only chat subset
    expect(opts.noTools).toBeFalsy();
    // Work starts on the click: the agent is handed the implementation order, not parked idle.
    expect(prompts.at(-1)).toMatch(/implement/i);
    expect(prompts.at(-1)).toContain(agent.branch);
    expect(agent.status).toBe("queued");
  });

  it("restores the chat when the worktree cannot be created", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    worktree.addWorktree.mockRejectedValueOnce(new Error("worktree add failed"));

    await expect(sup.promoteChatToAgent(chat.id, "card-1")).rejects.toThrow(/worktree add failed/);

    const row = registry.listSessions(g.id).find((s) => s.id === chat.id)!;
    expect(row.kind).toBe("chat");
    expect(row.branch).toBe("");
    expect(row.worktreePath).toBe("");
    expect(registry.listSessions(g.id)).toHaveLength(1);
  });

  // The row must not keep the card either. CloudSyncService mirrors any session that carries
  // a taskId, so a linked-but-restored chat would keep flipping its orphaned card to
  // done/thinking on the shared board — work nobody did, on a card nobody can open.
  it("unlinks the cloud card when the launch fails", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    worktree.addWorktree.mockRejectedValueOnce(new Error("worktree add failed"));

    await expect(sup.promoteChatToAgent(chat.id, "card-1")).rejects.toThrow(/worktree add failed/);

    const row = registry.listSessions(g.id).find((s) => s.id === chat.id)!;
    expect(row.kind).toBe("chat");
    expect(row.taskId).toBeUndefined();
  });

  it("rejects promotion before the chat has an omp session", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = registry.createSession({
      projectId: g.id, name: "дослідження 1", task: "", worktreePath: "", branch: "",
      worktree: false, kind: "chat",
    });
    await expect(sup.promoteChatToAgent(chat.id, "card-1")).rejects.toThrow(/omp session/i);
  });

  // Without this the promoted row has no cloud identity, and CloudSyncService drops every
  // status it emits on its first line (`if (!s.taskId) return`).
  it("stamps the cloud task id on the row before launching", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");

    const agent = await sup.promoteChatToAgent(chat.id, "card-1");

    expect(agent.taskId).toBe("card-1");
    expect(registry.listSessions(g.id).find((s) => s.id === chat.id)!.taskId).toBe("card-1");
  });

  // docs/specs/2026-11-16-research-mode.md, decision 7: «Глибокий аналіз» from the research
  // panel mints a deep-analysis card; the promoted agent is a deep-analysis session and opens
  // with the wrapper and the resolved skill instead of the implementation order.
  it("promotes a deep-analysis card into a deep-analysis session", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    cards.set("card-da", { id: "card-da", projectId: g.id, deepAnalysis: true });

    const agent = await sup.promoteChatToAgent(chat.id, "card-da");

    expect(agent.deepAnalysis).toBe(true);
    expect(registry.listSessions(g.id).find((s) => s.id === chat.id)!.deepAnalysis).toBe(true);
    const opening = prompts.at(-1)!;
    expect(opening).toContain("«Глибокий аналіз» (deep analysis)");
    expect(opening).toContain("Run a deep analysis of the feature researched in the conversation above");
    expect(opening).toContain("<skill deep-analysis>");
    expect(opening).not.toContain(agent.branch);
  });

  it("moves the row to the card's project and works in that project's checkout", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", workspaceId: "w1", localRepoPath: "/tmp/proj" });
    const other = registry.upsertProject({ id: "p2", name: "ui", workspaceId: "w1", localRepoPath: "/tmp/ui" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    cards.set("card-ui", { id: "card-ui", projectId: other.id, deepAnalysis: false });

    const agent = await sup.promoteChatToAgent(chat.id, "card-ui");

    expect(agent.projectId).toBe(other.id);
    expect(registry.listSessions(g.id)).toHaveLength(0);
    expect(registry.listSessions(other.id).map((s) => s.id)).toEqual([chat.id]);
    expect(agent.worktreePath).toBe(join("/tmp/ui", ".worktrees", ...agent.branch.split("/")));
    expect(worktree.addWorktree.mock.calls[0][0]).toBe("/tmp/ui");
    expect(started.at(-1)).toMatchObject({ cwd: agent.worktreePath, fork: "/tmp/chat.jsonl" });
  });

  it("returns the row to its own project when the launch in another one fails", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", workspaceId: "w1", localRepoPath: "/tmp/proj" });
    const other = registry.upsertProject({ id: "p2", name: "ui", workspaceId: "w1", localRepoPath: "/tmp/ui" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    cards.set("card-ui", { id: "card-ui", projectId: other.id, deepAnalysis: true });
    worktree.addWorktree.mockRejectedValueOnce(new Error("worktree add failed"));

    await expect(sup.promoteChatToAgent(chat.id, "card-ui")).rejects.toThrow(/worktree add failed/);

    const row = registry.listSessions().find((s) => s.id === chat.id)!;
    expect(row).toMatchObject({ projectId: g.id, kind: "chat", taskId: undefined });
    expect(row.deepAnalysis).toBeUndefined();
    expect(registry.listSessions(other.id)).toHaveLength(0);
  });

  it("refuses a card of a project not bound on this machine, touching nothing", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", workspaceId: "w1", localRepoPath: "/tmp/proj" });
    registry.upsertProject({ id: "p2", name: "ui", workspaceId: "w1" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    cards.set("card-ui", { id: "card-ui", projectId: "p2", deepAnalysis: false });

    await expect(sup.promoteChatToAgent(chat.id, "card-ui")).rejects.toThrow(/not bound/);

    expect(registry.listSessions().find((s) => s.id === chat.id)).toMatchObject({ projectId: g.id, kind: "chat" });
    expect(worktree.addWorktree).not.toHaveBeenCalled();
  });
});

// A `promote` trigger fires with no human in the loop and no UI to mint a card, so the api
// mints it. Without that the whole trigger target would be dead: a chat row never carries a
// taskId, and the promotion now refuses to run without one.
describe("trigger-driven promotion", () => {
  const USER = "11111111-1111-1111-1111-111111111111";
  const trigger: AiTrigger = {
    owner: { scope: "project", id: "p1" }, id: "start", slug: "start", label: "Берись", enabled: true, source: "operator",
    pattern: "берись за роботу", pathGlobs: [], action: "agent",
    instruction: "", agentId: "promote", skills: [],
    mode: "remind", repeat: "once",
  };

  // Same worktree stubs as make(), but signed in and with the trigger armed, which is what
  // sendMessage matches against before the text ever reaches the child.
  function makeTriggered() {
    const registry = new RegistryService(":memory:");
    const worktree = {
      isGitRepo: vi.fn().mockResolvedValue(true),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      removeBranch: vi.fn().mockResolvedValue(undefined),
      createBranchHere: vi.fn().mockResolvedValue(undefined),
      checkout: vi.fn().mockResolvedValue(undefined),
      currentBranch: vi.fn().mockResolvedValue("main"),
      forkStart: vi.fn(async (_repo: string, base: string) => ({ ref: base, stale: false })),
      hasUncommitted: vi.fn().mockResolvedValue(false),
    };
    const auth = {
      current: () => ({ userId: USER, accessToken: "token" }),
      cloudClient: () => ({}),
    } as unknown as AuthService;
    const skills = {
      ...stubSkills(),
      operatorTriggers: async () => [trigger],
      assignedForNames: async (_scope: AiScopeSet, names: readonly string[]) => ({ block: "", view: [], missing: [...names] }),
    } as unknown as SkillsService;
    const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth, skills);
    return { sup, registry };
  }

  it("mints the card the promotion needs and stamps it on the row", async () => {
    const { sup, registry } = makeTriggered();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");

    await sup.sendMessage(chat.id, "берись за роботу", "prompt");

    expect(createdCards).toHaveLength(1);
    expect(createdCards[0]).toMatchObject({
      projectId: g.id, title: "Додати експорт у CSV", description: "Додати експорт у CSV",
      prefix: "feature", worktree: true, assigneeId: USER, createdBy: USER,
    });
    const row = registry.listSessions(g.id).find((s) => s.id === chat.id)!;
    expect(row.taskId).toBe("card-1");
    expect(row.kind).toBe("agent");
  });

  it("reuses the card a chat already carries instead of minting a second", async () => {
    const { sup, registry } = makeTriggered();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    registry.updateSession(chat.id, { taskId: "existing" });

    await sup.sendMessage(chat.id, "берись за роботу", "prompt");

    expect(createdCards).toHaveLength(0);
    expect(registry.listSessions(g.id).find((s) => s.id === chat.id)!.taskId).toBe("existing");
  });
});
