// apps/api/test/supervisor.project.spec.ts
import { describe, expect, it, vi } from "vitest";
import type { CloudProject } from "@kermanych/cloud";
import type { ServerEvent } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import type { WorktreeService } from "../src/worktree/worktree.service";

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    prompt() {} followUp() {} steer() {}
  }
  return { RpcSession: FakeRpc };
});
import { SupervisorService } from "../src/supervisor/supervisor.service";

function make() {
  const registry = new RegistryService(":memory:");
  // DI seam: on these paths SupervisorService only touches the worktree ops below,
  // so a partial mock is sufficient; cast once at the boundary.
  const isGitRepo = vi.fn().mockResolvedValue(true);
  const worktree = {
    isGitRepo,
    listBranches: vi.fn().mockResolvedValue(["main", "dev"]),
    currentBranch: vi.fn().mockResolvedValue("main"),
    removeWorktree: vi.fn(),
    removeBranch: vi.fn(),
    checkout: vi.fn(),
  } as unknown as WorktreeService;
  return { sup: new SupervisorService(registry, worktree, offlineAuth()), registry, worktree, isGitRepo };
}

function cloudProject(id: string, over: Partial<CloudProject> = {}): CloudProject {
  return {
    id, name: `cloud ${id}`, carryFiles: [".env"], envKeys: [],
    workspaceId: "00000000-0000-4000-8000-000000000ws1",
    createdAt: "2026-08-21T00:00:00.000Z", ...over,
  };
}

describe("bindProject", () => {
  it("trims and stores the local repo path and announces it", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "p1", name: "P" });
    const events: ServerEvent[] = [];
    const sub = sup.events$.subscribe((e) => events.push(e));

    const bound = await sup.bindProject("p1", "  /tmp/repo  ");
    sub.unsubscribe();

    expect(bound.localRepoPath).toBe("/tmp/repo");
    expect(registry.listProjects()[0]!.localRepoPath).toBe("/tmp/repo");
    expect(events.some((e) => e.type === "project_update" && e.project.localRepoPath === "/tmp/repo")).toBe(true);
  });

  it("refuses an empty path and a directory that is not a git repo", async () => {
    const { sup, registry, isGitRepo } = make();
    registry.upsertProject({ id: "p1", name: "P" });

    await expect(sup.bindProject("p1", "   ")).rejects.toThrow(/cannot be empty/);
    isGitRepo.mockResolvedValueOnce(false);
    await expect(sup.bindProject("p1", "/tmp/not-a-repo")).rejects.toThrow(/not a git repo/);
    expect(registry.listProjects()[0]!.localRepoPath).toBe("");
  });
});

describe("syncProjects", () => {
  it("upserts cloud config while keeping this machine's binding", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "p1", name: "Old", localRepoPath: "/tmp/bound" });

    const after = await sup.syncProjects([
      cloudProject("p1", { name: "New", conventions: "rule", defaultBranch: "dev", carryFiles: [".env", ".env.local"] }),
    ]);

    const p = after.find((x) => x.id === "p1")!;
    expect(p.localRepoPath).toBe("/tmp/bound");
    expect(p.name).toBe("New");
    expect(p.conventions).toBe("rule");
    expect(p.defaultBranch).toBe("dev");
    expect(p.carryFiles).toEqual([".env", ".env.local"]);
  });

  it("creates an unbound row for a cloud project this machine has never seen", async () => {
    const { sup, registry } = make();
    await sup.syncProjects([cloudProject("p-new")]);
    expect(registry.listProjects()[0]!.localRepoPath).toBe("");
  });

  it("prunes only rows with no sessions, and only when asked", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "gone-empty", name: "Gone", localRepoPath: "/tmp/gone" });
    registry.upsertProject({ id: "gone-busy", name: "Busy", localRepoPath: "/tmp/busy" });
    registry.createSession({ projectId: "gone-busy", name: "a", task: "t", worktreePath: "", branch: "b" });

    // prune=false (default): nothing is removed, because the payload may be partial.
    await sup.syncProjects([cloudProject("kept")]);
    expect(registry.listProjects().map((p) => p.id).sort()).toEqual(["gone-busy", "gone-empty", "kept"]);

    const after = await sup.syncProjects([cloudProject("kept")], true);

    // gone-empty is stale cache and goes; gone-busy still owns local sessions and stays
    // as an orphan row — pruning it would destroy a developer's work.
    expect(after.map((p) => p.id).sort()).toEqual(["gone-busy", "kept"]);
    expect(registry.listSessions("gone-busy")).toHaveLength(1);
  });
});

describe("updateProject", () => {
  it("renames the project, announces it, and refuses an empty name", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "p1", name: "old", localRepoPath: "/tmp/x" });
    const events: ServerEvent[] = [];
    const sub = sup.events$.subscribe((e) => events.push(e));

    const updated = await sup.updateProject("p1", { name: "  renamed  " });
    sub.unsubscribe();

    expect(updated.name).toBe("renamed");
    expect(events.some((e) => e.type === "project_update" && e.project.name === "renamed")).toBe(true);
    await expect(sup.updateProject("p1", { name: "   " })).rejects.toThrow(/empty/);
  });
});

describe("projectBranches", () => {
  it("reads branches from the bound repo and refuses an unbound project", async () => {
    const { sup, registry } = make();
    registry.upsertProject({ id: "bound", name: "B", localRepoPath: "/tmp/repo" });
    registry.upsertProject({ id: "unbound", name: "U" });

    await expect(sup.projectBranches("bound")).resolves.toEqual({ branches: ["main", "dev"], current: "main", default: null });
    await expect(sup.projectBranches("unbound")).rejects.toThrow(/project not bound/);
    await expect(sup.projectBranches("nope")).rejects.toThrow(/project not found/);
  });
});

describe("removeProject cascade", () => {
  it("removes the project, its sessions, and announces both", async () => {
    const { sup, registry, worktree } = make();
    const p = registry.upsertProject({ id: "p1", name: "p", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({
      projectId: p.id, name: "WT", task: "t", worktreePath: "/tmp/wt", branch: "feature/wt",
    });
    const events: ServerEvent[] = [];
    const sub = sup.events$.subscribe((e) => events.push(e));

    await sup.removeProject(p.id);
    sub.unsubscribe();

    expect(registry.listProjects()).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/tmp/proj", "/tmp/wt");
    expect(events.some((e) => e.type === "session_removed" && e.sessionId === s.id)).toBe(true);
    expect(events.some((e) => e.type === "project_removed" && e.projectId === p.id)).toBe(true);
  });
});
