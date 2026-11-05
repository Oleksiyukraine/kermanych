import { describe, it, expect, vi, beforeEach } from "vitest";
const started: any[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: any) { started.push(opts); }
    onEvent() {} onExit() {}
    async start() {} async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; } async stop() {}
    prompt() {} followUp() {} steer() {}
  }
  return { RpcSession: FakeRpc };
});
import { Subject } from "rxjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DOCS_POLICY } from "@kermanych/core";
import type { CloudProject } from "@kermanych/cloud";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { PreviewService } from "../src/preview/preview.service";
import type { ModelsService } from "../src/models/models.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";
import { fakeDevice } from "./fake-device";
import type { WorktreeService } from "../src/worktree/worktree.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    removeWorktree: vi.fn(), removeBranch: vi.fn(), checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as any;
  // docs/specs/2026-11-03-session-browser-preview.md, decision 7: the lifecycle stops the preview.
  const preview = {
    changes$: new Subject(),
    forget: vi.fn(async (_id: string) => {}),
    stop: vi.fn(async (_id: string) => {}),
    stopUnfit: vi.fn(async (_projectId: string, _platform: unknown) => {}),
    states: () => ({}),
  };
  const sup = new SupervisorService(registry, worktree, offlineAuth(), stubSkills(), undefined as unknown as ModelsService, undefined, undefined, undefined, undefined, undefined, undefined, undefined, preview as unknown as PreviewService);
  return { sup, registry, worktree, preview };
}
beforeEach(() => { started.length = 0; });

describe("discard + cascade", () => {
  it("deletes a discussion child without any git calls", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;

    await sup.deleteSession(child.id);

    expect(registry.listSessions(g.id).find((x) => x.id === child.id)).toBeUndefined();
    expect(worktree.removeBranch).not.toHaveBeenCalled();
    expect(worktree.checkout).not.toHaveBeenCalled();
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("cascade-deletes children when the parent is deleted", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "feature/aaa", worktree: false, baseBranch: "main" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    expect(registry.listSessions(g.id).some((x) => x.kind === "discussion")).toBe(true);

    await sup.deleteSession(parent.id);

    expect(registry.listSessions(g.id)).toHaveLength(0);
  });

  it("every delete path forgets the preview, the children of a cascade included", async () => {
    const { sup, registry, preview } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "feature/aaa", worktree: false, baseBranch: "main" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;
    await sup.deleteSession(parent.id);
    expect(preview.forget.mock.calls.map(([id]) => id)).toEqual([child.id, parent.id]);

    const other = registry.createSession({ projectId: g.id, name: "BBB", task: "t", worktreePath: "", branch: "feature/bbb", worktree: false, baseBranch: "main" });
    await sup.removeProject(g.id);
    expect(preview.forget).toHaveBeenLastCalledWith(other.id);
  });

  it("archiving stops the preview; unarchiving does not touch it", async () => {
    const { sup, registry, preview } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", status: "done" });
    await sup.setArchived(s.id, true);
    expect(preview.stop).toHaveBeenCalledWith(s.id);
    await sup.setArchived(s.id, false);
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(sup.snapshot().previews).toEqual({});
  });

  // docs/specs/2026-11-03-mobile-device-preview.md, decision 11, through the real preview and a
  // fake device: archive shuts down (nothing to shut here) and keeps the clone; every delete
  // path deletes each session's clone, a cascade's children and removeProject's sessions too.
  it("archive keeps the device clones; every delete path removes them", async () => {
    const registry = new RegistryService(":memory:");
    // The delete paths' git calls only; this test is about the device.
    const worktree = { removeWorktree: vi.fn(), removeBranch: vi.fn(), checkout: vi.fn(), currentBranch: vi.fn().mockResolvedValue("main") } as unknown as WorktreeService;
    const fake = fakeDevice();
    const preview = new PreviewService(registry, fake.device);
    preview.opts.root = mkdtempSync(join(tmpdir(), "kmq-discard-preview-"));
    const sup = new SupervisorService(registry, worktree, offlineAuth(), stubSkills(), undefined as unknown as ModelsService, undefined, undefined, undefined, undefined, undefined, undefined, undefined, preview);
    try {
      const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj", platform: "mobile" });
      const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "feature/aaa", worktree: false, baseBranch: "main" });
      registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
      await sup.setArchived(parent.id, true);
      expect(fake.device.remove).not.toHaveBeenCalled();
      await sup.branchSession(parent.id);
      const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;
      await sup.deleteSession(parent.id);
      expect(fake.device.remove.mock.calls.map(([id]) => id)).toEqual([child.id, parent.id]);
      const other = registry.createSession({ projectId: g.id, name: "BBB", task: "t", worktreePath: "", branch: "feature/bbb", worktree: false, baseBranch: "main" });
      await sup.removeProject(g.id);
      expect(fake.device.remove).toHaveBeenLastCalledWith(other.id);
    } finally {
      rmSync(preview.opts.root, { recursive: true, force: true });
    }
  });

  // Mobile decision 8: a platform switch reaches the preview, which stops what no longer fits.
  it("a project sync hands every project's platform to the preview", async () => {
    const { sup, preview } = make();
    const cloud = (id: string, platform?: CloudProject["platform"]): CloudProject => ({
      id, name: id, carryFiles: [".env"], envKeys: [], docFolders: [], docsRequired: false, docsPolicy: DEFAULT_DOCS_POLICY,
      workspaceId: "00000000-0000-4000-8000-000000000ws1", createdAt: "2026-08-21T00:00:00.000Z", ...(platform ? { platform } : {}),
    });
    await sup.syncProjects([cloud("p1", "mobile"), cloud("p2", "web"), cloud("p3")]);
    expect(preview.stopUnfit.mock.calls).toEqual([["p1", "mobile"], ["p2", "web"], ["p3", undefined]]);
  });

  it("refuses finishSession on a discussion branch", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;
    await expect(sup.finishSession(child.id)).rejects.toThrow(/discussion/i);
  });
});
