import { describe, it, expect, vi, beforeEach } from "vitest";

const started: any[] = [];
const prompts: { text: string }[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    opts: any;
    constructor(opts: any) { this.opts = opts; started.push(opts); }
    onEvent() {} onExit() {}
    async start() {}
    async switchSession() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    prompt(text: string) { prompts.push({ text }); }
    followUp(text: string) { prompts.push({ text }); }
    steer(text: string) { prompts.push({ text }); }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = { currentBranch: vi.fn().mockResolvedValue("main") } as any;
  return { sup: new SupervisorService(registry, worktree), registry };
}
beforeEach(() => { started.length = 0; prompts.length = 0; });

describe("mergeDiscussion", () => {
  it("injects the summary into the parent and marks the child merged", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id); // needs Task 4
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;

    await sup.mergeDiscussion(child.id, "use cookies");

    expect(prompts.at(-1)!.text).toContain("use cookies");
    expect(prompts.at(-1)!.text).toContain("Висновок гілки");
    expect(registry.listSessions(g.id).find((x) => x.id === child.id)!.status).toBe("merged");
  });
});
