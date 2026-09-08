// apps/api/test/supervisor-docs.spec.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

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

// Unlike the mocked worktree in supervisor.project.spec.ts, the docs methods actually
// read from disk (listTree/readFileContent read the checkout directly), so this harness
// pairs a real WorktreeService with a real temp repo. The binding is set through the
// registry, exactly as bindProject would store it, so no git init is needed for readers
// that only readdir/readFile.
describe("supervisor docs", () => {
  let repo: string;
  let registry: RegistryService;
  let sup: SupervisorService;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "kermanych-docs-"));
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "intro.md"), "# Intro\n");

    registry = new RegistryService(":memory:");
    const worktree = new WorktreeService();
    sup = new SupervisorService(registry, worktree, offlineAuth(), stubSkills());

    registry.upsertProject({ id: "p1", name: "P", localRepoPath: repo, docFolders: ["docs"] });
    registry.upsertProject({ id: "p2", name: "U" }); // unbound: localRepoPath ""
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("lists a configured folder's tree", async () => {
    const tree = await sup.docsTree("p1", "docs", "");
    expect(tree.map((e) => e.name)).toContain("intro.md");
  });

  it("rejects a folder not in docFolders", async () => {
    await expect(sup.docsTree("p1", "secrets", "")).rejects.toThrow("unknown doc folder");
  });

  it("rejects when the project is unbound", async () => {
    await expect(sup.docsTree("p2", "docs", "")).rejects.toThrow("project not bound");
  });

  it("reads a file inside a configured folder", async () => {
    const f = await sup.docsFile("p1", "docs", "intro.md");
    expect(f.content).toContain("# Intro");
  });
});
